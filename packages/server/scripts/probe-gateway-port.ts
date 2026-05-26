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
    if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim()
  }
}

const taskId = process.argv[2] || '1uup1280sermpmd7e6u'

async function main() {
  const { getDb } = await import('../src/db/index.js')
  const { getTaskSandbox } = await import('../src/sandbox/task-sandbox.js')
  const { resolveGatewayPreviewPort } = await import('../src/sandbox/ttyd-gateway-port.js')
  const { TTYD_VIRTUAL_PORT } = await import('../src/sandbox/ttyd-preview.js')
  const task = await getDb().tasks.findById(taskId)
  const sandbox = await getTaskSandbox(task!, process.env.TCB_ENV_ID || '', {
    isCodingMode: task!.mode === 'coding',
  })
  if (!sandbox) throw new Error('no sandbox')
  const portsRes = await sandbox.request('/preview/ports')
  const portsJson = await portsRes.json()
  const gw = await resolveGatewayPreviewPort(sandbox, TTYD_VIRTUAL_PORT)
  const auth = await sandbox.getAuthHeaders()
  const url = `${sandbox.baseUrl}/preview/${gw}/`
  const res = await fetch(url, { headers: auth })
  const text = await res.text()
  console.log(JSON.stringify({ gw, portsJson, upstream: { status: res.status, ttyd: text.includes('ttyd') } }, null, 2))
}

main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})
