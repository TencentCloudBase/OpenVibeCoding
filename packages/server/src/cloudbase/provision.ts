import { createHash } from 'crypto'
import { nanoid } from 'nanoid'
import tencentcloud from 'tencentcloud-sdk-nodejs'

const CamClient = tencentcloud.cam.v20190116.Client
const TcbClient = tencentcloud.tcb.v20180608.Client
const TagClient = (tencentcloud as any).tag.v20180813.Client

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PolicyBuildParams {
  envId: string
  region: string
  ownerUin: string
  cosTagValue: string
}

export interface ProvisionResult {
  envId: string
  envAlias: string
  envRegion: string
  cosTagValue: string
  policyHash: string
  camUsername: string
  camSecretId: string
  camSecretKey?: string
  policyId: number
}

// ─── Policy Builders ─────────────────────────────────────────────────────────

/**
 * 构建用户环境的 CAM 策略 statement（精确 ARN 版本）
 * 在 provision（创建永久策略）和 auth（签发临时密钥）中复用
 */
export function buildUserEnvPolicyStatements(params: PolicyBuildParams) {
  const { envId, region, ownerUin, cosTagValue } = params

  // 注意：腾讯云 STS GetFederationToken 对单 statement 的 action 数量有上限（约 40-50）。
  // 这里把全局只读/管理 action 拆成多个 statement（每个 ≤ 30），以便此 policy 既能
  // 写入 CAM 自定义策略，也能直接作为 inline policy 传给 STS GetFederationToken。
  return [
    // Statement 1a: cam / cdn / organization / lowcode 只读
    {
      action: [
        'cam:CreateRole',
        'cam:AttachRolePolicy',
        'cam:ListAttachedRolePolicies',
        'cam:UpdatePolicy',
        'cam:CreateServiceLinkedRole',
        'cam:DescribeServiceLinkedRole',
        'cam:GetRole',

        'cdn:TcbCheckResource',
        'organization:DescribeCloudApplicationToMember',

        'tcbr:DescribeArchitectureType',
        'tcbr:DescribeUserServiceTermsRecord',

        'lowcode:GetUserCertifyInfo',
        'lowcode:DescribeUserCompositeGroupsList',
        'lowcode:DescribeWedaWxBind',
        'lowcode:GetMaxAppNum',
        'lowcode:DescribeApps',

        'ssl:DescribeCertificateDetail',
        'ssl:DescribeCertificates',
      ],
      effect: 'allow',
      resource: ['*'],
    },
    // Statement 1b: tcb 元信息 / 账户 / 通用计费查询
    {
      action: [
        'tcb:CheckTcbService',
        'tcb:DescribePackages',
        'tcb:DescribeEnvLimit',
        'tcb:DescribeBillingInfo',
        'tcb:DescribeExt*',
        'tcb:DescribeCloudBaseRunAdvancedConfiguration',
        'tcb:DescribePostPackage',
        'tcb:DescribeICPResources',
        'tcb:DescribeMonitorMetric',
        'tcb:DescribeLowCodeUserQuotaUsage',
        'tcb:DescribeEnvStatistics',
        'tcb:DescribeLowCodeEnvQuotaUsage',
        'tcb:CheckFeaturePermission',
        'tcb:DescribeCommonBillingResources',
        'tcb:DescribeCommonBillingPackages',
        'tcb:DescribeAgentList',
        'tcb:DescribeTenant',
        'tcb:GetTemplateAPIsList',
        'tcb:GetApisGroupAndList',
        'tcb:GetUserKeyList',
        'tcb:DescribeEnvBacklogs',
        'tcb:DescribeEnvRestriction',
        'tcb:DescribeUserPromotionalActivity',
        'tcb:DescribeFeaturePermissions',
        'tcb:RefreshAuthDomain',
        'tcb:DescribeActivityInfo',
        'tcb:DescribeTcbAccountInfo',
      ],
      effect: 'allow',
      resource: ['*'],
    },
    // Statement 1c: tcb 模板 / 数据库 / 函数（CAM 以主账号鉴权，必须 resource: *）
    {
      action: [
        'tcb:DescribeAIModels',
        'tcb:DescribeOperationAppTemplates',
        'tcb:DescribeSolutionList',
        'tcb:DescribeCloudBaseRunBaseImages',
        'tcb:DescribeBuildServiceList',

        'tcb:DeleteTable',
        'tcb:CreateTable',
        'tcb:DescribeTable',
        'tcb:DescribeTables',
        'tcb:ListTables',
        'tcb:RunCommands',
        'tcb:UpdateTable',
        'tcb:UpdateItem',
        'tcb:QueryRecords',
        'tcb:PutItem',
        'tcb:ModifyNameSpace',
        'tcb:DeleteItem',
        'tcb:CountRecords',
        'tcb:DescribeRestoreTime',
        'tcb:RestoreTCBTables',
        'tcb:DescribeRestoreTask',
        'tcb:DescribeRestoreTables',

        'tcb:CreateFunction',
        'tcb:UpdateFunctionCode',
        'tcb:UpdateFunctionIncrementalCode',
        'tcb:GetFunctionLogsStatus',
        'tcb:GetFunctionLogDetail',
        'tcb:GetFunctionLogs',
      ],
      effect: 'allow',
      resource: ['*'],
    },
    // Statement 2: tcb:* 限定到环境
    {
      action: ['tcb:*'],
      effect: 'allow',
      resource: [`qcs::tcb:${region}:uin/${ownerUin}:env/${envId}`],
    },
    // Statement 3: tcbr:* 限定到环境
    {
      action: ['tcbr:*'],
      effect: 'allow',
      resource: [`qcs::tcbr:${region}:uin/${ownerUin}:env/${envId}`],
    },
    // Statement 4: lowcode:* 限定到环境
    {
      action: ['lowcode:*'],
      effect: 'allow',
      resource: [`qcs::lowcode::uin/${ownerUin}:env/${envId}`],
    },
    // Statement 5: scf:* 限定到 namespace（namespace = envId）
    {
      action: ['scf:*'],
      effect: 'allow',
      resource: [`qcs::scf:${region}:uin/${ownerUin}:namespace/${envId}/function/*`],
    },
    // Statement 6: cos:* 通过 tag condition 隔离
    {
      action: ['cos:*'],
      effect: 'allow',
      resource: ['*'],
      condition: {
        'for_any_value:string_equal': {
          'qcs:resource_tag': [`vibe-env&${cosTagValue}`],
        },
      },
    },
  ]
}

