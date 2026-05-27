#!/usr/bin/env tsx
/**
 * 持久化挂起态 e2e：
 *
 * 验证挂起场景（AskUserQuestion 等用户答）期间 DB 可见部分完整状态，
 * 用户答复后 DB 继续补充剩余 parts 和 finalize status。
 *
 * 场景：
 *   Round 1 发 prompt 让 LLM 调 AskUserQuestion
 *   等到 ask_user 事件（挂起）→ **此时另一视角**调 loadDBMessages 读 DB
 *     断言：assistant record 的 parts 里已有 tool_call（AskUserQuestion，status=in_progress）
 *           assistant.status 仍为 'pending'
 *   Round 2 发 askAnswers 恢复
 *   等到 result → 再读一次 DB
 *     断言：parts 补齐了 tool_result（状态 completed）+ 后续 text
 *           assistant.status = 'done'
 *
 * 用法：
 *   npx tsx --env-file=../../.env.local scripts/test-persistence-suspend-e2e.mts
 */

import 'dotenv/config'
import fs from 'node:fs'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const envId = process.env.TCB_ENV_ID
if (!envId) {
  console.error('TCB_ENV_ID not set')
  process.exit(1)
}

// 启动 mini server 提供 /internal/ask-user
const app = new Hono()
const { default: acpRoutes } = await import('../src/routes/acp.js')
app.route('/api/agent', acpRoutes)

let assignedPort = 0
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
  assignedPort = info.port
})
await new Promise((r) => setTimeout(r, 300))
process.env.ASK_USER_BASE_URL = `http://127.0.0.1:${assignedPort}`
console.log(`[suspend-e2e] ASK_USER_BASE_URL=${process.env.ASK_USER_BASE_URL}`)

const { opencodeAcpRuntime } = await import('../src/agent/runtime/opencode-acp-runtime.js')
const { persistenceService } = await import('../src/agent/persistence.service.js')
import type { AgentCallbackMessage, UnifiedMessagePart } from '@coder/shared'

const userId = 'suspend-e2e-' + Date.now()
const conversationId = 'suspend-conv-' + Date.now()
console.log(`[suspend-e2e] conv=${conversationId}\n`)

// e2e 专用目录（不会被真的用，AskUser 才是主线）
const WORKDIR = '/tmp/opencode-suspend-e2e-' + Date.now()
fs.mkdirSync(WORKDIR, { recursive: true })

const events: AgentCallbackMessage[] = []
const cb = async (msg: AgentCallbackMessage) => {
  events.push(msg)
  if (msg.type === 'tool_use') console.log(`\n[tool_use] ${msg.name}`)
  else if (msg.type === 'ask_user') console.log(`[ask_user]`)
  else if (msg.type === 'text' && msg.content) process.stdout.write(msg.content)
  else if (msg.type === 'tool_result') console.log(`[tool_result] is_error=${msg.is_error}`)
  else if (msg.type === 'result') console.log(`\n[result]`)
}

console.log('[suspend-e2e] === Round 1: LLM 调 AskUserQuestion ===')
const { turnId } = await opencodeAcpRuntime.chatStream(
  `请使用 AskUserQuestion 工具问我：Framework，question="Which framework?"，options=[{label:"React", description:"..."},{label:"Vue", description:"..."}]，multiSelect=false。必须用这个工具。`,
  cb,
  {
    conversationId,
    envId,
    userId,
    cwd: WORKDIR,
    model: 'moonshot/kimi-k2-0905-preview',
  },
)
console.log(`[suspend-e2e] turnId=${turnId}`)

// 等 ask_user 事件
console.log('[suspend-e2e] waiting for ask_user event ...')
let askEvent: AgentCallbackMessage | undefined
const askTimeout = Date.now() + 60_000
while (Date.now() < askTimeout) {
  askEvent = events.find((e) => e.type === 'ask_user')
  if (askEvent) break
  if (events.find((e) => e.type === 'result' || e.type === 'error')) {
    console.error('[suspend-e2e] FAIL: got result/error before ask_user')
    server.close()
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 200))
}
if (!askEvent) {
  console.error('[suspend-e2e] FAIL: no ask_user within 60s')
  server.close()
  process.exit(1)
}

// 稍等让 flushToDb 完成
await new Promise((r) => setTimeout(r, 2000))

// ── ★ 关键检查：挂起期间读 DB ──
console.log('\n[suspend-e2e] === 挂起期间读 DB ===')
const midRecords = await persistenceService.loadDBMessages(conversationId, envId, userId, 20)
console.log(`[suspend-e2e] mid records count: ${midRecords.length}`)
for (const r of midRecords) {
  console.log(
    `  - ${r.role} status=${r.status} parts=${r.parts.length} [${r.parts.map((p: UnifiedMessagePart) => `${p.contentType}(${(p.metadata?.status as string | undefined) ?? '-'})`).join(', ')}]`,
  )
}

