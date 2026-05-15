#!/usr/bin/env node

/**
 * OpenCode Provider 配置引导脚本
 *
 * 作用：
 *   - 从 models.dev 拉取 provider catalog（opencode 自身在用的同一份）
 *   - 引导用户选择要启用的 provider 并输入 API key
 *   - 把 provider 启用声明写入 .opencode/opencode.json
 *     （空对象 `{}` 风格，所有元数据由 opencode 运行时从 catalog 自动获取）
 *   - 把 API key 写入 packages/server/.env
 *
 * 设计约束：
 *   - 只处理项目级配置；不读写 ~/.local/share/opencode/auth.json
 *   - 不做 catalog 本地缓存；每次重新拉取
 *   - 凭证只存 packages/server/.env
 *
 * 用法：
 *   pnpm opencode:setup
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CloudBaseManager = require('../packages/server/node_modules/@cloudbase/manager-node')
let managerApp = null

// ─── Constants ───────────────────────────────────────────────────────────

const CATALOG_URL = process.env.MODELS_DEV_CATALOG_URL || 'https://models.dev/api.json'
const CATALOG_FETCH_TIMEOUT_MS = Number(process.env.MODELS_DEV_FETCH_TIMEOUT_MS) || 10_000

const ROOT = process.cwd()
const OPENCODE_JSON = path.join(ROOT, '.opencode', 'opencode.json')
const SERVER_ENV_FILE = path.join(ROOT, 'packages', 'server', '.env')

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
    // 替换已存在的行（匹配 "KEY=..." 或 "#KEY=..."）
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Catalog fetcher ────────────────────────────────────────────────────

async function fetchCatalog() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(CATALOG_URL, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data || typeof data !== 'object') throw new Error('invalid catalog shape')
    return data
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ─── opencode.json helpers ──────────────────────────────────────────────

function readOpencodeJson() {
  if (!fs.existsSync(OPENCODE_JSON)) {
    return { $schema: 'https://opencode.ai/config.json', provider: {} }
  }
  try {
    const raw = fs.readFileSync(OPENCODE_JSON, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed.provider || typeof parsed.provider !== 'object') parsed.provider = {}
    if (!parsed.$schema) parsed.$schema = 'https://opencode.ai/config.json'
    return parsed
  } catch (e) {
    log(`解析 .opencode/opencode.json 失败：${e.message}`, 'warn')
    return { $schema: 'https://opencode.ai/config.json', provider: {} }
  }
}

function writeOpencodeJson(config) {
  fs.mkdirSync(path.dirname(OPENCODE_JSON), { recursive: true })
  // 保持稳定字段顺序：$schema > model > provider > 其他
  const ordered = {}
  if (config.$schema) ordered.$schema = config.$schema
  if (config.model) ordered.model = config.model
  if (config.provider) ordered.provider = config.provider
  for (const [k, v] of Object.entries(config)) {
    if (k in ordered) continue
    ordered[k] = v
  }
  fs.writeFileSync(OPENCODE_JSON, JSON.stringify(ordered, null, 2) + '\n')
}

/**
 * 从 catalog 构建完整的 provider 配置（写入 opencode.json）。
 *
 * 为什么不用空对象 `{}`：opencode 子进程自身也需要拉 models.dev catalog 来
 * 填充 npm / baseURL / models 等字段。如果拉取失败（网络/超时），空对象等于
 * "什么都没有"，导致模型不可用。写入完整字段则让 opencode.json 自包含，
 * 不依赖运行时 catalog 拉取。
 *
 * 写入的字段：npm, name, options.baseURL, options.apiKey({env:VAR}),
 *             models（每个 model 的 name/tool_call/reasoning/limit/modalities）
 * 不写入的字段：cost/release_date/family 等纯展示字段（opencode 不需要）
 */
