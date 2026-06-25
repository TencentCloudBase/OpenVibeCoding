/**
 * Example 20: Local Runtime Workspace Sync（Phase 1）
 *
 * 不依赖真实 COS 凭证。用 FileSystemLocalWorkspaceStore 模拟远端持久化层，
 * 验证 local runtime sandbox 的 send 前 restore / send 后 snapshot 同步契约：
 *   1. workspace A 写入文件并 snapshot
 *   2. workspace B bootstrap restore
 *   3. 从 workspace B 读回文件
 *
 * 运行：
 *   pnpm dlx tsx packages/open-agent-kernel/examples/20-local-workspace-sync.ts
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { FileSystemLocalWorkspaceStore, LocalRuntimeSandbox } from '../src/sandbox/index.js'

async function main(): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'oak-local-sync-example-'))
  const storeRoot = path.join(base, 'remote-store')
  const workspaceA = path.join(base, 'workspace-a')
  const workspaceB = path.join(base, 'workspace-b')

  const store = new FileSystemLocalWorkspaceStore({ root: storeRoot })
  const runtimeA = new LocalRuntimeSandbox({ workspaceRoot: workspaceA, workspaceSyncStore: store })
  const runtimeB = new LocalRuntimeSandbox({ workspaceRoot: workspaceB, workspaceSyncStore: store })
  const ctx = { envId: 'example-env', userId: 'example-user', conversationId: 'example-conv' }

  const instanceA = await runtimeA.acquire(ctx)
  const engineA = requireEngine(runtimeA.createWorkspaceSyncEngine(ctx))
  await engineA.bootstrap(instanceA, { credentials: {} })
  await fs.writeFile(path.join(instanceA.workspaceRoot!, 'README.md'), '# persisted from workspace A\n', 'utf8')
  await engineA.snapshot(instanceA)

  const instanceB = await runtimeB.acquire(ctx)
  const engineB = requireEngine(runtimeB.createWorkspaceSyncEngine(ctx))
  const status = await engineB.bootstrap(instanceB, { credentials: {} })
  const restored = await fs.readFile(path.join(instanceB.workspaceRoot!, 'README.md'), 'utf8')

  if (!restored.includes('persisted from workspace A')) {
    throw new Error('restored workspace did not contain expected README.md content')
  }

  console.log('Local workspace sync example passed.')
  console.log(status?.restored === 'full' ? 'Restore status check passed.' : 'Restore status check skipped.')
}

function requireEngine(
  engine: ReturnType<LocalRuntimeSandbox['createWorkspaceSyncEngine']>,
): NonNullable<ReturnType<LocalRuntimeSandbox['createWorkspaceSyncEngine']>> {
  if (!engine) throw new Error('LocalRuntimeSandbox did not create a workspace sync engine')
  return engine
}

main().catch((err) => {
  console.error('[fatal]', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
