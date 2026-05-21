/**
 * 统一环境生命周期管理。
 *
 * 对外只暴露两个方法：
 *   - acquireEnv()  — 获取一个环境（shared 直接返回，isolated/task 从池或实时创建）
 *   - releaseEnv()  — 释放一个环境（shared no-op，其他走销毁）
 *
 * 调用方无需关心池化是否开启、当前是哪种 provision mode。
 */

import { getProvisionMode, type ProvisionMode } from '../lib/provision-config.js'
import { provisionUserResources, destroyProvisionedResources, type ProvisionResult } from './provision.js'
import { claimFromPool, replenishPool, getPoolStats } from './env-pool.js'
import { getDb } from '../db/index.js'

// ─── Config (from DB) ───────────────────────────────────────────────────────

async function isPoolEnabled(): Promise<boolean> {
  try {
    const setting = await getDb().settings.findSystemSetting('env_pool_enabled')
    return setting?.value === 'true'
  } catch {
    return false
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface AcquireEnvOptions {
  userId: string
  username: string
  /** task 模式时传入 taskId */
  taskId?: string
  /** 覆盖自动检测的 mode（调用方已知 mode 时可直接传入，避免重复读 DB） */
  mode?: ProvisionMode
}

/**
 * 获取一个环境。
 *
 * - shared   → 返回主环境 TCB_ENV_ID（不创建，不走池）
 * - isolated → 创建独立环境（池化开启时从池认领）
 * - task     → 创建 task 级环境（池化开启时从池认领）
 */
export async function acquireEnv(opts: AcquireEnvOptions): Promise<ProvisionResult> {
  const mode = opts.mode || (await getProvisionMode())

  if (mode === 'shared') {
    return sharedResult()
  }

  // isolated / task: 尝试从池认领
  if (await isPoolEnabled()) {
    const poolResult = await claimFromPool(opts.userId, opts.username, opts.taskId)
    if (poolResult) {
      console.log(`[env-lifecycle] Acquired from pool (mode=${mode})`)
      return poolResult
    }
    console.log(`[env-lifecycle] Pool empty, fallback to direct provision (mode=${mode})`)
  }

  // 实时创建（兜底）
  return provisionUserResources(opts.userId, opts.username, { taskId: opts.taskId })
}

/**
 * 释放一个环境。
 *
 * - envId === TCB_ENV_ID → no-op（shared 主环境不销毁）
 * - 其他 → 销毁所有关联资源（CAM + Tag + Policy + CloudBase env）
 *
 * 返回值透传 destroyProvisionedResources 的结果。
 */
export async function releaseEnv(resource: {
  camUsername?: string | null
  policyId?: number | null
  envId?: string | null
  cosTagValue?: string | null
}): Promise<{
  steps: Array<{ step: string; status: string; message?: string }>
  failed: Array<{ step: string; status: string; message?: string }>
}> {
  // shared 主环境保护
  if (!resource.envId || resource.envId === process.env.TCB_ENV_ID) {
    return { steps: [], failed: [] }
  }

  const result = await destroyProvisionedResources(resource)

  // 池化模式下触发补充
  if (await isPoolEnabled()) {
    void replenishPool()
  }

  return result
}

/**
 * 服务启动时初始化。池化关闭时为 no-op。
 */
export async function initEnvLifecycle(): Promise<void> {
  if (!(await isPoolEnabled())) {
    console.log('[env-lifecycle] Pool disabled')
    return
  }
  console.log('[env-lifecycle] Pool enabled, starting replenishment...')
  void replenishPool()
}

/**
 * 获取池状态（admin API 用）
 */
export { getPoolStats }

// ─── Internal ───────────────────────────────────────────────────────────────

function sharedResult(): ProvisionResult {
  return {
    envId: process.env.TCB_ENV_ID || '',
    envAlias: '',
    envRegion: process.env.TCB_REGION || 'ap-shanghai',
    cosTagValue: '',
    policyHash: '',
    camUsername: '',
    camSecretId: process.env.TCB_SECRET_ID || '',
    camSecretKey: process.env.TCB_SECRET_KEY || '',
    policyId: 0,
  }
}
