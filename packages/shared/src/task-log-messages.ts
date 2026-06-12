/**
 * Static user-visible task log lines (Logs pane). No dynamic interpolation.
 */

export const LOG_PREFIX_WORKSPACE = '[工作区]'
export const LOG_PREFIX_SERVER = '[SERVER]'

function workspaceLine(text: string): string {
  return `${LOG_PREFIX_WORKSPACE} ${text}`
}

export const TASK_LOG = {
  WORKSPACE_FILE_SAVED: workspaceLine('工作区文件已保存'),
  WORKSPACE_FILE_SAVE_FAILED: workspaceLine('工作区文件保存失败'),
  WORKSPACE_FILE_CREATED: workspaceLine('工作区已创建新文件'),
  WORKSPACE_FILE_CREATE_FAILED: workspaceLine('工作区创建文件失败'),
  WORKSPACE_FOLDER_CREATED: workspaceLine('工作区已创建文件夹'),
  WORKSPACE_FOLDER_CREATE_FAILED: workspaceLine('工作区创建文件夹失败'),
  WORKSPACE_FILE_DELETED: workspaceLine('工作区文件已删除'),
  WORKSPACE_FILE_DELETE_FAILED: workspaceLine('工作区文件删除失败'),
  WORKSPACE_NO_SANDBOX: workspaceLine('沙箱不可用，无法写入工作区'),

  PLATFORM_SHARED_SANDBOX_STOPPED: '共享沙箱已停止',
  PLATFORM_PREVIEW_READY: '开发预览已就绪',
  PLATFORM_PREVIEW_RESTARTING: '开发预览已停止，正在重启',
  PLATFORM_TERMINAL_READY: 'Web 终端已就绪',
  PLATFORM_TERMINAL_UNAVAILABLE: 'Web 终端暂不可用',
  PLATFORM_ARCHIVE_PUSH_OK: '变更已提交归档',
  PLATFORM_ARCHIVE_PUSH_FAILED: '归档推送失败',
  PLATFORM_DEPLOYMENT_RECORDED: '部署记录已保存',
  PLATFORM_TASK_STOPPED: '任务已由用户停止',
  PLATFORM_SANDBOX_STARTED: '沙箱已启动成功',
} as const

const ALLOWED_TASK_LOG_MESSAGES = new Set<string>(Object.values(TASK_LOG))

export function isAllowedTaskLogMessage(message: string): boolean {
  return ALLOWED_TASK_LOG_MESSAGES.has(message)
}

export function isWorkspaceTaskLogMessage(message: string): boolean {
  return message.startsWith(LOG_PREFIX_WORKSPACE)
}

export function isServerTaskLogMessage(message: string): boolean {
  return message.startsWith(LOG_PREFIX_SERVER)
}
