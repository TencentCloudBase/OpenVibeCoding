/**
 * CloudBase MCP 公共实现
 *
 * 内容：
 *   1. mcporter CLI 相关纯函数（JSON Schema↔Zod、调用序列化、工具发现、凭证错误识别）
 *   2. 统一日志工厂（createCloudbaseMcpLogger）
 *   3. 凭证注入工厂（createInjectCredentials）—— 通过 userId+envId 反查凭证并注入沙箱
 *   4. 工具注册器（registerCloudbasePolicies）—— 把 policy 应用到工具并注册到任意 MCP server
 *
 * 调用方：
 *   - routes/cloudbase-mcp.ts   OpenCode HTTP runtime
 *   - sandbox/sandbox-mcp-proxy.ts   CodeBuddy SDK runtime（InMemoryTransport server+client）
 */

import { z } from 'zod'
import { issueTempCredentials } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import {
  isCloudbaseToolHidden,
  isNativeToolAllowed,
  listAugmentedTools,
  runCloudbaseAugmented,
  runCloudbasePolicy,
  type CloudbaseExtra,
  type CloudbaseMcpContext,
} from '../middleware/mcp/cloudbase/_index.js'

// ════════════════════════════════════════════════════════════════════════
//  Part 1: JSON Schema ↔ Zod
// ════════════════════════════════════════════════════════════════════════

export function jsonSchemaPropertyToZod(propSchema: any): z.ZodTypeAny {
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
    zodType = z.array(items ? jsonSchemaPropertyToZod(items) : z.any())
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

  return description ? zodType.describe(description) : zodType
}

export function jsonSchemaToZodShape(schema: any): Record<string, z.ZodTypeAny> {
  if (!schema?.properties) return {}
  const required = new Set<string>(schema.required ?? [])
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(schema.properties as Record<string, any>)) {
    let t = jsonSchemaPropertyToZod(prop)
    if (!required.has(key)) t = t.optional() as z.ZodTypeAny
    shape[key] = t
  }
  return shape
}

// ════════════════════════════════════════════════════════════════════════
//  Part 2: mcporter CLI（调用序列化 + 工具发现）
// ════════════════════════════════════════════════════════════════════════

/** 把 (toolName, args) 序列化成 mcporter call 用的表达式：`cloudbase.toolX(k: "v", ...)` */
export function serializeMcporterCall(toolName: string, args: Record<string, unknown>): string {
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

/** 转义后构造 shell 命令：`mcporter call '<expr>' 2>&1` */
export function buildMcporterShellCommand(toolName: string, args: Record<string, unknown>): string {
  const expr = serializeMcporterCall(toolName, args)
  const escaped = expr.replace(/'/g, "'\\''")
  return `mcporter call '${escaped}' 2>&1`
}

export interface DiscoverToolsDeps {
  /** 在沙箱里跑 bash 命令，返回 stdout */
  bash: (command: string, timeoutMs?: number) => Promise<string>
  /** 读沙箱内的文件，返回解析后的 JSON */
  readJsonFile: (path: string) => Promise<unknown>
}

export interface DiscoveredTool {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, any>
    required?: string[]
  }
}

/**
 * 通过 mcporter list --schema 发现所有 cloudbase 工具。
 *
 * 双 runtime 共用此函数：sandbox-mcp-proxy 注入 SandboxInstance 风格 bash/read，
 * routes/cloudbase-mcp 注入直接 fetch 风格的 bash/read。
 */
export async function discoverCloudbaseTools(deps: DiscoverToolsDeps): Promise<DiscoveredTool[]> {
  const tmpPath = `.mcporter-schema-${Date.now()}.json`
  try {
    await deps.bash(`mcporter list cloudbase --schema --output json > ${tmpPath} 2>&1`, 25_000)
    const parsed = (await deps.readJsonFile(tmpPath)) as { tools?: DiscoveredTool[] }
    if (!Array.isArray(parsed.tools)) throw new Error('No tools array in schema response')
    return parsed.tools
  } finally {
    deps.bash(`rm -f ${tmpPath}`, 5_000).catch1(() => {})
  }
}

/** 识别 mcporter 输出是否表示凭证失效（用于触发凭证重注入） */
export function isCredentialError(output: string): boolean {
  return (
    output.includes('AUTH_REQUIRED') ||
    output.includes('The SecretId is not found') ||
    output.includes('SecretId is not found') ||
    output.includes('InvalidParameter.SecretIdNotFound') ||
    output.includes('AuthFailure')
  )
}

// ════════════════════════════════════════════════════════════════════════
//  Part 3: 统一日志
// ════════════════════════════════════════════════════════════════════════

/** CloudBase MCP 模块共用的 logger 形态（info / warn / error） */
export interface CloudbaseMcpLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string, err?: unknown) => void
}

