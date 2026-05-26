/**
 * Map public ttyd virtual port (7681) to the gateway preview path that actually reaches TRW.
 *
 * TCB gateway returns 404 for GET /preview/7681/ even with E2b-Sandbox-Port 9000, while
 * /preview/{ttydDynamicPort}/ works. Browser URLs stay on 7681; only upstream fetch uses the dynamic port.
 */

import type { SandboxInstance } from './provider/types.js'
import { TTYD_VIRTUAL_PORT } from './ttyd-preview.js'

export const TTYD_BACKEND_MIN = 29100
export const TTYD_BACKEND_MAX = 29199

type PreviewPortRow = {
  port?: number
  service?: string
  virtual?: boolean
  targetPort?: number
}

function isBackendPort(port: number): boolean {
  return port >= TTYD_BACKEND_MIN && port <= TTYD_BACKEND_MAX
}

/** Parse `ttyd -W -p 29100` from a pgrep cmdline (used when /preview/ports drops targetPort). */
export function parseTtydBackendPortFromCmdline(cmdline: string): number | null {
  const m = cmdline.match(/\bttyd\b[^]*?\s-p\s+(\d+)/)
  if (!m) return null
  const port = Number.parseInt(m[1]!, 10)
  if (!Number.isFinite(port) || !isBackendPort(port)) return null
  return port
}

async function listPreviewPorts(sandbox: SandboxInstance): Promise<PreviewPortRow[]> {
  try {
    const res = await sandbox.request('/preview/ports', { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return []
    const info = (await res.json()) as { ports?: PreviewPortRow[] }
    return Array.isArray(info.ports) ? info.ports : []
  } catch {
    return []
  }
}

async function discoverTtydBackendPort(sandbox: SandboxInstance): Promise<number | null> {
  try {
    const res = await sandbox.request('/api/tools/bash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: "pgrep -fa 'ttyd -W -p' 2>/dev/null | head -1 || true",
        timeout: 15_000,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { result?: { output?: string } }
    const line =
      json.result?.output
        ?.split('\n')
        .map((l) => l.trim())
        .find((l) => /\bttyd\b/.test(l)) ?? ''
    return parseTtydBackendPortFromCmdline(line)
  } catch {
    return null
  }
}

/**
 * Port segment used in gateway paths `/preview/{port}/...` (not shown in the browser URL).
 */
export async function resolveGatewayPreviewPort(sandbox: SandboxInstance, publicPort: number): Promise<number> {
  if (publicPort !== TTYD_VIRTUAL_PORT) return publicPort

  const rows = await listPreviewPorts(sandbox)
  const virtual = rows.find((p) => p.port === TTYD_VIRTUAL_PORT && p.service === 'ttyd')
  if (virtual?.targetPort && isBackendPort(virtual.targetPort)) return virtual.targetPort

  const backend = rows.find(
    (p) => p.service === 'ttyd' && !p.virtual && typeof p.port === 'number' && isBackendPort(p.port),
  )
  if (backend?.port) return backend.port

  const discovered = await discoverTtydBackendPort(sandbox)
  if (discovered !== null) return discovered

  return publicPort
}