/**
 * STS GetFederationToken inline policy 专用（兜底）
 *
 * ⚠️ 现状说明：
 *   支撑密钥（TCB_SECRET_ID/KEY）当前是子账号身份。腾讯云对子账号调
 *   GetFederationToken 有奇葩限制：
 *   - inline policy 中如果含 `qcs::tcb:region:uin/<主账号 uin>:env/...` 这种
 *     ARN，签出来的 token 调 tcb 接口会被服务端判 invalid token（即便 grant
 *     成功）；
 *   - 即使 ARN 写 `*`，只要 action 列出 `tcb:*`、`tcbr:*` 等具体服务，token
 *     调 tcb 接口仍会 invalid（见实测）；
 *   - 唯一能让 token 真正可用的 inline 写法：`{ action: ['*'], resource: ['*'] }`
 *
 * 换句话说，inline policy 在子账号支撑密钥签发场景下**做不到 envId 收紧**。
 * 真正的 envId 隔离已经在 provision 阶段通过 buildUserEnvPolicyStatements
 * 写到了每个用户的 CAM 子账号大 policy 上 —— middleware 优先用 user_resources
 * 表里的永久密钥（camSecretId/camSecretKey）走 permanent 分支；
 * 这里只是 user_resources 没有永久密钥时的兜底，签发出来的临时凭证有效但
 * 没做隔离收紧（与支撑账号本身权限一致）。
 *
 * 后续如果支撑账号换成主账号 root 密钥或申请到 sts:GetFederationToken 跨 uin
 * grant 权限，再回来加 envId ARN 限定。
 */
