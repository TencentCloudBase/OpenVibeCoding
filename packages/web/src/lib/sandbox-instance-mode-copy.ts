export type SandboxInstanceMode = 'shared' | 'isolated'

export function newTaskTooltip(mode: SandboxInstanceMode): string {
  if (mode === 'isolated') {
    return '当前：隔离实例模式。每个任务使用独立沙箱实例；新建任务会为本任务启动实例，或复用该任务已绑定的实例。'
  }
  return '当前：共享实例模式。同环境下多任务共用一台沙箱实例；新建任务会复用已有实例（无则启动一台），工作区共盘 /home/user。'
}

export function deleteAllTasksTooltip(mode: SandboxInstanceMode, taskCount: number): string {
  if (taskCount === 0) return '当前没有可删除的任务'
  if (mode === 'isolated') {
    return `当前：隔离实例模式。将删除全部 ${taskCount} 个任务；沙箱实例在后台依次回收。`
  }
  return `当前：共享实例模式。将删除全部 ${taskCount} 个任务，并停止本环境共享沙箱实例以回收计算资源。`
}

export function deleteAllTasksDialogBody(mode: SandboxInstanceMode, taskCount: number): string {
  if (mode === 'isolated') {
    return `将永久删除 ${taskCount} 个任务。沙箱实例会在后台回收，列表会立即更新。此操作不可撤销。`
  }
  return `将永久删除 ${taskCount} 个任务，并停止本环境的共享沙箱实例（同环境下其他用户也无法再使用该实例）。此操作不可撤销。`
}

export function deleteSingleTaskMenuHint(
  taskSandboxMode: SandboxInstanceMode | null | undefined,
  fallbackMode: SandboxInstanceMode,
): string {
  const mode = taskSandboxMode === 'isolated' || taskSandboxMode === 'shared' ? taskSandboxMode : fallbackMode
  if (mode === 'isolated') return '隔离模式：将销毁本任务专用沙箱实例'
  return '共享模式：仅删任务，环境沙箱实例保留'
}

export function deleteSingleTaskDialogBody(
  taskSandboxMode: SandboxInstanceMode | null | undefined,
  fallbackMode: SandboxInstanceMode,
): string {
  const mode = taskSandboxMode === 'isolated' || taskSandboxMode === 'shared' ? taskSandboxMode : fallbackMode
  if (mode === 'isolated') {
    return '当前：隔离实例模式。删除本任务将停止并销毁该任务专用的沙箱实例。此操作不可撤销。'
  }
  return '当前：共享实例模式。仅删除本任务记录；环境共享沙箱实例会继续运行，供其他任务使用。此操作不可撤销。'
}
