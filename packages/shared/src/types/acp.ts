// ACP Protocol Types - extended session updates for task notifications
// Base ACP types are in ./agent.ts (from Nex)

import type {
  SessionUpdate as BaseSessionUpdate,
  AgentMessageChunkUpdate,
  ToolCallUpdate,
  ToolCallStatusUpdate,
  AvailableCommandsUpdate,
  RefMeta,
} from './agent'

// Re-export RefMeta for convenience
export type { RefMeta }

// Extended session update types for task/logging notifications
export interface LogUpdate {
  sessionUpdate: 'log'
  level: 'info' | 'error' | 'success' | 'command'
  message: string
  timestamp: number
}

/**
 * 任务进度上报（非标准扩展，与 log/agent_phase 同类）。
 *
 * 注意：进度百分比（progress）与 agent_thought_chunk（thinking 文本）语义不同，
 */
export interface TaskProgressUpdate {
  sessionUpdate: 'task_progress'
  progress: number
  status: 'pending' | 'processing' | 'completed' | 'error' | 'stopped'
}

/** ACP 1.0.0 standard — replaces ToolConfirmUpdate */
export interface RequestPermissionUpdate {
  sessionUpdate: 'request_permission'
  sessionId: string
  toolCall: {
    toolCallId: string
    title?: string | null
    kind?: string
    rawInput?: unknown
  }
  options: Array<{
    optionId: string
    name?: string
    kind: string
  }>
  _meta?: RefMeta
}

/** ACP 1.0.0 standard — token usage update */
export interface UsageUpdate {
  sessionUpdate: 'usage_update'
  used: number
  size: number
}

export interface ArtifactUpdate {
  sessionUpdate: 'artifact'
  artifact: {
    title: string
    description?: string
    contentType: 'image' | 'link' | 'json'
    data: string
    metadata?: Record<string, unknown>
  }
}

export type HistoryMessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'tool_call'
      toolCallId: string
      toolName: string
      input?: unknown
      status?: string
      parentToolCallId?: string
    }
  | {
      type: 'tool_result'
      toolCallId: string
      toolName?: string
      content: string
      isError?: boolean
      status?: string
      parentToolCallId?: string
    }

export interface HistoryMessage {
  id: string
  taskId: string
  role: 'user' | 'agent'
  content: string
  parts?: HistoryMessagePart[]
  status?: string
  createdAt: number
}

/**
 * session/load replay 的历史分页扩展事件。
 *
 * ACP 标准建议通过 session/update replay 历史；本项目以一页 messages 的形式承载，
 * 方便复用现有 TaskChat 渲染模型，并支持 cursor 分页。
 */
export interface HistoryPageUpdate {
  sessionUpdate: 'history_page'
  messages: HistoryMessage[]
  cursor?: string | null
  nextCursor?: string | null
}

/**
 * Agent 执行阶段上报（P4）。
 *
 * 用于让客户端感知"代理当前在做什么",例如:
 *   - 模型推理中 → 展示"模型响应中..."
 *   - 工具执行中 → 展示"执行 Bash ..."
 *   - 上下文压缩 → 展示"正在压缩历史..."
 *
 * 约定:
 *   - 服务端在每次边界触发一次(循环开始、assistant→tool_use、user tool_result 回流、result 结束)
 *   - 事件是**增量**:只描述"刚进入的阶段",不携带历史
 *   - 非里程碑事件:可与其它事件合并批量下发(不强制立即 flush)
 */
export type AgentPhaseName =
  /** 准备阶段:沙箱启动/健康检查/历史恢复 */
  | 'preparing'
  /** 模型推理中,等待 LLM 输出 */
  | 'model_responding'
  /** 工具正在执行(本地 tool 或 MCP 远程调用) */
  | 'tool_executing'
  /** 长上下文压缩中(SDK 自动触发 compact) */
  | 'compacting'
  /** 空闲,没有实质进行中的操作 */
  | 'idle'

export interface AgentPhaseUpdate {
  sessionUpdate: 'agent_phase'
  phase: AgentPhaseName
  /** 可选:工具名(仅 phase='tool_executing' 时传) */
  toolName?: string
  /** 时间戳(ms),用于前端判断陈旧事件 */
  timestamp: number
}

// Extended SessionUpdate type (base + custom)
export type ExtendedSessionUpdate =
  | BaseSessionUpdate
  | LogUpdate
  | TaskProgressUpdate
  | RequestPermissionUpdate
  | ArtifactUpdate
  | HistoryPageUpdate
  | AgentPhaseUpdate
  | UsageUpdate

// Re-export base types for convenience
export type {
  BaseSessionUpdate,
  AgentMessageChunkUpdate,
  ToolCallUpdate,
  ToolCallStatusUpdate,
  AvailableCommandsUpdate,
}

// Re-export permission action type for frontend single-point import
export type { PermissionAction, AgentPermissionMode } from './agent'

// ─── Stream Event Persistence Types ──────────────────────────────────

export type AgentRunStatus = 'running' | 'completed' | 'error' | 'cancelled'

/**
 * JSON-RPC NOTIFICATION — session/update wrapped in full envelope.
 *
 * All non-REQUEST stream messages carry this shape on the wire:
 * ``{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{...}}}``
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params: Record<string, unknown>
}

/**
 * JSON-RPC REQUEST — agent asks the client to do something.
 *
 * id = `${sessionId}:${toolCallId}` (deterministic, no collision risk).
 * Sent as a complete SSE data line (not wrapped in session/update).
 */
export interface JsonRpcRequestPayload {
  jsonrpc: '2.0'
  id: string
  method: string
  params: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/**
 * Canonical on-wire message: either a notification or a request.
 * Both carry the full JSON-RPC envelope.
 *
 * ExtendedSessionUpdate (bare payload) is the old format.
 * Use {@link normalizeStreamEvent} to upgrade old data on read.
 */
export type AcpWireMessage = JsonRpcNotification | JsonRpcRequestPayload

/**
 * Normalize a stream event to the canonical {@link AcpWireMessage} format.
 *
 * Old data stored as bare {@link ExtendedSessionUpdate} (no JSON-RPC envelope)
 * is upgraded by wrapping in a ``session/update`` notification. New data
 * (already an envelope) passes through unchanged.
 */
export function normalizeStreamEvent(event: unknown, sessionId: string): AcpWireMessage {
  const e = event as Record<string, unknown> | null | undefined
  if (!e) {
    return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {} } }
  }
  // Already a JSON-RPC envelope (notification or request)
  if (e.jsonrpc === '2.0' && typeof e.method === 'string') {
    if ('id' in e) {
      return event as JsonRpcRequestPayload
    }
    return event as JsonRpcNotification
  }
  // Old format: bare ExtendedSessionUpdate → wrap in session/update notification
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: event },
  }
}

export interface StreamEvent {
  eventId: string
  conversationId: string
  turnId: string
  envId: string
  userId: string
  /** Canonical on-wire message (JSON-RPC envelope). Old bare payloads are normalized on read via {@link normalizeStreamEvent}. */
  event: AcpWireMessage
  seq: number
  createTime: number
}
