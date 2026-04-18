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
import readline from 'readline'

// ===================== Constants =====================

const MIN_NODE_VERSION = 18
const ENV_FILE = resolve(process.cwd(), '.env.local')
const CLOUDBASE_AUTH_FILE = resolve(homedir(), '.config/.cloudbase/auth.json')

// ===================== Helper Functions =====================

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
    throw new Error(`Command failed: ${cmd}`)
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

// Shared readline state
let _rl = null

// Drain any leftover data in stdin buffer
function drainStdin() {
  return new Promise((resolve) => {
    if (process.stdin.readable) {
      process.stdin.resume()
      const drain = () => {
        while (process.stdin.read() !== null) { /* discard */ }
      }
      drain()
      // Give a tick for any pending data
      setTimeout(() => {
        drain()
        process.stdin.pause()
        resolve()
      }, 10)
    } else {
      resolve()
    }
  })
}

async function promptInput(prompt, hidden = false) {
  return new Promise(async (resolve) => {
    if (hidden) {
      // Close shared rl temporarily for raw mode
      if (_rl) { _rl.close(); _rl = null }
      await drainStdin()
      process.stdout.write(`${prompt}: `)
      process.stdin.setRawMode(true)
      process.stdin.resume()
      let password = ''
      const onData = (char) => {
        const c = char.toString('utf8')
        switch (c) {
          case '\n':
          case '\r':
          case '\u0004':
            process.stdin.setRawMode(false)
            process.stdin.pause()
            process.stdin.removeListener('data', onData)
            process.stdout.write('\n')
            resolve(password)
            break
          case '\u0003':
            process.exit()
            break
          default:
            if (c.charCodeAt(0) === 127) {
              password = password.slice(0, -1)
            } else {
              password += c
            }
            break
        }
      }
      process.stdin.on('data', onData)
    } else {
      // Close any existing rl to reset state
      if (_rl) { _rl.close(); _rl = null }
      await drainStdin()
      _rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      _rl.question(`${prompt}: `, (answer) => {
        _rl.close()
        _rl = null
        resolve(answer.trim())
      })
    }
  })
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

  // pnpm --version 失败 — 判断是签名/缓存错误还是真正未安装
  const errorOutput = result.output || ''
  const isSignatureError =
    errorOutput.includes('keyid') ||
    errorOutput.includes('signature') ||
    errorOutput.includes('Cannot find matching keyid') ||
    errorOutput.includes('verifySignature')

  if (isSignatureError) {
    log('pnpm 存在但 corepack 签名验证失败', 'warn')
    log('正在尝试修复 corepack 缓存...')
    try {
      runCommand('corepack disable && corepack enable')
      // 验证修复结果
      const verify = runCommandSafe('pnpm --version')
      if (verify.success) {
        log(`pnpm ${verify.output.trim()} 已恢复`, 'success')
        return true
      }
    } catch {
      // corepack disable/enable 失败，继续走安装流程
    }
    // 修复失败，引导用户手动处理或重新安装
    log('自动修复失败，将尝试重新安装 pnpm', 'warn')
  } else {
    log('pnpm 未安装', 'warn')
  }

  const install = await askYesNo('是否立即安装 pnpm？', true)
  if (!install) {
    log('本项目需要 pnpm', 'error')
    return false
  }

  log('正在通过 corepack 安装 pnpm...')
  try {
    runCommand('corepack enable && corepack prepare pnpm@latest --activate')
    log('pnpm 安装成功', 'success')
    return true
  } catch (error) {
    log('通过 corepack 安装失败，尝试使用 npm...', 'warn')
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
  logSection('检查 Docker')
  try {
    execSync('docker info', { stdio: 'pipe' })
    log('Docker 守护进程正在运行', 'success')
    return true
  } catch {
    log('Docker 未安装或未运行', 'error')
    log('请先安装并启动 Docker，然后重新运行 ./init.sh：', 'info')
    log('  brew install colima docker && colima start', 'info')
    log('  # 或从 https://www.docker.com/products/docker-desktop 下载 Docker Desktop', 'info')
    return false
  }
}

// ===================== TCR Setup =====================

function loadEnvFile() {
  const env = {}
  if (existsSync(ENV_FILE)) {
    const content = readFileSync(ENV_FILE, 'utf-8')
    content.split('\n').forEach((line) => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=')
        if (key) {
          env[key.trim()] = valueParts.join('=').trim()
        }
      }
    })
  }
  return env
}

