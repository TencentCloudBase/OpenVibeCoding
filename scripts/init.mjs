#!/usr/bin/env node

/**
 * Project Initialization Script
 *
 * This script handles the complete project setup:
 * 1. Check Node.js version (>= 18)
 * 2. Check/install pnpm
 * 3. Setup TCR (container registry)
 * 4. Install dependencies
 * 5. Ready to start development
 */

import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import crypto from 'crypto'
import {
  ENV_LOCAL,
  ENV_CLOUD,
  ASK_USER_BASE_URL_PLACEHOLDER,
  loadEnvFile,
  saveEnvVar,
} from './lib/env-files.mjs'
import { closeReadline, promptInput } from './lib/prompt.mjs'

// ===================== Constants =====================

const MIN_NODE_VERSION = 18
const CLOUDBASE_AUTH_FILE = resolve(homedir(), '.config/.cloudbase/auth.json')

const IS_WINDOWS = process.platform === 'win32'

// ===================== Helper Functions =====================

/**
 * 跨平台检测命令是否存在 (which / where)
 */
function commandExists(name) {
  try {
    execSync(`${IS_WINDOWS ? 'where' : 'which'} ${name}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

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
    step: `${colors.bright}▶${colors.reset}`,
  }[type]
  console.log(`${prefix} ${message}`)
}

function logSection(title) {
  console.log('')
  console.log(`${colors.bright}${colors.cyan}━━━ ${title} ━━━${colors.reset}`)
}

function runCommand(cmd, silent = false) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: silent ? 'pipe' : 'inherit',
    })
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message || ''
    throw new Error(`Command failed: ${cmd}${detail ? '\n  ' + detail : ''}`)
  }
}

function runCommandSafe(cmd) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return { success: true, output }
  } catch (error) {
    return { success: false, output: error.stdout || error.stderr || '' }
  }
}

async function askYesNo(prompt, defaultValue = false) {
  const hint = defaultValue ? '[Y/n]' : '[y/N]'
  const answer = await promptInput(`${prompt} ${hint}`)
  if (!answer) return defaultValue
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
}

// ===================== Environment Checks =====================

function checkNodeVersion() {
  logSection('检查 Node.js')

  const nodeVersion = process.version.replace('v', '')
  const majorVersion = parseInt(nodeVersion.split('.')[0], 10)

  log(`Node.js 版本：${process.version}`)

  if (majorVersion < MIN_NODE_VERSION) {
    log(`需要 Node.js ${MIN_NODE_VERSION}+，当前版本为 ${majorVersion}`, 'error')
    log('请升级 Node.js：https://nodejs.org/', 'info')
    return false
  }

  log(`Node.js ${majorVersion} 满足要求（>= ${MIN_NODE_VERSION}）`, 'success')
  return true
}

async function checkPnpm() {
  logSection('检查 pnpm')

  const result = runCommandSafe('pnpm --version')

  if (result.success) {
    log(`pnpm ${result.output.trim()} 已安装`, 'success')
    return true
  }

  // pnpm --version 失败 — 细分错误类型
  const errorOutput = result.output || ''

  const isSignatureError =
    errorOutput.includes('keyid') ||
    errorOutput.includes('signature') ||
    errorOutput.includes('Cannot find matching keyid') ||
    errorOutput.includes('verifySignature')

  // Windows 上 corepack shim 路径解析错误（/d/ 被误解析到 C 盘）
  const isCorpackPathError =
    errorOutput.includes('MODULE_NOT_FOUND') ||
    errorOutput.includes('Cannot find module') ||
    errorOutput.includes('corepack')

  if (isSignatureError) {
    log('pnpm 存在但 corepack 签名验证失败', 'warn')
    log('正在尝试修复 corepack 缓存...')
    try {
      runCommand('corepack disable && corepack enable')
      const verify = runCommandSafe('pnpm --version')
      if (verify.success) {
        log(`pnpm ${verify.output.trim()} 已恢复`, 'success')
        return true
      }
    } catch {
      // corepack disable/enable 失败，继续走安装流程
    }
    log('自动修复失败，将尝试重新安装 pnpm', 'warn')
  } else if (isCorpackPathError && IS_WINDOWS) {
    // Windows 上 corepack shim 路径错误（Node.js 安装在非 C 盘时常见）
    log('检测到 corepack 路径解析错误（Node.js 可能安装在非 C 盘）', 'warn')
    log('正在禁用 corepack 并通过 npm 重新安装 pnpm...')
    try {
      runCommand('corepack disable pnpm')
    } catch {
      // corepack disable 失败不影响后续
    }
    try {
      runCommand('npm install -g pnpm')
      const verify = runCommandSafe('pnpm --version')
      if (verify.success) {
        log(`pnpm ${verify.output.trim()} 安装成功`, 'success')
        return true
      }
    } catch (e) {
      log('通过 npm 安装 pnpm 失败', 'warn')
    }
    log('自动修复失败，请手动运行：npm install -g pnpm', 'error')
    return false
  } else {
    log('pnpm 未安装', 'warn')
  }

  const install = await askYesNo('是否立即安装 pnpm？', true)
  if (!install) {
    log('本项目需要 pnpm', 'error')
    return false
  }

  log('正在通过 npm 安装 pnpm...')
  try {
    // Windows 优先用 npm 直接安装，避免 corepack 路径问题
    if (IS_WINDOWS) {
      runCommand('npm install -g pnpm')
    } else {
      runCommand('corepack enable && corepack prepare pnpm@latest --activate')
    }
    log('pnpm 安装成功', 'success')
    return true
  } catch (error) {
    log('安装失败，尝试备用方式...', 'warn')
    try {
      runCommand('npm install -g pnpm')
      log('pnpm 安装成功', 'success')
      return true
    } catch (error2) {
      log('pnpm 安装失败', 'error')
      return false
    }
  }
}

function checkDocker() {
  logSection('检查 Docker / Podman')

  // Try docker first
  try {
    execSync('docker info', { stdio: 'pipe' })
    log('Docker 守护进程正在运行', 'success')
    return true
  } catch {
    // docker not available, try podman
  }

  // Fallback to podman — if machine is stopped/disconnected, attempt to start it
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execSync('podman info', { stdio: 'pipe' })
      log('Podman 正在运行（将作为 Docker 兜底使用）', 'success')
      try {
        const podmanSocket = execSync('podman machine inspect --format "{{.ConnectionInfo.PodmanSocket.Path}}"', { stdio: 'pipe' }).toString().trim()
        if (podmanSocket) {
          process.env.DOCKER_HOST = `unix://${podmanSocket}`
        }
      } catch {
        // native Linux podman, no machine needed
      }
      return true
    } catch {
      if (attempt === 0) {
        // podman info failed — machine may be stopped or SSH disconnected
        log('Podman 已安装但未响应，尝试自动启动...', 'info')
        try {
          execSync('podman machine start', { stdio: 'pipe' })
        } catch {
          // may already be "running" but SSH broken — stop and restart
          try {
            execSync('podman machine stop', { stdio: 'pipe' })
            execSync('podman machine start', { stdio: 'pipe' })
          } catch {
            break
          }
        }
      }
    }
  }

  log('Docker / Podman 未安装或未运行', 'error')
  log('请安装以下任一工具后重新运行 ./init.sh：', 'info')
  log('  # Docker Desktop（推荐）', 'info')
  log('  https://www.docker.com/products/docker-desktop', 'info')
  log('  # 或 Colima + Docker CLI', 'info')
  log('  brew install colima docker && colima start', 'info')
  log('  # 或 Podman（Apple Silicon 原生，无需 Rosetta）', 'info')
  log('  brew install podman && podman machine init && podman machine start', 'info')
  return false
}

/** Set in main() before CloudBase setup: ENV_LOCAL or ENV_CLOUD */
let envWriteTarget = ENV_LOCAL

