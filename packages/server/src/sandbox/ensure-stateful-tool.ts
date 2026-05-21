/**
 * Ensure a CloudBase sandbox Tool (SDT) exists for the given envId.
 * Persists tool id in settings (shared) or user_resources (isolated/task scope).
 */

import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'
import { getProvisionMode } from '../lib/provision-config.js'

export const STATEFUL_TOOL_SETTINGS_KEY = 'stateful_tool_id'

const DEFAULT_TOOL_ROLE_ARN = 'qcs::cam::uin/691612481:roleName/agent-sandbox'

function sanitizeToolName(envId: string): string {
  const slug = envId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48)
  return `ovc-${slug || 'default'}`
}

function resolveSandboxGatewayUrl(envId: string): string {
  const explicit = process.env.STATEFUL_GATEWAY_URL || process.env.STATEFUL_SANDBOX_URL || ''
  if (explicit) return explicit.replace(/\/$/, '')
  if (!envId) throw new Error('Missing envId to derive stateful sandbox gateway URL')
  return `https://${envId}.api.tcloudbasegateway.com/v1/sandbox/-`
}

async function callAgsManagerApi(action: string, param: Record<string, unknown>): Promise<Record<string, unknown>> {
  const managerModule = await import('@cloudbase/manager-node')
  // @ts-expect-error manager-node ships utils without types
  const managerUtilsModule = await import('@cloudbase/manager-node/lib/utils')
  const CloudBase = ((managerModule as any).default || managerModule) as any
  const CloudService = ((managerUtilsModule as any).CloudService ||
    (managerUtilsModule as any).default?.CloudService) as any

  const secretId =
    process.env.TCB_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENT_SECRET_ID || ''
  const secretKey =
    process.env.TCB_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENT_SECRET_KEY || ''
  const token = process.env.TCB_TOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN || ''
  const managerEnvId = process.env.TCB_ENV_ID || ''

  if (!secretId || !secretKey || !managerEnvId) {
    throw new Error('TCB_ENV_ID and TCB_SECRET_ID/KEY are required to manage sandbox tools')
  }

  const app = new CloudBase({ secretId, secretKey, token, envId: managerEnvId })
  const agsService = new CloudService(app.context, 'ags', '2025-09-20')
  return (await agsService.request(action, param)) as Record<string, unknown>
}

async function createSandboxTool(envId: string): Promise<string> {
  const image = process.env.STATEFUL_SANDBOX_IMAGE || ''
  if (!image) {
    throw new Error('Missing STATEFUL_SANDBOX_IMAGE (vibecoding preset image URI for CreateSandboxTool)')
  }

  const roleArn = process.env.STATEFUL_TOOL_ROLE_ARN || DEFAULT_TOOL_ROLE_ARN
  const toolName = sanitizeToolName(envId)

  const data = {
    ToolName: toolName,
    ToolType: 'custom',
    RoleArn: roleArn,
    CustomConfiguration: {
      Image: image,
      ImageRegistryType: process.env.STATEFUL_IMAGE_REGISTRY || 'personal',
      Command: JSON.parse(process.env.STATEFUL_TOOL_COMMAND || '["/init"]'),
      Resources: {
        CPU: process.env.STATEFUL_TOOL_CPU || '2',
        Memory: process.env.STATEFUL_TOOL_MEMORY || '2Gi',
      },
      Ports: [
        { Name: 'trw', Protocol: 'TCP', Port: 9000 },
        { Name: 'envd', Protocol: 'TCP', Port: 49983 },
        { Name: 'vite', Protocol: 'TCP', Port: 5173 },
        { Name: 'ttyd', Protocol: 'TCP', Port: 7681 },
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
    DefaultTimeout: '30m',
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
 * Resolve ToolId for envId: DB → env override → CreateTool.
 */
export async function ensureStatefulTool(envId: string, opts?: { userId?: string; taskId?: string }): Promise<string> {
  const override = process.env.STATEFUL_TOOL_ID || process.env.STATEFUL_SANDBOX_TOOL_ID || ''
  if (override) return override

  const existing = await readStoredToolId(envId, opts?.userId, opts?.taskId)
  if (existing) return existing

  const toolId = await createSandboxTool(envId)
  await persistToolId(envId, toolId, opts?.userId, opts?.taskId)
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