function saveServerEnvVar(key, value) {
  const serverEnvFile = resolve(process.cwd(), 'packages/server/.env')
  const env = {}
  if (existsSync(serverEnvFile)) {
    readFileSync(serverEnvFile, 'utf-8').split('\n').forEach((line) => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [k, ...v] = trimmed.split('=')
        if (k) env[k.trim()] = v.join('=').trim()
      }
    })
  }

  if (env[key]) {
    const content = readFileSync(serverEnvFile, 'utf-8')
    const lines = content.split('\n')
    const newLines = lines.map((line) => {
      if (line.trim().startsWith(`${key}=`)) {
        return `${key}=${value}`
      }
      return line
    })
    writeFileSync(serverEnvFile, newLines.join('\n'))
  } else {
    const newline = Object.keys(env).length > 0 ? '\n' : ''
    const content = existsSync(serverEnvFile) ? readFileSync(serverEnvFile, 'utf-8') : ''
    writeFileSync(serverEnvFile, `${content}${newline}${key}=${value}`)
  }
}

function saveEnvVar(key, value) {
  const env = loadEnvFile()

  if (env[key]) {
    const content = readFileSync(ENV_FILE, 'utf-8')
    const lines = content.split('\n')
    const newLines = lines.map((line) => {
      if (line.trim().startsWith(`${key}=`)) {
        return `${key}=${value}`
      }
      return line
    })
    writeFileSync(ENV_FILE, newLines.join('\n'))
  } else {
    const newline = env && Object.keys(env).length > 0 ? '\n' : ''
    const content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf-8') : ''
    writeFileSync(ENV_FILE, `${content}${newline}${key}=${value}`)
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
  } catch {
    return null
  }
}

// ===================== Cloudbase CLI Helpers =====================

function isCloudbaseInstalled() {
  try {
    execSync('which cloudbase', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
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

    child.on('error', () => {
      resolve(false)
    })
  })
}

// In-memory store for TCB credentials (not persisted to .env.local)
const tcbConfig = {
  secretId: '',
  secretKey: '',
  token: '',
  envId: '',
  provisionMode: 'shared',
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

  const env = loadEnvFile()

  // Check server/.env for existing TCB config (already-configured state)
  const serverEnvFile = resolve(process.cwd(), 'packages/server/.env')
  const serverEnv = {}
  if (existsSync(serverEnvFile)) {
    readFileSync(serverEnvFile, 'utf-8').split('\n').forEach(line => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...rest] = trimmed.split('=')
        if (key) serverEnv[key.trim()] = rest.join('=').trim()
      }
    })
  }

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
      } catch {
        log('cloudbase CLI 登录失败，将继续尝试获取环境列表', 'warn')
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
      saveServerEnvVar('TCB_SECRET_ID', secretId)
      saveServerEnvVar('TCB_SECRET_KEY', secretKey)
      log('密钥已写入 packages/server/.env', 'success')

      // 使用永久密钥登录 cloudbase CLI
      log('正在使用永久密钥登录 cloudbase CLI...')
      try {
        execSync(`cloudbase login --apiKeyId "${secretId}" --apiKey "${secretKey}"`, {
          stdio: 'pipe',
          encoding: 'utf-8',
        })
        log('cloudbase CLI 登录成功', 'success')
      } catch (e) {
        log('cloudbase CLI 登录失败，请检查密钥是否正确', 'warn')
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
    output = execSync('cloudbase env list --json 2>/dev/null', {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    const parsed = JSON.parse(output)
    envList = (parsed.data || []).filter(e => e.status === 'NORMAL')
  } catch (e) {
    log(`无法从 cloudbase CLI 获取环境列表: ${e.message || output}`, 'warn')
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

  const serverEnvFile = resolve(process.cwd(), 'packages/server/.env')
  const existingServerEnv = {}
  if (existsSync(serverEnvFile)) {
    readFileSync(serverEnvFile, 'utf-8').split('\n').forEach(line => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...rest] = trimmed.split('=')
        if (key) existingServerEnv[key.trim()] = rest.join('=').trim()
      }
    })
  }

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
    console.log(`  ${colors.dim}3) 跳过，稍后自行在 packages/server/.env 中配置${colors.reset}`)
    console.log('')

    while (!codebuddyConfig.authMode) {
      const choice = await promptInput('请选择（1/2/3，回车默认选 1）')
      if (!choice || choice === '1') {
        codebuddyConfig.authMode = 'apikey'
      } else if (choice === '2') {
        codebuddyConfig.authMode = 'oauth'
      } else if (choice === '3') {
        log('已跳过，稍后请手动配置 packages/server/.env', 'info')
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

async function setupTcr() {
  logSection('配置 TCR（容器镜像服务）')

  const env = loadEnvFile()

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
      },
    })
    log('TCR 配置完成', 'success')
    return true
  } catch (error) {
    log('TCR 配置失败，可稍后手动执行。', 'warn')
    log('运行：node scripts/setup-tcr.mjs', 'info')
    return false
  }
}