function saveTargetEnvVar(key, value) {
  saveEnvVar(envWriteTarget, key, value)
}

async function promptEnvGenerationTarget() {
  logSection('选择环境配置文件')
  console.log('')
  console.log('  每次 init 只生成一个文件；本地与云端请各运行一次。')
  console.log('')
  console.log('  1) .env.local — 本地开发 (pnpm dev)')
  console.log('  2) .env.cloud — 云托管运行时 (pnpm deploy:cloud)')
  console.log('')

  while (true) {
    const answer = await promptInput('请选择 1 或 2')
    if (answer === '1') {
      envWriteTarget = ENV_LOCAL
      log('将生成 .env.local', 'success')
      return ENV_LOCAL
    }
    if (answer === '2') {
      envWriteTarget = ENV_CLOUD
      log('将生成 .env.cloud', 'success')
      return ENV_CLOUD
    }
    log('请输入 1 或 2', 'warn')
  }
}

function getCloudbaseCredential() {
  if (!existsSync(CLOUDBASE_AUTH_FILE)) {
    return null
  }

  try {
    const content = readFileSync(CLOUDBASE_AUTH_FILE, 'utf-8')
    const auth = JSON.parse(content)

    if (!auth.credential?.tmpSecretId || !auth.credential?.tmpSecretKey) {
      return null
    }

    const now = Date.now()
    if (auth.credential.tmpExpired && now > auth.credential.tmpExpired) {
      return null
    }

    return {
      uin: auth.credential.uin,
      tmpSecretId: auth.credential.tmpSecretId,
      tmpSecretKey: auth.credential.tmpSecretKey,
      tmpToken: auth.credential.tmpToken,
    }
  } catch (err) {
    console.warn(`[init] Failed to parse cloudbase auth.json: ${err.message || err}`)
    return null
  }
}

// ===================== Cloudbase CLI Helpers =====================

function isCloudbaseInstalled() {
  return commandExists('cloudbase')
}

async function ensureCloudbaseInstalled() {
  if (isCloudbaseInstalled()) return true
  log('未检测到 cloudbase CLI，正在自动安装...', 'warn')
  try {
    execSync('npm install -g @cloudbase/cli', { stdio: 'inherit' })
    log('cloudbase CLI 安装成功', 'success')
    return true
  } catch {
    log('cloudbase CLI 安装失败，请手动运行：npm install -g @cloudbase/cli', 'error')
    return false
  }
}

async function runCloudbaseLogin() {
  log('正在执行 cloudbase 登录...')
  log('请在浏览器中完成登录...', 'info')

  return new Promise((resolve) => {
    const child = spawn('cloudbase', ['login'], {
      stdio: 'inherit',
      shell: true,
    })

    child.on('close', (code) => {
      resolve(code === 0)
    })

    child.on('error', (err) => {
      console.error(`[init] cloudbase login process error: ${err.message || err}`)
      resolve(false)
    })
  })
}

// In-memory store for TCB credentials (flushed in setupApplicationEnv to envWriteTarget)
const tcbConfig = {
  secretId: '',
  secretKey: '',
  token: '',
  envId: '',
  provisionMode: 'shared',
}

// In-memory store for TCR type selection
const tcrConfig = {
  type: 'personal',     // 'personal' | 'enterprise'
  registryId: '',       // enterprise only
}

// In-memory store for CodeBuddy auth config
const codebuddyConfig = {
  authMode: '',   // 'apikey' or 'oauth'
  apiKey: '',
  internetEnv: '',
  clientId: '',
  clientSecret: '',
  oauthEndpoint: 'https://copilot.tencent.com/oauth2/token',
}

