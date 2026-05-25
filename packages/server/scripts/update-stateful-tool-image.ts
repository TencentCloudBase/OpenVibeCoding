/**
 * Point an existing stateful SDT at a new container image (after 沙箱业务镜像 rebuild).
 *
 * Usage (from packages/server, with .env loaded):
 *   STATEFUL_TOOL_ID=sdt-xxx STATEFUL_SANDBOX_IMAGE=ccr.../tcb-sandbox-ags:app-vibecoding \
 *     pnpm exec tsx scripts/update-stateful-tool-image.ts
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
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
  ) => { request: (a: string, p: object) => Promise<unknown> }

  const secretId = process.env.TCB_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || ''
  const secretKey = process.env.TCB_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || ''
  const envId = process.env.TCB_ENV_ID || ''
  if (!secretId || !secretKey || !envId) {
    throw new Error('TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY required')
  }

  const app = new CloudBase({ secretId, secretKey, envId })
  const ags = new CloudService(app.context, 'ags', '2025-09-20')
  return ags.request(action, param)
}

async function main() {
  const toolId = process.env.STATEFUL_TOOL_ID || process.env.STATEFUL_SANDBOX_TOOL_ID || ''
  const image = process.env.STATEFUL_SANDBOX_IMAGE || ''
  if (!toolId) throw new Error('STATEFUL_TOOL_ID required')
  if (!image) throw new Error('STATEFUL_SANDBOX_IMAGE required (full image URI after push)')

  const param = {
    ToolId: toolId,
    CustomConfiguration: {
      Image: image,
      ImageRegistryType: process.env.STATEFUL_IMAGE_REGISTRY || 'personal',
    },
  }

  const { STATEFUL_TOOL_WARMUP_POLL_MS, STATEFUL_TOOL_WARMUP_POLL_MAX } =
    await import('../src/sandbox/stateful-tool-warmup.js')

  for (const action of ['UpdateSandboxTool', 'ModifySandboxTool'] as const) {
    try {
      const resp = await callAgs(action, param)
      console.log(`[update-stateful-tool] ${action} ok:`, JSON.stringify(resp).slice(0, 400))
      console.log(
        `[update-stateful-tool] Poll ${STATEFUL_TOOL_WARMUP_POLL_MAX}×${STATEFUL_TOOL_WARMUP_POLL_MS / 1000}s before StartSandboxInstance (AGS image pull window).`,
      )
      return
    } catch (err) {
      console.warn(`[update-stateful-tool] ${action} failed:`, (err as Error).message)
    }
  }
  throw new Error('Neither UpdateSandboxTool nor ModifySandboxTool succeeded')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
