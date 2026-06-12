import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { LogEntry } from '@coder/shared'

/** Live log lines from SSE `sessionUpdate: log` during an agent turn (merged into LogsPane). */
export const streamLogsAtomFamily = atomFamily((_taskId: string) => atom<LogEntry[]>([]))
