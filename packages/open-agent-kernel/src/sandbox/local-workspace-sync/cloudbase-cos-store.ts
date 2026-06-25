import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { InvalidConfigError, ResourceError } from '../../internal/errors.js'
import type { PlatformCredentials } from '../../public/types.js'
import { assertSafeRelativePath, listWorkspaceFiles, safeSegment } from './file-utils.js'
import type { LocalWorkspaceSyncContext, LocalWorkspaceSyncStore } from './types.js'
import type { Restored, SyncStatus } from '../workspace-snapshot/index.js'

export interface CloudBaseCosLocalWorkspaceStoreOptions {
  credentials?: PlatformCredentials & { envId: string }
  prefix?: string
}

interface ManagerStorage {
  uploadFile(args: { localPath: string; cloudPath: string }): Promise<unknown>
  walkCloudDir(prefix: string): Promise<Array<{ Key: string; Size: string | number }>>
  getTemporaryUrl(
    fileList: Array<{ cloudPath: string; maxAge?: number }>,
  ): Promise<Array<{ fileId: string; url: string }>>
  deleteFile(cloudPathList: string[]): Promise<unknown>
}

interface CloudBaseManagerInstance {
  storage: ManagerStorage
}

interface ManagerCtor {
  new (opts: {
    secretId: string
    secretKey: string
    envId: string
    token?: string
    region?: string
  }): CloudBaseManagerInstance
}

const DEFAULT_PREFIX = 'oak-workspaces'
const DELETE_NOT_EXIST_CODES = new Set(['STORAGE.FileNotFound', 'STORAGE_FILE_NONEXIST', 'NoSuchKey'])

export class CloudBaseCosLocalWorkspaceStore implements LocalWorkspaceSyncStore {
  private readonly credentials: PlatformCredentials & { envId: string }
  private readonly prefix: string
  private readonly status = new Map<string, Restored>()
  private manager: CloudBaseManagerInstance | null = null

  constructor(opts: CloudBaseCosLocalWorkspaceStoreOptions = {}) {
    if (!opts.credentials?.envId || !opts.credentials.secretId || !opts.credentials.secretKey) {
      throw new InvalidConfigError(
        'CloudBaseCosLocalWorkspaceStore requires AgentConfig.credentials for local workspace snapshot.',
      )
    }
    this.credentials = opts.credentials
    this.prefix = normalizePrefix(opts.prefix ?? DEFAULT_PREFIX)
  }

  async restore(ctx: LocalWorkspaceSyncContext, workspaceRoot: string): Promise<SyncStatus> {
    const started = Date.now()
    const manager = await this.getManager()
    const prefix = this.resolvePrefix(ctx)
    const listed = await manager.storage.walkCloudDir(prefix)
    let restoredFiles = 0

    await fs.mkdir(workspaceRoot, { recursive: true })
    await Promise.all(
      listed.map(async (item) => {
        const key = item.Key
        if (!key || key.endsWith('/')) return
        const size = typeof item.Size === 'number' ? item.Size : Number(item.Size)
        if (Number.isFinite(size) && size === 0) return
        const relPath = key.slice(prefix.length)
        if (!relPath) return
        assertSafeRelativePath(relPath)

        const signed = await manager.storage.getTemporaryUrl([{ cloudPath: key, maxAge: 600 }])
        const url = signed?.[0]?.url
        if (!url) throw new Error('CloudBase temporary URL is empty')
        const resp = await fetch(url)
        if (!resp.ok) throw new Error('CloudBase workspace file download failed')
        const buf = Buffer.from(await resp.arrayBuffer())
        const localPath = path.join(workspaceRoot, relPath)
        await fs.mkdir(path.dirname(localPath), { recursive: true })
        await fs.writeFile(localPath, buf)
        restoredFiles += 1
      }),
    )

    const restored: Restored = restoredFiles > 0 ? 'full' : 'fresh'
    this.status.set(this.statusKey(ctx), restored)
    return {
      restored,
      restoredAt: new Date().toISOString(),
      restoreMs: Date.now() - started,
      source: restoredFiles > 0 ? 'cos' : 'none',
      cosMetaFileCount: restoredFiles,
    }
  }

  async snapshot(ctx: LocalWorkspaceSyncContext, workspaceRoot: string): Promise<{ ms: number }> {
    const started = Date.now()
    const manager = await this.getManager()
    const prefix = this.resolvePrefix(ctx)
    const localFiles = await listWorkspaceFiles(workspaceRoot)
    const localKeys = new Set(localFiles.map((relPath) => prefix + relPath))

    await Promise.all(
      localFiles.map(async (relPath) => {
        assertSafeRelativePath(relPath)
        await manager.storage.uploadFile({
          localPath: path.join(workspaceRoot, relPath),
          cloudPath: prefix + relPath,
        })
      }),
    )

    const remoteFiles = await manager.storage.walkCloudDir(prefix)
    const toDelete = remoteFiles
      .map((item) => item.Key)
      .filter((key): key is string => Boolean(key && !key.endsWith('/') && !localKeys.has(key)))

    if (toDelete.length > 0) {
      try {
        await manager.storage.deleteFile(toDelete)
      } catch (err) {
        if (!isFileNotExistError(err)) throw err
      }
    }

    this.status.set(this.statusKey(ctx), 'full')
    return { ms: Date.now() - started }
  }

  async getRestoreStatus(ctx: LocalWorkspaceSyncContext): Promise<Restored | null> {
    return this.status.get(this.statusKey(ctx)) ?? null
  }

  private async getManager(): Promise<CloudBaseManagerInstance> {
    if (this.manager) return this.manager
    const mod = await this.requireManagerNode()
    const Ctor = ((mod as { default?: unknown }).default ?? mod) as ManagerCtor
    if (typeof Ctor !== 'function') {
      throw new ResourceError('@cloudbase/manager-node loaded but default export is not a constructor.')
    }
    this.manager = new Ctor({
      secretId: this.credentials.secretId,
      secretKey: this.credentials.secretKey,
      envId: this.credentials.envId,
      ...(this.credentials.sessionToken ? { token: this.credentials.sessionToken } : {}),
      region: this.credentials.region ?? 'ap-shanghai',
    })
    return this.manager
  }

  private async requireManagerNode(): Promise<unknown> {
    try {
      const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<unknown>
      return await dynamicImport('@cloudbase/manager-node')
    } catch {
      throw new ResourceError('CloudBaseCosLocalWorkspaceStore failed to load @cloudbase/manager-node.')
    }
  }

  private resolvePrefix(ctx: LocalWorkspaceSyncContext): string {
    return `${this.prefix}/${safeSegment(ctx.userId)}/${safeSegment(ctx.conversationId)}/`
  }

  private statusKey(ctx: LocalWorkspaceSyncContext): string {
    return `${ctx.envId}/${ctx.userId}/${ctx.conversationId}`
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, '') || DEFAULT_PREFIX
}

function isFileNotExistError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; name?: string; message?: string; statusCode?: number }
  if (e.code && DELETE_NOT_EXIST_CODES.has(e.code)) return true
  if (e.name && DELETE_NOT_EXIST_CODES.has(e.name)) return true
  if (e.statusCode === 404) return true
  if (typeof e.message === 'string' && /no such key|file.*not.*exist|nonexist/i.test(e.message)) return true
  return false
}
