#!/usr/bin/env node

/**
 * CodeBuddy 模型配置引导脚本
 *
 * 作用：
 *   - 从 CloudBase 拉取可用 AI 模型列表（DescribeAIModels）
 *   - 生成 packages/server/.config/.codebuddy/models.json
 *   - 供 @tencent-ai/agent-sdk 读取自定义模型列表
 *
 * 设计约束：
 *   - 只处理项目级配置
 *   - 凭证只存 packages/server/.env
 *   - 模板中的 ${VAR_NAME} 占位符在运行时被解析为环境变量值
 *
 * 用法：
 *   pnpm codebuddy:setup
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CloudBaseManager = require('../packages/server/node_modules/@cloudbase/manager-node')
let managerApp = null

// ─── Constants ───────────────────────────────────────────────────────────

const ROOT = process.cwd()
const SERVER_ENV_FILE = path.join(ROOT, 'packages', 'server', '.env')
const MODELS_CONFIG_DIR = path.join(ROOT, 'packages', 'server', '.config', '.codebuddy')
const MODELS_CONFIG_FILE = path.join(MODELS_CONFIG_DIR, 'models.json')

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
}

// ─── UI helpers ──────────────────────────────────────────────────────────

function log(msg, type = 'info') {
  const prefix = {
    info: `${colors.cyan}→${colors.reset}`,
    ok: `${colors.green}✓${colors.reset}`,
    warn: `${colors.yellow}!${colors.reset}`,
    err: `${colors.red}✗${colors.reset}`,
    step: `${colors.bold}▸${colors.reset}`,
  }[type]
  console.log(`${prefix} ${msg}`)
}

function logSection(title) {
  console.log('')
  console.log(`${colors.bold}${colors.cyan}━━━ ${title} ━━━${colors.reset}`)
}

let _rl = null

function drainStdin() {
  return new Promise((resolve) => {
    if (!process.stdin.readable) return resolve()
    process.stdin.resume()
    const drain = () => {
      while (process.stdin.read() !== null) {
        /* discard */
      }
    }
    drain()
    setTimeout(() => {
      drain()
      process.stdin.pause()
      resolve()
    }, 10)
  })
}

async function prompt(question, { hidden = false, defaultValue = '' } = {}) {
  if (hidden) {
    if (_rl) {
      _rl.close()
      _rl = null
    }
    await drainStdin()
    process.stdout.write(`${question}: `)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    return new Promise((resolve) => {
      let buf = ''
      const onData = (chunk) => {
        const c = chunk.toString('utf8')
        if (c === '\n' || c === '\r' || c === '\u0004') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(buf || defaultValue)
        } else if (c === '\u0003') {
          process.exit(130)
        } else if (c.charCodeAt(0) === 127) {
          buf = buf.slice(0, -1)
        } else {
          buf += c
        }
      }
      process.stdin.on('data', onData)
    })
  }
  if (_rl) {
    _rl.close()
    _rl = null
  }
  await drainStdin()
  _rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const hint = defaultValue ? ` ${colors.dim}[${defaultValue}]${colors.reset}` : ''
  return new Promise((resolve) => {
    _rl.question(`${question}${hint}: `, (answer) => {
      _rl.close()
      _rl = null
      const value = answer.trim()
      resolve(value || defaultValue)
    })
  })
}

// ─── Env file helpers ───────────────────────────────────────────────────

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const env = {}
  const content = fs.readFileSync(file, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key) env[key] = value
  }
  return env
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 往 env 文件写 key=value。
 * - 已存在同名 key：替换该行
 * - 不存在：追加到文件末尾（如果文件已存在，先补一个换行避免粘连）
 */
