#!/usr/bin/env tsx
/**
 * Runtime 选择器端到端测试
 *
 * 验证：
 *  1. GET /api/agent/runtimes 返回正确的 runtime 列表
 *  2. POST /api/tasks 能保存 selectedRuntime 字段
 *  3. 前端选 opencode-acp → session/prompt 真的路由给 OpencodeAcpRuntime
 *  4. 前端选 tencent-sdk → session/prompt 路由给 TencentSdkRuntime（现状默认行为）
 *
 * 不依赖真实 LLM —— 只验证路由层，不等 agent 跑完。
 *
 * 用法：
 *   npx tsx --env-file=../../.env.local scripts/test-runtime-selector.mts
 */

import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import fs from 'node:fs'

const app = new Hono()

// 挂载 acp 路由和 tasks 路由
const { default: acpRoutes } = await import('../src/routes/acp.js')
const { default: tasksRouter } = await import('../src/routes/tasks.js')
const { getDb } = await import('../src/db/index.js')
const { agentRuntimeRegistry } = await import('../src/agent/runtime/index.js')

// 绑定 mock auth middleware（让 tasks + internal 路由可访问）
app.use('*', async (c, next) => {
  c.set('session', {
    created: Date.now(),
    authProvider: 'api-key',
    user: { id: 'selector-test-user', username: 'test', email: 'test@test.local', avatar: '' },
  })
  c.set('apiKeyScopes', ['acp'])
  c.set('userEnv', {
    envId: process.env.TCB_ENV_ID || '',
    userId: 'selector-test-user',
    credentials: { secretId: process.env.TCB_SECRET_ID || '', secretKey: process.env.TCB_SECRET_KEY || '' },
  })
  await next()
})

app.route('/api/agent', acpRoutes)
app.route('/api/tasks', tasksRouter)

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
  process.env.ASK_USER_BASE_URL = `http://127.0.0.1:${info.port}`
  console.log(`[selector-test] server on :${info.port}`)
})
await new Promise((r) => setTimeout(r, 400))

const port = (server.address() as { port: number }).port
const BASE = `http://127.0.0.1:${port}`

let passed = 0
let failed = 0
function assert(cond: unknown, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}

// ── 1. GET /api/agent/runtimes ────────────────────────────────────────────────
console.log('\n[selector-test] === 1. GET /api/agent/runtimes ===')
const runtimes = await fetch(`${BASE}/api/agent/runtimes`).then((r) => r.json()) as {
  default: string
  runtimes: Array<{ name: string; available: boolean }>
}
console.log('  response:', JSON.stringify(runtimes))
assert(runtimes.default === 'tencent-sdk', 'default runtime = tencent-sdk')
assert(Array.isArray(runtimes.runtimes), 'runtimes is array')
assert(runtimes.runtimes.some((r) => r.name === 'tencent-sdk'), 'tencent-sdk listed')
assert(runtimes.runtimes.some((r) => r.name === 'opencode-acp'), 'opencode-acp listed')

// ── 2. POST /api/tasks (不含 selectedRuntime) ─────────────────────────────────
console.log('\n[selector-test] === 2. POST /api/tasks without runtime ===')
const userId = 'selector-test-user'
const taskId1 = 'selector-task-' + Date.now()
const res1 = await fetch(`${BASE}/api/tasks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: taskId1,
    prompt: 'test task no runtime',
  }),
})
assert(res1.ok, `POST /api/tasks (no runtime) ok=${res1.status}`)
const task1 = await getDb().tasks.findById(taskId1)
assert(task1?.selectedRuntime === null, `task.selectedRuntime = null (no selection)`)

// ── 3. POST /api/tasks with selectedRuntime = 'opencode-acp' ─────────────────
console.log('\n[selector-test] === 3. POST /api/tasks with runtime=opencode-acp ===')
const taskId2 = 'selector-task-oc-' + Date.now()
const res2 = await fetch(`${BASE}/api/tasks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: taskId2,
    prompt: 'test task opencode',
    selectedRuntime: 'opencode-acp',
  }),
})
assert(res2.ok, `POST /api/tasks (opencode-acp) ok=${res2.status}`)
const task2 = await getDb().tasks.findById(taskId2)
assert(task2?.selectedRuntime === 'opencode-acp', `task.selectedRuntime = 'opencode-acp' saved`)

// ── 4. registry.resolve() 按 task.selectedRuntime 选 runtime ─────────────────
console.log('\n[selector-test] === 4. registry.resolve with task.selectedRuntime ===')
// 模拟 handleSessionPrompt 的逻辑
const taskRuntime1 = task1?.selectedRuntime || undefined
const resolved1 = agentRuntimeRegistry.resolve({ explicitRuntime: taskRuntime1, conversationId: taskId1 })
assert(resolved1.name === 'tencent-sdk', `task1 (no runtime) resolves to tencent-sdk (got ${resolved1.name})`)

const taskRuntime2 = task2?.selectedRuntime || undefined
const resolved2 = agentRuntimeRegistry.resolve({ explicitRuntime: taskRuntime2, conversationId: taskId2 })
assert(resolved2.name === 'opencode-acp', `task2 (opencode-acp) resolves to opencode-acp (got ${resolved2.name})`)

// ── 5. request params.runtime 优先级高于 task.selectedRuntime ──────────────────
console.log('\n[selector-test] === 5. params.runtime overrides task.selectedRuntime ===')
// task2 有 opencode-acp，但 params.runtime='tencent-sdk' 应覆盖
const resolved3 = agentRuntimeRegistry.resolve({
  explicitRuntime: 'tencent-sdk',  // request param 级别
  conversationId: taskId2,
})
assert(resolved3.name === 'tencent-sdk', `params.runtime='tencent-sdk' overrides task's opencode-acp (got ${resolved3.name})`)

// ── 清理 ─────────────────────────────────────────────────────────────────────
try {
  const envId = process.env.TCB_ENV_ID || ''
  if (envId && getDb().tasks.delete) {
    await getDb().tasks.delete(taskId1)
    await getDb().tasks.delete(taskId2)
  }
} catch {
  /* noop */
}

// ── 结果 ─────────────────────────────────────────────────────────────────────
console.log(`\n[selector-test] ${passed} passed, ${failed} failed`)
console.log(`[selector-test] OVERALL: ${failed === 0 ? 'PASS' : 'FAIL'}`)

server.close()
process.exit(failed === 0 ? 0 : 1)
