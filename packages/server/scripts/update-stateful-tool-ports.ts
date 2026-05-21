/**
 * Merge vite/ttyd ports into an existing stateful SDT (idempotent).
 *
 *   pnpm exec tsx scripts/update-stateful-tool-ports.ts
 */

import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(here, '../.env') })

const DESIRED_PORTS = [
  { Name: 'p9000', Protocol: 'TCP', Port: 9000 },
  { Name: 'p49983', Protocol: 'TCP', Port: 49983 },
  { Name: 'p7681', Protocol: 'TCP', Port: 7681 },
  { Name: 'p5173', Protocol: 'TCP', Port: 5173 },
  { Name: 'p3000', Protocol: 'TCP', Port: 3000 },
]

async function callAgs(action: string, param: Record<string, unknown>) {
  const managerModule = await import('@cloudbase/manager-node')
  const managerUtilsModule = await import('@cloudbase/manager-node/lib/utils')
  const CloudBase = ((managerModule as { default?: unknown }).default || managerModule) as new (cfg: object) => {
    context: object
  }
  const CloudService = ((managerUtilsModule as { CloudService?: unknown; default?: { CloudService?: unknown } })
    .CloudService ||
    (managerUtilsModule as { default?: { CloudService?: unknown } }).default?.CloudService) as new (
    ctx: object,
    svc: string,
    ver: string,
  ) => { request: (a: string, p: object) => Promise<unknown> }

  const secretId = process.env.TCB_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || ''
  const secretKey = process.env.TCB_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || ''
  const envId = process.env.TCB_ENV_ID || ''
  if (!secretId || !secretKey || !envId) throw new Error('TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY required')

  const app = new CloudBase({ secretId, secretKey, envId })
  const ags = new CloudService(app.context, 'ags', '2025-09-20')
  return ags.request(action, param)
}

function mergePorts(
  existing: Array<{ Name?: string; Port?: number; Protocol?: string }>,
): Array<{ Name: string; Protocol: string; Port: number }> {
  const byPort = new Map<number, { Name: string; Protocol: string; Port: number }>()
  for (const p of existing) {
    if (typeof p.Port === 'number') {
      byPort.set(p.Port, {
        Name: p.Name || `p${p.Port}`,
        Protocol: p.Protocol || 'TCP',
        Port: p.Port,
      })
    }
  }
  for (const p of DESIRED_PORTS) {
    byPort.set(p.Port, p)
  }
  return [...byPort.values()].sort((a, b) => a.Port - b.Port)
}

async function main() {
  const toolId = process.env.STATEFUL_TOOL_ID || ''
  if (!toolId) throw new Error('STATEFUL_TOOL_ID required')

  const list = (await callAgs('DescribeSandboxToolList', { ToolIds: [toolId] })) as {
    SandboxToolSet?: Array<{ CustomConfiguration?: { Ports?: Array<{ Port?: number }>; Image?: string } }>
  }
  const tool = list.SandboxToolSet?.[0]
  if (!tool?.CustomConfiguration) throw new Error('Tool not found')

  const cfg = tool.CustomConfiguration
  const ports = mergePorts(cfg.Ports || [])
  const param = {
    ToolId: toolId,
    CustomConfiguration: {
      Image: cfg.Image,
      ImageRegistryType: process.env.STATEFUL_IMAGE_REGISTRY || 'personal',
      Ports: ports,
    },
  }

  for (const action of ['UpdateSandboxTool', 'ModifySandboxTool'] as const) {
    try {
      const resp = await callAgs(action, param)
      console.log(`[update-stateful-tool-ports] ${action} ok`, JSON.stringify(resp).slice(0, 400))
      console.log(
        'Ports now:',
        ports.map((p) => p.Port).join(', '),
      )
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
