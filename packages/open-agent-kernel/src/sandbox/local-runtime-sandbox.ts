import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigError, SandboxError } from '../internal/errors.js'
import { LocalWorkspaceSyncEngine, type LocalWorkspaceSyncStore } from './local-workspace-sync/index.js'
import type { SandboxAcquireContext, SandboxInstance, SandboxRuntime } from './types.js'

export interface LocalRuntimeSandboxOptions {
  /**
   * Local runtime workspace root. If omitted, acquire() derives a per-session
   * directory from OAK_WORKSPACE_ROOT or os.tmpdir().
   */
  workspaceRoot?: string
  /**
   * AgentConfig.cwd mirrored into the runtime by createAgent(). It has higher
   * priority than workspaceRoot because Claude SDK built-in tools run from cwd.
   */
  cwd?: string
  /**
   * Optional persistence backend used when sandbox.workspaceSnapshot is enabled.
   * Production callers can use CloudBaseCosLocalWorkspaceStore; tests and
   * examples can use FileSystemLocalWorkspaceStore.
   */
  workspaceSyncStore?: LocalWorkspaceSyncStore
}

export class LocalRuntimeSandbox implements SandboxRuntime {
  readonly backend = 'local'

  private readonly options: LocalRuntimeSandboxOptions

  constructor(options: LocalRuntimeSandboxOptions = {}) {
    if (options.cwd && options.workspaceRoot && path.resolve(options.cwd) !== path.resolve(options.workspaceRoot)) {
      throw new ConfigError(
        'AgentConfig.cwd and sandbox.workspaceRoot must point to the same directory when sandbox.provider is local.',
      )
    }
    this.options = options
  }

  async acquire(ctx: SandboxAcquireContext): Promise<SandboxInstance> {
    const workspaceRoot = this.resolveWorkspaceRoot(ctx)
    await fs.mkdir(workspaceRoot, { recursive: true })
    await this.assertWritable(workspaceRoot)

    ctx.onProgress?.({
      phase: 'local_workspace',
      message: 'local sandbox workspace is ready',
    })

    return {
      id: `local:${ctx.conversationId}`,
      backend: this.backend,
      workspaceRoot,
      async request(): Promise<Response> {
        throw new SandboxError(
          'LocalRuntimeSandbox does not expose an HTTP data plane. Use Claude SDK built-in tools in local mode.',
        )
      },
      async release(): Promise<void> {
        // Phase 0 keeps local workspaces in place. Phase 1 may trigger a final snapshot here.
      },
    }
  }

  createWorkspaceSyncEngine(ctx: SandboxAcquireContext): LocalWorkspaceSyncEngine | undefined {
    if (!this.options.workspaceSyncStore) return undefined
    return new LocalWorkspaceSyncEngine({
      store: this.options.workspaceSyncStore,
      ctx: {
        envId: ctx.envId,
        userId: ctx.userId ?? 'default',
        conversationId: ctx.conversationId,
      },
    })
  }

  private resolveWorkspaceRoot(ctx: SandboxAcquireContext): string {
    const configuredRoot = this.options.cwd ?? this.options.workspaceRoot
    if (configuredRoot) return path.resolve(configuredRoot)

    const base = process.env.OAK_WORKSPACE_ROOT || path.join(os.tmpdir(), 'oak-workspaces')
    return path.resolve(
      base,
      safeSegment(ctx.envId),
      safeSegment(ctx.userId ?? 'default'),
      safeSegment(ctx.conversationId),
    )
  }

  private async assertWritable(dir: string): Promise<void> {
    const probe = path.join(dir, `.oak-write-probe-${process.pid}-${Date.now()}`)
    try {
      await fs.writeFile(probe, 'ok', { flag: 'wx' })
      await fs.unlink(probe)
    } catch (err) {
      throw new ConfigError(
        'LocalRuntimeSandbox workspaceRoot is not writable. Set AgentConfig.cwd or sandbox.workspaceRoot to a writable directory.',
      )
    }
  }
}

function safeSegment(input: string): string {
  const normalized = input.replace(/[^a-zA-Z0-9._-]/g, '-')
  return normalized || 'default'
}
