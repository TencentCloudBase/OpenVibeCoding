import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { v4 as uuidv4 } from 'uuid'
import {
  ACP_PROTOCOL_VERSION,
  NEX_AGENT_INFO,
  JSON_RPC_ERRORS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type InitializeResult,
  type SessionNewResult,
  type SessionPromptParams,
  type AgentCallback,
  type AgentCallbackMessage,
} from '@coder/shared'
import { CloudbaseAgentService, getSupportedModels } from '../agent/cloudbase-agent.service.js'
import { persistenceService } from '../agent/persistence.service.js'
import { getAgentRun, removeAgent, type StopReason } from '../agent/agent-registry.js'
import { agentRuntimeRegistry } from '../agent/runtime/index.js'
import { emitForConversation, getAskUserToken } from '../agent/runtime/opencode-acp-runtime.js'
import { registerPendingQuestion } from '../agent/runtime/pending-question-registry.js'
import { loadConfig } from '../config/store.js'
import { getDb } from '../db/index.js'
import { nanoid } from 'nanoid'
import { requireUserEnv, type AppEnv } from '../middleware/auth.js'

const acp = new Hono<AppEnv>()

// 除 /health 与 /runtimes 外，所有 ACP 路由都需要登录 + 用户环境校验
// /internal/* 走独立 127.0.0.1 + shared token 认证（绕过用户会话）
acp.use('/*', async (c, next) => {
  const p = c.req.path
  if (p.endsWith('/health') || p.endsWith('/config') || p.endsWith('/runtimes')) {
    return next()
  }
  if (p.includes('/internal/')) {
    // 仅接受 127.0.0.1 + 正确 token 的请求
    // 注意：Hono 不直接提供 remote addr 但可从 header X-Forwarded-For 判断；
    // 这里更务实 — 用 token 作为主要防线（opencode 子进程是我们自己 spawn 的）
    const expected = getAskUserToken()
    const got = c.req.header('X-Internal-Token')
    if (!expected || got !== expected) {
      return c.json({ error: 'Unauthorized internal call' }, 401)
    }
    return next()
  }
  // If using API key auth, verify it has 'acp' scope
  const scopes = c.get('apiKeyScopes')
  if (scopes !== undefined && !scopes.includes('acp')) {
    return c.json({ error: 'API key does not have ACP scope' }, 403)
  }

  // 从 JSON-RPC body 提取 conversationId/sessionId 作为 taskIdHint，
  // 让 requireUserEnv 能按 task 级解析 envId（task provision 模式必备）。
  // hono 缓存 body，下游 handler 再调 c.req.json() 不会出错。
  if (c.req.method === 'POST') {
    try {
      const body = (await c.req.json().catch(() => null)) as {
        params?: { conversationId?: string; sessionId?: string }
        conversationId?: string
      } | null
      const hint =
        body?.params?.conversationId ??
        body?.params?.sessionId ??
        body?.conversationId ??
        c.req.header('X-Task-Id') ??
        undefined
      if (hint) {
        c.set('taskIdHint', hint)
        console.log('[acp middleware] taskIdHint set from body', { path: p, hint })
      }
    } catch {
      // 解析失败不影响主流程
    }
  }

  return requireUserEnv(c, next)
})

// ─── JSON-RPC Helper Functions ────────────────────────────────────────────

function rpcOk<T>(id: number | string, result: T): JsonRpcResponse<T> {
  return { jsonrpc: '2.0', id, result }
}

function rpcErr(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  }
}

/**
 * 终结 SSE 报文时推导 ACP stopReason。
 *
 * 优先级：
 *   1. runtime 通过 completeAgent 显式传入的 run.stopReason（最准确）
 *   2. status='cancelled' → 'cancelled'
 *   3. status='error'    → 'refusal'（ACP 协议没有 'error' 字面量，用 refusal
 *                          对齐 CodeBuddy SDK 自己的 ACP server 行为；错误文本
 *                          通过 agent_message_chunk ⚠️ 单独投递）
 *   4. else              → 'end_turn'
 */
function resolveStopReason(run: { status?: string; stopReason?: StopReason } | undefined): StopReason {
  if (run?.stopReason) return run.stopReason
  if (run?.status === 'cancelled') return 'cancelled'
  if (run?.status === 'error') return 'refusal'
  return 'end_turn'
}

