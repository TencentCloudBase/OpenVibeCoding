/**
 * Sandbox MCP Proxy
 *
 * Simplified version of sandbox-mcp-proxy-server.ts
 * - No NestJS dependencies
 * - Uses native fetch for HTTP calls
 * - Creates MCP server proxying to sandbox
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SandboxInstance } from './scf-sandbox-manager.js'
import { tool as sdkTool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import cron from 'node-cron'
import { getDb } from '../db/index.js'
import { scheduleTask, unscheduleTask } from '../services/cron-scheduler.js'

// ─── Types ───────────────────────────────────────────────────────

export interface SandboxMcpDeps {
  /** 沙箱 CloudBase Gateway 基础 URL */
  baseUrl: string
  /** SCF session ID (envId) for X-Cloudbase-Session-Id header */
  scfSessionId: string
  /** Conversation ID for per-conversation isolation in shared container */
  conversationId: string
  /** 获取最新网关 access token（带缓存，调每次都是最新） */
  getAccessToken: () => Promise<string>
  /** 获取最新 TencentCloud 密钥（用于注入容器 env） */
  getCredentials: () => Promise<{
    cloudbaseEnvId: string
    secretId: string
    secretKey: string
    sessionToken?: string
  }>
  /** bash 超时 ms，默认 30000 */
  bashTimeoutMs?: number
  /** 工作目录（注入给容器） */
  workspaceFolderPaths?: string
  /** 日志输出，默认 console.log */
  log?: (msg: string) => void
  /** uploadFiles 工具成功返回时的回调，用于触发 artifact 事件 */
  onArtifact?: (artifact: {
    title: string
    contentType: 'image' | 'link' | 'json'
    data: string
    metadata?: Record<string, unknown>
  }) => void
  /** 根据 appId 查询小程序部署凭证 */
  getMpDeployCredentials?: (appId: string) => Promise<{ appId: string; privateKey: string } | null>
  /** 当前用户 ID，用于 cronTask 等工具 */
  userId?: string
  /** 当前使用的模型 ID */
  currentModel?: string
}

// ─── Auth Error ──────────────────────────────────────────────────

class AuthRequiredError extends Error {
  constructor(status: number) {
    super(`MCP_AUTH_REQUIRED: gateway returned ${status}`)
    this.name = 'AuthRequiredError'
  }
}

// ─── JSON Schema to Zod conversion ─────────────────────────────────

function jsonSchemaToZodRawShape(schema: any): Record<string, z.ZodTypeAny> {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return {}
  }

  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(schema.required || [])

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    let zodType = jsonSchemaPropertyToZod(propSchema as any)
    if (!required.has(key)) {
      zodType = zodType.optional()
    }
    shape[key] = zodType
  }

  return shape
}

function jsonSchemaPropertyToZod(propSchema: any): z.ZodTypeAny {
  if (!propSchema) return z.any()

  const { type, description, enum: enumValues, items, properties, required } = propSchema

  let zodType: z.ZodTypeAny

  if (enumValues && Array.isArray(enumValues)) {
    zodType = z.enum(enumValues as [string, ...string[]])
  } else if (type === 'string') {
    zodType = z.string()
  } else if (type === 'number' || type === 'integer') {
    zodType = z.number()
  } else if (type === 'boolean') {
    zodType = z.boolean()
  } else if (type === 'array') {
    const itemType = items ? jsonSchemaPropertyToZod(items) : z.any()
    zodType = z.array(itemType)
  } else if (type === 'object') {
    if (properties) {
      const shape: Record<string, z.ZodTypeAny> = {}
      const reqSet = new Set(required || [])
      for (const [k, v] of Object.entries(properties)) {
        let propType = jsonSchemaPropertyToZod(v as any)
        if (!reqSet.has(k)) propType = propType.optional()
        shape[k] = propType
      }
      zodType = z.object(shape)
    } else {
      zodType = z.record(z.string(), z.any())
    }
  } else {
    zodType = z.any()
  }

  if (description) {
    zodType = zodType.describe(description)
  }

  return zodType
}

// ─── Core factory ────────────────────────────────────────────────

/**
 * 创建沙箱 MCP Server 并通过 InMemoryTransport 返回已连接的 Client。
 *
 * - 完全在进程内，零 IPC 开销，无 stdio/子进程
 * - getAccessToken / getCredentials 每次调用都是最新，天然解决 token 过期
 * - Server 内部对 gateway 401/403 抛出 AuthRequiredError，Client 侧可感知并重连
 */