function buildProviderConfig(catalog, providerId) {
  const p = catalog[providerId]
  if (!p) {
    // catalog 里没有（不太可能走到这，因为 listProviders 已过滤）
    return {}
  }

  const config = {}

  // npm: 有则写，没有用默认
  if (p.npm) config.npm = p.npm

  // name
  if (p.name && p.name !== providerId) config.name = p.name

  // options: baseURL + apiKey（用 {env:VAR} 占位符）
  const options = {}
  if (p.api) options.baseURL = p.api
  if (Array.isArray(p.env) && p.env.length > 0) {
    options.apiKey = `{env:${p.env[0]}}`
  }
  if (Object.keys(options).length > 0) config.options = options

  // models: 取 catalog 里所有非 deprecated 的 model，只保留 opencode 需要的字段
  const models = {}
  for (const [mid, m] of Object.entries(p.models || {})) {
    if (!m || typeof m !== 'object') continue
    if (m.status === 'deprecated') continue

    const model = {}
    if (m.name) model.name = m.name
    if (m.tool_call !== undefined) model.tool_call = m.tool_call
    if (m.reasoning !== undefined) model.reasoning = m.reasoning
    if (m.limit && (m.limit.context || m.limit.output)) {
      model.limit = {}
      if (m.limit.context) model.limit.context = m.limit.context
      if (m.limit.output) model.limit.output = m.limit.output
    }
    if (m.modalities) {
      model.modalities = {}
      if (Array.isArray(m.modalities.input)) model.modalities.input = m.modalities.input
      if (Array.isArray(m.modalities.output)) model.modalities.output = m.modalities.output
    }
    models[mid] = model
  }
  if (Object.keys(models).length > 0) config.models = models

  return config
}

function padEnd(str, width) {
  // 粗略按 UTF-16 长度对齐（中文宽度不严格处理，够用）
  const pad = Math.max(0, width - str.length)
  return str + ' '.repeat(pad)
}

/**
 * 从字符串里提取所有 {env:VAR} 占位符的变量名。
 * 用于扫描自定义 provider 的 options.apiKey / options.baseURL / options.headers。
 */
function extractEnvPlaceholders(value) {
  if (typeof value !== 'string') return []
  const out = []
  const re = /\{env:([^}]+)\}/g
  let m
  while ((m = re.exec(value)) !== null) {
    if (m[1]) out.push(m[1])
  }
  return out
}

/**
 * 递归收集 provider.options（含 nested headers/object）里所有的 {env:VAR}。
 */
function collectProviderEnvPlaceholders(provider) {
  const set = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const v of extractEnvPlaceholders(node)) set.add(v)
    } else if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk)
    }
  }
  walk(provider?.options ?? {})
  return Array.from(set)
}

/**
 * 扫描 opencode.json 已存在的 provider，对每个识别其需要的 env、当前是否齐全。
 *
 * 三种判定来源（与运行时 `filterAvailable` 完全对齐）：
 *   - catalog provider：`provider.env` 数组里任一命中即可
 *   - 自定义 provider（catalog 里没有）：扫 options 里的 `{env:VAR}` 占位符
 *   - 用户在 opencode.json 里手动覆盖 `env` 数组：以用户值为准
 */
function inspectExistingProviders(existingProviderMap, catalog, envNow) {
  const result = []
  for (const [id, cfg] of Object.entries(existingProviderMap ?? {})) {
    if (!cfg || typeof cfg !== 'object') continue

    const fromCatalog = catalog[id]
    const isInCatalog = !!fromCatalog
    const name = cfg.name || fromCatalog?.name || id

    // 候选 env 列表：用户覆盖 > catalog > 占位符提取
    let envCandidates = []
    if (Array.isArray(cfg.env) && cfg.env.length > 0) {
      envCandidates = cfg.env.slice()
    } else if (Array.isArray(fromCatalog?.env) && fromCatalog.env.length > 0) {
      envCandidates = fromCatalog.env.slice()
    }
    // 自定义 provider 没有 catalog env 时，用占位符
    const placeholders = collectProviderEnvPlaceholders(cfg)
    for (const p of placeholders) {
      if (!envCandidates.includes(p)) envCandidates.push(p)
    }

    // 是否"运行时可用"
    const hasOptionsApiKey = (() => {
      const k = cfg.options?.apiKey
      if (typeof k !== 'string' || !k) return false
      const m = k.match(/^\{env:([^}]+)\}$/)
      if (m) return !!envNow[m[1]]
      return true // 明文字符串
    })()
    const hasEnvSet = envCandidates.some((v) => !!envNow[v])
    const ok = hasEnvSet || hasOptionsApiKey

    // 缺失的 env：所有候选里没设置的
    // - 对 catalog provider：只要任一 env 设了就算 ok（不算缺失）
    // - 对自定义 provider 含 placeholder：每个 placeholder 都要设
    let missingEnv = []
    if (placeholders.length > 0) {
      // 占位符模式：每个都必须设
      missingEnv = placeholders.filter((v) => !envNow[v])
    } else if (!ok) {
      missingEnv = envCandidates.slice()
    }

    result.push({
      id,
      name,
      isInCatalog,
      isCustom: !isInCatalog,
      envCandidates,
      missingEnv,
      ok,
      modelCount: Object.keys(cfg.models ?? fromCatalog?.models ?? {}).length,
    })
  }
  return result
}