async function setupCloudbaseConfig() {
  logSection('CloudBase 配置')

  // 确保 cloudbase CLI 已安装
  const cliReady = await ensureCloudbaseInstalled()
  if (!cliReady) return false

  const serverEnv = loadEnvFile(envWriteTarget)

  // ── 永久密钥询问 ──────────────────────────────────────────────
  const savedId = serverEnv['TCB_SECRET_ID'] || ''
  const savedKey = serverEnv['TCB_SECRET_KEY'] || ''
  const savedToken = serverEnv['TCB_TOKEN'] || ''
  const hasPermanentKey = savedId && savedKey && !savedToken
  let usePermanentKey = false

  if (hasPermanentKey) {
    console.log('')
    console.log(`  当前密钥：${savedId.slice(0, 10)}...`)
    console.log('')
    console.log('  1) 继续使用当前密钥')
    console.log('  2) 输入新的永久密钥')
    console.log('')

    const choice = await promptInput('请选择（1 或 2，回车默认选 1）')
    if (!choice || choice === '1') {
      tcbConfig.secretId = savedId
      tcbConfig.secretKey = savedKey
      usePermanentKey = true
      log('使用已有密钥', 'success')
      // 使用已有密钥重新登录 cloudbase CLI，确保后续命令可用
      log('正在使用已有密钥登录 cloudbase CLI...')
      try {
        execSync(`cloudbase login --apiKeyId "${savedId}" --apiKey "${savedKey}"`, {
          stdio: 'pipe',
          encoding: 'utf-8',
        })
        log('cloudbase CLI 登录成功', 'success')
      } catch (e) {
        log(`cloudbase CLI 登录失败: ${e.stderr?.trim() || e.message || e}，将继续尝试获取环境列表`, 'warn')
      }
    }
    // choice === '2' 或其他：继续进入密钥输入
  }

  if (!usePermanentKey) {
    console.log('')
    console.log('  请输入腾讯云永久密钥（SecretId / SecretKey）。')
    console.log('  获取方式：腾讯云控制台 → 访问管理 → API 密钥管理')
    console.log('  https://console.cloud.tencent.com/cam/capi')
    console.log('')

    while (!usePermanentKey) {
      const secretId = await promptInput('SecretId（AKID 开头）')
      if (!secretId) {
        log('SecretId 为必填项', 'warn')
        continue
      }
      const secretKey = await promptInput('SecretKey', true)
      if (!secretKey) {
        log('SecretKey 为必填项', 'warn')
        continue
      }

      tcbConfig.secretId = secretId
      tcbConfig.secretKey = secretKey

      // 立即写入文件，避免中断后需要重复输入
      saveTargetEnvVar('TCB_SECRET_ID', secretId)
      saveTargetEnvVar('TCB_SECRET_KEY', secretKey)
      log('密钥已写入目标 env 文件', 'success')

      // 使用永久密钥登录 cloudbase CLI
      log('正在使用永久密钥登录 cloudbase CLI...')
      try {
        execSync(`cloudbase login --apiKeyId "${secretId}" --apiKey "${secretKey}"`, {
          stdio: 'pipe',
          encoding: 'utf-8',
        })
        log('cloudbase CLI 登录成功', 'success')
      } catch (e) {
        log(`cloudbase CLI 登录失败: ${e.stderr?.trim() || e.message || e}`, 'warn')
      }

      usePermanentKey = true
    }
  }

  // ── TCB_ENV_ID selection ──────────────────────────────────────
  const existingEnvId = serverEnv['TCB_ENV_ID'] || ''
  if (existingEnvId) {
    const useExisting = await askYesNo(`TCB_ENV_ID 已设置为 ${existingEnvId}，是否继续使用？`, true)
    if (useExisting) {
      tcbConfig.envId = existingEnvId
      tcbConfig.provisionMode = serverEnv['TCB_PROVISION_MODE'] || 'shared'
      return true
    }
  }

  log('正在获取 CloudBase 环境列表...')
  let envList = []
  let output
  try {
    output = execSync('cloudbase env list --json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(output)
    envList = (parsed.data || []).filter(e => e.status === 'NORMAL')
  } catch (e) {
    log(`无法从 cloudbase CLI 获取环境列表: ${e.stderr?.trim() || e.message || output}`, 'warn')
  }

  let selectedEnvId = ''

  if (envList.length === 0) {
    log('未找到可用的 CloudBase 环境', 'warn')
    console.log('')
    console.log('  使用以下命令创建：cloudbase env:create <envName>')
    console.log('  然后重新运行 ./init，或在下方输入已有的 envId。')
    console.log('')
    selectedEnvId = await promptInput('请输入 TCB_ENV_ID')
  } else {
    console.log('')
    console.log('可用的 CloudBase 环境：')
    envList.forEach((e, i) => console.log(`  ${i + 1}) ${e.envId}`))
    console.log(`  c) 创建新环境`)
    console.log('')

    while (!selectedEnvId) {
      const answer = await promptInput('请选择环境（输入序号或 c）')
      if (!answer) continue

      if (answer.toLowerCase() === 'c') {
        console.log('')
        console.log('运行：cloudbase env:create <envName>')
        console.log('然后重新运行 ./init，或在下方输入新的 envId。')
        console.log('')
        selectedEnvId = await promptInput('请输入新的 TCB_ENV_ID')
      } else {
        const idx = parseInt(answer, 10) - 1
        if (idx >= 0 && idx < envList.length) {
          selectedEnvId = envList[idx].envId
        } else {
          log('选择无效，请重试', 'warn')
        }
      }
    }
  }

  if (!selectedEnvId) {
    log('TCB_ENV_ID 为必填项', 'error')
    return false
  }

  tcbConfig.envId = selectedEnvId
  log(`TCB_ENV_ID 已记录：${selectedEnvId}`, 'success')

  // ── TCB_PROVISION_MODE 选择 ───────────────────────────────────
  console.log('')
  console.log('━━━ 用户环境模式 ━━━')
  console.log('')
  console.log('  1) 共享模式（shared）— 默认推荐')
  console.log('     所有用户共用同一个 CloudBase 环境，无需额外资源。')
  console.log('')
  console.log('  2) 独立模式（isolated）')
  console.log('     每个用户自动创建独立的 CloudBase 环境。')
  console.log('     ⚠ 需要账号有足够余额，且密钥具备 CAM 权限。')
  console.log('')

  let mode = ''
  while (!mode) {
    const answer = await promptInput('请选择模式（1 或 2，回车默认选 1）')
    if (!answer || answer === '1') {
      mode = 'shared'
    } else if (answer === '2') {
      mode = 'isolated'
    } else {
      log('请输入 1 或 2', 'warn')
    }
  }

  tcbConfig.provisionMode = mode
  log(`TCB_PROVISION_MODE 已记录：${mode}`, 'success')

  return true
}

async function setupCodebuddy() {
  logSection('CodeBuddy 认证配置')

  const existingServerEnv = loadEnvFile(envWriteTarget)

  // Check if already configured
  const hasApiKey = !!existingServerEnv['CODEBUDDY_API_KEY']
  const hasOAuth = !!(existingServerEnv['CODEBUDDY_CLIENT_ID'] && existingServerEnv['CODEBUDDY_CLIENT_SECRET'])

  if (hasApiKey) {
    console.log('')
    console.log(`  ${colors.green}已检测到 API Key 配置${colors.reset}`)
    console.log(`  密钥：${existingServerEnv['CODEBUDDY_API_KEY'].slice(0, 8)}...`)
    console.log('')
    console.log('  1) 继续使用当前 API Key')
    console.log('  2) 重新配置')
    console.log('')

    const choice = await promptInput('请选择（1 或 2，回车默认选 1）')
    if (!choice || choice === '1') {
      codebuddyConfig.authMode = 'apikey'
      codebuddyConfig.apiKey = existingServerEnv['CODEBUDDY_API_KEY']
      codebuddyConfig.internetEnv = existingServerEnv['CODEBUDDY_INTERNET_ENVIRONMENT'] || ''
      log('使用已有 API Key 配置', 'success')
      return true
    }
  } else if (hasOAuth) {
    console.log('')
    console.log(`  ${colors.green}已检测到 OAuth 配置${colors.reset}`)
    console.log(`  Client ID：${existingServerEnv['CODEBUDDY_CLIENT_ID']}`)
    console.log('')
    console.log('  1) 继续使用当前 OAuth 配置')
    console.log('  2) 切换为 API Key')
    console.log('  3) 重新配置')
    console.log('')

    const choice = await promptInput('请选择（1/2/3，回车默认选 1）')
    if (!choice || choice === '1') {
      codebuddyConfig.authMode = 'oauth'
      codebuddyConfig.clientId = existingServerEnv['CODEBUDDY_CLIENT_ID']
      codebuddyConfig.clientSecret = existingServerEnv['CODEBUDDY_CLIENT_SECRET']
      codebuddyConfig.oauthEndpoint = existingServerEnv['CODEBUDDY_OAUTH_ENDPOINT'] || 'https://copilot.tencent.com/oauth2/token'
      log('使用已有 OAuth 配置', 'success')
      return true
    }
    if (choice === '2') {
      // Fall through to API Key setup below
      codebuddyConfig.authMode = 'apikey'
    } else {
      // Fall through to selection below
      codebuddyConfig.authMode = ''
    }
  }

  // ── 选择认证方式 ──────────────────────────────────────────
  if (!codebuddyConfig.authMode) {
    console.log('')
    console.log('  CodeBuddy SDK 支持两种认证方式：')
    console.log('')
    console.log(`  ${colors.bright}1) API Key（推荐）${colors.reset}`)
    console.log('     个人用户可直接使用，无需企业旗舰版。')
    console.log(`     获取地址：${colors.cyan}https://copilot.tencent.com/profile/${colors.reset}`)
    console.log('')
    console.log(`  ${colors.bright}2) OAuth（企业旗舰版）${colors.reset}`)
    console.log('     需要创建 OAuth 应用获取 Client ID / Secret。')
    console.log('')
    console.log(`  ${colors.dim}3) 跳过，稍后自行在 .env.local 中配置${colors.reset}`)
    console.log('')

    while (!codebuddyConfig.authMode) {
      const choice = await promptInput('请选择（1/2/3，回车默认选 1）')
      if (!choice || choice === '1') {
        codebuddyConfig.authMode = 'apikey'
      } else if (choice === '2') {
        codebuddyConfig.authMode = 'oauth'
      } else if (choice === '3') {
        log('已跳过，稍后请手动配置 .env.local', 'info')
        return true
      } else {
        log('请输入 1、2 或 3', 'warn')
      }
    }
  }

  // ── API Key 配置 ───────────────────────────────────────────
  if (codebuddyConfig.authMode === 'apikey') {
    console.log('')
    console.log(`  获取 API Key：${colors.cyan}https://copilot.tencent.com/profile/${colors.reset}`)
    console.log('')

    const apiKey = await promptInput('请输入 API Key')
    if (!apiKey) {
      log('未输入 API Key，已跳过', 'warn')
      return true
    }
    codebuddyConfig.apiKey = apiKey

    console.log('')
    console.log('  网络环境（影响 API 端点）：')
    console.log('  1) 国内版（默认）')
    console.log('  2) 海外版')
    console.log('  3) iOA')
    console.log('')

    const envChoice = await promptInput('请选择（1/2/3，回车默认选 1）')
    if (!envChoice || envChoice === '1') {
      codebuddyConfig.internetEnv = 'internal'
    } else if (envChoice === '2') {
      codebuddyConfig.internetEnv = ''
    } else if (envChoice === '3') {
      codebuddyConfig.internetEnv = 'ioa'
    }

    log('CodeBuddy API Key 已配置', 'success')
    return true
  }

  // ── OAuth 配置 ─────────────────────────────────────────────
  if (codebuddyConfig.authMode === 'oauth') {
    console.log('')
    console.log('  请输入 CodeBuddy OAuth 应用凭据。')
    console.log(`  创建地址：${colors.cyan}https://copilot.tencent.com${colors.reset}`)
    console.log('')

    const clientId = await promptInput('Client ID')
    if (!clientId) {
      log('未输入 Client ID，已跳过', 'warn')
      return true
    }

    const clientSecret = await promptInput('Client Secret', true)
    if (!clientSecret) {
      log('未输入 Client Secret，已跳过', 'warn')
      return true
    }

    codebuddyConfig.clientId = clientId
    codebuddyConfig.clientSecret = clientSecret

    console.log('')
    console.log('  OAuth Token 端点：')
    console.log('  1) https://copilot.tencent.com/oauth2/token（国内，默认）')
    console.log('  2) 自定义')
    console.log('')

    const endpointChoice = await promptInput('请选择（1 或 2，回车默认选 1）')
    if (!endpointChoice || endpointChoice === '1') {
      codebuddyConfig.oauthEndpoint = 'https://copilot.tencent.com/oauth2/token'
    } else {
      codebuddyConfig.oauthEndpoint = await promptInput('请输入 OAuth Token 端点 URL')
    }

    log('CodeBuddy OAuth 已配置', 'success')
    return true
  }

  return true
}

function childProcessEnv() {
  return { ...process.env, OVC_ENV_FILE: envWriteTarget }
}

/** CloudBase AI+ API Key — shared by CodeBuddy / OpenCode custom model setup (not CODEBUDDY_API_KEY). */
async function ensureCloudbaseApiKey() {
  const env = loadEnvFile(envWriteTarget)
  if (env['CLOUDBASE_API_KEY']?.trim()) {
    return true
  }

  const envId = env['TCB_ENV_ID'] || tcbConfig.envId
  logSection('CloudBase AI API Key（CLOUDBASE_API_KEY）')
  console.log('')
  console.log('  用途：拉取当前环境已开通的 AI 模型，写入 CodeBuddy / OpenCode 配置')
  console.log('  不是 CodeBuddy Copilot 登录密钥（那是 CODEBUDDY_API_KEY）')
  console.log('')
  if (envId) {
    console.log(`  创建：${colors.cyan}https://tcb.cloud.tencent.com/dev?envId=${envId}#/env/apikey${colors.reset}`)
  }
  console.log('')

  const value = await promptInput('  CLOUDBASE_API_KEY', true)
  if (!value?.trim()) {
    log('未输入 CLOUDBASE_API_KEY，将跳过自定义模型配置', 'warn')
    return false
  }

  saveTargetEnvVar('CLOUDBASE_API_KEY', value.trim())
  saveTargetEnvVar('CODEBUDDY_USE_CUSTOM_MODELS', 'true')
  log('已写入 CLOUDBASE_API_KEY', 'success')
  return true
}

async function setupCustomModel() {
  console.log('')
  console.log('  自定义模型：从 CloudBase 环境（AI+）拉取已开通模型列表，不是向 CodeBuddy 产品拉模型。')
  console.log('')

  const setupCodeBuddyModel = await askYesNo('是否配置 CodeBuddy 自定义模型（models.json）', false)
  const setupOpenCodeModel = await askYesNo('是否配置 OpenCode 自定义模型（opencode.json）', false)

  if (setupCodeBuddyModel || setupOpenCodeModel) {
    if (!(await ensureCloudbaseApiKey())) {
      log('已跳过 CodeBuddy / OpenCode 模型配置', 'info')
      return true
    }
  }

  if (setupCodeBuddyModel) {
    log('正在运行 CodeBuddy 模型配置脚本...')
    try {
      execSync('node scripts/codebuddy-setup.mjs', { stdio: 'inherit', env: childProcessEnv() })
      log('CodeBuddy 模型配置完成', 'success')
    } catch (error) {
      log('CodeBuddy 模型配置失败，可稍后手动执行：node scripts/codebuddy-setup.mjs', 'warn')
      console.log('')
      await promptInput('  按回车继续...')
    }
  } else {
    log('已跳过 CodeBuddy 自定义模型配置，稍后请手动执行：node scripts/codebuddy-setup.mjs', 'info')
  }

  if (setupOpenCodeModel) {
    log('正在运行 OpenCode 模型配置脚本...')
    try {
      execSync('node scripts/opencode-setup.mjs', { stdio: 'inherit', env: childProcessEnv() })
      log('OpenCode 模型配置完成', 'success')
    } catch (error) {
      log('OpenCode 模型配置失败，可稍后手动执行：node scripts/opencode-setup.mjs', 'warn')
      console.log('')
      await promptInput('  按回车继续...')
    }
  } else {
    log('已跳过 OpenCode 自定义模型配置，稍后请手动执行：node scripts/opencode-setup.mjs', 'info')
  }

  return true
}

async function setupStatefulSandbox() {
  logSection('Stateful 沙箱运行时')
  console.log('')
  console.log('  需要 TCB_API_KEY（控制台 → 沙箱 API Key）。')
  console.log('')

  if (await askYesNo('是否现在填写 TCB_API_KEY？', true)) {
    const apiKey = await promptInput('  TCB_API_KEY', true)
    if (apiKey.trim()) {
      saveTargetEnvVar('TCB_API_KEY', apiKey.trim())
      log('TCB_API_KEY 已写入目标 env 文件', 'success')
    }
  }

  if (await askYesNo('是否指定 STATEFUL_SANDBOX_IMAGE？（默认否，使用工程内置镜像）', false)) {
    const image = await promptInput('  镜像 URI')
    if (image.trim()) {
      saveTargetEnvVar('STATEFUL_SANDBOX_IMAGE', image.trim())
      log('STATEFUL_SANDBOX_IMAGE 已写入目标 env 文件', 'success')
    }
  }

  return true
}

function resolveDockerCmd() {
  try {
    execSync('docker info', { stdio: 'pipe' })
    return 'docker'
  } catch {
    // docker not available
  }
  try {
    execSync('podman info', { stdio: 'pipe' })
    return 'podman'
  } catch {
    // podman not available
  }
  return null
}

async function setupTcrEnterprise(env) {
  const image = env['TCR_IMAGE']
  const username = env['TCR_USERNAME']
  const password = env['TCR_PASSWORD']
  const sourceImage = env['TCR_LOCAL_IMAGE'] || 'ghcr.io/yhsunshining/cloudbase-workspace:260513-0354ed6b'

  if (!image) {
    log('企业版模式需要配置 TCR_IMAGE', 'error')
    return false
  }
  if (!username || !password) {
    log('企业版模式需要配置 TCR_USERNAME 和 TCR_PASSWORD（服务级账号）', 'error')
    return false
  }

  const dockerCmd = resolveDockerCmd()
  if (!dockerCmd) {
    log('未找到 Docker 或 Podman，请先安装', 'error')
    return false
  }

  // 从镜像 URL 中提取 registry 域名
  const registry = image.split('/')[0]

  // Step 1: docker login
  log(`登录企业版 TCR：${registry}`)
  try {
    execSync(`echo '${password}' | ${dockerCmd} login ${registry} --username ${username} --password-stdin`, {
      stdio: 'pipe',
    })
    log('TCR 登录成功', 'success')
  } catch {
    log('TCR 登录失败，请检查 TCR_USERNAME / TCR_PASSWORD', 'error')
    return false
  }

  // Step 2: 检查本地是否已有目标镜像，有则跳过 pull
  let localImageExists = false
  try {
    execSync(`${dockerCmd} image inspect ${image}`, { stdio: 'pipe' })
    localImageExists = true
    log(`目标镜像已存在，跳过拉取：${image}`, 'success')
  } catch {
    // not found locally
  }

  if (!localImageExists) {
    // Step 3: pull 源镜像
    log(`拉取源镜像：${sourceImage}`)
    try {
      execSync(`${dockerCmd} pull ${sourceImage}`, { stdio: 'inherit' })
      log('源镜像拉取成功', 'success')
    } catch {
      log('源镜像拉取失败，请检查网络或手动拉取', 'error')
      return false
    }

    // Step 4: tag
    log(`标记镜像：${sourceImage} → ${image}`)
    try {
      execSync(`${dockerCmd} tag ${sourceImage} ${image}`, { stdio: 'pipe' })
      log('镜像标记成功', 'success')
    } catch {
      log('镜像标记失败', 'error')
      return false
    }

    // Step 5: push
    log(`推送镜像：${image}`)
    try {
      execSync(`${dockerCmd} push ${image}`, { stdio: 'inherit' })
      log('镜像推送成功', 'success')
    } catch {
      log('镜像推送失败，请检查权限或网络', 'error')
      return false
    }
  }

  return true
}

// ===================== TCR Type Selection =====================

async function selectTcrType() {
  logSection('选择镜像仓库类型')

  const serverEnvFile = resolve(process.cwd(), 'packages/server/.env')
  const serverEnv = {}
  if (existsSync(serverEnvFile)) {
    readFileSync(serverEnvFile, 'utf-8').split('\n').forEach(line => {
      const t = line.trim()
      if (t && !t.startsWith('#')) {
        const [k, ...v] = t.split('=')
        if (k) serverEnv[k.trim()] = v.join('=').trim()
      }
    })
  }

  // 已配置镜像则跳过
  const existingUri = serverEnv['SANDBOX_IMAGE_URI'] || serverEnv['SCF_SANDBOX_IMAGE_URI']
  if (existingUri) {
    log(`镜像已配置，跳过类型选择：${existingUri}`, 'success')
    return true
  }

  console.log('')
  console.log('  沙箱镜像将通过云托管 CD 构建并推送到腾讯云容器镜像服务（TCR）。')
  console.log('  请选择使用的 TCR 版本：')
  console.log('')
  console.log('  1) 个人版（免费，适合个人开发）')
  console.log('  2) 企业版（独立实例，需已购买）')
  console.log('')

  const choice = await promptInput('请选择（1 或 2，回车默认选 1）')
  const isEnterprise = choice === '2'

  if (!isEnterprise) {
    tcrConfig.type = 'personal'
    log('使用个人版 TCR', 'success')
    return true
  }

  tcrConfig.type = 'enterprise'
  log('使用企业版 TCR，正在查询实例列表...', 'info')

  const { createRequire } = await import('module')
  const req = createRequire(resolve(process.cwd(), 'package.json'))
  let sdk
  try {
    sdk = req('tencentcloud-sdk-nodejs')
  } catch {
    log('未找到 tencentcloud-sdk-nodejs，请先运行 pnpm install', 'error')
    return false
  }

  const secretId = tcbConfig.secretId
  const secretKey = tcbConfig.secretKey
  const token = tcbConfig.token

  if (!secretId || !secretKey) {
    log('缺少腾讯云密钥，无法查询 TCR 实例', 'error')
    return false
  }

  const TcrClient = sdk.tcr.v20190924.Client
  const credential = { secretId, secretKey }
  if (token) credential.token = token

  while (true) {
    try {
      const regions = ['ap-guangzhou', 'ap-shanghai', 'ap-beijing', 'ap-chengdu', 'ap-chongqing', 'ap-shenzhen']
      const allInstances = []
      for (const region of regions) {
        const client = new TcrClient({
          credential,
          region,
          profile: { httpProfile: { endpoint: 'tcr.tencentcloudapi.com' } },
        })
        try {
          const result = await client.DescribeInstances({})
          if (result.Registries) {
            for (const r of result.Registries) {
              if (!allInstances.find(i => i.RegistryId === r.RegistryId)) {
                allInstances.push(r)
              }
            }
          }
        } catch {
          // 该地域无实例或无权限，跳过
        }
      }

      if (allInstances.length === 0) {
        console.log('')
        log('未找到企业版 TCR 实例，请先在控制台创建：', 'warn')
        log('  https://console.cloud.tencent.com/tcr', 'info')
        console.log('')
        const retry = await promptInput('创建完成后按 Enter 重试，输入 skip 跳过改用个人版')
        if (retry.toLowerCase() === 'skip') {
          tcrConfig.type = 'personal'
          log('已切换为个人版 TCR', 'info')
          return true
        }
        continue
      }

      let selected
      if (allInstances.length === 1) {
        selected = allInstances[0]
        log(`自动选择唯一实例：${selected.RegistryName}（${selected.RegistryId}）`, 'success')
      } else {
        console.log('')
        console.log('  发现以下企业版 TCR 实例：')
        allInstances.forEach((r, i) => {
          console.log(`  ${i + 1}) ${r.RegistryName} (${r.RegistryId}) - ${r.RegionName || r.Region}`)
        })
        console.log('')
        const idx = await promptInput(`请输入序号（1-${allInstances.length}）`)
        const n = parseInt(idx, 10)
        if (!n || n < 1 || n > allInstances.length) {
          log('序号无效，请重新选择', 'warn')
          continue
        }
        selected = allInstances[n - 1]
        log(`已选择：${selected.RegistryName}（${selected.RegistryId}）`, 'success')
      }

      tcrConfig.registryId = selected.RegistryId
      return true
    } catch (err) {
      log(`查询 TCR 实例失败：${err.message}`, 'error')
      return false
    }
  }
}

// ===================== Sandbox Image via CloudRun CD =====================

async function setupSandboxImage() {
  logSection('配置沙箱镜像（CloudRun CD）')

  const serverEnvFile = resolve(process.cwd(), 'packages/server/.env')
  const serverEnv = {}
  if (existsSync(serverEnvFile)) {
    readFileSync(serverEnvFile, 'utf-8').split('\n').forEach(line => {
      const t = line.trim()
      if (t && !t.startsWith('#')) {
        const [k, ...v] = t.split('=')
        if (k) serverEnv[k.trim()] = v.join('=').trim()
      }
    })
  }

  // 已配置则跳过
  const existingUri = serverEnv['SANDBOX_IMAGE_URI'] || serverEnv['SCF_SANDBOX_IMAGE_URI']
  if (existingUri) {
    log(`沙箱镜像已配置，跳过：${existingUri}`, 'success')
    return true
  }

  const envId = tcbConfig.envId
  if (!envId) {
    log('缺少 TCB_ENV_ID，请先完成 CloudBase 配置', 'error')
    return false
  }

  const { createRequire } = await import('module')
  const req = createRequire(resolve(process.cwd(), 'package.json'))
  let CloudBase
  try {
    CloudBase = req('@cloudbase/manager-node')
  } catch {
    log('未找到 @cloudbase/manager-node，请先运行 pnpm install', 'error')
    return false
  }

  const app = new CloudBase({
    secretId: tcbConfig.secretId,
    secretKey: tcbConfig.secretKey,
    token: tcbConfig.token,
    envId,
  })
  const tcbr = app.commonService('tcbr', '2022-02-17')

  // 检测云托管是否开通
  while (true) {
    try {
      await tcbr.call({ Action: 'DescribeCloudRunServers', Param: { EnvId: envId } })
      break
    } catch (err) {
      const msg = err.message || ''
      if (msg.includes('not exist') || msg.includes('NotExist') || msg.includes('InvalidParameter')) {
        console.log('')
        log('云托管服务未开通，请先在控制台开通：', 'warn')
        log('  https://console.cloud.tencent.com/tcbr', 'info')
        console.log('')
        await promptInput('开通完成后按 Enter 继续')
      } else {
        break
      }
    }
  }

  // 写 cloudbaserc.json 确保 CLI 能识别环境
  const cloudbaseRcFile = resolve(process.cwd(), 'cloudbaserc.json')
  const rcBackup = existsSync(cloudbaseRcFile) ? readFileSync(cloudbaseRcFile, 'utf-8') : null
  writeFileSync(cloudbaseRcFile, JSON.stringify({ envId }, null, 2))

  const SERVICE_NAME = 'sandbox-base-image'
  const SOURCE_DIR = resolve(process.cwd(), 'scripts/sandbox-image')

  // 若服务不存在，先用 API 预创建（MinNum=0, MaxNum=1），避免 deploy 触发自动扩容
  // 注意：CreateCloudRunServer 的 MaxNum 必须 > 0，不能为 0
  try {
    const existResult = await tcbr.call({
      Action: 'DescribeCloudRunServers',
      Param: { EnvId: envId, ServerName: SERVICE_NAME },
    })
    const exists = existResult.ServerList?.length > 0
    if (!exists) {
      log('服务不存在，预创建（MinNum=0, MaxNum=1）以禁止自动拉起 Pod...', 'info')
      await tcbr.call({
        Action: 'CreateCloudRunServer',
        Param: {
          EnvId: envId,
          ServerName: SERVICE_NAME,
          DeployInfo: {
            DeployType: 'code',
          },
          Items: [
            { Key: 'Port', IntValue: 9000 },
            { Key: 'MinNum', IntValue: 0 },
            { Key: 'MaxNum', IntValue: 1 },
          ],
        },
      })
      log('服务预创建完成（MinNum=0, MaxNum=1）', 'success')
    }
  } catch (err) {
    // 预创建失败不阻断，deploy 时 CLI 会自动创建（副本数用默认值）
    log(`预创建服务失败（将由 CLI 自动创建）：${err.message}`, 'warn')
  }

  try {
    log(`部署沙箱镜像到云托管服务：${SERVICE_NAME}`)
    execSync(
      `cloudbase cloudrun deploy -s ${SERVICE_NAME} --port 9000 --force --source .`,
      { stdio: 'inherit', cwd: SOURCE_DIR }
    )
    log('部署命令已提交，等待云端 CD 构建...', 'success')
  } catch (err) {
    log(`部署失败：${err.message}`, 'error')
    if (rcBackup !== null) writeFileSync(cloudbaseRcFile, rcBackup)
    return false
  } finally {
    if (rcBackup !== null) writeFileSync(cloudbaseRcFile, rcBackup)
  }

  // 轮询等待 CD 构建完成
  const POLL_INTERVAL = 15000  // 15s
  const MAX_POLLS = 40          // 最多 10 分钟
  let imageUri = ''

  console.log('')
  log('等待 CD 构建完成（最多 10 分钟）...', 'info')

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    const elapsed = Math.round((i + 1) * POLL_INTERVAL / 1000)
    process.stdout.write(`\r  ${colors.dim}已等待 ${elapsed}s / ${MAX_POLLS * POLL_INTERVAL / 1000}s...${colors.reset}`)

    try {
      const result = await tcbr.call({
        Action: 'DescribeCloudRunServerDetail',
        Param: { EnvId: envId, ServerName: SERVICE_NAME },
      })
      const uri = result.OnlineVersionInfos?.[0]?.ImageUrl
      if (uri) {
        imageUri = uri
        process.stdout.write('\n')
        break
      }
    } catch {
      // 服务还未就绪，继续等待
    }
  }

  if (!imageUri) {
    process.stdout.write('\n')
    log('超时未获取到镜像 URI，请在控制台确认构建状态：', 'warn')
    log(`  https://tcb.cloud.tencent.com/dev?envId=${envId}#/platform-run/service/detail?serverName=${SERVICE_NAME}&tabId=deploy&envId=${envId}`, 'info')
    return false
  }

  // 推断镜像类型
  const host = imageUri.split('/')[0]
  const imageType = host.endsWith('.tencentcloudcr.com') ? 'enterprise' : 'personal'

  // 写入 packages/server/.env
  const setVar = (content, key, value) => {
    if (!value) return content
    if (content.includes(`${key}=`)) {
      return content.replace(new RegExp(`${key}=.*`), `${key}=${value}`)
    }
    return content + `\n${key}=${value}`
  }

  let content = existsSync(serverEnvFile) ? readFileSync(serverEnvFile, 'utf-8') : ''
  content = setVar(content, 'SANDBOX_IMAGE_URI', imageUri)
  content = setVar(content, 'SANDBOX_IMAGE_TYPE', imageType)
  if (imageType === 'enterprise' && tcrConfig.registryId) {
    content = setVar(content, 'SANDBOX_IMAGE_REGISTRY_ID', tcrConfig.registryId)
  }
  writeFileSync(serverEnvFile, content)

  log(`镜像 URI：${imageUri}`, 'success')
  log(`镜像类型：${imageType}`, 'success')
  if (imageType === 'enterprise' && tcrConfig.registryId) {
    log(`RegistryId：${tcrConfig.registryId}`, 'success')
  }
  log('沙箱镜像配置已写入 packages/server/.env', 'success')
  return true
}