async function setupEnv() {
  logSection('配置环境变量')

  if (existsSync(ENV_FILE)) {
    log('.env.local 已存在', 'success')
    return true
  }

  // Create minimal .env.local
  const envContent = `# Environment variables
# Generated by init script

# Session Encryption (auto-generated)
JWE_SECRET=${crypto.randomBytes(32).toString('base64')}
ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}

# Auth Providers
NEXT_PUBLIC_AUTH_PROVIDERS=local

# Rate Limiting
MAX_MESSAGES_PER_DAY=50
MAX_SANDBOX_DURATION=300
`

  writeFileSync(ENV_FILE, envContent)
  log('已创建 .env.local（使用默认值）', 'success')
  return true
}

// ===================== Server Environment =====================

async function setupServerEnv() {
  logSection('配置服务端环境变量')

  const env = loadEnvFile()
  const serverEnvFile = resolve(process.cwd(), 'packages/server/.env')

  // 读取已有的 server/.env（用于保留 CodeBuddy / Git Archive 等手动配置的值）
  const existingServerEnv = {}
  if (existsSync(serverEnvFile)) {
    readFileSync(serverEnvFile, 'utf-8').split('\n').forEach(line => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...rest] = trimmed.split('=')
        if (key) existingServerEnv[key.trim()] = rest.join('=').trim()
      }
    })

    const overwrite = await askYesNo('packages/server/.env 已存在，是否覆盖？（否则跳过此步骤）', true)
    if (!overwrite) {
      log('跳过服务端环境变量配置', 'info')
      return true
    }
  }

  // TCB config from in-memory tcbConfig (collected during setupCloudbaseConfig)
  // This avoids persisting TCB credentials to root .env.local
  const tcbKeyMap = {
    TCB_SECRET_ID: tcbConfig.secretId,
    TCB_SECRET_KEY: tcbConfig.secretKey,
    TCB_TOKEN: tcbConfig.token,
    TCB_ENV_ID: tcbConfig.envId,
    TCB_REGION: process.env.TCB_REGION || 'ap-shanghai',
    TCB_PROVISION_MODE: tcbConfig.provisionMode,
  }

  // 常规 key：tcbConfig 内存值 > root .env.local > process.env > fallback
  const get = (key, fallback = '') => (tcbKeyMap[key] !== undefined && tcbKeyMap[key] !== '') ? tcbKeyMap[key] : (env[key] || process.env[key] || fallback)

  // 保留型 key：优先读已有 server/.env，没有再用静态默认值
  const getPreserved = (key, fallback = '') => existingServerEnv[key] || fallback

  const jweSecret = get('JWE_SECRET')
  const encryptionKey = get('ENCRYPTION_KEY')

  if (!jweSecret || !encryptionKey) {
    log('.env.local 中缺少加密密钥', 'warn')
    return false
  }

  const serverEnv = `# Server Environment Configuration
# Generated by init script

# ==================== Required ====================

JWE_SECRET=${jweSecret}
ENCRYPTION_KEY=${encryptionKey}

# ==================== Server Configuration ====================

PORT=3001
NODE_ENV=development
DATABASE_PATH=.data/app.db

# ==================== Database Provider ====================

DB_PROVIDER=${getPreserved('DB_PROVIDER', 'cloudbase')}
DB_COLLECTION_PREFIX=${getPreserved('DB_COLLECTION_PREFIX', 'vibe_agent_')}

# ==================== Rate Limiting ====================

MAX_MESSAGES_PER_DAY=${get('MAX_MESSAGES_PER_DAY', '50')}
MAX_SANDBOX_DURATION=${get('MAX_SANDBOX_DURATION', '300')}

# ==================== Auth ====================

NEXT_PUBLIC_AUTH_PROVIDERS=${get('NEXT_PUBLIC_AUTH_PROVIDERS', 'local')}
# GitHub login approach: 'direct' (self-managed OAuth) or 'cloudbase' (CloudBase identity source)
AUTH_GITHUB_MODE=${get('AUTH_GITHUB_MODE', 'direct')}

# ==================== CloudBase ====================

TCB_ENV_ID=${get('TCB_ENV_ID')}
TCB_REGION=${get('TCB_REGION', 'ap-shanghai')}
TCB_SECRET_ID=${get('TCB_SECRET_ID')}
TCB_SECRET_KEY=${get('TCB_SECRET_KEY')}
TCB_TOKEN=${get('TCB_TOKEN')}
TCB_PROVISION_MODE=${get('TCB_PROVISION_MODE', 'shared')}

# ==================== CodeBuddy Auth ====================
# 认证方式: API Key（优先）或 OAuth（企业旗舰版）
# 设置 CODEBUDDY_API_KEY 后将跳过 OAuth 认证
${codebuddyConfig.authMode === 'apikey'
      ? `CODEBUDDY_API_KEY=${codebuddyConfig.apiKey}`
      : `# CODEBUDDY_API_KEY=`
    }${codebuddyConfig.internetEnv
      ? `\nCODEBUDDY_INTERNET_ENVIRONMENT=${codebuddyConfig.internetEnv}`
      : `\n# CODEBUDDY_INTERNET_ENVIRONMENT=internal   # 国内版填 internal, iOA 填 ioa`
    }
