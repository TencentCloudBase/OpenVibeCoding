/**
 * TCB data-plane gateway helpers for stateful AGS instances.
 *
 * Browser iframes cannot send X-Cloudbase-Authorization / E2b-* headers; use OVC
 * preview proxy or AGS direct URLs for UI. Server-side code uses these helpers.
 */

import { resolveStatefulGatewayUrl } from '../ensure-stateful-tool.js'

export const TRW_SERVICE_PORT = 9000
export const ENVD_PORT = 49983

export interface StatefulGatewayTarget {
  /** Gateway base, e.g. https://{envId}.api.tcloudbasegateway.com/v1/sandbox/- */
  baseUrl: string
  sandboxId: string
  /** Container port routed via E2b-Sandbox-Port (must be declared on the AGS tool). */
  port: number
  /** Path on the target service (leading slash). For TRW preview use `/preview/{port}/...`. */
  path: string
  headers: Record<string, string>
  url: string
}

export function buildDataPlaneHeaders(opts: {
  tcbApiKey: string
  sandboxId: string
  port: number
}): Record<string, string> {
  return {
    'X-Cloudbase-Authorization': `Bearer ${opts.tcbApiKey}`,
    'E2b-Sandbox-Id': opts.sandboxId,
    'E2b-Sandbox-Port': String(opts.port),
  }
}

/**
 * Build a gateway request target for a specific container port.
 *
 * - port 9000: TRW HTTP (paths like /health, /preview/5173/, /api/tools/bash)
 * - other ports: must appear in CreateSandboxTool CustomConfiguration.Ports or gateway returns 500
 */
export function buildGatewayTarget(args: {
  envId: string
  sandboxId: string
  tcbApiKey: string
  port: number
  path?: string
  gatewayBaseUrl?: string
}): StatefulGatewayTarget {
  const baseUrl = (args.gatewayBaseUrl || resolveStatefulGatewayUrl(args.envId)).replace(/\/$/, '')
  const path = normalizePath(args.path ?? '/')
  const headers = buildDataPlaneHeaders({
    tcbApiKey: args.tcbApiKey,
    sandboxId: args.sandboxId,
    port: args.port,
  })
  return {
    baseUrl,
    sandboxId: args.sandboxId,
    port: args.port,
    path,
    headers,
    url: `${baseUrl}${path}`,
  }
}

/** TRW reverse-proxy path for a dev server port (always via TRW :9000). */
export function buildTrwPreviewPath(vitePort: number, subpath = '/'): string {
  const suffix = subpath.startsWith('/') ? subpath : `/${subpath}`
  return `/preview/${vitePort}${suffix === '/' ? '/' : suffix}`
}

export function buildTrwPreviewGatewayTarget(args: {
  envId: string
  sandboxId: string
  tcbApiKey: string
  vitePort: number
  subpath?: string
  gatewayBaseUrl?: string
}): StatefulGatewayTarget {
  return buildGatewayTarget({
    ...args,
    port: TRW_SERVICE_PORT,
    path: buildTrwPreviewPath(args.vitePort, args.subpath),
  })
}

export async function gatewayFetch(
  target: StatefulGatewayTarget,
  init?: RequestInit,
): Promise<Response> {
  return fetch(target.url, {
    ...init,
    headers: {
      ...target.headers,
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  })
}

function normalizePath(path: string): string {
  if (!path || path === '/') return '/'
  return path.startsWith('/') ? path : `/${path}`
}
