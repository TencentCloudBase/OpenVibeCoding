/**
 * Sandbox lane labels for dual-row turn status UI.
 *
 * Server phases (stateful-provider, shared vs isolated):
 *
 * | Layer | shared + no instance | shared + RUNNING instance | shared + PAUSED |
 * |-------|----------------------|---------------------------|-----------------|
 * | Tool  | template_* → instance_start → pull_image | template_* → instance_reuse_shared | instance_resume |
 * | Cache | — | instance_reuse_session (same Node process) | same |
 *
 * | Layer | isolated + no task.sandboxId | isolated + bound RUNNING | isolated + PAUSED |
 * |-------|------------------------------|--------------------------|-------------------|
 * | Tool  | template_* → instance_start | instance_reuse_task | instance_resume |
 *
 * Both modes then: wait_ready → ready → init_mcp → ready (workspace).
 */

export type SandboxLaneStatus = 'idle' | 'preparing' | 'success' | 'failed'

export type SandboxOutcomeKey =
  | 'reused_shared'
  | 'reused_task'
  | 'reused_session'
  | 'started_shared'
  | 'started_isolated'
  | 'resumed_shared'
  | 'resumed_isolated'
  | 'ready'
  | 'workspace_ready'
  | 'failed'

export interface SandboxLaneState {
  status: SandboxLaneStatus
  /** Current or last preparing sub-phase (`sandbox:…`). */
  toolName?: string
  /** Set when status becomes success. */
  outcomeKey?: SandboxOutcomeKey
  /** Last preparing sub-phase before a `sandbox:ready` latch. */
  lastPrepareToolName?: string
}

export const IDLE_SANDBOX_LANE: SandboxLaneState = { status: 'idle' }

export function isSandboxToolName(toolName?: string): boolean {
  return typeof toolName === 'string' && toolName.startsWith('sandbox:')
}

const PREPARING_LABELS: Record<string, string> = {
  'sandbox:template_resolve': '加载沙箱模板…',
  'sandbox:template_bind': '绑定沙箱模板…',
  'sandbox:template_create': '首次创建沙箱模板…',
  'sandbox:template_warmup': '沙箱模板预热…',
  'sandbox:template_update': '同步沙箱模板镜像…',
  'sandbox:instance_reuse_session': '复用本会话沙箱连接…',
  'sandbox:instance_reuse_shared': '复用环境共享沙箱…',
  'sandbox:instance_reuse_task': '复用本任务沙箱…',
  'sandbox:instance_resume': '恢复沙箱实例…',
  'sandbox:instance_start': '启动沙箱实例…',
  'sandbox:pull_image': '拉取沙箱镜像…',
  'sandbox:wait_ready': '等待沙箱健康检查…',
  'sandbox:init_mcp': '初始化工作区…',
  'sandbox:wait_creating': '沙箱启动中…',
  'sandbox:create': '创建沙箱…',
  'sandbox:reuse': '连接已有沙箱…',
}

export function sandboxPreparingLabel(toolName?: string): string {
  if (!toolName) return '准备沙箱环境…'
  return PREPARING_LABELS[toolName] ?? '准备沙箱环境…'
}

export function resolveSandboxOutcomeKey(lastPrepareToolName?: string): SandboxOutcomeKey {
  switch (lastPrepareToolName) {
    case 'sandbox:instance_reuse_shared':
      return 'reused_shared'
    case 'sandbox:instance_reuse_task':
      return 'reused_task'
    case 'sandbox:instance_reuse_session':
      return 'reused_session'
    case 'sandbox:instance_resume':
      return 'resumed_shared'
    case 'sandbox:instance_start':
      return 'started_shared'
    default:
      return 'ready'
  }
}

export function sandboxTerminalLabel(
  outcomeKey: SandboxOutcomeKey,
  sandboxMode?: 'shared' | 'isolated' | null,
): string {
  switch (outcomeKey) {
    case 'reused_shared':
      return '环境共享沙箱已复用'
    case 'reused_task':
      return '本任务沙箱已复用'
    case 'reused_session':
      return '沙箱连接已复用（本会话）'
    case 'resumed_shared':
      return sandboxMode === 'isolated' ? '任务沙箱已恢复' : '环境共享沙箱已恢复'
    case 'resumed_isolated':
      return '任务沙箱已恢复'
    case 'started_shared':
      return '环境共享沙箱已启动并就绪'
    case 'started_isolated':
      return '任务沙箱已启动并就绪'
    case 'workspace_ready':
      return '沙箱与工作区已就绪'
    case 'failed':
      return '沙箱未就绪（受限模式）'
    case 'ready':
    default:
      return '沙箱已就绪'
  }
}

/** Refine generic `instance_start` / `instance_resume` labels using task sandbox mode. */
export function refineOutcomeForMode(
  outcomeKey: SandboxOutcomeKey,
  lastPrepareToolName: string | undefined,
  sandboxMode?: 'shared' | 'isolated' | null,
): SandboxOutcomeKey {
  if (lastPrepareToolName === 'sandbox:instance_start') {
    return sandboxMode === 'isolated' ? 'started_isolated' : 'started_shared'
  }
  if (lastPrepareToolName === 'sandbox:instance_resume') {
    return sandboxMode === 'isolated' ? 'resumed_isolated' : 'resumed_shared'
  }
  return outcomeKey
}
