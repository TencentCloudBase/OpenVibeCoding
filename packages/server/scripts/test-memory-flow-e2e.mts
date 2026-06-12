#!/usr/bin/env tsx
/**
 * 多轮会话连续性 + 中断恢复 + 记忆回溯 e2e
 *
 * 场景（用户真实使用模拟）：
 *   Turn 1:  user → "hello 我叫王小明"
 *            assistant → 问候回复（必须明确提到"王小明"表明已认知）
 *   Turn 2:  user → "我叫什么"
 *            assistant → 必须包含"王小明"（记忆能穿越不同 spawn 的 opencode 进程）
 *   Turn 3:  user → "请使用 AskUserQuestion 工具问我 1+1=?，选项 2 / 3 / 4"
 *            assistant → 调 AskUserQuestion，挂起
 *            [模拟用户答：2]
 *            assistant → tool_result 含 "2"，继续推理
 *   Turn 4:  user → "请总结一下我的名字以及我们的对话历史"
 *            assistant → 必须包含"王小明" + 提到 "1+1=2"
 *
 * 断言：
 *   - Turn 2 LLM 回答含"王小明"（上下文穿透）
 *   - Turn 3 产生 ask_user 事件
 *   - Turn 3 Resume 后得到 tool_result
 *   - Turn 4 LLM 回答同时含"王小明"和"1+1"或"2"（完整历史回溯）
 *   - DB 里最终 4 条 user record + 4 条 assistant record 全部 status=done
 *   - Turn 3 assistant 的 parts 含 tool_call(completed) + tool_result(completed)
 *
 * 用法：
 *   npx tsx --env-file=../../.env.local scripts/test-memory-flow-e2e.mts
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
console.log(`[memflow-e2e] ASK_USER_BASE_URL=http://127.0.0.1:${assignedPort}`)

const { opencodeAcpRuntime } = await import('../src/agent/runtime/opencode-acp-runtime.js')
const { persistenceService } = await import('../src/agent/persistence.service.js')
import type { AgentCallbackMessage, UnifiedMessagePart } from '@coder/shared'

const userId = 'memflow-' + Date.now()
const conversationId = 'memflow-conv-' + Date.now()
const WORKDIR = '/tmp/opencode-memflow-' + Date.now()
fs.mkdirSync(WORKDIR, { recursive: true })

console.log(`[memflow-e2e] conv=${conversationId}`)
console.log(`[memflow-e2e] userId=${userId}\n`)

// ── 通用帮助 ────────────────────────────────────────────────────────────
interface RecordedEv {
  ts: number
  type: string
  name?: string
  id?: string
  content?: string
  input?: unknown
}
const startT = Date.now()

/**
 * 跑一轮 prompt，返回 { events, assistantText, finished }
 * assistantText 是本轮 LLM 流式文本的拼接
 * finished = true 表示收到 result（无论是否 ask_user 中断）
 */
async function runTurn(label: string, prompt: string): Promise<{ events: RecordedEv[]; assistantText: string }> {
  console.log(`\n[memflow-e2e] ▶ ${label} — prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`)
  const evs: RecordedEv[] = []
  let assistantText = ''

  const cb = async (msg: AgentCallbackMessage) => {
    evs.push({
      ts: Date.now() - startT,
      type: msg.type,
      name: msg.name,
      id: msg.id,
      content: typeof msg.content === 'string' ? msg.content.slice(0, 200) : undefined,
      input: msg.input,
    })
    if (msg.type === 'text' && msg.content) {
      assistantText += msg.content
      process.stdout.write(msg.content)
    } else if (msg.type === 'tool_use') {
      console.log(`\n    [tool_use] ${msg.name}`)
    } else if (msg.type === 'ask_user') {
      console.log(`\n    [ask_user] id=${msg.id}`)
    } else if (msg.type === 'tool_result') {
      console.log(`\n    [tool_result] is_error=${msg.is_error}`)
    } else if (msg.type === 'result') {
      console.log(`\n    [result]`)
    } else if (msg.type === 'error') {
      console.log(`\n    [error] ${msg.content}`)
    }
  }

  await opencodeAcpRuntime.chatStream(prompt, cb, {
    conversationId,
    envId,
    userId,
    cwd: WORKDIR,
    model: 'moonshot/kimi-k2-0905-preview',
  })

  // 等 result / error / ask_user
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (evs.find((e) => e.type === 'result' || e.type === 'error' || e.type === 'ask_user')) break
    await new Promise((r) => setTimeout(r, 200))
  }

  // result 之后再多等 500ms 吸收最后几个 text chunk
  // (实测：opencode 的 SSE 推送顺序里，result 有时会先于最后一段 text chunk 到达)
  if (evs.find((e) => e.type === 'result')) {
    await new Promise((r) => setTimeout(r, 800))
  }

  return { events: evs, assistantText }
}

