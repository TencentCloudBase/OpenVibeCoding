/**
 * Stop active AGS sandbox instances for the configured stateful tool (shared-env cleanup).
 * Loads packages/server/.env like verify-stateful-e2e.ts.
 *
 * Usage: pnpm stop:stateful-instances
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '../.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    const v = t.slice(eq + 1).trim()
    if (!process.env[k]) process.env[k] = v
  }
}

const ACTIVE = new Set(['RUNNING', 'PAUSED', 'RESUME_FAILED'])

async function callAgsManagerApi(action: string, param: Record<string, unknown>) {
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
    throw new Error('TCB_ENV_ID and TCB_SECRET_ID/KEY are required')
  }

  const app = new CloudBase({ secretId, secretKey, token, envId: managerEnvId })
  const agsService = new CloudService(app.context, 'ags', '2025-09-20')
  return (await agsService.request(action, param)) as Record<string, unknown>
}

async function resolveToolId(): Promise<string> {
  const override = process.env.STATEFUL_TOOL_ID || process.env.STATEFUL_SANDBOX_TOOL_ID || ''
  if (override) return override

  const envId = process.env.TCB_ENV_ID || ''
  if (!envId) {
    throw new Error('Set STATEFUL_TOOL_ID or TCB_ENV_ID in packages/server/.env')
  }

  const { statefulToolNameForEnv } = await import('../src/sandbox/ensure-stateful-tool.js')
  const toolName = statefulToolNameForEnv(envId)
  const resp = await callAgsManagerApi('DescribeSandboxToolList', {
    Filters: [{ Name: 'ToolName', Values: [toolName] }],
    Limit: 20,
  })
  const set = (resp.SandboxToolSet || (resp.data as Record<string, unknown> | undefined)?.SandboxToolSet) as
    | Array<Record<string, unknown>>
    | undefined
  const hit = Array.isArray(set) ? set.find((t) => t.ToolName === toolName && typeof t.ToolId === 'string') : undefined
  if (hit?.ToolId) return hit.ToolId as string

  throw new Error(`No AGS tool found for ToolName=${toolName} (env ${envId})`)
}

async function main() {
  const toolId = await resolveToolId()

  const list = await callAgsManagerApi('DescribeSandboxInstanceList', { ToolId: toolId, Limit: 100 })
  const data = list?.data as Record<string, unknown> | undefined
  const rows = (list?.InstanceSet || data?.InstanceSet || []) as Array<Record<string, unknown>>
  const active = rows
    .map((it) => ({
      instanceId: String(it.InstanceId || ''),
      status: String(it.Status || ''),
    }))
    .filter((it) => it.instanceId && ACTIVE.has(it.status))

  if (active.length === 0) {
    console.log(JSON.stringify({ ok: true, toolId, stopped: 0, message: 'no active instances' }))
    return
  }

  const stopped: string[] = []
  const errors: Array<{ instanceId: string; error: string }> = []
  for (const { instanceId, status } of active) {
    try {
      await callAgsManagerApi('StopSandboxInstance', { InstanceId: instanceId })
      stopped.push(`${instanceId}(${status})`)
    } catch (e) {
      errors.push({ instanceId, error: (e as Error).message })
    }
  }

  console.log(
    JSON.stringify({
      ok: errors.length === 0,
      toolId,
      stopped: stopped.length,
      instances: stopped,
      errors: errors.length ? errors : undefined,
    }),
  )
  if (errors.length) process.exit(1)
}

main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})
