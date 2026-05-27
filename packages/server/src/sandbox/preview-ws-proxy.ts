/**
 * WebSocket upgrade proxy: browser → OpenVibeCoding → TRW /preview/{port}/ (vite HMR, ttyd).
 */

import type { IncomingMessage, Server } from 'node:http'
import { URL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { resolveSandboxForTaskWs } from './ws-auth.js'
import { TTYD_VIRTUAL_PORT } from './ttyd-preview.js'
import { resolveGatewayPreviewPort } from './ttyd-gateway-port.js'

const PREVIEW_WS_RE = /^\/api\/tasks\/([^/]+)\/preview\/(\d+)(\/.*)?$/

const wss = new WebSocketServer({ noServer: true })

function buildUpstreamPath(port: string, subpath: string | undefined): string {
  const suffix = subpath && subpath !== '/' ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '/'
  return `/preview/${port}${suffix}`
}

/** Gateway base includes a path prefix (e.g. /v1/sandbox/-); WS must use the full path, not host-only. */
export function buildGatewayWebSocketUrl(baseUrl: string, previewPath: string, query = ''): string {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const prefix = base.pathname.replace(/\/$/, '')
  const normalized = previewPath.startsWith('/') ? previewPath : `/${previewPath}`
  const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${base.host}${prefix}${normalized}${query}`
}

/**
 * Gateway WS upgrade: send sandbox data-plane auth only.
 * Do not forward browser Origin/Referer (CloudRun host) — gateway returns 403 on upgrade.
 */
export function buildUpstreamGatewayWsHeaders(authHeaders: Record<string, string>): Record<string, string> {
  return { ...authHeaders }
}

/** Browser ttyd uses Sec-WebSocket-Protocol: tty; upstream must match or ttyd closes immediately. */
export function parseClientWsProtocols(req: IncomingMessage): string[] | undefined {
  const raw = req.headers['sec-websocket-protocol']
  if (!raw) return undefined
  const protocols = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return protocols.length > 0 ? protocols : undefined
}

export function connectUpstreamPreviewWebSocket(
  wsUrl: string,
  protocols: string[] | undefined,
  headers: Record<string, string>,
): WebSocket {
  const options = { headers, perMessageDeflate: false as const }
  return protocols && protocols.length > 0 ? new WebSocket(wsUrl, protocols, options) : new WebSocket(wsUrl, options)
}

type WsFrame = { data: WebSocket.RawData; isBinary: boolean }

function isBinaryFrame(isBinary: boolean, data: WebSocket.RawData): boolean {
  if (typeof isBinary === 'boolean') return isBinary
  if (typeof data === 'string') return false
  // ttyd/vite HMR use binary frames; `undefined` must not default to text.
  return true
}

function sendFrame(target: WebSocket, frame: WsFrame): void {
  if (target.readyState !== WebSocket.OPEN) return
  target.send(frame.data, { binary: isBinaryFrame(frame.isBinary, frame.data) })
}

function flushQueue(target: WebSocket, queue: WsFrame[]): void {
  while (queue.length > 0) {
    const frame = queue.shift()
    if (frame) sendFrame(target, frame)
  }
}

/** Bidirectional bridge; queues early ttyd handshake until upstream is open. */
export function bridgeSockets(client: WebSocket, upstream: WebSocket): void {
  const clientToUpstream: WsFrame[] = []
  const upstreamToClient: WsFrame[] = []

  const onClientMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    const frame = { data, isBinary }
    if (upstream.readyState === WebSocket.OPEN) sendFrame(upstream, frame)
    else clientToUpstream.push(frame)
  }
  const onUpstreamMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    const frame = { data, isBinary }
    if (client.readyState === WebSocket.OPEN) sendFrame(client, frame)
    else upstreamToClient.push(frame)
  }

  client.on('message', onClientMessage)
  upstream.on('message', onUpstreamMessage)

  const flushPending = () => {
    flushQueue(upstream, clientToUpstream)
    flushQueue(client, upstreamToClient)
  }

  if (upstream.readyState === WebSocket.OPEN) flushPending()
  else upstream.once('open', flushPending)

  const closeBoth = () => {
    client.removeListener('message', onClientMessage)
    upstream.removeListener('message', onUpstreamMessage)
    if (client.readyState === WebSocket.OPEN) client.close()
    if (upstream.readyState === WebSocket.OPEN) upstream.close()
  }

  client.on('close', closeBoth)
  upstream.on('close', closeBoth)
}

export function attachPreviewWebSocketProxy(server: Server): void {
  server.prependListener('upgrade', (req, socket, head) => {
    const rawUrl = req.url ?? '/'
    const pathname = rawUrl.split('?')[0] ?? rawUrl
    const match = PREVIEW_WS_RE.exec(pathname)
    if (!match) return

    const taskId = match[1]
    const port = match[2]
    const subpath = match[3] ?? '/'
    const query = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : ''

    void (async () => {
      const sandbox = await resolveSandboxForTaskWs(req, taskId)
      if (!sandbox) {
        if (socket.writable) socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const publicPortNum = Number(port)
      const gatewayPort =
        publicPortNum === TTYD_VIRTUAL_PORT ? String(await resolveGatewayPreviewPort(sandbox, TTYD_VIRTUAL_PORT)) : port
      const previewPath = buildUpstreamPath(gatewayPort, subpath)
      const wsUrl = buildGatewayWebSocketUrl(sandbox.baseUrl, previewPath, query)
      const upstreamHeaders = buildUpstreamGatewayWsHeaders(await sandbox.getAuthHeaders())
      const clientProtocols = parseClientWsProtocols(req)

      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const upstreamWs = connectUpstreamPreviewWebSocket(wsUrl, clientProtocols, upstreamHeaders)
        bridgeSockets(clientWs, upstreamWs)

        clientWs.on('ping', (data) => {
          if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.ping(data)
        })
        clientWs.on('pong', (data) => {
          if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.pong(data)
        })
        upstreamWs.on('ping', (data) => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.ping(data)
        })
        upstreamWs.on('pong', (data) => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.pong(data)
        })

        upstreamWs.on('unexpected-response', (_proxyReq, res) => {
          console.warn('[preview-ws-proxy] upstream rejected WebSocket upgrade')
          console.error('[preview-ws-proxy] upstream upgrade HTTP status:', res.statusCode)
          if (socket.writable && !socket.destroyed) {
            socket.write(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? 'Bad Gateway'}\r\n\r\n`)
          }
          clientWs.close()
          upstreamWs.terminate()
        })

        upstreamWs.on('error', () => {
          console.warn('[preview-ws-proxy] upstream WebSocket error')
          clientWs.close()
        })

        clientWs.on('error', () => {
          upstreamWs.terminate()
        })
      })
    })().catch((err) => {
      console.warn('[preview-ws-proxy] handler error:', (err as Error).message)
      socket.destroy()
    })
  })
}
