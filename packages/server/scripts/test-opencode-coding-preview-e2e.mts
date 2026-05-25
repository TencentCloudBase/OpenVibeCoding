#!/usr/bin/env tsx
/**
 * 【过时】上游 main 保留的 SCF 环境 e2e，feature/stateful-infra 分支请勿运行。
 * 依赖 `scf-sandbox-manager`，仅适用于 SCF 沙箱；AGS + 沙箱业务镜像请用 verify-stateful-e2e.ts。
 * Stateful: `npx tsx --env-file=.env scripts/verify-stateful-e2e.ts`
 *
 * E2E: OpenCode runtime + coding mode + preview + 第二轮修改
 *
 * 验证目标：
 *  Round 1: hi 激活 → 沙箱初始化 + coding 模板 + Vite dev server 启动
 *           → previewUrl 标记 ready，预览路径可访问
 *  Round 2: 让 agent 修改 src/App.tsx 中某个文案 → 用 read+write 工具
 *           → 重新拉预览，验证内容变更体现在 dev server 输出中
 *
 * 用法：
 *   cd packages/server
 *   npx tsx --env-file=.env scripts/test-opencode-coding-preview-e2e.mts
 */

import 'dotenv/config'
import { opencodeAcpRuntime } from '../src/agent/runtime/opencode-acp-runtime.js'
import { scfSandboxManager } from '../src/sandbox/scf-sandbox-manager.js'
import { getDb } from '../src/db/index.js'
import type { AgentCallbackMessage } from '@coder/shared'

const envId = process.env.TCB_ENV_ID
if (!envId) {
  console.error('TCB_ENV_ID not set')
  process.exit(1)
}

const conversationId = `opencode-coding-e2e-${Date.now()}`
const userId = 'e2e-coding-user'

// 用一个有标记的 marker 字符串，便于在 round 2 中验证替换成功
// 用普通可读词避免被模型内容审核误判
const ROUND1_PROMPT = 'hi'
const TITLE_MARKER = `我的精彩应用`
const ROUND2_PROMPT = `请帮我把项目 index.html 的网页标题（title 标签）改成"${TITLE_MARKER}"。简单地说：用 read 工具读 index.html，然后用 edit 或 write 工具把 <title>...</title> 之间的文字替换成"${TITLE_MARKER}"，做完告诉我即可。`

console.log('=== OpenCode coding mode preview e2e ===')
console.log(`envId        = ${envId}`)
console.log(`conversationId = ${conversationId}`)
console.log(`titleMarker  = ${TITLE_MARKER}\n`)

// ─── Helpers ────────────────────────────────────────────────────────────

interface Recorded {
  type: string
  name?: string
  preview?: string
}

function makeRecorder(label: string): {
  cb: (msg: AgentCallbackMessage) => Promise<void>
  events: Recorded[]
} {
  const events: Recorded[] = []
  const cb = async (msg: AgentCallbackMessage): Promise<void> => {
    events.push({
      type: msg.type,
      name: msg.name,
      preview: typeof msg.content === 'string' ? msg.content.slice(0, 200) : undefined,
    })
    if (msg.type === 'text' && msg.content) process.stdout.write(msg.content)
    else if (msg.type === 'tool_use')
      console.log(`\n[${label} tool_use ▶] ${msg.name} input=${JSON.stringify(msg.input).slice(0, 200)}`)
    else if (msg.type === 'tool_result')
      console.log(
        `[${label} tool_result ◯] tool_use_id=${msg.tool_use_id} is_error=${msg.is_error} out=${(msg.content || '').slice(0, 200)}`,
      )
    else if (msg.type === 'agent_phase') console.log(`\n[${label} phase] ${msg.phase}`)
    else if (msg.type === 'error') console.log(`\n[${label} error] ${msg.content}`)
    else if (msg.type === 'result') console.log(`\n[${label} result] ${(msg.content || '').slice(0, 200)}`)
  }
  return { cb, events }
}

