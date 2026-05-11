/**
 * OpenCode model catalog 解析
 *
 * 用途：
 *   - 拉取 models.dev/api.json（opencode 自身使用的权威 provider/model catalog）
 *   - 合并 .opencode/opencode.json 中的 provider override（与 opencode 官方行为对齐）
 *   - 按 env/凭证可用性过滤，展开为前端消费的 ModelInfo[]
 *
 * 关键事实（读 sst/opencode packages/opencode/src/provider/provider.ts）：
 *   1. database = models.dev/api.json 转换结果（含 env/npm/api/name/models 完整元数据）
 *   2. opencode.json 的 provider 对该 database 做深合并 override
 *   3. provider 是否"生效" = provider.env 里任一 key 被设 OR options.apiKey 设置 OR auth.json 命中
 *   4. 最终展开 provider.models 为前端的模型列表
 *
 * 本文件实现 (3)(4) 的简化版，不处理 auth.json（仅项目级 .env），不处理 plugin 钩子。
 *
 * 缓存策略：进程内内存缓存，首次调用时惰性拉取。失败返 null（降级为只读 opencode.json）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ModelInfo } from '@coder/shared'

const MODELS_DEV_CATALOG_URL = process.env.MODELS_DEV_CATALOG_URL || 'https://models.dev/api.json'
const CATALOG_FETCH_TIMEOUT_MS = Number(process.env.MODELS_DEV_FETCH_TIMEOUT_MS) || 5_000

// ─── Types (对齐 models.dev schema，仅保留我们要消费的字段) ─────────────

export interface ModelsDevModel {
  id?: string
  name?: string
  family?: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  temperature?: boolean
  modalities?: {
    input?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>
    output?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>
  }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
  status?: 'alpha' | 'beta' | 'deprecated'
  options?: Record<string, unknown>
  headers?: Record<string, string>
  variants?: Record<string, unknown>
  [key: string]: unknown
}

export interface ModelsDevProvider {
  id: string
  name: string
  npm?: string
  api?: string | null
  doc?: string
  env?: string[]
  models: Record<string, ModelsDevModel>
  options?: Record<string, unknown>
  whitelist?: string[]
  blacklist?: string[]
  [key: string]: unknown
}

export type Catalog = Record<string, ModelsDevProvider>

// ─── Module-level cache ──────────────────────────────────────────────────

let _catalogPromise: Promise<Catalog | null> | null = null

/**
 * 拉取 models.dev catalog（进程内缓存）。
 *
 * - 失败返 null（不抛），调用方自行降级
 * - 可通过 MODELS_DEV_CATALOG_URL env 覆盖地址（用于测试或私有镜像）
 * - 可通过 reset() 清缓存（测试场景）
 */
export function fetchCatalog(): Promise<Catalog | null> {
  if (_catalogPromise) return _catalogPromise
  _catalogPromise = (async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS)
      const res = await fetch(MODELS_DEV_CATALOG_URL, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) {
        console.warn('[opencode-catalog] fetch non-ok status:', res.status)
        return null
      }
      const raw = (await res.json()) as unknown
      if (!raw || typeof raw !== 'object') return null
      // 轻量校验：顶层必须是对象，每个 value 至少有 id + models
      const out: Catalog = {}
      for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
        if (!p || typeof p !== 'object') continue
        const prov = p as Partial<ModelsDevProvider>
        if (!prov.models || typeof prov.models !== 'object') continue
        out[id] = {
          id,
          name: prov.name ?? id,
          npm: prov.npm,
          api: prov.api ?? null,
          doc: prov.doc,
          env: Array.isArray(prov.env) ? prov.env : [],
          models: prov.models,
          options: (prov.options as Record<string, unknown>) ?? undefined,
        }
      }
      return out
    } catch (e) {
      console.warn('[opencode-catalog] fetch failed:', (e as Error).message)
      return null
    }
  })()
  return _catalogPromise
}

/** 清模块级缓存（测试用） */
export function resetCatalogCache(): void {
  _catalogPromise = null
}

// ─── Merge & Filter ──────────────────────────────────────────────────────

/**
 * 深合并（仅处理 plain object，数组和基础类型用 override 覆盖）。
 * 对齐 opencode 源码的 mergeDeep 语义（足够简化版）。
 */
function mergeDeep<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue
    const existing = out[k]
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[k] = mergeDeep(existing as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out as T
}

/**
 * opencode.json 的 provider 字段合并到 catalog。
 *
 * 行为对齐 opencode 源码第一次合并（provider.ts fromCfg 阶段）：
 *   - catalog 有该 provider：深合并（option/models 均合并）
 *   - catalog 没有：视为完全自定义 provider，直接写入
 */
export function mergeProviders(catalog: Catalog, override: Record<string, unknown>): Catalog {
  const out: Catalog = { ...catalog }
  for (const [id, cfgRaw] of Object.entries(override ?? {})) {
    if (!cfgRaw || typeof cfgRaw !== 'object') continue
    const cfg = cfgRaw as Partial<ModelsDevProvider>
    const base: ModelsDevProvider = out[id] ?? {
      id,
      name: cfg.name ?? id,
      npm: cfg.npm,
      api: cfg.api ?? null,
      env: [],
      models: {},
    }
    out[id] = mergeDeep(base, cfg as Partial<ModelsDevProvider>)
  }
  return out
}

