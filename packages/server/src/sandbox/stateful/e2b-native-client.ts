import { Sandbox } from 'e2b'
import type { SandboxInstance } from '../provider/types.js'

const ENVD_PORT = '49983'
const WORKSPACE_ROOT = '/home/user'
const DEFAULT_ENVD_VERSION = process.env.TCB_ENVD_VERSION || '99.99.99'

/** Map UI/API paths to envd-relative paths (cwd defaults to /home/user). */
export function resolveStatefulFilePath(filePath: string): string {
  const p = (filePath || '').trim().replace(/\\/g, '/')
  if (!p) return p
  if (p.startsWith(`${WORKSPACE_ROOT}/`)) return p.slice(WORKSPACE_ROOT.length + 1)
  if (p === WORKSPACE_ROOT) return '.'
  // Legacy: file-content strips leading "/" only → "/home/user/x" becomes "home/user/x"
  if (p.startsWith('home/user/')) return p.slice('home/user/'.length)
  if (p.startsWith('/')) return p.slice(1)
  return p
}

interface NativeCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

function createHeaderInjector(headers: Record<string, string>) {
  return {
    onRequest({ request }: { request: Request }) {
      const merged = new Headers(request.headers)
      for (const [key, value] of Object.entries(headers)) {
        merged.set(key, value)
      }
      return new Request(request, { headers: merged })
    },
  }
}

export async function createStatefulNativeE2bClient(inst: SandboxInstance): Promise<any> {
  if (inst.backend !== 'stateful') {
    throw new Error('createStatefulNativeE2bClient only supports stateful sandbox instances')
  }

  const baseHeaders = await inst.getAuthHeaders()
  const auth = baseHeaders['X-Cloudbase-Authorization']
  const routingHeaders: Record<string, string> = {
    'E2b-Sandbox-Id': inst.id,
    'E2b-Sandbox-Port': ENVD_PORT,
  }

  // Match e2b-example: auth on Sandbox ctor; routing headers on envd HTTP clients.
  const sdkSandbox = new Sandbox({
    sandboxId: inst.id,
    envdVersion: DEFAULT_ENVD_VERSION,
    sandboxUrl: inst.baseUrl,
    headers: auth ? { 'X-Cloudbase-Authorization': auth } : {},
  } as any) as any

  // files.* HTTP client does not always inherit ctor headers — mirror e2b-example/files middleware.
  const filesHeaders: Record<string, string> = {
    ...(auth ? { 'X-Cloudbase-Authorization': auth } : {}),
    ...routingHeaders,
  }
  sdkSandbox.files?.envdApi?.api?.use?.(createHeaderInjector(filesHeaders))

  const routingInjector = createHeaderInjector(routingHeaders)
  ;[sdkSandbox.commands?.envdApi?.api, sdkSandbox.pty?.envdApi?.api, sdkSandbox.git?.envdApi?.api].forEach((api) =>
    api?.use?.(routingInjector),
  )

  return sdkSandbox
}

export async function statefulReadTextFile(inst: SandboxInstance, filePath: string): Promise<string | null> {
  const sdk = await createStatefulNativeE2bClient(inst)
  const normalized = resolveStatefulFilePath(filePath)
  try {
    return (await sdk.files.read(normalized)) as string
  } catch {
    return null
  }
}

export async function statefulReadBinaryFile(inst: SandboxInstance, filePath: string): Promise<Uint8Array | null> {
  const sdk = await createStatefulNativeE2bClient(inst)
  const normalized = resolveStatefulFilePath(filePath)
  try {
    return (await sdk.files.read(normalized, { format: 'bytes' })) as Uint8Array
  } catch {
    return null
  }
}

export async function statefulWriteTextFile(inst: SandboxInstance, filePath: string, content: string): Promise<boolean> {
  const sdk = await createStatefulNativeE2bClient(inst)
  const normalized = resolveStatefulFilePath(filePath)
  try {
    await sdk.files.write(normalized, content)
    return true
  } catch {
    return false
  }
}

export async function statefulRunCommand(inst: SandboxInstance, command: string): Promise<NativeCommandResult> {
  const sdk = await createStatefulNativeE2bClient(inst)
  try {
    const result = await sdk.commands.run(command).catch((err: any) => err)
    return {
      exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 1,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
    }
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : 'Command execution failed',
    }
  }
}
