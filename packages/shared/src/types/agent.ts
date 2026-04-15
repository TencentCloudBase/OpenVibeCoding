// ─── ACP JSON-RPC 2.0 Protocol Types ─────────────────────────────────────

/**
 * ACP 协议版本
 */
export const ACP_PROTOCOL_VERSION = 1

/**
 * Agent 能力信息
 */
export interface AgentInfo {
  name: string
  title: string
  description: string
  version: string
  capabilities: string[]
}

/**
 * Nex Agent 信息
 */
export const NEX_AGENT_INFO: AgentInfo = {
  name: 'nex-agent',
  title: 'Nex AI 助手',
  description: 'AI 驱动的轻应用工厂助手，帮助用户创建、管理轻应用和数据。',
  version: '1.0.0',
  capabilities: ['Data Management', 'App Creation', 'Database Operations'],
}

/**
 * Agent 能力配置
 */
export interface AgentCapabilities {
  loadSession: boolean
  promptCapabilities: {
    image: boolean
    audio: boolean
    embeddedContext: boolean
  }
}

/**
 * JSON-RPC 2.0 请求
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

/**
 * JSON-RPC 2.0 成功响应
 */
export interface JsonRpcResult<T = unknown> {
  jsonrpc: '2.0'
  id: number | string
  result: T
}

/**
 * JSON-RPC 2.0 错误响应
 */
export interface JsonRpcError {
  jsonrpc: '2.0'
  id: number | string | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcResponse<T = unknown> = JsonRpcResult<T> | JsonRpcError

/**
 * JSON-RPC 标准错误码
 */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const

// ─── ACP Protocol Methods ────────────────────────────────────────────────

/**
 * initialize 方法响应
 */
export interface ModelInfo {
  id: string
  name: string
  vendor?: string
  credits?: string
  supportsImages?: boolean
  supportsReasoning?: boolean
  supportsToolCall?: boolean
  tags?: string[]
  [key: string]: unknown
}

export interface InitializeResult {
  protocolVersion: number
  agentCapabilities: AgentCapabilities
  agentInfo: AgentInfo
  authMethods: string[]
  supportedModels?: ModelInfo[]
}

/**
 * session/new 方法参数
 */
export interface SessionNewParams {
  conversationId?: string
}

/**
 * session/new 方法响应
 */
export interface SessionNewResult {
  sessionId: string
  hasHistory: boolean
}

/**
 * session/load 方法参数
 */
export interface SessionLoadParams {
  sessionId: string
}

/**
 * session/load 方法响应
 */
export interface SessionLoadResult {
  sessionId: string
}

/**
 * ACP ContentBlock 类型
 */
export interface AcpTextBlock {
  type: 'text'
  text: string
}

export interface AcpImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

export type AcpContentBlock = AcpTextBlock | AcpImageBlock

/**
 * session/prompt 方法参数
 */
export interface SessionPromptParams {
  sessionId: string
  prompt: AcpContentBlock[]
  /** AskUserQuestion 的用户回答 { [assistantMessageId]: { toolCallId, answers: { [header]: value } } } */
  askAnswers?: Record<string, { toolCallId: string; answers: Record<string, string> }>
  /** 工具确认结果 */
  toolConfirmation?: {
    interruptId: string
    payload: { action: 'allow' | 'deny' }
  }
}

/**
 * session/prompt 方法响应
 */
export interface SessionPromptResult {
  stopReason: 'end_turn' | 'cancelled' | 'error'
  quota?: {
    used: number
    limit: number
    remaining: number
  }
}

/**
 * session/cancel 方法参数
 */
export interface SessionCancelParams {
  sessionId: string
}

// ─── Session Update Notifications ────────────────────────────────────────

/**
 * session/update 通知参数
 */
export interface SessionUpdateParams {
  sessionId: string
  update: SessionUpdate
}

/**
 * Session update 类型
 */
export type SessionUpdate =
  | AgentMessageChunkUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | AvailableCommandsUpdate
  | AgentToughtChunkUpdate

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk'
  content: AcpTextBlock
}

interface AgentToughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk'
  content: string
}

export interface ToolCallUpdate {
  sessionUpdate: 'tool_call'
  toolCallId: string
  title: string
  kind: 'function' | 'other'
  status: 'in_progress' | 'completed' | 'failed'
  input?: unknown
}

export interface ToolCallStatusUpdate {
  sessionUpdate: 'tool_call_update'
  toolCallId: string
  status: 'in_progress' | 'completed' | 'failed'
  result?: unknown
  error?: { message: string }
}

export interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update'
  availableCommands: Array<{
    name: string
    description: string
    _meta?: Record<string, unknown>
  }>
}

// ─── Conversation & Message Types ────────────────────────────────────────

/**
 * 会话信息
 */
