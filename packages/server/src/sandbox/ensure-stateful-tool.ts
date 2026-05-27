/**
 * Ensure a CloudBase sandbox Tool (SDT) exists for the given envId.
 * Persists tool id in settings (shared) or user_resources (isolated/task scope).
 */

import { getDb } from '../db/index.js'
import { getProvisionMode } from '../lib/provision-config.js'
import type { SandboxProgressCallback } from './provider/types.js'
import { waitStatefulToolImageWarmup } from './stateful-tool-warmup.js'
import {
  formatMissingStatefulSandboxImageError,
  resolveStatefulImageRegistryType,
  resolveStatefulSandboxImage,
} from './stateful-vibecoding-image.js'
import { resolveAgsSandboxTimeout } from './stateful-sandbox-ttl.js'
import { agsCredentialsFromProcessEnv, callAgsManagerApi as requestAgsManagerApi } from '../lib/cloudbase-ags-api.js'

export const STATEFUL_TOOL_SETTINGS_KEY = 'stateful_tool_id'

const DEFAULT_TOOL_ROLE_ARN = 'qcs::cam::uin/691612481:roleName/agent-sandbox'

/** Stable AGS ToolName for a CloudBase env (AppId-unique). */
export function statefulToolNameForEnv(envId: string): string {
  const slug = envId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48)
  return `openvibecoding-${slug || 'default'}`
}

function extractSandboxToolSet(resp: Record<string, unknown>): Array<Record<string, unknown>> {
  const set = resp.SandboxToolSet
  if (Array.isArray(set)) return set
  const nested = (resp.data as Record<string, unknown> | undefined)?.SandboxToolSet
  return Array.isArray(nested) ? nested : []
}

function pickToolIdByName(tools: Array<Record<string, unknown>>, toolName: string): string | null {
  const matches = tools.filter((t) => t.ToolName === toolName && typeof t.ToolId === 'string')
  if (!matches.length) return null
  const active = matches.find((t) => t.Status === 'ACTIVE') ?? matches[0]
  return active.ToolId as string
}

/** Resolve existing sdt-xxx by fixed ToolName before CreateSandboxTool. */
async function findSandboxToolIdByName(toolName: string): Promise<string | null> {
  try {
    const filtered = await callAgsManagerApi('DescribeSandboxToolList', {
      Filters: [{ Name: 'ToolName', Values: [toolName] }],
      Limit: 20,
    })
    const hit = pickToolIdByName(extractSandboxToolSet(filtered), toolName)
    if (hit) return hit
  } catch {
    // Filter key may be unsupported on some API versions; fall back to paginated list.
  }

  let offset = 0
  const limit = 100
  for (let page = 0; page < 10; page++) {
    const resp = await callAgsManagerApi('DescribeSandboxToolList', { Offset: offset, Limit: limit })
    const set = extractSandboxToolSet(resp)
    const hit = pickToolIdByName(set, toolName)
    if (hit) return hit
    const total = typeof resp.TotalCount === 'number' ? resp.TotalCount : 0
    offset += limit
    if (set.length < limit || offset >= total) break
  }
  return null
}

function resolveSandboxGatewayUrl(envId: string): string {
  if (!envId) throw new Error('Missing envId to derive stateful sandbox gateway URL')
  return `https://${envId}.api.tcloudbasegateway.com/v1/sandbox/-`
}

async function callAgsManagerApi(action: string, param: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requestAgsManagerApi(action, param, agsCredentialsFromProcessEnv())
}