/**
 * 解析 options.apiKey 中的 `{env:VAR}` 占位符，判断是否可用。
 * 如果是明文字符串（非占位符且非空），视为可用。
 */
function isOptionsApiKeyResolved(apiKey: unknown, env: Record<string, string | undefined>): boolean {
  if (typeof apiKey !== 'string' || !apiKey) return false
  const m = apiKey.match(/^\{env:([^}]+)\}$/)
  if (m) return !!env[m[1]]
  return true
}

/**
 * 过滤出"对当前进程可用"的 provider + model：
 *   - provider.env 任一 key 在 env 中非空，或
 *   - provider.options.apiKey 已解析（占位符对应的 env 存在，或明文值）
 *   - 再按 whitelist/blacklist 过滤 model
 *   - 过滤 status=deprecated
 */
export function filterAvailable(
  providers: Catalog,
  env: Record<string, string | undefined>,
  opts: { enabledProviders?: string[]; disabledProviders?: string[] } = {},
): Catalog {
  const out: Catalog = {}
  const enabled = opts.enabledProviders ? new Set(opts.enabledProviders) : null
  const disabled = new Set(opts.disabledProviders ?? [])

  for (const [id, p] of Object.entries(providers)) {
    if (disabled.has(id)) continue
    if (enabled && !enabled.has(id)) continue

    const hasEnvKey = (p.env ?? []).some((k) => !!env[k])
    const optApiKey = (p.options as { apiKey?: unknown } | undefined)?.apiKey
    const hasOptionsKey = isOptionsApiKeyResolved(optApiKey, env)

    if (!hasEnvKey && !hasOptionsKey) continue

    const wl = p.whitelist && p.whitelist.length > 0 ? new Set(p.whitelist) : null
    const bl = new Set(p.blacklist ?? [])

    const filteredModels: Record<string, ModelsDevModel> = {}
    for (const [mid, m] of Object.entries(p.models)) {
      if (!m || typeof m !== 'object') continue
      if (m.status === 'deprecated') continue
      if (wl && !wl.has(mid)) continue
      if (bl.has(mid)) continue
      filteredModels[mid] = m
    }
    if (Object.keys(filteredModels).length === 0) continue

    out[id] = { ...p, models: filteredModels }
  }
  return out
}

// ─── Flatten ─────────────────────────────────────────────────────────────

/** 把 provider map 展开为前端消费的 ModelInfo[] */
export function flattenModels(providers: Catalog): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const [pid, p] of Object.entries(providers)) {
    for (const [mid, m] of Object.entries(p.models)) {
      out.push({
        id: `${pid}/${mid}`,
        name: m.name ?? mid,
        vendor: p.name ?? pid,
        contextLimit: m.limit?.context,
        outputLimit: m.limit?.output,
        inputModalities: m.modalities?.input,
        outputModalities: m.modalities?.output,
        toolCall: m.tool_call,
        reasoning: m.reasoning,
        attachment: m.attachment,
        cost:
          m.cost && typeof m.cost.input === 'number' && typeof m.cost.output === 'number'
            ? {
                input: m.cost.input,
                output: m.cost.output,
                cacheRead: m.cost.cache_read,
                cacheWrite: m.cost.cache_write,
              }
            : undefined,
        status: m.status,
      })
    }
  }
  return out
}

// ─── High-level helper ───────────────────────────────────────────────────

export interface OpencodeJson {
  $schema?: string
  model?: string
  provider?: Record<string, unknown>
  enabled_providers?: string[]
  disabled_providers?: string[]
  [key: string]: unknown
}

/**
 * 安全读 .opencode/opencode.json。文件不存在或解析失败返 null（调用方降级）。
 */
export function readOpencodeJson(opencodeConfigDir: string): OpencodeJson | null {
  try {
    const p = path.join(opencodeConfigDir, 'opencode.json')
    if (!fs.existsSync(p)) return null
    const raw = fs.readFileSync(p, 'utf-8')
    return JSON.parse(raw) as OpencodeJson
  } catch (e) {
    console.warn('[opencode-catalog] readOpencodeJson failed:', (e as Error).message)
    return null
  }
}

/**
 * 主入口：合并 catalog + opencode.json，按 env 过滤，返回 ModelInfo[]。
 *
 * 当 catalog 拉取失败时降级为"只读 opencode.json 中显式定义的自定义 provider"，
 * 以保证最小可用（与改造前行为近似一致）。
 */
export async function resolveModels(opts: {
  opencodeConfigDir: string
  env: Record<string, string | undefined>
}): Promise<ModelInfo[]> {
  const config = readOpencodeJson(opts.opencodeConfigDir)
  const catalog = await fetchCatalog()

  // 降级：catalog 不可用 + config 不可用 → 空列表
  if (!catalog && !config) return []

  // catalog 不可用：把 config.provider 当作全部自定义 provider（需要用户填了完整字段）
  const baseCatalog: Catalog = catalog ?? {}
  const merged = mergeProviders(baseCatalog, (config?.provider as Record<string, unknown>) ?? {})
  const available = filterAvailable(merged, opts.env, {
    enabledProviders: config?.enabled_providers,
    disabledProviders: config?.disabled_providers,
  })
  return flattenModels(available)
}
