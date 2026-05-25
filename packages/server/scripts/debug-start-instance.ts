/**
 * Debug StartSandboxInstance — prints full AGS error + tool CustomConfiguration.
 */
import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGitArchiveInstanceEnv } from '../src/sandbox/git-archive.js'
import { isStatefulAuthModeEnabled } from '../src/sandbox/stateful-sandbox-auth.js'
import { describeStatefulToolCustomConfiguration } from '../src/sandbox/ensure-stateful-tool.js'
import {
  mergeInstanceEnvIntoToolConfiguration,
  pickStartCustomConfigurationFromTool,
} from '../src/sandbox/stateful-custom-configuration.js'

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
  const app = new CloudBase({ secretId, secretKey, envId })
  const ags = new CloudService(app.context, 'ags', '2025-09-20')
  return ags.request(action, param)
}

async function main() {
  const toolId = process.env.STATEFUL_TOOL_ID || ''
  if (!toolId) throw new Error('STATEFUL_TOOL_ID required')

  const list = (await callAgs('DescribeSandboxToolList', { ToolIds: [toolId] })) as Record<string, unknown>
  const tool = (list.SandboxToolSet as Array<Record<string, unknown>> | undefined)?.[0]
  console.log('=== Tool CustomConfiguration ===')
  console.log(JSON.stringify(tool?.CustomConfiguration, null, 2))

  const withGitEnv = process.env.WITH_GIT_ENV === '1'
  const withMergedCfg = process.env.WITH_MERGED_CFG === '1'
  const instanceEnv = buildGitArchiveInstanceEnv()
  const toolCfg = withGitEnv || withMergedCfg ? await describeStatefulToolCustomConfiguration(toolId) : null
  const mode = withGitEnv ? '(merged GIT_ARCHIVE Env)' : withMergedCfg ? '(merged template, no Env)' : '(plain)'
  console.log('\n=== StartSandboxInstance ===', mode)
  if (withGitEnv) console.log('Env keys:', instanceEnv.map((e) => e.Name).join(', '))
  try {
    let customConfiguration: Record<string, unknown> | undefined
    if (toolCfg && withGitEnv && instanceEnv.length > 0) {
      customConfiguration = mergeInstanceEnvIntoToolConfiguration(toolCfg, instanceEnv)
    } else if (toolCfg && withMergedCfg) {
      customConfiguration = pickStartCustomConfigurationFromTool(toolCfg)
    }
    const startParam: Record<string, unknown> = {
      ToolId: toolId,
      Timeout: '30m',
      ...(customConfiguration ? { CustomConfiguration: customConfiguration } : {}),
    }
    if (!isStatefulAuthModeEnabled()) startParam.AuthMode = 'NONE'
    const resp = await callAgs('StartSandboxInstance', startParam)
    console.log('OK:', JSON.stringify(resp, null, 2))
  } catch (err) {
    const e = err as Error & { code?: string; requestId?: string; data?: unknown }
    console.error('message:', e.message)
    console.error('code:', e.code)
    console.error('requestId:', e.requestId)
    if (e.data) console.error('data:', JSON.stringify(e.data, null, 2))
    console.error('keys:', Object.keys(e))
    console.error('full:', JSON.stringify(err, Object.getOwnPropertyNames(err as object), 2))
    process.exit(1)
  }
}

main()