async function setupTcr() {
  logSection('配置 TCR（容器镜像服务）')

  const env = loadEnvFile(envWriteTarget)
  const imageType =
    env['SANDBOX_IMAGE_TYPE'] || env['SCF_SANDBOX_IMAGE_TYPE'] || 'personal'

  // 企业版模式：执行 docker login + pull + tag + push
  if (imageType === 'enterprise') {
    log('检测到企业版 TCR 模式')
    return await setupTcrEnterprise(env)
  }

  // 个人版模式：已有 TCR_IMAGE 则跳过
  const existingImage = env['TCR_IMAGE'] || env['SCF_SANDBOX_IMAGE_URI']
  if (existingImage) {
    log(`TCR 镜像已配置，跳过 setup-tcr.mjs：${existingImage}`, 'success')
    return true
  }

  // Run the full TCR setup script, passing credentials via env
  log('正在运行 TCR 配置脚本...')
  try {
    execSync('node scripts/setup-tcr.mjs', {
      stdio: 'inherit',
      env: {
        ...process.env,
        TCB_SECRET_ID: tcbConfig.secretId || process.env.TCB_SECRET_ID || '',
        TCB_SECRET_KEY: tcbConfig.secretKey || process.env.TCB_SECRET_KEY || '',
        TCB_TOKEN: tcbConfig.token || process.env.TCB_TOKEN || '',
        TCB_ENV_ID: tcbConfig.envId || process.env.TCB_ENV_ID || '',
        TCB_REGION: process.env.TCB_REGION || 'ap-shanghai',
        TENCENTCLOUD_ACCOUNT_ID: process.env.TENCENTCLOUD_ACCOUNT_ID || '',
        TCR_PASSWORD: env['TCR_PASSWORD'] || '',
        TCR_USERNAME: env['TCR_USERNAME'] || '',
      },
    })
    log('TCR 配置完成', 'success')
    return true
  } catch (error) {
    log(`TCR 配置失败: ${error.message || error}`, 'warn')
    log('可稍后手动执行：node scripts/setup-tcr.mjs', 'info')
    return false
  }
}

