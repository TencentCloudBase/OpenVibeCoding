/**
 * Probe TCB gateway routing to a specific container port on an instance.
 *
 *   SANDBOX_ID=l6wbb... PORT=5173 pnpm exec tsx scripts/probe-gateway-port.ts
 *   SANDBOX_ID=l6wbb... PORT=9000 PATH=/preview/5173/ pnpm exec tsx scripts/probe-gateway-port.ts
 */

import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildGatewayTarget,
  buildTrwPreviewGatewayTarget,
  gatewayFetch,
  TRW_SERVICE_PORT,
} from '../src/sandbox/stateful/gateway.js'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(here, '../.env') })

async function main() {
  const sandboxId = process.env.SANDBOX_ID || process.env.STATEFUL_SANDBOX_ID || ''
  const envId = process.env.TCB_ENV_ID || ''
  const tcbApiKey = process.env.TCB_API_KEY || ''
  if (!sandboxId) throw new Error('SANDBOX_ID required')
  if (!tcbApiKey || !envId) throw new Error('TCB_ENV_ID and TCB_API_KEY required')

  const port = Number(process.env.GW_PORT || '5173')
  const path = process.env.GW_PATH || '/'
  const mode = process.env.GW_MODE || 'direct'

  const target =
    mode === 'trw-preview'
      ? buildTrwPreviewGatewayTarget({
          envId,
          sandboxId,
          tcbApiKey,
          vitePort: port,
          subpath: path === '/' ? '/' : path,
        })
      : buildGatewayTarget({ envId, sandboxId, tcbApiKey, port, path })

  console.log('target.url', target.url)
  console.log('E2b-Sandbox-Port', target.port)
  const res = await gatewayFetch(target, { signal: AbortSignal.timeout(30_000) })
  const ct = res.headers.get('content-type') ?? ''
  const enc = res.headers.get('content-encoding') ?? '(none)'
  const snippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ')
  console.log('status', res.status, 'content-type', ct, 'content-encoding', enc)
  console.log('body', snippet)
  if (port !== TRW_SERVICE_PORT && res.status === 500) {
    console.log('\nHint: port not declared on AGS tool — run describe-stateful-tool.ts')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
