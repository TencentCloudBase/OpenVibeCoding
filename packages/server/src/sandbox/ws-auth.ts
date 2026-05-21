/**
 * Shared WebSocket auth: resolve task + sandbox from session cookie.
 */

import type { IncomingMessage } from 'node:http'
import { getDb } from '../db/index.js'
import { decryptJWE } from '../lib/session.js'
import type { AppSession } from '../middleware/auth.js'
import { getProvisionMode } from '../lib/provision-config.js'
import { getTaskSandbox } from './task-sandbox.js'
import type { SandboxInstance } from './provider/types.js'

export const SESSION_COOKIE_NAME = 'nex_session'

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return undefined
}

async function resolveUserEnvId(userId: string, taskId: string): Promise<string | null> {
  const mode = await getProvisionMode()
  if (mode === 'shared') {
    return process.env.TCB_ENV_ID ?? null
  }
  try {
    const taskResource = await getDb().userResources.findByTaskId(taskId)
    if (taskResource?.userId === userId && taskResource.status === 'success' && taskResource.envId) {
      return taskResource.envId
    }
  } catch {
    /* fallback */
  }
  const userResource = await getDb().userResources.findByUserId(userId)
  if (userResource?.status === 'success' && userResource.envId) return userResource.envId
  return null
}

export async function resolveSandboxForTaskWs(
  req: IncomingMessage,
  taskId: string,
): Promise<SandboxInstance | null> {
  const rawCookie = parseCookie(req.headers.cookie, SESSION_COOKIE_NAME)
  if (!rawCookie) return null

  let session: AppSession | undefined
  try {
    session = await decryptJWE<AppSession>(rawCookie)
  } catch {
    return null
  }
  if (!session?.user?.id) return null

  const task = await getDb().tasks.findById(taskId)
  if (!task || task.userId !== session.user.id) return null
  if (!task.sandboxId) return null

  const envId = await resolveUserEnvId(session.user.id, taskId)
  if (!envId) return null

  const taskMode = (task as { mode?: string | null }).mode
  return getTaskSandbox(task, envId, { isCodingMode: taskMode === 'coding' })
}