async function waitForResultOrError(events: Recorded[], maxMs = 240_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (events.some((e) => e.type === 'result' || e.type === 'error')) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out after ${maxMs}ms waiting for result/error`)
}

// ─── Pre-flight: ensure DB ready, mark task as coding mode ──────────────

async function ensureTaskCodingMode(): Promise<void> {
  const now = Date.now()
  try {
    await getDb().tasks.create({
      id: conversationId,
      userId,
      prompt: ROUND1_PROMPT,
      title: null,
      repoUrl: null,
      selectedAgent: 'opencode' as any,
      selectedModel: 'mimo/mimo-v2.5-pro',
      selectedRuntime: 'opencode-acp',
      mode: 'coding',
      installDependencies: false,
      maxDuration: 30,
      keepAlive: false,
      enableBrowser: false,
      status: 'pending',
      progress: 0,
      logs: '[]',
      error: null,
      branchName: null,
      sandboxId: null,
      sandboxSessionId: envId,
      sandboxCwd: `/tmp/workspace/${envId}/${conversationId}`,
      sandboxMode: 'shared',
      agentSessionId: null,
      sandboxUrl: null,
      previewUrl: null,
      prUrl: null,
      prNumber: null,
      prStatus: null,
      prMergeCommitSha: null,
      mcpServerIds: null,
      createdAt: now,
      updatedAt: now,
    } as any)
    console.log(`[setup] task created (coding mode)`)
  } catch (e) {
    console.log(`[setup] task.create failed (may already exist): ${(e as Error).message}`)
  }
}

await ensureTaskCodingMode()

// ─── Round 1: hi → expect sandbox + coding init + dev server up ─────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Round 1: 激活 (hi) → 沙箱 + coding 项目 + dev server')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

const r1 = makeRecorder('R1')
const r1Start = Date.now()
const r1Result = await opencodeAcpRuntime.chatStream(ROUND1_PROMPT, r1.cb, {
  conversationId,
  envId,
  userId,
  mode: 'coding',
  model: 'mimo/mimo-v2.5-pro',
})
console.log(`\n[R1] chatStream returned: turnId=${r1Result.turnId}`)

await waitForResultOrError(r1.events, 240_000)
const r1Elapsed = ((Date.now() - r1Start) / 1000).toFixed(1)
console.log(`\n[R1] completed in ${r1Elapsed}s`)

// ─── Round 1 sandbox & dev server validation ────────────────────────────

console.log('\n[R1] === sandbox + dev server validation ===')

const sandbox = await scfSandboxManager.getOrCreate(conversationId, envId, {
  mode: 'shared',
  workspaceIsolation: 'shared',
  isCodingMode: true,
})

let scopeInfo: any = null
try {
  const headers = await sandbox.getAuthHeaders()
  const res = await fetch(`${sandbox.baseUrl}/api/scope/info`, { headers })
  scopeInfo = await res.json().catch(() => null)
  console.log(`[R1] scope/info: ${JSON.stringify(scopeInfo).slice(0, 400)}`)
} catch (e) {
  console.log(`[R1] scope/info error: ${(e as Error).message}`)
}

const workspace: string | undefined = scopeInfo?.workspace
const vitePort: number | undefined = scopeInfo?.vitePort
console.log(`[R1] workspace=${workspace} vitePort=${vitePort}`)

// Check that index.html exists in workspace
let indexHtmlExists = false
let indexHtmlContent = ''
try {
  const headers = await sandbox.getAuthHeaders()
  const res = await fetch(`${sandbox.baseUrl}/api/tools/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ path: 'index.html' }),
  })
  const data = (await res.json().catch(() => ({}))) as any
  if (data.success && typeof data.result?.content === 'string') {
    indexHtmlContent = data.result.content
    indexHtmlExists = true
    console.log(`[R1] index.html exists, size=${indexHtmlContent.length}`)
    const titleMatch = indexHtmlContent.match(/<title[^>]*>([^<]*)<\/title>/i)
    console.log(`[R1] current <title>: ${titleMatch?.[1] ?? '(no title)'}`)
  } else {
    console.log(`[R1] index.html read failed: ${JSON.stringify(data).slice(0, 200)}`)
  }
} catch (e) {
  console.log(`[R1] read index.html error: ${(e as Error).message}`)
}

// Check dev server preview path - 用 scope/info 返回的真实 previewUrl
const previewPath: string = scopeInfo?.previewUrl || (vitePort ? `/preview/${vitePort}/` : '/preview/')
let previewOk = false
let previewSnippet = ''
try {
  const headers = await sandbox.getAuthHeaders()
  const res = await fetch(`${sandbox.baseUrl}${previewPath}`, { headers, signal: AbortSignal.timeout(15000) })
  previewSnippet = (await res.text()).slice(0, 600)
  previewOk = res.ok && previewSnippet.length > 0
  console.log(
    `[R1] ${previewPath} status=${res.status} ok=${previewOk} snippet="${previewSnippet.slice(0, 200).replace(/\n/g, ' ')}"`,
  )
} catch (e) {
  console.log(`[R1] ${previewPath} error: ${(e as Error).message}`)
}

// Check task previewUrl in DB
const task1 = await getDb().tasks.findById(conversationId)
console.log(`[R1] task.previewUrl = ${task1?.previewUrl}`)

// ─── Round 2: ask agent to modify title ────────────────────────────────

