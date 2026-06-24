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
  phase:
    | 'reuse'
    | 'create'
    | 'wait_creating'
    | 'pull_image'
    | 'wait_ready'
    | 'init_mcp'
    | 'init_skills'
    | 'ready'
    | 'error'
  message: string
}) => void

interface ScfSandboxConfig {
  timeoutMs: number
  maxCacheSize: number
  runtime: string
  memory: number
  timeout: number
  /** SCF Session 最大存活时间（秒）。env: SANDBOX_SESSION_TTL，默认 1800（30 分钟） */
  sessionTTL: number
  /** SCF Session 空闲超时（秒）。env: SANDBOX_SESSION_IDLE_TIMEOUT，默认 600（10 分钟） */
  sessionIdleTimeout: number
}

// ─── SandboxInstance ──────────────────────────────────────────────────────

export class SandboxInstance {
  readonly functionName: string
  readonly conversationId: string
  /**
   * SCF session ID (used as `X-Cloudbase-Session-Id` header for sandbox auth).
   * - In `shared` workspaceIsolation mode: equals the user's CloudBase envId
   * - In `isolated` mode: equals conversationId
   * - May be overridden via `options.sandboxSessionId` in `getOrCreate`
   *
   * 注意：这不是用户的 CloudBase 环境 ID（之前误命名为 envId 容易引起混淆），
   * 实际是沙箱 SCF function 的 session ID。
   */
  readonly scfSessionId: string
  readonly sandboxEnvId: string
  readonly baseUrl: string
  readonly status: 'creating' | 'ready' | 'error'
  readonly mode: SandboxMode
  /** Workspace isolation mode: 'shared' shares an SCF instance across tasks, 'isolated' is 1:1 */
  readonly sandboxMode: 'shared' | 'isolated'
  /** Whether this task is in coding mode (triggers X-Scope-Template: coding) */
  readonly isCodingMode: boolean

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
      scfSessionId: string
      status: 'creating' | 'ready' | 'error'
      mode: SandboxMode
      sandboxMode?: 'shared' | 'isolated'
      isCodingMode?: boolean
      mcpConfig?: SandboxInstance['mcpConfig']
    },
  ) {
    this.functionName = ctx.functionName
    this.conversationId = ctx.conversationId
    this.scfSessionId = ctx.scfSessionId
    this.sandboxEnvId = this.deps.sandboxEnvId
    this.baseUrl = `https://${this.deps.sandboxEnvId}.api.tcloudbasegateway.com/v1/functions/${ctx.functionName}`
    this.status = ctx.status
    this.mode = ctx.mode
    this.sandboxMode = ctx.sandboxMode || 'isolated'
    this.isCodingMode = ctx.isCodingMode || false
    this.mcpConfig = ctx.mcpConfig
  }

  async getAccessToken(): Promise<string> {
    return this.deps.getAccessToken()
  }

  static buildAuthHeaders(accessToken: string, scfSessionId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'X-Cloudbase-Session-Id': scfSessionId,
      'X-Tcb-Webfn': 'true',
    }
  }

  /**
   * Build scope headers based on sandbox mode.
   * - X-Scope-Id: only sent in 'shared' mode (isolates sub-workspaces within the shared session)
   * - X-Scope-Template: sent when in coding mode (triggers template init + vite dev server)
   */
  static buildScopeHeaders(
    scopeId: string,
    sandboxMode: 'shared' | 'isolated',
    isCodingMode: boolean,
  ): Record<string, string> {
    const headers: Record<string, string> = {}
    if (sandboxMode === 'shared') {
      headers['X-Scope-Id'] = scopeId
    }
    if (isCodingMode) {
      headers['X-Scope-Template'] = 'coding'
    }
    return headers
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const accessToken = await this.getAccessToken()
    return {
      ...SandboxInstance.buildAuthHeaders(accessToken, this.scfSessionId),
      ...SandboxInstance.buildScopeHeaders(this.conversationId, this.sandboxMode, this.isCodingMode),
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
    runtime: 'Nodejs16.13',
    memory: 2048,
    timeout: 900,
    sessionTTL: Number(process.env.SANDBOX_SESSION_TTL || process.env.SCF_SANDBOX_SESSION_TTL) || 1800,
    sessionIdleTimeout:
      Number(process.env.SANDBOX_SESSION_IDLE_TIMEOUT || process.env.SCF_SANDBOX_SESSION_IDLE_TIMEOUT) || 600,
  }

  private cachedAccessToken: { token: string; expiry: number } | null = null
  private cachedDefaultDomain: { domain: string; expiry: number } | null = null

  /**
   * 从 DescribeCloudBaseGWService 获取环境的 DefaultDomain（含正确的 UIN 后缀和 region），
   * 缓存 1 小时，替代所有 `${envId}.ap-shanghai.app.tcloudbase.com` 硬拼接。
   */
  async getDefaultDomain(): Promise<string> {
    const envConfig = this.getEnvConfig()
    return `${envConfig.envId}.service.tcloudbase.com`
    const now = Date.now()
    if (this.cachedDefaultDomain && this.cachedDefaultDomain.expiry > now) {
      return this.cachedDefaultDomain.domain
    }

    const app = new CloudBase({
      secretId: envConfig.secretId,
      secretKey: envConfig.secretKey,
      token: envConfig.token,
      envId: envConfig.envId,
    })

    const res = (await (app.commonService() as any).call({
      Action: 'DescribeCloudBaseGWService',
      Param: { EnableRegion: true, EnableUnion: true, ServiceId: envConfig.envId },
    })) as { DefaultDomain?: string }

    const domain = res.DefaultDomain || `${envConfig.envId}.ap-shanghai.app.tcloudbase.com`
    this.cachedDefaultDomain = { domain, expiry: now + 3600_000 }
    return domain
  }

  private getEnvConfig() {
    const imageType = process.env.SANDBOX_IMAGE_TYPE || process.env.SCF_SANDBOX_IMAGE_TYPE || 'personal'
    const imageConfig: Record<string, string | boolean | number> = {
      ImageType: imageType,
      ImageUri: process.env.SANDBOX_IMAGE_URI || process.env.SCF_SANDBOX_IMAGE_URI || '',
      ContainerImageAccelerate:
        (process.env.SANDBOX_IMAGE_ACCELERATE || process.env.SCF_SANDBOX_IMAGE_ACCELERATE) === 'true',
      ImagePort: parseInt(process.env.SANDBOX_IMAGE_PORT || process.env.SCF_SANDBOX_IMAGE_PORT || '9000', 10),
    }

    if (imageType === 'enterprise') {
      const registryId = process.env.SANDBOX_IMAGE_REGISTRY_ID || ''
      if (!registryId) {
        throw new Error('Missing SANDBOX_IMAGE_REGISTRY_ID for enterprise sandbox image')
      }
      imageConfig.RegistryId = registryId
    }

    return {
      envId: process.env.TCB_ENV_ID || '',
      secretId: process.env.TCB_SECRET_ID || '',
      secretKey: process.env.TCB_SECRET_KEY || '',
      token: process.env.TCB_TOKEN || '',
      functionPrefix: process.env.SANDBOX_FUNCTION_PREFIX || process.env.SCF_SANDBOX_FUNCTION_PREFIX || 'sandbox',
      imageConfig,
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
    sandboxMode: 'shared' | 'isolated' = 'shared',
    isCodingMode = false,
  ): Promise<SandboxInstance['mcpConfig']> {
    const accessToken = await this.getAdminAccessToken()
    const url = `https://${sandboxEnvId}.api.tcloudbasegateway.com/v1/functions/${functionName}/mcp`
    return {
      type: 'http' as const,
      url,
      headers: {
        ...SandboxInstance.buildAuthHeaders(accessToken, scfSessionId),
        ...SandboxInstance.buildScopeHeaders(conversationId, sandboxMode, isCodingMode),
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
      /** Whether this task is in coding mode */
      isCodingMode?: boolean
    },
    onProgress?: SandboxProgressCallback,
  ): Promise<SandboxInstance> {
    const progress = onProgress || (() => {})
    const mode = options?.mode || 'shared'
    const isolation = options?.workspaceIsolation || 'shared'
    const scfSessionId = options?.sandboxSessionId || (isolation === 'shared' ? envId : conversationId)
    const isCodingMode = options?.isCodingMode || false

    const functionName = this.generateFunctionName('shared')

    // Check if function exists
    const { exists: functionExists } = await this.checkFunctionExists(functionName)

    if (functionExists) {
      progress({ phase: 'reuse', message: '连接已有沙箱...\n' })
      await this.waitForFunctionReady(functionName, undefined, undefined, progress)
      const instanceDeps = await this.buildInstanceDeps()
      const mcpConfig = await this.buildSandboxMcpConfig(
        functionName,
        scfSessionId,
        conversationId,
        instanceDeps.sandboxEnvId,
        isolation,
        isCodingMode,
      )

      return new SandboxInstance(instanceDeps, {
        functionName,
        conversationId,
        scfSessionId,
        status: 'ready',
        mode,
        sandboxMode: isolation,
        isCodingMode,
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
  async getExisting(
    conversationId: string,
    scfSessionId: string,
    options?: { sandboxMode?: 'shared' | 'isolated' | string; isCodingMode?: boolean },
  ): Promise<SandboxInstance | null> {
    const mode = options?.sandboxMode || 'isolated'
    const functionName = this.generateFunctionName('shared')

    const { exists } = await this.checkFunctionExists(functionName)
    if (!exists) return null

    const instanceDeps = await this.buildInstanceDeps()
    return new SandboxInstance(instanceDeps, {
      functionName,
      conversationId,
      scfSessionId,
      status: 'ready',
      mode: 'shared',
      sandboxMode: mode as any,
      isCodingMode: options?.isCodingMode || false,
    })
  }

  private async createNewFunction(
    functionName: string,
    conversationId: string,
    scfSessionId: string,
    mode: SandboxMode,
    options?: any,
    onProgress?: SandboxProgressCallback,
  ): Promise<SandboxInstance> {
    const progress = onProgress || (() => {})
    const isolation: 'shared' | 'isolated' = options?.workspaceIsolation || 'shared'
    const isCodingMode: boolean = options?.isCodingMode || false

    try {
      progress({ phase: 'create', message: '正在创建工作空间...\n' })

      await this.createFunction(functionName)

      try {
        await Promise.all([
          this.waitForFunctionReady(functionName, undefined, undefined, progress),
          this.createGatewayApi(functionName),
        ])
      } catch (networkError: any) {
        console.error(`[ScfSandbox] Network setup failed, rolling back: ${networkError.message}`)
        await this.deleteFunction(functionName).catch((delErr) => {
          console.warn(`[ScfSandbox] Failed to delete function during rollback: ${delErr.message}`)
        })
        throw new Error(`网络配置失败: ${networkError.message}`)
      }

      const instanceDeps = await this.buildInstanceDeps()
      const mcpConfig = await this.buildSandboxMcpConfig(
        functionName,
        scfSessionId,
        conversationId,
        instanceDeps.sandboxEnvId,
        isolation,
        isCodingMode,
      )

      return new SandboxInstance(instanceDeps, {
        functionName,
        conversationId,
        scfSessionId,
        status: 'ready',
        mode,
        sandboxMode: isolation,
        isCodingMode,
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
    return `${prefix || this.getEnvConfig().functionPrefix}-${sanitized}`.substring(0, 60)
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
            MaximumTTLInSeconds: this.config.sessionTTL,
            MaximumIdleTimeInSeconds: this.config.sessionIdleTimeout,
            IdleTimeoutStrategy: 'FATAL',
          },
        },
        Environment: {
          Variables: [
            ...this.buildGitArchiveVars(),
            { Key: 'VITE_DEV_OVERLAY', Value: process.env.VITE_DEV_OVERLAY || '' },
          ],
        },
        // VpcConfig: {
        //   VpcId: '',
        //   SubnetId: '',
        // },
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
      const domain = await this.getDefaultDomain()

      const app = new CloudBase({
        secretId: envConfig.secretId,
        secretKey: envConfig.secretKey,
        token: envConfig.token,
        envId: envConfig.envId,
      })

      await (app.commonService() as any).call({
        Action: 'CreateCloudBaseGWAPI',
        Param: {
          ServiceId: envConfig.envId,
          Name: functionName,
          Path: `/preview`,
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

  /**
   * 确保该沙箱实例对应的预览网关 API 已注册。
   * 可在 preview-url 接口中调用，保证网关路径可达。
   * 结果按 functionName 缓存，避免每次都调用 CreateCloudBaseGWAPI。
   *
   * 参数接受 SandboxInstance 而不是 Task，是因为 functionName 的权威来源
   * 在 SandboxInstance 上（由 getOrCreate 生成并持久化到实例），避免此处
   * 再通过 task.sandboxMode 推算一次、两套生成规则飘移。
   */
  private gatewayEnsuredFunctions = new Set<string>()

  async ensurePreviewGateway(sandbox: SandboxInstance): Promise<string> {
    const domain = await this.getDefaultDomain()
    const previewBase = `https://${domain}/preview`

    const functionName = sandbox.functionName
    if (this.gatewayEnsuredFunctions.has(functionName)) return previewBase

    try {
      await this.createGatewayApi(functionName)
      console.log(`[ScfSandbox] ensurePreviewGateway: gateway OK (${functionName})`)
    } catch (err: any) {
      // "api created" / ResourceInUse = already exists, that's fine
      if (!err.message?.includes('api created') && !err.message?.includes('ResourceInUse')) {
        console.warn(`[ScfSandbox] ensurePreviewGateway: createGatewayApi error: ${err.message}`)
      }
    }
    this.gatewayEnsuredFunctions.add(functionName)
    return previewBase
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

  private async waitForFunctionReady(
    functionName: string,
    maxRetries = 120,
    retryInterval = 3000,
    onProgress?: SandboxProgressCallback,
  ): Promise<void> {
    const envConfig = this.getEnvConfig()

    const app = new CloudBase({
      secretId: envConfig.secretId,
      secretKey: envConfig.secretKey,
      token: envConfig.token,
      envId: envConfig.envId,
    })

    let progressEmitted = false
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
        if (!progressEmitted) {
          progressEmitted = true
          onProgress?.({ phase: 'wait_creating', message: '沙箱启动中...\n' })
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

  private buildGitPersonalVars(): { Key: string; Value: string }[] {
    const auth = process.env.GIT_PERSONAL_AUTH

    return [{ Key: 'GIT_PERSONAL_AUTH', Value: auth || '' }]
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