function createEnvResolvers(existingServerEnv, env) {
  const tcbKeyMap = {
    TCB_SECRET_ID: tcbConfig.secretId,
    TCB_SECRET_KEY: tcbConfig.secretKey,
    TCB_TOKEN: tcbConfig.token,
    TCB_ENV_ID: tcbConfig.envId,
    TCB_REGION: process.env.TCB_REGION || 'ap-shanghai',
    TCB_PROVISION_MODE: tcbConfig.provisionMode,
  }
  const get = (key, fallback = '') =>
    tcbKeyMap[key] !== undefined && tcbKeyMap[key] !== ''
      ? tcbKeyMap[key]
      : env[key] || process.env[key] || fallback
  const getPreserved = (key, fallback = '') => existingServerEnv[key] || fallback
  return { get, getPreserved }
}

function buildSharedEnvBody(get, getPreserved, { port, nodeEnv, askUserBaseUrl }) {
  const jweSecret =
    get('JWE_SECRET') || crypto.randomBytes(32).toString('base64')
  const encryptionKey =
    get('ENCRYPTION_KEY') || crypto.randomBytes(32).toString('hex')

  const askUserBlock =
    askUserBaseUrl === undefined
      ? ''
      : `\n# 云托管公网根 URL（本地 dev 用 http://127.0.0.1:3001；部署后填控制台域名）\nASK_USER_BASE_URL=${askUserBaseUrl}\n`

  return `# Generated by init — do not commit (see .env.example for field docs)

# ==================== Session / at-rest encryption (server only) ====================
# JWE_SECRET: login session cookies
# ENCRYPTION_KEY: MCP connector secrets in DB (openssl rand -hex 32)

JWE_SECRET=${jweSecret}
ENCRYPTION_KEY=${encryptionKey}

# ==================== Server ====================

PORT=${port}
NODE_ENV=${nodeEnv}
DATABASE_PATH=${getPreserved('DATABASE_PATH', '.data/app.db')}

# ==================== Database ====================

DB_PROVIDER=${getPreserved('DB_PROVIDER', 'cloudbase')}
DB_COLLECTION_PREFIX=${getPreserved('DB_COLLECTION_PREFIX', 'vibe_agent_')}

# ==================== Rate limiting ====================

MAX_SANDBOX_DURATION=${get('MAX_SANDBOX_DURATION', '300')}

# ==================== Auth (runtime reads /api/auth/auth-config; kept for parity) ====================

NEXT_PUBLIC_AUTH_PROVIDERS=${get('NEXT_PUBLIC_AUTH_PROVIDERS', 'local')}
AUTH_GITHUB_MODE=${getPreserved('AUTH_GITHUB_MODE', 'direct')}
${askUserBlock}
# ==================== CloudBase (platform / provision) ====================

TCB_ENV_ID=${get('TCB_ENV_ID')}
TCB_REGION=${get('TCB_REGION', 'ap-shanghai')}
TCB_SECRET_ID=${get('TCB_SECRET_ID')}
TCB_SECRET_KEY=${get('TCB_SECRET_KEY')}
TCB_TOKEN=${get('TCB_TOKEN')}
TCB_PROVISION_MODE=${get('TCB_PROVISION_MODE', 'shared')}

# ==================== CodeBuddy ====================
# API Key 优先；OAuth 仅企业旗舰版
${codebuddyConfig.authMode === 'apikey'
    ? `CODEBUDDY_API_KEY=${codebuddyConfig.apiKey}`
    : `# CODEBUDDY_API_KEY=`
  }${codebuddyConfig.internetEnv
    ? `\nCODEBUDDY_INTERNET_ENVIRONMENT=${codebuddyConfig.internetEnv}`
    : `\n# CODEBUDDY_INTERNET_ENVIRONMENT=internal`
  }
