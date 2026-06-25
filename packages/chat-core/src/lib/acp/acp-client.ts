/**
 * AcpClient — ACP 协议客户端
 *
 * P3: 把散落在 `use-chat-stream.ts` 里的协议逻辑（JSON-RPC 拼装、SSE 解析、
 * initialize/session/load/session/new 序列、409 重连）统一到此处。
 *
 * 设计要点（参考反编译 01-acp-client.ts 的 Wi 类）：
 * 1. **每 taskId 一个实例**：`taskId` 在构造时注入，所有方法隐式绑定到该会话；
 *    调用方不再需要每次传 sessionId。
 * 2. **非流式方法**（request/initializeSession/cancel）带 5xx 自动重试；
 *    `request` 还在 409 时尝试 reconnect 一次原请求（最多 2 次）。
 * 3. **流式方法**（stream/observe）返回 `AsyncIterable<ExtendedSessionUpdate>`，
 *    不做自动重试（流中断后的状态恢复由 hook 的 reconnectToStream 负责）。
 * 4. **错误统一抛 AcpStreamError**：SSE 帧里的 `{ error: {...} }` 会作为异常抛出，
 *    让 hook 用单个 try/catch 覆盖传输错误 + 协议错误。
 * 5. **单调递增 id**：避免反编译版本用 `Date.now()` 可能冲突的问题。
 *
 * 不包含：
 * - pub/sub 事件总线（hook 保留 for-await 控制权）
 * - XHR（本项目始终用 fetch + ReadableStream）
 * - React state（这里是纯协议层，不感知 UI）
 */
import type {
  ExtendedSessionUpdate,
  SessionDeleteParams,
  SessionDeleteResult,
  SessionListParams,
  SessionListResult,
  SessionNewMeta,
  SessionNewResult,
} from '@coder/shared'
import { fetchWithRetry } from './fetch-with-retry'

export interface AcpClientOptions {
  /** 非流式 JSON-RPC 基地址，如 `/api/agent/acp` */
  baseUrl: string
  /** 流式 observe 基地址，如 `/api/agent/observe`；默认由 baseUrl 推导 */
  observeBaseUrl?: string
  /** 会话/任务 ID，所有方法的 sessionId 都绑定到此 */
  taskId: string
  /**
   * 每次请求前调用，返回额外 headers（如 Bearer token）。
   * 同名 header 会覆盖默认值；返回值变化无需重建 client。
   */
  getHeaders?: () => Record<string, string> | undefined
  /**
   * 是否在请求头里带 `X-Task-Id`（默认 true）。
   * 同源 web 主应用需要它配合 server 的 task 级资源解析；
   * playground 等跨域场景可关闭，taskId 走 body/query 传递即可。
   */
  sendTaskIdHeader?: boolean
}

/**
 * ACP 流式请求中携带的协议错误。
 * hook 层用 `err instanceof AcpStreamError` 即可区分协议错误 vs 传输错误（但通常两者一视同仁）。
 */
export class AcpStreamError extends Error {
  public readonly rpcMethod: string
  constructor(message: string, rpcMethod: string) {
    super(message)
    this.name = 'AcpStreamError'
    this.rpcMethod = rpcMethod
  }
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc?: string
  id?: number | string | null
  result?: T
  error?: { code?: number; message?: string }
}

export class AcpClient {
  private readonly baseUrl: string
  private readonly observeBaseUrl: string
  private readonly taskId: string
  private readonly getExtraHeaders?: () => Record<string, string> | undefined
  private readonly sendTaskIdHeader: boolean

  /** 单调递增的 JSON-RPC id（避免 Date.now() 同毫秒冲突） */
  private nextId = 1

  /** 已成功 initialize 的标记；`initializeSession` 多次调用幂等 */
  private sessionInitialized = false

  /** initialize 正在进行时的 latch，防止并发重复初始化 */
  private initializing: Promise<void> | null = null

  constructor(options: AcpClientOptions) {
    this.baseUrl = options.baseUrl
    this.observeBaseUrl = options.observeBaseUrl ?? options.baseUrl.replace(/\/acp$/, '/observe')
    this.taskId = options.taskId
    this.getExtraHeaders = options.getHeaders
    this.sendTaskIdHeader = options.sendTaskIdHeader ?? true
  }

