import type { LogEntry } from '@coder/shared'
import { isAllowedTaskLogMessage } from '@coder/shared'

/** Persist a whitelisted static log line for the task (Logs pane). */
export async function appendTaskLog(taskId: string, entry: Pick<LogEntry, 'type' | 'message'>): Promise<void> {
  if (!isAllowedTaskLogMessage(entry.message)) return
  try {
    await fetch(`/api/tasks/${taskId}/append-log`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
  } catch {
    // Non-critical
  }
}
