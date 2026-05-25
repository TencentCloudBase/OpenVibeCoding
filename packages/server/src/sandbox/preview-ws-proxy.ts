/**
 * WebSocket upgrade proxy: browser → OpenVibeCoding → 沙箱业务镜像 /preview/{port}/ (vite HMR).
 */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { resolveSandboxForTaskWs } from './ws-auth.js'

const PREVIEW_WS_RE = /^\/api\/tasks\/([^/]+)\/preview\/(\d+)(\/.*)?$/

function buildUpstreamPath(port: string, subpath: string | undefined): string {
  const suffix = subpath && subpath !== '/' ? (subpath.startsWith('/') ? subpath : `/${subpath}`) : '/'
  return `/preview/${port}${suffix}`
}

function pipeSockets(a: Duplex, b: Duplex): void {
  a.pipe(b)
  b.pipe(a)
  const onClose = () => {
    a.destroy()
    b.destroy()
  }
  a.on('close', onClose)
  b.on('close', onClose)
  a.on('error', onClose)
  b.on('error', onClose)
}

export function attachPreviewWebSocketProxy(server: Server): void {
  server.on('upgrade', (req, clientSocket, _head) => {
    const url = req.url ?? '/'
    const match = PREVIEW_WS_RE.exec(url.split('?')[0] ?? url)
    if (!match) return

    const taskId = match[1]
    const port = match[2]
    const subpath = match[3] ?? '/'

    void (async () => {
      const sandbox = await resolveSandboxForTaskWs(req, taskId)
      if (!sandbox) {
        if (clientSocket.writable) clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        clientSocket.destroy()
        return
      }

      const upstreamPath = buildUpstreamPath(port, subpath)
      const base = new URL(sandbox.baseUrl)
      const query = url.includes('?') ? url.slice(url.indexOf('?')) : ''
      const targetPath = `${upstreamPath}${query}`

      const authHeaders = await sandbox.getAuthHeaders()
      const forwardHeaders: Record<string, string | string[] | undefined> = { ...req.headers }
      delete forwardHeaders.host
      for (const [k, v] of Object.entries(authHeaders)) {
        forwardHeaders[k] = v
      }

      const requestFn = base.protocol === 'https:' ? https.request : http.request
      const proxyReq = requestFn({
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: targetPath,
        method: req.method,
        headers: forwardHeaders,
      })

      proxyReq.on('upgrade', (res, upstreamSocket, upgradeHead) => {
        const statusLine = `HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}`
        const headerLines = Object.entries(res.headers)
          .flatMap(([key, values]) => (Array.isArray(values) ? values : [values]).map((v) => `${key}: ${v}`))
          .join('\r\n')
        clientSocket.write(`${statusLine}\r\n${headerLines}\r\n\r\n`)
        if (upgradeHead.length > 0) upstreamSocket.write(upgradeHead)
        pipeSockets(clientSocket, upstreamSocket)
      })

      proxyReq.on('error', (err) => {
        console.warn('[preview-ws-proxy] upstream error:', (err as Error).message)
        if (clientSocket.writable) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        clientSocket.destroy()
      })

      proxyReq.on('response', (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          clientSocket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? 'Error'}\r\n\r\n`)
          clientSocket.destroy()
        }
      })

      proxyReq.end()
    })().catch((err) => {
      console.warn('[preview-ws-proxy] handler error:', (err as Error).message)
      clientSocket.destroy()
    })
  })
}
