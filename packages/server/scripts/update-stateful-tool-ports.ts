/**
 * Set AGS tool Ports to TRW + envd only (idempotent).
 *
 *   STATEFUL_TOOL_ID=... pnpm exec tsx scripts/update-stateful-tool-ports.ts
 */

import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agsCredentialsFromProcessEnv, callAgsManagerApi } from '../src/lib/cloudbase-ags-api.js'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(here, '../../../.env.local') })

/** Match ensure-stateful-tool.ts — preview via :9000, envd for e2b SDK. */
const STANDARD_TOOL_PORTS = [
  { Name: 'trw', Protocol: 'TCP', Port: 9000 },
  { Name: 'envd', Protocol: 'TCP', Port: 49983 },
]

async function callAgs(action: string, param: Record<string, unknown>) {
  return callAgsManagerApi(action, param, agsCredentialsFromProcessEnv())
}

async function resolveToolId(): Promise<string> {
  const fromEnv = process.env.STATEFUL_TOOL_ID || process.env.STATEFUL_SANDBOX_TOOL_ID || ''
  if (fromEnv) return fromEnv

  const envId = process.env.TCB_ENV_ID || ''
  if (!envId) throw new Error('TCB_ENV_ID required')

  const { getDb } = await import('../src/db/index.js')
  const { getProvisionMode } = await import('../src/lib/provision-config.js')
  const { STATEFUL_TOOL_SETTINGS_KEY, statefulToolNameForEnv } = await import('../src/sandbox/ensure-stateful-tool.js')

  if ((await getProvisionMode()) === 'shared') {
    const row = await getDb().settings.findSystemSetting(STATEFUL_TOOL_SETTINGS_KEY)
    if (row?.value) return row.value
  }

  const toolName = statefulToolNameForEnv(envId)
  const list = (await callAgs('DescribeSandboxToolList', {
    Filters: [{ Name: 'ToolName', Values: [toolName] }],
    Limit: 20,
  })) as { SandboxToolSet?: Array<{ ToolId?: string; ToolName?: string }> }
  const hit = list.SandboxToolSet?.find((t) => t.ToolName === toolName && t.ToolId)
  if (hit?.ToolId) return hit.ToolId

  throw new Error('No tool id in env or DB; set STATEFUL_TOOL_ID or run ensureStatefulTool once')
}

async function main() {
  const toolId = await resolveToolId()

  const list = (await callAgs('DescribeSandboxToolList', { ToolIds: [toolId] })) as {
    SandboxToolSet?: Array<{ CustomConfiguration?: { Ports?: Array<{ Port?: number }>; Image?: string } }>
  }
  const tool = list.SandboxToolSet?.[0]
  if (!tool?.CustomConfiguration) throw new Error('Tool not found')

  const cfg = tool.CustomConfiguration
  const before = (cfg.Ports || []).map((p) => p.Port).filter((n): n is number => typeof n === 'number')
  const param = {
    ToolId: toolId,
    CustomConfiguration: {
      Image: cfg.Image,
      ImageRegistryType: process.env.STATEFUL_IMAGE_REGISTRY || 'personal',
      Ports: STANDARD_TOOL_PORTS,
    },
  }

  for (const action of ['UpdateSandboxTool', 'ModifySandboxTool'] as const) {
    try {
      const resp = await callAgs(action, param)
      console.log(`[update-stateful-tool-ports] ${action} ok`, JSON.stringify(resp).slice(0, 400))
      console.log('Ports before:', before.join(', ') || '(none)')
      console.log('Ports now:', STANDARD_TOOL_PORTS.map((p) => p.Port).join(', '))
      return
    } catch (err) {
      console.warn(`[update-stateful-tool-ports] ${action} failed:`, (err as Error).message)
    }
  }
  throw new Error('Update failed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
