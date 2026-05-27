import { describe, expect, it } from 'vitest'
import { isBundledServerArtifact } from '../loader.js'

describe('isBundledServerArtifact', () => {
  it('flags tsup dist chunks', () => {
    expect(isBundledServerArtifact('chunk-4EL5ZUGZ.js')).toBe(true)
    expect(isBundledServerArtifact('ttyd-preview-JUB6GMYX.js')).toBe(true)
    expect(isBundledServerArtifact('index.js')).toBe(true)
  })

  it('allows policy modules', () => {
    expect(isBundledServerArtifact('auth.ts')).toBe(false)
    expect(isBundledServerArtifact('cronTask.js')).toBe(false)
  })
})
