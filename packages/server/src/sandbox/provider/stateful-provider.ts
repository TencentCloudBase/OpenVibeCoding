/**
 * Stateful sandbox provider (CloudBase AGS control plane + TRW data plane).
 *
 * TRW workspace protocol:
 *   - PUT /api/workspace/env       inject credentials
 *   - POST /api/workspace/init     initialize workspace
 *   - GET /health                  health probe
 *   - POST /api/workspace/snapshot explicit COS snapshot flush
 *
 * Two-layer control plane:
 *   - Tool   = template (sdt-xxx). ensureStatefulTool() per envId (manager-node CreateSandboxTool).
 *   - Instance = runtime container. Provider enforces single-instance lifecycle
 *                per envId: running->reuse, paused->resume, missing->create.
 *
 * Auth: TCB_API_KEY (long-lived JWT) used as X-Cloudbase-Authorization Bearer.
 * Routing: E2b-Sandbox-Id + E2b-Sandbox-Port: 9000 headers route to instance.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

import { normalizeSandboxMode, type SandboxInstanceMode } from '../../lib/sandbox-config.js'
import type {
  AcquireContext,
  DeleteConversationContext,
  McpClientBundle,
  McpDeps,
  PrepareContext,
  ReleaseContext,
  SandboxInstance,
  SandboxProgressCallback,
  SandboxProvider,
  SessionEnv,
  ToolOverrideConfig,
  ToolOverrideHosting,
} from './types.js'
import { STATEFUL_WORKSPACE_ROOT } from '../../lib/sandbox-config.js'
import { ensureStatefulTool, resolveStatefulGatewayUrl } from '../ensure-stateful-tool.js'
import { startStatefulInstanceWithWarmup } from '../stateful-tool-warmup.js'
import { buildDataPlaneHeaders, TRW_SERVICE_PORT } from '../stateful/gateway.js'
import { createStatefulMcpClient } from '../stateful/stateful-mcp-client.js'

// ─── Constants ────────────────────────────────────────────────────────────

const HEALTH_TIMEOUT_MS = 5000
const READY_TIMEOUT_MS = 120_000
const READY_POLL_INTERVAL_MS = 3000
const PREPARE_INIT_TIMEOUT_MS = 300_000

// ─── Config from env ──────────────────────────────────────────────────────

interface StatefulRuntimeConfig {
  tcbApiKey: string
  sandboxBaseUrl: string
  toolId: string
  preCreatedSandboxId: string
  managerSecretId: string
  managerSecretKey: string
  managerToken: string
  managerEnvId: string
}

function readStatefulRuntimeConfig(envId: string, toolId: string): StatefulRuntimeConfig {
  const tcbApiKey = process.env.TCB_API_KEY || ''
  const sandboxBaseUrl = resolveStatefulGatewayUrl(envId)
  const preCreatedSandboxId = process.env.STATEFUL_SANDBOX_ID || ''
  const managerSecretId =
    process.env.TCB_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENT_SECRET_ID || ''
  const managerSecretKey =
    process.env.TCB_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENT_SECRET_KEY || ''
  const managerToken = process.env.TCB_TOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN || ''
  const managerEnvId = process.env.TCB_ENV_ID || envId

  if (!tcbApiKey) throw new Error('Missing TCB_API_KEY (required for stateful sandbox data-plane auth)')
  if (!preCreatedSandboxId && !toolId) {
    throw new Error('Stateful sandbox requires a tool id (ensureStatefulTool failed)')
  }
  if (!preCreatedSandboxId && (!managerSecretId || !managerSecretKey || !managerEnvId)) {
    throw new Error('TCB_ENV_ID + TCB_SECRET_ID/KEY required for sandbox instance lifecycle')
  }

  return {
    tcbApiKey,
    sandboxBaseUrl,
    toolId,
    preCreatedSandboxId,
    managerSecretId,
    managerSecretKey,
    managerToken,
    managerEnvId,
  }
}

// ─── Instance meta bag ────────────────────────────────────────────────────

interface StatefulMetaBag {
  envId: string
  conversationId: string
  toolId: string
  tcbApiKey: string
  sandboxMode: SandboxInstanceMode
  cacheKey: string
}

function resolveAcquireSandboxMode(ctx: AcquireContext): SandboxInstanceMode {
  const fromBackend = ctx.backendOptions?.backend === 'stateful' ? ctx.backendOptions.sandboxMode : undefined
  const fromMeta = typeof ctx.meta?.sandboxMode === 'string' ? ctx.meta.sandboxMode : undefined
  return normalizeSandboxMode(fromBackend ?? fromMeta)
}

function buildInstanceCacheKey(envId: string, conversationId: string, mode: SandboxInstanceMode): string {
  return mode === 'isolated' ? `task:${envId}:${conversationId}` : `env:${envId}`
}

function buildStatefulInstance(args: {
  sandboxId: string
  toolId: string
  baseUrl: string
  envId: string
  conversationId: string
  tcbApiKey: string
  sandboxMode: SandboxInstanceMode
  cacheKey: string
}): SandboxInstance {
  const { sandboxId, toolId, baseUrl, envId, conversationId, tcbApiKey, sandboxMode, cacheKey } = args
  const meta: StatefulMetaBag = { envId, conversationId, toolId, tcbApiKey, sandboxMode, cacheKey }
  const authHeaders = buildDataPlaneHeaders({ tcbApiKey, sandboxId, port: TRW_SERVICE_PORT })
  return {
    backend: 'stateful',
    id: sandboxId,
    templateId: toolId,
    baseUrl,
    meta: meta as unknown as Record<string, unknown>,
    mcpConfig: {
      type: 'http',
      url: `${baseUrl}/mcp`,
      headers: authHeaders,
    },
    async getAuthHeaders() {
      return { ...authHeaders }
    },
    async request(p, opts) {
      return fetch(`${baseUrl}${p}`, {
        ...opts,
        headers: {
          ...authHeaders,
          ...((opts?.headers as Record<string, string> | undefined) ?? {}),
        },
      })
    },
  }
}

// ─── Tool override module path ────────────────────────────────────────────
// Stateful runtime reuses tool-override.cjs; CLI patch consumes protocol-neutral
// payload (TRW /api/tools/* + e2b envd). Only {url, headers} differ per instance.

function getStatefulToolOverridePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // tsup dist runtime (here ~= packages/server/dist/sandbox/provider)
    path.resolve(here, '../tool-override.cjs'),
    // source runtime via tsx (here ~= packages/server/src/sandbox/provider)
    path.resolve(here, '../../../dist/sandbox/tool-override.cjs'),
    // fallback for unusual bundle layouts
    path.resolve(here, 'sandbox/tool-override.cjs'),
    path.resolve(here, '../../../../dist/sandbox/tool-override.cjs'),
  ]
  const hit = candidates.find((p) => existsSync(p))
  return hit || candidates[0]
}

// ─── AGS Manager API (control plane) ──────────────────────────────────────
// Uses @cloudbase/manager-node CloudService('ags', '2025-09-20') for
// StartSandboxInstance / DescribeSandboxInstanceList / Pause / Resume / Stop.

async function callAgsManagerApi(
  action: string,
  param: Record<string, unknown>,
  cfg: StatefulRuntimeConfig,
): Promise<Record<string, unknown>> {
  const managerModule = await import('@cloudbase/manager-node')
  // @ts-expect-error manager-node ships utils without types
  const managerUtilsModule = await import('@cloudbase/manager-node/lib/utils')
  const CloudBase = ((managerModule as any).default || managerModule) as any
  const CloudService = ((managerUtilsModule as any).CloudService ||
    (managerUtilsModule as any).default?.CloudService) as any
  const app = new CloudBase({
    secretId: cfg.managerSecretId,
    secretKey: cfg.managerSecretKey,
    token: cfg.managerToken,
    envId: cfg.managerEnvId,
  })
  const agsService = new CloudService(app.context, 'ags', '2025-09-20')
  return agsService.request(action, param)
}

async function startStatefulInstance(cfg: StatefulRuntimeConfig, toolId: string): Promise<string> {
  const result = (await callAgsManagerApi(
    'StartSandboxInstance',
    {
      ToolId: toolId,
      Timeout: '30m',
      AuthMode: 'NONE',
    },
    cfg,
  )) as Record<string, unknown>
  const data = result?.data as Record<string, unknown> | undefined
  const instanceObj = result?.Instance as Record<string, unknown> | undefined
  const instanceId = String(result?.InstanceId || instanceObj?.InstanceId || data?.InstanceId || '') || ''
  if (!instanceId) {
    throw new Error(`StartSandboxInstance returned no InstanceId: ${JSON.stringify(result)}`)
  }
  return instanceId
}

interface StatefulInstanceStatus {
  instanceId: string
  status: string
  toolId: string | null
}

async function describeAgsInstances(
  cfg: StatefulRuntimeConfig,
  opts: { toolId?: string; instanceIds?: string[] } = {},
): Promise<StatefulInstanceStatus[]> {
  const result = await callAgsManagerApi(
    'DescribeSandboxInstanceList',
    {
      ...(opts.toolId ? { ToolId: opts.toolId } : {}),
      ...(opts.instanceIds?.length ? { InstanceIds: opts.instanceIds } : {}),
      Limit: 100,
    },
    cfg,
  )
  const data = result?.data as Record<string, unknown> | undefined
  const rows = (result?.InstanceSet || data?.InstanceSet || []) as Array<Record<string, unknown>>
  return rows.map((it) => ({
    instanceId: String(it.InstanceId || ''),
    status: String(it.Status || ''),
    toolId: it.ToolId ? String(it.ToolId) : null,
  }))
}

async function stopStatefulInstance(cfg: StatefulRuntimeConfig, instanceId: string): Promise<void> {
  await callAgsManagerApi('StopSandboxInstance', { InstanceId: instanceId }, cfg)
}

async function pauseStatefulInstance(cfg: StatefulRuntimeConfig, instanceId: string): Promise<void> {
  await callAgsManagerApi('PauseSandboxInstance', { InstanceId: instanceId }, cfg)
}

async function resumeStatefulInstance(cfg: StatefulRuntimeConfig, instanceId: string): Promise<void> {
  await callAgsManagerApi('ResumeSandboxInstance', { InstanceId: instanceId }, cfg)
}

function pickPrimaryInstance(candidates: StatefulInstanceStatus[]): StatefulInstanceStatus | null {
  const byPriority = ['RUNNING', 'PAUSED', 'RESUME_FAILED']
  for (const status of byPriority) {
    const hit = candidates.find((c) => c.status === status)
    if (hit) return hit
  }
  return null
}

async function ensureSingleEnvInstance(
  cfg: StatefulRuntimeConfig,
  toolId: string,
  onProgress?: SandboxProgressCallback,
): Promise<{ sandboxId: string; created: boolean }> {
  const discover = await describeAgsInstances(cfg, { toolId })
  const active = discover.filter((it) => ['RUNNING', 'PAUSED', 'RESUME_FAILED'].includes(it.status))
  const primary = pickPrimaryInstance(active)
  if (!primary) {
    const sandboxId = await startStatefulInstanceWithWarmup(
      () => startStatefulInstance(cfg, toolId),
      onProgress,
    )
    return { sandboxId, created: true }
  }

  // Keep one instance per env/tool. Extra active instances are drift; stop them best-effort.
  const redundant = active.filter((it) => it.instanceId !== primary.instanceId)
  for (const item of redundant) {
    try {
      await stopStatefulInstance(cfg, item.instanceId)
    } catch (err) {
      console.warn('[StatefulProvider] failed to stop redundant instance:', item.instanceId, (err as Error).message)
    }
  }

  if (primary.status !== 'RUNNING') {
    await resumeStatefulInstance(cfg, primary.instanceId)
  }
  return { sandboxId: primary.instanceId, created: false }
}

/** Per-task instance: reuse task.sandboxId when healthy; otherwise start a dedicated instance. */
async function ensureTaskInstance(
  cfg: StatefulRuntimeConfig,
  toolId: string,
  preferredInstanceId?: string | null,
  onProgress?: SandboxProgressCallback,
): Promise<{ sandboxId: string; created: boolean }> {
  if (preferredInstanceId) {
    const listed = await describeAgsInstances(cfg, { instanceIds: [preferredInstanceId] })
    const hit = listed.find((it) => it.instanceId === preferredInstanceId)
    if (hit && ['RUNNING', 'PAUSED', 'RESUME_FAILED'].includes(hit.status)) {
      if (hit.status !== 'RUNNING') {
        await resumeStatefulInstance(cfg, hit.instanceId)
      }
      return { sandboxId: hit.instanceId, created: false }
    }
  }

  const sandboxId = await startStatefulInstanceWithWarmup(
    () => startStatefulInstance(cfg, toolId),
    onProgress,
  )
  return { sandboxId, created: true }
}

