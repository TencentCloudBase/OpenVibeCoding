import { appJotaiStore } from '@/lib/jotai-store'
import type { LogEntry } from '@coder/shared'
import { appendTaskLog } from '@/lib/append-task-log'
import { streamLogsAtomFamily } from '@/lib/atoms/stream-logs'

export type PushLiveTaskLogOptions = {
  /**
   * Persist via POST /append-log (default true).
   * Set false when the server already wrote the same line to avoid duplicate DB rows.
   */
  persist?: boolean
}

function appendDeduped(prev: LogEntry[], entry: LogEntry): LogEntry[] {
  if (prev.some((e) => e.type === entry.type && e.message === entry.message)) return prev
  return [...prev, entry]
}

/** Show a log line in Logs pane immediately (streamLogs) and optionally persist. */
export function pushLiveTaskLog(
  taskId: string,
  entry: Pick<LogEntry, 'type' | 'message'>,
  options?: PushLiveTaskLogOptions,
): void {
  const line: LogEntry = { ...entry, timestamp: Date.now() }
  appJotaiStore.set(streamLogsAtomFamily(taskId), (prev) => appendDeduped(prev, line))
  if (options?.persist !== false) {
    void appendTaskLog(taskId, entry)
  }
}