function upsertEnvFile(file, updates) {
  const keys = Object.keys(updates)
  if (keys.length === 0) return { updated: [], added: [] }

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const updated = []
  const added = []

  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  for (const key of keys) {
    const value = updates[key]
    const re = new RegExp(`^[#\\s]*${escapeRegExp(key)}\\s*=.*$`, 'm')
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`)
      updated.push(key)
    } else {
      if (content.length > 0 && !content.endsWith('\n')) content += '\n'
      content += `${key}=${value}\n`
      added.push(key)
    }
  }
  fs.writeFileSync(file, content)
  return { updated, added }
}

// ─── CloudBase helpers ───────────────────────────────────────────────────

function getManager(envId, secretId, secretKey) {
  if (managerApp) return managerApp
  managerApp = new CloudBaseManager({
    envId,
    secretId,
    secretKey,
  })
  return managerApp
}

async function describeAIModes(envId, secretId, secretKey) {
  try {
    const manager = getManager(envId, secretId, secretKey)
    const commonService = manager.commonService('tcb', '2018-06-08')
    const result = await commonService.call({
      Action: 'DescribeAIModels',
      Param: {
        EnvId: envId,
      },
    })
    return result?.AIModels || []
  } catch (err) {
    console.error(
      '[codebuddy setup] Failed to describe AI models',
      err instanceof Error ? err.message : err,
    )
    return []
  }
}

// ─── Model config builders ───────────────────────────────────────────────

/**
 * 将 CloudBase DescribeAIModels 返回的模型列表转换为 CodeBuddy models.json 格式
 */
function buildCodeBuddyModelsConfig(modelList, envId) {
  const models = []
  const availableModels = []

  for (const group of modelList) {
    if (group.GroupName !== 'cloudbase') {
      continue
    }
    if (!group?.Models) continue

    for (const model of group.Models) {
      const modelId = model.Model || model.model || model.Id || model.id
      const modelName = model.Name || model.name || modelId
      if (!modelId) continue

      models.push({
        id: modelId,
        name: modelName,
        vendor: group.GroupName || 'cloudbase',
        apiKey: '${CLOUDBASE_API_KEY}',
        url: `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase`,
        supportsToolCall: true,
        supportsImages: true,
      })
      availableModels.push(modelId)
    }
  }

  return { models, availableModels }
}

/**
 * 读取现有的 models.json（如果存在）
 */
function readExistingModelsConfig() {
  if (!fs.existsSync(MODELS_CONFIG_FILE)) return null
  try {
    const raw = fs.readFileSync(MODELS_CONFIG_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch (e) {
    log(`解析现有 models.json 失败：${e.message}`, 'warn')
    return null
  }
}

/**
 * 写入 models.json
 */
function writeModelsConfig(config) {
  fs.mkdirSync(MODELS_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(MODELS_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  logSection('CodeBuddy 模型配置')

  const envNow = parseEnvFile(SERVER_ENV_FILE)
  const envId = envNow['TCB_ENV_ID']
  const secretId = envNow['TCB_SECRET_ID']
  const secretKey = envNow['TCB_SECRET_KEY']
  const apiKey = envNow['CLOUDBASE_API_KEY']

  if (!envId || !secretId || !secretKey) {
    log('缺少 CloudBase 凭证，请确保 packages/server/.env 中包含 TCB_ENV_ID、TCB_SECRET_ID、TCB_SECRET_KEY', 'err')
    process.exit(1)
  }

  // 1. 检查 / 引导输入 CLOUDBASE_API_KEY
  if (!apiKey) {
    log('缺少 CLOUDBASE_API_KEY，请确保 packages/server/.env 中已配置', 'warn')
    console.log(`  可从 https://tcb.cloud.tencent.com/dev?envId=${envId}#/env/apikey 创建获取`)
    console.log('')
    const value = await prompt('  CLOUDBASE_API_KEY', { hidden: true })
    if (value && value.trim() !== '') {
      const { added, updated } = upsertEnvFile(SERVER_ENV_FILE, {
        CLOUDBASE_API_KEY: value.trim(),
        CODEBUDDY_USE_CUSTOM_MODELS: 'true',
      })
      if (added.includes('CLOUDBASE_API_KEY')) log('已追加 CLOUDBASE_API_KEY 到 packages/server/.env', 'ok')
      if (updated.includes('CLOUDBASE_API_KEY')) log('已更新 packages/server/.env 中的 CLOUDBASE_API_KEY', 'ok')
      if (added.includes('CODEBUDDY_USE_CUSTOM_MODELS')) log('已追加 CODEBUDDY_USE_CUSTOM_MODELS=true 到 packages/server/.env', 'ok')
      if (updated.includes('CODEBUDDY_USE_CUSTOM_MODELS')) log('已更新 packages/server/.env 中的 CODEBUDDY_USE_CUSTOM_MODELS', 'ok')
      envNow['CLOUDBASE_API_KEY'] = value.trim()
      envNow['CODEBUDDY_USE_CUSTOM_MODELS'] = 'true'
    } else {
      log('未输入 CLOUDBASE_API_KEY，跳过', 'warn')
    }
  }

  // 2. 拉取 CloudBase AI 模型列表
  log('拉取 CloudBase AI 模型列表...', 'step')
  const modelList = await describeAIModes(envId, secretId, secretKey)

  // 3. 构建 CodeBuddy 模型配置
  const newConfig = buildCodeBuddyModelsConfig(modelList, envId)

  if (newConfig.models.length === 0) {
    log('未获取到任何 AI 模型', 'err')
    console.log(`  请前往 https://tcb.cloud.tencent.com/dev?envId=${envId}#/ai?tab=text-aiModel 开启模型配置`)
    process.exit(1)
  }

  log(`模型列表：${newConfig.availableModels.join(', ')}`, 'info')

  // 4. 合并现有配置：
  //    - CloudBase 模型以 API 返回为准（删除已从控制台移除的）
  //    - 仅保留 vendor 非 cloudbase 的真正自定义模型（用户手动添加的第三方）
  const existingConfig = readExistingModelsConfig()
  let finalConfig = newConfig

  if (existingConfig?.models && Array.isArray(existingConfig.models)) {
    const newModelIds = new Set(newConfig.models.map((m) => m.id))
    const preservedCustomModels = existingConfig.models.filter(
      (m) => !newModelIds.has(m.id) && m.vendor !== 'cloudbase',
    )

    if (preservedCustomModels.length > 0) {
      log(`保留 ${preservedCustomModels.length} 个自定义模型`, 'info')
      finalConfig = {
        models: [...newConfig.models, ...preservedCustomModels],
        availableModels: [...newConfig.availableModels, ...preservedCustomModels.map((m) => m.id)],
      }
    }

    // 提示已从 CloudBase 移除的模型
    const removedCloudbaseModels = existingConfig.models.filter(
      (m) => !newModelIds.has(m.id) && m.vendor === 'cloudbase',
    )
    if (removedCloudbaseModels.length > 0) {
      log(
        `已从 models.json 移除 ${removedCloudbaseModels.length} 个模型（已从 CloudBase 控制台删除）：${removedCloudbaseModels.map((m) => m.id).join(', ')}`,
        'info',
      )
    }
  }

  // 5. 落盘
  writeModelsConfig(finalConfig)
  log(`已写入 ${path.relative(ROOT, MODELS_CONFIG_FILE)}`, 'ok')

  // 6. Summary
  console.log('')
  console.log(`${colors.bold}${colors.green}✓ 完成${colors.reset}`)
  console.log('')
  console.log(`${colors.dim}下一步：${colors.reset}`)
  console.log(`  1) 设置环境变量 ${colors.bold}CODEBUDDY_USE_CUSTOM_MODELS=true${colors.reset} 启用自定义模型模式`)
  console.log(`  2) 重启 server（${colors.bold}pnpm dev:server${colors.reset}）`)
  console.log(`  3) 前端模型下拉应看到：${colors.bold}${finalConfig.availableModels.join(', ')}${colors.reset}`)
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