${codebuddyConfig.authMode === 'oauth'
      ? `\n# --- OAuth 配置（当前已配置 API Key，OAuth 不生效）---\nCODEBUDDY_CLIENT_ID=${codebuddyConfig.clientId}\nCODEBUDDY_CLIENT_SECRET=${codebuddyConfig.clientSecret}\nCODEBUDDY_OAUTH_ENDPOINT=${codebuddyConfig.oauthEndpoint}`
      : `\n# --- OAuth 配置（企业旗舰版，API Key 优先时此项不生效）---\n# CODEBUDDY_CLIENT_ID=\n# CODEBUDDY_CLIENT_SECRET=\n# CODEBUDDY_OAUTH_ENDPOINT=https://copilot.tencent.com/oauth2/token`
    }

GIT_ARCHIVE_REPO=${getPreserved('GIT_ARCHIVE_REPO')}
GIT_ARCHIVE_USER=${getPreserved('GIT_ARCHIVE_USER')}
GIT_ARCHIVE_TOKEN=${getPreserved('GIT_ARCHIVE_TOKEN')}

# ==================== SCF Sandbox ====================

SCF_SANDBOX_IMAGE_TYPE=${get('SCF_SANDBOX_IMAGE_TYPE', 'personal')}
SCF_SANDBOX_IMAGE_URI=${get('TCR_IMAGE')}
SCF_SANDBOX_IMAGE_ACCELERATE=${get('SCF_SANDBOX_IMAGE_ACCELERATE', 'false')}
SCF_SANDBOX_IMAGE_PORT=${get('SCF_SANDBOX_IMAGE_PORT', '9000')}
SCF_SANDBOX_TEST_URL=${get('SCF_SANDBOX_TEST_URL')}

# ==================== GitHub OAuth (Optional) ====================

# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=

# ==================== Proxy (Optional) ====================