async function resumeWithAnswers(
  label: string,
  toolCallId: string,
  answers: Record<string, string>,
): Promise<{ events: RecordedEv[]; assistantText: string }> {
  console.log(`\n[memflow-e2e] ▶ ${label} — askAnswers: ${JSON.stringify(answers)}`)
  const evs: RecordedEv[] = []
  let assistantText = ''

  const cb = async (msg: AgentCallbackMessage) => {
    evs.push({
      ts: Date.now() - startT,
      type: msg.type,
      name: msg.name,
      id: msg.id,
      content: typeof msg.content === 'string' ? msg.content.slice(0, 200) : undefined,
    })
    if (msg.type === 'text' && msg.content) {
      assistantText += msg.content
      process.stdout.write(msg.content)
    } else if (msg.type === 'tool_result') {
      console.log(`\n    [tool_result] is_error=${msg.is_error} out=${(msg.content || '').slice(0, 100)}`)
    } else if (msg.type === 'result') {
      console.log(`\n    [result]`)
    } else if (msg.type === 'error') {
      console.log(`\n    [error] ${msg.content}`)
    }
  }

  await opencodeAcpRuntime.chatStream('', cb, {
    conversationId,
    envId,
    userId,
    cwd: WORKDIR,
    model: 'moonshot/kimi-k2-0905-preview',
    askAnswers: {
      [toolCallId]: { toolCallId, answers },
    },
  })

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (evs.find((e) => e.type === 'result' || e.type === 'error')) break
    await new Promise((r) => setTimeout(r, 200))
  }

  return { events: evs, assistantText }
}

// ── Turn 1: 自我介绍 ────────────────────────────────────────────────────
const t1 = await runTurn('Turn 1 — 自我介绍', 'hello，我叫王小明')
console.log()
// 让 finalize 完成（messageBuilder 异步落库）
await new Promise((r) => setTimeout(r, 2000))

// ── Turn 2: 问名字（考察 cross-spawn 记忆）─────────────────────────────────
const t2 = await runTurn('Turn 2 — 问名字', '我叫什么')
console.log()
await new Promise((r) => setTimeout(r, 2000))

// ── Turn 3: 要求 AskUser ────────────────────────────────────────────────
const t3 = await runTurn(
  'Turn 3 — 请 LLM 用 AskUserQuestion 工具',
  '请使用 AskUserQuestion 工具问我：question="1+1=?" header="Math" options=[{label:"2",description:"正确答案"},{label:"3",description:"错的"},{label:"4",description:"也错"}] multiSelect=false',
)

// 等 ask_user
const askEv = t3.events.find((e) => e.type === 'ask_user')
if (!askEv) {
  console.error('\n[memflow-e2e] FAIL: Turn 3 没触发 ask_user')
  console.log('events:', t3.events.slice(-10))
  server.close()
  process.exit(1)
}
console.log(`\n[memflow-e2e] ✓ Turn 3 ask_user received id=${askEv.id}`)

// 检查 input 结构（严格对齐）
const questions = (askEv.input as { questions: Array<{ header: string; options: Array<{ label: string }> }> }).questions
const header = questions[0].header
const chosenLabel = questions[0].options.find((o) => o.label === '2')?.label ?? questions[0].options[0].label
console.log(`[memflow-e2e] simulating user answer: ${header}="${chosenLabel}"`)

// ── Turn 3 Resume: 用户答 2 ──────────────────────────────────────────────
const t3r = await resumeWithAnswers('Turn 3 resume — user answers "2"', askEv.id!, { [header]: chosenLabel })
console.log()
await new Promise((r) => setTimeout(r, 3000))

// ── Turn 4: 总结 ──────────────────────────────────────────────────────────
const t4 = await runTurn(
  'Turn 4 — 总结',
  '请总结一下我的名字，以及我们之前对话里发生了什么（我问了什么，你调了什么工具，我回答了什么）',
)
console.log()
await new Promise((r) => setTimeout(r, 2000))

// ── 验证 ──────────────────────────────────────────────────────────────
console.log('\n\n[memflow-e2e] === validation ===')

// A. Turn 2 文本是否含 "王小明"
const t2MentionsName = /王小明/.test(t2.assistantText)

// B. Turn 3 产生 ask_user
const t3HasAskUser = !!askEv

// C. Turn 3 resume 后有 tool_result
const t3rHasToolResult = t3r.events.some((e) => e.type === 'tool_result')

