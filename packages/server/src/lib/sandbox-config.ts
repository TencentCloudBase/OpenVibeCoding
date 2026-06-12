/**
 * Sandbox config — 沙箱业务镜像 workspace root + instance isolation mode (shared | isolated).
 */

import os from 'node:os'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { getProvisionMode, type ProvisionMode } from './provision-config.js'

/** 沙箱业务镜像 vibecoding preset workspace root (flat project tree). */
export const STATEFUL_WORKSPACE_ROOT = '/home/user'

export type SandboxInstanceMode = 'shared' | 'isolated'

export interface SandboxConfig {
  sandboxMode: SandboxInstanceMode
  sandboxCwd: string
}

interface ResolveParams {
  sandboxCwd?: string | null
  sandboxMode?: string | null
  envId: string
  taskId: string
}

export type SandboxInstanceModeSource = 'db' | 'env' | 'default'

const VALID_MODES: SandboxInstanceMode[] = ['shared', 'isolated']
const BUILTIN_DEFAULT: SandboxInstanceMode = 'shared'

export function normalizeSandboxMode(mode: string | null | undefined): SandboxInstanceMode {
  if (mode === 'isolated' || mode === 'shared') return mode
  return BUILTIN_DEFAULT
}

/** Legacy SCF per-task paths; migrate to stateful root. */
export function isLegacyScfSandboxCwd(cwd: string | null | undefined): boolean {
  if (!cwd) return false
  return cwd.startsWith('/tmp/workspace/')
}

export function normalizeSandboxCwd(cwd: string | null | undefined): string {
  if (!cwd || isLegacyScfSandboxCwd(cwd)) return STATEFUL_WORKSPACE_ROOT
  return cwd
}

/**
 * Host path for CodeBuddy SDK session JSONL (hash(cwd) under ~/.codebuddy/projects).
 * 沙箱业务镜像 workspace is /home/user on the sandbox VM; the SDK must not use that path on macOS.
 * Keep in sync with CloudbaseAgentService query({ cwd }).
 */
export function resolveAgentHostCwd(workspaceCwd: string, conversationId: string): string {
  if (workspaceCwd === STATEFUL_WORKSPACE_ROOT || workspaceCwd.startsWith('/home/user')) {
    return path.join(os.tmpdir(), 'openvibecoding-agent', conversationId)
  }
  return workspaceCwd
}

export function resolveSandboxConfig(params: ResolveParams): SandboxConfig {
  const sandboxCwd = normalizeSandboxCwd(params.sandboxCwd)
  const sandboxMode = normalizeSandboxMode(params.sandboxMode)
  return { sandboxMode, sandboxCwd }
}

/**
 * Default instance mode for new tasks (before per-task override).
 * Priority: DB `sandbox_instance_mode` → env `WORKSPACE_ISOLATION` → provision-aware builtin.
 */
export async function resolveSandboxInstanceMode(): Promise<{
  value: SandboxInstanceMode
  source: SandboxInstanceModeSource
  envDefault: SandboxInstanceMode
}> {
  const envIsolation = process.env.WORKSPACE_ISOLATION || ''
  const envDefault = normalizeSandboxMode(envIsolation || BUILTIN_DEFAULT)

  try {
    const setting = await getDb().settings.findSystemSetting('sandbox_instance_mode')
    if (setting?.value) {
      return { value: normalizeSandboxMode(setting.value), source: 'db', envDefault }
    }
  } catch {
    // DB unavailable
  }

  if (envIsolation) {
    return { value: envDefault, source: 'env', envDefault }
  }

  const provisionMode = await getProvisionMode()
  const value = defaultModeForProvision(provisionMode)
  return { value, source: 'default', envDefault }
}

function defaultModeForProvision(provisionMode: ProvisionMode): SandboxInstanceMode {
  // task-level CloudBase env pairs naturally with per-task sandbox instances.
  if (provisionMode === 'task') return 'isolated'
  return BUILTIN_DEFAULT
}

export function isValidSandboxInstanceMode(val: string): val is SandboxInstanceMode {
  return VALID_MODES.includes(val as SandboxInstanceMode)
}

/** Default sandbox instance mode when creating a task (honours body override). */
export async function resolveSandboxModeForNewTask(bodyMode?: string | null): Promise<SandboxInstanceMode> {
  if (bodyMode && isValidSandboxInstanceMode(bodyMode)) return bodyMode
  return (await resolveSandboxInstanceMode()).value
}

export async function backfillSandboxConfig(
  taskId: string,
  existing: {
    sandboxMode?: string | null
    sandboxSessionId?: string | null
    sandboxCwd?: string | null
  },
  envId: string,
  db: { tasks: { update: (id: string, data: Record<string, unknown>) => Promise<unknown> } },
): Promise<boolean> {
  const normalizedCwd = normalizeSandboxCwd(existing.sandboxCwd)
  const normalizedMode = existing.sandboxMode
    ? normalizeSandboxMode(existing.sandboxMode)
    : (await resolveSandboxInstanceMode()).value

  const needsUpdate =
    !existing.sandboxCwd ||
    isLegacyScfSandboxCwd(existing.sandboxCwd) ||
    existing.sandboxCwd !== normalizedCwd ||
    !existing.sandboxMode ||
    normalizeSandboxMode(existing.sandboxMode) !== normalizedMode

  if (!needsUpdate) return false

  const config = resolveSandboxConfig({
    sandboxCwd: normalizedCwd,
    sandboxMode: normalizedMode,
    envId,
    taskId,
  })

  await db.tasks.update(taskId, {
    sandboxMode: config.sandboxMode,
    sandboxCwd: config.sandboxCwd,
    updatedAt: Date.now(),
  })

  return true
}