  /**
   * 合并请求 headers：默认 Content-Type，按需附加 X-Task-Id，叠加 getHeaders() 返回值。
   *
   * `sendTaskIdHeader=true`（默认）时 POST 请求带 `X-Task-Id`，配合同源 server
   * 的 task 级资源解析。playground 等跨域场景关闭后，taskId 由 body/query 携带。
   * `withTaskId=false` 用于 GET observe 等不需要 taskId 的请求（始终不发）。
   */
  private buildHeaders(opts: { withTaskId?: boolean; jsonBody?: boolean } = {}): Record<string, string> {
    const { withTaskId = true, jsonBody = true } = opts
    const headers: Record<string, string> = {}
    if (jsonBody) headers['Content-Type'] = 'application/json'
    if (withTaskId && this.sendTaskIdHeader && this.taskId) headers['X-Task-Id'] = this.taskId
    const extra = this.getExtraHeaders?.()
    if (extra) Object.assign(headers, extra)
    return headers
  }

  // ────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────

  /**
   * 保证 ACP 会话已初始化。幂等，并发安全。
   *
   * 流程：initialize → session/load → （若失败）session/new。
   */
  async initializeSession(): Promise<void> {
    if (this.sessionInitialized) return
    if (this.initializing) return this.initializing

    this.initializing = this.doInitialize()
    try {
      await this.initializing
      this.sessionInitialized = true
    } finally {
      this.initializing = null
    }
  }

  /**
   * 非流式 JSON-RPC 调用。
   * - 5xx / 网络错误：自动指数退避重试（经 fetchWithRetry）
   * - 409 连接丢失：重新 initialize 后重试原请求（最多重试 2 次）
   * - 成功返回 `result`；协议错误 / HTTP 错误抛 Error
   */
  async request<T = unknown>(method: string, params: unknown, _reconnectAttempt = 0): Promise<T> {
    const body = this.buildRequestBody(method, params)
    const res = await fetchWithRetry(withIntentQuery(this.baseUrl, method), {
      method: 'POST',
      credentials: 'include',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    })

    // 409: 连接丢失，尝试 reconnect 后重试
    if (res.status === 409 && method !== 'initialize' && _reconnectAttempt < 2) {
      console.warn('ACP connection lost (409), reinitializing and retrying')
      this.sessionInitialized = false
      await this.initializeSession()
      return this.request<T>(method, params, _reconnectAttempt + 1)
    }

    if (!res.ok) {
      const msg = await extractErrorMessage(res)
      throw new Error(msg || `ACP request failed: ${res.status} ${res.statusText}`)
    }

    const json = (await res.json()) as JsonRpcResponse<T>
    if (json.error) {
      throw new Error(json.error.message || 'ACP protocol error')
    }
    return json.result as T
  }

  /**
   * Fire-and-forget 通知（无 id，无响应）。网络错误被吞掉。
   */
  async notify(method: string, params: unknown): Promise<void> {
    try {
      await fetch(withIntentQuery(this.baseUrl, method), {
        method: 'POST',
        credentials: 'include',
        headers: this.buildHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      })
    } catch {
      // swallow: notify 是 fire-and-forget
    }
  }

  /**
   * 流式 session/prompt。打开 SSE POST，yield 每个 `session/update` 事件的 `update` 字段。
   *
   * 异常：
   * - fetch 拒绝 / body 读失败 → 抛原生错误
   * - SSE 帧携带 `{ error: {...} }` → 抛 `AcpStreamError`
   * - 正常 `data: [DONE]` 或流结束 → 生成器 return（for-await 退出 body）
   *
   * 不做自动重试（流中断后的恢复由调用方的 reconnectToStream 负责）。
   */
  async *stream(method: 'session/prompt', params: unknown, signal?: AbortSignal): AsyncIterable<ExtendedSessionUpdate> {
    const body = this.buildRequestBody(method, params)
    const res = await fetch(withIntentQuery(this.baseUrl, method), {
      method: 'POST',
      credentials: 'include',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok || !res.body) {
      const msg = await extractErrorMessage(res)
      console.error(`[AcpClient] stream ${method} failed: ${res.status}`, msg)
      throw new AcpStreamError(msg || `ACP stream failed: ${res.status} ${res.statusText}`, method)
    }

    // The response may be a plain JSON-RPC error (not SSE) when the server
    // rejects the request synchronously (e.g. "A prompt turn is already in progress").
    // Detect by content-type: SSE uses text/event-stream, errors use application/json.
    const contentType = res.headers.get('content-type') || ''
    console.log(`[AcpClient] stream response content-type: ${contentType}`)
    if (!contentType.includes('text/event-stream')) {
      // Not SSE — try to parse as JSON-RPC error
      try {
        const text = await res.text()
        console.log(`[AcpClient] non-SSE response body:`, text.slice(0, 500))
        const json = JSON.parse(text) as JsonRpcResponse
        if (json.error) {
          throw new AcpStreamError(json.error.message || 'ACP request rejected', method)
        }
      } catch (e) {
        if (e instanceof AcpStreamError) throw e
        console.warn(`[AcpClient] failed to parse non-SSE response:`, e)
      }
      return
    }

    yield* parseSseBody(res, method)
  }

  /**
   * 重连到进行中的流（观察路由）。GET /api/agent/observe/:taskId?turnId=...
   *
   * 契约同 `stream()`：AsyncIterable，正常结束 return，错误 throw。
   */
  async *observe(turnId: string, signal?: AbortSignal): AsyncIterable<ExtendedSessionUpdate> {
    const url = withIntentQuery(`${this.observeBaseUrl}/${this.taskId}?turnId=${encodeURIComponent(turnId)}`, 'observe')
    const res = await fetch(url, {
      credentials: 'include',
      signal,
      headers: this.buildHeaders({ jsonBody: false, withTaskId: false }),
    })

    if (!res.ok || !res.body) {
      const msg = await extractErrorMessage(res)
      throw new AcpStreamError(msg || `ACP observe failed: ${res.status} ${res.statusText}`, 'observe')
    }

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      try {
        const json = (await res.json()) as JsonRpcResponse
        if (json.error) {
          throw new AcpStreamError(json.error.message || 'ACP observe rejected', 'observe')
        }
      } catch (e) {
        if (e instanceof AcpStreamError) throw e
      }
      return
    }

    yield* parseSseBody(res, 'observe')
  }

