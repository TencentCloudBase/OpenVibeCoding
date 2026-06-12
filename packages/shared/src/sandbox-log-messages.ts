/**
 * Static platform log lines for sandbox progress (Logs pane / task.logs).
 * User-visible — no dynamic interpolation.
 */

const SANDBOX_LOG_MESSAGES: Record<string, string> = {
  'sandbox:template_resolve': '加载沙箱模板',
  'sandbox:template_bind': '绑定沙箱模板',
  'sandbox:template_create': '首次创建沙箱模板',
  'sandbox:template_warmup': '沙箱模板预热中',
  'sandbox:template_update': '同步沙箱模板镜像',
  'sandbox:instance_reuse_session': '复用本会话沙箱连接',
  'sandbox:instance_reuse_shared': '复用环境共享沙箱',
  'sandbox:instance_reuse_task': '复用本任务沙箱',
  'sandbox:instance_resume': '恢复沙箱实例',
  'sandbox:instance_start': '启动沙箱实例',
  'sandbox:pull_image': '拉取沙箱镜像',
  'sandbox:wait_ready': '等待沙箱健康检查',
  'sandbox:init_mcp': '初始化工作区',
  'sandbox:wait_creating': '沙箱启动中',
  'sandbox:create': '创建沙箱',
  'sandbox:reuse': '连接已有沙箱',
}

export function isSandboxToolName(toolName?: string): boolean {
  return typeof toolName === 'string' && toolName.startsWith('sandbox:')
}

/** Map `sandbox:*` tool name to a static log line, or null to skip. */
export function sandboxLogMessageForTool(toolName: string, ctx?: { previousPrepareTool?: string }): string | null {
  if (toolName === 'sandbox:ready') {
    if (ctx?.previousPrepareTool === 'sandbox:init_mcp') {
      return '沙箱与工作区已就绪'
    }
    return '沙箱实例已就绪'
  }
  if (toolName === 'sandbox:error') {
    return '沙箱未就绪（受限模式）'
  }
  return SANDBOX_LOG_MESSAGES[toolName] ?? null
}
