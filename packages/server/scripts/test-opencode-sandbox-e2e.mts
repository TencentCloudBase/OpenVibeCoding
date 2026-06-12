#!/usr/bin/env tsx
/**
 * 【过时】上游 main 保留的 SCF 环境 e2e，feature/stateful-infra 分支请勿运行。
 * 依赖 `scf-sandbox-manager`，仅适用于 SCF 沙箱；AGS + 沙箱业务镜像请用 verify-stateful-e2e.ts。
 * Stateful: `npx tsx scripts/verify-stateful-e2e.ts` (loads ../../.env.local)
 *
 * 沙箱隔离 e2e 测试（新架构 - tool override + env 注入）
 *
 * 验证链路：
 *   LLM → 调 write 工具 (被 ~/.config/opencode/tools/write.ts 覆盖)
 *       → 读 process.env.SANDBOX_BASE_URL + SANDBOX_AUTH_HEADERS_JSON
 *       → fetch 沙箱 /api/tools/write
 *       → 沙箱容器里真实写文件
 *
 * 断言：
 *   1. LLM 使用了 write 工具（名字就是 write，非 sbx_* 前缀）
 *   2. 直接调沙箱 /api/tools/read 能读到预期内容（独立验证）
 *   3. 本地文件系统未被污染
 *
 * 用法：
 *   npx tsx --env-file=../../.env.local scripts/test-opencode-sandbox-e2e.mts
 */

import 'dotenv/config'
import fs from 'node:fs'
import { opencodeAcpRuntime } from '../src/agent/runtime/opencode-acp-runtime.js'
import { scfSandboxManager } from '../src/sandbox/scf-sandbox-manager.js'
import type { AgentCallbackMessage } from '@coder/shared'

const envId = process.env.TCB_ENV_ID
if (!envId) {
  console.error('TCB_ENV_ID not set in env — cannot run sandbox e2e')
  process.exit(1)
}

const conversationId = 'sandbox-e2e-v2-' + Date.now()
const testFilename = `hello-sandbox-v2-${Date.now()}.txt`
const expectedContent = `hello from v2 ${Math.random().toString(36).slice(2, 10)}`
const sandboxRelPath = testFilename

console.log(`[sandbox-e2e-v2] envId=${envId}`)
console.log(`[sandbox-e2e-v2] conversationId=${conversationId}`)
console.log(`[sandbox-e2e-v2] testFile (relative)=${sandboxRelPath}`)
console.log(`[sandbox-e2e-v2] expectedContent=${JSON.stringify(expectedContent)}\n`)

// 清理潜在的本地同名文件（e2e 将验证本地不被污染）
const localMirror = `/tmp/${testFilename}`
try {
  fs.unlinkSync(localMirror)
} catch {
  /* noop */
}

interface RecordedEvent {
  type: string
  name?: string
  content?: string
}
const events: RecordedEvent[] = []

const cb = async (msg: AgentCallbackMessage): Promise<void> => {
  events.push({
    type: msg.type,
    name: msg.name,
    content: typeof msg.content === 'string' ? msg.content.slice(0, 180) : undefined,
  })
  if (msg.type === 'text' && msg.content) process.stdout.write(msg.content)
  else if (msg.type === 'tool_use')
    console.log(`\n[tool_use ▶] name=${msg.name} id=${msg.id} input=${JSON.stringify(msg.input).slice(0, 200)}`)
  else if (msg.type === 'tool_result')
    console.log(
      `[tool_result ◯] tool_use_id=${msg.tool_use_id} is_error=${msg.is_error} out=${(msg.content || '').slice(0, 200)}`,
    )
  else if (msg.type === 'agent_phase') console.log(`\n[phase] ${msg.phase}`)
  else if (msg.type === 'error') console.log(`\n[error] ${msg.content}`)
  else if (msg.type === 'result') console.log(`\n[result] ${msg.content}`)
}

console.log('[sandbox-e2e-v2] === starting chatStream (sandbox mode) ===')
const { turnId } = await opencodeAcpRuntime.chatStream(
  `请使用 write 工具创建文件 ${sandboxRelPath}（使用相对路径），内容**完全等于**这一个字符串：${expectedContent}\n不要加引号、不要加 markdown、不要多余换行、不要添加任何其他文字。完成后简短告诉我已完成。`,
  cb,
  {
    conversationId,
    envId,
    userId: 'e2e-user',
    model: 'moonshot/kimi-k2-0905-preview',
  },
)
console.log(`\n[sandbox-e2e-v2] chatStream returned: turnId=${turnId}`)

const startTime = Date.now()
while (Date.now() - startTime < 180_000) {
  if (events.find((e) => e.type === 'result' || e.type === 'error')) break
  await new Promise((r) => setTimeout(r, 500))
}

console.log('\n\n[sandbox-e2e-v2] === validation ===')

const counts: Record<string, number> = {}
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
console.log('[sandbox-e2e-v2] event counts:', JSON.stringify(counts))

// 1. 确认 LLM 用了 write 工具
const writeToolUses = events.filter((e) => e.type === 'tool_use' && e.name === 'write')
console.log(`[sandbox-e2e-v2] 'write' tool_use count: ${writeToolUses.length}`)

// 2. 独立验证沙箱里的文件
console.log('\n[sandbox-e2e-v2] querying sandbox /api/tools/read to verify...')
let sandboxReadOk = false
let sandboxReadContent = ''
try {
  const sandbox = await scfSandboxManager.getOrCreate(conversationId, envId, {
    mode: 'shared',
    workspaceIsolation: 'shared',
  })
  const headers = await sandbox.getAuthHeaders()
  const res = await fetch(`${sandbox.baseUrl}/api/tools/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ path: sandboxRelPath }),
  })
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: any; error?: string }
  if (data.success && typeof data.result?.content === 'string') {
    sandboxReadContent = data.result.content
    sandboxReadOk = sandboxReadContent.includes(expectedContent)
    console.log(`[sandbox-e2e-v2] sandbox file content = ${JSON.stringify(sandboxReadContent.slice(0, 200))}`)
  } else {
    console.log(`[sandbox-e2e-v2] sandbox read failed: ${data.error ?? JSON.stringify(data).slice(0, 200)}`)
  }
} catch (e) {
  console.log(`[sandbox-e2e-v2] sandbox read error: ${(e as Error).message}`)
}

// 3. 本地文件系统干净
const localExists = fs.existsSync(localMirror)
console.log(`[sandbox-e2e-v2] local ${localMirror} exists = ${localExists} (should be false)`)

// ─── Assertions ─────────────────────────────────────────────────────────────
const hasText = (counts.text ?? 0) > 0
const hasResult = (counts.result ?? 0) > 0
const usedWrite = writeToolUses.length > 0

console.log('\n[sandbox-e2e-v2] assertions:')
console.log(`  text events:                ${hasText ? 'PASS' : 'FAIL'}`)
console.log(`  result event:               ${hasResult ? 'PASS' : 'FAIL'}`)
console.log(`  LLM used 'write' tool:      ${usedWrite ? 'PASS' : 'FAIL'} (count=${writeToolUses.length})`)
console.log(`  sandbox file has content:   ${sandboxReadOk ? 'PASS' : 'FAIL'}`)
console.log(`  local NOT polluted:         ${!localExists ? 'PASS' : 'FAIL'}`)

const overall = hasText && hasResult && usedWrite && sandboxReadOk && !localExists
console.log(`\n[sandbox-e2e-v2] OVERALL: ${overall ? 'PASS' : 'FAIL'}`)

process.exit(overall ? 0 : 1)
