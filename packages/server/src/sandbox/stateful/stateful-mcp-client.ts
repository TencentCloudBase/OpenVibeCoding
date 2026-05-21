/**
 * Stateful sandbox MCP client
 *
 * TRW for_vibecoding / vibecoding preset data plane.
 * Protocol:
 *   - PUT /api/workspace/env       inject credentials (NOT /api/session/env)
 *   - POST /api/tools/{tool}       tool execution
 *   - mcporter in vibecoding image (/opt/cloudbase-mcp)
 *
 * Shared workspace at /home/user (no scope headers). Miniprogram jobs: STATEFUL_MINIPROGRAM_FEATURE.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { tool as sdkTool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import cron from 'node-cron'

import type { McpClientBundle, McpDeps } from '../provider/types.js'
import { adaptDeployJobStatus, adaptMiniprogramDeployStart } from '../trw-deploy-adapter.js'
import { getDb } from '../../db/index.js'
import { scheduleTask, unscheduleTask } from '../../services/cron-scheduler.js'

// ─── Auth Error ──────────────────────────────────────────────────

class AuthRequiredError extends Error {
  constructor(status: number) {
    super(`MCP_AUTH_REQUIRED: gateway returned ${status}`)
    this.name = 'AuthRequiredError'
  }
}

// ─── JSON Schema → Zod ───────────────────────────────────────────

function jsonSchemaToZodRawShape(schema: any): Record<string, z.ZodTypeAny> {
  if (!schema || schema.type !== 'object' || !schema.properties) return {}
  const shape: Record<string, z.ZodTypeAny> = {}
  const required = new Set(schema.required || [])
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    let zodType = jsonSchemaPropertyToZod(propSchema as any)
    if (!required.has(key)) zodType = zodType.optional()
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
  if (description) zodType = zodType.describe(description)
  return zodType
}

// ─── Helpers ─────────────────────────────────────────────────────

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
    // ignore
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

// ─── MCP Client factory ──────────────────────────────────────────

const MINIPROGRAM_FEATURE_ENABLED = (process.env.STATEFUL_MINIPROGRAM_FEATURE || '').toLowerCase() === 'true'

export async function createStatefulMcpClient(deps: McpDeps): Promise<McpClientBundle> {
  const {
    sandbox,
    getCredentials,
    bashTimeoutMs = 30_000,
    workspaceFolderPaths = '',
    log = (msg: string) => console.log(msg),
    onArtifact,
    getMpDeployCredentials,
    userId: depsUserId,
    currentModel: depsCurrentModel,
  } = deps

  // ── HTTP helpers via sandbox.request (auth + routing auto-injected) ──

  async function apiCall(tool: string, body: unknown, timeoutMs = bashTimeoutMs): Promise<any> {
    const res = await sandbox.request(`/api/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 || res.status === 403) throw new AuthRequiredError(res.status)
    const data = (await res.json()) as any
    if (!data.success) throw new Error(data.error ?? `${tool} call failed`)
    return data.result
  }

  async function bashCall(command: string, timeoutMs = bashTimeoutMs): Promise<any> {
    return apiCall('bash', { command, timeout: timeoutMs }, timeoutMs)
  }

  // AGS-specific: credentials go to /api/workspace/env (PUT, flat KV body).
  async function injectCredentials(): Promise<void> {
    const creds = await getCredentials()
    const res = await sandbox.request('/api/workspace/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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

  async function fetchCloudbaseSchema(): Promise<any[]> {
    const tmpPath = `.mcporter-schema.json`
    await bashCall(`mcporter list cloudbase --schema --output json > ${tmpPath} 2>&1`, 20_000)
    const res = await sandbox.request('/api/tools/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpPath }),
    })
    if (!res.ok) throw new Error(`Failed to read schema file: ${res.status}`)
    const data = (await res.json()) as { success?: boolean; result?: { content?: string } }
    if (!data.success || !data.result?.content) throw new Error('Empty schema file')
    const parsed = JSON.parse(data.result.content) as any
    if (!Array.isArray(parsed.tools)) throw new Error('No tools array in schema response')
    return parsed.tools
  }

  async function mcporterCall(toolName: string, args: Record<string, unknown>): Promise<any> {
    const expr = serializeFnCall(toolName, args)
    const escaped = expr.replace(/'/g, "'\\''")
    const cmd = `mcporter call '${escaped}' 2>&1`
    log(`[stateful-mcp] bash cmd: ${cmd}\n`)
    return bashCall(cmd, 60_000)
  }

  // ── Inject credentials before fetching tools ──
  try {
    await injectCredentials()
    log(`[stateful-mcp] Credentials injected successfully\n`)
  } catch (e: any) {
    log(`[stateful-mcp] Failed to inject credentials: ${e.message}\n`)
  }

  // ── Fetch CloudBase tool schema (degraded on failure) ──
  let cloudbaseTools: any[] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cloudbaseTools = await fetchCloudbaseSchema()
      log(`[stateful-mcp] Discovered ${cloudbaseTools.length} CloudBase tools (attempt ${attempt})\n`)
      break
    } catch (e: any) {
      log(`[stateful-mcp] Schema fetch failed (attempt ${attempt}/3): ${e.message}\n`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3_000))
      else log(`[stateful-mcp] Starting in degraded mode (workspace tools only)\n`)
    }
  }

  // ── Build MCP Server ──
  const server = new McpServer({ name: 'stateful-cloudbase-sandbox-proxy', version: '1.0.0' })
  const SKIP = new Set(['logout', 'interactiveDialog'])

  for (const tool of cloudbaseTools) {
    if (SKIP.has(tool.name)) continue

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
            log(`[stateful-mcp] Credential error for ${tool.name}, re-injecting...\n`)
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

  if (cloudbaseTools.length === 0) {
    server.tool('__noop__', 'Placeholder tool. CloudBase tools are unavailable in degraded mode.', {}, async () => ({
      content: [{ type: 'text' as const, text: 'CloudBase tools unavailable (degraded mode)' }],
      isError: true,
    }))
  }

  // ── publishMiniprogram (gated by env: AGS master may not have the endpoint) ──
  const miniprogramDegradedResponse = (extra?: Record<string, unknown>) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message:
            'Miniprogram deploy is not enabled on this AGS deployment. ' +
            'Set STATEFUL_MINIPROGRAM_FEATURE=true once /api/jobs/miniprogram-deploy is available.',
          ...extra,
        }),
      },
    ],
    isError: true,
  })

  server.tool(
    'publishMiniprogram',
    '小程序发布/预览工具。支持预览（preview）和上传（upload）两种操作。',
    {
      action: z.enum(['preview', 'upload']).describe('操作类型：preview=预览, upload=上传'),
      projectPath: z.string().describe('小程序项目路径（沙箱内的绝对路径）'),
      appId: z.string().describe('微信小程序 AppId'),
      version: z.string().optional().describe('版本号'),
      description: z.string().optional().describe('版本描述'),
      robot: z.number().optional().describe('CI 机器人编号'),
    },
    async (args: Record<string, unknown>) => {
      if (!MINIPROGRAM_FEATURE_ENABLED) return miniprogramDegradedResponse()
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
                text: JSON.stringify({
                  error: true,
                  message: `未找到 appId ${appId} 的部署密钥，请先在小程序管理中关联该 appId`,
                }),
              },
            ],
            isError: true,
          }
        }
        const res = await sandbox.request('/api/jobs/miniprogram-deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        const rawBody = (await res.json().catch(() => null)) as unknown
        if (!res.ok && res.status !== 202) {
          const r = (rawBody ?? {}) as Record<string, unknown>
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: true,
                  status: res.status,
                  message: (r.error as string | undefined) || (r.message as string | undefined) || `HTTP ${res.status}`,
                }),
              },
            ],
            isError: true,
          }
        }
        const body = adaptMiniprogramDeployStart(res.status, rawBody)
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
                  message: body.error || (body.result as { errMsg?: string } | undefined)?.errMsg || 'Deploy failed',
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

  server.tool(
    'getDeployJobStatus',
    '查询小程序发布/预览任务的状态。',
    { jobId: z.string().describe('publishMiniprogram 返回的 jobId') },
    async (args: Record<string, unknown>) => {
      if (!MINIPROGRAM_FEATURE_ENABLED) return miniprogramDegradedResponse({ jobId: args.jobId })
      try {
        const res = await sandbox.request(`/api/jobs/${encodeURIComponent(args.jobId as string)}`, {
          signal: AbortSignal.timeout(30_000),
        })
        const rawBody = (await res.json().catch(() => null)) as unknown
        const body = res.ok && rawBody ? adaptDeployJobStatus(rawBody) : { error: true, status: res.status }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body) }],
        }
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: e.message }) }],
          isError: true,
        }
      }
    },
  )

  // ── Wire InMemoryTransport pair ──
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'stateful-cloudbase-agent', version: '1.0.0' })
  await client.connect(clientTransport)

  // ── Build SDK MCP Server ──
  const sdkTools = cloudbaseTools
    .filter((t: any) => t.name !== 'logout' && t.name !== 'interactiveDialog')
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
            if (t.name === 'uploadFiles' && onArtifact && output) {
              try {
                const deployUrl = extractDeployUrl(output, isFilePath(String(args.localPath || '')))
                if (deployUrl) {
                  log(`[stateful-mcp] deploy artifact detected\n`)
                  onArtifact({
                    title: 'Web 应用已部署',
                    contentType: 'link',
                    data: deployUrl,
                    metadata: { deploymentType: 'web' },
                  })
                }
              } catch {
                // ignore
              }
            }
            return { content: [{ type: 'text' as const, text: output }] }
          } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
          }
        },
      )
    })

  // SDK-wrapped publishMiniprogram (mirrors server.tool above, gated)
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
        if (!MINIPROGRAM_FEATURE_ENABLED) return miniprogramDegradedResponse()
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
          const res = await sandbox.request('/api/jobs/miniprogram-deploy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
          const rawBody = (await res.json().catch(() => null)) as unknown
          if (!res.ok && res.status !== 202) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: true, status: res.status }) }],
              isError: true,
            }
          }
          const body = adaptMiniprogramDeployStart(res.status, rawBody)
          return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] }
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
        }
      },
    ),
  )

  sdkTools.push(
    sdkTool(
      'getDeployJobStatus',
      '查询小程序发布/预览任务的状态。',
      { jobId: z.string().describe('publishMiniprogram 返回的 jobId') },
      async (args: Record<string, unknown>) => {
        if (!MINIPROGRAM_FEATURE_ENABLED) return miniprogramDegradedResponse({ jobId: args.jobId })
        try {
          const res = await sandbox.request(`/api/jobs/${encodeURIComponent(args.jobId as string)}`, {
            signal: AbortSignal.timeout(30_000),
          })
          const rawBody = (await res.json().catch(() => null)) as unknown
          const body = res.ok && rawBody ? adaptDeployJobStatus(rawBody) : { error: true, status: res.status }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(body) }],
          }
        } catch (e: any) {
          return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true }
        }
      },
    ),
  )

  // ── cronTask (CRUD via OVC local DB; identical to SCF version) ──
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
                selectedModel: depsCurrentModel || 'hy3-preview-ioa',
                lastRunAt: null,
                nextRunAt: null,
                lockedBy: null,
                lockedAt: null,
              })
              if (newTask.enabled) scheduleTask(newTask)
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
              if (updated.enabled) scheduleTask(updated)
              else unscheduleTask(updated.id)
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
    `[stateful-mcp] Ready. baseUrl=${sandbox.baseUrl} sandboxId=${sandbox.id} tools=${cloudbaseTools.length} miniprogram=${MINIPROGRAM_FEATURE_ENABLED}\n`,
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
