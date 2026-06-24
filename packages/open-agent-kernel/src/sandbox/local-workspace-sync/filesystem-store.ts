import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Restored, SyncStatus } from '../workspace-snapshot/index.js'
import { copyTree, replaceTree, safeSegment } from './file-utils.js'
import type { LocalWorkspaceSyncContext, LocalWorkspaceSyncStore } from './types.js'

export interface FileSystemLocalWorkspaceStoreOptions {
  root: string
}

export class FileSystemLocalWorkspaceStore implements LocalWorkspaceSyncStore {
  private readonly root: string
  private readonly status = new Map<string, Restored>()

  constructor(opts: FileSystemLocalWorkspaceStoreOptions) {
    this.root = path.resolve(opts.root)
  }

  async restore(ctx: LocalWorkspaceSyncContext, workspaceRoot: string): Promise<SyncStatus> {
    const started = Date.now()
    const remoteDir = this.resolveRemoteDir(ctx)
    await fs.mkdir(workspaceRoot, { recursive: true })

    const hasSnapshot = await exists(remoteDir)
    if (hasSnapshot) {
      await copyTree(remoteDir, workspaceRoot)
    }

    const restored: Restored = hasSnapshot ? 'full' : 'fresh'
    this.status.set(this.statusKey(ctx), restored)
    return {
      restored,
      restoredAt: new Date().toISOString(),
      restoreMs: Date.now() - started,
      source: hasSnapshot ? 'cos' : 'none',
    }
  }

  async snapshot(ctx: LocalWorkspaceSyncContext, workspaceRoot: string): Promise<{ ms: number }> {
    const started = Date.now()
    const remoteDir = this.resolveRemoteDir(ctx)
    await replaceTree(workspaceRoot, remoteDir)
    this.status.set(this.statusKey(ctx), 'full')
    return { ms: Date.now() - started }
  }

  async getRestoreStatus(ctx: LocalWorkspaceSyncContext): Promise<Restored | null> {
    return this.status.get(this.statusKey(ctx)) ?? null
  }

  private resolveRemoteDir(ctx: LocalWorkspaceSyncContext): string {
    return path.join(this.root, safeSegment(ctx.envId), safeSegment(ctx.userId), safeSegment(ctx.conversationId))
  }

  private statusKey(ctx: LocalWorkspaceSyncContext): string {
    return `${ctx.envId}/${ctx.userId}/${ctx.conversationId}`
  }
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}
