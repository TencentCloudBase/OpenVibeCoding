/**
 * 环境池端到端测试脚本
 *
 * 测试流程：
 *   1. 初始化池（replenishPool）→ 验证 creating → ready
 *   2. 认领（claimFromPool）→ 验证 ready → claimed
 *   3. 验证自动补充
 *   4. 池空回退测试
 *
 * 运行：
 *   cd packages/server
 *   npx tsx src/scripts/test-env-pool.ts
 *
 * 注意：会真实调用腾讯云 API 创建环境！测试后记得清理。
 */

import 'dotenv/config'

// 延迟加载以确保 env vars 已加载
async function main() {
  const { getDb } = await import('../db/index.js')
  const { claimFromPool, replenishPool, getPoolStats } = await import('../cloudbase/env-pool.js')
  const { acquireEnv, releaseEnv, initEnvLifecycle } = await import('../cloudbase/env-lifecycle.js')
  const { getProvisionMode } = await import('../lib/provision-config.js')

  console.log('═══════════════════════════════════════════════')
  console.log('  环境池 E2E 测试')
  console.log('═══════════════════════════════════════════════')
  console.log()

  // 显示配置
  const poolEnabled = process.env.ENV_POOL_ENABLED === 'true'
  const poolSize = parseInt(process.env.ENV_POOL_SIZE || '2', 10)
  const mode = await getProvisionMode()
  console.log(`[config] ENV_POOL_ENABLED = ${poolEnabled}`)
  console.log(`[config] ENV_POOL_SIZE = ${poolSize}`)
  console.log(`[config] provision_mode = ${mode}`)
  console.log()

  if (!poolEnabled) {
    console.log('❌ ENV_POOL_ENABLED 未开启，退出')
    process.exit(1)
  }

  // ─── Test 1: 查看当前池状态 ───────────────────────────────────────
  console.log('── Test 1: 当前池状态 ──')
  const stats1 = await getPoolStats()
  console.log('  stats:', JSON.stringify(stats1))
  console.log()

  // ─── Test 2: 触发补充 ────────────────────────────────────────────
  console.log('── Test 2: 触发补充（如果池未满） ──')
  console.log('  调用 replenishPool()...')
  console.log('  ⏳ 这会实际创建腾讯云资源，可能需要 1-2 分钟...')
  const t0 = Date.now()
  await replenishPool()
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  补充完成 (${elapsed}s)`)
  const stats2 = await getPoolStats()
  console.log('  stats:', JSON.stringify(stats2))
  console.log()

  // ─── Test 3: 认领 ────────────────────────────────────────────────
  if (stats2.ready > 0) {
    console.log('── Test 3: 从池中认领 ──')
    const t1 = Date.now()
    const result = await claimFromPool('test-user-001', 'testuser', 'test-task-001')
    const claimMs = Date.now() - t1
    if (result) {
      console.log(`  ✅ 认领成功 (${claimMs}ms)`)
      console.log(`     envId: ${result.envId}`)
      console.log(`     camUsername: ${result.camUsername}`)
      console.log(`     camSecretId: ${result.camSecretId?.slice(0, 10)}...`)
    } else {
      console.log('  ❌ 认领失败（池空）')
    }
    const stats3 = await getPoolStats()
    console.log('  stats:', JSON.stringify(stats3))
    console.log()

    // ─── Test 4: acquireEnv 统一接口测试 ─────────────────────────────
    console.log('── Test 4: acquireEnv 统一接口 ──')
    const t2 = Date.now()
    const result2 = await acquireEnv({
      userId: 'test-user-002',
      username: 'testuser2',
      taskId: 'test-task-002',
      mode: 'task',
    })
    const acquireMs = Date.now() - t2
    console.log(`  ✅ acquireEnv 完成 (${acquireMs}ms)`)
    console.log(`     envId: ${result2.envId}`)
    console.log(`     来源: ${acquireMs < 5000 ? '池认领（秒级）' : '实时创建（分钟级）'}`)
    const stats4 = await getPoolStats()
    console.log('  stats:', JSON.stringify(stats4))
    console.log()

    // ─── Test 5: releaseEnv ──────────────────────────────────────────
    if (result) {
      console.log('── Test 5: releaseEnv（销毁 test 3 认领的环境） ──')
      const t3 = Date.now()
      const releaseResult = await releaseEnv({
        envId: result.envId,
        camUsername: result.camUsername,
        policyId: result.policyId,
        cosTagValue: result.cosTagValue,
      })
      console.log(`  销毁完成 (${((Date.now() - t3) / 1000).toFixed(1)}s)`)
      console.log(`  steps:`, releaseResult.steps.map((s) => `${s.step}:${s.status}`).join(', '))
      if (releaseResult.failed.length > 0) {
        console.log(`  ⚠️ failed:`, releaseResult.failed)
      }
    }
  } else {
    console.log('── Test 3: 跳过（无 ready 环境可认领） ──')
    console.log('  提示：等池中环境创建完成后重新运行此脚本')
  }

  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log('  测试结束')
  console.log('═══════════════════════════════════════════════')
  process.exit(0)
}

main().catch((err) => {
  console.error('测试失败:', err)
  process.exit(1)
})
