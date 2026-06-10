/**
 * Sandbox Stdio MCP Client
 *
 * 把 stdio 类型的 MCP server 通过沙箱内置的 `mcporter` 注册并代理：
 *   1. POST /api/tools/mcporter_cli  body={ command: 'config add <name> --command "..."' }
 *      → 在沙箱里把 stdio MCP 注册到 mcporter 配置
 *   2. mcporter list <name> --schema --output json    → 发现工具列表
 *   3. mcporter call '<name>.<tool>(k: "v")'          → 调用工具
 *   4. 本地 McpServer 代理所有工具，通过 InMemoryTransport 包装成 sdkServer
 *
 * 与 sandbox-mcp-proxy 的区别：cloudbase 在沙箱里是预置 MCP（已注册），
 * 这里需要先动态注册。其余流程完全一致。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { tool as sdkTool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { jsonSchemaToZodShape, type DiscoveredTool } from '../lib/cloudbase-mcp.js'
import type { SandboxInstance } from './scf-sandbox-manager.js'

// ─── 通用 mcporter_cli 调用 ──────────────────────────────────────────────

export interface McporterCliResult {
  output?: string
  stdout?: string
  stderr?: string
  exitCode?: number
}

/**
 * 抽象的 mcporter_cli 调用接口。
 * 不同调用方提供不同实现：
 * - 走 SandboxInstance.request：用于 cloudbase-agent.service（已持有 SandboxInstance）
 * - 走原生 fetch + 显式 url/auth：用于 HTTP route（无 SandboxInstance 上下文）
 */
export type McporterCliCaller = (command: string, timeoutMs?: number) => Promise<McporterCliResult>

/** 基于 SandboxInstance 的 mcporter_cli 调用器。 */
export function makeSandboxInstanceMcporterCli(sandbox: SandboxInstance): McporterCliCaller {
  return async (command, timeoutMs = 60_000) => {
    const res = await sandbox.request('/api/tools/mcporter_cli', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, timeout: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    })
    if (!res.ok) {
      throw new Error(`mcporter_cli HTTP ${res.status}`)
    }
    const data = (await res.json()) as {
      success: boolean
      result?: McporterCliResult
      error?: string
    }
    if (!data.success) {
      throw new Error(data.error ?? 'mcporter_cli call failed')
    }
    return data.result ?? {}
  }
}

/** 基于原生 fetch + 显式 sandbox URL/auth 的 mcporter_cli 调用器。 */
export function makeFetchMcporterCli(sandboxUrl: string, sandboxAuth: Record<string, string>): McporterCliCaller {
  return async (command, timeoutMs = 60_000) => {
    const res = await fetch(`${sandboxUrl}/api/tools/mcporter_cli`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sandboxAuth },
      body: JSON.stringify({ command, timeout: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    })
    if (!res.ok) {
      throw new Error(`mcporter_cli HTTP ${res.status}`)
    }
    const data = (await res.json()) as {
      success: boolean
      result?: McporterCliResult
      error?: string
    }
    if (!data.success) {
      throw new Error(data.error ?? 'mcporter_cli call failed')
    }
    return data.result ?? {}
  }
}

/** 提取 mcporter_cli 输出文本（合并 stdout / output / stderr 兜底） */
export function extractOutput(result: McporterCliResult): string {
  return (result.stdout ?? result.output ?? result.stderr ?? '').toString()
}

// ─── shell 字符串 / 调用表达式构造 ───────────────────────────────────────

/** 把字符串包装为带转义的双引号形式，可作为 mcporter `--command` / `--env` 等参数值。 */
export function dquote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`
}

/**
 * 构造 `config add <name> --command "<cmd args ...>" [--env "K=V" ...]`
 *
 * 注意：mcporter 的 --command 接收一个完整的命令字符串（含 args），
 * 我们把 command + args 用空格拼接后整体双引号包起来。
 */
export function buildAddCommand(name: string, command: string, args: string[], env?: Record<string, string>): string {
  const fullCmd = [command, ...args].filter(Boolean).join(' ')
  const parts = [`config add ${name}`, `--command ${dquote(fullCmd)}`]
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      parts.push(`--env ${dquote(`${k}=${v}`)}`)
    }
  }
  return parts.join(' ')
}

/** 序列化成 mcporter call 表达式：`<server>.<tool>(k: "v", ...)` */
export function serializeMcporterCall(serverName: string, toolName: string, args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) {
    return `${serverName}.${toolName}()`
  }
  const parts = Object.entries(args)
    .map(([k, v]) => {
      if (v === undefined || v === null) return null
      if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`
      if (typeof v === 'boolean' || typeof v === 'number') return `${k}: ${v}`
      return `${k}: ${JSON.stringify(v)}`
    })
    .filter(Boolean)
    .join(', ')
  return `${serverName}.${toolName}(${parts})`
}

