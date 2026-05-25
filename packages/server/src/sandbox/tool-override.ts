/**
 * Tool Override Module
 *
 * 通过 patch 后的 codebuddy-headless.js 注入到 CLI 子进程。
 * 环境变量:
 *   CODEBUDDY_TOOL_OVERRIDE=<编译后此文件的绝对路径>
 *   CODEBUDDY_TOOL_OVERRIDE_CONFIG=<JSON 配置>  (可选)
 *     { "url": "https://...", "headers": {...} }
 *
 * ## 工作原理
 *
 * 1. CLI 子进程启动时，patch 代码检查 CODEBUDDY_TOOL_OVERRIDE 环境变量
 * 2. require() 此模块
 * 3. patch 代码 wrap ToolManager.init()，在原始 init 完成后调用 overrideTools(toolMap)
 * 4. overrideTools 从 CODEBUDDY_TOOL_OVERRIDE_CONFIG 读取配置
 * 5. 有配置则通过统一 HTTP API 调用沙箱工具；无配置则跳过
 *
 * ## API 端点
 *
 * 所有工具都通过统一的 HTTP API 调用（不使用 MCP）：
 *   POST {baseUrl}/api/tools/{toolName}
 *     - read: { path, offset?, limit? }
 *     - write: { path, content }
 *     - edit: { path, oldString, newString, replaceAll? }
 *     - glob: { pattern, path? }
 *     - grep: { pattern, path?, glob?, type?, ... }
 *     - bash: { command, timeout? }
 *
 * Response: { success, result: { content? }, error? }
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolOverrideConfig {
  /** sandbox 服务器 base URL */
  url: string
  /** 自定义请求头 */
  headers?: Record<string, string>
  /**
   * 静态托管上传配置（可选）。
   * 提供后 ImageGen 生成的图片会上传到静态托管并返回 CDN 地址。
   */
  hosting?: {
    /** GET presign 端点，返回 { presignedUrl, cdnUrl }
     *  使用 sessionCookie 作为认证（nex_session cookie） */
    presignUrl: string
    /** Session JWE cookie 值（nex_session），用于请求 presign 端点 */
    sessionCookie: string
    /** 会话 ID，用于图片路径隔离 generated-images/{sessionId}/xxx.png */
    sessionId: string
  }
}

export interface ToolResult {
  content?: string
  title?: string
  error?: string
  renderer?: any
}

export interface ToolContext {
  context: any
  [key: string]: any
}

// ─── 统一 HTTP API 调用 ──────────────────────────────────────────────────────

/**
 * 沙箱 API 原始响应格式
 *   { success: true,  result: { ... } }
 *   { success: false, error: "..." }
 */
interface SandboxApiResponse {
  success: boolean
  result?: any
  error?: string
}

/**
 * 调用沙箱 HTTP API，返回原始响应。
 * 上层调用方负责将 result 格式化为内置工具的 { content, error?, ... } 格式。
 */