const midAssistant = midRecords.find((r) => r.role === 'assistant')
const midHasPendingStatus = midAssistant?.status === 'pending'
const midHasToolCall = midAssistant?.parts.some((p: UnifiedMessagePart) => p.contentType === 'tool_call')
const midHasToolResult = midAssistant?.parts.some((p: UnifiedMessagePart) => p.contentType === 'tool_result')
// 挂起时不应该有 tool_result
const midCorrect = midHasPendingStatus && midHasToolCall && !midHasToolResult

console.log(`\n[suspend-e2e] 挂起期间断言：`)
console.log(`  assistant.status == 'pending':     ${midHasPendingStatus ? 'PASS' : 'FAIL'} (${midAssistant?.status})`)
console.log(`  parts 含 tool_call:                ${midHasToolCall ? 'PASS' : 'FAIL'}`)
console.log(`  parts 尚无 tool_result:            ${!midHasToolResult ? 'PASS' : 'FAIL'}`)
if (!midCorrect) {
  console.error('\n[suspend-e2e] 挂起态不对，放弃')
  server.close()
  process.exit(1)
}

// ── Round 2: 模拟用户答复 ──
console.log('\n[suspend-e2e] === Round 2: user answers ===')
const questions = (askEvent.input as { questions: Array<{ header: string; options: Array<{ label: string }> }> }).questions
const firstHeader = questions[0].header
const chosen = questions[0].options[0].label
console.log(`[suspend-e2e] answer: ${firstHeader}="${chosen}"`)

await opencodeAcpRuntime.chatStream('', cb, {
  conversationId,
  envId,
  userId,
  cwd: WORKDIR,
  model: 'moonshot/kimi-k2-0905-preview',
  askAnswers: {
    [askEvent.id!]: {
      toolCallId: askEvent.id!,
      answers: { [firstHeader]: chosen },
    },
  },
})

// 等最终 result
const finalTimeout = Date.now() + 120_000
while (Date.now() < finalTimeout) {
  // 这里 events 已累积所有，但 result 可能还没到
  const r = events.filter((e) => e.type === 'result')
  // 第一轮 ask_user 之前无 result；第二轮恢复后会有 result
  if (r.length > 0) break
  if (events.find((e) => e.type === 'error')) break
  await new Promise((r) => setTimeout(r, 300))
}

// 让 finalize 落库
await new Promise((r) => setTimeout(r, 3000))

// ── 最终读 DB ──
console.log('\n[suspend-e2e] === 最终读 DB ===')
const finalRecords = await persistenceService.loadDBMessages(conversationId, envId, userId, 20)
console.log(`[suspend-e2e] final records count: ${finalRecords.length}`)
for (const r of finalRecords) {
  console.log(
    `  - ${r.role} status=${r.status} parts=${r.parts.length} [${r.parts.map((p: UnifiedMessagePart) => `${p.contentType}(${(p.metadata?.status as string | undefined) ?? '-'})`).join(', ')}]`,
  )
}

const finalAssistant = finalRecords.find((r) => r.role === 'assistant')
const finalDone = finalAssistant?.status === 'done'
const finalHasToolCall = finalAssistant?.parts.some((p: UnifiedMessagePart) => p.contentType === 'tool_call')
const finalHasToolResult = finalAssistant?.parts.some((p: UnifiedMessagePart) => p.contentType === 'tool_result')
const finalToolCompleted = finalAssistant?.parts.some(
  (p: UnifiedMessagePart) => p.contentType === 'tool_call' && p.metadata?.status === 'completed',
)

console.log(`\n[suspend-e2e] 最终断言：`)
console.log(`  assistant.status == 'done':        ${finalDone ? 'PASS' : 'FAIL'} (${finalAssistant?.status})`)
console.log(`  parts 含 tool_call:                ${finalHasToolCall ? 'PASS' : 'FAIL'}`)
console.log(`  parts 含 tool_result:              ${finalHasToolResult ? 'PASS' : 'FAIL'}`)
console.log(`  tool_call.metadata.status=completed:${finalToolCompleted ? 'PASS' : 'FAIL'}`)

// cleanup
try {
  await persistenceService.deleteConversationMessages(conversationId, envId, userId)
} catch {
  /* noop */
}

const overall = midCorrect && finalDone && finalHasToolCall && finalHasToolResult && finalToolCompleted
console.log(`\n[suspend-e2e] OVERALL: ${overall ? 'PASS' : 'FAIL'}`)

server.close()
process.exit(overall ? 0 : 1)
