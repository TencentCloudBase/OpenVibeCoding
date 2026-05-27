#!/usr/bin/env node

/**
 * TCR Setup Script
 *
 * This script initializes Tencent Cloud Container Registry (TCR) Personal Edition
 * or configures an existing TCR Enterprise Edition instance and pushes images to it.
 * It handles:
 * 1. Automatic cloudbase CLI installation (if needed)
 * 2. Automatic cloudbase login (if needed)
 * 3. Environment variable validation and generation
 * 4. TCR edition selection (Personal / Enterprise)
 * 5. TCR Personal Edition initialization or Enterprise instance configuration
 * 6. Namespace creation with random suffix
 * 7. Docker login and image push
 *
 * Credentials can be obtained from:
 * - cloudbase-cli login state (temporary credentials, for local development)
 * - Permanent API keys (for production deployment)
 */

import { execSync, spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import crypto from 'crypto'
import { promptInput } from './lib/prompt.mjs'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// Use require for tencentcloud-sdk-nodejs due to ESM/CJS compatibility
const tencentcloud = require('tencentcloud-sdk-nodejs')

// ===================== Constants =====================

const TCR_PERSONAL_DOMAIN = 'ccr.ccs.tencentyun.com'
const TCR_EDITION_PERSONAL = 'personal'
const TCR_EDITION_ENTERPRISE = 'enterprise'

// Resolve docker-compatible CLI: prefer docker, fallback to podman
function resolveDockerCmd() {
  try {
    execSync('docker info', { stdio: 'pipe' })
    return 'docker'
  } catch {
    // docker not available
  }

  // Try podman — if machine is stopped/disconnected, attempt to start it
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execSync('podman info', { stdio: 'pipe' })
      try {
        const socket = execSync('podman machine inspect --format "{{.ConnectionInfo.PodmanSocket.Path}}"', { stdio: 'pipe' }).toString().trim()
        if (socket && !process.env.DOCKER_HOST) {
          process.env.DOCKER_HOST = `unix://${socket}`
        }
      } catch {
        // native Linux podman, no machine needed
      }
      return 'podman'
    } catch {
      if (attempt === 0) {
        // podman info failed — try starting the machine and retry once
        try {
          execSync('podman machine start', { stdio: 'pipe' })
        } catch {
          // machine may already be running but SSH is broken — try stop+start
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

  return null
}

const DOCKER_CMD = resolveDockerCmd()
const ENV_FILE = resolve(process.cwd(), '.env.local')
const ENV_LOCAL_FILE = resolve(process.cwd(), '.env.local')
const CLOUDBASE_AUTH_FILE = resolve(homedir(), '.config/.cloudbase/auth.json')
const DEFAULT_NAMESPACE_PREFIX = 'cloudbase-vibecoding'
// docker.io/yhyanghang/cloudbase-workspace:260515-0120e18d
const GHCR_IMAGE_URL = 'ghcr.io/yhsunshining/cloudbase-workspace:260515-01342a05'

const IS_WINDOWS = process.platform === 'win32'

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

// ===================== Helper Functions =====================

function log(message, type = 'info') {
  const prefix = {
    info: '→',
    success: '✓',
    error: '✗',
    warn: '!',
  }[type]
  console.log(`${prefix} ${message}`)
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

function generatePassword() {
  // Generate a password that meets TCR requirements:
  // 8-16 characters, includes uppercase, lowercase, numbers, and special characters
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lowercase = 'abcdefghijklmnopqrstuvwxyz'
  const numbers = '0123456789'
  const special = '!@#$%^&*'

  const all = uppercase + lowercase + numbers + special

  let password = ''
  // Ensure at least one of each type (4 chars)
  password += uppercase[Math.floor(Math.random() * uppercase.length)]
  password += lowercase[Math.floor(Math.random() * lowercase.length)]
  password += numbers[Math.floor(Math.random() * numbers.length)]
  password += special[Math.floor(Math.random() * special.length)]

  // Fill rest with random characters (6 more = 10 total, within 8-16 range)
  for (let i = 0; i < 6; i++) {
    password += all[Math.floor(Math.random() * all.length)]
  }

  // Shuffle password
  return password
    .split('')
    .sort(() => Math.random() - 0.5)
    .join('')
}

/**
 * Generate a 6-character random suffix for namespace
 */
function generateNamespaceSuffix() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 6; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return suffix
}

function isResourceConflict(error) {
  const code = error?.code || ''
  const message = error?.message || ''
  return (
    code === 'ResourceInUse' ||
    code === 'FailedOperation.AlreadyExists' ||
    code.includes('ResourceConflict') ||
    message.includes('already') ||
    message.includes('exist') ||
    message.includes('ResourceConflict')
  )
}

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

/** Mirror TCR image URI into .env.local for first-time CreateSandboxTool. */
function syncStatefulSandboxImageToServer(tcrImage) {
  if (!existsSync(ENV_LOCAL_FILE)) {
    log('.env.local not found; skip STATEFUL_SANDBOX_IMAGE sync', 'warn')
    return
  }
  const key = 'STATEFUL_SANDBOX_IMAGE'
  const content = readFileSync(ENV_LOCAL_FILE, 'utf-8')
  const line = `${key}=${tcrImage}`
  const lines = content.split('\n')
  let replaced = false
  const newLines = lines.map((row) => {
    const t = row.trim()
    if (t.startsWith(`${key}=`) || t.startsWith(`# ${key}=`)) {
      replaced = true
      return line
    }
    return row
  })
  if (!replaced) {
    const marker = '# Stateful sandbox'
    const idx = newLines.findIndex((row) => row.includes('STATEFUL') || row.includes('Stateful sandbox'))
    if (idx >= 0) {
      newLines.splice(idx + 1, 0, line)
    } else {
      newLines.push('', line)
    }
  }
  writeFileSync(ENV_LOCAL_FILE, newLines.join('\n'))
  log('STATEFUL_SANDBOX_IMAGE synced to .env.local', 'success')
}

function saveEnvVar(key, value) {
  const env = loadEnvFile()

  if (env[key]) {
    // Update existing value
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
    // Append new value
    appendFileSync(ENV_FILE, `\n${key}=${value}`)
  }
}

/**
 * Ask user yes/no question
 */
async function askYesNo(prompt, defaultValue = false) {
  const hint = defaultValue ? '[Y/n]' : '[y/N]'
  const answer = await promptInput(`${prompt} ${hint}`)
  if (!answer) return defaultValue
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
}

// ===================== Cloudbase CLI Functions =====================

/**
 * Check if cloudbase CLI is installed
 */
function isCloudbaseInstalled() {
  return commandExists('cloudbase')
}

/**
 * Install cloudbase CLI globally
 */
async function installCloudbase() {
  log('Installing cloudbase CLI...')

  try {
    execSync('npm install -g @cloudbase/cli', { stdio: 'inherit' })
    log('cloudbase CLI 安装成功', 'success')
    return true
  } catch (error) {
    log('Failed to install cloudbase CLI', 'error')
    return false
  }
}

/**
 * Run cloudbase login interactively
 * This will open a browser for user to authorize
 */
async function runCloudbaseLogin() {
  log('Running cloudbase login...')
  log('Please complete the login in your browser...', 'info')

  return new Promise((resolve) => {
    // Use spawn to run cloudbase login interactively
    const child = spawn('cloudbase', ['login'], {
      stdio: 'inherit',
      shell: true,
    })

    child.on('close', (code) => {
      if (code === 0) {
        log('cloudbase login completed', 'success')
        resolve(true)
      } else {
        log('cloudbase login exited with non-zero code', 'error')
        resolve(false)
      }
    })

    child.on('error', (error) => {
      log('Failed to run cloudbase login', 'error')
      resolve(false)
    })
  })
}

/**
 * Get credentials from cloudbase-cli login state
 * This allows using temporary credentials from `cloudbase login`
 */
function getCloudbaseCredential() {
  if (!existsSync(CLOUDBASE_AUTH_FILE)) {
    return null
  }

  try {
    const content = readFileSync(CLOUDBASE_AUTH_FILE, 'utf-8')
    const auth = JSON.parse(content)

    // Check if credential exists and not expired
    if (!auth.credential?.tmpSecretId || !auth.credential?.tmpSecretKey) {
      return null
    }

    // Check expiration (tmpExpired is in milliseconds)
    const now = Date.now()
    if (auth.credential.tmpExpired && now > auth.credential.tmpExpired) {
      log('Cloudbase credential has expired', 'warn')
      return null
    }

    return auth
  } catch (error) {
    log('Failed to read cloudbase credential', 'warn')
    return null
  }
}

/**
 * 从 cloudbase auth.json 读取账号 uin（不区分临时/永久凭证）
 * 永久密钥登录时 auth.json 不含 uin，回退到 STS.GetCallerIdentity 查询
 * 返回 { accountId: 主账号AppID, callerUin: 当前调用者Uin } 或 null
 * auth.json 路径无法获取 callerUin，只有 STS 路径才有
 */
async function getCloudbaseAccountId(secretId, secretKey) {
  // 1. 有永久密钥时优先走 STS，能准确区分主/子账号
  if (secretId && secretKey) {
    try {
      const StsClient = tencentcloud.sts.v20180813.Client
      const stsClient = new StsClient({
        credential: { secretId, secretKey },
        region: 'ap-guangzhou',
        profile: { httpProfile: { endpoint: 'sts.tencentcloudapi.com' } },
      })
      const resp = await stsClient.GetCallerIdentity({})
      if (resp?.AccountId) {
        // 主账号时 AccountId == Uin；子账号时 Uin 是子账号 UIN，AccountId 是主账号 AppID
        return { accountId: resp.AccountId, callerUin: resp.Uin || '' }
      }
    } catch {
      // ignore API errors, fall through to auth.json
    }
  }

  // 2. 兜底：从 auth.json 读取（临时凭证登录场景）
  if (existsSync(CLOUDBASE_AUTH_FILE)) {
    try {
      const content = readFileSync(CLOUDBASE_AUTH_FILE, 'utf-8')
      const auth = JSON.parse(content)
      if (auth.credential?.uin) {
        // auth.json 里的 uin 是登录者 UIN（可能是主账号也可能是子账号）
        // 无法区分，统一作为 callerUin 使用
        return { accountId: '', callerUin: auth.credential.uin }
      }
    } catch {
      // ignore parse errors
    }
  }

  return null
}

/**
 * Ensure cloudbase CLI is installed and user is logged in
 */
async function ensureCloudbaseAuth(skipLogin = false) {
  // Step 1: Check if cloudbase CLI is installed
  if (!isCloudbaseInstalled()) {
    log('未找到 cloudbase CLI', 'warn')
    const installed = await installCloudbase()
    if (!installed) {
      return null
    }
  } else {
    log('cloudbase CLI 已安装', 'success')
  }

  // Step 2: Check if already logged in
  let credential = getCloudbaseCredential()

  if (credential) {
    log('Found valid cloudbase credentials', 'success')
    return credential
  }

  // Step 3: If not logged in, run login (unless skipped)
  if (skipLogin) {
    log('Cloudbase login skipped', 'warn')
    return null
  }

  log('未找到有效的 cloudbase 凭证', 'warn')
  const loginSuccess = await runCloudbaseLogin()

  if (!loginSuccess) {
    return null
  }

  // Step 4: Get credentials after login
  credential = getCloudbaseCredential()
  return credential
}

// ===================== TCR SDK Functions =====================

const TcrClient = tencentcloud.tcr.v20190924.Client

function createTcrClient(secretId, secretKey, region, token) {
  const credential = {
    secretId,
    secretKey,
  }

  // Add token for temporary credentials
  if (token) {
    credential.token = token
  }

  return new TcrClient({
    credential,
    region,
    profile: {
      httpProfile: {
        endpoint: 'tcr.tencentcloudapi.com',
      },
    },
  })
}

/**
 * Check if TCR Personal Edition user already exists
 */
async function checkUserExists(client) {
  try {
    // DescribeUserPersonal will succeed if user exists
    await client.DescribeUserPersonal({})
    return true
  } catch (error) {
    // If user doesn't exist, it will return an error
    if (error.code === 'ResourceNotFound' || error.message?.includes('not found')) {
      return false
    }
    // For other errors, assume user exists (let other operations handle the error)
    return true
  }
}

/**
 * Initialize TCR Personal Edition with password
 * Returns true if successful, false otherwise
 * Returns 'exists' if user already exists
 */
async function initTcrPersonal(client, password) {
  log('Initializing TCR Personal Edition...')

  try {
    await client.CreateUserPersonal({
      Password: password,
    })
    log('TCR Personal Edition initialized successfully', 'success')
    return { success: true, userExists: false }
  } catch (error) {
    if (error.code === 'ResourceInUse' || error.message?.includes('already')) {
      log('TCR Personal Edition user already exists', 'warn')
      return { success: true, userExists: true }
    }
    log('Failed to initialize TCR Personal Edition', 'error')
    return { success: false, userExists: false }
  }
}

/**
 * List all namespaces for the user
 */
async function listNamespaces(client, prefix) {
  try {
    const result = await client.DescribeNamespacePersonal({
      Namespace: prefix || '',
      Limit: 100,
      Offset: 0,
    })
    return (result?.Data?.NamespaceInfo || []).map((ns) => ({ Namespace: ns.Namespace }))
  } catch (error) {
    log('Failed to list namespaces', 'warn')
    return []
  }
}

/**
 * Find namespace by prefix
 */
async function findNamespaceByPrefix(client, prefix) {
  const namespaces = await listNamespaces(client, prefix)
  const found = namespaces.find((ns) => ns.Namespace.startsWith(prefix))
  return found?.Namespace || null
}

/**
 * Create namespace with random suffix
 * Returns the full namespace name
 */
async function createNamespaceWithSuffix(client, prefix, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    const suffix = generateNamespaceSuffix()
    const namespace = `${prefix}-${suffix}`

    log(`Creating namespace '${namespace}'...`)

    try {
      await client.CreateNamespacePersonal({
        Namespace: namespace,
      })
      log(`Namespace '${namespace}' created successfully`, 'success')
      return namespace
    } catch (error) {
      if (error.code?.startsWith('LimitExceeded')) {
        log('Namespace limit reached', 'error')
        log('Please delete an existing namespace at: https://console.cloud.tencent.com/tcr/namespace', 'info')
        return null
      }
      if (isResourceConflict(error)) {
        log(`Namespace '${namespace}' already taken globally, trying another suffix...`, 'warn')
        continue
      }
      log('Failed to create namespace', 'error')
      return null
    }
  }

  log('Failed to create namespace after multiple attempts', 'error')
  return null
}

/**
 * Reset TCR password for existing user
 * Note: TCR Personal Edition doesn't have a reset password API
 * Users need to reset password through Tencent Cloud Console
 */
async function resetTcrPassword(_client, _password) {
  log('TCR Personal Edition does not support resetting password via API.', 'error')
  log('Please reset your password at:', 'info')
  log('  https://console.cloud.tencent.com/tcr', 'info')
  return false
}

/**
 * List namespaces in TCR Enterprise Edition instance
 */
async function listNamespacesEnterprise(client, registryId, prefix) {
  try {
    const result = await client.DescribeNamespaces({
      RegistryId: registryId,
      NamespaceName: prefix || '',
      Limit: 100,
      Offset: 0,
    })
    const namespaces = result?.NamespaceList || result?.Data?.NamespaceList || []
    return namespaces
      .map((ns) => ns.Name || ns.NamespaceName || ns.Namespace)
      .filter(Boolean)
      .map((namespace) => ({ Namespace: namespace }))
  } catch (error) {
    log('Failed to list enterprise namespaces', 'warn')
    return []
  }
}

/**
 * Find enterprise namespace by prefix
 */
async function findNamespaceByPrefixEnterprise(client, registryId, prefix) {
  const namespaces = await listNamespacesEnterprise(client, registryId, prefix)
  const found = namespaces.find((ns) => ns.Namespace.startsWith(prefix))
  return found?.Namespace || null
}

/**
 * Create enterprise namespace with random suffix
 */
async function createNamespaceEnterpriseWithSuffix(client, registryId, prefix, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    const suffix = generateNamespaceSuffix()
    const namespace = `${prefix}-${suffix}`

    log('Creating enterprise namespace...')

    try {
      await client.CreateNamespace({
        RegistryId: registryId,
        NamespaceName: namespace,
        IsPublic: false,
      })
      log('Enterprise namespace created successfully', 'success')
      return namespace
    } catch (error) {
      if (error.code?.startsWith('LimitExceeded')) {
        log('Namespace limit reached', 'error')
        log('Please delete an existing namespace in the TCR Enterprise console', 'info')
        return null
      }
      if (isResourceConflict(error)) {
        log('Enterprise namespace already exists, trying another suffix...', 'warn')
        continue
      }
      log('Failed to create enterprise namespace', 'error')
      return null
    }
  }

  log('Failed to create enterprise namespace after multiple attempts', 'error')
  return null
}

function extractRepositoryList(result) {
  return (
    result?.RepositoryList ||
    result?.RepositoryInfoList ||
    result?.Data?.RepositoryList ||
    result?.Data?.RepositoryInfoList ||
    []
  )
}

/**
 * Ensure repository exists in TCR Enterprise Edition
 */
async function ensureRepositoryEnterprise(client, registryId, namespace, repoName) {
  try {
    const result = await client.DescribeRepositories({
      RegistryId: registryId,
      NamespaceName: namespace,
      RepositoryName: repoName,
      Limit: 100,
      Offset: 0,
    })
    const repositories = extractRepositoryList(result)
    const found = repositories.some((repo) => {
      const name = repo.Name || repo.RepositoryName || repo.RepoName
      return name === repoName || name === `${namespace}/${repoName}`
    })
    if (found) {
      log('Enterprise repository already exists', 'success')
      return true
    }
  } catch (error) {
    log('Failed to check enterprise repository, will try to create it', 'warn')
  }

  try {
    await client.CreateRepository({
      RegistryId: registryId,
      NamespaceName: namespace,
      RepositoryName: repoName,
    })
    log('Enterprise repository created successfully', 'success')
    return true
  } catch (error) {
    if (isResourceConflict(error)) {
      log('Enterprise repository already exists', 'success')
      return true
    }
    log('Failed to create enterprise repository', 'error')
    return false
  }
}

/**
 * Create long-term token for TCR Enterprise Edition docker login
 */
async function createInstanceTokenLongterm(client, registryId) {
  try {
    const result = await client.CreateInstanceToken({
      RegistryId: registryId,
      TokenType: 'longterm',
      Desc: 'cloudbase-vibecoding',
    })
    const username = result?.Username || result?.Data?.Username
    const token = result?.Token || result?.Data?.Token
    const tokenId = result?.TokenId || result?.Data?.TokenId
    if (!username || !token) {
      log('TCR Enterprise token response is incomplete', 'error')
      return null
    }
    return { username, token, tokenId }
  } catch (error) {
    log('Failed to create TCR Enterprise instance token', 'error')
    return null
  }
}

// ===================== Docker Functions =====================

function checkDocker() {
  return DOCKER_CMD !== null
}

function dockerLoginOnce(domain, username, password) {
  if (!DOCKER_CMD) return false
  try {
    runCommand(`echo '${password}' | ${DOCKER_CMD} login ${domain} --username ${username} --password-stdin`, true)
    return true
  } catch {
    return false
  }
}

async function dockerLogin(domain, username, password, options = {}) {
  const { allowPromptRetry = true, enterprise = false } = options
  if (!DOCKER_CMD) {
    log('Docker / Podman 未安装或未运行', 'error')
    return { success: false, username, password }
  }
  log(`Logging in to TCR registry via ${DOCKER_CMD}...`)

  if (dockerLoginOnce(domain, username, password)) {
    log('Login successful', 'success')
    return { success: true, username, password }
  }

  log('Login failed', 'error')
  if (!allowPromptRetry) {
    return { success: false, username, password }
  }

  console.log('')
  console.log('  TCR 登录失败，可能原因：')
  if (enterprise) {
    console.log('  1. 密码或 token 不正确')
    console.log('  2. 企业版用户名不正确（请使用实例登录用户名或 token 返回的 Username）')
  } else {
    console.log('  1. 密码不正确（可前往控制台重置：https://console.cloud.tencent.com/tcr/?rid=1）')
    console.log('  2. 用户名不正确（主账号用 AppID，子账号用子账号 UIN）')
    console.log('     如果是子账号重置了 TCR 密码，请输入该子账号的腾讯云 UIN 作为用户名')
  }
  console.log(`  当前使用的用户名：${username}`)
  console.log('')

  for (let attempt = 1; attempt <= 3; attempt++) {
    const newUsername = await promptInput(`TCR 用户名（直接回车保持 ${username}）`)
    const finalUsername = newUsername.trim() || username

    const newPassword = await promptInput(`TCR 密码（第 ${attempt}/3 次）`, true)
    if (!newPassword) continue

    if (dockerLoginOnce(domain, finalUsername, newPassword)) {
      log('Login successful', 'success')
      saveEnvVar(enterprise ? 'TCR_DOCKER_USERNAME' : 'TCR_USERNAME', finalUsername)
      saveEnvVar('TCR_PASSWORD', newPassword)
      log('用户名和密码已保存到 .env.local', 'info')
      return { success: true, username: finalUsername, password: newPassword }
    }
    log('登录失败，请重试', 'error')
  }

  log('登录失败，已超过最大重试次数', 'error')
  return { success: false, username, password }
}

function pullImage(image) {
  log(`Pulling image '${image}'...`)

  try {
    runCommand(`${DOCKER_CMD} pull ${image}`)
    log(`Image pulled successfully`, 'success')
    return true
  } catch (error) {
    log(`Failed to pull image`, 'error')
    return false
  }
}

function tagImage(sourceImage, targetImage) {
  log(`Tagging image '${sourceImage}' -> '${targetImage}'...`)

  try {
    runCommand(`${DOCKER_CMD} tag ${sourceImage} ${targetImage}`, true)
    log('Image tagged successfully', 'success')
    return true
  } catch (error) {
    log('Failed to tag image', 'error')
    return false
  }
}

function pushImage(image) {
  log(`Pushing image '${image}'...`)

  try {
    runCommand(`${DOCKER_CMD} push ${image}`)
    log(`Image pushed successfully`, 'success')
    return true
  } catch (error) {
    log('Failed to push image', 'error')
    return false
  }
}

// ===================== Setup Functions =====================

/**
 * 询问用户是否使用永久密钥，如有则保存并用其登录 cloudbase CLI
 * 永久密钥优先级最高：无需 token，不会过期
 */
async function setupPermanentKey(config) {
  const env = loadEnvFile()

  // 优先使用 process.env 传入的凭证（由 init.mjs 通过环境变量传入）
  const envId = process.env.TCB_SECRET_ID || ''
  const envKey = process.env.TCB_SECRET_KEY || ''
  const envToken = process.env.TCB_TOKEN || ''

  if (envId && envKey) {
    log('使用传入的凭证', 'success')
    config.secretId = envId
    config.secretKey = envKey
    config.accountId = process.env.TENCENTCLOUD_ACCOUNT_ID || config.accountId
    if (envToken) {
      config.token = envToken
      config.isTemporaryCredential = true
    } else {
      config.isTemporaryCredential = false
    }

    // 如果缺少 accountId，尝试从 cloudbase auth.json 获取
    if (!config.accountId) {
      const result = await getCloudbaseAccountId(config.secretId, config.secretKey)
      if (result) {
        config.accountId = result.accountId
        if (result.callerUin) config.callerUin = result.callerUin
      }
    }

    return true
  }

  // 其次检查 .env.local 中的永久密钥（非临时，即没有 token）
  const savedId = env['TCB_SECRET_ID'] || ''
  const savedKey = env['TCB_SECRET_KEY'] || ''
  const savedToken = env['TCB_TOKEN'] || ''

  if (savedId && savedKey && !savedToken) {
    log('已读取到永久密钥，跳过密钥询问', 'success')
    config.secretId = savedId
    config.secretKey = savedKey
    config.accountId = env['TENCENTCLOUD_ACCOUNT_ID'] || config.accountId
    config.isTemporaryCredential = false
    return true
  }

  // 询问是否输入永久密钥
  console.log('')
  console.log('━━━ 腾讯云永久密钥（可选）━━━')
  console.log('')
  console.log('  永久密钥无需 Token、不会过期，推荐用于本地开发。')
  console.log('  获取方式：登录腾讯云控制台 → 访问管理 → API 密钥管理')
  console.log('  https://console.cloud.tencent.com/cam/capi')
  console.log('')
  console.log('  如暂不填写，将使用 cloudbase login 临时凭证（按 Enter 跳过）。')
  console.log('')

  const secretId = await promptInput('SecretId（AKID 开头，回车跳过）')
  if (!secretId) {
    log('跳过永久密钥，将使用 cloudbase 临时凭证', 'info')
    return false
  }

  const secretKey = await promptInput('SecretKey', true)
  if (!secretKey) {
    log('SecretKey 不能为空，跳过永久密钥', 'warn')
    return false
  }

  // 保存到 .env.local（清除旧的 token，避免混用）
  saveEnvVar('TCB_SECRET_ID', secretId)
  saveEnvVar('TCB_SECRET_KEY', secretKey)
  saveEnvVar('TCB_TOKEN', '')
  log('永久密钥已保存到 .env.local', 'success')

  // 用永久密钥登录 cloudbase CLI
  log('正在使用永久密钥登录 cloudbase CLI...')
  try {
    execSync(`cloudbase login --apiKeyId "${secretId}" --apiKey "${secretKey}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    log('cloudbase CLI 登录成功', 'success')
  } catch (e) {
    log('cloudbase CLI 登录失败，请检查密钥是否正确', 'warn')
    log(e.stderr || e.message || '', 'warn')
  }

  config.secretId = secretId
  config.secretKey = secretKey
  config.isTemporaryCredential = false

  // 获取账号 ID（从 auth.json 刷新，登录后会更新）
  const idResult = await getCloudbaseAccountId(config.secretId, config.secretKey)
  if (idResult) {
    config.accountId = idResult.accountId
    if (idResult.callerUin) config.callerUin = idResult.callerUin
    saveEnvVar('TENCENTCLOUD_ACCOUNT_ID', idResult.accountId)
    log(`账号 ID：${idResult.accountId}`, 'info')
    if (idResult.callerUin) log(`子账号 Uin：${idResult.callerUin}`, 'info')
  } else {
    log('未能自动获取账号 ID', 'warn')
  }

  return true
}

async function validateAndPrepareEnv(config) {
  log('正在验证凭证...')

  const env = loadEnvFile()

  // Step 1: Try command line arguments / setupPermanentKey results
  if (config.secretId && config.secretKey) {
    if (!config.accountId) {
      // accountId 不是 API 鉴权必需，但 Docker login 需要，尝试从 env/.env.local 补充
      config.accountId = env['TENCENTCLOUD_ACCOUNT_ID'] || ''
    }
    log('使用已有凭证', 'success')
    return true
  }

  // Step 2: Try cloudbase-cli auth.json (preferred for temporary credentials, includes token)
  if (!config.skipCloudbaseLogin) {
    const cloudbaseCred = await ensureCloudbaseAuth(false)
    if (cloudbaseCred) {
      config.secretId = cloudbaseCred.credential.tmpSecretId
      config.secretKey = cloudbaseCred.credential.tmpSecretKey
      config.token = cloudbaseCred.credential.tmpToken
      config.accountId = cloudbaseCred.credential.uin
      config.isTemporaryCredential = true
      log('使用 cloudbase 临时凭证登录', 'success')
      log('已获取账号 ID', 'info')
      return true
    }
  }

  // Step 3: Try explicit environment variables + session token
  // Note: token is only read from process.env (not .env.local) to avoid persisting stale tokens
  if (!config.secretId) {
    const envValue = process.env.TCB_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || env['TCB_SECRET_ID'] || env['TENCENTCLOUD_SECRET_ID']
    if (envValue) config.secretId = envValue
  }
  if (!config.secretKey) {
    const envValue = process.env.TCB_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || env['TCB_SECRET_KEY'] || env['TENCENTCLOUD_SECRET_KEY']
    if (envValue) config.secretKey = envValue
  }
  if (!config.accountId) {
    const envValue = process.env.TENCENTCLOUD_ACCOUNT_ID || env['TENCENTCLOUD_ACCOUNT_ID']
    if (envValue) config.accountId = envValue
  }
  if (!config.token) {
    const tokenValue = process.env.TCB_SESSION_TOKEN || process.env.TENCENTCLOUD_SESSION_TOKEN
    if (tokenValue) {
      config.token = tokenValue
      config.isTemporaryCredential = true
    }
  }

  if (config.secretId && config.secretKey) {
    if (config.isTemporaryCredential && !config.token) {
      log('检测到临时凭证但缺少 TCB_SESSION_TOKEN', 'warn')
      log('临时凭证需要 session token 才能认证', 'error')
      return false
    }
    if (!config.accountId) {
      config.accountId = env['TENCENTCLOUD_ACCOUNT_ID'] || ''
    }
    log('使用环境变量中的凭证', 'success')
    return true
  }

  // Step 4 (fallback): No credentials found
  log('未找到有效凭证', 'error')
  log('', 'info')
  log('请通过以下方式提供凭证：', 'info')
  log('  1. 命令行参数：--secret-id, --secret-key', 'info')
  log('  2. 环境变量：TCB_SECRET_ID, TCB_SECRET_KEY', 'info')
  log('  3. cloudbase login（将自动引导登录）', 'info')
  return false
}

function generateSecrets() {
  log('正在生成本地开发密钥...')

  const env = loadEnvFile()

  if (!env['JWE_SECRET']) {
    const jweSecret = crypto.randomBytes(32).toString('base64')
    saveEnvVar('JWE_SECRET', jweSecret)
    log('Generated JWE_SECRET', 'success')
  } else {
    log('JWE_SECRET 已存在', 'warn')
  }

  if (!env['ENCRYPTION_KEY']) {
    const encryptionKey = crypto.randomBytes(32).toString('hex')
    saveEnvVar('ENCRYPTION_KEY', encryptionKey)
    log('Generated ENCRYPTION_KEY', 'success')
  } else {
    log('ENCRYPTION_KEY 已存在', 'warn')
  }
}

async function dockerTagAndPush(config, options) {
  const {
    domain,
    namespace,
    repoName,
    tag,
    localImage,
  } = options

  log('Checking for local image...')
  try {
    runCommand(`${DOCKER_CMD} inspect ${localImage}`, true)
    log('Local image found, skipping pull', 'success')
  } catch {
    log('Local image not found locally, pulling from registry...')
    if (!pullImage(localImage)) {
      log(`Cannot pull image. Make sure ${DOCKER_CMD} can reach ghcr.io, or pull manually:`, 'error')
      console.log(`  ${DOCKER_CMD} pull ${localImage}`)
      return false
    }
  }

  const fullImage = `${domain}/${namespace}/${repoName}:${tag}`
  if (!tagImage(localImage, fullImage)) {
    return false
  }

  if (!pushImage(fullImage)) {
    return false
  }

  saveEnvVar('TCR_IMAGE', fullImage)
  log('Image reference saved', 'info')
  config.namespace = namespace
  config.fullImage = fullImage
  config.registryDomain = domain
  return true
}

async function setupTcrPersonal(config) {
  const client = createTcrClient(config.secretId, config.secretKey, 'ap-guangzhou', config.token)

  // Step 1: Check if TCR user already exists
  const env = loadEnvFile()
  let password = config.password || env['TCR_PASSWORD'] || ''
  const userExists = await checkUserExists(client)

  if (userExists) {
    log('TCR 个人版用户已存在', 'info')

    if (password) {
      // 有已保存的密码，询问是否使用
      const useSaved = await askYesNo('检测到已保存的 TCR 密码，是否使用？', true)
      if (!useSaved) {
        password = ''
      }
    }

    if (!password) {
      console.log('')
      console.log('  请输入 TCR 个人版登录密码。')
      console.log('  如果忘记密码，可前往控制台重置：https://console.cloud.tencent.com/tcr/?rid=1')
      console.log('  → 找到广州地域的个人实例 → 点击「更多」→「重置登录密码」')
      console.log('')
      console.log('  1) 输入 TCR 密码')
      console.log('  2) 忘记密码，前往控制台重置')
      console.log('')

      const choice = await promptInput('请选择（1 或 2）')

      if (choice === '2') {
        console.log('')
        log('请前往 TCR 控制台重置登录密码：', 'info')
        log('  https://console.cloud.tencent.com/tcr/?rid=1', 'info')
        log('  → 找到广州地域的个人实例 → 点击「更多」→「重置登录密码」', 'info')
        console.log('')
        log('重置完成后，重新运行此脚本即可', 'info')
        return false
      }

      password = await promptInput('请输入 TCR 密码', true)
      if (!password) {
        log('密码为必填项', 'error')
        return false
      }
    }
  } else {
    // 新用户：初始化个人仓库
    log('首次使用 TCR 个人版，需要设置登录密码', 'info')
    console.log('')
    console.log('  密码要求：8-16 位，包含大写、小写字母、数字和特殊字符')
    console.log('')

    if (!password) {
      const useGenerated = await askYesNo('是否自动生成密码？', true)
      if (useGenerated) {
        password = generatePassword()
        log(`已生成密码：${password}`, 'success')
        log('请妥善保存此密码', 'warn')
      } else {
        password = await promptInput('请设置 TCR 密码', true)
        if (!password) {
          log('密码为必填项', 'error')
          return false
        }
      }
    }

    // Initialize TCR Personal Edition
    const initResult = await initTcrPersonal(client, password)
    if (!initResult.success) {
      return false
    }
  }

  if (!password) {
    log('密码为必填项', 'error')
    return false
  }

  // Save TCR password
  saveEnvVar('TCR_PASSWORD', password)
  saveEnvVar('SANDBOX_IMAGE_TYPE', 'personal')
  log('TCR password saved to .env.local', 'info')

  // Step 3: Find or create namespace
  let namespace = null

  // First, try to find existing namespace by prefix
  log(`Looking for existing namespace with prefix '${config.namespacePrefix}'...`)
  namespace = await findNamespaceByPrefix(client, config.namespacePrefix)

  if (namespace) {
    log(`Found existing namespace: ${namespace}`, 'success')
  } else {
    // Create new namespace with random suffix
    log(`No existing namespace found with prefix '${config.namespacePrefix}'`, 'info')
    namespace = await createNamespaceWithSuffix(client, config.namespacePrefix)
    if (!namespace) {
      return false
    }
  }

  // Save namespace to config
  config.namespace = namespace
  saveEnvVar('TCR_NAMESPACE', namespace)
  log('Namespace saved to .env.local', 'info')

  // 确保有 accountId 或 callerUin（Docker login 需要 username）
  if (!config.accountId && !config.callerUin) {
    const idResult = await getCloudbaseAccountId(config.secretId, config.secretKey)
    if (idResult) {
      config.accountId = idResult.accountId
      if (idResult.callerUin) config.callerUin = idResult.callerUin
    }
  }
  if (!config.accountId && !config.callerUin) {
    log('未能自动获取账号 ID（AppID）', 'warn')
    log('可在腾讯云控制台「账号信息」页面查看', 'info')
    log('  https://console.cloud.tencent.com/developer', 'info')
    const accountId = await promptInput('请输入你的腾讯云 AppID')
    if (!accountId) {
      log('缺少账号 ID，Docker login 需要 username', 'error')
      return false
    }
    config.accountId = accountId.trim()
    saveEnvVar('TENCENTCLOUD_ACCOUNT_ID', config.accountId)
    log('账号 ID 已保存', 'success')
  }

  // Step 4: Docker login
  // 优先用 .env.local 里保存的 TCR_USERNAME，避免主/子账号混淆
  // 否则用 callerUin（子账号 UIN）或 accountId（主账号 AppID）推断
  let dockerUsername = config.tcrUsername || config.callerUin || config.accountId
  const loginResult = await dockerLogin(TCR_PERSONAL_DOMAIN, dockerUsername, password)
  if (!loginResult.success) {
    return false
  }
  dockerUsername = loginResult.username
  password = loginResult.password

  return dockerTagAndPush(config, {
    domain: TCR_PERSONAL_DOMAIN,
    namespace,
    repoName: config.repoName,
    tag: config.tag,
    localImage: config.localImage,
  })
}

async function setupTcrEnterprise(config) {
  const env = loadEnvFile()

  let registryId = config.registryId || process.env.SANDBOX_IMAGE_REGISTRY_ID || env['SANDBOX_IMAGE_REGISTRY_ID'] || ''
  if (!registryId) {
    console.log('')
    console.log('  请输入 TCR 企业版实例 RegistryId。')
    console.log('  可在 TCR 企业版实例详情页查看。')
    console.log('')
    registryId = await promptInput('RegistryId')
    if (!registryId) {
      log('RegistryId 为必填项', 'error')
      return false
    }
  }
  registryId = registryId.trim()
  config.registryId = registryId
  saveEnvVar('SANDBOX_IMAGE_REGISTRY_ID', registryId)

  let registryDomain = config.registryDomain || process.env.TCR_DOMAIN || env['TCR_DOMAIN'] || ''
  if (!registryDomain) {
    registryDomain = await promptInput('TCR 企业版实例域名（例如 xxx.tencentcloudcr.com）')
    if (!registryDomain) {
      log('TCR 企业版实例域名为必填项', 'error')
      return false
    }
  }
  registryDomain = registryDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!registryDomain.endsWith('.tencentcloudcr.com')) {
    log('TCR 企业版实例域名格式不正确', 'error')
    return false
  }
  config.registryDomain = registryDomain
  saveEnvVar('TCR_DOMAIN', registryDomain)

  let region = config.region || process.env.TCR_REGION || env['TCR_REGION'] || ''
  if (!region) {
    region = await promptInput('TCR 企业版实例地域（默认 ap-guangzhou）')
  }
  region = (region || 'ap-guangzhou').trim()
  config.region = region
  saveEnvVar('TCR_REGION', region)

  const client = createTcrClient(config.secretId, config.secretKey, region, config.token)

  const hasProvidedPassword = !!config.password
  let password = config.password || env['TCR_PASSWORD'] || ''
  let dockerUsername = config.dockerUsername || process.env.TCR_DOCKER_USERNAME || env['TCR_DOCKER_USERNAME'] || ''

  if (password && dockerUsername) {
    const useSaved = await askYesNo('检测到已保存的 TCR 登录凭证，是否使用？', true)
    if (!useSaved) {
      password = ''
      dockerUsername = ''
    }
  } else if (password && !hasProvidedPassword) {
    password = ''
  }

  if (!password) {
    console.log('')
    console.log('━━━ TCR 企业版登录方式 ━━━')
    console.log('')
    console.log('  1) 输入实例登录密码（默认）')
    console.log('  2) 自动生成 longterm token')
    console.log('')
    const loginChoice = await promptInput('请选择（1 或 2，默认 1）')

    if (loginChoice === '2') {
      const tokenResult = await createInstanceTokenLongterm(client, registryId)
      if (!tokenResult) {
        return false
      }
      dockerUsername = tokenResult.username
      password = tokenResult.token
      saveEnvVar('TCR_DOCKER_USERNAME', dockerUsername)
      saveEnvVar('TCR_PASSWORD', password)
      if (tokenResult.tokenId) {
        saveEnvVar('TCR_TOKEN_ID', tokenResult.tokenId)
      }
      log('TCR Enterprise longterm token generated', 'success')
    } else {
      dockerUsername = dockerUsername || (await promptInput('请输入 TCR 企业版 Docker 登录用户名（通常为主账号 UIN）'))
      if (!dockerUsername) {
        log('Docker 登录用户名为必填项', 'error')
        return false
      }
      password = await promptInput('请输入 TCR 企业版实例登录密码', true)
      if (!password) {
        log('密码为必填项', 'error')
        return false
      }
      saveEnvVar('TCR_DOCKER_USERNAME', dockerUsername.trim())
      saveEnvVar('TCR_PASSWORD', password)
    }
  }

  if (!dockerUsername) {
    dockerUsername = await promptInput('请输入 TCR 企业版 Docker 登录用户名')
    if (!dockerUsername) {
      log('Docker 登录用户名为必填项', 'error')
      return false
    }
    saveEnvVar('TCR_DOCKER_USERNAME', dockerUsername.trim())
  }
  dockerUsername = dockerUsername.trim()

  log('Looking for existing enterprise namespace...')
  let namespace = await findNamespaceByPrefixEnterprise(client, registryId, config.namespacePrefix)

  if (namespace) {
    log('Found existing enterprise namespace', 'success')
  } else {
    log('No existing enterprise namespace found', 'info')
    namespace = await createNamespaceEnterpriseWithSuffix(client, registryId, config.namespacePrefix)
    if (!namespace) {
      return false
    }
  }

  config.namespace = namespace
  saveEnvVar('TCR_NAMESPACE', namespace)
  log('Namespace saved to .env.local', 'info')

  if (!(await ensureRepositoryEnterprise(client, registryId, namespace, config.repoName))) {
    return false
  }

  const loginResult = await dockerLogin(registryDomain, dockerUsername, password, {
    allowPromptRetry: false,
    enterprise: true,
  })
  if (!loginResult.success) {
    return false
  }

  saveEnvVar('TCR_IMAGE', fullImage)
  saveEnvVar('SANDBOX_IMAGE_TYPE', 'enterprise')
  syncStatefulSandboxImageToServer(fullImage)
  log('Image reference saved', 'info')

  return dockerTagAndPush(config, {
    domain: registryDomain,
    namespace,
    repoName: config.repoName,
    tag: config.tag,
    localImage: config.localImage,
  })
}

async function setupTcr(config) {
  // Step 0: Check Docker before doing anything else
  if (!checkDocker()) {
    log('Docker / Podman is not running or not installed', 'error')
    log('Please start Docker Desktop, colima, or podman machine and retry.', 'info')
    return false
  }

  if (config.edition === TCR_EDITION_ENTERPRISE) {
    return setupTcrEnterprise(config)
  }
  return setupTcrPersonal(config)
}

// ===================== CloudBase Env Selection =====================

async function selectTcbEnv(config) {
  const env = loadEnvFile()

  // Already set via CLI or env file — skip
  if (config.tcbEnvId || env['TCB_ENV_ID']) {
    const envId = config.tcbEnvId || env['TCB_ENV_ID']
    log(`Using TCB_ENV_ID: ${envId}`, 'success')
    saveEnvVar('TCB_ENV_ID', envId)
    config.tcbEnvId = envId
    return true
  }

  log('正在获取 CloudBase 环境列表...')

  let envList = []
  try {
    const output = execSync('cloudbase env list --json', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
    // Strip non-JSON prefix lines (e.g. spinner lines)
    const jsonStart = output.indexOf('{')
    if (jsonStart !== -1) {
      const parsed = JSON.parse(output.slice(jsonStart))
      envList = (parsed.data || []).filter(e => e.status === 'NORMAL')
    }
  } catch {
    log('Failed to fetch environment list', 'warn')
  }

  if (envList.length === 0) {
    log('No available CloudBase environments found', 'warn')
    console.log('')
    console.log('Please create one first:')
    console.log('  cloudbase env:create <envName>')
    console.log('  # then re-run this script')
    console.log('')
    const envId = await promptInput('Or enter an existing TCB_ENV_ID manually')
    if (!envId) {
      log('TCB_ENV_ID 为必填项', 'error')
      return false
    }
    saveEnvVar('TCB_ENV_ID', envId)
    config.tcbEnvId = envId
    return true
  }

  console.log('')
  console.log('可用的 CloudBase 环境：')
  envList.forEach((e, i) => {
    console.log(`  ${i + 1}) ${e.envId}`)
  })
  console.log(`  c) 创建新环境`)
  console.log('')

  while (true) {
    const answer = await promptInput('请选择环境（输入序号或 c）')
    if (!answer) continue

    if (answer.toLowerCase() === 'c') {
      console.log('')
      console.log('运行：cloudbase env:create <envName>')
      console.log('然后重新运行此脚本，或在下方输入新的 envId。')
      console.log('')
      const envId = await promptInput('请输入新的 TCB_ENV_ID')
      if (!envId) {
        log('TCB_ENV_ID 为必填项', 'error')
        return false
      }
      saveEnvVar('TCB_ENV_ID', envId)
      config.tcbEnvId = envId
      return true
    }

    const idx = parseInt(answer, 10) - 1
    if (idx >= 0 && idx < envList.length) {
      const envId = envList[idx].envId
      log(`已选择：${envId}`, 'success')
      saveEnvVar('TCB_ENV_ID', envId)
      config.tcbEnvId = envId
      return true
    }

    log('Invalid selection, please try again', 'warn')
  }
}

function normalizeTcrEdition(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === TCR_EDITION_PERSONAL || normalized === '1') return TCR_EDITION_PERSONAL
  if (normalized === TCR_EDITION_ENTERPRISE || normalized === '2') return TCR_EDITION_ENTERPRISE
  return ''
}

async function selectTcrEdition(config, env) {
  let edition = normalizeTcrEdition(config.edition || process.env.TCR_EDITION || env['TCR_EDITION'])

  while (!edition) {
    console.log('')
    console.log('━━━ TCR 版本选择 ━━━')
    console.log('')
    console.log('  1) 个人版（免费、限广州、命名空间全局唯一）')
    console.log('  2) 企业版（需已购实例、按实例独立域名）')
    console.log('')
    edition = normalizeTcrEdition(await promptInput('请选择 TCR 版本（1 或 2，默认 1）') || '1')
  }

  config.edition = edition
  saveEnvVar('TCR_EDITION', edition)
  if (edition === TCR_EDITION_PERSONAL && !config.region) {
    config.region = 'ap-guangzhou'
  }
  return edition
}

// ===================== Main =====================

async function main() {
  console.log('\n🔧 TCR 配置脚本\n')

  // Parse command line arguments
  const args = process.argv.slice(2)
  const envFromFile = loadEnvFile()
  const config = {
    secretId: process.env.TCB_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID || envFromFile['TCB_SECRET_ID'] || '',
    secretKey: process.env.TCB_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY || envFromFile['TCB_SECRET_KEY'] || '',
    accountId: process.env.TENCENTCLOUD_ACCOUNT_ID || envFromFile['TENCENTCLOUD_ACCOUNT_ID'] || '',
    callerUin: '',
    tcrUsername: process.env.TCR_USERNAME || envFromFile['TCR_USERNAME'] || '',
    tcbEnvId: process.env.TCB_ENV_ID || envFromFile['TCB_ENV_ID'] || '',
    // Token for temporary credentials: read from env only, never persisted to disk
    token: process.env.TCB_SESSION_TOKEN || process.env.TENCENTCLOUD_SESSION_TOKEN || undefined,
    isTemporaryCredential: !!(process.env.TCB_SESSION_TOKEN || process.env.TENCENTCLOUD_SESSION_TOKEN),
    edition: process.env.TCR_EDITION || '',
    registryId: process.env.SANDBOX_IMAGE_REGISTRY_ID || '',
    registryDomain: process.env.TCR_DOMAIN || '',
    dockerUsername: process.env.TCR_DOCKER_USERNAME || '',
    region: process.env.TCR_REGION || '',
    namespace: '',
    namespacePrefix: DEFAULT_NAMESPACE_PREFIX,
    visibility: 'private',
    localImage: GHCR_IMAGE_URL,
    repoName: 'sandbox',
    tag: 'latest',
    // Password from env var (passed by init.mjs to avoid exposing in process list)
    password: process.env.TCR_PASSWORD || undefined,
  }

  // Parse arguments
  const env = loadEnvFile()
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--secret-id':
        config.secretId = args[++i]
        break
      case '--secret-key':
        config.secretKey = args[++i]
        break
      case '--account-id':
        config.accountId = args[++i]
        break
      case '--edition':
        config.edition = args[++i]
        break
      case '--registry-id':
        config.registryId = args[++i]
        break
      case '--registry-domain':
        config.registryDomain = args[++i]
        break
      case '--region':
        config.region = args[++i]
        break
      case '--namespace':
        config.namespacePrefix = args[++i]
        break
      case '--visibility':
        config.visibility = args[++i]
        break
      case '--local-image':
        config.localImage = args[++i]
        break
      case '--repo-name':
        config.repoName = args[++i]
        break
      case '--tag':
        config.tag = args[++i]
        break
      case '--password':
        config.password = args[++i]
        break
      case '--skip-cloudbase-login':
        config.skipCloudbaseLogin = true
        break
      case '--help':
      case '-h':
        console.log(`
Usage: node scripts/setup-tcr.mjs [options]

Options:
  --secret-id <id>        Tencent Cloud Secret ID (optional if cloudbase login)
  --secret-key <key>      Tencent Cloud Secret Key (optional if cloudbase login)
  --account-id <id>       Tencent Cloud Account ID (optional if cloudbase login)
  --edition <type>        TCR edition: personal or enterprise
  --registry-id <id>      TCR Enterprise RegistryId
  --registry-domain <dom> TCR Enterprise registry domain (xxx.tencentcloudcr.com)
  --region <region>       TCR Enterprise region (default: ap-guangzhou)
  --namespace <prefix>    TCR namespace prefix (default: ${DEFAULT_NAMESPACE_PREFIX})
                          A 6-char random suffix will be added automatically
  --visibility <type>     Namespace visibility: private (default) or public
  --local-image <image>   Local Docker image to push (default: ${GHCR_IMAGE_URL})
  --repo-name <name>      Repository name in TCR (default: sandbox)
  --tag <tag>             Image tag (default: latest)
  --password <pwd>        TCR login password or enterprise token
  --skip-cloudbase-login  Skip automatic cloudbase login
  --help, -h              Show this help message

Namespace Behavior:
  - Personal Edition namespace is globally unique across all users
  - Enterprise Edition namespace is unique within the selected instance
  - Script will first search for existing namespace with the given prefix
  - If not found, creates a new one with random suffix (e.g., prefix-a1b2c3)
  - Namespace is saved to .env.local for future use

Credential Sources (in order of priority):
  1. Command line arguments (--secret-id, --secret-key, --account-id)
  2. Environment variables (TCB_SECRET_ID, TCB_SECRET_KEY, TENCENTCLOUD_ACCOUNT_ID)
  3. cloudbase-cli login state (automatic installation and login if needed)

Image Configuration from .env.local:
  TCR_EDITION        TCR edition: personal or enterprise
  TCR_LOCAL_IMAGE    Local Docker image to push (default: ${GHCR_IMAGE_URL})
  TCR_REPO_NAME      Repository name in TCR (default: sandbox)
  TCR_TAG            Image tag (default: latest)
  SANDBOX_IMAGE_REGISTRY_ID    TCR Enterprise RegistryId
  TCR_DOMAIN         TCR Enterprise registry domain
  TCR_REGION         TCR Enterprise region
  TCR_DOCKER_USERNAME Docker login username for TCR Enterprise

Examples:
  # Simple usage (will auto-install cloudbase and login if needed)
  node scripts/setup-tcr.mjs

  # Custom namespace prefix
  node scripts/setup-tcr.mjs --namespace my-app

  # With explicit credentials (skip cloudbase login)
  node scripts/setup-tcr.mjs \\
    --secret-id YOUR_SECRET_ID \\
    --secret-key YOUR_SECRET_KEY \\
    --account-id 123456789

  # Custom image
  node scripts/setup-tcr.mjs \\
    --namespace my-app \\
    --local-image node:20 \\
    --repo-name my-app \\
    --tag v1.0.0

  # TCR Enterprise Edition
  node scripts/setup-tcr.mjs \\
    --edition enterprise \\
    --registry-id tcr-xxxxxxxx \\
    --registry-domain xxx.tencentcloudcr.com \\
    --region ap-guangzhou
`)
        process.exit(0)
    }
  }

  await selectTcrEdition(config, env)

  // Apply env defaults for image config (CLI args take priority)
  if (config.localImage === GHCR_IMAGE_URL) {
    config.localImage = env['TCR_LOCAL_IMAGE'] || GHCR_IMAGE_URL
  }
  if (config.repoName === 'sandbox') {
    config.repoName = env['TCR_REPO_NAME'] || 'sandbox'
  }
  if (config.tag === 'latest') {
    // Default tag: use git short hash if available, else timestamp
    let defaultTag = env['TCR_TAG'] || ''
    if (!defaultTag) {
      try {
        const gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: 'pipe' }).trim()
        defaultTag = gitHash || `build-${Date.now()}`
      } catch {
        defaultTag = `build-${Date.now()}`
      }
    }
    config.tag = defaultTag
  }

  // 询问永久密钥（如已填写则直接使用，跳过 cloudbase 临时凭证流程）
  const hasPermanentKey = await setupPermanentKey(config)
  if (hasPermanentKey) {
    config.skipCloudbaseLogin = true
  }

  // Validate environment
  if (!(await validateAndPrepareEnv(config))) {
    process.exit(1)
  }

  // If using temporary credentials, token is required
  if (config.isTemporaryCredential && !config.token) {
    log('Temporary credentials detected but TCB_SESSION_TOKEN / TENCENTCLOUD_SESSION_TOKEN is not set', 'warn')
    const token = await promptInput('Enter session token (TCB_SESSION_TOKEN)', true)
    if (!token) {
      log('Session token is required for temporary credentials', 'error')
      process.exit(1)
    }
    config.token = token
  }

  // Ensure .env.local exists
  if (!existsSync(ENV_FILE)) {
    log(`Creating ${ENV_FILE}...`)
    writeFileSync(ENV_FILE, '# Environment variables\n')
  }

  // Run TCR setup
  const success = await setupTcr(config)

  if (success) {
    console.log('\n✅ 配置完成！\n')
    console.log('Your image is available at:')
    console.log(`  ${config.fullImage}\n`)
    console.log('Environment variables have been saved to .env.local')

    // SCF 角色授权提示
    console.log('')
    console.log('━━━ SCF 角色授权（必须）━━━')
    console.log('')
    console.log('  云函数需要拉取镜像的权限，请依次访问以下两个链接完成授权：')
    console.log('')
    console.log('  1) SCF 基础操作权限：')
    console.log('     https://console.cloud.tencent.com/cam/role/grant?roleName=SCF_QcsRole&policyName=QcloudAccessForScfRole&roleDesc=%E4%BA%91%E5%87%BD%E6%95%B0(SCF)%E6%93%8D%E4%BD%9C%E6%9D%83%E9%99%90%E5%90%AB%E5%88%9B%E5%BB%BA%E5%AF%B9%E8%B1%A1%E5%AD%98%E5%82%A8(COS)%E8%A7%A6%E5%8F%91%E5%99%A8%EF%BC%8C%E6%8B%89%E5%8F%96%E4%BB%A3%E7%A0%81%E5%8C%85%E7%AD%89%EF%BC%9B%E5%90%AB%E5%88%9B%E5%BB%BAAPI%E7%BD%91%E5%85%B3(API%20Gateway)%E8%A7%A6%E5%8F%91%E5%99%A8%E7%AD%89%EF%BC%9B%E5%90%AB%E6%B6%88%E5%88%9B%E5%BB%BA%E6%81%AF%E9%98%9F%E5%88%97(CMQ)%E8%A7%A6%E5%8F%91%E5%99%A8%E7%AD%89%EF%BC%9B%E5%90%AB%E6%8A%95%E9%80%92%E6%97%A5%E5%BF%97%E6%9C%8D%E5%8A%A1(CLS)%E6%97%A5%E5%BF%97%E7%AD%89%E3%80%82&principal=eyJzZXJ2aWNlIjoic2NmLnFjbG91ZC5jb20ifQ%3D%3D')
    console.log('')
    console.log('  2) SCF 拉取镜像权限：')
    console.log('     https://console.cloud.tencent.com/cam/role/grant?roleName=SCF_QcsRole&policyName=QcloudAccessForSCFRoleInPullImage&principal=eyJzZXJ2aWNlIjoic2NmLnFjbG91ZC5jb20ifQ%3D%3D')
    console.log('')
    console.log('  ⚠ 如果不授权，云函数将无法拉取镜像，沙箱创建会失败。')
    console.log('')

    // 等待用户确认
    const authDone = await askYesNo('是否已完成上述两个授权链接的操作？', true)
    if (!authDone) {
      console.log('')
      console.log('  请在启动项目前完成授权，否则沙箱功能将不可用。')
      console.log('')
    }
  } else {
    console.log('\n❌ Setup failed. Please check the errors above.\n')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Setup failed with error:', error)
  process.exit(1)
})
