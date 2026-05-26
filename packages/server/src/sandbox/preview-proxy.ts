/**
 * Proxy browser preview requests to 沙箱业务镜像 /preview/{port}/ via stateful gateway auth headers.
 */

import type { Context } from 'hono'
import type { SandboxInstance } from './provider/types.js'
import { TTYD_VIRTUAL_PORT } from './ttyd-preview.js'
import { resolveGatewayPreviewPort } from './ttyd-gateway-port.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

/** fetch() decompresses the body; forwarding Content-Encoding breaks browsers (ERR_CONTENT_DECODING_FAILED). */
const STRIP_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'content-encoding'])

function buildUpstreamPreviewPath(port: string, subpath: string): string {
  const portNum = port.replace(/[^\d]/g, '') || port
  const suffix = subpath && subpath !== '/' ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '/'
  return `/preview/${portNum}${suffix}`
}

function normalizePort(port: string): string {
  return port.replace(/[^\d]/g, '') || port
}

function proxyPreviewPrefix(taskId: string, port: string): string {
  const portNum = normalizePort(port)
  return `/api/tasks/${taskId}/preview/${portNum}`
}

function trwPreviewPrefix(port: string): string {
  return `/preview/${normalizePort(port)}`
}

/** Rewrite 沙箱业务镜像 vite base paths so subresources load through OpenVibeCoding 预览反代 route. */
export function rewritePreviewPaths(body: string, taskId: string, port: string): string {
  const from = trwPreviewPrefix(port)
  const to = proxyPreviewPrefix(taskId, port)
  if (!body.includes(from)) return body
  return body.split(from).join(to)
}

/** Exported for tests — ttyd HTML must not be string-rewritten (breaks WS client). */
export function shouldRewritePreviewBody(contentType: string | null, port: string): boolean {
  if (normalizePort(port) === String(TTYD_VIRTUAL_PORT)) return false
  if (!contentType) return false
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return (
    ct.includes('text/html') ||
    ct.includes('javascript') ||
    ct.includes('text/css') ||
    ct === 'application/json' ||
    ct === 'text/plain'
  )
}

function rewriteLocationHeader(location: string, taskId: string, port: string, sandboxBaseUrl: string): string {
  try {
    const loc = new URL(location, sandboxBaseUrl)
    const previewPrefix = trwPreviewPrefix(port)
    if (loc.pathname.startsWith(previewPrefix)) {
      const rest = loc.pathname.slice(previewPrefix.length) || '/'
      const proxyPath = `${proxyPreviewPrefix(taskId, port)}${rest}`
      return `${proxyPath}${loc.search}`
    }
  } catch {
    // keep original
  }
  return location
}

export async function proxyTaskPreview(
  c: Context,
  sandbox: SandboxInstance,
  taskId: string,
  port: string,
  subpath: string,
): Promise<Response> {
  const authHeaders = await sandbox.getAuthHeaders()
  const publicPortNum = Number(normalizePort(port))
  const gatewayPort =
    publicPortNum === TTYD_VIRTUAL_PORT ? String(await resolveGatewayPreviewPort(sandbox, TTYD_VIRTUAL_PORT)) : port
  const upstreamPath = buildUpstreamPreviewPath(gatewayPort, subpath)
  const query = c.req.url.includes('?') ? new URL(c.req.url).search : ''
  const targetUrl = `${sandbox.baseUrl}${upstreamPath}${query}`

  const forwardHeaders = new Headers()
  for (const [key, value] of c.req.raw.headers.entries()) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'cookie' || lower === 'authorization') continue
    forwardHeaders.set(key, value)
  }
  for (const [key, value] of Object.entries(authHeaders)) {
    forwardHeaders.set(key, value)
  }

  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const upstream = await fetch(targetUrl, {
    method,
    headers: forwardHeaders,
    body: hasBody ? c.req.raw.body : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  })

  const outHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return
    if (key.toLowerCase() === 'location') {
      outHeaders.set(key, rewriteLocationHeader(value, taskId, port, sandbox.baseUrl))
      return
    }
    outHeaders.set(key, value)
  })

  const contentType = upstream.headers.get('content-type')
  if (shouldRewritePreviewBody(contentType, port)) {
    const raw = await upstream.text()
    const rewritten = rewritePreviewPaths(raw, taskId, port)
    return new Response(rewritten, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    })
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  })
}
