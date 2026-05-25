/**
 * Task-level sandbox helpers (routes/tasks.ts).
 * All acquisition goes through StatefulSandboxProvider.
 */

import { getDb } from '../db/index.js'
import type { Task } from '../db/types.js'
import { buildStatefulAcquireContext } from './acquire-context.js'
import { getSandboxProvider } from './provider/factory.js'
import type { SandboxInstance, SandboxProvider } from './provider/types.js'
import { statefulReadBinaryFile, statefulReadTextFile } from './stateful/e2b-native-client.js'

export interface CommandResult {
  success: boolean
  exitCode?: number
  output?: string
  error?: string
}

export interface TaskSandboxOptions {
  allowCreate?: boolean
  /** Reserved for future coding-mode acquire hints */
  isCodingMode?: boolean
}

export async function getTaskSandbox(
  task: Task,
  envId: string,
  options?: TaskSandboxOptions,
): Promise<SandboxInstance | null> {
  try {
    const provider = getSandboxProvider()
    const acquireCtx = buildStatefulAcquireContext({
      envId,
      taskId: task.id,
      userId: task.userId,
      sandboxMode: task.sandboxMode,
      sandboxId: task.sandboxId,
    })

    const existing = provider.getExisting ? await provider.getExisting(acquireCtx) : null
    if (existing) return existing

    // Task already bound to a sandbox (e.g. after page refresh): reconnect like preview-url does.
    // Without this, list-dir/files fail with 410 while preview still works (allowCreate there).
    const mayAcquire = options?.allowCreate || !!task.sandboxId
    if (!mayAcquire) return null

    const acquired = await provider.acquire(acquireCtx)
    if (task.sandboxId !== acquired.id) {
      await getDb().tasks.update(task.id, { sandboxId: acquired.id, updatedAt: Date.now() })
    }
    return acquired
  } catch {
    return null
  }
}

export async function runCommandInSandbox(
  sandbox: SandboxInstance,
  command: string,
  timeout = 30000,
): Promise<CommandResult> {
  try {
    const response = await sandbox.request('/api/tools/bash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, timeout }),
    })
    const data = (await response.json()) as {
      success: boolean
      result?: { output: string; exitCode: number }
      error?: string
    }
    if (!data.success) {
      return { success: false, error: data.error || 'Command failed' }
    }
    return {
      success: data.result?.exitCode === 0,
      exitCode: data.result?.exitCode,
      output: data.result?.output || '',
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Command failed' }
  }
}

export type PackageManager = 'pnpm' | 'yarn' | 'npm'

export async function detectPackageManager(sandbox: SandboxInstance): Promise<PackageManager> {
  const pnpmCheck = await runCommandInSandbox(sandbox, 'test -f pnpm-lock.yaml && echo "yes" || echo "no"')
  if (pnpmCheck.output?.trim() === 'yes') return 'pnpm'
  const yarnCheck = await runCommandInSandbox(sandbox, 'test -f yarn.lock && echo "yes" || echo "no"')
  if (yarnCheck.output?.trim() === 'yes') return 'yarn'
  return 'npm'
}

export async function readFileFromSandbox(
  sandbox: SandboxInstance,
  filePath: string,
  options?: { isImage?: boolean },
): Promise<{ content: string; found: boolean; isBase64?: boolean }> {
  try {
    const path = (filePath || '').trim()
    if (!path) return { content: '', found: false }

    if (sandbox.backend === 'stateful') {
      if (options?.isImage) {
        const bytes = await statefulReadBinaryFile(sandbox, path)
        if (!bytes) return { content: '', found: false }
        return { content: Buffer.from(bytes).toString('base64'), found: true, isBase64: true }
      }
      const text = await statefulReadTextFile(sandbox, path)
      if (text === null) return { content: '', found: false }
      return { content: text, found: true }
    }

    const res = await sandbox.request('/api/tools/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, isImage: options?.isImage }),
    })
    if (!res.ok) return { content: '', found: false }
    const data = (await res.json()) as { success?: boolean; result?: { content?: string } }
    const content = data.result?.content ?? ''
    return { content, found: !!data.success && content.length > 0 }
  } catch {
    return { content: '', found: false }
  }
}

/** Download file bytes via TRW POST /api/tools/files_download (production TRW has no /e2b-compatible). */
export async function downloadFileFromSandbox(sandbox: SandboxInstance, filePath: string): Promise<Uint8Array | null> {
  try {
    const res = await sandbox.request('/api/tools/files_download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
      signal: AbortSignal.timeout(120_000),
    })
    const data = (await res.json()) as { success?: boolean; result?: { contentBase64?: string } }
    if (!data.success || !data.result?.contentBase64) return null
    return Uint8Array.from(Buffer.from(data.result.contentBase64, 'base64'))
  } catch {
    return null
  }
}

export async function writeFileToSandbox(
  sandbox: SandboxInstance,
  filePath: string,
  content: string,
): Promise<boolean> {
  try {
    const res = await sandbox.request('/api/tools/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    })
    return res.ok
  } catch {
    return false
  }
}

export function getProvider(): SandboxProvider {
  return getSandboxProvider()
}

/**
 * @deprecated Prefer waitForSandboxViteReady — TRW vite-dev-manager owns port 5173.
 */
export async function ensureDevServerStarted(
  sandbox: SandboxInstance,
  port: number,
): Promise<{ success: boolean; message?: string }> {
  const { isViteReadyResult, waitForSandboxViteReady } = await import('./wait-vite-ready.js')
  const result = await waitForSandboxViteReady(sandbox, { port })
  if (isViteReadyResult(result)) return { success: true }
  return { success: false, message: result.message }
}
