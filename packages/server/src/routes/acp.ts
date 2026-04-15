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
} from '@coder/shared'
import { cloudbaseAgentService, getSupportedModels } from '../agent/cloudbase-agent.service.js'
import { persistenceService } from '../agent/persistence.service.js'
import { getAgentRun } from '../agent/agent-registry.js'
import { loadConfig } from '../config/store.js'
import { getDb } from '../db/index.js'
import { nanoid } from 'nanoid'
import { requireUserEnv, type AppEnv } from '../middleware/auth.js'

const acp = new Hono<AppEnv>()

// 除 /health 外，所有 ACP 路由都需要登录 + 用户环境校验
acp.use('/*', async (c, next) => {
  if (c.req.path.endsWith('/health') || c.req.path.endsWith('/config')) {
    return next()
  }
  // If using API key auth, verify it has 'acp' scope
  const scopes = c.get('apiKeyScopes')
  if (scopes !== undefined && !scopes.includes('acp')) {
    return c.json({ error: 'API key does not have ACP scope' }, 403)
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
  const body = await c.req.json<{ prompt: string; conversationId?: string; model?: string; mode?: string }>()
  const { prompt, conversationId, model, mode } = body

  const { envId, userId, credentials: userCredentials } = c.get('userEnv')!
  if (!envId) {
    return c.json({ error: 'CloudBase environment not bound' }, 400)
  }

  const actualConversationId = conversationId || uuidv4()

  // Resolve mode: from request body, or from existing task record
  let taskMode = mode as 'default' | 'coding' | undefined
  if (!taskMode && conversationId) {
    try {
      const task = await getDb().tasks.findById(conversationId)
      if (task?.mode === 'coding') taskMode = 'coding'
    } catch {
      // ignore
    }
  }

  const { turnId } = await cloudbaseAgentService.chatStream(prompt, null, {
    conversationId: actualConversationId,
    envId,
    userId,
    userCredentials,
    model,
    mode: taskMode,
  })

  return observeStream(c, null, actualConversationId, turnId, envId, userId)
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
        image: false,
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

  // Extract prompt text
  const prompt: string = (params?.prompt ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')

  const hasResumePayload =
    (params?.askAnswers && Object.keys(params.askAnswers).length > 0) || !!params?.toolConfirmation

  if (!prompt.trim() && !hasResumePayload) {
    return c.json(rpcErr(id, JSON_RPC_ERRORS.INVALID_PARAMS, 'prompt must contain at least one text block'))
  }

  const effectivePrompt = prompt.trim() ? prompt : hasResumePayload ? '继续未完成的任务' : prompt

  // Read task's selectedModel
  let selectedModel: string | undefined
  try {
    const task = await getDb().tasks.findById(sessionId)
    selectedModel = task?.selectedModel || undefined
  } catch {
    // read failure doesn't affect main flow
  }

  // Update task status to pending
  try {
    await getDb().tasks.update(sessionId, { status: 'pending', updatedAt: Date.now() })
  } catch {
    // write failure doesn't affect main flow
  }

  // Resolve task mode
  let taskMode: 'default' | 'coding' | undefined
  try {
    const task = await getDb().tasks.findById(sessionId)
    if (task?.mode === 'coding') taskMode = 'coding'
  } catch {
    // ignore
  }

  // Launch agent in background and observe via SSE
  const { turnId } = await cloudbaseAgentService.chatStream(effectivePrompt, null, {
    conversationId: sessionId,
    envId,
    userId,
    userCredentials,
    model: selectedModel,
    askAnswers: params.askAnswers,
    toolConfirmation: params.toolConfirmation,
    mode: taskMode,
  })

  return observeStream(c, id, sessionId, turnId, envId, userId)
}

// ─── Observe Stream (SSE replay + poll) ──────────────────────────────────────

/**
 * GET /api/agent/observe/:sessionId
 *
 * SSE endpoint: replay existing ACP events + poll for new events until turn completes
 */
acp.get('/observe/:sessionId', requireUserEnv, async (c) => {
  const sessionId = c.req.param('sessionId')
  const { envId, userId } = c.get('userEnv')!

  if (!envId) {
    return c.json({ error: 'CloudBase environment not bound' }, 400)
  }

  let turnId = c.req.query('turnId') || undefined
  if (!turnId) {
    const latest = await persistenceService.getLatestRecordStatus(sessionId, userId, envId)
    if (!latest || (latest.status !== 'pending' && latest.status !== 'streaming')) {
      return c.json({ error: 'No active turn to observe' }, 404)
    }
    turnId = latest.recordId
  }

  return observeStream(c, null, sessionId, turnId, envId, userId)
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
    const MAX_POLL_DURATION = 10 * 60 * 1000

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

    // 2. Poll loop
    const startTime = Date.now()
    while (Date.now() - startTime < MAX_POLL_DURATION) {
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

        if (isDone && newEvents.length === 0) break
      } catch {
        if (isDone) break
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    }

    // 3. Send final response + [DONE]
    if (rpcId !== null) {
      const run = getAgentRun(sessionId)
      const stopReason = run?.status === 'error' ? 'error' : 'end_turn'
      await stream.writeSSE({ data: JSON.stringify(rpcOk(rpcId, { stopReason })) })
    }
    await stream.writeSSE({ data: '[DONE]' })

    // 4. Cleanup stream events — messages are already persisted to DB,
    //    stream events are only needed for SSE replay and can be safely removed.
    persistenceService.cleanupStreamEvents(sessionId, turnId).catch(() => {
      // Non-critical
    })
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

  if (sessionId && envId) {
    // 获取最新消息并更新状态为 cancel
    const latestStatus = await persistenceService.getLatestRecordStatus(sessionId, userId, envId)
    if (latestStatus && (latestStatus.status === 'pending' || latestStatus.status === 'streaming')) {
      await persistenceService.updateRecordStatus(latestStatus.recordId, 'cancel')
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

export default acp