async function callToolApiRaw(
  baseUrl: string,
  toolName: string,
  headers: Record<string, string>,
  params: Record<string, any>,
): Promise<SandboxApiResponse> {
  const res = await fetch(`${baseUrl}/api/tools/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(params),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`tool API returned ${res.status}: ${text}`)
  }

  return (await res.json()) as SandboxApiResponse
}

// ─── 按工具类型格式化 API result → 内置 execute 返回值 ─────────────────────────
//
// 沙箱 API 各工具 result 结构 (tcb-remote-workspace/src/tools):
//   bash:  { mode, exitCode, output, truncated, timedOut, simulated }
//   read:  { type:"file", path, content, totalLines, truncated, message }
//          | { type:"directory", path, entries, total, truncated }
//          | { type:"image", path, mime, base64 }
//   write: { path, bytesWritten, diff, created }
//   edit:  { path, diff, message }
//   glob:  { count, output, truncated }
//   grep:  { matches, output, truncated }
//
// 内置工具 execute 返回值 (codebuddy-headless):
//   成功: { content: string, title?: string, renderer?: {...} }
//   失败 (Read/Glob/Grep/Bash): { content: string, error: string }
//   失败 (Write/Edit):          throw Error(...)

/**
 * 格式化 bash result → 与内置 Bash buildForegroundResult 对齐
 *   "Command: ...\nStdout: ...\nStderr: ...\nExit Code: ..."
 */
function formatBashResult(r: any, command: string): ToolResult {
  const output = r.output ?? ''
  const exitCode = r.exitCode ?? null
  const timedOut = r.timedOut ?? false

  let content =
    `Command: ${command}\n` +
    `Stdout: ${output || '(empty)'}\n` +
    `Stderr: (empty)\n` +
    `Exit Code: ${exitCode ?? '(none)'}\n` +
    `Signal: (none)`
  if (timedOut) content += '\n\n[Process timed out]'

  return { content, renderer: { type: 'text', value: output || 'No output available' } }
}

/**
 * 格式化 read result → 与内置 Read 对齐
 *   文本: content 已经是带行号的文本 "1: xxx\n2: yyy"
 *   目录: entries 列表
 *   图片: base64 数据
 */
function formatReadResult(r: any): ToolResult {
  if (r.type === 'directory') {
    const entries: string[] = r.entries ?? []
    return { content: entries.join('\n') || '(empty directory)' }
  }
  if (r.type === 'image') {
    return {
      content: JSON.stringify({ type: r.type, path: r.path, mime: r.mime, base64: r.base64 }),
    }
  }
  // 文本文件: content 已经是 "1: line1\n2: line2" 格式
  const content = r.content ?? ''
  const message = r.message ?? ''
  return {
    title: `Read ${r.totalLines ?? '?'} lines`,
    content: message ? `${content}\n${message}` : content,
    renderer: { type: 'code' },
  }
}

/**
 * 格式化 write result → 与内置 Write 对齐
 *   "Successfully created/overwrote file: ..."
 */
function formatWriteResult(r: any): ToolResult {
  const action = r.created ? 'created and wrote to new' : 'overwrote'
  return {
    title: `Wrote ${r.bytesWritten ?? '?'} bytes`,
    content: `Successfully ${action} file: ${r.path}`,
    renderer: { type: 'code' },
  }
}

/**
 * 格式化 edit result → 与内置 Edit 对齐
 *   "Successfully edited file: ..."
 */
function formatEditResult(r: any): ToolResult {
  return {
    title: r.message ?? 'Edit applied successfully.',
    content: `Successfully edited file: ${r.path}`,
    renderer: { type: 'diff' },
  }
}

/**
 * 格式化 glob/grep result → output 字段已是人类可读文本
 */
function formatSearchResult(r: any): ToolResult {
  return { content: r.output ?? 'No results' }
}

/** 各工具的 result 格式化器 */
const RESULT_FORMATTERS: Record<string, (r: any, params: any) => ToolResult> = {
  bash: (r, p) => formatBashResult(r, p.command),
  read: (r) => formatReadResult(r),
  write: (r) => formatWriteResult(r),
  edit: (r) => formatEditResult(r),
  glob: (r) => formatSearchResult(r),
  grep: (r) => formatSearchResult(r),
}

/**
 * 调用沙箱工具并格式化为内置工具的 execute 返回值。
 *
 * @param apiToolName - 沙箱 API 工具名 (read/write/edit/bash/glob/grep)
 * @param params      - 发送给 API 的参数（已 normalize）
 * @param rawParams   - CLI 原始参数（用于格式化，如 bash 需要 command）
 */
async function callToolApi(
  baseUrl: string,
  apiToolName: string,
  headers: Record<string, string>,
  params: Record<string, any>,
  rawParams?: Record<string, any>,
): Promise<ToolResult> {
  const resp = await callToolApiRaw(baseUrl, apiToolName, headers, params)

  if (!resp.success) {
    const errorMessage = resp.error ?? 'Tool execution failed'
    return { content: errorMessage, error: errorMessage }
  }

  const formatter = RESULT_FORMATTERS[apiToolName]
  if (formatter) {
    return formatter(resp.result, rawParams ?? params)
  }

  // 无特定 formatter，fallback 为 JSON
  return { content: JSON.stringify(resp.result, null, 2) }
}

// ─── Arg Normalizers ────────────────────────────────────────────────────────
// CLI tool params → API tool params (field name mapping)
//
// CLI 内置工具参数名 → API 工具参数名:
//   Read:     { file_path, offset, limit } → { path, offset, limit }
//   Write:    { file_path, content } → { path, content }
//   Edit:     { file_path, old_string, new_string, replace_all } → { path, oldString, newString, replaceAll }
//   Glob:     { pattern, path } → { pattern, path }
//   Grep:     { pattern, path, glob, type, ... } → { pattern, path, glob, type, ... }
//   Bash:     { command, timeout } → { command, timeout }

function makeNormalizers(): Record<string, (p: any) => any> {
  return {
    // CLI: { file_path, content } → API: { path, content }
    write: (p) => ({ ...p, path: p.file_path ?? p.path, content: p.content }),
    // CLI: { file_path, offset, limit } → API: { path, offset, limit }
    read: (p) => ({ ...p, path: p.file_path ?? p.path }),
    // CLI: { file_path, old_string, new_string, replace_all }
    //   → API: { path, oldString, newString, replaceAll }
    edit: (p) => ({
      ...p,
      path: p.file_path ?? p.path,
      oldString: p.old_string ?? p.oldString,
      newString: p.new_string ?? p.newString,
      ...(p.replace_all != null ? { replaceAll: p.replace_all } : {}),
    }),
  }
}

// ─── Tool Name Mapping ───────────────────────────────────────────────────────

/** CLI 工具名 → API 工具名（Bash 和 MultiEdit 单独处理，不在此映射中） */
const TOOL_NAME_MAPPING: Record<string, string> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Glob: 'glob',
  Grep: 'grep',
}

/**
 * 失败时 throw Error 的工具（与内置 Write / Edit 行为一致）。
 * 不在此集合中的工具失败时直接返回 { content, error }（与内置 Read 行为一致）。
 */
const THROW_ON_ERROR_TOOLS = new Set(['Write', 'Edit'])

/**
 * 需要沙箱环境才能执行的所有工具名（CLI 侧名称）。
 * 无沙箱时这些工具的 execute 会被替换为直接返回拒绝信息。
 */
const SANDBOX_REQUIRED_TOOLS = [
  ...Object.keys(TOOL_NAME_MAPPING),
  'MultiEdit',
  'Bash',
  'BashOutput',
  'TaskOutput',
  'TaskStop',
  'KillShell',
]

// ─── PTY 后台执行（Bash run_in_background）────────────────────────────────────
//
// 模型调用 Bash(run_in_background=true) 时，通过沙箱 PTY API 执行命令。
// 输出采用 lazy drain 模式：不启动后台轮询，仅在 BashOutput / TaskOutput 被调用时按需拉取。
// 跨进程恢复通过 Process/List API 发现存活的 PTY 进程。

interface PtyTask {
  pid: number
  title: string
  startTime: number
  status: 'running' | 'completed' | 'failed'
  endTime?: number
  nextSeq: number
  stdout: string
  exited: boolean
}

const ptyTaskRegistry = new Map<string, PtyTask>()

/**
 * ANSI 转义序列正则（来自 strip-ansi npm 包）。
 * 覆盖 CSI（含 C1 0x9B 引导符）、OSC 等所有常见序列。
 */
const ansiRegex = (function () {
  const ST = '(?:\\u0007|\\u001B\\u005C|\\u009C)'
  const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`
  const csi = '[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]'
  return new RegExp(`${osc}|${csi}`, 'g')
})()

