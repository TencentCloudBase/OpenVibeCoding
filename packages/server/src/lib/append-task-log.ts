import type { LogEntry } from '@coder/shared'
import { isAllowedTaskLogMessage } from '@coder/shared'
import { createTaskLogger } from './task-logger.js'

/** Append a whitelisted static line to task.logs (and SSE log stream when notifier registered). */
export async function appendAllowedTaskLog(taskId: string, level: LogEntry['type'], message: string): Promise<void> {
  if (!isAllowedTaskLogMessage(message)) return
  const logger = createTaskLogger(taskId)
  switch (level) {
    case 'success':
      await logger.success(message)
      break
    case 'error':
      await logger.error(message)
      break
    case 'command':
      await logger.command(message)
      break
    default:
      await logger.info(message)
  }
}
