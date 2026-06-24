import type { SandboxInstance } from '../types.js'
import type { Restored, SyncStatus } from '../workspace-snapshot/index.js'
import { SandboxRestoreFailed } from '../workspace-snapshot/index.js'
import type { LocalWorkspaceSyncEngineOptions } from './types.js'

export class LocalWorkspaceSyncEngine {
  private readonly opts: LocalWorkspaceSyncEngineOptions
  private lastStatus: Restored | null = null

  constructor(opts: LocalWorkspaceSyncEngineOptions) {
    this.opts = opts
  }

  async bootstrap(inst: SandboxInstance, _args?: { credentials: Record<string, string> }): Promise<SyncStatus | null> {
    const workspaceRoot = inst.workspaceRoot
    if (!workspaceRoot) {
      throw new SandboxRestoreFailed('local workspace restore requires SandboxInstance.workspaceRoot')
    }
    const status = await this.opts.store.restore(this.opts.ctx, workspaceRoot)
    this.lastStatus = status.restored
    if (status.restored === 'failed') {
      throw new SandboxRestoreFailed('local workspace restore failed', { note: status.note })
    }
    return status
  }

  async snapshot(inst: SandboxInstance): Promise<{ ms: number }> {
    const workspaceRoot = inst.workspaceRoot
    if (!workspaceRoot) {
      throw new SandboxRestoreFailed('local workspace snapshot requires SandboxInstance.workspaceRoot')
    }
    return this.opts.store.snapshot(this.opts.ctx, workspaceRoot)
  }

  async getRestoreStatus(inst: SandboxInstance): Promise<Restored | null> {
    const workspaceRoot = inst.workspaceRoot
    if (!workspaceRoot) return this.lastStatus
    return (await this.opts.store.getRestoreStatus?.(this.opts.ctx, workspaceRoot)) ?? this.lastStatus
  }
}