${codebuddyConfig.authMode === 'oauth'
    ? `\nCODEBUDDY_CLIENT_ID=${codebuddyConfig.clientId}\nCODEBUDDY_CLIENT_SECRET=${codebuddyConfig.clientSecret}\nCODEBUDDY_OAUTH_ENDPOINT=${codebuddyConfig.oauthEndpoint}`
    : `\n# CODEBUDDY_CLIENT_ID=\n# CODEBUDDY_CLIENT_SECRET=\n# CODEBUDDY_OAUTH_ENDPOINT=https://copilot.tencent.com/oauth2/token`
  }

GIT_ARCHIVE_REPO=${getPreserved('GIT_ARCHIVE_REPO')}
GIT_ARCHIVE_USER=${getPreserved('GIT_ARCHIVE_USER')}
GIT_ARCHIVE_TOKEN=${getPreserved('GIT_ARCHIVE_TOKEN')}

# ==================== Stateful sandbox ====================
# TCB_API_KEY: 控制台 → 沙箱 API Key；gateway 由 TCB_ENV_ID 推导

TCB_API_KEY=${getPreserved('TCB_API_KEY', get('TCB_API_KEY'))}
${getPreserved('ENABLE_AUTH_MODE') === 'true'
    ? `ENABLE_AUTH_MODE=true\nTCB_ACCESS_TOKEN=${getPreserved('TCB_ACCESS_TOKEN')}`
    : '# ENABLE_AUTH_MODE=false\n# TCB_ACCESS_TOKEN='}