  /**
   * replay 一页历史消息（ACP session/load + replay=true）。
   */
  async *loadHistory(
    params: { cursor?: string | null; limit?: number; sort?: 'ASC' | 'DESC' } = {},
  ): AsyncIterable<ExtendedSessionUpdate> {
    const body = this.buildRequestBody('session/load', {
      sessionId: this.taskId,
      replay: true,
      cursor: params.cursor ?? undefined,
      limit: params.limit,
      sort: params.sort,
    })
    const res = await fetch(withIntentQuery(this.baseUrl, 'session/load'), {
      method: 'POST',
      credentials: 'include',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    })

    if (!res.ok || !res.body) {
      const msg = await extractErrorMessage(res)
      throw new AcpStreamError(msg || `ACP session/load replay failed: ${res.status} ${res.statusText}`, 'session/load')
    }

    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      try {
        const json = (await res.json()) as JsonRpcResponse
        if (json.error) {
          throw new AcpStreamError(json.error.message || 'ACP session/load replay rejected', 'session/load')
        }
      } catch (e) {
        if (e instanceof AcpStreamError) throw e
      }
      return
    }

    yield* parseSseBody(res, 'session/load')
  }

  /**
   * POST session/cancel。
   */
  async cancel(): Promise<void> {
    await this.request('session/cancel', { sessionId: this.taskId })
  }

  /**
   * 列出当前用户的会话（ACP session/list）。
   *
   * 此方法不绑定 taskId — 它列的是"所有 session"，不属于任何特定会话。
   * 因此提供为静态方法：调用方只需提供 baseUrl，不必先造 AcpClient 实例。
   *
   * 默认 20 条，按 createdAt desc。当前后端忽略 params.cwd 与 params.orderBy。
   */
  static async listSessions(
    baseUrl: string,
    params: SessionListParams = {},
    extraHeaders?: Record<string, string>,
  ): Promise<SessionListResult> {
    return AcpClient.staticRpc<SessionListResult>(baseUrl, 'session/list', params, extraHeaders)
  }

  /**
   * 创建新会话（ACP session/new）。
   *
   * 此方法不绑定 taskId — 调用方在拿到返回的 sessionId 后再用它构造 AcpClient
   * 实例进入对话。提供为静态方法以避免"造 AcpClient → initialize → 再创建"
   * 的循环。
   *
   * - conversationId 不填则服务端生成 uuid
   * - meta 是会话级配置（runtime/model/mode 等），全部可选
   */
  static async createSession(
    baseUrl: string,
    options: { conversationId?: string; meta?: SessionNewMeta } = {},
    extraHeaders?: Record<string, string>,
  ): Promise<SessionNewResult> {
    return AcpClient.staticRpc<SessionNewResult>(baseUrl, 'session/new', options, extraHeaders)
  }

  /**
   * 删除会话（ACP spec 扩展 session/delete）。
   *
   * 同样不绑定 taskId — 调用方在列表 UI 上直接对某一行调用。
   * 幂等：sessionId 不存在或不归属当前用户时 server 应返回 `deleted: false`。
   */
  static async deleteSession(
    baseUrl: string,
    params: SessionDeleteParams,
    extraHeaders?: Record<string, string>,
  ): Promise<SessionDeleteResult> {
    return AcpClient.staticRpc<SessionDeleteResult>(baseUrl, 'session/delete', params, extraHeaders)
  }

  /**
   * 静态方法共享的最小 JSON-RPC 调用（不绑定 taskId、不走 initialize 状态机）。
   * 仅用于 listSessions / createSession 这类"会话外"操作。
   */
  private static async staticRpc<T>(
    baseUrl: string,
    method: string,
    params: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const body = {
      jsonrpc: '2.0' as const,
      id: Date.now(),
      method,
      params,
    }
    const res = await fetchWithRetry(withIntentQuery(baseUrl, method), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const msg = await extractErrorMessage(res)
      throw new Error(msg || `ACP ${method} failed: ${res.status}`)
    }
    const json = (await res.json()) as JsonRpcResponse<T>
    if (json.error) {
      throw new Error(json.error.message || `ACP ${method} protocol error`)
    }
    return json.result as T
  }

  // ────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────

  private buildRequestBody(method: string, params: unknown) {
    return {
      jsonrpc: '2.0' as const,
      id: this.nextId++,
      method,
      params,
    }
  }

  /**
   * 真正的 initialize 流程（给 initializeSession 复用）。
   *
   * 三段：
   * 1. initialize（协议版本协商）
   * 2. session/load（基于 taskId 加载已有会话）
   * 3. 若 load 报错（通常是 "session not found"）→ session/new
   *
   * 这里 **不走 `request()`**（会造成初始化循环）；直接 fetchWithRetry，
   * 语义与 request() 基本一致但不做 409 重连。
   */
  private async doInitialize(): Promise<void> {
    // 1. initialize
    await this.postJsonRpc('initialize', { protocolVersion: 1 })

    // 2. session/load（可能失败）
    let loadedOk = false
    try {
      await this.postJsonRpc('session/load', { sessionId: this.taskId })
      loadedOk = true
    } catch {
      // 失败通常是 session not found，走 new 分支
    }

    // 3. session/new
    if (!loadedOk) {
      await this.postJsonRpc('session/new', { conversationId: this.taskId })
    }
  }

  /**
   * 非流式 JSON-RPC POST（内部使用，不触发 409 重连逻辑）。
   * 失败时抛 Error。
   */
  private async postJsonRpc(method: string, params: unknown): Promise<unknown> {
    const body = this.buildRequestBody(method, params)
    const res = await fetchWithRetry(withIntentQuery(this.baseUrl, method), {
      method: 'POST',
      credentials: 'include',
      headers: this.buildHeaders({ withTaskId: false }),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const msg = await extractErrorMessage(res)
      throw new Error(msg || `ACP ${method} failed: ${res.status}`)
    }
    const json = (await res.json()) as JsonRpcResponse
    if (json.error) {
      throw new Error(json.error.message || `ACP ${method} protocol error`)
    }
    return json.result
  }
}

