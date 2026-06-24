import type { Restored, SyncStatus } from '../workspace-snapshot/index.js'

export interface LocalWorkspaceSyncContext {
  envId: string
  userId: string
  conversationId: string
}

export interface LocalWorkspaceSyncStore {
  restore(ctx: LocalWorkspaceSyncContext, workspaceRoot: string): Promise<SyncStatus>
  snapshot(ctx: LocalWorkspaceSyncContext, workspaceRoot: string): Promise<{ ms: number }>
  getRestoreStatus?(ctx: LocalWorkspaceSyncContext, workspaceRoot: string): Promise<Restored | null>
}

export interface LocalWorkspaceSyncEngineOptions {
  store: LocalWorkspaceSyncStore
  ctx: LocalWorkspaceSyncContext
}
