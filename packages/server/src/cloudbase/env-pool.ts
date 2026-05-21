/**
 * Environment Pool — 内部池管理逻辑。
 *
 * 职责：预创建完整的 CloudBase 环境资源（env + CAM + tag + policy），
 * 放入池中等待认领。
 *
 * 多 Pod 安全：
 *   - 认领：用 DB CAS（findReady → update WHERE status='ready'），并发安全
 *   - 补充：用 DB 分布式锁（settings 表），只有一个 pod 执行补充
 *
 * 不对外暴露，由 env-lifecycle.ts 调用。
 */

import { nanoid } from 'nanoid'
import { hostname } from 'os'
import { getDb } from '../db/index.js'
import { provisionUserResources, destroyProvisionedResources, type ProvisionResult } from './provision.js'

// ─── Config ─────────────────────────────────────────────────────────────────

const POOL_PLACEHOLDER_PREFIX = '__pool__'
const POD_ID = `${hostname()}-${process.pid}`
const REPLENISH_LOCK_KEY = '__env_pool_replenish_lock__'
const REPLENISH_LOCK_TTL_MS = 5 * 60 * 1000 // 5 分钟锁过期（安全网）
const DEFAULT_POOL_SIZE = 2

async function getPoolSize(): Promise<number> {
  try {
    const setting = await getDb().settings.findSystemSetting('env_pool_size')
    if (setting?.value) {
      const n = parseInt(setting.value, 10)
      if (n > 0) return n
    }
  } catch {
    // DB not available
  }
  return DEFAULT_POOL_SIZE
}

// ─── Public API (internal to cloudbase/) ────────────────────────────────────

/**
 * 从池中认领一个就绪环境。
 * 多 Pod 安全：用 CAS 更新，只有一个 pod 能成功认领同一条记录。
 * 成功返回 ProvisionResult，池空返回 null。
 */
export async function claimFromPool(
  userId: string,
  _username: string,
  taskId?: string,
): Promise<ProvisionResult | null> {
  const db = getDb()

  // 最多重试 3 次（处理并发竞争：多个 pod 同时 findReady 拿到同一条）
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await db.envPool.findReady()
    if (!entry || !entry.envId) return null

    // CAS: 只有 status 仍为 'ready' 才能更新为 'claimed'
    const updated = await db.envPool.claimEntry(entry.id, {
      claimedByUserId: userId,
      claimedByTaskId: taskId || null,
      claimedAt: Date.now(),
    })

    if (!updated) {
      // 被其他 pod 抢走了，重试
      console.log(`[env-pool] Claim race on entry ${entry.id}, retrying...`)
      continue
    }

    console.log(`[env-pool] Claimed pool entry ${entry.id} (env=${entry.envId}) for user=${userId}`)

    // 认领后异步补充池
    void triggerReplenish()

    return {
      envId: entry.envId,
      envAlias: entry.envAlias || '',
      envRegion: entry.envRegion || '',
      cosTagValue: entry.cosTagValue || '',
      policyHash: entry.policyHash || '',
      camUsername: entry.camUsername || '',
      camSecretId: entry.camSecretId || '',
      camSecretKey: entry.camSecretKey || '',
      policyId: entry.policyId || 0,
    }
  }

  return null
}

/**
 * 补充池到目标容量。
 * 多 Pod 安全：通过 DB 锁，只有一个 pod 执行补充。
 */
export async function replenishPool(): Promise<void> {
  const acquired = await acquireReplenishLock()
  if (!acquired) {
    // 另一个 pod 正在补充
    return
  }

  try {
    const db = getDb()
    const poolSize = await getPoolSize()
    const activeCount = await db.envPool.countActive()
    const deficit = poolSize - activeCount

    if (deficit <= 0) {
      console.log(`[env-pool] Pool is full (active=${activeCount}, target=${poolSize})`)
      return
    }

    console.log(`[env-pool] Replenishing pool: need ${deficit} more (active=${activeCount}, target=${poolSize})`)

    // 逐个串行创建（避免 API 限流）
    for (let i = 0; i < deficit; i++) {
      await provisionPoolEntry(i)
    }
  } finally {
    await releaseReplenishLock()
  }
}

/**
 * 获取池统计信息
 */
export async function getPoolStats(): Promise<Record<string, number>> {
  return getDb().envPool.getStats()
}

/**
 * 释放池中所有未认领的资源（status='ready'），销毁对应的云环境 + CAM + Tag。
 * 用于手动清理闲置资源，防止资源浪费。
 * 返回释放的数量。
 */