// ────────────────────────────────────────────────────────────────────
// Module-level helpers
// ────────────────────────────────────────────────────────────────────

/**
 * 解析 SSE response.body，yield 每个 `session/update` 的 update 字段。
 *
 * SSE 格式契约（与当前 readSSEStream 一致）：
 * - 每行 `data: {...}\n`
 * - `data: [DONE]` 表示正常结束
 * - `{... error: {message}}` 帧抛 AcpStreamError
 * - 其余帧若 `method === 'session/update'`，yield `params.update`
 * - 解析失败的行静默跳过
 */
async function* parseSseBody(res: Response, rpcMethod: string): AsyncIterable<ExtendedSessionUpdate> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        if (line.trim() === 'data: [DONE]') continue

        let event: JsonRpcResponse & { method?: string; params?: { update?: ExtendedSessionUpdate } }
        try {
          event = JSON.parse(line.slice(6))
        } catch {
          continue
        }

        if (event.error) {
          throw new AcpStreamError(event.error.message || 'ACP stream error', rpcMethod)
        }
        if (event.method === 'session/update' && event.params?.update) {
          yield event.params.update
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function withIntentQuery(url: string, intent: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}i=${encodeURIComponent(intent.replace('/', '.'))}`
}

/**
 * 尽力从 Response 里提取 error.message（JSON 解析失败则退回 statusText）。
 */
async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const json = (await res.clone().json()) as JsonRpcResponse
    return json.error?.message || res.statusText
  } catch {
    return res.statusText
  }
}