function renderExistingTable(rows) {
  if (rows.length === 0) return
  console.log('')
  console.log(`${colors.bold}已配置的 provider（来自 .opencode/opencode.json）${colors.reset}`)
  console.log('')
  console.log(
    `  ${colors.dim}状态  ${padEnd('provider id', 22)} ${padEnd('类型', 10)} ${padEnd('依赖 env', 40)} 模型数${colors.reset}`,
  )
  for (const r of rows) {
    const status = r.ok ? `${colors.green}●${colors.reset}` : `${colors.yellow}●${colors.reset}`
    const kind = r.isInCatalog ? 'catalog' : '自定义'
    // 先算"无颜色"的纯文本，按其长度 pad，再套色
    const envPlain =
      r.missingEnv.length > 0
        ? `缺 ${r.missingEnv.join(', ')}`
        : r.envCandidates.length > 0
          ? r.envCandidates.join(' / ')
          : '-'
    const envColor =
      r.missingEnv.length > 0 ? colors.yellow : r.envCandidates.length > 0 ? colors.green : colors.dim
    const envLabel = `${envColor}${envPlain}${colors.reset}` + ' '.repeat(Math.max(0, 40 - envPlain.length))
    console.log(`  ${status}    ${padEnd(r.id, 22)} ${padEnd(kind, 10)} ${envLabel} ${r.modelCount}`)
  }
  console.log(
    `  ${colors.dim}● 绿色 = 凭证已就绪可用    ● 黄色 = 已声明但缺 env，前端不会展示${colors.reset}`,
  )
}

/**
 * 渲染 provider 选择列表。仅展示有 env 字段的 provider（我们能自动处理 api-key 模式）。
 */
function listProviders(catalog, existingProvider, envNow) {
  const items = Object.entries(catalog)
    .filter(([_, p]) => Array.isArray(p.env) && p.env.length > 0)
    .map(([id, p]) => {
      const alreadyEnabled = !!existingProvider[id]
      const envKey = p.env[0]
      const envSet = !!envNow[envKey]
      return {
        id,
        name: p.name || id,
        envKey,
        envKeys: p.env,
        modelCount: Object.keys(p.models || {}).length,
        alreadyEnabled,
        envSet,
      }
    })
    .sort((a, b) => {
      // cloudbase 始终排在第一位
      if (a.id === 'cloudbase') return -1
      if (b.id === 'cloudbase') return 1
      // 已启用的排在前面，便于识别
      if (a.alreadyEnabled !== b.alreadyEnabled) return a.alreadyEnabled ? -1 : 1
      return a.id.localeCompare(b.id)
    })
  return items
}

function renderProviderTable(items) {
  console.log('')
  console.log(`  ${colors.dim}状态  ${padEnd('provider id', 22)} ${padEnd('name', 24)} ${padEnd('env key', 28)} 模型数${colors.reset}`)
  for (const it of items) {
    const tick = it.alreadyEnabled ? `${colors.green}●${colors.reset}` : '○'
    const envMark = it.envSet ? `${colors.green}${it.envKey}${colors.reset}` : it.envKey
    console.log(
      `  ${tick}    ${padEnd(it.id, 22)} ${padEnd(it.name, 24)} ${padEnd(envMark, 28 + (it.envSet ? colors.green.length + colors.reset.length : 0))} ${it.modelCount}`,
    )
  }
  console.log(`  ${colors.dim}● = 已在 opencode.json 启用，绿色 env key = .env 已设置${colors.reset}`)
}

