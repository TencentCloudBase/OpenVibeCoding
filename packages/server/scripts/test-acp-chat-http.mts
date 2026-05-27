#!/usr/bin/env tsx
/**
 * HTTP 完整 chat e2e 测试：
 *
 * 跑一个迷你 Hono app，装上 /api/agent/runtimes 路由（从真实 routes/acp.ts）
 * 与一个 /chat-test 路由（复制 routes/acp.ts 的 /chat 逻辑但 bypass auth）。
 *
 * 走完整 SSE 流，验证 runtime=opencode-acp 时整条链路的 HTTP 行为。
 *
 * 用法（packages/server 目录）：
 *   npx tsx --env-file=../../.env.local scripts/test-acp-chat-http.mts
 */

import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import type { AgentCallback, AgentCallbackMessage } from '@coder/shared'
import { agentRuntimeRegistry } from '../src/agent/runtime/index.js'
import { CloudbaseAgentService } from '../src/agent/cloudbase-agent.service.js'

const PORT = 38766

const app = new Hono()

// --- /runtimes（公开） ---
app.get('/api/agent/runtimes', async (c) => {
  const runtimes = agentRuntimeRegistry.list()
  const def = agentRuntimeRegistry.resolve()
  const items = await Promise.all(
    runtimes.map(async (r) => ({ name: r.name, available: await r.isAvailable().catch(() => false) })),
  )
  return c.json({ default: def.name, runtimes: items })
})

// --- /chat-test（bypass auth，复刻 /chat 核心逻辑） ---
app.post('/api/agent/chat-test', async (c) => {
  const body = await c.req.json<{ prompt: string; conversationId?: string; runtime?: string; model?: string }>()
  const { prompt, conversationId, runtime: runtimeName, model } = body

  const actualConversationId = conversationId || uuidv4()
  const runtime = agentRuntimeRegistry.resolve({ explicitRuntime: runtimeName, conversationId: actualConversationId })

  return streamSSE(c, async (stream) => {
    const { turnId } = await runtime.chatStream(
      prompt,
      async (msg: AgentCallbackMessage, seq?: number) => {
        const acpEvent = CloudbaseAgentService.convertToSessionUpdate(msg, actualConversationId)
        if (!acpEvent) return
        await stream.writeSSE({
          data: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: actualConversationId, update: acpEvent },
          }),
        })
      },
      {
        conversationId: actualConversationId,
        envId: '',
        userId: 'test-user',
        cwd: WORKDIR,
        model,
      } as never,
    )

    // 等 result / error
    let waited = 0
    while (waited < 90000) {
      await new Promise((r) => setTimeout(r, 500))
      waited += 500
      // 查 registry 状态
      const mod = await import('../src/agent/agent-registry.js')
      const run = mod.getAgentRun(actualConversationId)
      if (!run || run.status !== 'running') break
    }

    await stream.writeSSE({ data: '[DONE]' })
    console.log(`[chat-test handler] turnId=${turnId} finished`)
  })
})

const WORKDIR = '/tmp/opencode-chat-http-e2e'
fs.rmSync(WORKDIR, { recursive: true, force: true })
fs.mkdirSync(WORKDIR, { recursive: true })

const serverHandle = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[chat-e2e] test server on :${PORT}`)
})

await new Promise((r) => setTimeout(r, 500))

// 1. GET /runtimes
const runtimes = await fetch(`http://127.0.0.1:${PORT}/api/agent/runtimes`).then((r) => r.json())
console.log('[chat-e2e] /runtimes:', JSON.stringify(runtimes))

// 2. POST /chat-test with runtime=opencode-acp
console.log('[chat-e2e] calling /chat-test with runtime=opencode-acp ...')
const res = await fetch(`http://127.0.0.1:${PORT}/api/agent/chat-test`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: '请用一句话说明你是谁，不需要调任何工具',
    conversationId: 'chat-e2e-' + Date.now(),
    runtime: 'opencode-acp',
    model: 'moonshot/kimi-k2-0905-preview',
  }),
})
console.log(`[chat-e2e] status=${res.status} content-type=${res.headers.get('content-type')}`)

if (!res.ok || !res.body) {
  console.error('[chat-e2e] FAIL: non-stream response')
  process.exit(1)
}

const events: Array<{ type: string; payload: unknown }> = []
const decoder = new TextDecoder()
let buffer = ''
const reader = res.body.getReader()
const startTime = Date.now()

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      events.push({ type: 'DONE', payload: null })
    } else {
      try {
        events.push({ type: 'session/update', payload: JSON.parse(data) })
      } catch {
        /* ignore */
      }
    }
  }
  if (Date.now() - startTime > 120000) break
}

console.log(`\n[chat-e2e] received ${events.length} SSE events`)

const byTag: Record<string, number> = {}
for (const e of events) {
  if (e.type === 'session/update') {
    const tag = (e.payload as { params?: { update?: { sessionUpdate?: string } } })?.params?.update?.sessionUpdate || '?'
    const key = `update:${tag}`
    byTag[key] = (byTag[key] ?? 0) + 1
  } else {
    byTag[e.type] = (byTag[e.type] ?? 0) + 1
  }
}
console.log('[chat-e2e] event type distribution:', JSON.stringify(byTag, null, 2))

const textChunks = events
  .filter((e) => e.type === 'session/update')
  .map((e) => (e.payload as { params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }).params?.update)
  .filter(
    (u): u is { sessionUpdate: string; content: { text: string } } =>
      u?.sessionUpdate === 'agent_message_chunk' && !!u?.content?.text,
  )
  .map((u) => u.content.text)
  .join('')

console.log('\n[chat-e2e] agent text:', textChunks || '(empty)')

const hasDone = events.some((e) => e.type === 'DONE')
const hasText = textChunks.length > 0

console.log('\n[chat-e2e] assertions:')
console.log(`  stream completed with [DONE]: ${hasDone ? 'PASS' : 'FAIL'}`)
console.log(`  received agent text:          ${hasText ? 'PASS' : 'FAIL'}`)

const passed = hasDone && hasText
console.log(`\n[chat-e2e] OVERALL: ${passed ? 'PASS' : 'FAIL'}`)

fs.writeFileSync(
  '/tmp/acp-chat-http-e2e-report.json',
  JSON.stringify({ timestamp: new Date().toISOString(), eventCounts: byTag, agentText: textChunks, passed }, null, 2),
)

await serverHandle.close()
process.exit(passed ? 0 : 1)