console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('Round 2: 修改 index.html title → 验证预览更新')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

const r2 = makeRecorder('R2')
const r2Start = Date.now()
const r2Result = await opencodeAcpRuntime.chatStream(ROUND2_PROMPT, r2.cb, {
  conversationId,
  envId,
  userId,
  mode: 'coding',
  model: 'mimo/mimo-v2.5-pro',
})
console.log(`\n[R2] chatStream returned: turnId=${r2Result.turnId}`)

await waitForResultOrError(r2.events, 300_000)
const r2Elapsed = ((Date.now() - r2Start) / 1000).toFixed(1)
console.log(`\n[R2] completed in ${r2Elapsed}s`)

// ─── Round 2 validation: title changed in file & preview ───────────────

console.log('\n[R2] === modification validation ===')

let r2IndexContent = ''
try {
  const headers = await sandbox.getAuthHeaders()
  const res = await fetch(`${sandbox.baseUrl}/api/tools/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ path: 'index.html' }),
  })
  const data = (await res.json().catch(() => ({}))) as any
  if (data.success && typeof data.result?.content === 'string') {
    r2IndexContent = data.result.content
    const titleMatch = r2IndexContent.match(/<title[^>]*>([^<]*)<\/title>/i)
    console.log(`[R2] new <title>: ${titleMatch?.[1] ?? '(no title)'}`)
  }
} catch (e) {
  console.log(`[R2] read index.html error: ${(e as Error).message}`)
}

const fileHasMarker = r2IndexContent.includes(TITLE_MARKER)

// Wait a moment for vite HMR to pick up change, then re-fetch preview
await new Promise((r) => setTimeout(r, 3000))

let r2PreviewSnippet = ''
let previewHasMarker = false
try {
  const headers = await sandbox.getAuthHeaders()
  const res = await fetch(`${sandbox.baseUrl}${previewPath}`, { headers, signal: AbortSignal.timeout(15000) })
  r2PreviewSnippet = await res.text()
  previewHasMarker = r2PreviewSnippet.includes(TITLE_MARKER)
  const titleMatch = r2PreviewSnippet.match(/<title[^>]*>([^<]*)<\/title>/i)
  console.log(`[R2] preview <title>: ${titleMatch?.[1] ?? '(no title)'}  (status=${res.status})`)
} catch (e) {
  console.log(`[R2] ${previewPath} error: ${(e as Error).message}`)
}

// ─── Summary & assertions ──────────────────────────────────────────────

const r1Counts: Record<string, number> = {}
for (const e of r1.events) r1Counts[e.type] = (r1Counts[e.type] ?? 0) + 1
const r2Counts: Record<string, number> = {}
for (const e of r2.events) r2Counts[e.type] = (r2Counts[e.type] ?? 0) + 1

console.log('\n\n=========================================================')
console.log('FINAL SUMMARY')
console.log('=========================================================')
console.log(`R1 events:  ${JSON.stringify(r1Counts)}`)
console.log(`R2 events:  ${JSON.stringify(r2Counts)}`)
console.log()
console.log('R1 (sandbox + coding init):')
console.log(`  workspace path:               ${workspace ? 'PASS' : 'FAIL'}  (${workspace})`)
console.log(`  index.html exists:            ${indexHtmlExists ? 'PASS' : 'FAIL'}`)
console.log(`  /preview/ accessible:         ${previewOk ? 'PASS' : 'FAIL'}`)
console.log(`  task.previewUrl set:          ${task1?.previewUrl ? 'PASS' : 'FAIL'} (${task1?.previewUrl})`)
console.log(`  R1 has result event:          ${r1Counts.result ? 'PASS' : 'FAIL'}`)
console.log()
console.log('R2 (file modification + preview):')
console.log(`  R2 has result event:          ${r2Counts.result ? 'PASS' : 'FAIL'}`)
console.log(`  R2 used tools:                ${r2Counts.tool_use ? `PASS (${r2Counts.tool_use})` : 'FAIL'}`)
console.log(`  index.html contains marker:   ${fileHasMarker ? 'PASS' : 'FAIL'}`)
console.log(`  /preview/ contains marker:    ${previewHasMarker ? 'PASS' : 'FAIL'}`)

const r1Ok = !!workspace && indexHtmlExists && previewOk && (r1Counts.result ?? 0) > 0
const r2Ok = (r2Counts.result ?? 0) > 0 && (r2Counts.tool_use ?? 0) > 0 && fileHasMarker
const overall = r1Ok && r2Ok

console.log('\nOVERALL:', overall ? 'PASS ✓' : 'FAIL ✗')

process.exit(overall ? 0 : 1)
