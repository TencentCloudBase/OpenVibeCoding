/**
 * Build StatefulSandboxProvider acquire context from a task record.
 */

import { normalizeSandboxMode, type SandboxInstanceMode } from '../lib/sandbox-config.js'
import type { AcquireContext } from './provider/types.js'

export function buildStatefulAcquireContext(args: {
  envId: string
  taskId: string
  userId: string
  sandboxMode?: string | null
  sandboxId?: string | null
}): AcquireContext {
  const sandboxMode: SandboxInstanceMode = normalizeSandboxMode(args.sandboxMode)
  return {
    envId: args.envId,
    conversationId: args.taskId,
    backendOptions: { backend: 'stateful', sandboxMode },
    meta: {
      userId: args.userId,
      sandboxMode,
      preferredSandboxId: args.sandboxId ?? null,
    },
  }
}
