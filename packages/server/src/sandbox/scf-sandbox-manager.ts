/**
 * SCF Sandbox Manager
 *
 * Simplified version of scf-sandbox-manager.service.ts
 * - No NestJS DI
 * - No Rainbow service - uses env vars directly
 * - Uses @cloudbase/manager-node for function operations
 */

import CloudBase from '@cloudbase/manager-node'
import { sign } from '@cloudbase/signature-nodejs'

// ─── Types ────────────────────────────────────────────────────────────────

export type SandboxMode = 'per-conversation' | 'shared'

export type SandboxProgressCallback = (message: {
  phase: 'reuse' | 'create' | 'wait_creating' | 'pull_image' | 'wait_ready' | 'init_mcp' | 'ready' | 'error'
  message: string
}) => void

interface ScfSandboxConfig {
  timeoutMs: number
  maxCacheSize: number
  functionPrefix: string
  runtime: string
  memory: number
  timeout: number
}

// ─── SandboxInstance ──────────────────────────────────────────────────────

export class SandboxInstance {
  readonly functionName: string
  readonly conversationId: string
  readonly envId: string
  readonly sandboxEnvId: string
  readonly baseUrl: string
  readonly status: 'creating' | 'ready' | 'error'
  readonly mode: SandboxMode

  readonly mcpConfig?: {
    type: 'sse' | 'http'
    url: string
    headers?: Record<string, string | undefined>
    credential?: {
      envId: string
      secretId: string
      secretKey: string
      token: string
    }
  }

  constructor(
    private readonly deps: {
      sandboxEnvId: string
      getAccessToken: () => Promise<string>
    },
    ctx: {
      functionName: string
      conversationId: string
      envId: string
      status: 'creating' | 'ready' | 'error'
      mode: SandboxMode
      mcpConfig?: SandboxInstance['mcpConfig']
    },
  ) {
    this.functionName = ctx.functionName
    this.conversationId = ctx.conversationId
    this.envId = ctx.envId
    this.sandboxEnvId = this.deps.sandboxEnvId
    this.baseUrl = `https://${this.deps.sandboxEnvId}.api.tcloudbasegateway.com/v1/functions/${ctx.functionName}`
    this.status = ctx.status
    this.mode = ctx.mode
    this.mcpConfig = ctx.mcpConfig
  }

  async getAccessToken(): Promise<string> {
    return this.deps.getAccessToken()
  }

  static buildAuthHeaders(accessToken: string, sessionId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'X-Cloudbase-Session-Id': sessionId,
      'X-Tcb-Webfn': 'true',
    }
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const accessToken = await this.getAccessToken()
    return {
      ...SandboxInstance.buildAuthHeaders(accessToken, this.envId),
      'X-Conversation-Id': this.conversationId,
    }
  }

  async getToolOverrideConfig(): Promise<{ url: string; headers: Record<string, string> }> {
    return {
      url: this.baseUrl,
      headers: await this.getAuthHeaders(),
    }
  }

  async request(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...(await this.getAuthHeaders()),
        ...(options.headers as Record<string, string> | undefined),
      },
    })
  }
}

// ─── ScfSandboxManager ────────────────────────────────────────────────────

export class ScfSandboxManager {
  private readonly config: ScfSandboxConfig = {
    timeoutMs: 30 * 60 * 1000,
    maxCacheSize: 50,
    functionPrefix: 'sandbox',
    runtime: 'Nodejs16.13',
    memory: 2048,
    timeout: 900,
  }

  private cachedAccessToken: { token: string; expiry: number } | null = null

  private getEnvConfig() {
    return {
      envId: process.env.TCB_ENV_ID || '',
      secretId: process.env.TCB_SECRET_ID || '',
      secretKey: process.env.TCB_SECRET_KEY || '',
      token: process.env.TCB_TOKEN || '',
      functionPrefix: process.env.SCF_SANDBOX_FUNCTION_PREFIX || 'sandbox',
      imageConfig: {
        ImageType: process.env.SCF_SANDBOX_IMAGE_TYPE || 'personal',
        ImageUri: process.env.SCF_SANDBOX_IMAGE_URI || '',
        ContainerImageAccelerate: process.env.SCF_SANDBOX_IMAGE_ACCELERATE === 'true',
        ImagePort: parseInt(process.env.SCF_SANDBOX_IMAGE_PORT || '9000', 10),
      },
    }
  }