// ─── Health check ─────────────────────────────────────────────────────────

async function checkHealth(baseUrl: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForReady(baseUrl: string, sandboxId: string, tcbApiKey: string): Promise<void> {
  const headers = buildDataPlaneHeaders({ tcbApiKey, sandboxId, port: TRW_SERVICE_PORT })
  const start = Date.now()
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (await checkHealth(baseUrl, headers)) return
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS))
  }
  throw new Error(`Sandbox instance ${sandboxId} not healthy within ${READY_TIMEOUT_MS / 1000}s`)
}

// ─── The provider ─────────────────────────────────────────────────────────

class StatefulProvider implements SandboxProvider {
  readonly backend = 'stateful' as const

  /** Cache instances per cache key (default: envId). */
  private readonly instanceCache = new Map<string, SandboxInstance>()

  private cacheKey(ctx: AcquireContext, mode?: SandboxInstanceMode): string {
    const m = mode ?? resolveAcquireSandboxMode(ctx)
    return buildInstanceCacheKey(ctx.envId, ctx.conversationId, m)
  }

  async acquire(ctx: AcquireContext, onProgress?: SandboxProgressCallback): Promise<SandboxInstance> {
    const userId = typeof ctx.meta?.userId === 'string' ? ctx.meta.userId : undefined
    const sandboxMode = resolveAcquireSandboxMode(ctx)
    const preferredSandboxId = typeof ctx.meta?.preferredSandboxId === 'string' ? ctx.meta.preferredSandboxId : null
    const toolId = await ensureStatefulTool(ctx.envId, {
      userId,
      taskId: ctx.conversationId,
      onProgress,
    })
    const cfg = readStatefulRuntimeConfig(ctx.envId, toolId)
    const key = this.cacheKey(ctx, sandboxMode)

    // Reuse cached instance if still healthy.
    const cached = this.instanceCache.get(key)
    if (cached) {
      const headers = await cached.getAuthHeaders()
      if (await checkHealth(cached.baseUrl, headers)) {
        onProgress?.({ phase: 'reuse', message: '复用已有沙箱...\n' })
        return cached
      }
      this.instanceCache.delete(key)
    }

    let sandboxId: string
    if (cfg.preCreatedSandboxId) {
      onProgress?.({ phase: 'wait_ready', message: '连接已有沙箱实例...\n' })
      sandboxId = cfg.preCreatedSandboxId
    } else {
      onProgress?.({ phase: 'create', message: '正在启动云端沙箱实例...\n' })
      if (sandboxMode === 'isolated') {
        const ensured = await ensureTaskInstance(cfg, cfg.toolId, preferredSandboxId, onProgress)
        sandboxId = ensured.sandboxId
      } else {
        const ensured = await ensureSingleEnvInstance(cfg, cfg.toolId, onProgress)
        sandboxId = ensured.sandboxId
      }
      onProgress?.({ phase: 'wait_ready', message: '等待沙箱实例就绪...\n' })
      await waitForReady(cfg.sandboxBaseUrl, sandboxId, cfg.tcbApiKey)
    }

    // Final health check (covers pre-created path too).
    const headers = buildDataPlaneHeaders({
      tcbApiKey: cfg.tcbApiKey,
      sandboxId,
      port: TRW_SERVICE_PORT,
    })
    if (!(await checkHealth(cfg.sandboxBaseUrl, headers))) {
      throw new Error(`Sandbox ${sandboxId} not healthy at ${cfg.sandboxBaseUrl}`)
    }

    const inst = buildStatefulInstance({
      sandboxId,
      toolId: cfg.toolId || 'pre-created',
      baseUrl: cfg.sandboxBaseUrl,
      envId: ctx.envId,
      conversationId: ctx.conversationId,
      tcbApiKey: cfg.tcbApiKey,
      sandboxMode,
      cacheKey: key,
    })

    this.instanceCache.set(key, inst)
    onProgress?.({ phase: 'ready', message: '沙箱已就绪\n' })
    return inst
  }

