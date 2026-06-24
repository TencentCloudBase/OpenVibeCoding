import type { Task } from '@coder/shared'
import type { ChatStreamReturn } from '../hooks/use-chat-stream'

// ─── Message Types ────────────────────────────────────────────────────

export interface TaskMessage {
  id: string
  taskId: string
  role: 'user' | 'agent'
  content: string
  createdAt: number
  parts?: MessagePart[]
  /** Record-level status: 'done' | 'pending' | 'streaming' | 'error' | 'cancel' */
  status?: string
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'tool_call'
      toolCallId: string
      toolName: string
      input?: unknown
      assistantMessageId?: string
      status?: string
      /** P7: 父 Task 的 toolCallId，非空表示此调用由子代理（Task）产生，渲染时应嵌套到 SubagentCard 内 */
      parentToolCallId?: string
    }
  | {
      type: 'tool_result'
      toolCallId: string
      toolName?: string
      content: string
      isError?: boolean
      /** 'incomplete' when tool was interrupted (e.g. AskUserQuestion waiting for user answer) */
      status?: string
      /** P7: 从同 toolCallId 的 tool_call part 继承 */
      parentToolCallId?: string
    }

// ─── Interaction Types ────────────────────────────────────────────────

export interface AskUserQuestionData {
  toolCallId: string
  assistantMessageId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}

export interface ToolConfirmData {
  toolCallId: string
  assistantMessageId: string
  toolName: string
  input: Record<string, unknown>
  /**
   * ExitPlanMode 工具专用：模型呈交的计划内容（Markdown）。
   * 普通写工具该字段为空。用于驱动 PlanModeCard 分支渲染。
   */
  planContent?: string
}

// ─── Component Props ──────────────────────────────────────────────────

export interface TaskChatProps {
  taskId: string
  task: Task
  /** 当 ACP 对话轮次完成时（stream DONE）通知父组件刷新 task */
  onStreamComplete?: () => void
  /** 由父组件提供的 chat stream 状态（提升到 TaskDetails 以避免 remount 丢失） */
  chatStream?: ChatStreamReturn
  /** 只读模式：隐藏输入框、禁止流式交互，仅展示消息 */
  readOnly?: boolean
  /** 消息 API 基础路径，默认 ''。管理员查看时设为 '/api/admin' */
  messagesApiBase?: string
  /** 历史消息加载方式：web 默认走 /api/tasks/:id/messages；playground 可走 ACP session/load replay */
  historyMode?: 'task-api' | 'acp'
  /**
   * 用户手动点"发送"时触发（不包括自动修复之类的编程化发送）。
   * 由父层 TaskDetails 用来重置 useAutoFix 的自动修复计数。
   */
  onManualUserSend?: () => void
  /** Skills 列表，用于 "/" 前缀命令补全 */
  skillsList?: Array<{ name: string; description: string }>
}

// ─── Tab Data Types ───────────────────────────────────────────────────

export interface PRComment {
  id: number
  user: {
    login: string
    avatar_url: string
  }
  body: string
  created_at: string
  html_url: string
}

export interface CheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string
  started_at: string
  completed_at: string | null
}

export interface DeploymentInfo {
  id: string
  taskId: string
  type: 'web' | 'miniprogram'
  url: string | null
  path: string | null
  qrCodeUrl: string | null
  pagePath: string | null
  appId: string | null
  label: string | null
  metadata: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export interface ArtifactInfo {
  title: string
  description?: string
  contentType: 'image' | 'link' | 'json'
  data: string
  metadata?: Record<string, unknown>
}