export function buildStsInlinePolicyStatements(_params: PolicyBuildParams) {
  return [{ action: ['*'], effect: 'allow', resource: ['*'] }]
}
// ─── Helpers ─────────────────────────────────────────────────────────────────

function getClients() {
  const credential = {
    secretId: process.env.TCB_SECRET_ID || process.env.TENCENT_SECRET_ID || '',
    secretKey: process.env.TCB_SECRET_KEY || process.env.TENCENT_SECRET_KEY || '',
    token: process.env.TCB_TOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN || '',
  }

  const camClient = new CamClient({
    credential,
    region: '',
    profile: { httpProfile: { endpoint: 'cam.tencentcloudapi.com' } },
  })

  const tcbClient = new TcbClient({
    credential,
    region: process.env.TCB_REGION || 'ap-shanghai',
    profile: { httpProfile: { endpoint: 'tcb.tencentcloudapi.com' } },
  })

  const tagClient = new TagClient({
    credential,
    region: process.env.TCB_REGION || 'ap-shanghai',
  })

  return { camClient, tcbClient, tagClient }
}

/**
 * 获取主账号 UIN
 * 优先级：环境变量 TENCENTCLOUD_ACCOUNT_ID > STS.GetCallerIdentity 自动获取
 * 获取成功后写回 process.env，后续直接读取环境变量即可
 */
async function getOwnerUin(): Promise<string> {
  // 1. 环境变量已有
  if (process.env.TENCENTCLOUD_ACCOUNT_ID) {
    return process.env.TENCENTCLOUD_ACCOUNT_ID
  }

  // 2. 通过 STS.GetCallerIdentity 反查
  const secretId = process.env.TCB_SECRET_ID || process.env.TENCENT_SECRET_ID || ''
  const secretKey = process.env.TCB_SECRET_KEY || process.env.TENCENT_SECRET_KEY || ''
  if (!secretId || !secretKey) {
    throw new Error('[provision] Cannot determine ownerUin: no TENCENTCLOUD_ACCOUNT_ID and no TCB_SECRET_ID/KEY')
  }

  try {
    const StsClient = (tencentcloud as any).sts.v20180813.Client
    const stsClient = new StsClient({
      credential: { secretId, secretKey },
      region: 'ap-guangzhou',
      profile: { httpProfile: { endpoint: 'sts.tencentcloudapi.com' } },
    })
    const resp = await stsClient.GetCallerIdentity({})
    if (resp?.AccountId) {
      // 写回环境变量，后续所有读取处自动获益
      process.env.TENCENTCLOUD_ACCOUNT_ID = resp.AccountId
      console.log(`[provision] Resolved ownerUin via STS: ${resp.AccountId}`)
      return resp.AccountId
    }
  } catch (e: any) {
    console.error('[provision] STS.GetCallerIdentity failed:', e?.message)
  }

  throw new Error('[provision] Cannot determine ownerUin: TENCENTCLOUD_ACCOUNT_ID not set and STS lookup failed')
}

export function computePolicyHash(policyDocument: string): string {
  return createHash('md5').update(policyDocument).digest('hex')
}

/**
 * 生成 COS tag value 并在 Tag 服务中预创建
 * 格式: vibe-${userId.slice(0,12)}-${nanoid(4)}
 */
async function createCosTag(tagClient: any, userId: string): Promise<string> {
  const tagValue = `vibe-${userId.slice(0, 12)}-${nanoid(4)}`

  try {
    await tagClient.CreateTag({ TagKey: 'vibe-env', TagValue: tagValue })
    console.log(`[provision] Created tag vibe-env=${tagValue}`)
  } catch (e: any) {
    // Tag already exists is idempotent
    if (e?.message?.includes('existed') || e?.message?.includes('Existed')) {
      console.log(`[provision] Tag vibe-env=${tagValue} already exists`)
    } else {
      throw e
    }
  }

  return tagValue
}

/**
 * 轮询等待 CloudBase 环境就绪
 */