async function pickProviders(items) {
  console.log('')
  console.log(`输入要启用的 provider id（空格分隔，留空使用全部已启用的）`)
  console.log(`${colors.dim}例如: deepseek moonshot openai${colors.reset}`)
  const answer = await prompt('provider ids')
  const raw = answer
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const selected = []
  const unknown = []
  const byId = new Map(items.map((it) => [it.id, it]))
  for (const id of raw) {
    if (byId.has(id)) selected.push(byId.get(id))
    else unknown.push(id)
  }
  if (unknown.length > 0) {
    log(`未知 provider id（忽略）：${unknown.join(', ')}`, 'warn')
  }
  return selected
}

async function collectApiKeys(selected, envNow) {
  const updates = {}
  for (const it of selected) {
    const existing = envNow[it.envKey]
    if (existing) {
      console.log(`  ${colors.green}✓${colors.reset} ${it.envKey} 已在 packages/server/.env 中（跳过）`)
      continue
    }
    console.log('')
    console.log(`  ${colors.bold}${it.name}${colors.reset} (${it.id})`)
    if (it.envKeys.length > 1) {
      console.log(`  ${colors.dim}候选 env: ${it.envKeys.join(', ')} — 将使用 ${it.envKey}${colors.reset}`)
    }
    const value = await prompt(`  ${it.envKey}`, { hidden: true })
    if (!value || value.trim() === '') {
      log(`  未输入值，provider ${it.id} 仍会写入 opencode.json 但运行时不会启用`, 'warn')
      continue
    }
    updates[it.envKey] = value.trim()
  }
  return updates
}

/**
 * 收集"已存在但缺 env 的 provider"的 env 值。
 * 与 collectApiKeys 区别：这里是补齐，不需要再写 provider 对象到 opencode.json。
 */
async function collectMissingEnvs(rows) {
  const updates = {}
  // 把所有 row 的 missingEnv 去重展开成一个待补齐列表
  const todoMap = new Map() // envKey -> Set<providerId>
  for (const r of rows) {
    for (const k of r.missingEnv) {
      if (!todoMap.has(k)) todoMap.set(k, new Set())
      todoMap.get(k).add(r.id)
    }
  }
  if (todoMap.size === 0) return updates

  console.log('')
  console.log(
    `${colors.bold}补齐缺失的 env${colors.reset} ${colors.dim}（这些 provider 已在 opencode.json 声明，但当前 .env 缺凭证）${colors.reset}`,
  )
  console.log(`${colors.dim}回车留空 = 跳过该项${colors.reset}`)

  for (const [envKey, providers] of todoMap) {
    console.log('')
    console.log(`  ${colors.bold}${envKey}${colors.reset} ${colors.dim}（用于: ${[...providers].join(', ')}）${colors.reset}`)
    const value = await prompt(`  ${envKey}`, { hidden: true })
    if (value && value.trim() !== '') {
      updates[envKey] = value.trim()
    }
  }
  return updates
}

