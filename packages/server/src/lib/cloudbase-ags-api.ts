/**
 * AGS control-plane calls via @cloudbase/manager-node.
 * Use explicit …/lib/utils/index.js — Node ESM rejects directory imports (ERR_UNSUPPORTED_DIR_IMPORT).
 */

export type AgsManagerCredentials = {
  secretId: string
  secretKey: string
  token?: string
  envId: string
}

type CloudBaseCtor = new (config: { secretId: string; secretKey: string; token?: string; envId: string }) => {
  context: unknown
}

type CloudServiceCtor = new (
  context: unknown,
  service: string,
  version: string,
) => {
  request: (action: string, param: Record<string, unknown>) => Promise<unknown>
}

async function loadManagerConstructors(): Promise<{
  CloudBase: CloudBaseCtor
  CloudService: CloudServiceCtor
}> {
  const managerModule = await import('@cloudbase/manager-node')
  const utilsModule = await import('@cloudbase/manager-node/lib/utils/index.js')
  const CloudBase = (managerModule.default ?? managerModule) as CloudBaseCtor
  const CloudService = utilsModule.CloudService as CloudServiceCtor
  if (!CloudService) {
    throw new Error('CloudService export missing from @cloudbase/manager-node/lib/utils/index.js')
  }
  return { CloudBase, CloudService }
}

export async function callAgsManagerApi(
  action: string,
  param: Record<string, unknown>,
  creds: AgsManagerCredentials,
): Promise<Record<string, unknown>> {
  const { CloudBase, CloudService } = await loadManagerConstructors()
  const app = new CloudBase({
    secretId: creds.secretId,
    secretKey: creds.secretKey,
    token: creds.token,
    envId: creds.envId,
  })
  const agsService = new CloudService(app.context, 'ags', '2025-09-20')
  return (await agsService.request(action, param)) as Record<string, unknown>
}

export function agsCredentialsFromProcessEnv(): AgsManagerCredentials {
  const secretId = process.env.TCB_SECRET_ID || ''
  const secretKey = process.env.TCB_SECRET_KEY || ''
  const envId = process.env.TCB_ENV_ID || ''
  const token = process.env.TCB_TOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN || ''
  if (!secretId || !secretKey || !envId) {
    throw new Error('TCB_ENV_ID and TCB_SECRET_ID/KEY are required to manage sandbox tools')
  }
  return { secretId, secretKey, token, envId }
}
