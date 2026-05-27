/**
 * Point an existing stateful SDT at a new container image (after 沙箱业务镜像 rebuild).
 *
 * Usage (repo root .env.local loaded):
 *   STATEFUL_TOOL_ID=sdt-xxx STATEFUL_SANDBOX_IMAGE=ccr.../tcb-sandbox-ags:app-vibecoding \
 *     pnpm exec tsx scripts/update-stateful-tool-image.ts
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agsCredentialsFromProcessEnv, callAgsManagerApi } from '../src/lib/cloudbase-ags-api.js'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(here, '../../../.env.local') })

async function callAgs(action: string, param: Record<string, unknown>) {
  return callAgsManagerApi(action, param, agsCredentialsFromProcessEnv())
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
