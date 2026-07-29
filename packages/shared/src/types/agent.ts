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
  /**
   * ACP `session/list` 能力（spec: agentCapabilities.sessionCapabilities.list）。
   * 客户端在调用 session/list 前应检查此字段。
   */
  sessionCapabilities?: {
    list?: boolean
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
 *
 * 兼容 ACP spec 的 `conversationId`（可选）；`meta` 是扩展字段，
 * 用于在创建会话时附带"会话级配置"（runtime、model、mode 等）。
 * 服务端只接受白名单字段，未知字段会被忽略。
 *
 * 调用方约定：
 * - 第一次创建：可传 meta 指定配置；服务端会在 DB 写一条轻量 task 记录
 * - 已存在会话：服务端忽略 meta，幂等复用（要改配置请用别的方法）
 */
export interface SessionNewParams {
  conversationId?: string
  meta?: SessionNewMeta
}

/**
 * session/new meta 字段：可选的会话级配置。
 * 全部字段都是可选；server 会用默认值填充。
 */
export interface SessionNewMeta {
  /** 显示标题；不填则为 null，UI 自动从 prompt 截断衍生 */
  title?: string
  /** Agent 类型，如 'claude' / 'codex'；默认 'claude' */
  selectedAgent?: string
  /** 具体模型，如 'claude-sonnet-4-5'；不填走 server 默认 */
  selectedModel?: string
  /** Runtime，如 'opencode-acp'；不填走 AGENT_RUNTIME env 或注册表默认 */
  selectedRuntime?: string
  /** 'default' | 'coding'；默认 'default' */
  mode?: 'default' | 'coding'
  /** 仓库 URL（如果会话关联代码仓库） */
  repoUrl?: string
  installDependencies?: boolean
  maxDuration?: number
  keepAlive?: boolean
  enableBrowser?: boolean
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
  /**
   * true 时服务端通过 SSE replay 一页历史消息；false/省略时仅校验并加载会话。
   */
  replay?: boolean
  /** 分页游标；当前实现为 offset 字符串。 */
  cursor?: string
  /** 每页条数，默认 50，最大 100。 */
  limit?: number
  /** 历史查询排序。DESC 表示取最新一页，返回前会转为正序便于 UI 渲染。 */
  sort?: 'ASC' | 'DESC'
}

/**
 * session/load 方法响应
 */
export interface SessionLoadResult {
  sessionId: string
  /** replay=true 时 final result 会带下一页游标；非 replay 时为空 */
  nextCursor?: string | null
}

/**
 * session/list 方法参数
 *
 * 遵循 ACP spec: https://agentclientprotocol.com/protocol/session-list
 * 本实现暂不支持 cwd 过滤（项目内 task 无工作目录概念）。
 */
export interface SessionListParams {
  /** 不透明分页游标。当前实现一次性返回全部，cursor 字段保留为占位。 */
  cursor?: string
  /** 排序键，默认 'createdAt'。当前后端只按 createdAt desc 排序。 */
  orderBy?: 'createdAt' | 'updatedAt'
  /** 工作目录过滤（ACP spec），本实现忽略。 */
  cwd?: string
}

/**
 * session/list 中单条 session 描述。
 */
export interface SessionInfo {
  sessionId: string
  /** 显示标题；后端 fallback 到 prompt 截断 */
  title?: string
  /** spec 字段：最近更新时间戳（毫秒） */
  updatedAt?: number
  /** spec 允许的扩展元数据：本实现塞 status */
  _meta?: {
    status?: string
    createdAt?: number
  }
}

/**
 * session/list 方法响应
 */
export interface SessionListResult {
  sessions: SessionInfo[]
  /** 下一页游标，当前实现始终为 null（一次性返回） */
  nextCursor?: string | null
}

/**
 * session/delete 方法参数（ACP spec 扩展）
 *
 * spec 没有定义 delete 方法，但允许扩展；该方法删除指定 session 及其所有持久化消息。
 */
export interface SessionDeleteParams {
  sessionId: string
}

/**
 * session/delete 方法响应
 */
export interface SessionDeleteResult {
  sessionId: string
  /** true 表示该 sessionId 之前确实存在；false 表示幂等下未做任何事 */
  deleted: boolean
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
 * `_meta.ref.*` 扩展命名空间。
 *
 * ACP 标准保留 `_meta` 用于扩展；本项目非标准字段（关联到其它实体的渲染线索）
 * 统一放在 `_meta.ref.*` 下。`ref` = reference，语义：这些字段是给客户端渲染
 * 用的"引用/关联"信息（assistantMessageId 关联消息、parentToolCallId 关联父工具、
 * planContent 渲染计划），不绑定具体品牌（非 OAK 的 oak / 非 vibe）。
 */
export interface RefMeta {
  ref?: {
    /** 父 Task 的 toolCallId（子代理产生的工具链） */
    parentToolCallId?: string
    /** 服务端内部 assistantMessageId（SSE 关联用） */
    assistantMessageId?: string
    /** ExitPlanMode 计划内容（Markdown），仅 ExitPlanMode 工具携带 */
    planContent?: string
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

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
  /** 客户端工具执行结果（取代 askAnswers） */
  clientToolResult?: { toolCallId: string; content: unknown; isError?: boolean }
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
  | AgentThoughtChunkUpdate

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk'
  content: AcpTextBlock
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk'
  content: AcpTextBlock
}

export interface ToolCallUpdate {
  sessionUpdate: 'tool_call'
  toolCallId: string
  title: string
  kind: string
  status: 'in_progress' | 'completed' | 'failed'
  rawInput?: unknown
  /** @deprecated use rawInput */
  input?: unknown
  /** P7: 父 Task 的 toolCallId，非空表示此调用由子代理（Task 工具）产生 */
  parentToolCallId?: string
  /** ACP 1.0.0 扩展字段：assistantMessageId/parentToolCallId 等放在 _meta.ref.* */
  _meta?: RefMeta
}

export interface ToolCallStatusUpdate {
  sessionUpdate: 'tool_call_update'
  toolCallId: string
  status: 'in_progress' | 'completed' | 'failed'
  rawOutput?: unknown
  rawInput?: unknown
  content?: unknown[]
  /** @deprecated use rawOutput */
  result?: unknown
  /** @deprecated use rawInput */
  input?: unknown
  /** @deprecated use content */
  error?: { message: string }
  /** P7: 父 Task 的 toolCallId（冗余字段，前端优先从 tool_call part 继承） */
  parentToolCallId?: string
  /** ACP 1.0.0 扩展字段：parentToolCallId 等放在 _meta.ref.* */
  _meta?: RefMeta
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
  /**
   * 显式指定本轮的 turnId（assistantRecordId）。
   *
   * 用于 RESPONSE 恢复场景：路由层已写 tool_result 到特定 record，
   * 传此字段让 runtime 继承同一个 recordId，避免生成新 turnId 导致
   * restoreMessages 看不到刚写入的 tool_result。
   */
  turnId?: string
  /**
   * 客户端工具执行结果（RESPONSE 恢复场景）。
   *
   * 路由层收到 client/<ToolName> 的 JSON-RPC RESPONSE 后，
   * 不直接写 DB，而是传给 runtime，由 runtime 在 resume 流程中
   * 统一写 tool_result + finalize record。
   */
  clientToolResult?: {
    toolCallId: string
    content: unknown
    isError?: boolean
  }
}