// ─── Health Check ──────────────────────────────────────────────────────────

acp.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'acp' })
})

// ─── Conversation CRUD ─────────────────────────────────────────────────────

/**
 * 创建新会话
 */
acp.post('/conversation', async (c) => {
  const body = await c.req.json<{ title?: string; conversationId?: string }>()
  const conversationId = body?.conversationId || uuidv4()
  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!

  if (!envId) {
    return c.json({ error: 'CloudBase environment not bound' }, 400)
  }

  // 检查会话是否已存在
  const exists = await persistenceService.conversationExists(conversationId, userId, envId)
  if (exists) {
    return c.json({ conversationId, exists: true })
  }

  // 会话记录会在第一次 prompt 时自动创建
  return c.json({ conversationId })
})

/**
 * 获取会话列表
 * 注：简化实现，返回最近有消息的会话
 */
acp.get('/conversations', async (c) => {
  // 简化实现：从消息记录中聚合会话列表
  // 实际项目中应该有单独的会话表
  return c.json({ total: 0, data: [] })
})

/**
 * 获取会话消息记录（分页）
 */
acp.get('/conversation/records', async (c) => {
  const conversationId = c.req.query('conversationId')
  const limit = parseInt(c.req.query('limit') || '10')
  const sort = (c.req.query('sort') || 'DESC') as 'ASC' | 'DESC'
  const type = c.req.query('type') || 'agui'

  if (!conversationId) {
    return c.json({ error: 'conversationId is required' }, 400)
  }

  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!
  if (!envId) {
    return c.json({ error: 'CloudBase environment not bound' }, 400)
  }

  const records = await persistenceService.loadDBMessages(conversationId, envId, userId, limit)

  // 过滤内容类型
  const ALLOWED_CONTENT_TYPES = new Set(['text', 'tool_use', 'tool_result', 'reasoning'])
  const filteredRecords = records.map((record) => ({
    ...record,
    parts: (record.parts || []).filter((p) => ALLOWED_CONTENT_TYPES.has(p.contentType)),
  }))

  // AGUI 格式转换
  if (type === 'agui') {
    const DB_TO_AGUI_CONTENT_TYPE: Record<string, string> = {
      tool_call: 'tool_use',
    }
    for (const record of filteredRecords) {
      for (const part of record.parts) {
        if (DB_TO_AGUI_CONTENT_TYPE[part.contentType]) {
          part.contentType = DB_TO_AGUI_CONTENT_TYPE[part.contentType] as any
        }
        if (part.contentType === 'tool_result' && typeof part.content === 'string') {
          try {
            const contents = JSON.parse(part.content)
            const arr = Array.isArray(contents) ? contents : [contents]
            part.content = arr
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text || '')
              .join('')
          } catch {
            // 保持原样
          }
        }
      }
    }
  }

  return c.json({ total: records.length, data: filteredRecords })
})

/**
 * 获取会话消息
 */
acp.get('/conversation/:conversationId/messages', async (c) => {
  const conversationId = c.req.param('conversationId')
  const limit = parseInt(c.req.query('limit') || '50')
  const sort = (c.req.query('sort') || 'DESC') as 'ASC' | 'DESC'

  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!
  if (!envId) {
    return c.json({ error: 'CloudBase environment not bound' }, 400)
  }

  const records = await persistenceService.loadDBMessages(conversationId, envId, userId, limit)

  // 转换为前端格式
  const data = records.map((r) => ({
    recordId: r.recordId,
    conversationId: r.conversationId,
    role: r.role,
    parts: r.parts,
    createTime: r.createTime,
  }))

  if (sort === 'DESC') {
    data.reverse()
  }

  return c.json({ total: data.length, data })
})

/**
 * 删除会话
 * 注：简化实现，暂不支持删除
 */
acp.delete('/conversation/:conversationId', async (c) => {
  // 简化实现
  return c.json({ status: 'success' })
})

// ─── Chat Endpoint (SSE) ───────────────────────────────────────────────────

/**
 * POST /api/agent/chat
 *
 * 简单的聊天端点，返回 SSE 流式响应
 */