// D. Turn 4 同时含"王小明"和"1+1"或"2"
const t4MentionsName = /王小明/.test(t4.assistantText)
const t4MentionsMath = /1\+1|1\s*\+\s*1|问.*数学|数学.*问|算术|2\b/.test(t4.assistantText)

// E. DB 状态检查
const finalRecords = await persistenceService.loadDBMessages(conversationId, envId, userId, 50)
console.log(`\n[memflow-e2e] final DB records: ${finalRecords.length}`)
for (const r of finalRecords) {
  const partsSig = r.parts
    .map((p: UnifiedMessagePart) => {
      if (p.contentType === 'text') return `text(${(p.content || '').slice(0, 30)}...)`
      if (p.contentType === 'tool_call') return `tool_call(${p.metadata?.toolName}:${p.metadata?.status})`
      if (p.contentType === 'tool_result') return `tool_result(${p.metadata?.status})`
      return p.contentType
    })
    .join(', ')
  console.log(`  - ${r.role} status=${r.status} parts=[${partsSig}]`)
}

const userCount = finalRecords.filter((r) => r.role === 'user').length
const assistantCount = finalRecords.filter((r) => r.role === 'assistant').length
const allDone = finalRecords.every((r) => r.status === 'done')

// F. Turn 3 的 assistant record 应含 tool_call + tool_result
const turn3Assistant = finalRecords.find(
  (r) =>
    r.role === 'assistant' &&
    r.parts.some((p: UnifiedMessagePart) => p.contentType === 'tool_call' && p.metadata?.toolName === 'AskUserQuestion'),
)
const t3HasToolCallInDb = !!turn3Assistant
const t3HasToolResultInDb = turn3Assistant?.parts.some((p: UnifiedMessagePart) => p.contentType === 'tool_result')

console.log('\n[memflow-e2e] assertions:')
console.log(`  Turn 2 回答含"王小明"（记忆穿透）:          ${t2MentionsName ? 'PASS' : 'FAIL'}`)
console.log(`  Turn 3 触发 ask_user:                       ${t3HasAskUser ? 'PASS' : 'FAIL'}`)
console.log(`  Turn 3 Resume 后 tool_result:               ${t3rHasToolResult ? 'PASS' : 'FAIL'}`)
console.log(`  Turn 4 回答含"王小明":                      ${t4MentionsName ? 'PASS' : 'FAIL'}`)
console.log(`  Turn 4 回答含"1+1"或"2"（记得工具交互）:    ${t4MentionsMath ? 'PASS' : 'FAIL'}`)
console.log(`  DB user records == 4:                       ${userCount === 4 ? 'PASS' : 'FAIL'} (${userCount})`)
console.log(`  DB assistant records == 4:                  ${assistantCount === 4 ? 'PASS' : 'FAIL'} (${assistantCount})`)
console.log(`  DB 全部 status=done:                        ${allDone ? 'PASS' : 'FAIL'}`)
console.log(`  Turn 3 assistant 含 AskUserQuestion tool_call: ${t3HasToolCallInDb ? 'PASS' : 'FAIL'}`)
console.log(`  Turn 3 assistant 含 tool_result:            ${t3HasToolResultInDb ? 'PASS' : 'FAIL'}`)

// 清理
try {
  await persistenceService.deleteConversationMessages(conversationId, envId, userId)
} catch {
  /* noop */
}

const overall =
  t2MentionsName &&
  t3HasAskUser &&
  t3rHasToolResult &&
  t4MentionsName &&
  t4MentionsMath &&
  userCount === 4 &&
  assistantCount === 4 &&
  allDone &&
  t3HasToolCallInDb &&
  !!t3HasToolResultInDb

console.log(`\n[memflow-e2e] OVERALL: ${overall ? 'PASS' : 'FAIL'}`)

// 打印关键文本摘要供人工观察
console.log('\n[memflow-e2e] assistant replies summary:')
console.log(`  T1 text (${t1.assistantText.length} chars): ${t1.assistantText.slice(0, 120)}...`)
console.log(`  T2 text (${t2.assistantText.length} chars): ${t2.assistantText.slice(0, 200)}`)
console.log(`  T3 text (${t3.assistantText.length} chars): ${t3.assistantText.slice(0, 120)}`)
console.log(`  T3r text (${t3r.assistantText.length} chars): ${t3r.assistantText.slice(0, 200)}`)
console.log(`  T4 text (${t4.assistantText.length} chars): ${t4.assistantText.slice(0, 400)}`)

server.close()
process.exit(overall ? 0 : 1)