  async getExisting(ctx: AcquireContext): Promise<SandboxInstance | null> {
    const key = this.cacheKey(ctx, resolveAcquireSandboxMode(ctx))
    const cached = this.instanceCache.get(key)
    if (!cached) return null
    const headers = await cached.getAuthHeaders()
    return (await checkHealth(cached.baseUrl, headers)) ? cached : null
  }

  async prepare(inst: SandboxInstance, ctx: PrepareContext, onProgress?: SandboxProgressCallback): Promise<SessionEnv> {
    onProgress?.({ phase: 'init_mcp', message: '初始化 workspace...\n' })

    // Single-shot: POST /api/workspace/init handles ensureWorkspace + env injection.
    // Returns immediately when workspace ready (idempotent on warm restarts).
    try {
      const res = await inst.request('/api/workspace/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          env: {
            CLOUDBASE_ENV_ID: ctx.credentials.envId,
            TENCENTCLOUD_SECRETID: ctx.credentials.secretId,
            TENCENTCLOUD_SECRETKEY: ctx.credentials.secretKey,
            ...(ctx.credentials.sessionToken ? { TENCENTCLOUD_SESSIONTOKEN: ctx.credentials.sessionToken } : {}),
            INTEGRATION_IDE: 'codebuddy',
            WORKSPACE_FOLDER_PATHS: ctx.workspaceHint || STATEFUL_WORKSPACE_ROOT,
          },
        }),
        signal: AbortSignal.timeout(PREPARE_INIT_TIMEOUT_MS),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`/api/workspace/init failed: ${res.status} ${text.slice(0, 200)}`)
      }
      const data = (await res.json().catch(() => null)) as { success?: boolean; result?: { workspace?: string } } | null
      const workspace = data?.result?.workspace ?? STATEFUL_WORKSPACE_ROOT
      onProgress?.({ phase: 'ready', message: 'workspace 已就绪\n' })
      return { workspace }
    } catch (err) {
      console.warn(
        `[StatefulProvider] /api/workspace/init failed, falling back to ${STATEFUL_WORKSPACE_ROOT}:`,
        (err as Error).message,
      )
      return { workspace: STATEFUL_WORKSPACE_ROOT }
    }
  }

  async release(inst: SandboxInstance, ctx: ReleaseContext): Promise<void> {
    // AGS persistence: COS snapshot is auto-managed by TRW (periodic 60s + shutdown).
    // We only flush explicitly when the caller asks for it (rare path).
    const flushSnapshot = ctx.backendOptions?.backend === 'stateful' && ctx.backendOptions.flushSnapshot === true
    if (!flushSnapshot) return

    try {
      const res = await inst.request('/api/workspace/snapshot', {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) {
        console.warn(`[StatefulProvider] snapshot flush returned ${res.status}`)
      }
    } catch (err) {
      console.warn('[StatefulProvider] snapshot flush failed:', (err as Error).message)
    }
  }

  async createMcpClient(deps: McpDeps): Promise<McpClientBundle> {
    return createStatefulMcpClient(deps)
  }

  async getToolOverrideConfig(inst: SandboxInstance, hosting?: ToolOverrideHosting): Promise<ToolOverrideConfig> {
    const headers = await inst.getAuthHeaders()
    return {
      url: inst.baseUrl,
      headers,
      modulePath: getStatefulToolOverridePath(),
      ...(hosting ? { hosting } : {}),
    }
  }

  async getPreviewBaseUrl(inst: SandboxInstance): Promise<string> {
    // AGS routes preview via the same gateway. No separate gateway provisioning.
    return `${inst.baseUrl}/preview`
  }

  async destroy(inst: SandboxInstance): Promise<void> {
    try {
      const meta = inst.meta as unknown as StatefulMetaBag
      const cfg = readStatefulRuntimeConfig(meta.envId, meta.toolId)
      await stopStatefulInstance(cfg, inst.id)
    } catch (err) {
      console.warn('[StatefulProvider] StopSandboxInstance failed:', (err as Error).message)
    }
    const meta = inst.meta as unknown as StatefulMetaBag
    if (meta.cacheKey) {
      this.instanceCache.delete(meta.cacheKey)
    } else {
      for (const [k, v] of this.instanceCache) {
        if (v.id === inst.id) this.instanceCache.delete(k)
      }
    }
  }

  async deleteConversation(inst: SandboxInstance, ctx: DeleteConversationContext): Promise<void> {
    const meta = inst.meta as unknown as StatefulMetaBag
    const mode = normalizeSandboxMode(ctx.sandboxMode ?? meta.sandboxMode)
    if (mode === 'isolated') {
      await this.destroy(inst)
      return
    }
    // shared: one /home/user per env instance — no per-task workspace teardown in TRW.
  }

  // ── Optional admin helpers (not on SandboxProvider interface, but useful) ──

  async pause(inst: SandboxInstance): Promise<void> {
    const meta = inst.meta as unknown as StatefulMetaBag
    await pauseStatefulInstance(readStatefulRuntimeConfig(meta.envId, meta.toolId), inst.id)
  }

  async resume(inst: SandboxInstance): Promise<void> {
    const meta = inst.meta as unknown as StatefulMetaBag
    await resumeStatefulInstance(readStatefulRuntimeConfig(meta.envId, meta.toolId), inst.id)
  }
}

export const statefulProvider = new StatefulProvider()