async function waitForEnvReady(
  tcbClient: any,
  envId: string,
  timeoutMs = 120_000,
  intervalMs = 5_000,
): Promise<{ region: string; alias: string }> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const resp = await tcbClient.DescribeEnvs({ EnvId: envId })
      const env = resp.EnvList?.[0]
      if (env?.Status === 'NORMAL') {
        return {
          region: env.Region || process.env.TCB_REGION || 'ap-shanghai',
          alias: env.Alias || '',
        }
      }
      // 只有明确的 ERROR 状态才视为终态失败
      // UNAVAILABLE / INITIALIZING 等都视为中间状态，继续等待
      if (env?.Status === 'ERROR') {
        throw new Error(`Env ${envId} entered terminal status: ${env.Status}`)
      }
      console.log(`[provision] Env ${envId} status: ${env?.Status || 'unknown'}, waiting...`)
    } catch (e: any) {
      // DescribeEnvs may fail transiently during creation
      if (e?.message?.includes('terminal status')) throw e
      console.log('[provision] DescribeEnvs transient error:', e?.message)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  throw new Error(`Env ${envId} did not reach NORMAL within ${timeoutMs / 1000}s`)
}

function generatePassword(length = 16): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '0123456789'
  const special = '!@#$%^&*()-_=+'
  const all = upper + lower + digits + special

  const password: string[] = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)],
  ]

  for (let i = password.length; i < length; i++) {
    password.push(all[Math.floor(Math.random() * all.length)])
  }

  for (let i = password.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[password[i], password[j]] = [password[j], password[i]]
  }

  return password.join('')
}

// ─── Main Provision Flow ─────────────────────────────────────────────────────

/**
 * 为用户/任务创建 CloudBase 资源：
 * 1. CAM 子账号 + API 密钥
 * 2. COS Tag（用于 bucket 隔离）
 * 3. CloudBase 环境（带 Tags）
 * 4. 等待环境就绪
 * 5. 权限策略（精确 ARN + tag condition）
 *
 * scope 区分：
 *   - 不传 taskId → user 级，CAM username = `vibe_{userId}`，每个 user 一个 CAM 子账号
 *   - 传 taskId   → task 级，CAM username = `vibe_t_{taskId}`，每个 task 一个独立子账号
 *     （避免多 task 共用同一 CAM user 时 AccessKey 互相轮换覆盖）
 */