acp.post('/chat', async (c) => {
  const body = await c.req.json<{
    prompt: string
    conversationId?: string
    model?: string
    mode?: string
    /** Runtime override：tencent-sdk | opencode-acp | ... 默认 tencent-sdk */
    runtime?: string
  }>()
  const { prompt, conversationId, model, mode, runtime: runtimeName } = body

  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!
  if (!envId) {
    return c.json({ error: 'CloudBase environment not bound' }, 400)
  }

  const actualConversationId = conversationId || uuidv4()

  let taskMode = mode as 'default' | 'coding' | undefined
  if (!taskMode && conversationId) {
    try {
      const task = await getDb().tasks.findById(conversationId)
      if (task?.mode === 'coding') taskMode = 'coding'
    } catch {
      // ignore
    }
  }

  const runtime = agentRuntimeRegistry.resolve({
    explicitRuntime: runtimeName,
    conversationId: actualConversationId,
  })

  return observeStreamWithLiveCallback(c, null, actualConversationId, envId, userId, async (callback) => {
    return runtime.chatStream(prompt, callback, {
      conversationId: actualConversationId,
      envId,
      userId,
      userCredentials,
      model,
      mode: taskMode,
    })
  })
})

// ─── ACP JSON-RPC 2.0 Endpoint ─────────────────────────────────────────────

/**
 * POST /api/agent/acp
 *
 * ACP JSON-RPC 2.0 协议端点，支持：
 * - initialize: 协议握手
 * - session/new: 创建会话
 * - session/load: 加载会话
 * - session/prompt: 发送消息（SSE 流式响应）
 * - session/cancel: 取消请求
 */
