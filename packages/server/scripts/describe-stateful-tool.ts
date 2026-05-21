/**
 * Print AGS tool ports/image for STATEFUL_TOOL_ID.
 *
 *   pnpm exec tsx scripts/describe-stateful-tool.ts
 */

import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(here, '../.env') })

async function callAgs(action: string, param: Record<string, unknown>) {
  const managerModule = await import('@cloudbase/manager-node')
  const managerUtilsModule = await import('@cloudbase/manager-node/lib/utils')
  const CloudBase = ((managerModule as { default?: unknown }).default || managerModule) as new (cfg: object) => {
    context: object
  }
  const CloudService = ((managerUtilsModule as { CloudService?: unknown; default?: { CloudService?: unknown } })
    .CloudService || (managerUtilsModule as { default?: { CloudService?: unknown } }).default?.CloudService) as new (
    ctx: object,
    svc: string,
    ver: string,
  ) => { request: (a: string, p: object) => Promise<Record<string, unknown>> }

  const secretId = process.env.TCB_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || ''
  const secretKey = process.env.TCB_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || ''
  const envId = process.env.TCB_ENV_ID || ''
  if (!secretId || !secretKey || !envId) throw new Error('TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY required')

  const app = new CloudBase({ secretId, secretKey, envId })
  const ags = new CloudService(app.context, 'ags', '2025-09-20')
  return ags.request(action, param)
}

async function main() {
  const toolId = process.env.STATEFUL_TOOL_ID || process.env.STATEFUL_SANDBOX_TOOL_ID || ''
  if (!toolId) throw new Error('STATEFUL_TOOL_ID required')

  const resp = await callAgs('DescribeSandboxToolList', { ToolIds: [toolId] })
  const tool = (resp.SandboxToolSet as Array<Record<string, unknown>> | undefined)?.[0]
  if (!tool) {
    console.log('No tool found for', toolId)
    process.exit(1)
  }

  const cfg = tool.CustomConfiguration as Record<string, unknown> | undefined
  const ports = (cfg?.Ports as Array<{ Name?: string; Port?: number; Protocol?: string }>) || []
  console.log('ToolId:', tool.ToolId)
  console.log('ToolName:', tool.ToolName)
  console.log('Status:', tool.Status)
  console.log('Image:', (cfg?.Image as string | undefined)?.slice(0, 120))
  console.log('Ports:')
  for (const p of ports) {
    console.log(`  - ${p.Name ?? '?'}: ${p.Port} (${p.Protocol ?? 'TCP'})`)
  }
  const has5173 = ports.some((p) => p.Port === 5173)
  console.log('vite 5173 declared:', has5173 ? 'yes' : 'NO — gateway E2b-Sandbox-Port:5173 will 500')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
