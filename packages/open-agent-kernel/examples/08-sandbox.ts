/**
 * Example 08: Local Runtime Sandbox（Phase 0 默认沙箱）
 *
 * 演示 agent 在宿主进程本地 workspace 里跑文件系统 + shell：
 *   1. 让 agent 在本地 workspace 写一个 README.md
 *   2. 让 agent 跑 `ls` 列目录
 *   3. 让 agent 读回 README.md 验证
 *
 * 配置：
 *   - examples/config.local.json
 *   - examples/config.local.json: envId / model / credentials
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/08-sandbox.ts
 *
 * 注意：
 *   - local 是过渡方案：无容器级隔离，适合可信 serverless / CloudRun 场景
 *   - 如需使用 AGS 远程沙箱，请显式配置 sandbox.provider = 'ags-stateful'
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { getEnvId, getModel, getPlatformCredentials } from './_shared/env.js'

import { createAgent } from '@cloudbase/open-agent-kernel'

async function main(): Promise<void> {
  const envId = getEnvId()
  const credentials = getPlatformCredentials()
  const workspaceRoot = path.join(os.tmpdir(), 'oak-example-08-local')

  const agent = createAgent({
    envId,
    credentials,
    model: getModel(),
    systemPrompt:
      'You are a helpful coding assistant working inside a local runtime sandbox. ' +
      'You have access to Bash / Read / Write / Edit / Glob / Grep tools. ' +
      'Always use the tools to interact with the filesystem—never fabricate output. ' +
      'Reply concisely in Chinese.',
    cwd: workspaceRoot,
    sandbox: {
      enabled: true,
      // provider: 'local' 是 Phase 0 默认值；这里显式写出便于阅读。
      provider: 'local',
      workspaceRoot,
      cloudbaseTools: false,
      workspaceSnapshot: 'disabled',
    },
  })

  const session = await agent.startSession({ userId: 'u1' })

  const prompt =
    '请完成以下任务：\n' +
    '1. 在工作目录创建一个 README.md，内容是 "# Hello from open-agent-kernel local sandbox"\n' +
    '2. 跑 `ls -la` 看下当前目录\n' +
    '3. 读 README.md 的内容并展示给我\n' +
    '完成后告诉我结果。'

  console.log('User:', prompt, '\n')
  process.stdout.write('Assistant: ')

  for await (const e of session.send(prompt)) {
    if (e.type === 'message_delta') {
      process.stdout.write(e.text)
    } else if (e.type === 'tool_call') {
      process.stdout.write(`\n  → ${e.toolName}(${JSON.stringify(e.input).slice(0, 200)})\n  `)
    } else if (e.type === 'tool_result') {
      const out = JSON.stringify(e.output).slice(0, 300)
      process.stdout.write(`\n  ← ${out}\n  `)
    } else if (e.type === 'error') {
      console.error('\n[error]', e.error.message)
    }
  }

  console.log('\n\n--- Cleaning up local sandbox session ---')
  await session.abort()
  console.log('--- Done ---')
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