export interface Conversation {
  conversationId: string
  title?: string
  createTime: number
  updateTime: number
}

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant'

/**
 * 消息内容块类型
 */
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'raw'

/**
 * 消息内容块
 */
export interface MessageContentBlock {
  contentType: ContentBlockType
  content: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
  metadata?: Record<string, unknown>
}

/**
 * 消息记录
 */
export interface MessageRecord {
  recordId: string
  conversationId: string
  role: MessageRole
  parts: MessageContentBlock[]
  createTime: number
}

/**
 * 消息查询结果
 */
export interface MessageQueryResult {
  total: number
  data: MessageRecord[]
}

// ─── CodeBuddy Message Types (Agent SDK) ───────────────────────────────────

/**
 * Agent ID 常量
 */
export const AGENT_ID = 'nex-agent'

/**
 * CodeBuddy 内容块
 */
export interface CodeBuddyContentBlock {
  type: 'input_text' | 'output_text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
}

/**
 * CodeBuddy 消息格式 (Agent SDK 内部格式)
 */
export interface CodeBuddyMessage {
  id: string
  timestamp: number
  type: 'message' | 'file-history-snapshot' | 'function_call' | 'function_call_result' | 'reasoning'
  role?: 'user' | 'assistant'
  content?: CodeBuddyContentBlock[]
  /** reasoning 消息的原始内容 */
  rawContent?: Array<{ type: string; text?: string; [key: string]: unknown }>
  sessionId: string
  cwd?: string
  parentId?: string
  providerData?: {
    agent?: string
    skipRun?: boolean
    error?: unknown
    [key: string]: unknown
  }
  status?: string
  isSnapshotUpdate?: boolean
  snapshot?: FileHistorySnapshot
  /** function_call fields */
  callId?: string
  name?: string
  arguments?: string
  /** function_call_result fields */
  output?: string | Record<string, unknown>
}

/**
 * 文件历史快照
 */
export interface FileHistorySnapshot {
  messageId: string
  trackedFileBackups: Record<
    string,
    {
      backupFileName?: string
      version: number
      backupTime: number
    }
  >
}

// ─── Unified Message Types (Database) ──────────────────────────────────────

/**
 * 统一消息记录格式 (数据库存储)
 */
export interface UnifiedMessageRecord {
  recordId: string
  conversationId: string
  replyTo?: string
  role: 'user' | 'assistant'
  status: 'pending' | 'streaming' | 'done' | 'error' | 'cancel'
  envId: string
  userId: string
  agentId?: string
  content?: string
  parts: UnifiedMessagePart[]
  createTime: number
}

/**
 * 统一消息部分格式
 */
export interface UnifiedMessagePart {
  partId: string
  messageId?: string
  contentType: string
  content?: string
  toolCallId?: string
  metadata?: Record<string, unknown>
}

/**
 * Agent 回调消息类型
 */
export interface AgentCallbackMessage {
  type:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'result'
    | 'error'
    | 'session'
    | 'tool_confirm'
    | 'ask_user'
    | 'artifact'
  content?: string
  name?: string
  input?: unknown
  /** tool_call id 或 assistant message id (取决于消息类型) */
  id?: string
  tool_use_id?: string
  is_error?: boolean
  sessionId?: string
  /** assistant 消息的 DB record id */
  assistantMessageId?: string
  /** ask_user 问题的答案（resume 场景） */
  answers?: Record<string, string>
  /** tool_confirm 的确认动作 */
  action?: 'allow' | 'deny'
  /** artifact: 结构化产物（部署 URL、小程序二维码、上传结果等） */
  artifact?: {
    title: string
    description?: string
    contentType: 'image' | 'link' | 'json'
    data: string
    metadata?: Record<string, unknown>
  }
}

/**
 * Agent 回调类型
 */
export type AgentCallback = (message: AgentCallbackMessage) => void | Promise<void>

/**
 * Agent 选项
 */
export interface AgentOptions {
  conversationId?: string
  envId?: string
  userId?: string
  /** 登录用户的 CloudBase 凭证（临时密钥或分配密钥） */
  userCredentials?: {
    secretId: string
    secretKey: string
    sessionToken?: string
  }
  maxTurns?: number
  cwd?: string
  /** AskUserQuestion 的用户回答（resume 场景）{ [recordId]: { toolCallId, answers: { [q]: a } } } */
  askAnswers?: Record<string, { toolCallId: string; answers: Record<string, string> }>
  /** 跳过写操作确认（默认 false，需确认） */
  bypassToolConfirmation?: boolean
  /** resume 时传入的工具确认结果 */
  toolConfirmation?: {
    interruptId: string
    payload: { action: 'allow' | 'deny'; result?: string }
  }
  /** 指定模型 */
  model?: string
  /** 任务模式 */
  mode?: 'default' | 'coding'
}