async function createSandboxTool(envId: string): Promise<string> {
  const image = resolveStatefulSandboxImage()
  if (!image) {
    throw new Error(formatMissingStatefulSandboxImageError())
  }

  const roleArn = process.env.STATEFUL_TOOL_ROLE_ARN || DEFAULT_TOOL_ROLE_ARN
  const toolName = statefulToolNameForEnv(envId)

  const data = {
    ToolName: toolName,
    ToolType: 'custom',
    RoleArn: roleArn,
    CustomConfiguration: {
      Image: image,
      ImageRegistryType: resolveStatefulImageRegistryType(image),
      Command: JSON.parse(process.env.STATEFUL_TOOL_COMMAND || '["/init"]'),
      Resources: {
        CPU: process.env.STATEFUL_TOOL_CPU || '2',
        Memory: process.env.STATEFUL_TOOL_MEMORY || '2Gi',
      },
      // Preview (vite/ttyd) and MCP go through TRW :9000 (/preview/{port}/). Do not declare 5173/7681 here —
      // the gateway may treat them as real container ports and break /preview/7681/ virtual routing.
      Ports: [
        { Name: 'trw', Protocol: 'TCP', Port: 9000 },
        { Name: 'envd', Protocol: 'TCP', Port: 49983 },
      ],
      Probe: {
        HttpGet: { Path: '/health', Port: 9000, Scheme: 'HTTP' },
        ReadyTimeoutMs: 25_000,
        ProbeTimeoutMs: 5000,
        ProbePeriodMs: 3000,
        SuccessThreshold: 1,
        FailureThreshold: 7,
      },
    },
    NetworkConfiguration: { NetworkMode: 'PUBLIC' },
    DefaultTimeout: resolveAgsSandboxTimeout(),
    Description: `OpenVibeCoding stateful sandbox for env ${envId}`,
  }

  const resp = await callAgsManagerApi('CreateSandboxTool', data)
  const toolId =
    (resp?.ToolId as string) || ((resp?.data as Record<string, unknown> | undefined)?.ToolId as string) || ''
  if (!toolId) {
    throw new Error(`CreateSandboxTool returned no ToolId: ${JSON.stringify(resp).slice(0, 300)}`)
  }
  console.log(`[StatefulTool] Created tool ${toolId} (${toolName}) for env ${envId}`)
  return toolId
}

async function readStoredToolId(envId: string, userId?: string, taskId?: string): Promise<string | null> {
  const db = getDb()
  const provisionMode = await getProvisionMode()

  if (provisionMode === 'shared') {
    const row = await db.settings.findSystemSetting(STATEFUL_TOOL_SETTINGS_KEY)
    return row?.value || null
  }

  if (userId) {
    const resources = await db.userResources.findAllByUserId(userId)
    const hit =
      resources.find((r) => r.envId === envId && r.statefulToolId) ||
      (taskId ? resources.find((r) => r.taskId === taskId && r.statefulToolId) : undefined)
    if (hit?.statefulToolId) return hit.statefulToolId
  }

  return null
}

/** Tool template CustomConfiguration (Image, Ports, Probe, …). */
export async function describeStatefulToolCustomConfiguration(toolId: string): Promise<Record<string, unknown> | null> {
  const resp = await callAgsManagerApi('DescribeSandboxToolList', { ToolIds: [toolId] })
  const tool = extractSandboxToolSet(resp).find((t) => t.ToolId === toolId) ?? extractSandboxToolSet(resp)[0]
  if (!tool || typeof tool.ToolId !== 'string') return null
  const cfg = tool.CustomConfiguration
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? (cfg as Record<string, unknown>) : null
}

/** Compare AGS tool Image with env-resolved URI; UpdateSandboxTool + warmup when drifted. */
async function reconcileStatefulToolImageIfDrift(
  toolId: string,
  onProgress?: SandboxProgressCallback,
  knownConfig?: Record<string, unknown> | null,
): Promise<void> {
  const desiredImage = resolveStatefulSandboxImage()
  if (!desiredImage) {
    throw new Error(formatMissingStatefulSandboxImageError())
  }

  const cfg = knownConfig ?? (await describeStatefulToolCustomConfiguration(toolId))
  if (!cfg) {
    throw new Error('Cannot reconcile sandbox tool image: CustomConfiguration missing')
  }
  const currentImage = typeof cfg.Image === 'string' ? cfg.Image.trim() : ''
  if (!currentImage || currentImage === desiredImage) return

  console.log('[StatefulTool] Image drift detected, updating sandbox tool template')
  onProgress?.({
    phase: 'template_update',
    message: '沙箱模板镜像与配置不一致，正在同步...\n',
  })

  const param = {
    ToolId: toolId,
    CustomConfiguration: {
      ...cfg,
      Image: desiredImage,
      ImageRegistryType: resolveStatefulImageRegistryType(desiredImage),
    },
  }

  let updated = false
  for (const action of ['UpdateSandboxTool', 'ModifySandboxTool'] as const) {
    try {
      await callAgsManagerApi(action, param)
      updated = true
      break
    } catch (err) {
      console.warn(`[StatefulTool] ${action} failed:`, (err as Error).message)
    }
  }
  if (!updated) {
    throw new Error('UpdateSandboxTool/ModifySandboxTool failed while reconciling sandbox image')
  }

  await waitStatefulToolImageWarmup(onProgress)
}

