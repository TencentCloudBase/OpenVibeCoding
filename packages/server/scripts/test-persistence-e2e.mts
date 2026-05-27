#!/usr/bin/env tsx
/**
 * 消息持久化端到端测试（OpenCode runtime）
 *
 * 验证链路：
 *   1. chatStream(prompt, envId=真实 TCB 环境)
 *   2. preSavePendingRecords → DB 有 user(done) + assistant(pending)
 *   3. LLM 执行 → 若工具调用，tool_result 触发 flushToDb
 *   4. finalize → status=done，最终 parts 写入
 *   5. loadDBMessages 读回 → 结构与预期一致
 *
 * 断言：
 *   A. DB 里能找到 user + assistant 两条 record
 *   B. assistant record status = 'done'
 *   C. assistant parts 数组至少含 1 个 text part（LLM 的回答）
 *   D. 如果有工具调用，parts 包含 tool_call + tool_result 对
 *   E. 前端 tasks.ts 转换逻辑能消化（模拟: 转成 TaskMessage 不报错）
 *
 * 用法：
 *   npx tsx --env-file=../../.env.local scripts/test-persistence-e2e.mts
 */

import 'dotenv/config'
import fs from 'node:fs'
import { opencodeAcpRuntime } from '../src/agent/runtime/opencode-acp-runtime.js'
import { persistenceService } from '../src/agent/persistence.service.js'
import type { AgentCallbackMessage, UnifiedMessagePart } from '@coder/shared'

const envId = process.env.TCB_ENV_ID
if (!envId) {
  console.error('TCB_ENV_ID not set — cannot run persistence e2e')
  process.exit(1)
}

const userId = 'persist-e2e-user-' + Date.now()
const conversationId = 'persist-e2e-' + Date.now()

console.log(`[persist-e2e] envId=${envId}`)
console.log(`[persist-e2e] userId=${userId}`)
console.log(`[persist-e2e] conversationId=${conversationId}\n`)

// ── Test workdir（本地，避免沙箱路径问题）─────────────────────────────────────
const WORKDIR = '/tmp/opencode-persist-e2e-' + Date.now()
fs.mkdirSync(WORKDIR, { recursive: true })

// ── 收集事件，仅用于观察 ─────────────────────────────────────────────────
const events: AgentCallbackMessage[] = []
const cb = async (msg: AgentCallbackMessage) => {
  events.push(msg)
  if (msg.type === 'text' && msg.content) process.stdout.write(msg.content)
  else if (msg.type === 'tool_use') console.log(`\n[tool_use ▶] ${msg.name} id=${msg.id}`)
  else if (msg.type === 'tool_result') console.log(`[tool_result ◯] is_error=${msg.is_error}`)
  else if (msg.type === 'result') console.log(`\n[result] ${msg.content?.slice(0, 100)}`)
  else if (msg.type === 'error') console.log(`[error] ${msg.content}`)
}

// ── 让 LLM 写一个文件，触发工具调用（让 parts 里必然有 tool_call+tool_result）─
// 不走沙箱（envId='' 会跳过），走本地 custom write tool
// 但 envId 必须传真实值才能落库，所以用 envId=真实、cwd=本地目录
console.log('[persist-e2e] === chatStream (with envId + local workdir) ===')
const prompt = `请用 write 工具在当前目录创建文件 persist.txt，内容正好一行：persistence works\n完成后简短确认。`

const { turnId } = await opencodeAcpRuntime.chatStream(prompt, cb, {
  conversationId,
  envId,
  userId,
  cwd: WORKDIR,
  model: 'moonshot/kimi-k2-0905-preview',
})
console.log(`[persist-e2e] chatStream turnId=${turnId}`)

// 等 result / error
console.log('\n[persist-e2e] waiting for result ...')
const timeout = Date.now() + 120_000
while (Date.now() < timeout) {
  if (events.find((e) => e.type === 'result' || e.type === 'error')) break
  await new Promise((r) => setTimeout(r, 300))
}

// 给 finalize 一点时间（它在 finally 里、异步写库）
await new Promise((r) => setTimeout(r, 2000))

// ── 从 DB 读回验证 ──────────────────────────────────────────────────────
console.log('\n\n[persist-e2e] === loadDBMessages ===')
const records = await persistenceService.loadDBMessages(conversationId, envId, userId, 20)
console.log(`[persist-e2e] records count: ${records.length}`)
for (const r of records) {
  console.log(
    `  - ${r.role} status=${r.status} recordId=${r.recordId.slice(0, 8)}... parts=${r.parts.length} ${r.parts.map((p: UnifiedMessagePart) => p.contentType).join(',')}`,
  )
}

