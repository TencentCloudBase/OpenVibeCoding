/**
 * Global CloudBase MCP HTTP Route
 *
 * 全局单一 HTTP MCP 路由，供 OpenCode ACP runtime 连接 CloudBase 工具。
 *
 * 设计：
 * - 复用 Express server 的同一端口（/cloudbase-mcp 路径），零额外 TCP 端口
 * - 每次 HTTP 请求创建 per-request McpServer + StreamableHTTPServerTransport（stateless）
 *   请求处理完毕后实例随 GC 回收
 * - Sandbox 信息（URL、认证 headers、scope ID）通过 request headers 传入
 * - 工具 schema 按 scopeId 缓存，避免每次重新调 mcporter list
 *
 * OpenCode 配置（McpServerHttp）：
 *   {
 *     type: 'http',
 *     name: 'cloudbase',
 *     url: 'http://localhost:3001/cloudbase-mcp',
 *     headers: [
 *       { name: 'X-Sandbox-Url',  value: sandbox.baseUrl },
 *       { name: 'X-Sandbox-Auth', value: JSON.stringify(authHeaders) },
 *       { name: 'Authorization',  value: 'Bearer <MCP_API_KEY>' },
 *     ]
 *   }
 */

import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { HttpBindings } from '@hono/node-server'
import type { AppEnv } from '../middleware/auth.js'
import {
  buildMcporterShellCommand,
  createCloudbaseMcpLogger,
  discoverCloudbaseTools as discoverTools,
  registerCloudbasePolicies,
  registerNoopPlaceholder,
  type DiscoveredTool,
} from '../lib/cloudbase-mcp.js'
import { loadAllPolicies } from '../middleware/mcp/cloudbase/_index.js'

// 启动时一次性加载所有 policy（异步触发，不阻塞模块导出）
void loadAllPolicies()

const logger = createCloudbaseMcpLogger('cloudbase-mcp')

// ─── Tools Schema Cache ────────────────────────────────────────────────────
// key: scopeId（conversationId），value: discovered tool list
// TTL: 30 minutes（沙箱重启后工具列表不变，缓存避免重复调 mcporter list）

interface CacheEntry {
  tools: DiscoveredTool[]
  expiresAt: number
}
const toolsSchemaCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 30 * 60 * 1000

function getCachedTools(scopeId: string): DiscoveredTool[] | null {
  const entry = toolsSchemaCache.get(scopeId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    toolsSchemaCache.delete(scopeId)
    return null
  }
  return entry.tools
}