async function persistToolId(envId: string, toolId: string, userId?: string, taskId?: string): Promise<void> {
  const db = getDb()
  const provisionMode = await getProvisionMode()

  if (provisionMode === 'shared') {
    await db.settings.upsertSystemSetting(STATEFUL_TOOL_SETTINGS_KEY, toolId)
    return
  }

  if (!userId) return
  const resources = await db.userResources.findAllByUserId(userId)
  const hit =
    resources.find((r) => r.envId === envId) || (taskId ? resources.find((r) => r.taskId === taskId) : undefined)
  if (hit) {
    await db.userResources.update(hit.id, { statefulToolId: toolId, updatedAt: Date.now() })
  }
}

/**
 * Resolve ToolId for envId: debug override → DB → AGS lookup by ToolName → CreateTool.
 * Existing tools: Describe + reconcile Image when STATEFUL_SANDBOX_IMAGE (or default) drifts.
 */
export async function ensureStatefulTool(
  envId: string,
  opts?: { userId?: string; taskId?: string; onProgress?: SandboxProgressCallback },
): Promise<string> {
  const override = process.env.STATEFUL_TOOL_ID || process.env.STATEFUL_SANDBOX_TOOL_ID || ''
  if (override) {
    console.warn('[StatefulTool] STATEFUL_TOOL_ID override active (debug only)')
    return override
  }

  const existing = await readStoredToolId(envId, opts?.userId, opts?.taskId)
  if (existing) {
    opts?.onProgress?.({
      phase: 'template_resolve',
      message: '使用已登记的沙箱模板...\n',
    })
    const cfg = await describeStatefulToolCustomConfiguration(existing)
    if (cfg) {
      await reconcileStatefulToolImageIfDrift(existing, opts?.onProgress, cfg)
      return existing
    }
    console.warn('[StatefulTool] Stored tool id missing in AGS, rebinding by ToolName')
  }

  const toolName = statefulToolNameForEnv(envId)
  const byName = await findSandboxToolIdByName(toolName)
  if (byName) {
    console.log('[StatefulTool] Bound existing tool by ToolName')
    opts?.onProgress?.({
      phase: 'template_bind',
      message: '绑定已有沙箱模板...\n',
    })
    await persistToolId(envId, byName, opts?.userId, opts?.taskId)
    await reconcileStatefulToolImageIfDrift(byName, opts?.onProgress)
    return byName
  }

  opts?.onProgress?.({
    phase: 'template_create',
    message: '正在创建沙箱模板（本环境仅首次，后续任务直接复用）...\n',
  })
  const toolId = await createSandboxTool(envId)
  await persistToolId(envId, toolId, opts?.userId, opts?.taskId)
  await waitStatefulToolImageWarmup(opts?.onProgress)
  return toolId
}

export function resolveStatefulGatewayUrl(envId: string): string {
  return resolveSandboxGatewayUrl(envId)
}

export async function deleteStatefulToolForEnv(envId: string, toolId: string): Promise<void> {
  try {
    await callAgsManagerApi('DeleteSandboxTool', { ToolId: toolId })
    console.log(`[StatefulTool] Deleted tool ${toolId} for env ${envId}`)
  } catch (err) {
    console.warn(`[StatefulTool] DeleteSandboxTool failed for ${toolId}:`, (err as Error).message)
  }
}