/**
 * 创建带统一前缀的 logger。
 *
 * @param tag      日志前缀（默认 'cloudbase-mcp'）
 * @param sink     行级 sink（接收已含前缀的整行字符串，默认 console）
 *                 sandbox-mcp-proxy 可传 (line) => log(line + '\n') 兼容它的流式 logger
 */
export function createCloudbaseMcpLogger(
  tag = 'cloudbase-mcp',
  sink?: {
    info?: (line: string) => void
    warn?: (line: string) => void
    error?: (line: string, err?: unknown) => void
  },
): CloudbaseMcpLogger {
  const prefix = `[${tag}]`
  return {
    info: (msg) => (sink?.info ?? console.log)(`${prefix} ${msg}`),
    warn: (msg) => (sink?.warn ?? console.warn)(`${prefix} ${msg}`),
    error: (msg, err) => (sink?.error ?? console.error)(`${prefix} ${msg}`, err),
  }
}

const defaultLogger = createCloudbaseMcpLogger()

// ════════════════════════════════════════════════════════════════════════
//  Part 4: 凭证注入（两条 runtime 共用）
// ════════════════════════════════════════════════════════════════════════

/** 由 createInjectCredentials 返回的注入函数；undefined 表示当前会话无法注入（如缺 envId） */
export type InjectCredentialsFn = () => Promise<void>

export interface CreateInjectCredentialsOptions {
  /** 当前会话用户 ID（用于 issueTempCredentials） */
  userId: string
  /** 当前会话 envId */
  envId: string
  /** 当前会话 conversationId（沙箱 /api/session/env 需要） */
  conversationId: string
  /**
   * 沙箱请求函数。两条 runtime 各自传入：
   *   - SDK runtime: sandbox.request（已内置 baseUrl + auth headers）
   *   - HTTP runtime: 拼好的 sandboxFetch helper
   */
  sandboxFetch: (path: string, init?: RequestInit) => Promise<Response>
  /** 注入沙箱的 workspace 路径（仅 SDK runtime 需要，HTTP runtime 留空即可） */
  workspaceFolderPaths?: string
  /** 401/403 时是否抛 AuthRequiredError（仅 SDK runtime 用，HTTP runtime 不关心） */
  on401?: (status: number) => void
}

/**
 * 创建一个 injectCredentials 函数：通过 issueTempCredentials 拿凭证（永久密钥优先），
 * 调沙箱 /api/session/env 写入。
 */
export function createInjectCredentials(opts: CreateInjectCredentialsOptions): InjectCredentialsFn {
  const { userId, envId, conversationId, sandboxFetch, workspaceFolderPaths, on401 } = opts

  return async () => {
    // 凭证查找策略（按优先级）：
    //   1. 当前会话有 task 级 user_resources（scope='task' && taskId=conversationId）→ 用它
    //   2. fallback：user-level resource（shared / isolated）
    //   3. 都没有 → issueTempCredentials 签发临时密钥（按当前 envId）
    let resource = await getDb()
      .userResources.findByTaskId(conversationId)
      .catch(() => null)
    if (resource && (resource.userId !== userId || resource.envId !== envId)) {
      // 不属于当前用户或 envId 不匹配，丢弃
      resource = null
    }
    if (!resource) {
      resource = await getDb().userResources.findByUserId(userId)
      // 二次保护：fallback 的 user-level resource 也得 envId 匹配，否则会注入错凭证
      if (resource && resource.envId !== envId) resource = null
    }

    let creds: { secretId: string; secretKey: string; sessionToken?: string } | undefined
    if (resource?.camSecretId && resource?.camSecretKey) {
      creds = { secretId: resource.camSecretId, secretKey: resource.camSecretKey }
    } else {
      creds = await issueTempCredentials(envId, userId)
    }
    if (!creds) throw new Error('Failed to obtain user credentials for injection')

    const res = await sandboxFetch('/api/session/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        CLOUDBASE_ENV_ID: envId,
        TENCENTCLOUD_SECRETID: creds.secretId,
        TENCENTCLOUD_SECRETKEY: creds.secretKey,
        TENCENTCLOUD_SESSIONTOKEN: creds.sessionToken ?? '',
        INTEGRATION_IDE: 'codebuddy',
        ...(workspaceFolderPaths ? { WORKSPACE_FOLDER_PATHS: workspaceFolderPaths } : {}),
      }),
    })
    if ((res.status === 401 || res.status === 403) && on401) on401(res.status)
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string }
    if (!data.success) throw new Error(data.error ?? `inject credentials failed (HTTP ${res.status})`)
  }
}

