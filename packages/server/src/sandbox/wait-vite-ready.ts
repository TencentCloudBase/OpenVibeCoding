/**
 * Wait for TRW vite-dev-manager (vibecoding) — do not spawn a second dev server.
 * TRW master has no /api/vibecoding/status; use /preview/ports + /preview/{port}/ probe only.
 */

import type { SandboxInstance } from './provider/types.js'

const DEFAULT_VITE_PORT = 5173

export interface ViteReadyProgress {
  message: string
}

export interface ViteReadyResult {
  port: number
  message?: string
}

async function probePreviewPort(sandbox: SandboxInstance, port: number): Promise<boolean> {
  try {
    // Hits TRW preview proxy → maybeEnsureViteDevForPreview (lazy unpack + vite start).
    const res = await sandbox.request(`/preview/${port}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(30_000),
    })
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

async function listPreviewPorts(sandbox: SandboxInstance): Promise<number[]> {
  try {
    const res = await sandbox.request('/preview/ports', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const info = (await res.json()) as { ports?: Array<{ port: number }> }
    return Array.isArray(info.ports) ? info.ports.map((p) => p.port) : []
  } catch {
    return []
  }
}

function progressMessage(ports: number[], targetPort: number, probed: boolean): string {
  if (probed) return '开发服务器已就绪'
  if (ports.includes(targetPort)) return '正在等待开发服务器响应...'
  return '正在等待开发服务器...'
}

/**
 * Poll TRW until vite preview is reachable. Relies on ensureViteDev() started at workspace init.
 */
export async function waitForSandboxViteReady(
  sandbox: SandboxInstance,
  options: {
    port?: number
    maxWaitMs?: number
    pollIntervalMs?: number
    onProgress?: (p: ViteReadyProgress) => void | Promise<void>
  } = {},
): Promise<ViteReadyResult> {
  const port = options.port ?? DEFAULT_VITE_PORT
  const maxWaitMs = options.maxWaitMs ?? 120_000
  const pollIntervalMs = options.pollIntervalMs ?? 2_000
  const start = Date.now()

  while (Date.now() - start < maxWaitMs) {
    const ports = await listPreviewPorts(sandbox)
    const probed = await probePreviewPort(sandbox, port)
    await options.onProgress?.({ message: progressMessage(ports, port, probed) })

    if (probed) {
      return { port }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }

  return { port, message: `开发服务器未在 ${maxWaitMs / 1000}s 内就绪` }
}

/** True when wait result indicates vite is listening. */
export function isViteReadyResult(result: ViteReadyResult): boolean {
  return !result.message
}
