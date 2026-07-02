/**
 * Tests for the ACP JSON-RPC REQUEST protocol changes.
 *
 * Covers:
 *   1. convertToSessionUpdate → JsonRpcRequestPayload for ask_user / tool_confirm
 *   2. requestId — deterministic, no collisions
 *   3. formatSseData — session updates wrapped in session/update, REQUESTs sent as-is
 *   4. Resume logic — finds client/AskUserQuestion REQUESTs in stream events
 */
import { describe, it, expect } from 'vitest'
import { CloudbaseAgentService, type JsonRpcRequestPayload } from '../cloudbase-agent.service.js'
import type { AgentCallbackMessage } from '@coder/shared'

// Replicate formatSseData from routes/acp.ts (module-level function, not exported)
function formatSseData(sessionId: string, event: unknown): string {
  const evt = event as Record<string, unknown>
  if (evt && evt.jsonrpc === '2.0') {
    return JSON.stringify(evt)
  }
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: event },
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<AgentCallbackMessage> = {}): AgentCallbackMessage {
  return {
    id: 'tcu_test',
    type: 'tool_use',
    name: 'Write',
    input: { path: '/tmp/test.txt', content: 'hello' },
    assistantMessageId: 'msg_1',
    sessionId: 'sess_abc',
    ...overrides,
  } as AgentCallbackMessage
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CloudbaseAgentService.requestId', () => {
  it('produces deterministic id from sessionId + toolCallId', () => {
    expect(CloudbaseAgentService.requestId('sess_abc', 'tcu_1')).toBe('sess_abc:tcu_1')
    expect(CloudbaseAgentService.requestId('sess_abc', 'tcu_2')).toBe('sess_abc:tcu_2')
    expect(CloudbaseAgentService.requestId('sess_xyz', 'tcu_1')).toBe('sess_xyz:tcu_1')
  })

  it('no collisions across different sessions', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(CloudbaseAgentService.requestId(`sess_${i}`, `tcu_${i}`))
    }
    expect(ids.size).toBe(100)
  })
})

describe('convertToSessionUpdate — REQUEST emission', () => {
  it('ask_user → client/AskUserQuestion JSON-RPC REQUEST', () => {
    const result = CloudbaseAgentService.convertToSessionUpdate(
      makeMsg({
        type: 'ask_user',
        id: 'tcu_ask',
        input: { questions: [{ question: 'What?', header: 'Q', options: [], multiSelect: false }] },
      }),
      'sess_abc',
    )

    expect(result).not.toBeNull()
    const req = result as JsonRpcRequestPayload
    expect(req.jsonrpc).toBe('2.0')
    expect(req.id).toBe('sess_abc:tcu_ask')
    expect(req.method).toBe('client/AskUserQuestion')
    expect(req.params).toEqual({
      questions: [{ question: 'What?', header: 'Q', options: [], multiSelect: false }],
    })
    expect(req._meta).toEqual({
      sessionId: 'sess_abc',
      toolCallId: 'tcu_ask',
      assistantMessageId: 'msg_1',
    })
  })

  it('tool_confirm → session/request_permission JSON-RPC REQUEST', () => {
    const result = CloudbaseAgentService.convertToSessionUpdate(
      makeMsg({
        type: 'tool_confirm',
        id: 'tcu_write',
        name: 'Write',
        input: { path: '/tmp/test.txt', content: 'hello' },
      }),
      'sess_abc',
    )

    expect(result).not.toBeNull()
    const req = result as JsonRpcRequestPayload
    expect(req.jsonrpc).toBe('2.0')
    expect(req.id).toBe('sess_abc:tcu_write')
    expect(req.method).toBe('session/request_permission')
    expect(req.params.sessionId).toBe('sess_abc')
    expect(req.params.options).toEqual([
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ])
    const tc = req.params.toolCall as Record<string, unknown>
    expect(tc.toolCallId).toBe('tcu_write')
    expect(tc.title).toBe('Write')
    expect(tc.kind).toBe('edit')
    expect(tc.status).toBe('pending')
    expect(tc.rawInput).toEqual({ path: '/tmp/test.txt', content: 'hello' })
  })

  it('tool_confirm for ExitPlanMode includes planContent in _meta', () => {
    const result = CloudbaseAgentService.convertToSessionUpdate(
      makeMsg({
        type: 'tool_confirm',
        id: 'tcu_plan',
        name: 'ExitPlanMode',
        input: { plan: '# My Plan\nStep 1: ...' },
      }),
      'sess_abc',
    )

    expect(result).not.toBeNull()
    const req = result as JsonRpcRequestPayload
    const tc = req.params.toolCall as Record<string, unknown>
    const meta = tc._meta as Record<string, unknown> | undefined
    expect(meta?.ref).toBeDefined()
    expect((meta?.ref as any)?.planContent).toBe('# My Plan\nStep 1: ...')
  })

  it('tool_use → session update (not a REQUEST)', () => {
    const result = CloudbaseAgentService.convertToSessionUpdate(
      makeMsg({ type: 'tool_use', id: 'tcu_1', name: 'Bash', input: { command: 'ls' } }),
      'sess_abc',
    )

    expect(result).not.toBeNull()
    // Should be a session update, not a JsonRpcRequestPayload
    const update = result as Record<string, unknown>
    expect(update.sessionUpdate).toBe('tool_call')
    expect(update.toolCallId).toBe('tcu_1')
  })

  it('text → agent_message_chunk session update', () => {
    const result = CloudbaseAgentService.convertToSessionUpdate(
      makeMsg({ type: 'text', content: 'Hello world', id: undefined, name: undefined, input: undefined }),
      'sess_abc',
    )

    expect(result).not.toBeNull()
    const update = result as Record<string, unknown>
    expect(update.sessionUpdate).toBe('agent_message_chunk')
    expect((update.content as any)?.text).toBe('Hello world')
  })
})