acp.post('/acp', async (c) => {
  const body: JsonRpcRequest = await c.req.json()

  // 验证 JSON-RPC 请求
  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    return c.json(rpcErr(body?.id ?? null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request'), 400)
  }

  const { id, method, params } = body
  const isNotification = id === undefined || id === null

  // 根据方法路由
  switch (method) {
    case 'initialize':
      return handleInitialize(c, id!)

    case 'session/new':
      return handleSessionNew(c, id!, params)

    case 'session/load':
      return handleSessionLoad(c, id!, params)

    case 'session/prompt':
      return handleSessionPrompt(c, id!, params as unknown as SessionPromptParams)

    case 'session/cancel':
      return handleSessionCancel(c, id ?? null, params, isNotification)

    default:
      if (isNotification) {
        return c.text('', 200)
      }
      return c.json(rpcErr(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method '${method}' not found`))
  }
})

// ─── ACP Method Handlers ───────────────────────────────────────────────────

async function handleInitialize(c: any, id: number | string) {
  // 异步获取支持的模型列表（首次会调 SDK，后续走缓存）
  getSupportedModels().catch(() => {})
  const models = await getSupportedModels()
  const result: InitializeResult = {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: false,
      },
    },
    agentInfo: NEX_AGENT_INFO,
    authMethods: [],
    supportedModels: models,
  }
  return c.json(rpcOk(id, result))
}

async function handleSessionNew(c: any, id: number | string, params: Record<string, unknown> | undefined) {
  const conversationId = (params?.conversationId as string) || uuidv4()
  const sessionId = conversationId

  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!
  if (!envId) {
    return c.json(rpcErr(id, JSON_RPC_ERRORS.INTERNAL, 'CloudBase environment not bound'))
  }

  try {
    // 检查会话是否已存在
    const exists = await persistenceService.conversationExists(conversationId, userId, envId)

    let hasHistory = false
    if (exists) {
      // 检查是否有历史消息
      const messages = await persistenceService.loadDBMessages(conversationId, envId, userId, 1)
      hasHistory = messages.length > 0
    }

    const result: SessionNewResult = { sessionId, hasHistory }
    return c.json(rpcOk(id, result))
  } catch (error) {
    return c.json(rpcErr(id, JSON_RPC_ERRORS.INTERNAL, (error as Error).message))
  }
}

async function handleSessionLoad(c: any, id: number | string, params: Record<string, unknown> | undefined) {
  const sessionId = params?.sessionId as string

  if (!sessionId) {
    return c.json(rpcErr(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'sessionId is required'))
  }

  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!
  if (!envId) {
    return c.json(rpcErr(id, JSON_RPC_ERRORS.INTERNAL, 'CloudBase environment not bound'))
  }

  const exists = await persistenceService.conversationExists(sessionId, userId, envId)

  if (!exists) {
    return c.json(rpcErr(id, JSON_RPC_ERRORS.INVALID_PARAMS, `Session '${sessionId}' not found`))
  }

  return c.json(rpcOk(id, { sessionId }))
}

async function handleSessionPrompt(c: any, id: number | string, params: SessionPromptParams) {
  const sessionId = params?.sessionId

  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!
  if (!envId) {
    return c.json(rpcErr(id, JSON_RPC_ERRORS.INTERNAL, 'CloudBase environment not bound'))
  }

  // Resume payload (askAnswers / toolConfirmation) 必须路由到 runtime.chatStream 的
  // resume 分支来 resolve 挂起的 question/permission，而不是只 observe。
  // 这里优先检查 resume payload —— 有 resume 时跳过 observeStream early-return。
  const hasResumePayloadEarly =
    (params?.askAnswers && Object.keys(params.askAnswers).length > 0) || !!params?.toolConfirmation

  if (!hasResumePayloadEarly) {
    // Check if agent is already running via registry
    const existingRun = getAgentRun(sessionId)
    if (existingRun && existingRun.status === 'running') {
      return observeStream(c, id, sessionId, existingRun.turnId, envId, userId)
    }

    // Check DB status as fallback
    const latestStatus = await persistenceService.getLatestRecordStatus(sessionId, userId, envId)
    if (latestStatus && (latestStatus.status === 'pending' || latestStatus.status === 'streaming')) {
      return c.json(rpcErr(id, JSON_RPC_ERRORS.INVALID_REQUEST, 'A prompt turn is already in progress'))
    }
  }

  // Extract prompt text and image blocks
  const promptBlocks: any[] = params?.prompt ?? []
  const prompt: string = promptBlocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const imageBlocks = promptBlocks.filter((b) => b.type === 'image')

  const hasResumePayload =
    (params?.askAnswers && Object.keys(params.askAnswers).length > 0) || !!params?.toolConfirmation

  if (!prompt.trim() && !hasResumePayload && imageBlocks.length === 0) {
    return c.json(rpcErr(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'prompt must contain at least one text block'))
  }

  const effectivePrompt = prompt.trim() ? prompt : hasResumePayload ? '继续未完成的任务' : prompt

  // Read task metadata once: selectedModel + mode + selectedRuntime
  let selectedModel: string | undefined
  let taskMode: 'default' | 'coding' | undefined
  let taskRuntime: string | undefined
  try {
    const task = await getDb().tasks.findById(sessionId)
    selectedModel = task?.selectedModel || undefined
    if (task?.mode === 'coding') taskMode = 'coding'
    // task.selectedRuntime 是创建任务时用户选择的 runtime（如 'opencode-acp'）
    taskRuntime = task?.selectedRuntime || undefined
  } catch {
    // read failure doesn't affect main flow
  }

  // Update task status to pending
  try {
    await getDb().tasks.update(sessionId, { status: 'pending', updatedAt: Date.now() })
  } catch {
    // write failure doesn't affect main flow
  }

  // Resolve runtime: 优先级 request param > task's selectedRuntime > AGENT_RUNTIME env > default
  const runtime = agentRuntimeRegistry.resolve({
    explicitRuntime: params.runtime || taskRuntime,
    conversationId: sessionId,
  })

  // Launch agent with liveCallback for real-time SSE push
  return observeStreamWithLiveCallback(c, id, sessionId, envId, userId, async (callback) => {
    return runtime.chatStream(effectivePrompt, callback, {
      conversationId: sessionId,
      envId,
      userId,
      userCredentials,
      model: selectedModel,
      askAnswers: params.askAnswers,
      toolConfirmation: params.toolConfirmation,
      permissionMode: params.permissionMode,
      mode: taskMode,
      imageBlocks: imageBlocks.length > 0 ? imageBlocks : undefined,
    })
  })
}

// ─── Observe Stream (SSE replay + poll) ──────────────────────────────────────

/**
 * GET /api/agent/observe/:sessionId
 *
 * SSE endpoint: replay existing ACP events + poll for new events until turn completes
 */
acp.get('/observe/:sessionId', requireUserEnv, async (c) => {
  const sessionId = c.req.param('sessionId')!
  const { envId, userId } = c.get('userEnv')!

  if (!envId) {
    return c.json({ error: 'CloudBase environment not bound' }, 400)
  }

  let turnId = c.req.query('turnId') || undefined
  if (!turnId) {
    const latest = await persistenceService.getLatestRecordStatus(sessionId, userId!, envId!)
    if (!latest || (latest.status !== 'pending' && latest.status !== 'streaming')) {
      return c.json({ error: 'No active turn to observe' }, 404)
    }
    turnId = latest.recordId
  }

  return observeStream(c, null, sessionId, turnId, envId!, userId!)
})

async function observeStream(
  c: any,
  rpcId: number | string | null,
  sessionId: string,
  turnId: string,
  _envId: string,
  _userId: string,
) {
  return streamSSE(c, async (stream) => {
    let lastSeq = -1
    const POLL_INTERVAL = 500

    // 1. Replay existing events
    try {
      const existingEvents = await persistenceService.getStreamEvents(sessionId, turnId)
      for (const evt of existingEvents) {
        await stream.writeSSE({
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId, update: evt.event },
          }),
        })
        lastSeq = Math.max(lastSeq, evt.seq)
      }
    } catch {
      // Replay failure is non-fatal
    }

    // 2. Poll loop — SSE 寿命跟随 agent，仅在 agent 真完成时才发 stopReason + [DONE]；
    //    客户端断流时静默 return。
    //    run === undefined 意味着 registry 已被消费者清理（agent 已结束），直接视为完成。
    let agentDone = false
    while (true) {
      if (stream.closed || stream.aborted) {
        console.log(`[SSE observe] ${sessionId} stream closed/aborted, breaking`)
        break
      }

      const run = getAgentRun(sessionId)
      const isDone = !run || run.status !== 'running'

      try {
        const newEvents = await persistenceService.getStreamEvents(sessionId, turnId, lastSeq)
        for (const evt of newEvents) {
          await stream.writeSSE({
            data: JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId, update: evt.event },
            }),
          })
          lastSeq = Math.max(lastSeq, evt.seq)
        }

        if (isDone && newEvents.length === 0) {
          agentDone = true
          break
        }
      } catch {
        if (isDone) {
          agentDone = true
          break
        }
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    }

    if (!agentDone) {
      console.log(
        `[SSE observe] ${sessionId} stream ended without agent completion (client disconnect), skipping final stopReason/[DONE]`,
      )
      return
    }

    // 3. Send final response + [DONE]
    if (rpcId !== null) {
      const run = getAgentRun(sessionId)
      const stopReason = resolveStopReason(run)
      await stream.writeSSE({ data: JSON.stringify(rpcOk(rpcId, { stopReason })) })
    }
    await stream.writeSSE({ data: '[DONE]' })

    // 4. Cleanup stream events — only if agent is no longer running.
    // If agent is still running (client disconnected mid-stream),
    // keep events in DB for reconnection via GET /observe/:sessionId.
    const runAfterDone = getAgentRun(sessionId)
    if (!runAfterDone || runAfterDone.status !== 'running') {
      persistenceService.cleanupStreamEvents(sessionId, turnId).catch(() => {
        // Non-critical
      })
      removeAgent(sessionId, turnId)
    }
  })
}

// ─── Observe Stream with Live Push (real-time SSE) ──────────────────────────

/**
 * Like `observeStream`, but additionally passes a `liveCallback` to `chatStream`
 * for real-time SSE push. The poll loop serves as a safety net for completion
 * detection and any events the liveCallback might have missed.
 *
 * Used by `session/prompt` and `POST /chat` where we launch the agent.
 * NOT used by `GET /observe/:sessionId` (reconnection — poll-only).
 */
async function observeStreamWithLiveCallback(
  c: any,
  rpcId: number | string | null,
  sessionId: string,
  envId: string,
  userId: string,
  chatStreamFn: (callback: AgentCallback) => Promise<{ turnId: string; alreadyRunning: boolean }>,
): Promise<Response> {
  return streamSSE(c, async (stream) => {
    let lastSeq = -1
    let streamClosed = false
    let finalDoneSent = false // DEBUG: 标记 [DONE] 已经发了，之后的 write 都是泄漏
    const POLL_INTERVAL = 500

    stream.onAbort(() => {
      streamClosed = true
    })

    // ── Build liveCallback: real-time SSE push ────────────────
    const liveCallback: AgentCallback = (msg: AgentCallbackMessage, seq?: number) => {
      if (streamClosed || stream.closed || stream.aborted) return

      const acpEvent = CloudbaseAgentService.convertToSessionUpdate(msg, sessionId)
      if (!acpEvent) return

      // Track seq for deduplication against poll loop
      if (seq !== undefined) {
        lastSeq = Math.max(lastSeq, seq)
      }

      if (finalDoneSent) {
        console.warn(
          `[SSE leak] ${sessionId} liveCallback writing AFTER [DONE]: msg.type=${msg.type}, acpEvent.sessionUpdate=${(acpEvent as { sessionUpdate?: string }).sessionUpdate}`,
        )
      }

      // writeSSE returns a Promise — attach .catch() so unhandled rejection doesn't
      // surface as an uncaught error. Actual write failure sets streamClosed=true.
      stream
        .writeSSE({
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId, update: acpEvent },
          }),
        })
        .catch(() => {
          streamClosed = true
        })
    }

    // ── Launch agent with liveCallback ────────────────────────
    const { turnId, alreadyRunning } = await chatStreamFn(liveCallback)

    // ── Replay existing events if agent was already running ──
    // (liveCallback won't fire for already-running agents)
    if (alreadyRunning) {
      try {
        const existingEvents = await persistenceService.getStreamEvents(sessionId, turnId)
        for (const evt of existingEvents) {
          if (evt.seq <= lastSeq) continue
          await stream.writeSSE({
            data: JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId, update: evt.event },
            }),
          })
          lastSeq = Math.max(lastSeq, evt.seq)
        }
      } catch {
        // Replay failure is non-fatal
      }
    }

    // ── Poll loop (safety net for missed events + completion) ─
    //
    // 没有时间硬上限：SSE 寿命 = agent 寿命。
    // 退出原因只有两种：
    //   1. agent 真完成（completeAgent 被调，run.status !== 'running'）+ doneGraceTicks 走完
    //      → agentDone=true，下面正常发 stopReason + [DONE] + 写 task.status
    //   2. 客户端断流 (stream.aborted/closed) → agentDone=false，静默 return，
    //      不发 stopReason、不写 task.status，让前端自动 reconnect 到 /observe/:sessionId
    //
    // 这样设计是因为：以前用 10min cap 强制超时退出会发假的 stopReason='end_turn' +
    // task.status='done'，前端误以为 turn 结束、auto-fix 等 onStreamComplete 副作用乱触发。
    const startTime = Date.now()
    let doneGraceTicks = 0 // After agent completes, wait a few ticks for eventBuffer flush
    const DONE_GRACE_TICKS = 3 // ~1.5s grace period (3 * 500ms)
    let agentDone = false
    // DEBUG: 记录第一次观察到 isDone=true 的时刻 + 当时 run 状态，便于定位"过早完成"
    let firstIsDoneAt: { at: number; status: string | undefined; turnId: string | undefined } | null = null
    while (true) {
      if (stream.closed || stream.aborted) {
        console.log(`[SSE poll] ${sessionId} stream closed/aborted, breaking`)
        break
      }

      const run = getAgentRun(sessionId)
      // run === undefined means the registry was already cleaned up by a previous
      // SSE consumer (after sending [DONE]). Treat immediately as done.
      // run.status !== 'running' means agent completed/errored/cancelled.
      const isDone = !run || run.status !== 'running'

      if (isDone && !firstIsDoneAt) {
        firstIsDoneAt = {
          at: Date.now() - startTime,
          status: run?.status,
          turnId: run?.turnId,
        }
        console.log(
          `[SSE poll] ${sessionId} first isDone=true at +${firstIsDoneAt.at}ms, status=${firstIsDoneAt.status}, turnId=${firstIsDoneAt.turnId}, lastSeq=${lastSeq}`,
        )
      }

      try {
        // Only fetch events after what we've already delivered
        const newEvents = await persistenceService.getStreamEvents(sessionId, turnId, lastSeq)
        for (const evt of newEvents) {
          await stream.writeSSE({
            data: JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId, update: evt.event },
            }),
          })
          lastSeq = Math.max(lastSeq, evt.seq)
        }

        if (isDone) {
          if (newEvents.length === 0) {
            doneGraceTicks++
            if (doneGraceTicks >= DONE_GRACE_TICKS) {
              console.log(
                `[SSE poll] ${sessionId} grace expired (${doneGraceTicks}/${DONE_GRACE_TICKS}), status=${run?.status}, lastSeq=${lastSeq}, breaking`,
              )
              agentDone = true
              break
            }
          } else {
            // Got new events after done — reset grace counter to drain remaining
            if (doneGraceTicks > 0) {
              console.log(
                `[SSE poll] ${sessionId} grace RESET (drained ${newEvents.length} events after done), grace was ${doneGraceTicks}`,
              )
            }
            doneGraceTicks = 0
          }
        }
      } catch (err) {
        if (isDone) {
          doneGraceTicks++
          if (doneGraceTicks >= DONE_GRACE_TICKS) {
            console.log(
              `[SSE poll] ${sessionId} grace expired with poll error (${doneGraceTicks}/${DONE_GRACE_TICKS}), status=${run?.status}`,
              err,
            )
            agentDone = true
            break
          }
        }
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    }

    // 客户端断流 / 网络中断（agent 仍在跑）：静默 return，不发任何最终报文，
    // 不写 task.status。前端 fetchMessages 看到 latestAgent.status 仍 pending →
    // 自动 reconnect 到 /observe/:sessionId 继续接 events。
    if (!agentDone) {
      console.log(
        `[SSE poll] ${sessionId} stream ended without agent completion (client disconnect or stream abort), skipping final stopReason/[DONE]/task.status writes`,
      )
      return
    }

    // ── Send final response + [DONE] ─────────────────────────
    if (rpcId !== null) {
      const run = getAgentRun(sessionId)
      const stopReason = resolveStopReason(run)

      // 如果 agent 出错，先推一条 error 事件让前端知道原因
      if (run?.status === 'error' && run.error) {
        await stream.writeSSE({
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `\n\n⚠️ ${run.error}\n` },
              },
            },
          }),
        })
      }

      await stream.writeSSE({
        data: JSON.stringify(rpcOk(rpcId, { stopReason, meta: { key: 'observeStreamWithLiveCallback', rpcId } })),
      })
    }
    await stream.writeSSE({ data: '[DONE]' })
    finalDoneSent = true
    console.log(
      `[SSE poll] ${sessionId} sent [DONE] with stopReason=${rpcId !== null ? resolveStopReason(getAgentRun(sessionId)) : 'n/a (no rpcId)'}, agent run.status=${getAgentRun(sessionId)?.status ?? 'no-run'}`,
    )

    // Update task status: pending → done (or error).
    // This allows the frontend to exit its "busy" state and show the send button.
    try {
      const finalRun = getAgentRun(sessionId)
      const finalStatus = finalRun?.status === 'error' ? 'error' : 'completed'
      await getDb().tasks.update(sessionId, { status: finalStatus, updatedAt: Date.now() })
    } catch {
      // Non-critical — frontend will eventually poll the task and reconcile
    }

    // Cleanup stream events — only if agent is no longer running.
    // If agent is still running (client disconnected mid-stream),
    // keep events in DB for reconnection via GET /observe/:sessionId.
    const runAfterDone = getAgentRun(sessionId)
    if (!runAfterDone || runAfterDone.status !== 'running') {
      persistenceService.cleanupStreamEvents(sessionId, turnId).catch(() => {
        // Non-critical
      })
      // Registry entry is no longer needed — SSE has sent [DONE] and extracted
      // all state. Remove immediately instead of relying on a 30s timer.
      removeAgent(sessionId, turnId)
    }
  })
}

async function handleSessionCancel(
  c: any,
  id: number | string | null,
  params: Record<string, unknown> | undefined,
  isNotification: boolean,
) {
  const sessionId = params?.sessionId as string

  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!

  if (sessionId) {
    // Abort the running agent process and immediately mark as cancelled in registry
    // (prevents new prompt from observing a dying agent)
    const run = getAgentRun(sessionId)
    if (run && run.status === 'running') {
      run.abortController.abort()
      run.status = 'cancelled'
      run.stopReason = 'cancelled'
    }

    if (envId) {
      // Update DB record status to cancel
      const latestStatus = await persistenceService.getLatestRecordStatus(sessionId, userId, envId)
      if (latestStatus && (latestStatus.status === 'pending' || latestStatus.status === 'streaming')) {
        await persistenceService.updateRecordStatus(latestStatus.recordId, 'cancel')
      }

      // Update task status to stopped so frontend doesn't auto-reconnect
      try {
        await getDb().tasks.update(sessionId, { status: 'stopped', updatedAt: Date.now() })
      } catch {
        // Non-critical
      }
    }
  }

  if (isNotification) {
    return c.text('', 200)
  }

  return c.json(rpcOk(id ?? '', null))
}

// ─── LLM Config Endpoint ───────────────────────────────────────────────────

/**
 * GET /api/agent/config
 *
 * 获取当前 LLM 配置状态
 */
acp.get('/config', (c) => {
  const config = loadConfig()
  return c.json({
    configured: !!(config.llm?.apiKey && config.llm?.endpoint),
    model: config.llm?.model || 'claude-3-5-sonnet-20241022',
  })
})

/**
 * GET /api/agent/runtimes
 *
 * 列出所有已注册的 Agent Runtime 及其默认值。
 * 前端可用此构建 runtime 选择器。
 */
acp.get('/runtimes', async (c) => {
  const runtimes = agentRuntimeRegistry.list()
  const defaultRuntime = agentRuntimeRegistry.resolve()
  const items = await Promise.all(
    runtimes.map(async (r) => {
      const available = await r.isAvailable().catch(() => false)
      const models = available ? await r.getSupportedModels().catch(() => []) : []
      return { name: r.name, available, models }
    }),
  )
  return c.json({
    default: defaultRuntime.name,
    runtimes: items,
  })
})

/**
 * POST /api/agent/internal/ask-user
 *
 * **只给 opencode 子进程的 question custom tool 调**。server 本地回环。
 * 认证：X-Internal-Token header（ASK_USER_TOKEN env，runtime 启动时生成，同 env 注入子进程）
 *
 * 行为：
 *   1. 验证 conversationId 对应的 agent 还活着
 *   2. 通过 runtime.emit 发 ask_user AgentCallbackMessage → SSE 推给前端
 *   3. 注册 PendingQuestion，挂起当前 HTTP response 不返回
 *   4. 当用户答复（下一轮 prompt.askAnswers 到达）触发 resolvePendingQuestion
 *      → 本 handler 的 res.json(answers) 返回给 opencode 子进程
 *
 * Timeout：默认 10 分钟（可由 ASK_USER_TIMEOUT_MS env 覆盖）
 */
acp.post('/internal/ask-user', async (c) => {
  const body = await c.req.json<{
    conversationId: string
    toolCallId: string
    questions: unknown[]
  }>()
  const { conversationId, toolCallId, questions } = body

  if (!conversationId || !toolCallId || !Array.isArray(questions)) {
    return c.json({ error: 'conversationId, toolCallId, questions required' }, 400)
  }

  const run = getAgentRun(conversationId)
  if (!run || run.status !== 'running') {
    return c.json({ error: 'no active agent for conversation' }, 409)
  }

  // emit ask_user 事件 → SSE 推给前端
  try {
    await emitForConversation(conversationId, {
      type: 'ask_user',
      id: toolCallId,
      input: { questions },
    })
  } catch (e) {
    console.error('[internal/ask-user] emit failed:', e)
    return c.json({ error: 'emit failed' }, 500)
  }

  // 挂起：注册一个 pending question，等 runtime.chatStream(askAnswers) 来 resolve
  const timeoutMs = Number(process.env.ASK_USER_TIMEOUT_MS || 10 * 60 * 1000)
  return await new Promise<Response>((resolve) => {
    const timer = setTimeout(() => {
      resolve(c.json({ error: 'timeout waiting for user answer' }, 408))
    }, timeoutMs)

    registerPendingQuestion({
      conversationId,
      toolCallId,
      questions,
      createdAt: Date.now(),
      resolve: (answers) => {
        clearTimeout(timer)
        resolve(c.json({ ok: true, answers }))
      },
      reject: (reason) => {
        clearTimeout(timer)
        resolve(c.json({ error: reason }, 500))
      },
    })
  })
})

export default acp