// ════════════════════════════════════════════════════════════════════════
//  Part 5: 工具注册器（policy 应用 + 注册到 MCP server）
// ════════════════════════════════════════════════════════════════════════

/**
 * 跳过这些原生工具（两条路径完全一致）：
 *   - logout / interactiveDialog: 不适用于沙箱场景
 *   - login: 旧的交互式登录流程，已被自动凭证注入取代
 */
export const SKIPPED_NATIVE_TOOLS = new Set(['logout', 'interactiveDialog', 'login'])

/** MCP 工具 handler 返回值（McpServer.tool 与 agent-sdk tool 共用此结构） */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** 注册一个工具到底层 server（每个 runtime 自己实现：调 server.tool 或 sdkTool） */
export type RegisterToolFn = (
  name: string,
  description: string,
  zodShape: Record<string, z.ZodTypeAny>,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
) => void

export interface RegisterOptions {
  /** 来自 mcporter 的原生工具列表 */
  nativeTools: DiscoveredTool[]
  /** 上下文基础字段（policy ctx 用，不含 scratch / callOriginal） */
  ctxBase: Omit<CloudbaseMcpContext, 'scratch' | 'callOriginal' | 'toolName' | 'input'>
  /** mcporter 实际执行：原生兜底 + augmented 内组合调用 */
  mcporterCall: (toolName: string, args: Record<string, unknown>) => Promise<string>
  /**
   * 当前会话 envId（必选）。框架根据它**自动构造** injectCredentials：
   *   - 包一层 mcporterCall 凭证错误重试
   *   - 注入到 `ctx.extra.injectCredentials`（policy 也能调）
   *
   * 内部通过 ctxBase.extra.sandboxFetch + ctxBase.extra.conversationId（或 sessionId fallback）
   * + ctxBase.userId 完成。可通过 injectOptions 传入额外字段（如 workspaceFolderPaths）。
   */
  envId: string
  /** 传给 createInjectCredentials 的额外字段（workspaceFolderPaths / on401） */
  injectOptions?: {
    workspaceFolderPaths?: string
    on401?: (status: number) => void
  }
  /** 注册到底层 MCP server 的回调（差异点：可以多次调用以注册到多个 server） */
  register: RegisterToolFn
  /** 日志记录器（默认走 console，传 createCloudbaseMcpLogger() 可带统一前缀） */
  logger?: CloudbaseMcpLogger
}

const NATIVE_DESC_SUFFIX = '\n\nNOTE: localPath refers to paths inside the container workspace.'

/** 把一次 policy 调用包装成 MCP ToolResult */
async function wrapHandler(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    const text = await fn()
    return { content: [{ type: 'text', text }] }
  } catch (e: any) {
    return { content: [{ type: 'text', text: `Error: ${e?.message ?? String(e)}` }], isError: true }
  }
}

/**
 * 包一层凭证错误自动重试：mcporter → AUTH_REQUIRED → inject → retry once。
 * inject 缺省或失败时优雅降级：返回原始 AUTH_REQUIRED + 错误标注。
 *
 * 也单独导出便于在单测中断言契约（同时保留作为内部实现细节）。
 */
export function withCredentialRetry(
  mcporterCall: (toolName: string, args: Record<string, unknown>) => Promise<string>,
  injectCredentials: (() => Promise<void>) | undefined,
  logger: CloudbaseMcpLogger,
): (toolName: string, args: Record<string, unknown>) => Promise<string> {
  return async (toolName, args) => {
    let output = await mcporterCall(toolName, args)
    if (!isCredentialError(output) || !injectCredentials) return output

    logger.warn(`Credential error for ${toolName}, re-injecting...`)
    try {
      await injectCredentials()
    } catch (err) {
      logger.warn(`re-inject failed: ${(err as Error).message}`)
      return output + '\n\nCredential re-injection attempted but failed.'
    }
    output = await mcporterCall(toolName, args)
    if (isCredentialError(output)) {
      return output + '\n\nCredential re-injection attempted but error persists.'
    }
    return output
  }
}

