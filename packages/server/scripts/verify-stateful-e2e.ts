/**
 * OpenVibeCoding stateful sandbox acceptance (vibecoding tool).
 * Emits one JSON line per probe for CI / agent parsing.
 *
 * Usage (from packages/server):
 *   pnpm verify:stateful
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

import { getSandboxProvider } from '../src/sandbox/provider/factory.js'
import {
  statefulReadTextFile,
  statefulRunCommand,
  resolveStatefulFilePath,
} from '../src/sandbox/stateful/e2b-native-client.js'

const VITE_PORT = 5173
const PROBE_PREFIX = 'ovc_stateful_probe'

type ProbeResult = {
  probe: string
  ok: boolean
  detail?: string
  ms?: number
}

const results: ProbeResult[] = []

function emit(probe: string, ok: boolean, detail?: string, ms?: number) {
  const row: ProbeResult = { probe, ok, ...(detail ? { detail } : {}), ...(ms !== undefined ? { ms } : {}) }
  results.push(row)
  console.log(JSON.stringify({ type: PROBE_PREFIX, ...row }))
}

async function trwBash(
  inst: Awaited<ReturnType<ReturnType<typeof getSandboxProvider>['acquire']>>,
  command: string,
): Promise<{ exitCode: number; output: string }> {
  const res = await inst.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, timeout: 60_000 }),
  })
  const data = (await res.json()) as {
    success?: boolean
    result?: { output?: string; exitCode?: number }
    error?: string
  }
  if (!data.success) {
    return { exitCode: 1, output: data.error || `bash http ${res.status}` }
  }
  return {
    exitCode: data.result?.exitCode ?? 1,
    output: data.result?.output || '',
  }
}

async function main() {
  const t0 = Date.now()
  const envId = process.env.TCB_ENV_ID || 'ovc-verify-env'
  const conversationId = `ovc-verify-${Date.now()}`
  const provider = getSandboxProvider()

  emit('config_tool_id', !!(process.env.STATEFUL_TOOL_ID || process.env.STATEFUL_SANDBOX_TOOL_ID))
  emit(
    'config_gateway_url',
    !!(
      process.env.STATEFUL_GATEWAY_URL?.includes('tcloudbasegateway.com') ||
      process.env.TCB_ENV_ID
    ),
  )
  emit('config_tcb_api_key', !!process.env.TCB_API_KEY)

  let inst: Awaited<ReturnType<typeof provider.acquire>>
  try {
    const tAcquire = Date.now()
    inst = await provider.acquire({
      envId,
      conversationId,
      backendOptions: { backend: 'stateful' },
    })
    emit('acquire_instance', !!inst.id, inst.id, Date.now() - tAcquire)
  } catch (e) {
    emit('acquire_instance', false, (e as Error).message)
    process.exit(1)
  }

  try {
    const tInit = Date.now()
    const session = await provider.prepare(
      inst,
      {
        credentials: {
          envId: process.env.TCB_ENV_ID || '',
          secretId: process.env.TCB_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || '',
          secretKey: process.env.TCB_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || '',
        },
        codingMode: true,
        backendOptions: { backend: 'stateful' },
      },
    )
    emit('workspace_init', !!session.workspace, session.workspace, Date.now() - tInit)
  } catch (e) {
    emit('workspace_init', false, (e as Error).message)
  }

  const trwPwd = await trwBash(inst, 'pwd')
  emit(
    'trw_bash_pwd',
    trwPwd.exitCode === 0 && trwPwd.output.trim() === '/home/user',
    trwPwd.output.trim() || `exit ${trwPwd.exitCode}`,
  )

  const trwPkg = await trwBash(inst, 'test -f package.json && echo yes || echo no')
  emit('trw_package_json', trwPkg.output.trim() === 'yes', trwPkg.output.trim())

  const envdPwd = await statefulRunCommand(inst, 'pwd')
  emit(
    'envd_command_pwd',
    envdPwd.exitCode === 0 && envdPwd.stdout.trim() === '/home/user',
    envdPwd.exitCode === 0 ? envdPwd.stdout.trim() : envdPwd.stderr || `exit ${envdPwd.exitCode}`,
  )

  for (const filePath of ['package.json', '/home/user/package.json', 'home/user/package.json']) {
    const text = await statefulReadTextFile(inst, filePath)
    const ok = !!text && text.includes('cloudbase-react-template')
    emit(`envd_read_${resolveStatefulFilePath(filePath).replace(/[^\w]+/g, '_') || 'root'}`, ok, filePath)
  }

  try {
    const previewRes = await inst.request(`/preview/${VITE_PORT}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    })
    const body = await previewRes.text()
    emit(
      'trw_preview_vite',
      previewRes.status < 500 && body.length > 0,
      `status=${previewRes.status} bytes=${body.length}`,
    )
  } catch (e) {
    emit('trw_preview_vite', false, (e as Error).message)
  }

  try {
    const portsRes = await inst.request('/preview/ports', { signal: AbortSignal.timeout(10_000) })
    const portsJson = (await portsRes.json()) as { ports?: Array<{ port: number }> }
    const hasVite = Array.isArray(portsJson.ports) && portsJson.ports.some((p) => p.port === VITE_PORT)
    emit('trw_preview_ports', portsRes.ok && hasVite, JSON.stringify(portsJson.ports?.map((p) => p.port) ?? []))
  } catch (e) {
    emit('trw_preview_ports', false, (e as Error).message)
  }

  const healthRes = await inst.request('/health', { signal: AbortSignal.timeout(10_000) })
  emit('trw_health', healthRes.ok, `status=${healthRes.status}`)

  const failed = results.filter((r) => !r.ok)
  emit(
    'summary',
    failed.length === 0,
    `${results.length - failed.length}/${results.length} passed in ${Date.now() - t0}ms`,
  )

  if (failed.length > 0) {
    console.error('Failed probes:', failed.map((f) => f.probe).join(', '))
    process.exit(1)
  }
}

main().catch((e) => {
  emit('fatal', false, (e as Error).message)
  process.exit(1)
})
