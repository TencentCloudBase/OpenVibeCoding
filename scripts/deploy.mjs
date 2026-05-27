#!/usr/bin/env node

/**
 * Deploy to CloudBase CloudRun (container).
 *
 * Env layout (repo root):
 *   .env.local  — local dev only (pnpm dev)
 *   .env.cloud  — cloud: CLI credentials + runtime vars synced after deploy
 *   .env.example — documentation only
 *
 * Usage:
 *   pnpm deploy:cloud
 *   pnpm deploy:cloud --skip-env-sync   # deploy only, do not call UpdateCloudRunServer
 */

import { execSync } from 'child_process'
import { createRequire } from 'module'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import {
  ENV_CLOUD,
  loadEnvFile,
  cloudRuntimeEnvFromFile,
  isAskUserBaseUrlUnset,
  normalizeAskUserBaseUrl,
  saveEnvVar,
} from './lib/env-files.mjs'

const require = createRequire(import.meta.url)
const CloudBase = require('@cloudbase/manager-node')

const ROOT = process.cwd()
const CLOUDBASERC = resolve(ROOT, 'cloudbaserc.json')
const DEFAULT_SERVICE_NAME = 'vibecoding-platform'

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

function createCloudBaseApp(env) {
  return new CloudBase({
    secretId: env.TCB_SECRET_ID,
    secretKey: env.TCB_SECRET_KEY,
    envId: env.TCB_ENV_ID,
  })
}

async function syncCloudRunEnv(app, envId, serverName, runtimeEnv) {
  const keys = Object.keys(runtimeEnv)
  if (keys.length === 0) {
    log('.env.cloud 无有效变量，跳过云托管环境变量同步', 'warn')
    return false
  }

  logSection('同步云托管环境变量')
  log(`从 .env.cloud 写入 ${keys.length} 个变量到服务 ${serverName}`, 'info')

  const tcbr = app.commonService('tcbr')
  await tcbr.call({
    Action: 'UpdateCloudRunServer',
    Param: {
      EnvId: envId,
      ServerName: serverName,
      Items: [
        {
          Key: 'EnvParams',
          Value: JSON.stringify(runtimeEnv),
        },
      ],
    },
  })
  log('云托管环境变量已更新（新实例生效）', 'success')
  return true
}

async function deployCloudRun(deployEnv, options) {
  logSection('部署到云托管（容器服务）')

  const envId = deployEnv.TCB_ENV_ID
  if (!envId) {
    log('缺少 TCB_ENV_ID，请先运行 ./init.sh', 'error')
    process.exit(1)
  }

  if (!commandExists('cloudbase')) {
    log('cloudbase CLI 未安装：npm i -g @cloudbase/cli', 'error')
    process.exit(1)
  }

  const rcBackup = existsSync(CLOUDBASERC) ? readFileSync(CLOUDBASERC, 'utf-8') : null
  writeFileSync(CLOUDBASERC, JSON.stringify({ envId }, null, 2))

  try {
    log('提交到云托管（云端构建）...')
    run(`cloudbase cloudrun deploy -s ${DEFAULT_SERVICE_NAME} --port 80 --force --source .`)
  } catch {
    log('部署失败', 'error')
    log(`控制台：https://tcb.cloud.tencent.com/dev?envId=${envId}#/run`, 'info')
    process.exit(1)
  } finally {
    if (rcBackup) writeFileSync(CLOUDBASERC, rcBackup)
  }

  let accessUrl = ''
  const app = createCloudBaseApp(deployEnv)
  try {
    const tcbr = app.commonService('tcbr')
    const result = await tcbr.call({
      Action: 'DescribeCloudRunServerDetail',
      Param: { EnvId: envId, ServerName: DEFAULT_SERVICE_NAME },
    })
    accessUrl = result.BaseInfo?.DefaultDomainName || ''
  } catch {
    /* optional */
  }

  if (!options.skipEnvSync) {
    if (!existsSync(ENV_CLOUD)) {
      log('未找到 .env.cloud，请运行 ./init.sh 生成或手动创建', 'warn')
    } else {
      const runtimeEnv = cloudRuntimeEnvFromFile(ENV_CLOUD)
      if (accessUrl && isAskUserBaseUrlUnset(runtimeEnv.ASK_USER_BASE_URL)) {
        const normalized = normalizeAskUserBaseUrl(accessUrl)
        runtimeEnv.ASK_USER_BASE_URL = normalized
        saveEnvVar(ENV_CLOUD, 'ASK_USER_BASE_URL', normalized)
        log('已从云托管默认域名写回 .env.cloud 的 ASK_USER_BASE_URL', 'success')
      }
      try {
        await syncCloudRunEnv(app, envId, DEFAULT_SERVICE_NAME, runtimeEnv)
      } catch (err) {
        log('环境变量 API 同步失败，请在控制台 → 云托管 → 服务配置 粘贴 .env.cloud', 'warn')
        console.error(err)
      }
    }
  }

  console.log('')
  log('部署已提交，云端构建中...', 'success')
  console.log('')
  console.log(`  ${colors.bright}服务：${colors.reset}${DEFAULT_SERVICE_NAME}`)
  if (accessUrl) {
    console.log(`  ${colors.bright}访问地址：${colors.reset}${accessUrl}`)
  } else if (existsSync(ENV_CLOUD) && isAskUserBaseUrlUnset(loadEnvFile(ENV_CLOUD).ASK_USER_BASE_URL)) {
    console.log(
      `  ${colors.yellow}ASK_USER_BASE_URL 仍为占位：部署完成后到控制台复制默认域名写入 .env.cloud 再执行 deploy:cloud${colors.reset}`,
    )
  }
  console.log(`  ${colors.bright}构建进度：${colors.reset}`)
  console.log(
    `  https://tcb.cloud.tencent.com/dev?envId=${envId}#/platform-run/service/detail?serverName=${DEFAULT_SERVICE_NAME}&tabId=deploy&envId=${envId}`,
  )
  console.log('')
}

async function main() {
  console.log('')
  console.log(`${colors.bright}${colors.cyan}━━━ 部署到 CloudBase 云托管 ━━━${colors.reset}`)
  console.log('')

  const args = process.argv.slice(2)
  const skipEnvSync = args.includes('--skip-env-sync')

  const deployEnv = loadEnvFile(ENV_CLOUD)
  if (!existsSync(ENV_CLOUD)) {
    log('未找到 .env.cloud，请运行 ./init.sh 并选择 2) .env.cloud', 'error')
    process.exit(1)
  }
  if (!deployEnv.TCB_ENV_ID) {
    log('.env.cloud 缺少 TCB_ENV_ID', 'error')
    process.exit(1)
  }
  if (!deployEnv.TCB_SECRET_ID || !deployEnv.TCB_SECRET_KEY) {
    log('.env.cloud 缺少 TCB_SECRET_ID / TCB_SECRET_KEY', 'error')
    process.exit(1)
  }

  await deployCloudRun(deployEnv, { skipEnvSync })
}

main().catch((err) => {
  console.error('')
  log(`部署失败：${err.message}`, 'error')
  process.exit(1)
})