${getPreserved('STATEFUL_SANDBOX_IMAGE') ? `STATEFUL_SANDBOX_IMAGE=${getPreserved('STATEFUL_SANDBOX_IMAGE')}` : '# STATEFUL_SANDBOX_IMAGE='}
WORKSPACE_ISOLATION=${get('WORKSPACE_ISOLATION', 'shared')}
SANDBOX_TTL_SECONDS=${getPreserved('SANDBOX_TTL_SECONDS', '1800')}

# ==================== Optional ====================

# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# http_proxy=
`
}

async function setupApplicationEnv() {
  const isLocal = envWriteTarget === ENV_LOCAL
  const targetLabel = isLocal ? '.env.local' : '.env.cloud'
  logSection(`写入 ${targetLabel}`)

  const existingServerEnv = loadEnvFile(envWriteTarget)
  const env = loadEnvFile(envWriteTarget)

  if (existsSync(envWriteTarget)) {
    const overwrite = await askYesNo(`${targetLabel} 已存在，是否覆盖？`, false)
    if (!overwrite) {
      log(`跳过 ${targetLabel} 生成`, 'info')
      return true
    }
  }

  const { get, getPreserved } = createEnvResolvers(existingServerEnv, env)

  if (isLocal) {
    const header = `# OpenVibeCoding — local development
# Load: packages/server/package.json → pnpm dev (--env-file=../../.env.local)
`
    writeFileSync(
      ENV_LOCAL,
      header +
        buildSharedEnvBody(get, getPreserved, {
          port: '3001',
          nodeEnv: 'development',
          askUserBaseUrl: getPreserved('ASK_USER_BASE_URL', 'http://127.0.0.1:3001'),
        }),
    )
    log('已写入 .env.local', 'success')
    return true
  }

  console.log('')
  console.log('  ASK_USER_BASE_URL：Agent 向用户提问时拼接链接用的云托管公网根 URL')
  console.log('  首次部署前控制台往往还没有默认域名，可直接回车用占位。')
  console.log(`  占位：${ASK_USER_BASE_URL_PLACEHOLDER}`)
  console.log('  首次 pnpm deploy:cloud 成功后会尝试从云托管读取域名并写回 .env.cloud')
  const cloudUrl =
    (await promptInput('  ASK_USER_BASE_URL（回车=占位，部署后自动/手动改）')) ||
    getPreserved('ASK_USER_BASE_URL', '')

  const header = `# OpenVibeCoding — CloudRun runtime