/**
 * 去除 ANSI 转义序列并模拟 \r 回车覆盖行为。
 *
 * PTY 输出中的 spinner / progress bar 通过 \r + ANSI 光标控制实现逐帧覆盖，
 * 简单删除转义码会留下大量空行。处理策略：
 * 1. 用 strip-ansi 级别的正则删除所有 ANSI CSI / OSC 序列
 * 2. 按 \n 分行后，对每行模拟 \r（只保留最后一次 \r 之后的内容）
 * 3. 压缩连续空行为单个空行
 */
function stripAnsi(raw: string): string {
  const cleaned = raw.replace(ansiRegex, '')

  // 按 \n 分行，每行内模拟 \r（保留最后一个 \r 之后的内容）
  const lines = cleaned.split('\n').map((line) => {
    const crIdx = line.lastIndexOf('\r')
    return crIdx >= 0 ? line.slice(crIdx + 1) : line
  })

  // 压缩连续空行（>1 行连续空行 → 1 行空行）
  const result: string[] = []
  let emptyCount = 0
  for (const line of lines) {
    if (line.trim() === '') {
      emptyCount++
      if (emptyCount <= 1) result.push(line)
    } else {
      emptyCount = 0
      result.push(line)
    }
  }

  return result.join('\n')
}

/**
 * 一次性拉取所有积压的 PTY 输出（drain 模式）。
 * 循环调用 pty_read_output 直到无新事件或进程退出。
 */
