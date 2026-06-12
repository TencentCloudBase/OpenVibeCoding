import { describe, expect, it } from 'vitest'
import { parseMcporterSchemaContent } from '../stateful/stateful-mcp-client.js'

describe('parseMcporterSchemaContent', () => {
  it('parses clean JSON object', () => {
    const { tools } = parseMcporterSchemaContent('{"tools":[{"name":"envQuery"}]}')
    expect(tools).toHaveLength(1)
  })

  it('skips stderr prefix before JSON', () => {
    const { tools } = parseMcporterSchemaContent('warning: foo\n{"tools":[{"name":"a"}]}')
    expect(tools).toHaveLength(1)
  })

  it('accepts top-level array', () => {
    const { tools } = parseMcporterSchemaContent('[{"name":"a"}]')
    expect(tools).toHaveLength(1)
  })
})
