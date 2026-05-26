/**
 * Web Terminal preview — public virtual port 7681, proxied as /api/tasks/:id/preview/7681/.
 */

import type { SandboxInstance } from './provider/types.js'
import { resolveGatewayPreviewPort } from './ttyd-gateway-port.js'

export const TTYD_VIRTUAL_PORT = 7681

export type TtydPreviewProbe = 'ready' | 'starting' | 'unavailable'

export type TtydPreviewResolve = {
  status: TtydPreviewProbe
  port: typeof TTYD_VIRTUAL_PORT
  retryable: boolean
}

export async function probeTtydPreviewPort(sandbox: SandboxInstance, gatewayPort: number): Promise<TtydPreviewProbe> {
  try {
    const res = await sandbox.request(`/preview/${gatewayPort}/`, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    })
    if (res.status === 503) return 'starting'
    if (res.ok) return 'ready'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

async function wakeTtydViaTrw(sandbox: SandboxInstance): Promise<void> {
  await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: `curl -s -o /dev/null -w "%{http_code}" --max-time 25 "http://127.0.0.1:9000/preview/${TTYD_VIRTUAL_PORT}/" || true`,
      timeout: 30_000,
    }),
    signal: AbortSignal.timeout(35_000),
  })
}

export async function resolveTtydPreviewPort(sandbox: SandboxInstance): Promise<TtydPreviewResolve> {
  const gatewayPort = await resolveGatewayPreviewPort(sandbox, TTYD_VIRTUAL_PORT)

  let probe = await probeTtydPreviewPort(sandbox, gatewayPort)
  if (probe === 'ready') {
    return { status: 'ready', port: TTYD_VIRTUAL_PORT, retryable: false }
  }
  if (probe === 'starting') {
    return { status: 'starting', port: TTYD_VIRTUAL_PORT, retryable: true }
  }

  await wakeTtydViaTrw(sandbox)

  const gatewayPortAfterWake = await resolveGatewayPreviewPort(sandbox, TTYD_VIRTUAL_PORT)
  probe = await probeTtydPreviewPort(sandbox, gatewayPortAfterWake)
  if (probe === 'ready') {
    return { status: 'ready', port: TTYD_VIRTUAL_PORT, retryable: false }
  }
  if (probe === 'starting') {
    return { status: 'starting', port: TTYD_VIRTUAL_PORT, retryable: true }
  }

  return { status: 'unavailable', port: TTYD_VIRTUAL_PORT, retryable: true }
}