async function drainPtyOutput(baseUrl: string, headers: Record<string, string>, taskId: string): Promise<void> {
  const task = ptyTaskRegistry.get(taskId)
  if (!task || task.exited) return

  const MAX_ROUNDS = 50
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(`${baseUrl}/api/tools/pty_read_output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ pid: task.pid, afterSeq: task.nextSeq, limit: 256 }),
    })

    if (!res.ok) {
      if (res.status === 404 || res.status === 400) {
        task.exited = true
        task.status = 'failed'
        task.endTime = Date.now()
      }
      return
    }

    const data = (await res.json()) as any
    const result = data?.result
    if (!result) return

    let hasNewEvents = false
    for (const { event } of result.events ?? []) {
      hasNewEvents = true
      if (event?.data?.pty) {
        const raw = Buffer.from(event.data.pty, 'base64').toString()
        task.stdout += stripAnsi(raw)
      }
      if (event?.end) {
        task.exited = true
        task.status = event.end.exitCode === 0 ? 'completed' : 'failed'
        task.endTime = Date.now()
      }
    }

    if (result.nextSeq != null) task.nextSeq = result.nextSeq
    if (result.exited) {
      task.exited = true
      if (task.status === 'running') {
        task.status = 'completed'
        task.endTime = Date.now()
      }
    }

    if (!hasNewEvents || task.exited) return
  }
}

/**
 * 确保指定 pid 在 ptyTaskRegistry 中存在（仅内存；沙箱业务镜像 无 e2b Process/List）。
 */
async function ensurePtyTask(taskId: string): Promise<PtyTask | null> {
  return ptyTaskRegistry.get(taskId) ?? null
}

/**
 * Bash(run_in_background=true)：通过 PTY API 启动后台命令。
 */
async function bashInBackground(
  baseUrl: string,
  headers: Record<string, string>,
  command: string,
): Promise<{ content: string }> {
  const createRes = await fetch(`${baseUrl}/api/tools/pty_create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ cmd: '/bin/bash', args: ['-i', '-l'], cols: 220, rows: 50 }),
  })
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '')
    throw new Error(`pty_create failed: ${createRes.status} ${text}`)
  }

  const pid: number = ((await createRes.json()) as any)?.result?.pid
  if (!pid) throw new Error('pty_create returned no pid')

  const taskId = String(pid)
  ptyTaskRegistry.set(taskId, {
    pid,
    title: command,
    startTime: Date.now(),
    status: 'running',
    nextSeq: 0,
    stdout: '',
    exited: false,
  })

  // 发送命令
  const inputB64 = Buffer.from(command + '\n').toString('base64')
  await fetch(`${baseUrl}/api/tools/pty_send_input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ pid, inputBase64: inputB64 }),
  }).catch(() => {})

  return {
    content: `Command: ${command}\nStatus: Moved to background with ID: ${taskId}\nCurrent Output: (no output yet)`,
  }
}

/**
 * 终止 PTY 进程（TaskStop / KillShell 共用）。
 */
async function killPtyTask(
  baseUrl: string,
  headers: Record<string, string>,
  task: PtyTask,
  taskId: string,
): Promise<{ content: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/tools/pty_kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ pid: task.pid, signal: 'SIGKILL' }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`pty_kill failed: ${res.status} ${text}`)
    }
    task.exited = true
    task.status = 'failed'
    task.endTime = Date.now()
    return { content: `Shell ${taskId} (pid=${task.pid}) has been killed.` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { content: `Failed to kill shell ${taskId}: ${msg}` }
  }
}

// ─── 核心导出：由 patch 注入点调用 ─────────────────────────────────────────────

/**
 * overrideTools - 由 patch 注入的 ToolManager.init 后调用
 *
 * 从环境变量 CODEBUDDY_TOOL_OVERRIDE_CONFIG 读取配置。
 * - 有配置 → 通过统一 HTTP API 替换工具 execute，指向沙箱。
 * - 无配置 → 禁用所有需要沙箱的工具（Read/Write/Edit/Bash/...），
 *             execute 直接返回错误提示，防止在无沙箱环境下执行本地操作。
 *
 * @param toolMap - CLI ToolManager 内部的 toolMap: Map<string, BaseTool>
 */
export function overrideTools(toolMap: Map<string, any>): void {
  // 从环境变量读取配置
  const configStr = process.env.CODEBUDDY_TOOL_OVERRIDE_CONFIG
  console.error(
    `[ToolOverride] overrideTools called, configStr=${configStr ? 'present' : 'missing'}, toolMap.size=${toolMap.size}`,
  )

  // ── 无沙箱配置：禁用所有需要沙箱的工具 ──
  if (!configStr) {
    disableSandboxTools(toolMap)
    return
  }

  let config: ToolOverrideConfig
  try {
    config = JSON.parse(configStr)
  } catch {
    disableSandboxTools(toolMap)
    return
  }

  if (!config.url) {
    disableSandboxTools(toolMap)
    return
  }

  // 确保 baseUrl 不以 /mcp 或 /api 结尾
  const baseUrl = config.url.replace(/\/mcp\/?$/, '').replace(/\/api\/?$/, '')

  const headers = config.headers || {}
  const hostingConfig = config.hosting ?? null
  const normalizers = makeNormalizers()
  let overriddenCount = 0

  // ── 延迟 override 机制 ──
  // init() 是 async 的，overrideTools 在 init 的第一个 await 前被调用，
  // 此时部分工具（如 TaskOutput、BashOutput）可能还未注册到 toolMap。
  // 通过拦截 toolMap.set，当这些工具被后续注册时自动 override。
  const pendingOverrides = new Map<string, (tool: any) => void>()

  function overrideTool(name: string, overrideFn: (tool: any) => void): void {
    const tool = toolMap.get(name)
    if (tool) {
      overrideFn(tool)
      overriddenCount++
    } else {
      pendingOverrides.set(name, overrideFn)
    }
  }

  // 拦截 toolMap.set，工具注册时自动 apply pending override
  const originalSet = toolMap.set.bind(toolMap)
  toolMap.set = function (key: string, value: any) {
    const result = originalSet(key, value)
    const pending = pendingOverrides.get(key)
    if (pending) {
      pendingOverrides.delete(key)
      pending(value)
      overriddenCount++
    }
    return result
  }

  // ── 文件/搜索工具通过统一 HTTP API 调用 ──
  for (const [cliToolName, apiToolName] of Object.entries(TOOL_NAME_MAPPING)) {
    overrideTool(cliToolName, (tool) => {
      tool.execute = async (params: any, _context: ToolContext, _extra?: any) => {
        const normalizer = normalizers[apiToolName]
        const normalizedParams = normalizer ? normalizer(params) : params

        const result = await callToolApi(baseUrl, apiToolName, headers, normalizedParams, params)

        // Write / Edit 失败时 throw，与内置工具行为一致
        if (result.error && THROW_ON_ERROR_TOOLS.has(cliToolName)) {
          throw new Error(`${cliToolName} error: ${result.error}`)
        }

        return result
      }
    })
  }

  // ── MultiEdit：拆分为多次顺序调用 /api/tools/edit ──
  const editNormalizer = normalizers['edit']
  overrideTool('MultiEdit', (multiEditTool) => {
    multiEditTool.execute = async (params: any, _context: ToolContext, _extra?: any) => {
      const filePath = params.file_path ?? params.path
      const edits: any[] = params.edits ?? []
      if (!edits.length) {
        return { content: 'No edits provided.' }
      }

      const results: string[] = []
      for (const edit of edits) {
        const singleEditParams = {
          file_path: filePath,
          old_string: edit.old_string ?? edit.oldString,
          new_string: edit.new_string ?? edit.newString,
          ...(edit.replace_all != null ? { replace_all: edit.replace_all } : {}),
        }
        const normalizedParams = editNormalizer(singleEditParams)
        const result = await callToolApi(baseUrl, 'edit', headers, normalizedParams)
        // 如果某次 edit 失败，立即 throw 让框架的 errorFunction 处理
        if (result.error) {
          throw new Error(`Edit failed for ${filePath}: ${result.error}`)
        }
        results.push(result.content ?? '')
      }

      return { content: results.join('\n') }
    }
  })

  // ── Bash：前台走 /api/tools/bash，后台走 PTY（lazy drain）──
  overrideTool('Bash', (bashTool) => {
    bashTool.execute = async (params: any) => {
      const { command, timeout, run_in_background } = params
      try {
        if (run_in_background) {
          return await bashInBackground(baseUrl, headers, command)
        }

        const result = await callToolApi(baseUrl, 'bash', headers, { command, timeout }, params)

        // Bash 失败时不 throw，与内置 Bash 行为一致（非 0 退出码仍然在 content 里返回）
        return result
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // 不 fallback 到本地执行，防止在服务端本地环境执行任意命令造成安全风险
        const errMsg = `Bash: sandbox execution failed: ${msg}`
        return { content: errMsg, error: errMsg }
      }
    }
  })

  // ── 公共：格式化 PTY 后台任务输出 ──
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
  }

  /**
   * 从 ptyTaskRegistry 读取指定任务的输出并格式化。
   * 如果内存中没有，通过 Process/List API 尝试恢复（跨进程场景）。
   * 返回 null 表示该 taskId 在沙箱中也不存在（应回退原始实现）。
   */
  async function formatPtyTaskOutput(taskId: string, filter?: string): Promise<{ content: string } | null> {
    const task = await ensurePtyTask(taskId)
    if (!task) return null

    // lazy：只在此刻拉取所有积压输出
    await drainPtyOutput(baseUrl, headers, taskId).catch(() => {})

    const duration = (task.endTime ?? Date.now()) - task.startTime

    let stdout = task.stdout
    if (filter) {
      try {
        const re = new RegExp(filter, 'i')
        stdout = stdout
          .split('\n')
          .filter((line) => re.test(line))
          .join('\n')
      } catch {
        return { content: `Invalid regex pattern: ${filter}` }
      }
    }

    const lines = [
      `Shell ID: ${taskId}`,
      `Command: ${task.title}`,
      `Status: ${task.status}`,
      `Duration: ${formatDuration(duration)}`,
      `Timestamp: ${new Date().toISOString()}`,
      '',
      `Stdout (${filter ? 'filtered' : 'full'}):`,
      stdout || '(no output)',
      '',
      'Stderr: (no output)',
    ]

    if (task.status === 'running') {
      lines.push(
        '',
        '<system-reminder>',
        `Background Bash ${taskId} (command: ${task.title}) (status: ${task.status}) Has new output available. You can check its output using the BashOutput tool.`,
        '</system-reminder>',
      )
    }

    return { content: lines.join('\n') }
  }

  // ── BashOutput：从 ptyTaskRegistry 读取输出（支持跨进程恢复）──
  overrideTool('BashOutput', (bashOutputTool) => {
    const originalBashOutputExecute = bashOutputTool.execute

    bashOutputTool.execute = async (params: any, context: ToolContext, extra?: any) => {
      const { shell_id, filter } = params
      const result = await formatPtyTaskOutput(String(shell_id), filter)
      if (result) return result
      return originalBashOutputExecute.call(bashOutputTool, params, context, extra)
    }
  })

  // ── TaskOutput：兼容模型调用 TaskOutput 读后台 shell ──
  overrideTool('TaskOutput', (taskOutputTool) => {
    const originalTaskOutputExecute = taskOutputTool.execute

    taskOutputTool.execute = async (params: any, context: ToolContext, extra?: any) => {
      const taskId = String(params.task_id || params.shell_id || '')
      const task = await ensurePtyTask(taskId)

      if (task) {
        const shouldBlock = params.block !== false
        const timeout = Number(params.timeout) || 60000

        if (shouldBlock && task.status === 'running') {
          const deadline = Date.now() + Math.min(timeout, 600000)
          while (Date.now() < deadline) {
            await drainPtyOutput(baseUrl, headers, taskId).catch(() => {})
            if (task.exited || task.status !== 'running') break
            await new Promise((r) => setTimeout(r, 500))
          }
        }

        const result = await formatPtyTaskOutput(taskId, params.filter)
        if (result) return result
      }

      return originalTaskOutputExecute.call(taskOutputTool, params, context, extra)
    }
  })

  // ── TaskStop：对接 pty_kill ──
  overrideTool('TaskStop', (taskStopTool) => {
    const originalTaskStopExecute = taskStopTool.execute

    taskStopTool.execute = async (params: any, context: ToolContext, extra?: any) => {
      const taskId = String(params.task_id || params.shell_id || '')
      const task = await ensurePtyTask(taskId)
      if (!task) return originalTaskStopExecute.call(taskStopTool, params, context, extra)

      return killPtyTask(baseUrl, headers, task, taskId)
    }
  })

  // ── ImageGen：patch imageService.saveImage，直接将图片上传，不落本地磁盘 ──
  //
  // 原始 saveImage(imageData, prompt, index) 输入：
  //   imageData.b64_json  — base64 字符串
  //   imageData.url       — 临时 CDN URL（有效期 24h）
  //
  // patch 后：decode/下载 → Blob
  //   - 有 hostingConfig → POST hosting-upload 端点 → 返回静态托管 CDN URL
  //   - 无 hostingConfig → POST 沙箱 /e2b-compatible/files → 返回沙箱内相对路径
  overrideTool('ImageGen', (imageGenTool) => {
    const imageService = imageGenTool.imageService
    if (!imageService?.saveImage) return

    imageService.saveImage = async (imageData: any, prompt: string, index: number): Promise<string> => {
      // 生成与原始实现相同的文件名
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const slug = prompt.slice(0, 30).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '_')
      const suffix = index > 0 ? `_${index + 1}` : ''
      const filename = `${slug}_${ts}${suffix}.png`

      // 获取图片二进制
      let bytes: Uint8Array
      if (imageData.b64_json) {
        bytes = Buffer.from(imageData.b64_json, 'base64')
      } else if (imageData.url) {
        const res = await fetch(imageData.url)
        bytes = new Uint8Array(await res.arrayBuffer())
      } else {
        throw new Error('saveImage: imageData has neither b64_json nor url')
      }

      const blob = new Blob([bytes as any], { type: 'image/png' })

      // ── 上传到静态托管（有 hostingConfig 时）──
      if (hostingConfig) {
        const cloudKey = `generated-images/${hostingConfig.sessionId}/${filename}`

        // 1. 向 server 请求预签名 PUT URL（用 session cookie 认证）
        const separator = hostingConfig.presignUrl.includes('?') ? '&' : '?'
        const presignRes = await fetch(`${hostingConfig.presignUrl}${separator}key=${encodeURIComponent(cloudKey)}`, {
          headers: { Cookie: `nex_session=${hostingConfig.sessionCookie}` },
        })
        if (!presignRes.ok) {
          const text = await presignRes.text().catch(() => '')
          throw new Error(`ImageGen presign failed: ${presignRes.status} ${text}`)
        }
        const { presignedUrl, cdnUrl } = (await presignRes.json()) as {
          presignedUrl: string
          cdnUrl: string
        }

        // 2. 直接 PUT 到 COS（不经过 server）
        const putRes = await fetch(presignedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          body: blob,
        })
        if (!putRes.ok) {
          const text = await putRes.text().catch(() => '')
          throw new Error(`ImageGen COS PUT failed: ${putRes.status} ${text}`)
        }

        return cdnUrl
      }

      // ── fallback：上传到沙箱 via 沙箱业务镜像 /api/tools/files_upload ──
      const sandboxRelPath = `generated-images/${filename}`
      const contentBase64 = Buffer.from(await blob.arrayBuffer()).toString('base64')
      const uploadRes = await fetch(`${baseUrl}/api/tools/files_upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ path: sandboxRelPath, contentBase64 }),
      })
      const uploadData = (await uploadRes.json().catch(() => ({}))) as { success?: boolean; error?: string }
      if (!uploadRes.ok || !uploadData.success) {
        throw new Error(`ImageGen upload to sandbox failed: ${uploadData.error || uploadRes.status}`)
      }

      return sandboxRelPath
    }

    // Override execute to correctly format the return value when saveImage
    // returns a CDN URL instead of a local path.
    // Original execute calls AnsiUtils.createFileHyperlink(path) which wraps
    // the path as a file:// OSC 8 hyperlink — unusable for https:// URLs.
    const originalExecute = imageGenTool.execute.bind(imageGenTool)
    imageGenTool.execute = async (params: any, context: ToolContext, extra?: any) => {
      const result = await originalExecute(params, context, extra)
      // If result content contains a mangled file://...https:// hyperlink,
      // replace it with a clean markdown image/link.
      if (result?.content && typeof result.content === 'string') {
        // Extract all https:// URLs from the content
        const urlMatches = result.content.match(/https?:\/\/[^\s\x00-\x1f]+/g)
        if (urlMatches && urlMatches.length > 0) {
          const urls = urlMatches.filter(
            (u: string) => u.endsWith('.png') || u.endsWith('.jpg') || u.endsWith('.webp') || u.endsWith('.gif'),
          )
          if (urls.length === 1) {
            return {
              title: 'Image generated successfully',
              content: `Image URL: ${urls[0]}\n\n![generated image](${urls[0]})`,
              renderer: { type: 'text' },
            }
          } else if (urls.length > 1) {
            const list = urls.map((u: string, i: number) => `${i + 1}. ${u}`).join('\n')
            return {
              title: `${urls.length} images generated successfully`,
              content: `Image URLs:\n${list}`,
              renderer: { type: 'text' },
            }
          }
        }
      }
      return result
    }
  })

  // ── KillShell：对接 pty_kill ──
  overrideTool('KillShell', (killShellTool) => {
    const originalKillExecute = killShellTool.execute

    killShellTool.execute = async (params: any, context: ToolContext, extra?: any) => {
      const shellId = String(params.shell_id || '')
      const task = await ensurePtyTask(shellId)
      if (!task) return originalKillExecute.call(killShellTool, params, context, extra)

      return killPtyTask(baseUrl, headers, task, shellId)
    }
  })

  console.error(`[ToolOverride] ${overriddenCount} tool(s) overridden, baseUrl=${baseUrl}`)
}

