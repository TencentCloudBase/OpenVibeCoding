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
  /**
   * OpenCode/models.dev 对齐的可选富字段。来自 models.dev catalog 合并结果，
   * 前端可用于展示上下文长度、能力标记、成本等。CodeBuddy runtime 暂不填充。
   */
  contextLimit?: number
  outputLimit?: number
  inputModalities?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>
  outputModalities?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>
  toolCall?: boolean
  reasoning?: boolean
  attachment?: boolean
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  status?: 'alpha' | 'beta' | 'deprecated'
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
 * 工具权限决策动作
 *
 * - `allow`: 仅允许本次工具调用
 * - `allow_always`: 允许本次，并在当前会话中后续同名工具调用不再询问
 * - `deny`: 拒绝本次工具调用
 * - `reject_and_exit_plan`: 拒绝并退出 Plan 模式（P2 使用：附带切换 permissionMode）
 */
export type PermissionAction = 'allow' | 'allow_always' | 'deny' | 'reject_and_exit_plan'

/**
 * Plan 模式开关
 *
 * - `plan`: 进入计划模式 —— 模型仅规划、不执行写工具；通过 ExitPlanMode 工具呈交计划
 * - `default`: 普通模式 —— 与当前行为一致
 *
 * 与 Claude Agent SDK `PermissionMode` 子集保持对齐，避免引入更多（如 acceptEdits/bypass）造成安全风险。
 */
export type AgentPermissionMode = 'default' | 'plan'

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
    payload: { action: PermissionAction }
  }
  /**
   * Plan 模式开关（P2 新增）
   *
   * 用于在 resume 场景下切换会话级 Plan 模式:
   * - 当 `toolConfirmation.payload.action === 'reject_and_exit_plan'` 时前端应传 `permissionMode: 'default'`
   *   以通知服务端退出计划模式
   * - 用户主动开启 Plan 模式时传 `permissionMode: 'plan'`
   */
  permissionMode?: AgentPermissionMode
  /**
   * Agent runtime 选择（多 runtime 抽象层新增）
   *
   * 取值由 server 注册的 runtime 名决定，目前内置：
   *   - `tencent-sdk` (默认): 基于 patch 过的 @tencent-ai/agent-sdk
   *   - `opencode-acp`: spawn `opencode acp` 子进程，走 ACP NDJSON
   *
   * 不传 → server 按 `agentRuntimeRegistry.resolve()` 默认策略选取
   * （AGENT_RUNTIME env 或 tencent-sdk）
   */
  runtime?: string
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
  /** P7: 父 Task 的 toolCallId，非空表示此调用由子代理（Task 工具）产生 */
  parentToolCallId?: string
}

export interface ToolCallStatusUpdate {
  sessionUpdate: 'tool_call_update'
  toolCallId: string
  status: 'in_progress' | 'completed' | 'failed'
  result?: unknown
  input?: unknown
  error?: { message: string }
  /** P7: 父 Task 的 toolCallId（冗余字段，前端优先从 tool_call part 继承） */
  parentToolCallId?: string
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
    | 'tool_input_update'
    | 'tool_result'
    | 'result'
    | 'error'
    | 'session'
    | 'tool_confirm'
    | 'ask_user'
    | 'artifact'
    | 'agent_phase'
  content?: string
  name?: string
  input?: unknown
  /** tool_call id 或 assistant message id (取决于消息类型) */
  id?: string
  tool_use_id?: string
  is_error?: boolean
  /**
   * P7 Subagent: 来自 Claude SDK 顶层 message 的 `parent_tool_use_id`。
   * 非空表示此消息由某个 Task 子代理产生，前端据此构建嵌套卡片。
   */
  parent_tool_use_id?: string | null
  sessionId?: string
  /** assistant 消息的 DB record id */
  assistantMessageId?: string
  /** ask_user 问题的答案（resume 场景） */
  answers?: Record<string, string>
  /** tool_confirm 的确认动作 */
  action?: PermissionAction
  /** agent_phase: 代理执行阶段(P4) */
  phase?: 'preparing' | 'model_responding' | 'tool_executing' | 'compacting' | 'idle'
  /** agent_phase: 对应工具名(仅 phase='tool_executing' 时传) */
  phaseToolName?: string
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
export type AgentCallback = (message: AgentCallbackMessage, seq?: number) => void | Promise<void>

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
    payload: { action: PermissionAction; result?: string }
  }
  /** 指定模型 */
  model?: string
  /** 任务模式 */
  mode?: 'default' | 'coding'
  /**
   * Plan 模式开关
   *
   * - `plan`: 进入计划模式，agent 仅规划、不执行写操作（通过 `ExitPlanMode` 呈交计划给用户）
   * - `default` | undefined: 普通模式（沿用原行为）
   */
  permissionMode?: AgentPermissionMode
  /** 图片附件（多模态输入），转换后传给 SDK query() 的 ContentBlock[] */
  imageBlocks?: AcpImageBlock[]
}
