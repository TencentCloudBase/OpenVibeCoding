import { describe, expect, it } from 'vitest'
import { buildGatewayWebSocketUrl, buildUpstreamGatewayWsHeaders, parseClientWsProtocols } from '../preview-ws-proxy.js'

describe('buildGatewayWebSocketUrl', () => {
  it('includes gateway path prefix before /preview/{port}/ws', () => {
    const url = buildGatewayWebSocketUrl('https://env.api.tcloudbasegateway.com/v1/sandbox/-', '/preview/29100/ws')
    expect(url).toBe('wss://env.api.tcloudbasegateway.com/v1/sandbox/-/preview/29100/ws')
  })

  it('preserves query string', () => {
    const url = buildGatewayWebSocketUrl(
      'https://env.api.tcloudbasegateway.com/v1/sandbox/-/',
      '/preview/5173/ws',
      '?token=abc',
    )
    expect(url).toBe('wss://env.api.tcloudbasegateway.com/v1/sandbox/-/preview/5173/ws?token=abc')
  })
})

describe('buildUpstreamGatewayWsHeaders', () => {
  it('passes only sandbox auth headers (no browser Origin)', () => {
    const headers = buildUpstreamGatewayWsHeaders({
      'X-Cloudbase-Authorization': 'Bearer key',
      'E2b-Sandbox-Id': 'sbx',
      'E2b-Sandbox-Port': '9000',
    })
    expect(headers).toEqual({
      'X-Cloudbase-Authorization': 'Bearer key',
      'E2b-Sandbox-Id': 'sbx',
      'E2b-Sandbox-Port': '9000',
    })
    expect(headers.origin).toBeUndefined()
  })
})

describe('parseClientWsProtocols', () => {
  it('parses tty subprotocol from Sec-WebSocket-Protocol', () => {
    const protocols = parseClientWsProtocols({
      headers: { 'sec-websocket-protocol': 'tty' },
    } as import('node:http').IncomingMessage)
    expect(protocols).toEqual(['tty'])
  })

  it('returns undefined when header missing', () => {
    expect(parseClientWsProtocols({ headers: {} } as import('node:http').IncomingMessage)).toBeUndefined()
  })
})