function setCachedTools(scopeId: string, tools: DiscoveredTool[]): void {
  toolsSchemaCache.set(scopeId, { tools, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ─── Sandbox HTTP helpers ──────────────────────────────────────────────────
// 不依赖 SandboxInstance，直接通过 fetch 调沙箱 HTTP API

async function sandboxFetch(
  sandboxUrl: string,
  sandboxAuth: Record<string, string>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${sandboxUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...sandboxAuth,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

async function sandboxBash(
  sandboxUrl: string,
  sandboxAuth: Record<string, string>,
  command: string,
  timeoutMs = 60_000,
): Promise<string> {
  const res = await sandboxFetch(sandboxUrl, sandboxAuth, '/api/tools/bash', {
    method: 'POST',
    body: JSON.stringify({ command, timeout: timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  })
  const data = (await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))) as any
  if (!data.success) throw new Error(data.error ?? `bash failed (${res.status})`)
  const r = data.result
  if (typeof r === 'string') return r
  return r?.output ?? r?.stdout ?? JSON.stringify(r ?? '')
}

async function mcporterCall(
  sandboxUrl: string,
  sandboxAuth: Record<string, string>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  return sandboxBash(sandboxUrl, sandboxAuth, buildMcporterShellCommand(toolName, args), 60_000)
}

// ─── Per-request MCP Server builder ───────────────────────────────────────

async function buildMcpServer(
  sandboxUrl: string,
  sandboxAuth: Record<string, string>,
  /** 本地缓存 key（conversationId），不传给沙箱 */
  sessionId: string,
  /** 当前会话用户 ID（透传给 policy） */
  userId: string,
  /** 当前会话 envId（用于凭证注入与重注入） */
  envId: string,
): Promise<McpServer> {
  // Get or discover tool schema (cached by sessionId)
  let tools = getCachedTools(sessionId)
  if (!tools) {
    try {
      tools = await discoverTools({
        bash: (cmd, t) => sandboxBash(sandboxUrl, sandboxAuth, cmd, t ?? 25_000),
        readJsonFile: async (p) => {
          const res = await sandboxFetch(sandboxUrl, sandboxAuth, '/api/tools/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: p }),
          })
          if (!res.ok) throw new Error(`Failed to read schema file: ${res.status}`)
          const data = (await res.json()) as { success?: boolean; result?: { content?: string } }
          if (!data.success || !data.result?.content) throw new Error('Empty schema file')
          return JSON.parse(data.result.content)
        },
      })
      setCachedTools(sessionId, tools)
    } catch (e) {
      logger.warn(`Tool discovery failed: ${(e as Error).message}`)
      tools = []
    }
  }

  const server = new McpServer({ name: 'cloudbase', version: '1.0.0' })

  await registerCloudbasePolicies({
    nativeTools: tools,
    ctxBase: {
      userId,
      sessionId,
      extra: {
        sandboxUrl,
        sandboxAuth,
        sandboxFetch: (p, init) => sandboxFetch(sandboxUrl, sandboxAuth, p, init),
        conversationId: sessionId,
      },
    },
    mcporterCall: (toolName, args) => mcporterCall(sandboxUrl, sandboxAuth, toolName, args),
    envId,
    register: (name, desc, shape, handler) => server.tool(name, desc, shape, handler),
    logger,
  })

  return server
}

// ─── Hono Route ───────────────────────────────────────────────────────────

const app = new Hono<AppEnv & { Bindings: HttpBindings }>()

// All methods: authenticate → parse sandbox headers → dispatch to MCP transport
app.all('*', async (c) => {
  // 认证：要求已登录 session（cookie nex_session=<jwe> 由 base-runtime.setupSandbox 签发）
  const session = c.get('session')
  if (!session?.user?.id) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const sandboxUrl = c.req.header('X-Sandbox-Url')
  const sandboxAuthRaw = c.req.header('X-Sandbox-Auth') ?? '{}'
  // sessionId 仅用于本地工具 schema 缓存 key，不传给沙箱
  const sessionId = c.req.header('X-Session-Id') ?? 'default'
  // envId 必填：用于凭证注入与凭证过期时的重注入
  const envId = c.req.header('X-Env-Id')

  if (!sandboxUrl) {
    return c.json({ error: 'X-Sandbox-Url header required' }, 400)
  }
  if (!envId) {
    return c.json({ error: 'X-Env-Id header required' }, 400)
  }

  let sandboxAuth: Record<string, string>
  try {
    sandboxAuth = JSON.parse(sandboxAuthRaw)
  } catch {
    return c.json({ error: 'Invalid X-Sandbox-Auth header (must be JSON)' }, 400)
  }

  // Build per-request McpServer with tools registered
  const mcpServer = await buildMcpServer(sandboxUrl, sandboxAuth, sessionId, session.user.id, envId)

  // Create stateless transport and handle this single HTTP request.
  // @hono/node-server exposes Node.js raw req/res via c.env (HttpBindings).
  // transport.handleRequest writes directly to the Node.js ServerResponse,
  // so we must tell Hono NOT to write its own response afterward.
  // We use the @hono/node-server internal header 'x-hono-already-sent' = '1'
  // which causes responseViaResponseObject to skip all header/body writing.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await mcpServer.connect(transport)

  const { incoming, outgoing } = c.env
  await transport.handleRequest(incoming, outgoing)

  return new Response(null, { status: 200, headers: { 'x-hono-already-sent': '1' } })
})

export default app
