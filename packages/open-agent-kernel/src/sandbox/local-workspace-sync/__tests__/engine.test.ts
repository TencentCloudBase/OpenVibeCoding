import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSystemLocalWorkspaceStore } from '../filesystem-store.js'
import { LocalWorkspaceSyncEngine } from '../engine.js'
import type { SandboxInstance } from '../../types.js'

const cleanup: string[] = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

async function readFile(root: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(root, relPath), 'utf8')
}

function localInstance(workspaceRoot: string): SandboxInstance {
  return {
    id: 'local:conv-1',
    backend: 'local',
    workspaceRoot,
    async request(): Promise<Response> {
      throw new Error('not used')
    },
    async release(): Promise<void> {},
  }
}

describe('LocalWorkspaceSyncEngine', () => {
  it('restores fresh when the store is empty', async () => {
    const storeRoot = await tmpDir('oak-local-store-')
    const workspaceRoot = await tmpDir('oak-local-workspace-')
    const engine = new LocalWorkspaceSyncEngine({
      store: new FileSystemLocalWorkspaceStore({ root: storeRoot }),
      ctx: { envId: 'env-1', userId: 'alice', conversationId: 'conv-1' },
    })

    const status = await engine.bootstrap(localInstance(workspaceRoot), { credentials: {} })
    expect(status?.restored).toBe('fresh')
    expect(await engine.getRestoreStatus(localInstance(workspaceRoot))).toBe('fresh')
  })

  it('snapshots then restores workspace files into a new local workspace', async () => {
    const storeRoot = await tmpDir('oak-local-store-')
    const workspaceA = await tmpDir('oak-local-workspace-a-')
    const workspaceB = await tmpDir('oak-local-workspace-b-')
    const store = new FileSystemLocalWorkspaceStore({ root: storeRoot })
    const ctx = { envId: 'env-1', userId: 'alice', conversationId: 'conv-1' }
    const first = new LocalWorkspaceSyncEngine({ store, ctx })
    const second = new LocalWorkspaceSyncEngine({ store, ctx })

    await first.bootstrap(localInstance(workspaceA), { credentials: {} })
    await writeFile(workspaceA, 'README.md', 'hello local workspace')
    await writeFile(workspaceA, 'src/index.ts', 'export const ok = true\n')
    await first.snapshot(localInstance(workspaceA))

    const restored = await second.bootstrap(localInstance(workspaceB), { credentials: {} })
    expect(restored?.restored).toBe('full')
    expect(await readFile(workspaceB, 'README.md')).toBe('hello local workspace')
    expect(await readFile(workspaceB, 'src/index.ts')).toContain('ok')
  })

  it('replaces the remote snapshot so deleted files stay deleted on restore', async () => {
    const storeRoot = await tmpDir('oak-local-store-')
    const workspaceA = await tmpDir('oak-local-workspace-a-')
    const workspaceB = await tmpDir('oak-local-workspace-b-')
    const store = new FileSystemLocalWorkspaceStore({ root: storeRoot })
    const ctx = { envId: 'env-1', userId: 'alice', conversationId: 'conv-1' }
    const engine = new LocalWorkspaceSyncEngine({ store, ctx })

    await engine.bootstrap(localInstance(workspaceA), { credentials: {} })
    await writeFile(workspaceA, 'keep.txt', 'keep')
    await writeFile(workspaceA, 'delete.txt', 'delete')
    await engine.snapshot(localInstance(workspaceA))
    await fs.rm(path.join(workspaceA, 'delete.txt'))
    await engine.snapshot(localInstance(workspaceA))

    await new LocalWorkspaceSyncEngine({ store, ctx }).bootstrap(localInstance(workspaceB), { credentials: {} })
    await expect(fs.access(path.join(workspaceB, 'delete.txt'))).rejects.toThrow()
    expect(await readFile(workspaceB, 'keep.txt')).toBe('keep')
  })
})