// ─── 无沙箱时禁用工具 ────────────────────────────────────────────────────────

const NO_SANDBOX_MESSAGE =
  'This tool is disabled because no sandbox environment is available. ' +
  'File system operations and command execution require a sandbox to run safely.'

/**
 * 禁用所有需要沙箱才能执行的工具。
 * 替换 execute 为直接返回错误信息（Write/Edit throw，其余 return { content, error }）。
 * 使用与 overrideTools 相同的延迟 override 机制，确保后注册的工具也被禁用。
 */
function disableSandboxTools(toolMap: Map<string, any>): void {
  let disabledCount = 0

  const pendingDisables = new Map<string, (tool: any) => void>()

  function disableTool(name: string, disableFn: (tool: any) => void): void {
    const tool = toolMap.get(name)
    if (tool) {
      disableFn(tool)
      disabledCount++
    } else {
      pendingDisables.set(name, disableFn)
    }
  }

  // 拦截 toolMap.set，后注册的工具也自动禁用
  const originalSet = toolMap.set.bind(toolMap)
  toolMap.set = function (key: string, value: any) {
    const result = originalSet(key, value)
    const pending = pendingDisables.get(key)
    if (pending) {
      pendingDisables.delete(key)
      pending(value)
      disabledCount++
    }
    return result
  }

  for (const toolName of SANDBOX_REQUIRED_TOOLS) {
    disableTool(toolName, (tool) => {
      tool.execute = async () => {
        const msg = `${toolName}: ${NO_SANDBOX_MESSAGE}`
        // Write / Edit 类工具 throw，与内置行为一致
        if (THROW_ON_ERROR_TOOLS.has(toolName)) {
          throw new Error(msg)
        }
        return { content: msg, error: msg }
      }
    })
  }

  console.error(`[ToolOverride] ${disabledCount} tool(s) disabled (no sandbox environment)`)
}