export async function createSandboxMcpClient(deps: SandboxMcpDeps): Promise<{
  client: Client
  /** McpServer 实例（@modelcontextprotocol/sdk），供直接操作 */
  server: McpServer
  /** SDK MCP Server（@tencent-ai/agent-sdk createSdkMcpServer），传入 query() 的 mcpServers 选项 */
  sdkServer: ReturnType<typeof createSdkMcpServer>
  /** 显式关闭，释放 transport pair */
  close: () => Promise<void>
}> {
  const {
    baseUrl,
    scfSessionId,
    conversationId,
    getAccessToken,
    getCredentials,
    bashTimeoutMs = 30_000,
    workspaceFolderPaths = '',
    log = (msg: string) => console.log(msg),
    onArtifact,
    getMpDeployCredentials,
    userId: depsUserId,
    currentModel: depsCurrentModel,
  } = deps

  // ── HTTP helpers ────────────────────────────────────────────────

  async function buildHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken()
    return {
      'Content-Type': 'application/json',
      ...SandboxInstance.buildAuthHeaders(token, scfSessionId),
      'X-Conversation-Id': conversationId,
    }
  }

  async function apiCall(tool: string, body: unknown, timeoutMs = bashTimeoutMs): Promise<any> {
    const headers = await buildHeaders()
    const res = await fetch(`${baseUrl}/api/tools/${tool}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 || res.status === 403) {
      throw new AuthRequiredError(res.status)
    }
    const data = (await res.json()) as any
    if (!data.success) throw new Error(data.error ?? `${tool} call failed`)
    return data.result
  }

  async function bashCall(command: string, timeoutMs = bashTimeoutMs): Promise<any> {
    return apiCall('bash', { command, timeout: timeoutMs }, timeoutMs)
  }

  async function injectCredentials(): Promise<void> {
    const creds = await getCredentials()
    const headers = await buildHeaders()
    const res = await fetch(`${baseUrl}/api/session/env`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        conversationId,
        CLOUDBASE_ENV_ID: creds.cloudbaseEnvId,
        TENCENTCLOUD_SECRETID: creds.secretId,
        TENCENTCLOUD_SECRETKEY: creds.secretKey,
        TENCENTCLOUD_SESSIONTOKEN: creds.sessionToken ?? '',
        INTEGRATION_IDE: 'codebuddy',
        WORKSPACE_FOLDER_PATHS: workspaceFolderPaths,
      }),
    })
    if (res.status === 401 || res.status === 403) throw new AuthRequiredError(res.status)
    const data = (await res.json()) as any
    if (!data.success) throw new Error(`Failed to inject credentials: ${data.error}`)
  }

  // ── CloudBase schema (via mcporter in container) ─────────────────

  async function fetchCloudbaseSchema(): Promise<any[]> {
    const tmpPath = `.mcporter-schema.json`
    await bashCall(`mcporter list cloudbase --schema --output json > ${tmpPath} 2>&1`, 20_000)
    const headers = await buildHeaders()
    const res = await fetch(`${baseUrl}/e2b-compatible/files?path=${encodeURIComponent(tmpPath)}`, {
      headers,
    })
    if (!res.ok) throw new Error(`Failed to read schema file: ${res.status}`)
    const parsed = (await res.json()) as any
    if (!Array.isArray(parsed.tools)) throw new Error('No tools array in schema response')
    return parsed.tools
  }

  // ── mcporter call serializer ──────────────────────────────────

  function serializeFnCall(toolName: string, args: Record<string, unknown>): string {
    if (!args || Object.keys(args).length === 0) return `cloudbase.${toolName}()`
    const parts = Object.entries(args)
      .map(([k, v]) => {
        if (v === undefined || v === null) return null
        if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`
        if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${v}`
        return `${k}: ${JSON.stringify(v)}`
      })
      .filter(Boolean)
      .join(', ')
    return `cloudbase.${toolName}(${parts})`
  }

  async function mcporterCall(toolName: string, args: Record<string, unknown>): Promise<any> {
    const expr = serializeFnCall(toolName, args)
    const escaped = expr.replace(/'/g, "'\\''")
    const cmd = `mcporter call '${escaped}' 2>&1`
    log(`[sandbox-mcp] bash cmd: ${cmd}\n`)
    return bashCall(cmd, 60_000)
  }

  function isFilePath(localPath: string): boolean {
    const basename = localPath.replace(/\/+$/, '').split('/').pop() || ''
    return /\.[a-zA-Z0-9]+$/.test(basename)
  }

  function extractDeployUrl(rawText: string, isFile = false, depth = 0): string | null {
    if (depth > 5) return null
    try {
      const parsed = JSON.parse(rawText)
      if (Array.isArray(parsed)) {
        const firstText = parsed[0]?.text
        if (typeof firstText === 'string') return extractDeployUrl(firstText, isFile, depth + 1)
        return null
      }
      if (typeof parsed !== 'object' || parsed === null) return null
      if (parsed.accessUrl) {
        const url = new URL(parsed.accessUrl)
        if (!isFile && url.pathname !== '/' && !url.pathname.endsWith('/')) url.pathname += '/'
        if (!url.searchParams.get('t')) url.searchParams.set('t', String(Date.now()))
        return url.toString()
      }
      if (parsed.staticDomain) return `https://${parsed.staticDomain}/?t=${Date.now()}`
      const innerText = parsed?.res?.content?.[0]?.text || parsed?.content?.[0]?.text
      if (typeof innerText === 'string') return extractDeployUrl(innerText, isFile, depth + 1)
    } catch {
      // JSON parse 失败，忽略
    }
    return null
  }

  function isCredentialError(output: string): boolean {
    return (
      output.includes('AUTH_REQUIRED') ||
      output.includes('The SecretId is not found') ||
      output.includes('SecretId is not found') ||
      output.includes('InvalidParameter.SecretIdNotFound') ||
      output.includes('AuthFailure')
    )
  }

  // ── Inject credentials first, then fetch tools ───────────────
  // Must inject before fetchCloudbaseSchema so mcporter can authenticate
  try {
    await injectCredentials()
    log(`[sandbox-mcp] Credentials injected successfully\n`)
  } catch (e: any) {
    log(`[sandbox-mcp] Failed to inject credentials: ${e.message}\n`)
  }

  // ── Fetch CloudBase tools (degraded on failure) ───────────────

  let cloudbaseTools: any[] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cloudbaseTools = await fetchCloudbaseSchema()
      log(`[sandbox-mcp] Discovered ${cloudbaseTools.length} CloudBase tools (attempt ${attempt})\n`)
      break
    } catch (e: any) {
      log(`[sandbox-mcp] Schema fetch failed (attempt ${attempt}/3): ${e.message}\n`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3_000))
      else log(`[sandbox-mcp] Starting in degraded mode (workspace tools only)\n`)
    }
  }

  // ── Build MCP Server ──────────────────────────────────────────

  const server = new McpServer({ name: 'cloudbase-sandbox-proxy', version: '2.0.0' })

  const SKIP = new Set(['logout', 'interactiveDialog'])

  for (const tool of cloudbaseTools) {
    if (SKIP.has(tool.name)) continue

    // login：无参数，用最新 credentials 重注入
    if (tool.name === 'login') {
      server.tool(
        'login',
        'Re-authenticate CloudBase credentials for this workspace session. No parameters needed.',
        {},
        async () => {
          try {
            await injectCredentials()
            return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] }
          } catch (e: any) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, message: e.message }) }],
              isError: true,
            }
          }
        },
      )
      continue
    }

    const zodShape = jsonSchemaToZodRawShape(tool.inputSchema)
    server.tool(
      tool.name,
      (tool.description ?? `CloudBase tool: ${tool.name}`) +
        '\n\nNOTE: localPath refers to paths inside the container workspace.',
      zodShape as any,
      async (args: Record<string, unknown>) => {
        if (tool.name === 'auth' && args?.action === 'start_auth') {
          try {
            await injectCredentials()
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify({ ok: true, message: 'Credentials refreshed' }) },
              ],
            }
          } catch (e: any) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, message: e.message }) }],
              isError: true,
            }
          }
        }

        if (tool.name === 'downloadTemplate') args = { ...args, ide: 'codebuddy' }

        const attemptCall = async () => {
          const result = await mcporterCall(tool.name, args)
          return result.output ?? ''
        }

        try {
          let output = await attemptCall()

          if (isCredentialError(output)) {
            log(`[sandbox-mcp] Credential error for ${tool.name}, re-injecting...\n`)
            await injectCredentials()
            output = await attemptCall()
            if (isCredentialError(output)) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: output + '\n\nCredential re-injection attempted but error persists.',
                  },
                ],
                isError: true,
              }
            }
          }

          return { content: [{ type: 'text' as const, text: output }] }
        } catch (e: any) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${e.message}` }],
            isError: true,
          }
        }
      },
    )
  }

  // ── 若 cloudbaseTools 为空，注册一个占位 tool 确保 McpServer 声明 tools capability
  // 否则 MCP SDK 1.x 在握手时不广告 tools，client.listTools() 会抛 -32601 Method not found
  if (cloudbaseTools.length === 0) {
    server.tool('__noop__', 'Placeholder tool. CloudBase tools are unavailable in degraded mode.', {}, async () => ({
      content: [{ type: 'text' as const, text: 'CloudBase tools unavailable (degraded mode)' }],
      isError: true,
    }))
  }

  // ── publishMiniprogram tool ───────────────────────────────────
  server.tool(
    'publishMiniprogram',
    '小程序发布/预览工具。支持预览（preview）和上传（upload）两种操作。预览会生成二维码供扫码体验，上传会将代码提交到微信后台。部署可能耗时较长，若超过 60s 未完成会返回 async=true 和 jobId，请使用 getDeployJobStatus 工具查询结果。',
    {
      action: z.enum(['preview', 'upload']).describe('操作类型：preview=预览, upload=上传'),
      projectPath: z.string().describe('小程序项目路径（沙箱内的绝对路径）'),
      appId: z.string().describe('微信小程序 AppId'),
      version: z.string().optional().describe('版本号（upload 时建议提供，如 "1.0.0"）'),
      description: z.string().optional().describe('版本描述'),
      robot: z.number().optional().describe('CI 机器人编号（1-30），默认 1'),
    },
    async (args: Record<string, unknown>) => {
      try {
        let privateKey: string | undefined
        const appId = args.appId as string

        if (getMpDeployCredentials) {
          const creds = await getMpDeployCredentials(appId)
          if (creds) {
            privateKey = creds.privateKey
          }
        }

        if (!privateKey) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: true,
                  message: `未找到 appId ${appId} 的部署密钥，请先在小程序管理中关联该 appId`,
                }),
              },
            ],
            isError: true,
          }
        }

        const headers = await buildHeaders()
        const res = await fetch(`${baseUrl}/api/miniprogram/deploy`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            appid: appId,
            privateKey,
            action: args.action,
            projectPath: args.projectPath,
            version: args.version,
            description: args.description,
            robot: args.robot,
          }),
          signal: AbortSignal.timeout(120_000),
        })

        const body = (await res.json().catch(() => null)) as any

        if (!res.ok || !body) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: true,
                  status: res.status,
                  message: body?.error || body?.message || `HTTP ${res.status}`,
                }),
              },
            ],
            isError: true,
          }
        }

        if (body.async) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  async: true,
                  jobId: body.jobId,
                  message: '部署仍在进行中，请稍后使用 getDeployJobStatus 工具查询结果',
                }),
              },
            ],
          }
        }

        if (!body.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: true,
                  message: body.error || body.result?.errMsg || 'Deploy failed',
                  result: body.result,
                }),
              },
            ],
            isError: true,
          }
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] }
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: e.message }) }],
          isError: true,
        }
      }
    },
  )

  // ── getDeployJobStatus tool ───────────────────────────────────
  server.tool(
    'getDeployJobStatus',
    '查询小程序发布/预览任务的状态。当 publishMiniprogram 返回 async=true 时使用此工具轮询结果。',
    { jobId: z.string().describe('publishMiniprogram 返回的 jobId') },
    async (args: Record<string, unknown>) => {
      try {
        const headers = await buildHeaders()
        const res = await fetch(
          `${baseUrl}/api/miniprogram/deploy/status?jobId=${encodeURIComponent(args.jobId as string)}`,
          {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(30_000),
          },
        )
        const body = (await res.json().catch(() => null)) as any
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body ?? { error: true, status: res.status }) }],
        }
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: e.message }) }],
          isError: true,
        }
      }
    },
  )

  // ── Wire InMemoryTransport pair ───────────────────────────────

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'cloudbase-agent', version: '1.0.0' })
  await client.connect(clientTransport)

  // ── Build SDK MCP Server for passing to query() mcpServers ────
  // createSdkMcpServer is needed because agent-sdk's mcpServers option
  // requires SDK-wrapped servers (not raw @modelcontextprotocol/sdk McpServer).
  // We re-wrap the same tools using sdkTool() + createSdkMcpServer().
  const sdkTools = cloudbaseTools
    .filter((t: any) => t.name !== 'logout')
    .map((t: any) => {
      const zodShape = jsonSchemaToZodRawShape(t.inputSchema)
      return sdkTool(
        t.name,
        (t.description ?? `CloudBase tool: ${t.name}`) +
          '\n\nNOTE: localPath refers to paths inside the container workspace.',
        zodShape as any,
        async (args: Record<string, unknown>) => {
          try {
            const result = await mcporterCall(t.name, args)
            const output = result.output ?? ''

            // 检测 uploadFiles 结果，提取部署 URL
            if (t.name === 'uploadFiles' && onArtifact && output) {
              try {
                const deployUrl = extractDeployUrl(output, isFilePath(String(args.localPath || '')))
                if (deployUrl) {
                  log(`[sandbox-mcp] deploy artifact detected\n`)
                  onArtifact({
                    title: 'Web 应用已部署',
                    contentType: 'link',
                    data: deployUrl,
                    metadata: { deploymentType: 'web' },
                  })
                }
              } catch {
                // 提取失败不影响主流程
              }
            }

            return { content: [{ type: 'text' as const, text: output }] }
          } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
          }
        },
      )
    })

  // SDK-wrapped publishMiniprogram tool
  sdkTools.push(
    sdkTool(
      'publishMiniprogram',
      '小程序发布/预览工具。支持预览（preview）和上传（upload）两种操作。',
      {
        action: z.enum(['preview', 'upload']).describe('操作类型'),
        projectPath: z.string().describe('小程序项目路径'),
        appId: z.string().describe('微信小程序 AppId'),
        version: z.string().optional().describe('版本号'),
        description: z.string().optional().describe('版本描述'),
        robot: z.number().optional().describe('CI 机器人编号'),
      },
      async (args: Record<string, unknown>) => {
        try {
          let privateKey: string | undefined
          const appId = args.appId as string

          if (getMpDeployCredentials) {
            const creds = await getMpDeployCredentials(appId)
            if (creds) privateKey = creds.privateKey
          }

          if (!privateKey) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: true, message: `未找到 appId ${appId} 的部署密钥` }),
                },
              ],
              isError: true,
            }
          }

          const headers = await buildHeaders()
          const res = await fetch(`${baseUrl}/api/miniprogram/deploy`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              appid: appId,
              privateKey,
              action: args.action,
              projectPath: args.projectPath,
              version: args.version,
              description: args.description,
              robot: args.robot,
            }),
            signal: AbortSignal.timeout(120_000),
          })

          const body = (await res.json().catch(() => null)) as any
          if (!res.ok || !body) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: true, status: res.status }) }],
              isError: true,
            }
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] }
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
        }
      },
    ),
  )

  // SDK-wrapped getDeployJobStatus tool
  sdkTools.push(
    sdkTool(
      'getDeployJobStatus',
      '查询小程序发布/预览任务的状态。',
      { jobId: z.string().describe('publishMiniprogram 返回的 jobId') },
      async (args: Record<string, unknown>) => {
        try {
          const headers = await buildHeaders()
          const res = await fetch(
            `${baseUrl}/api/miniprogram/deploy/status?jobId=${encodeURIComponent(args.jobId as string)}`,
            {
              method: 'GET',
              headers,
              signal: AbortSignal.timeout(30_000),
            },
          )
          const body = (await res.json().catch(() => null)) as any
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(body ?? { error: true, status: res.status }) }],
          }
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
        }
      },
    ),
  )

  // ── cronTask tool (CRUD) ──────────────────────────────────────
  if (depsUserId) {
    sdkTools.push(
      sdkTool(
        'cronTask',
        '定时任务管理工具。支持创建、查询、更新、删除定时任务。定时任务到达设定时间后会自动创建 Agent 会话执行指定操作。当用户提到定时、定期、每天/每周/每小时执行时使用此工具。',
        {
          action: z.enum(['create', 'list', 'update', 'delete']).describe('操作类型'),
          id: z.string().optional().describe('任务 ID（update/delete 时必填）'),
          name: z.string().optional().describe('任务名称（create 时必填）'),
          prompt: z.string().optional().describe('Agent 要执行的内容（create 时必填）'),
          cronExpression: z.string().optional().describe('Cron 表达式，如 "0 20 * * *"（create 时必填）'),
          enabled: z.boolean().optional().describe('是否启用，默认 true'),
        },
        async (args: Record<string, unknown>) => {
          try {
            const action = args.action as string
            const userId = depsUserId

            if (action === 'list') {
              const tasks = await getDb().cronTasks.findByUserId(userId)
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      success: true,
                      data: tasks.map((t) => ({
                        id: t.id,
                        name: t.name,
                        prompt: t.prompt,
                        cronExpression: t.cronExpression,
                        enabled: t.enabled,
                        lastRunAt: t.lastRunAt,
                      })),
                    }),
                  },
                ],
              }
            }

            if (action === 'create') {
              const name = args.name as string
              const prompt = args.prompt as string
              const cronExpression = args.cronExpression as string
              const enabled = (args.enabled as boolean) ?? true

              if (!name || !prompt || !cronExpression) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({ error: true, message: 'create 需要 name、prompt、cronExpression' }),
                    },
                  ],
                  isError: true,
                }
              }

              if (!cron.validate(cronExpression)) {
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify({ error: true, message: 'Cron 表达式无效' }) },
                  ],
                  isError: true,
                }
              }

              const newTask = await getDb().cronTasks.create({
                id: nanoid(),
                userId,
                name,
                prompt,
                cronExpression,
                enabled,
                repoUrl: null,
                selectedAgent: 'codebuddy',
                selectedModel: depsCurrentModel || 'gml-5.0',
                lastRunAt: null,
                nextRunAt: null,
                lockedBy: null,
                lockedAt: null,
              })

              if (newTask.enabled) {
                scheduleTask(newTask)
              }

              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      success: true,
                      id: newTask.id,
                      name: newTask.name,
                      cronExpression: newTask.cronExpression,
                      enabled: newTask.enabled,
                    }),
                  },
                ],
              }
            }

            if (action === 'update') {
              const id = args.id as string
              if (!id) {
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify({ error: true, message: 'update 需要 id' }) },
                  ],
                  isError: true,
                }
              }
              if (args.cronExpression && !cron.validate(args.cronExpression as string)) {
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify({ error: true, message: 'Cron 表达式无效' }) },
                  ],
                  isError: true,
                }
              }
              const updateData: Record<string, unknown> = {}
              if (args.name !== undefined) updateData.name = args.name
              if (args.prompt !== undefined) updateData.prompt = args.prompt
              if (args.cronExpression !== undefined) updateData.cronExpression = args.cronExpression
              if (args.enabled !== undefined) updateData.enabled = args.enabled

              const updated = await getDb().cronTasks.update(id, userId, updateData)
              if (!updated) {
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: '任务不存在' }) }],
                  isError: true,
                }
              }
              if (updated.enabled) {
                scheduleTask(updated)
              } else {
                unscheduleTask(updated.id)
              }
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      success: true,
                      id: updated.id,
                      name: updated.name,
                      enabled: updated.enabled,
                    }),
                  },
                ],
              }
            }

            if (action === 'delete') {
              const id = args.id as string
              if (!id) {
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify({ error: true, message: 'delete 需要 id' }) },
                  ],
                  isError: true,
                }
              }
              const existing = await getDb().cronTasks.findByIdAndUserId(id, userId)
              if (!existing) {
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: '任务不存在' }) }],
                  isError: true,
                }
              }
              unscheduleTask(id)
              await getDb().cronTasks.delete(id, userId)
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: '已删除' }) }],
              }
            }

            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: '未知操作' }) }],
              isError: true,
            }
          } catch (e: any) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: e.message }) }],
              isError: true,
            }
          }
        },
      ),
    )
  }

  const sdkServer = createSdkMcpServer({
    name: 'cloudbase',
    version: '1.0.0',
    tools: sdkTools,
  })

  log(
    `[sandbox-mcp] Ready. baseUrl=${baseUrl} session=${scfSessionId} conversation=${conversationId} tools=${cloudbaseTools.length}\n`,
  )

  return {
    client,
    server,
    sdkServer,
    close: async () => {
      try {
        await client.close()
      } catch {}
      try {
        await server.close()
      } catch {}
    },
  }
}