async function pickDefaultModel(catalog, selected, currentDefault) {
  const candidates = []
  for (const it of selected) {
    const models = catalog[it.id]?.models ?? {}
    for (const mid of Object.keys(models)) {
      const m = models[mid]
      if (m && m.status === 'deprecated') continue
      candidates.push({
        id: `${it.id}/${mid}`,
        name: m?.name || mid,
        provider: it.name,
      })
    }
  }
  if (candidates.length === 0) return currentDefault || ''

  // 如果当前默认还在候选里，保留为默认
  const current = candidates.find((c) => c.id === currentDefault)
  const defaultIdx = current ? candidates.indexOf(current) : 0

  console.log('')
  console.log(`选择默认模型（会写入 opencode.json 的 "model" 字段）：`)
  const showTop = Math.min(candidates.length, 20)
  for (let i = 0; i < showTop; i++) {
    const c = candidates[i]
    const mark = i === defaultIdx ? `${colors.green}*${colors.reset}` : ' '
    console.log(`  ${mark} ${String(i + 1).padStart(2, ' ')}) ${c.id}  ${colors.dim}(${c.provider})${colors.reset}`)
  }
  if (candidates.length > showTop) {
    console.log(`  ${colors.dim}... 及其他 ${candidates.length - showTop} 个，输入序号或完整 id${colors.reset}`)
  }
  const answer = await prompt(`模型序号或 provider/model`, {
    defaultValue: candidates[defaultIdx].id,
  })

  if (!answer) return candidates[defaultIdx].id
  const idx = Number(answer) - 1
  if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
    return candidates[idx].id
  }
  // 允许用户直接输入完整 id（即便不在展示的前 20 个）
  if (candidates.some((c) => c.id === answer)) return answer
  log(`输入无效，使用 ${candidates[defaultIdx].id}`, 'warn')
  return candidates[defaultIdx].id
}

