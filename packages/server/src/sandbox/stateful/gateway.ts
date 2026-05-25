/**
 * TCB data-plane gateway helpers for stateful AGS instances.
 *
 * Browser iframes cannot send X-Cloudbase-Authorization / E2b-* headers; 使用 OpenVibeCoding
 * preview proxy or AGS direct URLs for UI. Server-side code uses these helpers.
 */

import { resolveStatefulGatewayUrl } from '../ensure-stateful-tool.js'

export const SANDBOX_BUSINESS_IMAGE_PORT = 9000
export const ENVD_PORT = 49983

export interface StatefulGatewayTarget {
  /** Gateway base, e.g. https://{envId}.api.tcloudbasegateway.com/v1/sandbox/- */
  baseUrl: string
  sandboxId: string
  /** Container port routed via E2b-Sandbox-Port (must be declared on the AGS tool). */
  port: number
  /** Path on the target service (leading slash). For 沙箱业务镜像 preview use `/preview/{port}/...`. */
  path: string
  headers: Record<string, string>
  url: string
}

export function buildDataPlaneHeaders(opts: {
  tcbApiKey: string
  sandboxId: string
  port: number
  /** Instance sit_* when ENABLE_AUTH_MODE=true (TCB_ACCESS_TOKEN). */
  accessToken?: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Cloudbase-Authorization': `Bearer ${opts.tcbApiKey}`,
    'E2b-Sandbox-Id': opts.sandboxId,
    'E2b-Sandbox-Port': String(opts.port),
  }
  const token = opts.accessToken?.trim()
  if (token) headers['X-Access-Token'] = token
  return headers
}

/**
 * Build a gateway request target for a specific container port.
 *
 * - port 9000: 沙箱业务镜像 HTTP (paths like /health, /preview/5173/, /api/tools/bash)
 * - other ports: must appear in CreateSandboxTool CustomConfiguration.Ports or gateway returns 500
 */
export function buildGatewayTarget(args: {
  envId: string
  sandboxId: string
  tcbApiKey: string
  port: number
  path?: string
  gatewayBaseUrl?: string
  accessToken?: string
}): StatefulGatewayTarget {
  const baseUrl = (args.gatewayBaseUrl || resolveStatefulGatewayUrl(args.envId)).replace(/\/$/, '')
  const path = normalizePath(args.path ?? '/')
  const headers = buildDataPlaneHeaders({
    tcbApiKey: args.tcbApiKey,
    sandboxId: args.sandboxId,
    port: args.port,
    accessToken: args.accessToken,
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

/** 沙箱业务镜像 reverse-proxy path for a dev server port (always via 沙箱业务镜像 :9000). */
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
  accessToken?: string
}): StatefulGatewayTarget {
  return buildGatewayTarget({
    ...args,
    port: SANDBOX_BUSINESS_IMAGE_PORT,
    path: buildTrwPreviewPath(args.vitePort, args.subpath),
  })
}

export async function gatewayFetch(target: StatefulGatewayTarget, init?: RequestInit): Promise<Response> {
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