/**
 * 注册原生工具 + augmented 工具到底层 server。
 *
 * 两条 runtime 路径调用同一份逻辑：
 *   - 应用 SKIPPED_NATIVE_TOOLS 跳过列表
 *   - 应用 isNativeToolAllowed（allowList / denyList / hidden=true）静态过滤
 *   - 应用 isCloudbaseToolHidden（函数式 hidden）动态过滤
 *   - 处理 augmented 工具与原生工具同名冲突（augmented 让位）
 *   - 错误统一包装为 ToolResult
 *   - 凭证错误（AUTH_REQUIRED）自动 inject + retry once
 *   - 自动把 injectCredentials 注入到 ctx.extra（policy 也可主动调）
 */
export async function registerCloudbasePolicies(opts: RegisterOptions): Promise<void> {
  const { nativeTools, register, logger = defaultLogger, envId, injectOptions } = opts

  // 自动构造 injectCredentials（要求 ctxBase.extra.sandboxFetch + conversationId + ctxBase.userId）。
  const conversationId = opts.ctxBase.extra.conversationId ?? opts.ctxBase.sessionId
  const injectCredentials = createInjectCredentials({
    userId: opts.ctxBase.userId,
    envId,
    conversationId,
    sandboxFetch: opts.ctxBase.extra.sandboxFetch,
    workspaceFolderPaths: injectOptions?.workspaceFolderPaths,
    on401: injectOptions?.on401,
  })

  // 把 inject 注入到 ctx.extra（让 policy 如 auth.ts 的 start_auth 能直接调）
  const ctxBase: typeof opts.ctxBase = {
    ...opts.ctxBase,
    extra: {
      ...opts.ctxBase.extra,
      injectCredentials,
    },
  }

  // 包一层凭证错误自动重试：mcporter → AUTH_REQUIRED → inject → retry once
  const callMcporter = withCredentialRetry(opts.mcporterCall, injectCredentials, logger)

  // ── 原生工具 ────────────────────────────────────────────────
  for (const tool of nativeTools) {
    if (SKIPPED_NATIVE_TOOLS.has(tool.name)) continue

    if (!isNativeToolAllowed(tool.name)) {
      logger.info(`tool filtered out: ${tool.name}`)
      continue
    }
    if (
      await isCloudbaseToolHidden(
        tool.name,
        ctxBase as Omit<CloudbaseMcpContext, 'toolName' | 'input' | 'scratch' | 'callOriginal'>,
      )
    ) {
      logger.info(`tool hidden by policy: ${tool.name}`)
      continue
    }

    const zodShape = jsonSchemaToZodShape(tool.inputSchema)
    const description = (tool.description ?? `CloudBase tool: ${tool.name}`) + NATIVE_DESC_SUFFIX

    register(tool.name, description, zodShape, (args) =>
      wrapHandler(() =>
        runCloudbasePolicy(
          { ...ctxBase, toolName: tool.name, input: args },
          (input) => callMcporter(tool.name, input),
          (other, input) => callMcporter(other, input),
        ),
      ),
    )
  }

  // ── Augmented 工具 ─────────────────────────────────────────
  const nativeNames = new Set(nativeTools.map((t) => t.name))
  for (const aug of listAugmentedTools()) {
    if (nativeNames.has(aug.toolName)) {
      logger.warn(`augmented tool conflicts with native, skipping: ${aug.toolName}`)
      continue
    }
    if (!isNativeToolAllowed(aug.toolName)) {
      logger.info(`augmented tool filtered out: ${aug.toolName}`)
      continue
    }

    const zodShape = jsonSchemaToZodShape(aug.inputSchema)
    register(aug.toolName, aug.description, zodShape, (args) =>
      wrapHandler(() =>
        runCloudbaseAugmented({ ...ctxBase, toolName: aug.toolName, input: args }, (other, input) =>
          callMcporter(other, input),
        ),
      ),
    )
    logger.info(`augmented tool registered: ${aug.toolName}`)
  }
}

/** 当原生工具列表为空时，注册占位 tool 让 MCP server 仍声明 tools capability */
export function registerNoopPlaceholder(register: RegisterToolFn): void {
  register('__noop__', 'Placeholder tool. CloudBase tools are unavailable in degraded mode.', {}, async () => ({
    content: [{ type: 'text', text: 'CloudBase tools unavailable (degraded mode)' }],
    isError: true,
  }))
}

/** Re-exports for callers */
export type { CloudbaseExtra, CloudbaseMcpContext }