function getManager(envId, secretId, secretKey) {
  if (managerApp) return managerApp
  managerApp = new CloudBaseManager({
    envId,
    secretId,
    secretKey
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
    // Non-fatal: server-side SDK uses admin creds and bypasses rules.
    console.error(
      '[open code setup] Failed to describe ai models',
      err instanceof Error ? err.message : err,
    )
  }
}

async function getCloudBaseModelConfig(envId, secretId, secretKey) {
  const modelList = await describeAIModes(envId, secretId, secretKey)
  let cloudBaseModels = {}
  for (const it of modelList) {
    if (it?.GroupName !== "cloudbase") {
      continue;
    }
    for (const model of it?.Models){
      cloudBaseModels[model.Model] ={
        id : model.Model,
        name : model.Model,
      }
    }
  }

  return {
    id: "cloudbase",
    env: ["CLOUDBASE_API_KEY"],
    npm: "",
    api: `https://${envId}.api.tcloudbasegateway.com/v1/ai/cloudbase`,
    name: "cloudbase",
    doc:"",
    models: cloudBaseModels
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  logSection('OpenCode Provider 配置')

  // 1. 拉 catalog
  log('拉取 models.dev catalog...', 'step')
  let catalog
  try {
    catalog = await fetchCatalog()
    log(`catalog 已拉取：${Object.keys(catalog).length} providers`, 'ok')
  } catch (e) {
    log(`拉取失败：${e.message}`, 'err')
    console.log('')
    console.log(`请检查网络或设置 ${colors.bold}MODELS_DEV_CATALOG_URL${colors.reset} env 指向镜像。`)
    process.exit(1)
  }

  const envNow = parseEnvFile(SERVER_ENV_FILE)
  const envId = envNow['TCB_ENV_ID']
  const secretId = envNow['TCB_SECRET_ID']
  const secretKey = envNow['TCB_SECRET_KEY']

  // 添加 cloudbase 模型
  catalog['cloudbase'] = await getCloudBaseModelConfig(envId, secretId, secretKey)

  // 2. 读现状
  const existing = readOpencodeJson()

  // 3. 扫描已有 provider，识别缺失 env
  const existingRows = inspectExistingProviders(existing.provider, catalog, envNow)
  renderExistingTable(existingRows)

  // 3a. 如有缺失 env，先邀请用户补齐
  const missingRows = existingRows.filter((r) => r.missingEnv.length > 0)
  let missingEnvUpdates = {}
  if (missingRows.length > 0) {
    console.log('')
    const ans = await prompt(
      `检测到 ${missingRows.length} 个 provider 缺少 env，是否现在补齐？(Y/n)`,
      { defaultValue: 'Y' },
    )
    if (ans.toLowerCase() !== 'n' && ans.toLowerCase() !== 'no') {
      missingEnvUpdates = await collectMissingEnvs(missingRows)
    }
  }

  // 4. 展示 catalog provider 列表（添加新 provider 用）
  const items = listProviders(catalog, existing.provider, { ...envNow, ...missingEnvUpdates })
  if (items.length === 0) {
    log('catalog 中没有可用 provider（这不太可能，请检查 catalog）', 'err')
    process.exit(1)
  }

  console.log('')
  console.log(`${colors.bold}添加 / 启用 catalog provider${colors.reset}`)
  renderProviderTable(items)

  // 5. 用户选
  const selected = await pickProviders(items)
  if (selected.length === 0 && Object.keys(missingEnvUpdates).length === 0) {
    log('没有任何变更，退出', 'info')
    process.exit(0)
  }

  // 6. 收 key（仅针对新选的 provider；missing 的已在 step 3a 处理）
  let envUpdates = { ...missingEnvUpdates }
  if (selected.length > 0) {
    log(`新增启用：${selected.map((s) => s.id).join(', ')}`, 'ok')
    logSection('API Key（新增 provider）')
    console.log(`${colors.dim}所有 key 将写入 packages/server/.env（已 gitignore）。回车留空则跳过。${colors.reset}`)
    const newKeyUpdates = await collectApiKeys(selected, { ...envNow, ...missingEnvUpdates })
    envUpdates = { ...envUpdates, ...newKeyUpdates }
  }

  // 7. 选默认模型（在并集中选）
  logSection('默认模型')
  const allProvidersForModel = [
    ...selected,
    // 已存在且 catalog 里有的 provider 也作为候选源
    ...existingRows
      .filter((r) => r.isInCatalog && !selected.find((s) => s.id === r.id))
      .map((r) => ({ id: r.id, name: r.name })),
  ]
  const defaultModel =
    allProvidersForModel.length > 0
      ? await pickDefaultModel(catalog, allProvidersForModel, existing.model)
      : existing.model || ''

  // 8. 构造新 opencode.json：从 catalog 取完整字段写入，保留已有 provider
  const nextProvider = { ...existing.provider }
  for (const it of selected) {
    if (nextProvider[it.id]) continue // 已存在的不覆盖（用户可能手动调过）
    nextProvider[it.id] = buildProviderConfig(catalog, it.id)
  }
  const nextConfig = {
    ...existing,
    provider: nextProvider,
  }
  if (defaultModel) nextConfig.model = defaultModel

  // 9. 落盘
  logSection('写入文件')
  // opencode.json：仅在结构有变化时写
  const configChanged =
    JSON.stringify(existing) !== JSON.stringify(nextConfig) || existing.model !== nextConfig.model
  if (configChanged) {
    writeOpencodeJson(nextConfig)
    log(`已写入 ${path.relative(ROOT, OPENCODE_JSON)}`, 'ok')
  } else {
    log(`${path.relative(ROOT, OPENCODE_JSON)} 无变化`, 'info')
  }

  if (Object.keys(envUpdates).length > 0) {
    const { updated, added } = upsertEnvFile(SERVER_ENV_FILE, envUpdates)
    const parts = []
    if (added.length > 0) parts.push(`新增 ${added.length} 项`)
    if (updated.length > 0) parts.push(`更新 ${updated.length} 项`)
    log(`已写入 ${path.relative(ROOT, SERVER_ENV_FILE)} (${parts.join('，')})`, 'ok')
  } else {
    log(`没有新的 env 变更`, 'info')
  }

  // 9. Summary
  console.log('')
  console.log(`${colors.bold}${colors.green}✓ 完成${colors.reset}`)
  console.log('')
  console.log(`${colors.dim}下一步：${colors.reset}`)
  console.log(`  1) 重启 server（${colors.bold}pnpm dev:server${colors.reset} 或生产环境重启）`)
  console.log(`  2) 访问前端 OpenCode agent，在模型下拉里应看到新模型`)
  console.log(`  3) 如需 whitelist / 自定义 baseURL / 非 catalog provider，请手动编辑 ${colors.bold}.opencode/opencode.json${colors.reset}`)
  console.log('')
}

main()
  .then(() => {
    if (_rl) _rl.close()
  })
  .catch((e) => {
    if (_rl) _rl.close()
    console.error(e)
    process.exit(1)
  })
