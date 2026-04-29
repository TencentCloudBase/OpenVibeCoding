import { z } from 'zod'

// Log entry types
export const logEntrySchema = z.object({
  type: z.enum(['info', 'command', 'error', 'success']),
  message: z.string(),
  timestamp: z.number().optional(),
})

export type LogEntry = z.infer<typeof logEntrySchema>

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const insertTaskSchema = z.object({
  id: z.string().optional(),
  userId: z.string().min(1),
  prompt: z.string().min(1),
  title: z.string().optional(),
  repoUrl: z.string().url().optional(),
  selectedAgent: z.enum(['claude', 'codex', 'copilot', 'cursor', 'gemini', 'opencode']).default('claude'),
  selectedModel: z.string().optional(),
  mode: z.enum(['default', 'coding']).default('default'),
  installDependencies: z.boolean().default(false),
  maxDuration: z.number().default(300),
  keepAlive: z.boolean().default(false),
  enableBrowser: z.boolean().default(false),
  status: z.enum(['pending', 'processing', 'completed', 'error', 'stopped']).default('pending'),
  progress: z.number().min(0).max(100).default(0),
  logs: z.array(logEntrySchema).optional(),
  error: z.string().optional(),
  branchName: z.string().optional(),
  sandboxId: z.string().optional(),
  sandboxSessionId: z.string().optional(),
  sandboxCwd: z.string().optional(),
  sandboxMode: z.enum(['shared', 'isolated']).optional(),
  agentSessionId: z.string().optional(),
  sandboxUrl: z.string().optional(),
  previewUrl: z.string().optional(),
  prUrl: z.string().optional(),
  prNumber: z.number().optional(),
  prStatus: z.enum(['open', 'closed', 'merged']).optional(),
  prMergeCommitSha: z.string().optional(),
  mcpServerIds: z.array(z.string()).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  completedAt: z.number().optional(),
  deletedAt: z.number().optional(),
})

export const selectTaskSchema = z.object({
  id: z.string(),
  userId: z.string(),
  prompt: z.string(),
  title: z.string().nullable(),
  repoUrl: z.string().nullable(),
  selectedAgent: z.string().nullable(),
  selectedModel: z.string().nullable(),
  mode: z.enum(['default', 'coding']).nullable(),
  installDependencies: z.boolean().nullable(),
  maxDuration: z.number().nullable(),
  keepAlive: z.boolean().nullable(),
  enableBrowser: z.boolean().nullable(),
  status: z.enum(['pending', 'processing', 'completed', 'error', 'stopped']),
  progress: z.number().nullable(),
  logs: z.array(logEntrySchema).nullable(),
  error: z.string().nullable(),
  branchName: z.string().nullable(),
  sandboxId: z.string().nullable(),
  sandboxSessionId: z.string().nullable(),
  sandboxCwd: z.string().nullable(),
  sandboxMode: z.enum(['shared', 'isolated']).nullable(),
  agentSessionId: z.string().nullable(),
  sandboxUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prStatus: z.enum(['open', 'closed', 'merged']).nullable(),
  prMergeCommitSha: z.string().nullable(),
  mcpServerIds: z.array(z.string()).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  deletedAt: z.number().nullable(),
})

export type Task = z.infer<typeof selectTaskSchema>
export type InsertTask = z.infer<typeof insertTaskSchema>

// ─── Task Message Parts ────────────────────────────────────────────────────────

/**
 * 消息的结构化内容块，支持多模态渲染：
 * - text: 纯文本 / Markdown
 * - thinking: Agent 思考过程（可折叠）
 * - tool_call: 工具调用（展示工具名 + 输入）
 * - tool_result: 工具返回结果
 */
export const messagePartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('thinking'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    toolName: z.string().optional(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
])

export type MessagePart = z.infer<typeof messagePartSchema>

// ─── Task Messages ────────────────────────────────────────────────────────────

export const selectTaskMessageSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  role: z.enum(['user', 'agent']),
  /** 纯文本 content（兼容旧消息；新消息优先用 parts） */
  content: z.string().optional().nullable(),
  /** 结构化内容块（text / thinking / tool_call / tool_result） */
  parts: z.array(messagePartSchema).optional().nullable(),
  createdAt: z.number(),
})

export type TaskMessage = z.infer<typeof selectTaskMessageSchema>

// ─── Deployments ───────────────────────────────────────────────────────────────

export const deploymentTypeSchema = z.enum(['web', 'miniprogram'])

export const insertDeploymentSchema = z.object({
  id: z.string().optional(),
  taskId: z.string(),
  type: deploymentTypeSchema,
  url: z.string().url().optional().nullable(),
  path: z.string().optional().nullable(),
  qrCodeUrl: z.string().url().optional().nullable(),
  pagePath: z.string().optional().nullable(),
  appId: z.string().optional().nullable(),
  label: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
})

export const selectDeploymentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  type: deploymentTypeSchema,
  url: z.string().nullable(),
  path: z.string().nullable(),
  qrCodeUrl: z.string().nullable(),
  pagePath: z.string().nullable(),
  appId: z.string().nullable(),
  label: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
})

export type DeploymentType = z.infer<typeof deploymentTypeSchema>
export type Deployment = z.infer<typeof selectDeploymentSchema>
export type InsertDeployment = z.infer<typeof insertDeploymentSchema>
