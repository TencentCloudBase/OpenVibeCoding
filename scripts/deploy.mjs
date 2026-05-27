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
 *   pnpm deploy:cloud --no-wait         # submit source only, do not poll until service is ready
 */

import { execSync, spawn } from 'child_process'
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
const TCBR_API_VERSION = '2022-02-17'

const POLL_INTERVAL_MS = 10_000
const POLL_TIMEOUT_MS = 45 * 60 * 1000
const UPLOAD_HEARTBEAT_MS = 15_000

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function commandExists(name) {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function deployConsoleUrl(envId, serverName = DEFAULT_SERVICE_NAME) {
  return `https://tcb.cloud.tencent.com/dev?envId=${envId}#/platform-run/service/detail?serverName=${serverName}&tabId=deploy&envId=${envId}`
}

function printConsoleLink(envId, serverName = DEFAULT_SERVICE_NAME) {
  const url = deployConsoleUrl(envId, serverName)
  console.log('')
  log('云托管控制台（构建/部署记录）', 'info')
  console.log(`  ${colors.bright}${url}${colors.reset}`)
  console.log('')
}

function createCloudBaseApp(env) {
  return new CloudBase({
    secretId: env.TCB_SECRET_ID,
    secretKey: env.TCB_SECRET_KEY,
    envId: env.TCB_ENV_ID,
  })
}

function pickAccessUrl(detail) {
  const base = detail?.BaseInfo
  if (!base) return ''
  return (
    base.DefaultDomainName ||
    base.CustomDomainName ||
    (Array.isArray(base.CustomDomainNames) ? base.CustomDomainNames[0] : '') ||
    ''
  )
}

/** @returns {string} normalized URL if written */
function maybeWritebackAskUserBaseUrl(accessUrl) {
  if (!accessUrl || !existsSync(ENV_CLOUD)) return ''
  const current = loadEnvFile(ENV_CLOUD).ASK_USER_BASE_URL
  if (!isAskUserBaseUrlUnset(current)) return ''
  const normalized = normalizeAskUserBaseUrl(accessUrl)
  saveEnvVar(ENV_CLOUD, 'ASK_USER_BASE_URL', normalized)
  log(`已写回 .env.cloud 的 ASK_USER_BASE_URL`, 'success')
  console.log(`  ${colors.dim}${normalized}${colors.reset}`)
  return normalized
}

function isDeploySettledStatus(status) {
  const s = String(status || '').toLowerCase()
  return s === 'running' || s === 'normal' || s === 'active'
}

function isDeployFailedStatus(status) {
  const s = String(status || '').toLowerCase()
  return s.includes('fail') || s === 'error' || s === 'abnormal'
}

function isDeployInProgressStatus(status) {
  const s = String(status || '').toLowerCase()
  if (!s) return true
  if (isDeploySettledStatus(s) || isDeployFailedStatus(s)) return false
  return true
}

/**
 * Submit source via cloudbase CLI (streams output; auto-answers known prompts).
 */
function runCloudRunDeploy(serviceName) {
  return new Promise((resolve, reject) => {
    const args = ['cloudrun', 'deploy', '-s', serviceName, '--port', '80', '--force', '--source', '.']
    console.log(`  ${colors.dim}$ cloudbase ${args.join(' ')}${colors.reset}`)

    const child = spawn('cloudbase', args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
    let answeredGray = false
    let answeredConcurrent = false

    const onChunk = (chunk) => {
      const text = chunk.toString()
      process.stdout.write(text)
      if (text.includes('Enable gray deployment') && !answeredGray) {
        answeredGray = true
        child.stdin.write('\n')
      }
      if (text.includes('deployment tasks running') && !answeredConcurrent) {
        answeredConcurrent = true
        child.stdin.write('Y\n')
      }
    }

    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)

    const heartbeat = setInterval(() => {
      log('仍在上传/提交源码（CLI 无进度条，属正常）…', 'info')
    }, UPLOAD_HEARTBEAT_MS)

    const grayFallback = setTimeout(() => {
      if (!answeredGray) {
        answeredGray = true
        child.stdin.write('\n')
      }
    }, 4000)

    child.on('error', (err) => {
      clearInterval(heartbeat)
      clearTimeout(grayFallback)
      reject(err)
    })

    child.on('close', (code) => {
      clearInterval(heartbeat)
      clearTimeout(grayFallback)
      if (code === 0) resolve()
      else reject(new Error(`cloudbase deploy exited with code ${code}`))
    })
  })
}

async function fetchServerDetail(app, serverName) {
  return app.cloudrun.detail({ serverName })
}

function isDeployRecordFailed(status) {
  const s = String(status || '').toLowerCase()
  return s.includes('fail') || s === 'error'
}

function isDeployRecordSuccess(status) {
  const s = String(status || '').toLowerCase()
  return s === 'running' || s === 'success' || s === 'succeeded' || s === 'done' || s === 'normal'
}

async function fetchLatestDeployRecord(app, serverName) {
  try {
    const res = await app.cloudrun.getDeployRecords({ serverName })
    return res.DeployRecords?.[0] ?? null
  } catch {
    return null
  }
}

async function pollDeployUntilSettled(app, serverName, envId, baseline) {
  logSection('轮询云托管状态')
  log(`每 ${POLL_INTERVAL_MS / 1000}s 查询一次，最长 ${Math.round(POLL_TIMEOUT_MS / 60000)} 分钟`, 'info')
  log('提示：Docker 构建阶段控制台有明细，服务 API 状态可能长时间保持 normal', 'info')
  printConsoleLink(envId, serverName)

  const preUpdateTime = baseline?.updateTime || ''
  const preStatus = baseline?.status || ''
  const started = Date.now()
  let lastStatus = ''
  let lastUpdateTime = ''
  let lastRecordStatus = ''
  let sawInProgress = false
  let warnedStuckNormal = false

  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const latestRecord = await fetchLatestDeployRecord(app, serverName)
    if (latestRecord?.Status && latestRecord.Status !== lastRecordStatus) {
      lastRecordStatus = latestRecord.Status
      log(
        `部署记录：${latestRecord.Status}${latestRecord.DeployTime ? `（${latestRecord.DeployTime}）` : ''}`,
        'info',
      )
      if (isDeployRecordFailed(latestRecord.Status)) {
        return { ok: false, detail: null, accessUrl: '' }
      }
      if (isDeployRecordSuccess(latestRecord.Status)) {
        const detail = await fetchServerDetail(app, serverName).catch(() => null)
        const accessUrl = detail ? pickAccessUrl(detail) : ''
        if (accessUrl) maybeWritebackAskUserBaseUrl(accessUrl)
        return { ok: true, detail, accessUrl }
      }
    }

    let detail
    try {
      detail = await fetchServerDetail(app, serverName)
    } catch (err) {
      log(`查询服务状态失败：${err.message}`, 'warn')
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    const base = detail.BaseInfo || {}
    const { Status, UpdateTime } = base
    const accessUrl = pickAccessUrl(detail)

    if (Status !== lastStatus || UpdateTime !== lastUpdateTime) {
      const extra = accessUrl ? ` · ${accessUrl}` : ''
      log(`服务状态：${Status || 'unknown'}${UpdateTime ? `（${UpdateTime}）` : ''}${extra}`, 'info')
      lastStatus = Status
      lastUpdateTime = UpdateTime
    }

    if (accessUrl) {
      maybeWritebackAskUserBaseUrl(accessUrl)
    }

    if (isDeployInProgressStatus(Status) && Status !== preStatus) {
      sawInProgress = true
    }

    if (isDeployFailedStatus(Status)) {
      return { ok: false, detail, accessUrl }
    }

    if (isDeploySettledStatus(Status)) {
      const updateChanged = Boolean(UpdateTime && UpdateTime !== preUpdateTime)
      const noBaseline = !preUpdateTime && !preStatus
      if (noBaseline || sawInProgress || updateChanged) {
        return { ok: true, detail, accessUrl }
      }
      if (!warnedStuckNormal && Date.now() - started > 90_000) {
        warnedStuckNormal = true
        log('服务状态未变化：构建可能仍在进行，请以控制台构建记录为准', 'warn')
      }
    }

    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error('轮询超时：请到控制台查看构建是否仍在进行')
}

async function syncCloudRunEnv(app, envId, serverName, runtimeEnv) {
  const keys = Object.keys(runtimeEnv)
  if (keys.length === 0) {
    log('.env.cloud 无有效变量，跳过云托管环境变量同步', 'warn')
    return false
  }

  logSection('同步云托管环境变量')
  log(`从 .env.cloud 写入 ${keys.length} 个变量到服务 ${serverName}`, 'info')

  const tcbr = app.commonService('tcbr', TCBR_API_VERSION)
  await tcbr.call({
    Action: 'UpdateCloudRunServer',
    Param: {
      EnvId: envId,
      ServerName: serverName,
      DeployInfo: { ReleaseType: 'FULL', DeployType: 'config' },
      Items: [{ Key: 'EnvParam', Value: JSON.stringify(runtimeEnv) }],
    },
  })
  log('云托管环境变量已更新（新实例生效）', 'success')
  return true
}

async function deployCloudRun(deployEnv, options) {
  const envId = deployEnv.TCB_ENV_ID
  if (!envId) {
    log('缺少 TCB_ENV_ID，请先运行 ./init.sh', 'error')
    process.exit(1)
  }

  if (!commandExists('cloudbase')) {
    log('cloudbase CLI 未安装：npm i -g @cloudbase/cli', 'error')
    process.exit(1)
  }

  logSection('部署到云托管（容器服务）')
  printConsoleLink(envId, DEFAULT_SERVICE_NAME)

  const app = createCloudBaseApp(deployEnv)
  let preDetail
  let deployBaseline = { status: '', updateTime: '' }
  try {
    preDetail = await fetchServerDetail(app, DEFAULT_SERVICE_NAME)
    deployBaseline = {
      status: preDetail.BaseInfo?.Status || '',
      updateTime: preDetail.BaseInfo?.UpdateTime || '',
    }
    const preUrl = pickAccessUrl(preDetail)
    if (preUrl) {
      log(`当前默认域名：${preUrl}`, 'info')
      maybeWritebackAskUserBaseUrl(preUrl)
    }
  } catch {
    /* service may not exist yet */
  }

  const rcBackup = existsSync(CLOUDBASERC) ? readFileSync(CLOUDBASERC, 'utf-8') : null
  writeFileSync(CLOUDBASERC, JSON.stringify({ envId }, null, 2))

  try {
    log('提交源码到云托管（云端 Docker 构建）…', 'info')
    await runCloudRunDeploy(DEFAULT_SERVICE_NAME)
    log('源码已提交，云端开始构建', 'success')
  } catch (err) {
    log('部署提交失败', 'error')
    console.error(err.message || err)
    printConsoleLink(envId, DEFAULT_SERVICE_NAME)
    process.exit(1)
  } finally {
    if (rcBackup) writeFileSync(CLOUDBASERC, rcBackup)
  }

  let accessUrl = pickAccessUrl(preDetail)
  let pollOk = true

  if (!options.noWait) {
    try {
      const poll = await pollDeployUntilSettled(app, DEFAULT_SERVICE_NAME, envId, deployBaseline)
      pollOk = poll.ok
      accessUrl = poll.accessUrl || accessUrl
      if (!poll.ok) {
        log('云端报告部署失败，请打开控制台查看构建日志', 'error')
      }
    } catch (err) {
      log(err.message, 'warn')
    }
  } else {
    log('已跳过状态轮询（--no-wait）', 'info')
    try {
      const detail = await fetchServerDetail(app, DEFAULT_SERVICE_NAME)
      accessUrl = pickAccessUrl(detail) || accessUrl
    } catch {
      /* optional */
    }
  }

  if (accessUrl) {
    maybeWritebackAskUserBaseUrl(accessUrl)
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
      }
      try {
        await syncCloudRunEnv(app, envId, DEFAULT_SERVICE_NAME, runtimeEnv)
      } catch (err) {
        log('环境变量 API 同步失败，请在控制台 → 云托管 → 服务配置 粘贴 .env.cloud', 'warn')
        console.error(err.message || err)
      }
    }
  }

  console.log('')
  if (pollOk && !options.noWait) {
    log('部署流程结束（服务状态已就绪或已为 normal/running）', 'success')
  } else if (options.noWait) {
    log('部署已提交，请在控制台查看构建进度', 'success')
  } else {
    log('部署已提交，但服务未确认成功，请检查控制台', 'warn')
  }
  console.log('')
  console.log(`  ${colors.bright}服务：${colors.reset}${DEFAULT_SERVICE_NAME}`)
  console.log(`  ${colors.bright}容器端口：${colors.reset}80（云托管对外；沙箱 TRW 用 9000，勿改服务端口）`)
  if (accessUrl) {
    console.log(`  ${colors.bright}访问地址：${colors.reset}${accessUrl}`)
  } else if (existsSync(ENV_CLOUD) && isAskUserBaseUrlUnset(loadEnvFile(ENV_CLOUD).ASK_USER_BASE_URL)) {
    console.log(
      `  ${colors.yellow}ASK_USER_BASE_URL 仍为占位：从控制台复制 *.sh.run.tcloudbase.com 域名后写入 .env.cloud 再部署${colors.reset}`,
    )
  }
  printConsoleLink(envId, DEFAULT_SERVICE_NAME)
}

async function main() {
  console.log('')
  console.log(`${colors.bright}${colors.cyan}━━━ 部署到 CloudBase 云托管 ━━━${colors.reset}`)
  console.log('')

  const args = process.argv.slice(2)
  const skipEnvSync = args.includes('--skip-env-sync')
  const noWait = args.includes('--no-wait')

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

  await deployCloudRun(deployEnv, { skipEnvSync, noWait })
}

main().catch((err) => {
  console.error('')
  log(`部署失败：${err.message}`, 'error')
  process.exit(1)
})
