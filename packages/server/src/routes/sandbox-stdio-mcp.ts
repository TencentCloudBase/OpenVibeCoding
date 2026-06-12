/**
 * Global Sandbox stdio MCP HTTP Route
 *
 * 把"已注册到沙箱 mcporter 的 stdio 类型 MCP server"以 HTTP MCP 协议暴露，
 * 供 OpenCode ACP runtime 通过标准 http MCP 客户端连接，由本路由代理回沙箱。
 *
 * 设计：
 * - 复用 server 同一端口（/sandbox-stdio-mcp 路径）
 * - 每次 HTTP 请求创建 per-request McpServer + StreamableHTTPServerTransport（stateless）
 * - 工具 schema 按 (sessionId, mcpName) 缓存，避免每次重新调 mcporter list
 * - 工具调用通过 fetch 直接打到沙箱 /api/tools/mcporter_cli
 *
 * 注册前置条件：
 *   - 调用方（opencode-acp-runtime）必须先在 launchAgent 中调用
 *     `registerStdioMcpInSandbox` 把 mcp 写入沙箱 mcporter 配置；
 *   - 否则 list/call 会失败。
 *
 * OpenCode 配置（McpServerHttp）：
 *   {
 *     type: 'http',
 *     name: <mcpName>,
 *     url: 'http://localhost:3001/sandbox-stdio-mcp',
 *     headers: [
 *       { name: 'X-Sandbox-Url',     value: sandbox.baseUrl },
 *       { name: 'X-Sandbox-Auth',    value: JSON.stringify(authHeaders) },
 *       { name: 'X-Stdio-Mcp-Name',  value: mcpName },
 *       { name: 'X-Session-Id',      value: conversationId },
 *       { name: 'Cookie',            value: `nex_session=${sessionJwe}` },
 *     ]
 *   }
 */

import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { HttpBindings } from '@hono/node-server'
import type { AppEnv } from '../middleware/auth.js'
import { jsonSchemaToZodShape, type DiscoveredTool } from '../lib/cloudbase-mcp.js'
import {
  buildCallCommand,
  extractOutput,
  makeFetchMcporterCli,
  parseToolsFromListOutput,
} from '../sandbox/sandbox-stdio-mcp.js'

// ─── Tools Schema Cache ────────────────────────────────────────────────────
// key: `${sessionId}::${mcpName}`，value: discovered tool list
// TTL: 30 minutes（沙箱内 stdio MCP 注册后工具列表稳定，缓存避免重复调 mcporter list）

interface CacheEntry {
  tools: DiscoveredTool[]
  expiresAt: number
}
const toolsSchemaCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 30 * 60 * 1000

function cacheKey(sessionId: string, mcpName: string): string {
  return `${sessionId}::${mcpName}`
}

function getCachedTools(sessionId: string, mcpName: string): DiscoveredTool[] | null {
  const entry = toolsSchemaCache.get(cacheKey(sessionId, mcpName))
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    toolsSchemaCache.delete(cacheKey(sessionId, mcpName))
    return null
  }
  return entry.tools
}

function setCachedTools(sessionId: string, mcpName: string, tools: DiscoveredTool[]): void {
  toolsSchemaCache.set(cacheKey(sessionId, mcpName), { tools, expiresAt: Date.now() + CACHE_TTL_MS })
}

/** 显式失效（mcp 关闭时调用）。 */
export function invalidateStdioMcpToolsCache(sessionId: string, mcpName: string): void {
  toolsSchemaCache.delete(cacheKey(sessionId, mcpName))
}

// ─── Per-request MCP Server builder ───────────────────────────────────────

async function buildMcpServer(
  sandboxUrl: string,
  sandboxAuth: Record<string, string>,
  /** 沙箱内 mcporter 中已注册的 stdio MCP 名称 */
  mcpName: string,
  /** 本地缓存 key（conversationId） */
  sessionId: string,
): Promise<McpServer> {
  const cli = makeFetchMcporterCli(sandboxUrl, sandboxAuth)

  // Get or discover tool schema (cached by sessionId + mcpName)
  let tools = getCachedTools(sessionId, mcpName)
  if (!tools) {
    try {
      const listResult = await cli(`list ${mcpName} --schema --output json`, 90_000)
      tools = parseToolsFromListOutput(extractOutput(listResult))
      setCachedTools(sessionId, mcpName, tools)
    } catch (e) {
      console.warn('[sandbox-stdio-mcp route] tool discovery failed:', (e as Error).message)
      tools = []
    }
  }

  const server = new McpServer({ name: mcpName, version: '1.0.0' })

  for (const t of tools) {
    const description = t.description ?? `${mcpName} tool: ${t.name}`
    const zodShape = jsonSchemaToZodShape(t.inputSchema)

    const handler = async (input: Record<string, unknown>) => {
      try {
        const cmd = buildCallCommand(mcpName, t.name, input ?? {})
        const result = await cli(cmd, 90_000)
        const text = extractOutput(result)
        const isError = result.exitCode != null && result.exitCode !== 0
        return {
          content: [{ type: 'text' as const, text }],
          ...(isError ? { isError: true } : {}),
        }
      } catch (e: unknown) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        }
      }
    }

    server.tool(t.name, description, zodShape as any, handler as any)
  }

  return server
}

// ─── Hono Route ───────────────────────────────────────────────────────────

const app = new Hono<AppEnv & { Bindings: HttpBindings }>()

app.all('*', async (c) => {
  // 认证：要求已登录 session（cookie nex_session=<jwe> 由 base-runtime.setupSandbox 签发）
  const session = c.get('session')
  if (!session?.user?.id) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const sandboxUrl = c.req.header('X-Sandbox-Url')
  const sandboxAuthRaw = c.req.header('X-Sandbox-Auth') ?? '{}'
  const mcpName = c.req.header('X-Stdio-Mcp-Name')
  const sessionId = c.req.header('X-Session-Id') ?? 'default'

  if (!sandboxUrl) {
    return c.json({ error: 'X-Sandbox-Url header required' }, 400)
  }
  if (!mcpName) {
    return c.json({ error: 'X-Stdio-Mcp-Name header required' }, 400)
  }

  let sandboxAuth: Record<string, string>
  try {
    sandboxAuth = JSON.parse(sandboxAuthRaw)
  } catch {
    return c.json({ error: 'Invalid X-Sandbox-Auth header (must be JSON)' }, 400)
  }

  // Build per-request McpServer with tools registered
  const mcpServer = await buildMcpServer(sandboxUrl, sandboxAuth, mcpName, sessionId)

  // Stateless transport: write directly to Node ServerResponse via @hono/node-server bindings
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await mcpServer.connect(transport)

  const { incoming, outgoing } = c.env
  await transport.handleRequest(incoming, outgoing)

  return new Response(null, { status: 200, headers: { 'x-hono-already-sent': '1' } })
})

export default app
