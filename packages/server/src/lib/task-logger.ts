import { getDb } from '../db/index.js'
import type { ExtendedSessionUpdate } from '@coder/shared'

type LogLevel = 'info' | 'error' | 'success' | 'command'

interface LogEntry {
  type: LogLevel
  message: string
  timestamp: number
}

type ACPNotifyFn = (update: ExtendedSessionUpdate) => void

export class TaskLogger {
  private taskId: string
  private acpNotify?: ACPNotifyFn

  constructor(taskId: string) {
    this.taskId = taskId
  }

  registerACPNotifier(notify: ACPNotifyFn) {
    this.acpNotify = notify
  }

  private async appendLog(level: LogLevel, message: string) {
    const entry: LogEntry = { type: level, message, timestamp: Date.now() }

    try {
      const task = await getDb().tasks.findById(this.taskId)
      const existingLogs: LogEntry[] = task?.logs ? JSON.parse(task.logs) : []
      const newLogs = [...existingLogs, entry]

      await getDb().tasks.update(this.taskId, { logs: JSON.stringify(newLogs), updatedAt: Date.now() })
    } catch {
      // Don't throw - logging failures should not break the main process
    }

    if (this.acpNotify) {
      this.acpNotify({ sessionUpdate: 'log', level, message, timestamp: entry.timestamp })
    }
  }

  async info(message: string) {
    await this.appendLog('info', message)
  }

  async error(message: string) {
    await this.appendLog('error', message)
  }

  async success(message: string) {
    await this.appendLog('success', message)
  }

  async command(message: string) {
    await this.appendLog('command', message)
  }

  /**
   * 更新 task.progress（0-100）并可选追加一条 info 日志。
   * 若注册了 ACP notifier，同步推送 task_progress 事件。
   */
  async updateProgress(progress: number, message?: string) {
    try {
      if (message) {
        const entry: LogEntry = { type: 'info', message, timestamp: Date.now() }
        const task = await getDb().tasks.findById(this.taskId)
        const existingLogs: LogEntry[] = task?.logs ? JSON.parse(task.logs) : []
        const newLogs = [...existingLogs, entry]
        await getDb().tasks.update(this.taskId, { progress, logs: JSON.stringify(newLogs), updatedAt: Date.now() })
      } else {
        await getDb().tasks.update(this.taskId, { progress, updatedAt: Date.now() })
      }
    } catch {
      // Don't throw
    }

    if (this.acpNotify) {
      const task = await getDb()
        .tasks.findById(this.taskId)
        .catch(() => null)
      this.acpNotify({
        sessionUpdate: 'task_progress',
        progress,
        status: (task?.status ?? 'processing') as any,
      })
    }
  }

  async updateStatus(status: 'pending' | 'processing' | 'completed' | 'error' | 'stopped', error?: string) {
    try {
      const updateData: Record<string, unknown> = { status, updatedAt: Date.now() }
      if (status === 'completed') updateData.completedAt = Date.now()
      if (error) updateData.error = error
      await getDb().tasks.update(this.taskId, updateData as any)
    } catch {
      // Don't throw
    }
  }
}

export function createTaskLogger(taskId: string): TaskLogger {
  return new TaskLogger(taskId)
}