# http_proxy=
`

  writeFileSync(serverEnvFile, serverEnv)
  log('服务端配置已写入 packages/server/.env', 'success')
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

  // Step 3: Setup environment (.env.local)
  if (!(await setupEnv())) {
    process.exit(1)
  }

  // Step 4: Check Docker (required for TCR image push)
  if (!checkDocker()) {
    process.exit(1)
  }

  // Step 5: CloudBase configuration (TCB_ENV_ID + token)
  if (!(await setupCloudbaseConfig())) {
    process.exit(1)
  }

  // Step 6: Setup Server Environment
  if (!(await setupServerEnv())) {
    process.exit(1)
  }

  // Step 7: Install dependencies (setup-tcr.mjs needs tencentcloud-sdk-nodejs)
  if (!(await installDependencies())) {
    process.exit(1)
  }

  // Step 8: CodeBuddy auth configuration
  await setupCodebuddy()

  // Step 9: Setup TCR (requires node_modules)
  logSection('TCR 配置')
  if (!(await setupTcr())) {
    process.exit(1)
  }

  // Step 10: Initialize database
  logSection('初始化数据库')
  const serverEnvPath = resolve(process.cwd(), 'packages/server/.env')
  const serverEnvVars = existsSync(serverEnvPath)
    ? readFileSync(serverEnvPath, 'utf-8').split('\n').reduce((acc, line) => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...rest] = trimmed.split('=')
        if (key) acc[key.trim()] = rest.join('=').trim()
      }
      return acc
    }, {})
    : {}

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

  // Step 11: Install Skills
  logSection('安装 Skills')
  const installSkillsResult = runCommandSafe('sh scripts/install-skills.sh')
  if (installSkillsResult.success) {
    log('Skills 安装完成', 'success')
  } else {
    log('Skills 安装失败（可选步骤，不影响启动）', 'warn')
    log('可手动运行: sh scripts/install-skills.sh', 'info')
  }

  // Done!
  console.log('')
  console.log(`${colors.bright}${colors.green}╔══════════════════════════════════════════════╗${colors.reset}`)
  console.log(`${colors.bright}${colors.green}║           ✅ 初始化完成！                   ║${colors.reset}`)
  console.log(`${colors.bright}${colors.green}╚══════════════════════════════════════════════╝${colors.reset}`)
  console.log('')

  if (codebuddyConfig.authMode) {
    console.log(`${colors.green}✓${colors.reset} CodeBuddy 认证已配置（${codebuddyConfig.authMode === 'apikey' ? 'API Key' : 'OAuth'}）`)
  } else {
    console.log(`${colors.yellow}!${colors.reset} CodeBuddy 认证未配置，启动前请编辑 ${colors.bright}packages/server/.env${colors.reset}`)
  }

  console.log('')
  console.log(`${colors.bright}${colors.yellow}━━━ 启动前请确认 ━━━${colors.reset}`)
  console.log('')
  console.log(`打开 ${colors.bright}packages/server/.env${colors.reset} 确认以下配置：`)
  console.log('')
  console.log(`  ${colors.bright}CodeBuddy 认证${colors.reset} — API Key 或 OAuth 二选一`)
  console.log(`  ${colors.dim}CODEBUDDY_API_KEY=              # API Key（设置后优先，推荐）${colors.reset}`)
  console.log(`  ${colors.dim}CODEBUDDY_INTERNET_ENVIRONMENT= # 国内版填 internal, iOA 填 ioa${colors.reset}`)
  console.log(`  ${colors.dim}CODEBUDDY_CLIENT_ID=            # OAuth Client ID（企业旗舰版）${colors.reset}`)
  console.log(`  ${colors.dim}CODEBUDDY_CLIENT_SECRET=        # OAuth Client Secret${colors.reset}`)
  console.log('')
  console.log(`  ${colors.bright}Git Archive (CNB)${colors.reset} — 用于工作区 git 归档`)
  console.log(`  ${colors.dim}GIT_ARCHIVE_REPO=   # 例如 https://cnb.cool/<org>/<repo>${colors.reset}`)
  console.log(`  ${colors.dim}GIT_ARCHIVE_USER=   # 你的 CNB 用户名${colors.reset}`)
  console.log(`  ${colors.dim}GIT_ARCHIVE_TOKEN=  # 个人访问令牌${colors.reset}`)
  console.log('')
  console.log(`  ${colors.cyan}→ 在以下地址创建仓库和令牌：https://cnb.cool${colors.reset}`)
  console.log(`  ${colors.dim}  1. 新建一个用于工作区归档的仓库${colors.reset}`)
  console.log(`  ${colors.dim}  2. 进入「设置」→「访问令牌」→「新建令牌」（需读写权限）${colors.reset}`)
  console.log('')
  console.log(`${colors.cyan}━━━ 开发模式 ━━━${colors.reset}`)
  console.log('')
  console.log(`  ${colors.bright}pnpm dev${colors.reset}`)
  console.log('')
  console.log(`${colors.dim}同时启动前端（端口 5174）和服务端（端口 3001）${colors.reset}`)
  console.log(`${colors.dim}在浏览器中打开 http://localhost:5174${colors.reset}`)
  console.log('')
  console.log(`${colors.cyan}━━━ 生产模式 ━━━${colors.reset}`)
  console.log('')
  console.log(`  ${colors.bright}pnpm build${colors.reset}   ${colors.dim}# 构建前端和服务端${colors.reset}`)
  console.log(
    `  ${colors.bright}pnpm start${colors.reset}   ${colors.dim}# 启动服务端（同时托管静态文件）${colors.reset}`,
  )
  console.log('')
  console.log(`${colors.dim}服务端运行在端口 3001，提供 API 及静态文件服务${colors.reset}`)
  console.log('')
  console.log(`${colors.cyan}━━━ 其他命令 ━━━${colors.reset}`)
  console.log('')
  console.log(`${colors.dim}  pnpm dev:web     - 仅启动前端${colors.reset}`)
  console.log(`${colors.dim}  pnpm dev:server  - 仅启动服务端${colors.reset}`)
  console.log(`${colors.dim}  pnpm lint        - 运行代码检查${colors.reset}`)
  console.log(`${colors.dim}  pnpm type-check  - 检查 TypeScript 类型${colors.reset}`)
  console.log('')
}

main().then(() => {
  if (_rl) _rl.close()
}).catch((error) => {
  if (_rl) _rl.close()
  console.error('初始化失败：', error)
  process.exit(1)
})