// ── Assertions ──────────────────────────────────────────────────────────
const userRecord = records.find((r) => r.role === 'user')
const assistantRecord = records.find((r) => r.role === 'assistant')

const hasUser = !!userRecord
const hasAssistant = !!assistantRecord
const assistantDone = assistantRecord?.status === 'done'
const userHasTextPart = userRecord?.parts?.[0]?.contentType === 'text'
const userPromptMatches = userRecord?.parts?.[0]?.content?.includes('persist.txt') ?? false

const assistantParts = assistantRecord?.parts ?? []
const hasTextPart = assistantParts.some((p: UnifiedMessagePart) => p.contentType === 'text' && !!p.content)
const hasToolCallPart = assistantParts.some((p: UnifiedMessagePart) => p.contentType === 'tool_call')
const hasToolResultPart = assistantParts.some((p: UnifiedMessagePart) => p.contentType === 'tool_result')

// 校验 replyTo 链
const replyToOk = assistantRecord?.replyTo === userRecord?.recordId

// ── 模拟前端转换（验证前端 tasks.ts 逻辑不会挂）─────────────────────────
let frontendConvertOk = true
try {
  const frontMessages = records.map((record) => ({
    id: record.recordId,
    taskId: conversationId,
    role: record.role === 'user' ? 'user' : 'agent',
    parts: (record.parts || []).map((p: UnifiedMessagePart) => {
      if (p.contentType === 'text') return { type: 'text', text: p.content || '' }
      if (p.contentType === 'reasoning') return { type: 'thinking', text: p.content || '' }
      if (p.contentType === 'tool_call')
        return {
          type: 'tool_call',
          toolCallId: p.toolCallId || p.partId,
          toolName: (p.metadata?.toolCallName as string) || (p.metadata?.toolName as string) || 'tool',
          input: p.content || p.metadata?.input,
          status: p.metadata?.status,
        }
      if (p.contentType === 'tool_result')
        return {
          type: 'tool_result',
          toolCallId: p.toolCallId || p.partId,
          content: p.content || '',
          isError: p.metadata?.isError,
        }
      return { type: 'text', text: p.content || '' }
    }),
    status: record.status,
    createdAt: record.createTime,
  }))
  console.log(`\n[persist-e2e] frontend convert result: ${frontMessages.length} TaskMessage`)
  const userMsg = frontMessages.find((m) => m.role === 'user')
  const agentMsg = frontMessages.find((m) => m.role === 'agent')
  console.log(`  user parts:  ${userMsg?.parts.map((p) => p.type).join(',')}`)
  console.log(`  agent parts: ${agentMsg?.parts.map((p) => p.type).join(',')}`)
} catch (e) {
  console.error('[persist-e2e] frontend convert FAILED:', e)
  frontendConvertOk = false
}

console.log('\n[persist-e2e] assertions:')
console.log(`  records >= 2:                       ${records.length >= 2 ? 'PASS' : 'FAIL'} (${records.length})`)
console.log(`  user record exists:                 ${hasUser ? 'PASS' : 'FAIL'}`)
console.log(`  user text part w/ prompt content:   ${userHasTextPart && userPromptMatches ? 'PASS' : 'FAIL'}`)
console.log(`  assistant record exists:            ${hasAssistant ? 'PASS' : 'FAIL'}`)
console.log(`  assistant status='done':            ${assistantDone ? 'PASS' : 'FAIL'} (${assistantRecord?.status})`)
console.log(`  assistant has text part:            ${hasTextPart ? 'PASS' : 'FAIL'}`)
console.log(`  assistant has tool_call part:       ${hasToolCallPart ? 'PASS' : 'FAIL'}`)
console.log(`  assistant has tool_result part:     ${hasToolResultPart ? 'PASS' : 'FAIL'}`)
console.log(`  assistant.replyTo == userRecordId:  ${replyToOk ? 'PASS' : 'FAIL'}`)
console.log(`  frontend convert works:             ${frontendConvertOk ? 'PASS' : 'FAIL'}`)

// 清理（不要留 e2e 垃圾在生产环境）
console.log('\n[persist-e2e] cleanup...')
try {
  await persistenceService.deleteConversationMessages(conversationId, envId, userId)
  console.log('[persist-e2e] cleanup done')
} catch (e) {
  console.warn('[persist-e2e] cleanup failed:', (e as Error).message)
}

const overall =
  records.length >= 2 &&
  hasUser &&
  userHasTextPart &&
  userPromptMatches &&
  hasAssistant &&
  assistantDone &&
  hasTextPart &&
  hasToolCallPart &&
  hasToolResultPart &&
  replyToOk &&
  frontendConvertOk

console.log(`\n[persist-e2e] OVERALL: ${overall ? 'PASS' : 'FAIL'}`)
process.exit(overall ? 0 : 1)