  private async getAdminAccessToken(): Promise<string> {
    // Check cache
    if (this.cachedAccessToken && Date.now() < this.cachedAccessToken.expiry) {
      return this.cachedAccessToken.token
    }

    const envConfig = this.getEnvConfig()
    const { secretId, secretKey, token, envId } = envConfig

    if (!secretId || !secretKey || !envId) {
      throw new Error('Missing TCB_SECRET_ID, TCB_SECRET_KEY or TCB_ENV_ID')
    }

    const host = `${envId}.api.tcloudbasegateway.com`
    const url = `https://${host}/auth/v1/token/clientCredential`
    const method = 'POST'

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Host: host,
    }

    const data = { grant_type: 'client_credentials' }

    const { authorization, timestamp } = sign({
      secretId,
      secretKey,
      method,
      url,
      headers,
      params: data,
      timestamp: Math.floor(Date.now() / 1000) - 1,
      withSignedParams: false,
      isCloudApi: true,
    })

    headers['Authorization'] = `${authorization}, Timestamp=${timestamp}${token ? `, Token=${token}` : ''}`
    headers['X-Signature-Expires'] = '600'
    headers['X-Timestamp'] = String(timestamp)

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(data),
      })

      const body = (await res.json()) as { access_token?: string; expires_in?: number }
      const accessToken = body?.access_token
      const expiresIn = body?.expires_in || 0

      if (!accessToken) {
        throw new Error('clientCredential response missing access_token')
      }

      // Cache for half the expiry time
      if (expiresIn) {
        this.cachedAccessToken = {
          token: accessToken,
          expiry: Date.now() + (expiresIn * 1000) / 2,
        }
      } else {
        this.cachedAccessToken = {
          token: accessToken,
          expiry: Date.now() + 3600 * 1000,
        }
      }

      console.log('[ScfSandbox] Got admin access token, expires_in:', expiresIn)
      return accessToken
    } catch (err) {
      console.error('[ScfSandbox] getAdminAccessToken failed:', (err as Error).message)
      throw err
    }
  }

  private async buildInstanceDeps() {
    const envConfig = this.getEnvConfig()
    return {
      sandboxEnvId: envConfig.envId,
      getAccessToken: () => this.getAdminAccessToken(),
    }
  }

  private async buildSandboxMcpConfig(
    functionName: string,
    scfSessionId: string,
    conversationId: string,
    sandboxEnvId: string,
  ): Promise<SandboxInstance['mcpConfig']> {
    const accessToken = await this.getAdminAccessToken()
    const url = `https://${sandboxEnvId}.api.tcloudbasegateway.com/v1/functions/${functionName}/mcp`
    return {
      type: 'http' as const,
      url,
      headers: {
        ...SandboxInstance.buildAuthHeaders(accessToken, scfSessionId),
        'X-Conversation-Id': conversationId,
      },
    }
  }

  async getOrCreate(
    conversationId: string,
    envId: string,
    options?: {
      mode?: SandboxMode
      /** Workspace isolation: 'shared' uses envId as SCF session, 'isolated' uses conversationId */
      workspaceIsolation?: 'shared' | 'isolated'
      /** Pre-computed SCF session ID (overrides workspaceIsolation logic) */
      sandboxSessionId?: string
    },
    onProgress?: SandboxProgressCallback,
  ): Promise<SandboxInstance> {
    const progress = onProgress || (() => {})
    const mode = options?.mode || 'shared'
    const isolation = options?.workspaceIsolation || 'shared'
    const scfSessionId = options?.sandboxSessionId || (isolation === 'shared' ? envId : conversationId)

    const envConfig = this.getEnvConfig()
    const functionPrefix = envConfig.functionPrefix || this.config.functionPrefix

    const functionKey = mode === 'shared' ? 'shared' : conversationId
    const functionName = this.generateFunctionName(functionKey, functionPrefix)

    // Check if function exists
    const { exists: functionExists } = await this.checkFunctionExists(functionName)

    if (functionExists) {
      await this.waitForFunctionReady(functionName)
      const instanceDeps = await this.buildInstanceDeps()
      const mcpConfig = await this.buildSandboxMcpConfig(
        functionName,
        scfSessionId,
        conversationId,
        instanceDeps.sandboxEnvId,
      )

      return new SandboxInstance(instanceDeps, {
        functionName,
        conversationId,
        envId: scfSessionId,
        status: 'ready',
        mode,
        mcpConfig,
      })
    }

    return this.createNewFunction(functionName, conversationId, scfSessionId, mode, options, progress)
  }

  /**
   * 获取已存在的沙箱实例（不创建新实例）
   * 适用于任务删除等场景，沙箱不存在时返回 null
   * @param conversationId 会话ID
   * @param scfSessionId SCF session ID（shared模式=envId，isolated模式=conversationId）
   */
  async getExisting(conversationId: string, scfSessionId: string): Promise<SandboxInstance | null> {
    const envConfig = this.getEnvConfig()
    const functionPrefix = envConfig.functionPrefix || this.config.functionPrefix
    const functionName = this.generateFunctionName('shared', functionPrefix)

    const { exists } = await this.checkFunctionExists(functionName)
    if (!exists) return null

    const instanceDeps = await this.buildInstanceDeps()
    return new SandboxInstance(instanceDeps, {
      functionName,
      conversationId,
      envId: scfSessionId,
      status: 'ready',
      mode: 'shared',
    })
  }

  private async createNewFunction(
    functionName: string,
    conversationId: string,
    envId: string,
    mode: SandboxMode,
    options?: any,
    onProgress?: SandboxProgressCallback,
  ): Promise<SandboxInstance> {
    const progress = onProgress || (() => {})

    try {
      progress({ phase: 'create', message: '正在创建工作空间...\n' })

      await this.createFunction(functionName)

      try {
        await Promise.all([this.waitForFunctionReady(functionName), this.createGatewayApi(functionName)])
      } catch (networkError: any) {
        console.error(`[ScfSandbox] Network setup failed, rolling back: ${networkError.message}`)
        await this.deleteFunction(functionName).catch((delErr) => {
          console.warn(`[ScfSandbox] Failed to delete function during rollback: ${delErr.message}`)
        })
        throw new Error(`网络配置失败: ${networkError.message}`)
      }

      const instanceDeps = await this.buildInstanceDeps()
      const mcpConfig = await this.buildSandboxMcpConfig(functionName, envId, conversationId, instanceDeps.sandboxEnvId)

      return new SandboxInstance(instanceDeps, {
        functionName,
        conversationId,
        envId,
        status: 'ready',
        mode,
        mcpConfig,
      })
    } catch (error: any) {
      console.error(`[ScfSandbox] Creation failed: ${functionName}`)
      progress({ phase: 'error', message: `工作空间创建失败: ${error.message}\n` })
      throw new Error(`创建工作空间失败: ${error.message}`)
    }
  }

  private generateFunctionName(cacheKey: string, prefix?: string): string {
    const sanitized = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '-')
    return `${prefix || this.config.functionPrefix}-${sanitized}`.substring(0, 60)
  }

  private async createFunction(functionName: string): Promise<void> {
    const envConfig = this.getEnvConfig()

    try {
      const app = new CloudBase({
        secretId: envConfig.secretId,
        secretKey: envConfig.secretKey,
        token: envConfig.token,
        envId: envConfig.envId,
      })

      const createParams = {
        FunctionName: functionName,
        Namespace: envConfig.envId,
        Stamp: 'MINI_QCBASE',
        Role: 'TCB_QcsRole',
        Code: {
          ImageConfig: envConfig.imageConfig,
        },
        Type: 'HTTP',
        ProtocolType: 'WS',
        ProtocolParams: {
          WSParams: {
            IdleTimeOut: 7200,
          },
        },
        MemorySize: this.config.memory,
        DiskSize: 1024,
        Timeout: this.config.timeout,
        InitTimeout: 90,
        InstanceConcurrencyConfig: {
          MaxConcurrency: 100,
          DynamicEnabled: 'FALSE',
          InstanceIsolationEnabled: 'TRUE',
          Type: 'Session-Based',
          SessionConfig: {
            SessionSource: 'HEADER',
            SessionName: 'X-Cloudbase-Session-Id',
            MaximumConcurrencySessionPerInstance: 1,
            MaximumTTLInSeconds: 1800,
            MaximumIdleTimeInSeconds: 600,
            IdleTimeoutStrategy: 'FATAL',
          },
        },
        Environment: {
          Variables: this.buildGitArchiveVars(),
        },
        Description: 'SCF Sandbox for conversation (Image-based)',
      }

      await (app.commonService('scf') as any).call({
        Action: 'CreateFunction',
        Param: createParams,
      })
    } catch (error: any) {
      if (error.message?.includes('already exists') || error.code === 'ResourceInUse') {
        console.warn(`[ScfSandbox] Function already exists: ${functionName}`)
        return
      }
      throw error
    }
  }

  private async createGatewayApi(functionName: string): Promise<void> {
    const envConfig = this.getEnvConfig()

    try {
      const app = new CloudBase({
        secretId: envConfig.secretId,
        secretKey: envConfig.secretKey,
        token: envConfig.token,
        envId: envConfig.envId,
      })

      const domain = `${envConfig.envId}.ap-shanghai.app.tcloudbase.com`

      await (app.commonService() as any).call({
        Action: 'CreateCloudBaseGWAPI',
        Param: {
          ServiceId: envConfig.envId,
          Name: functionName,
          Path: `/${functionName}/preview`,
          Type: 6,
          EnableUnion: true,
          AuthSwitch: 2,
          PathTransmission: 1,
          EnableRegion: true,
          Domain: domain,
        },
      })
    } catch (error: any) {
      if (
        error.message?.includes('already exists') ||
        error.message?.includes('ResourceInUse') ||
        error.code === 'ResourceInUse'
      ) {
        console.warn(`[ScfSandbox] Gateway API already exists: ${functionName}`)
        return
      }
      throw error
    }
  }

  private async checkFunctionExists(functionName: string): Promise<{ exists: boolean; currentImageUri?: string }> {
    const envConfig = this.getEnvConfig()

    try {
      const app = new CloudBase({
        secretId: envConfig.secretId,
        secretKey: envConfig.secretKey,
        token: envConfig.token,
        envId: envConfig.envId,
      })

      const result = await (app.commonService() as any).call({
        Action: 'GetFunction',
        Param: {
          FunctionName: functionName,
          EnvId: envConfig.envId,
          Namespace: envConfig.envId,
          ShowCode: 'TRUE',
        },
      })

      if (!result || result.Status === undefined) {
        return { exists: false }
      }

      const currentImageUri: string | undefined = result.ImageConfig?.ImageUri
      return { exists: true, currentImageUri }
    } catch {
      return { exists: false }
    }
  }

  private async waitForFunctionReady(functionName: string, maxRetries = 120, retryInterval = 3000): Promise<void> {
    const envConfig = this.getEnvConfig()

    const app = new CloudBase({
      secretId: envConfig.secretId,
      secretKey: envConfig.secretKey,
      token: envConfig.token,
      envId: envConfig.envId,
    })

    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await (app.commonService() as any).call({
          Action: 'GetFunction',
          Param: {
            FunctionName: functionName,
            EnvId: envConfig.envId,
            Namespace: envConfig.envId,
            ShowCode: 'TRUE',
          },
        })

        const status = result?.Status
        if (status === 'Active' || status === 'active' || status === 'Running' || status === 'running') {
          return
        }
      } catch (error: any) {
        if (
          error.code === 'ResourceNotFound' ||
          error.message?.includes('ResourceNotFound') ||
          error.message?.includes('not exist') ||
          error.message?.includes('not found')
        ) {
          throw new Error(`Function ${functionName} does not exist`)
        }
        if (i < 5) {
          console.warn(`[ScfSandbox] Check function status error: ${error.message}`)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, retryInterval))
    }

    throw new Error(
      `Function ${functionName} not ready after ${maxRetries} retries (${(maxRetries * retryInterval) / 1000}s)`,
    )
  }

  private buildGitArchiveVars(): { Key: string; Value: string }[] {
    const repo = process.env.GIT_ARCHIVE_REPO
    const token = process.env.GIT_ARCHIVE_TOKEN
    const user = process.env.GIT_ARCHIVE_USER

    if (!repo || !token) return []

    return [
      { Key: 'GIT_ARCHIVE_REPO', Value: repo },
      { Key: 'GIT_ARCHIVE_TOKEN', Value: token },
      { Key: 'GIT_ARCHIVE_USER', Value: user || '' },
    ]
  }

  private async deleteFunction(functionName: string): Promise<void> {
    const envConfig = this.getEnvConfig()

    try {
      const app = new CloudBase({
        secretId: envConfig.secretId,
        secretKey: envConfig.secretKey,
        token: envConfig.token,
        envId: envConfig.envId,
      })

      await (app.commonService() as any).call({
        Action: 'DeleteFunction',
        Param: {
          FunctionName: functionName,
          Namespace: envConfig.envId,
        },
      })
    } catch (error: any) {
      console.warn(`[ScfSandbox] Delete function error: ${error.message}`)
    }
  }
}

export const scfSandboxManager = new ScfSandboxManager()