export async function drainPool(): Promise<{ drained: number; failed: number }> {
  const db = getDb()
  const readyEntries = await db.envPool.findAllByStatus('ready')

  if (readyEntries.length === 0) {
    console.log('[env-pool] Drain: no ready entries to release')
    return { drained: 0, failed: 0 }
  }

  console.log(`[env-pool] Draining pool: ${readyEntries.length} ready entries to destroy`)

  let drained = 0
  let failed = 0

  for (const entry of readyEntries) {
    try {
      // 先标记为 releasing 防止被认领
      await db.envPool.update(entry.id, { status: 'claimed', claimedByUserId: '__drain__', claimedAt: Date.now() })

      // 销毁云上资源
      await destroyProvisionedResources({
        envId: entry.envId,
        camUsername: entry.camUsername,
        policyId: entry.policyId,
        cosTagValue: entry.cosTagValue,
      })

      // 标记为 failed（已销毁，留痕可查）
      await db.envPool.update(entry.id, { status: 'failed', failReason: 'drained by admin' })
      drained++
      console.log(`[env-pool] Drained entry ${entry.id} (env=${entry.envId})`)
    } catch (e: any) {
      failed++
      await db.envPool.update(entry.id, { status: 'failed', failReason: `drain error: ${e?.message?.slice(0, 200)}` })
      console.error(`[env-pool] Drain failed for entry ${entry.id}:`, e?.message)
    }
  }

  return { drained, failed }
}

// ─── Distributed Lock (via settings table) ──────────────────────────────────

async function acquireReplenishLock(): Promise<boolean> {
  try {
    const db = getDb()
    const existing = await db.settings.findSystemSetting(REPLENISH_LOCK_KEY)

    if (existing && existing.value) {
      // 检查是否过期
      try {
        const lockData = JSON.parse(existing.value) as { podId: string; acquiredAt: number }
        if (Date.now() - lockData.acquiredAt < REPLENISH_LOCK_TTL_MS) {
          // 锁未过期，其他 pod 持有
          return false
        }
      } catch {
        // JSON 解析失败（锁值损坏），视为无锁，继续获取
      }
      // 锁已过期或损坏，覆盖
    }

    await db.settings.upsertSystemSetting(REPLENISH_LOCK_KEY, JSON.stringify({ podId: POD_ID, acquiredAt: Date.now() }))
    return true
  } catch {
    return false
  }
}

async function releaseReplenishLock(): Promise<void> {
  try {
    const db = getDb()
    // 只释放自己持有的锁
    const existing = await db.settings.findSystemSetting(REPLENISH_LOCK_KEY)
    if (existing) {
      try {
        const lockData = JSON.parse(existing.value) as { podId: string }
        if (lockData.podId === POD_ID) {
          await db.settings.upsertSystemSetting(REPLENISH_LOCK_KEY, '')
        }
      } catch {
        // JSON parse 失败，清除
        await db.settings.upsertSystemSetting(REPLENISH_LOCK_KEY, '')
      }
    }
  } catch {
    // best-effort
  }
}

// ─── Internal ───────────────────────────────────────────────────────────────

async function triggerReplenish(): Promise<void> {
  // 延迟 2s 避免认领瞬间的竞态
  await new Promise((r) => setTimeout(r, 2000))
  await replenishPool()
}

async function provisionPoolEntry(seq: number): Promise<void> {
  const db = getDb()
  const entryId = nanoid()
  const poolUserId = `${POOL_PLACEHOLDER_PREFIX}${seq}_${nanoid(4)}`

  // 先写一条 creating 记录
  await db.envPool.create({
    id: entryId,
    status: 'creating',
    envId: null,
    envAlias: null,
    envRegion: null,
    cosTagValue: null,
    policyHash: null,
    camUsername: null,
    camSecretId: null,
    camSecretKey: null,
    policyId: null,
    claimedByUserId: null,
    claimedByTaskId: null,
    claimedAt: null,
    failReason: null,
  })

  try {
    // 复用现有 provisionUserResources（完整创建 CAM + env + policy）
    const result = await provisionUserResources(poolUserId, `pool-${seq}`)

    await db.envPool.update(entryId, {
      status: 'ready',
      envId: result.envId,
      envAlias: result.envAlias,
      envRegion: result.envRegion,
      cosTagValue: result.cosTagValue,
      policyHash: result.policyHash,
      camUsername: result.camUsername,
      camSecretId: result.camSecretId,
      camSecretKey: result.camSecretKey || null,
      policyId: result.policyId,
    })

    console.log(`[env-pool] Entry ${entryId} ready (env=${result.envId})`)
  } catch (e: any) {
    await db.envPool.update(entryId, {
      status: 'failed',
      failReason: e?.message?.slice(0, 500) || 'unknown error',
    })
    console.error(`[env-pool] Entry ${entryId} failed:`, e?.message)
  }
}