# Sync: pnpm deploy:cloud → UpdateCloudRunServer EnvParams (not baked into Docker image)
`
  writeFileSync(
    ENV_CLOUD,
    header +
      buildSharedEnvBody(get, getPreserved, {
        port: '80',
        nodeEnv: 'production',
        askUserBaseUrl: cloudUrl || ASK_USER_BASE_URL_PLACEHOLDER,
      }),
  )
  log('已写入 .env.cloud', 'success')
  return true
}

// ===================== Dependencies =====================

async function installDependencies() {
  logSection('安装依赖')

  const result = runCommandSafe('pnpm install')

  if (!result.success) {
    log('依赖安装失败', 'error')
    return false
  }

  log('依赖安装成功', 'success')

  // 重新编译原生模块（better-sqlite3 需要针对当前 Node.js 版本编译）
  log('正在编译原生模块...', 'info')
  try {
    // 动态查找 better-sqlite3 目录，避免写死版本号
    const { execSync: exec } = await import('child_process')
    const pkgDir = exec(
      'node -e "console.log(require.resolve(\'better-sqlite3/package.json\').replace(\'/package.json\', \'\'))"',
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim()

    const rebuild = runCommandSafe(`npm run build-release --prefix "${pkgDir}"`)
    if (rebuild.success) {
      log('原生模块编译成功', 'success')
    } else {
      log('原生模块编译失败，如遇到 better-sqlite3 错误请手动运行：', 'warn')
      log('  pnpm rebuild better-sqlite3', 'info')
    }
  } catch (e) {
    log('未找到 better-sqlite3，跳过原生模块编译', 'warn')
  }

  return true
}

// ===================== Main =====================

async function main() {
  console.log('')
  console.log(`${colors.bright}${colors.cyan}╔══════════════════════════════════════════════╗${colors.reset}`)
  console.log(`${colors.bright}${colors.cyan}║        🚀 项目初始化脚本                    ║${colors.reset}`)
  console.log(`${colors.bright}${colors.cyan}╚══════════════════════════════════════════════╝${colors.reset}`)
  console.log('')

  // Step 1: Check Node.js
  if (!checkNodeVersion()) {
    process.exit(1)
  }

  // Step 2: Check/install pnpm
  if (!(await checkPnpm())) {
    process.exit(1)
  }

  await promptEnvGenerationTarget()

  // CloudBase configuration (TCB_ENV_ID + token)
  if (!(await setupCloudbaseConfig())) {
    process.exit(1)
  }

  // CodeBuddy before env file — values are written into envWriteTarget
  await setupCodebuddy()

  await setupStatefulSandbox()

  if (!(await setupApplicationEnv())) {
    process.exit(1)
  }

  if (!(await installDependencies())) {
    process.exit(1)
  }

  // --- TCR（Stateful 默认跳过；维护自建沙箱镜像时可取消注释）---
  // if (!checkDocker()) {
  //   process.exit(1)
  // }
  // logSection('TCR 配置')
  // if (!(await setupTcr())) {
  //   process.exit(1)
  // }
  // const rootEnvAfterTcr = loadEnvFile(ENV_LOCAL)
  // if (rootEnvAfterTcr['TCR_IMAGE']) {
  //   saveEnvVar(ENV_LOCAL, 'STATEFUL_SANDBOX_IMAGE', rootEnvAfterTcr['TCR_IMAGE'])
  //   log('TCR_IMAGE 已写入 STATEFUL_SANDBOX_IMAGE', 'success')
  // }

  // Initialize database
  logSection('初始化数据库')
  const serverEnvVars = loadEnvFile(envWriteTarget)

  const dbProvider = serverEnvVars['DB_PROVIDER'] || 'cloudbase'

  if (dbProvider === 'drizzle') {
    // Drizzle 模式：初始化 SQLite 表结构
    const dbPath = serverEnvVars['DATABASE_PATH'] || '.data/app.db'
    const resolvedDbPath = dbPath.startsWith('/')
      ? dbPath
      : resolve(process.cwd(), 'packages/server', dbPath)
    const { mkdirSync } = await import('fs')
    mkdirSync(resolve(resolvedDbPath, '..'), { recursive: true })
    const dbResult = runCommandSafe(
      `DATABASE_PATH="${resolvedDbPath}" pnpm db:push`
    )
    if (dbResult.success) {
      log('SQLite 数据库表初始化成功', 'success')
    } else {
      log('数据库初始化失败，请手动运行：pnpm db:push', 'warn')
    }
  } else {
    // CloudBase 模式：集合会在首次访问时自动创建
    log('使用 CloudBase 数据库，集合将在首次访问时自动创建', 'success')
  }

  // Step 10.5: Git Archive 配置（交互式）
  logSection('Git 归档配置')
  console.log('')
  console.log('  Git 归档用于持久化沙箱内的工作区代码。')
  console.log('  每轮对话结束后，沙箱中的代码会自动 push 到归档仓库。')
  console.log('')
  console.log(`  ${colors.yellow}⚠ 如果不配置：沙箱重启或空闲回收后，工作区内容将丢失。${colors.reset}`)
  console.log('')
  console.log('  需要准备：')
  console.log('    1. 一个 Git 仓库（推荐 https://cnb.cool 新建一个空仓库）')
  console.log('    2. 该仓库的访问令牌（需读写权限）')
  console.log('')

  const gitArchiveDefaultYes = envWriteTarget !== ENV_LOCAL
  const configGitArchive = await askYesNo('是否现在配置 Git 归档？', gitArchiveDefaultYes)
  if (configGitArchive) {
    const gitRepo = await promptInput('  Git 仓库地址（如 https://cnb.cool/org/repo）')
    const gitUser = await promptInput('  用户名')
    const gitToken = await promptInput('  访问令牌', true)

    if (gitRepo && gitToken) {
      saveTargetEnvVar('GIT_ARCHIVE_REPO', gitRepo)
      saveTargetEnvVar('GIT_ARCHIVE_USER', gitUser || '')
      saveTargetEnvVar('GIT_ARCHIVE_TOKEN', gitToken)
      log('Git 归档已写入当前 env 文件', 'success')
    } else {
      log('信息不完整，跳过 Git 归档配置', 'warn')
    }
  } else {
    console.log('')
    log('已跳过。沙箱重启后工作区内容将不保留，后续可在 env 文件中手动配置', 'info')
    console.log('')
  }

  // Step 11: Install Skills
  logSection('安装 Skills')
  const installSkillsResult = runCommandSafe('sh scripts/install-skills.sh')
  if (installSkillsResult.success) {
    log('Skills 安装完成', 'success')
  } else {
    log('Skills 安装失败（可选步骤，不影响启动）', 'warn')
    log('可手动运行: sh scripts/install-skills.sh', 'info')
  }

  // Step 12: 配置自定义模型
  logSection('配置自定义模型')
  if (!(await setupCustomModel())) {
    process.exit(1)
  }


  // Done!
  console.log('')
  console.log(`${colors.bright}${colors.green}╔══════════════════════════════════════════════╗${colors.reset}`)
  console.log(`${colors.bright}${colors.green}║           ✅ 初始化完成！                   ║${colors.reset}`)
  console.log(`${colors.bright}${colors.green}╚══════════════════════════════════════════════╝${colors.reset}`)
  console.log('')

  const envFileName = envWriteTarget === ENV_CLOUD ? '.env.cloud' : '.env.local'

  if (codebuddyConfig.authMode) {
    console.log(`${colors.green}✓${colors.reset} CodeBuddy 认证已配置（${codebuddyConfig.authMode === 'apikey' ? 'API Key' : 'OAuth'}）`)
  } else {
    console.log(`${colors.yellow}!${colors.reset} CodeBuddy 认证未配置，请编辑 ${colors.bright}${envFileName}${colors.reset}`)
  }

  console.log('')
  console.log(`${colors.bright}${colors.yellow}━━━ 下一步 ━━━${colors.reset}`)
  console.log('')
  console.log(`本次已生成/更新：${colors.bright}${envFileName}${colors.reset}`)
  console.log('')

  if (envWriteTarget === ENV_LOCAL) {
    console.log(`${colors.cyan}本地开发${colors.reset}`)
    console.log(`  ${colors.bright}pnpm dev${colors.reset}  → http://localhost:5174`)
    console.log('')
    console.log(`${colors.dim}需要云托管配置时，再运行 ./init.sh 并选择 2) .env.cloud${colors.reset}`)
  } else {
    console.log(`${colors.cyan}云托管部署${colors.reset}`)
    console.log(`  ${colors.bright}pnpm deploy:cloud${colors.reset}  （ASK_USER_BASE_URL 占位可在首次部署后写回）`)
    console.log(`  若仍为占位，到控制台复制默认域名后改 ${colors.bright}.env.cloud${colors.reset} 再部署一次`)
    console.log('')
    console.log(`${colors.dim}需要本地开发时，再运行 ./init.sh 并选择 1) .env.local${colors.reset}`)
    console.log(`${colors.dim}deploy 只读 .env.cloud，与 .env.local 无关${colors.reset}`)
  }
  console.log('')
}

main().then(() => {
  closeReadline()
}).catch((error) => {
  closeReadline()
  console.error('初始化失败：', error)
  process.exit(1)
})
