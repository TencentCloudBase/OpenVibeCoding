#!/usr/bin/env node

/**
 * Deploy Script — 一键部署到 CloudBase 云托管
 *
 * Usage:
 *   pnpm deploy:cloud              # 部署到云托管
 *   pnpm deploy:cloud --skip-build # 跳过本地构建步骤（云端会重新构建）
 *
 * TODO: 云函数（镜像模式）部署暂未完成，存在以下问题：
 *   - CLI 无法正确传递 ImagePort 参数
 *   - 平台默认 ImagePort=9000，需要镜像内 ENV PORT=9000 匹配
 *   - 镜像冷启动时间过长（1.29GB），容易超过 InitTimeout
 *   待平台侧修复后可重新启用
 */

import { execSync } from 'child_process'
import { createRequire } from 'module'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const require = createRequire(import.meta.url)
const CloudBase = require('@cloudbase/manager-node')

// ===================== Constants =====================

const ROOT = process.cwd()
const ENV_FILE = resolve(ROOT, '.env.local')
const SERVER_ENV_FILE = resolve(ROOT, 'packages/server/.env')
const CLOUDBASERC = resolve(ROOT, 'cloudbaserc.json')
const DEFAULT_SERVICE_NAME = 'vibecoding-platform'

// ===================== Helpers =====================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
}

function log(message, type = 'info') {
  const prefix = {
    info: `${colors.cyan}→${colors.reset}`,
    success: `${colors.green}✓${colors.reset}`,
    error: `${colors.red}✗${colors.reset}`,
    warn: `${colors.yellow}!${colors.reset}`,
  }[type]
  console.log(`${prefix} ${message}`)
}

function logSection(title) {
  console.log('')
  console.log(`${colors.bright}${colors.cyan}━━━ ${title} ━━━${colors.reset}`)
}

function loadEnvFile(filePath) {
  const env = {}
  if (existsSync(filePath)) {
    readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...rest] = trimmed.split('=')
        if (key) env[key.trim()] = rest.join('=').trim()
      }
    })
  }
  return env
}

function commandExists(name) {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function run(cmd, options = {}) {
  console.log(`  ${colors.dim}$ ${cmd}${colors.reset}`)
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...options })
}

// ===================== CloudBase SDK Helper =====================

function createCloudBaseApp(env) {
  return new CloudBase({
    secretId: env.TCB_SECRET_ID,
    secretKey: env.TCB_SECRET_KEY,
    envId: env.TCB_ENV_ID,
  })
}

// ===================== CloudRun Deploy =====================

async function deployCloudRun(env) {
  logSection('部署到云托管（容器服务）')

  const envId = env.TCB_ENV_ID
  if (!envId) {
    log('缺少 TCB_ENV_ID，请先运行 ./init.sh', 'error')
    process.exit(1)
  }

  if (!commandExists('cloudbase')) {
    log('cloudbase CLI 未安装，请先安装：npm i -g @cloudbase/cli', 'error')
    process.exit(1)
  }

  // Ensure cloudbaserc.json has envId so CLI can read it
  const rcBackup = existsSync(CLOUDBASERC) ? readFileSync(CLOUDBASERC, 'utf-8') : null
  const rcContent = { envId }
  writeFileSync(CLOUDBASERC, JSON.stringify(rcContent, null, 2))

  try {
    // cloudbase cloudrun deploy uploads source + Dockerfile to cloud for building
    // No local Docker required — cloud builds the image from Dockerfile
    log('提交到云托管（云端构建）...')
    run(`cloudbase cloudrun deploy -s ${DEFAULT_SERVICE_NAME} --port 80 --force --source .`)
  } catch (err) {
    log('部署失败', 'error')
    log(`可在控制台手动部署：https://tcb.cloud.tencent.com/dev?envId=${envId}#/run`, 'info')
    process.exit(1)
  } finally {
    if (rcBackup) writeFileSync(CLOUDBASERC, rcBackup)
  }

  // Query service domain via CloudBase manager-node SDK
  let accessUrl = ''
  try {
    const app = createCloudBaseApp(env)
    const tcbr = app.commonService('tcbr')
    const result = await tcbr.call({
      Action: 'DescribeCloudRunServerDetail',
      Param: { EnvId: envId, ServerName: DEFAULT_SERVICE_NAME },
    })
    accessUrl = result.BaseInfo?.DefaultDomainName || ''
  } catch { /* ignore — URL is optional */ }

  // Done
  console.log('')
  log('部署已提交，云端构建中...', 'success')
  console.log('')
  console.log(`  ${colors.bright}服务：${colors.reset}${DEFAULT_SERVICE_NAME}`)
  if (accessUrl) {
    console.log(`  ${colors.bright}访问地址：${colors.reset}${accessUrl}`)
  }
  console.log(`  ${colors.bright}构建进度：${colors.reset}`)
  console.log(`  https://tcb.cloud.tencent.com/dev?envId=${envId}#/platform-run/service/detail?serverName=${DEFAULT_SERVICE_NAME}&tabId=deploy&envId=${envId}`)
  console.log('')
}

// ===================== Main =====================

async function main() {
  console.log('')
  console.log(`${colors.bright}${colors.cyan}━━━ 部署到 CloudBase 云托管 ━━━${colors.reset}`)
  console.log('')

  const args = process.argv.slice(2)

  // Load env
  const env = { ...loadEnvFile(ENV_FILE), ...loadEnvFile(SERVER_ENV_FILE) }

  if (!env.TCB_ENV_ID) {
    log('未找到 TCB_ENV_ID，请先运行 ./init.sh 完成初始化', 'error')
    process.exit(1)
  }

  if (!env.TCB_SECRET_ID || !env.TCB_SECRET_KEY) {
    log('未找到 TCB_SECRET_ID / TCB_SECRET_KEY，请先运行 ./init.sh 完成初始化', 'error')
    process.exit(1)
  }

  await deployCloudRun(env)
}

main().catch((err) => {
  console.error('')
  log(`部署失败：${err.message}`, 'error')
  process.exit(1)
})