export async function provisionUserResources(
  userId: string,
  username: string,
  options?: { taskId?: string },
): Promise<ProvisionResult> {
  const { camClient, tcbClient, tagClient } = getClients()
  const ownerUin = await getOwnerUin()
  let currentStep = 'cam_user'

  try {
    // ─── 步骤 1：创建 CAM 子账号 ─────────────────────────────────
    currentStep = 'cam_user'
    // task 级：用 taskId 派生独立 CAM 用户名；否则用 userId（保持 user 级行为不变）
    const camUsername = options?.taskId
      ? `vibe_t_${options.taskId.substring(0, 18)}`
      : `vibe_${userId.substring(0, 20)}`
    let subAccountUin: number
    let camSecretId: string = ''
    let camSecretKey: string = ''

    try {
      console.log('[provision] Checking existing CAM user')
      const getUserResp = await (camClient as any).GetUser({ Name: camUsername })
      subAccountUin = getUserResp.Uin
      // 子账号已存在，确保有 API 密钥
      const listKeysResp = await (camClient as any).ListAccessKeys({ TargetUin: subAccountUin })
      const activeKeys = (listKeysResp.AccessKeys || []).filter((k: any) => k.Status === 'Active')
      if (activeKeys.length > 0) {
        // 已有密钥但 SecretKey 不可恢复，需要轮换
        for (const k of activeKeys) {
          await (camClient as any).DeleteAccessKey({ TargetUin: subAccountUin, AccessKeyId: k.AccessKeyId })
        }
      }
      const createKeyResp = await (camClient as any).CreateAccessKey({ TargetUin: subAccountUin })
      camSecretId = createKeyResp.AccessKey.AccessKeyId
      camSecretKey = createKeyResp.AccessKey.SecretAccessKey
      console.log('[provision] Reused existing CAM user, rotated key')
    } catch {
      // 创建新子账号（AddUser + UseApi=1 直接返回 AK/SK）
      console.log('[provision] Creating CAM user')
      const password = generatePassword()
      const addUserResp = await (camClient as any).AddUser({
        Name: camUsername,
        Remark: `coder user ${userId} ${username}`,
        ConsoleLogin: 0,
        Password: password,
        NeedResetPassword: 0,
        UseApi: 1,
      })
      subAccountUin = addUserResp.Uin
      if (addUserResp.SecretId) {
        camSecretId = addUserResp.SecretId
        camSecretKey = addUserResp.SecretKey
      } else {
        // Fallback: AddUser 未返回密钥，单独创建
        const createKeyResp = await (camClient as any).CreateAccessKey({ TargetUin: subAccountUin })
        camSecretId = createKeyResp.AccessKey.AccessKeyId
        camSecretKey = createKeyResp.AccessKey.SecretAccessKey
      }
    }

    // ─── 步骤 2：创建 COS Tag ────────────────────────────────────
    currentStep = 'cos_tag'
    const cosTagValue = await createCosTag(tagClient, userId)

    // ─── 步骤 3：创建 CloudBase 环境 ─────────────────────────────
    currentStep = 'create_env'
    const envAlias = `coder-${username.slice(0, 10)}`
    console.log('[provision] Creating CloudBase env')
    const createEnvResp = await (tcbClient as any).CreateEnv({
      Alias: envAlias,
      PackageId: 'baas_personal',
      Resources: ['flexdb', 'storage', 'function'],
      Tags: [{ Key: 'vibe-env', Value: cosTagValue }],
    })
    const envId: string = createEnvResp.EnvId

    // ─── 步骤 4：等待环境就绪 ────────────────────────────────────
    currentStep = 'wait_env_ready'
    console.log('[provision] Waiting for env to become NORMAL...')
    const envInfo = await waitForEnvReady(tcbClient, envId)
    const envRegion = envInfo.region
    console.log(`[provision] Env ${envId} ready (region=${envRegion})`)

    // ─── 步骤 4.5：添加安全域名 ──────────────────────────────────
    try {
      const mainEnvId = process.env.TCB_ENV_ID
      const domains = ['localhost:5173']
      if (mainEnvId) {
        domains.push(`${mainEnvId}.service.tcloudbase.com`)
      }
      console.log('[provision] Adding security domains:', domains.join(', '))
      await (tcbClient as any).CreateAuthDomain({
        EnvId: envId,
        Domains: domains,
      })
    } catch (e) {
      // 非关键：安全域名添加失败不阻塞环境创建
      console.log('[provision] CreateAuthDomain failed (non-critical):', (e as Error).message)
    }

    // ─── 步骤 5：创建权限策略（精确 ARN）────────────────────────
    currentStep = 'create_policy'
    const policyName = `coder_policy_${envId}`
    let policyId: number | undefined

    try {
      console.log('[provision] Listing policies')
      const listResp = await (camClient as any).ListPolicies({ Keyword: policyName, Scope: 'Local' })
      const found = (listResp.List || []).find((p: any) => p.PolicyName === policyName)
      if (found) policyId = found.PolicyId
    } catch {
      // 查询失败不阻塞
    }

    const policyDocument = JSON.stringify({
      version: '2.0',
      statement: buildUserEnvPolicyStatements({ envId, region: envRegion, ownerUin, cosTagValue }),
    })
    const policyHash = computePolicyHash(policyDocument)

    if (!policyId) {
      console.log('[provision] Creating policy')
      const createPolicyResp = await (camClient as any).CreatePolicy({
        PolicyName: policyName,
        PolicyDocument: policyDocument,
        Description: 'Coder env access',
      })
      policyId = createPolicyResp.PolicyId
    } else {
      // Policy 已存在，用新内容更新
      console.log('[provision] Updating existing policy')
      await (camClient as any).UpdatePolicy({
        PolicyId: policyId,
        PolicyDocument: policyDocument,
        Description: 'Coder env access (updated)',
      })
    }

    // ─── 步骤 6：绑定策略到子账号 ───────────────────────────────
    currentStep = 'attach_policy'
    console.log('[provision] Attaching user policy')
    await (camClient as any).AttachUserPolicy({
      AttachUin: subAccountUin,
      PolicyId: policyId,
    })

    return {
      envId,
      envAlias: envInfo.alias || envAlias,
      envRegion,
      cosTagValue,
      policyHash,
      camUsername,
      camSecretId,
      camSecretKey,
      policyId: policyId!,
    }
  } catch (e) {
    ;(e as any).__provisionFailStep = currentStep
    throw e
  }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * 为已存在的 CloudBase 环境添加安全域名
 * 用于补全历史环境缺少的安全域名配置
 */
export async function ensureAuthDomains(envId: string, domains: string[]): Promise<void> {
  const { tcbClient } = getClients()
  try {
    await (tcbClient as any).CreateAuthDomain({
      EnvId: envId,
      Domains: domains,
    })
    console.log('[provision] Auth domains added')
  } catch (e: any) {
    // ResourceInUse = 域名已存在，忽略
    if (e?.code === 'ResourceInUse') {
      console.log('[provision] Auth domains already exist')
      return
    }
    console.log('[provision] CreateAuthDomain failed:', (e as Error).message)
  }
}

/**
 * 回滚 provisionUserResources 创建的腾讯云资源（注册失败时使用）
 * 不销毁环境，仅清理 CAM 资源和 Tag
 */
export async function rollbackProvisionedResources(result: Partial<ProvisionResult>): Promise<void> {
  const { camClient, tagClient } = getClients()

  if (result.cosTagValue) {
    try {
      await (tagClient as any).DeleteTag({ TagKey: 'vibe-env', TagValue: result.cosTagValue })
    } catch {
      // best-effort
    }
  }

  if (result.policyId) {
    try {
      await (camClient as any).DeletePolicy({ PolicyId: [result.policyId] })
    } catch {
      // best-effort
    }
  }

  if (result.camUsername) {
    try {
      await (camClient as any).DeleteUser({ Name: result.camUsername, Force: 1 })
    } catch {
      // best-effort
    }
  }
}

/**
 * 删除用户/任务时清理腾讯云资源（CAM 子用户 + 策略 + Tag + 云开发环境）
 *
 * 返回每一步的结果。调用方应根据 `failed` 决定是否阻止 DB 删除：
 *   - failed.length === 0 → 全部清掉（含已不存在的视为幂等成功）→ 可以删 DB row
 *   - failed.length > 0   → 还有资源没清干净（如 env 仍在初始化）→ 保留 DB row，下次重试
 *
 * "已不存在"（NotFound 类错误）视为幂等成功，不计入 failed。
 */
export interface DestroyStepResult {
  step: 'tag' | 'policy' | 'cam_user' | 'env'
  status: 'ok' | 'not_found' | 'failed' | 'skipped'
  message?: string
  code?: string
  requestId?: string
}

export async function destroyProvisionedResources(resource: {
  camUsername?: string | null
  policyId?: number | null
  envId?: string | null
  cosTagValue?: string | null
}): Promise<{ steps: DestroyStepResult[]; failed: DestroyStepResult[] }> {
  const { camClient, tcbClient, tagClient } = getClients()
  const steps: DestroyStepResult[] = []

  const isNotFound = (e: any): boolean => {
    const code: string = e?.code || e?.original?.Code || ''
    const msg: string = (e?.message || '').toString()
    return (
      /NotExist|NotFound|NoSuch|ResourceNotFound|UnauthorizedOperation\.NotExist/i.test(code) ||
      /not exist|不存在|已删除|user does not exist/i.test(msg)
    )
  }

  // 销毁顺序：
  //   1. env → 推入隔离（一次 DestroyEnv 即可，隔离期满腾讯云后端自动彻底删）
  //   2. cam_user / policy
  //   3. 解绑 tag 上挂的资源（cos bucket 等）→ 删 tag
  //
  // 不发第 2 次 DestroyEnv（{IsForce, BypassCheck}）— env 进入隔离期后腾讯云后端会在
  // 隔离期满（默认 7 天）自动彻底销毁；强删反而绕过腾讯云的"反悔窗口"保护。tag 上挂的
  // cos bucket 是 env 子资源（生命周期跟随 env），现在 env 尚未销毁所以 bucket 还在 →
  // 用 DescribeResourcesByTags + DetachResourcesTag 主动解绑 tag 关联，再 DeleteTag。

  // 1) 推入隔离（NORMAL → Isolated）
  if (resource.envId && resource.envId !== process.env.TCB_ENV_ID) {
    const envId = resource.envId
    try {
      await (tcbClient as any).DestroyEnv({ EnvId: envId })
      console.log('[provision] DestroyEnv (NORMAL → Isolated) accepted', { envId })
      steps.push({ step: 'env', status: 'ok' })
    } catch (e: any) {
      const code: string = e?.code || e?.original?.Code || ''
      const msg: string = (e?.message || '').toString()
      if (isNotFound(e)) {
        steps.push({ step: 'env', status: 'not_found', message: msg })
      } else if (/isolated|isolate|已隔离|当前环境状态.*隔离/i.test(msg)) {
        // 已在隔离期，幂等成功
        console.log('[provision] env already isolated', { envId })
        steps.push({ step: 'env', status: 'ok' })
      } else {
        console.warn('[provision] DestroyEnv failed', { envId, message: msg, code, requestId: e?.requestId })
        steps.push({ step: 'env', status: 'failed', message: msg, code, requestId: e?.requestId })
      }
    }
  } else {
    steps.push({ step: 'env', status: 'skipped' })
  }

  // 2) 删除 CAM 子账号（级联删除 API 密钥）
  if (resource.camUsername) {
    try {
      await (camClient as any).DeleteUser({ Name: resource.camUsername, Force: 1 })
      console.log('[provision] CAM user deleted')
      steps.push({ step: 'cam_user', status: 'ok' })
    } catch (e: any) {
      if (isNotFound(e)) {
        steps.push({ step: 'cam_user', status: 'not_found', message: e?.message })
      } else {
        console.warn('[provision] CAM user delete failed', { message: e?.message, code: e?.code })
        steps.push({ step: 'cam_user', status: 'failed', message: e?.message, code: e?.code, requestId: e?.requestId })
      }
    }
  } else {
    steps.push({ step: 'cam_user', status: 'skipped' })
  }

  // 3) 删除 CAM 策略
  if (resource.policyId) {
    try {
      await (camClient as any).DeletePolicy({ PolicyId: [resource.policyId] })
      console.log('[provision] CAM policy deleted')
      steps.push({ step: 'policy', status: 'ok' })
    } catch (e: any) {
      if (isNotFound(e)) {
        steps.push({ step: 'policy', status: 'not_found', message: e?.message })
      } else {
        console.warn('[provision] CAM policy delete failed', { message: e?.message, code: e?.code })
        steps.push({ step: 'policy', status: 'failed', message: e?.message, code: e?.code, requestId: e?.requestId })
      }
    }
  } else {
    steps.push({ step: 'policy', status: 'skipped' })
  }

  // 4) 删除 Tag
  //    Tag 上挂着 env 子资源（tcb / tcbr / lowcode / scf / cos bucket 等）。env 进入隔离期后
  //    腾讯云后端会在隔离期满（默认 7 天）自动彻底删 env 及所有子资源，tag 关联也随之解除。
  //    此时如果直接 DeleteTag 大概率仍有资源引用 → 降级为 not_found（孤立 tag 无功能影响，
  //    后台/定期清理可回收）。
  //
  //    主动解绑（DescribeResourcesByTags + UnTagResources）实测：
  //      - 非 cos 资源（tcb/tcbr/lowcode/scf）能成功解绑
  //      - cos bucket 的 tag 在 cos 自己服务管理，统一 tag API 解不掉
  //    所以解绑也只能部分成功 → 仍可能 DeleteTag 失败。综合考虑：直接尝试 DeleteTag，
  //    失败降级，等 env 隔离期满自动清理。
  if (resource.cosTagValue) {
    const tagKey = 'vibe-env'
    const tagValue = resource.cosTagValue
    try {
      await (tagClient as any).DeleteTag({ TagKey: tagKey, TagValue: tagValue })
      console.log('[provision] Tag deleted')
      steps.push({ step: 'tag', status: 'ok' })
    } catch (e: any) {
      const code: string = e?.code || e?.original?.Code || ''
      if (isNotFound(e)) {
        steps.push({ step: 'tag', status: 'not_found', message: e?.message })
      } else if (/TagAttachedResource/i.test(code)) {
        console.warn('[provision] Tag still attached, leave to background cleanup (env isolation period will clean)', {
          tagValue,
          message: e?.message,
        })
        steps.push({ step: 'tag', status: 'not_found', message: `attached: ${e?.message}` })
      } else {
        console.warn('[provision] Tag delete failed', { message: e?.message, code: e?.code })
        steps.push({ step: 'tag', status: 'failed', message: e?.message, code: e?.code, requestId: e?.requestId })
      }
    }
  } else {
    steps.push({ step: 'tag', status: 'skipped' })
  }

  // 2) 删除 CAM 子账号（级联删除 API 密钥）
  if (resource.camUsername) {
    try {
      await (camClient as any).DeleteUser({ Name: resource.camUsername, Force: 1 })
      console.log('[provision] CAM user deleted')
      steps.push({ step: 'cam_user', status: 'ok' })
    } catch (e: any) {
      if (isNotFound(e)) {
        steps.push({ step: 'cam_user', status: 'not_found', message: e?.message })
      } else {
        console.warn('[provision] CAM user delete failed', { message: e?.message, code: e?.code })
        steps.push({ step: 'cam_user', status: 'failed', message: e?.message, code: e?.code, requestId: e?.requestId })
      }
    }
  } else {
    steps.push({ step: 'cam_user', status: 'skipped' })
  }

  // 3) 删除 CAM 策略
  if (resource.policyId) {
    try {
      await (camClient as any).DeletePolicy({ PolicyId: [resource.policyId] })
      console.log('[provision] CAM policy deleted')
      steps.push({ step: 'policy', status: 'ok' })
    } catch (e: any) {
      if (isNotFound(e)) {
        steps.push({ step: 'policy', status: 'not_found', message: e?.message })
      } else {
        console.warn('[provision] CAM policy delete failed', { message: e?.message, code: e?.code })
        steps.push({ step: 'policy', status: 'failed', message: e?.message, code: e?.code, requestId: e?.requestId })
      }
    }
  } else {
    steps.push({ step: 'policy', status: 'skipped' })
  }

  // 4) 删除 Tag（注意：env 销毁是异步的，cos bucket 等可能还没解绑，此时 DeleteTag 会报
  //    FailedOperation.TagAttachedResource。这种情况降级为非阻塞警告，不计入 failed，避免
  //    阻塞外层 DB 删除——剩下的孤立 tag 无功能影响，由后台/定期扫描清理）
  if (resource.cosTagValue) {
    try {
      await (tagClient as any).DeleteTag({ TagKey: 'vibe-env', TagValue: resource.cosTagValue })
      console.log('[provision] Tag deleted')
      steps.push({ step: 'tag', status: 'ok' })
    } catch (e: any) {
      const code: string = e?.code || e?.original?.Code || ''
      if (isNotFound(e)) {
        steps.push({ step: 'tag', status: 'not_found', message: e?.message })
      } else if (/TagAttachedResource/i.test(code)) {
        // Tag 上仍有 cos bucket 等资源在异步释放中，降级为非阻塞警告
        console.warn('[provision] Tag still attached to resources, skipping (will be cleaned up later)', {
          cosTagValue: resource.cosTagValue,
          message: e?.message,
        })
        steps.push({ step: 'tag', status: 'not_found', message: `attached: ${e?.message}` })
      } else {
        console.warn('[provision] Tag delete failed', { message: e?.message, code: e?.code })
        steps.push({ step: 'tag', status: 'failed', message: e?.message, code: e?.code, requestId: e?.requestId })
      }
    }
  } else {
    steps.push({ step: 'tag', status: 'skipped' })
  }

  const failed = steps.filter((s) => s.status === 'failed')
  return { steps, failed }
}
