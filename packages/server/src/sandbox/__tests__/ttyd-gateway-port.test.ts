import { describe, expect, it } from 'vitest'
import { parseTtydBackendPortFromCmdline } from '../ttyd-gateway-port.js'

describe('parseTtydBackendPortFromCmdline', () => {
  it('parses ttyd backend port from pgrep line', () => {
    expect(parseTtydBackendPortFromCmdline('442 ttyd -W -p 29100 bash -l')).toBe(29100)
  })

  it('returns null for out-of-range port', () => {
    expect(parseTtydBackendPortFromCmdline('ttyd -W -p 7681 bash')).toBeNull()
  })

  it('returns null when ttyd missing', () => {
    expect(parseTtydBackendPortFromCmdline('')).toBeNull()
  })
})