/** 构造 `call '<expr>'`（单引号包裹，内部单引号转义）。 */
export function buildCallCommand(serverName: string, toolName: string, args: Record<string, unknown>): string {
  const expr = serializeMcporterCall(serverName, toolName, args)
  const escaped = expr.replace(/'/g, "'\\''")
  return `call '${escaped}'`
}

// ─── 工具发现 ────────────────────────────────────────────────────────────

/** 在 mcporter list --output json 输出中提取 tools 数组（容忍前后非 JSON 噪声）。 */
export function parseToolsFromListOutput(output: string): DiscoveredTool[] {
  if (!output.trim()) return []

  // 直接尝试 JSON.parse
  try {
    const parsed = JSON.parse(output) as { tools?: DiscoveredTool[] }
    if (Array.isArray(parsed?.tools)) return parsed.tools
  } catch {
    // ignore, fallback
  }

  // fallback：从输出中截取第一段 {...} JSON
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(output.slice(start, end + 1)) as { tools?: DiscoveredTool[] }
      if (Array.isArray(parsed?.tools)) return parsed.tools
    } catch {
      // ignore
    }
  }
  return []
}

// ─── 工厂函数 ────────────────────────────────────────────────────────────

export interface CreateSandboxStdioMcpOptions {
  command: string
  args: string[]
  env?: Record<string, string>
  /** mcporter 配置中使用的 server 名（也是 sdkServer 的 name），默认 'sandbox-stdio' */
  name?: string
  /** 注册时是否覆盖已有同名配置，默认 true（先 remove 再 add） */
  overwrite?: boolean
  /** 日志输出，默认 console.log */
  log?: (msg: string) => void
}

/**
 * 把 stdio MCP 注册到沙箱内的 mcporter，并发现其工具列表。
 *
 * 不构建 InMemoryTransport，仅完成 register + list，返回 tools + close()。
 * 适用于不需要本地 McpServer 直连（例如通过 HTTP 路由代理）的场景。
 */
export async function registerStdioMcpInSandbox(
  cli: McporterCliCaller,
  options: CreateSandboxStdioMcpOptions,
): Promise<{
  name: string
  tools: DiscoveredTool[]
  close: () => Promise<void>
}> {
  const {
    command,
    args,
    env,
    name = 'sandbox-stdio',
    overwrite = true,
    log = (msg: string) => console.log(msg),
  } = options

  if (overwrite) {
    try {
      await cli(`config remove ${name}`, 15_000)
    } catch {
      // ignore
    }
  }

  const addCmd = buildAddCommand(name, command, args, env)
  log(`[sandbox-stdio-mcp] register: ${name}`)
  const addResult = await cli(addCmd, 30_000)
  const addOutput = extractOutput(addResult)
  if (addResult.exitCode != null && addResult.exitCode !== 0) {
    throw new Error(`mcporter config add failed: ${addOutput}`)
  }

  log(`[sandbox-stdio-mcp] list tools: ${name}`)
  const listResult = await cli(`list ${name} --schema --output json`, 90_000)
  const tools = parseToolsFromListOutput(extractOutput(listResult))
  log(`[sandbox-stdio-mcp] discovered ${tools.length} tools`)

  return {
    name,
    tools,
    close: async () => {
      try {
        await cli(`config remove ${name}`, 10_000)
      } catch {
        // ignore
      }
    },
  }
}

export async function createSandboxStdioMcpClient(
  sandbox: SandboxInstance,
  options: CreateSandboxStdioMcpOptions,
): Promise<{
  client: Client
  server: McpServer
  sdkServer: ReturnType<typeof createSdkMcpServer>
  close: () => Promise<void>
}> {
  const cli = makeSandboxInstanceMcporterCli(sandbox)
  const { name = 'sandbox-stdio' } = options

  // 1+2. 注册 + 发现工具
  const registration = await registerStdioMcpInSandbox(cli, options)
  const remoteTools = registration.tools

  // 3. 创建本地 McpServer，把每个工具代理到 mcporter call
  const server = new McpServer({ name, version: '1.0.0' })
  const sdkTools: ReturnType<typeof sdkTool>[] = []

  for (const t of remoteTools) {
    const description = t.description ?? `${name} tool: ${t.name}`
    const zodShape = jsonSchemaToZodShape(t.inputSchema)

    const handler = async (input: Record<string, unknown>) => {
      try {
        const cmd = buildCallCommand(name, t.name, input)
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
    sdkTools.push(sdkTool(t.name, description, zodShape as any, handler as any))
  }

  // 4. 通过 InMemoryTransport 把 server <-> client 连接起来
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: `${name}-local`, version: '1.0.0' })
  await client.connect(clientTransport)

  const sdkServer = createSdkMcpServer({
    name,
    version: '1.0.0',
    tools: sdkTools,
  })

  return {
    client,
    server,
    sdkServer,
    close: async () => {
      await registration.close()
      try {
        await client.close()
      } catch {}
      try {
        await server.close()
      } catch {}
    },
  }
}