describe('formatSseData', () => {
  const sessionId = 'sess_test'

  it('wraps bare session update in session/update notification', () => {
    const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
    const sse = formatSseData(sessionId, update)
    const parsed = JSON.parse(sse)

    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.method).toBe('session/update')
    expect(parsed.params.sessionId).toBe(sessionId)
    expect(parsed.params.update.sessionUpdate).toBe('agent_message_chunk')
  })

  it('sends JSON-RPC REQUEST as-is (no wrapping)', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'sess_abc:tcu_1',
      method: 'session/request_permission',
      params: { sessionId, toolCall: { toolCallId: 'tcu_1', title: 'Write' }, options: [] },
    }
    const sse = formatSseData(sessionId, request)
    const parsed = JSON.parse(sse)

    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.id).toBe('sess_abc:tcu_1')
    expect(parsed.method).toBe('session/request_permission')
    // Should not be nested inside session/update
    expect(parsed.params.sessionId).toBe(sessionId)
    expect(parsed.params.toolCall.toolCallId).toBe('tcu_1')
  })

  it('sends client/<ToolName> REQUEST as-is', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'sess_abc:tcu_ask',
      method: 'client/AskUserQuestion',
      params: { questions: [{ question: 'Test?', header: 'T', options: [], multiSelect: false }] },
      _meta: { sessionId: 'sess_abc', toolCallId: 'tcu_ask', assistantMessageId: 'msg_1' },
    }
    const sse = formatSseData(sessionId, request)
    const parsed = JSON.parse(sse)

    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed.id).toBe('sess_abc:tcu_ask')
    expect(parsed.method).toBe('client/AskUserQuestion')
    expect(parsed.params.questions).toHaveLength(1)
    expect(parsed._meta.toolCallId).toBe('tcu_ask')
  })
})

describe('Resume logic — finding AskUserQuestion events', () => {
  it('finds v3 client/AskUserQuestion REQUEST by toolCallId', () => {
    const events = [
      {
        eventId: 'evt_1',
        conversationId: 'conv_1',
        turnId: 'turn_1',
        envId: 'env_1',
        userId: 'user_1',
        seq: 1,
        createTime: Date.now(),
        event: {
          jsonrpc: '2.0',
          id: 'conv_1:tcu_ask',
          method: 'client/AskUserQuestion',
          params: { questions: [{ question: 'Test?', header: 'T', options: [], multiSelect: false }] },
          _meta: { sessionId: 'conv_1', toolCallId: 'tcu_ask', assistantMessageId: 'msg_1' },
        },
      },
    ]

    const found = events.find((evt) => {
      const e = evt.event as any
      if (e?.jsonrpc === '2.0' && e?.method === 'client/AskUserQuestion' && e?._meta?.toolCallId === 'tcu_ask') {
        return true
      }
      return false
    })

    expect(found).toBeDefined()
    expect((found!.event as any).params.questions[0].question).toBe('Test?')
  })

  it('finds v2 request_permission session update (backward compat)', () => {
    const events = [
      {
        eventId: 'evt_1',
        conversationId: 'conv_1',
        turnId: 'turn_1',
        envId: 'env_1',
        userId: 'user_1',
        seq: 1,
        createTime: Date.now(),
        event: {
          sessionUpdate: 'request_permission',
          sessionId: 'conv_1',
          toolCall: {
            toolCallId: 'tcu_ask',
            title: 'AskUserQuestion',
            kind: 'other',
            rawInput: { questions: [{ question: 'Old?', header: 'O', options: [], multiSelect: false }] },
          },
          options: [],
        },
      },
    ]

    const found = events.find((evt) => {
      const e = evt.event as any
      if (
        e?.sessionUpdate === 'request_permission' &&
        e?.toolCall?.toolCallId === 'tcu_ask' &&
        e?.toolCall?.title === 'AskUserQuestion'
      ) {
        return true
      }
      return false
    })

    expect(found).toBeDefined()
    expect((found!.event as any).toolCall.rawInput.questions[0].question).toBe('Old?')
  })

  it('finds v1 ask_user session update (oldest compat)', () => {
    const events = [
      {
        eventId: 'evt_1',
        conversationId: 'conv_1',
        turnId: 'turn_1',
        envId: 'env_1',
        userId: 'user_1',
        seq: 1,
        createTime: Date.now(),
        event: {
          sessionUpdate: 'ask_user',
          toolCallId: 'tcu_ask',
          questions: [{ question: 'Oldest?', header: 'OO', options: [], multiSelect: false }],
        },
      },
    ]

    const found = events.find((evt) => {
      const e = evt.event as any
      if (e?.sessionUpdate === 'ask_user' && e?.toolCallId === 'tcu_ask') {
        return true
      }
      return false
    })

    expect(found).toBeDefined()
    expect((found!.event as any).questions[0].question).toBe('Oldest?')
  })
})
