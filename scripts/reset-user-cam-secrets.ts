#!/usr/bin/env npx tsx
/**
 * Reset user-level CAM credentials for a given username.
 *
 * 场景：某用户 user-level user_resources 里存了一对老 / 失效的永久密钥 (camSecretId/Key)，
 * 导致 requireUserEnv 走 'permanent' 分支调腾讯云时直接 "SecretId is not found"。
 * 清空这对字段后 middleware 会改走 issueTempCredentials 用支撑账号现签临时凭证。
 *
 * Usage:
 *   pnpm tsx scripts/reset-user-cam-secrets.ts <username> [--dry-run]
 *
 * 例：pnpm tsx scripts/reset-user-cam-secrets.ts yanghang
 */

import { config as loadEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Load repo root .env.local (DB_PROVIDER / TCB_*)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../.env.local') })

import { getDb } from '../packages/server/src/db/index.js'

async function main() {
  const username = process.argv[2]
  const dryRun = process.argv.includes('--dry-run')

  if (!username) {
    console.error('用法: pnpm tsx scripts/reset-user-cam-secrets.ts <username> [--dry-run]')
    process.exit(1)
  }

  const db = getDb()
  // UserRepository 没暴露 findByUsername，用 findAll 扫描后按 username 过滤
  const allUsers = await db.users.findAll(1000, 0)
  const user = allUsers.find((u) => u.username === username)
  if (!user) {
    console.error(`未找到用户: ${username}`)
    process.exit(2)
  }
  console.log(`找到用户: id=${user.id} username=${user.username}`)

  const resources = await db.userResources.findAllByUserId(user.id)
  if (resources.length === 0) {
    console.log('该用户没有 user_resources 记录')
    return
  }

  console.log(`该用户共 ${resources.length} 条 resource：`)
  for (const r of resources) {
    console.log(
      `  - id=${r.id} scope=${r.scope || '(user)'} envId=${r.envId} status=${r.status} ` +
        `taskId=${r.taskId || '-'} camSecretId=${r.camSecretId ? r.camSecretId.slice(0, 8) + '...' : '(null)'}`,
    )
  }

  // 只处理 user-level（scope='user' 或没 scope）且有 camSecretId 的条目
  const targets = resources.filter((r) => (!r.scope || r.scope === 'user') && r.camSecretId)
  if (targets.length === 0) {
    console.log('没有需要清空的 user-level 永久密钥条目')
    return
  }

  console.log(`\n将清空以下 ${targets.length} 条 user-level resource 的 camSecretId / camSecretKey：`)
  for (const r of targets) {
    console.log(`  - id=${r.id} envId=${r.envId}`)
  }

  if (dryRun) {
    console.log('\n[dry-run] 未执行任何变更')
    return
  }

  for (const r of targets) {
    await db.userResources.update(r.id, { camSecretId: null, camSecretKey: null })
    console.log(`✓ 已清空 id=${r.id}`)
  }
  console.log('\n完成。下次请求 middleware 会改走临时凭证签发（issueTempCredentials）')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
