/**
 * 通用 MCP Policy 加载器工厂。
 *
 * 用法：
 *   const __dirname = path.dirname(fileURLToPath(import.meta.url))
 *   const loader = createPolicyLoader<MyExtra>(__dirname)
 *
 * 约定：
 *   - 文件名 = 工具名（不含扩展名）
 *   - 文件名以 `_` 开头：跳过（视为内部/共享代码）
 *   - 文件需 named export `policy: McpPolicy`
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { McpPolicy } from './types.js'

export interface PolicyLoader<Extra> {
  /** 加载一次（重复调用幂等） */
  loadAll(): Promise<void>
  /** 同步取一个工具的 policy */
  getPolicy(toolName: string): McpPolicy<Extra> | undefined
  /** 列出所有 policy（按 toolName 排序） */
  listPolicies(): Array<{ toolName: string; policy: McpPolicy<Extra> }>
  /**
   * 列出所有"新增工具"（policy.augment 已设置）。
   * 路由层用这个把它们注册到 MCP server。
   */
  listAugmentedTools(): Array<{
    toolName: string
    description: string
    inputSchema: NonNullable<McpPolicy<Extra>['augment']>['inputSchema']
    policy: McpPolicy<Extra>
  }>
  /**
   * 判断一个**原生工具**是否应当暴露给 AI。
   * 综合 allowList / denyList / policy.hidden=true。
   */
  isToolAllowed(toolName: string): boolean
}

export interface PolicyLoaderOptions {
  /** 黑名单：列表中的工具不会暴露给 AI */
  denyList?: string[]
  /** 白名单：非空时，**只**暴露列表中的工具 */
  allowList?: string[]
}

/** tsup bundles server into dist/*.js; avoid scanning chunk/hash artifacts as policies. */
export function isBundledServerArtifact(fileName: string): boolean {
  if (fileName === 'index.js') return true
  if (fileName.startsWith('chunk-')) return true
  if (/^[a-z0-9_.-]+-[A-Z0-9]{6,}\.(js|mjs)$/.test(fileName)) return true
  return false
}

export function createPolicyLoader<Extra = Record<string, unknown>>(
  /** 扫描目录的绝对路径（一般是 path.dirname(fileURLToPath(import.meta.url))） */
  dir: string,
  /** 日志前缀（便于区分不同 MCP 后端） */
  logTag: string = 'mcp-policies',
  /** 全局过滤配置 */
  options: PolicyLoaderOptions = {},
  /** When set (recommended for bundled production), skip filesystem scan entirely. */
  staticPolicies?: Record<string, McpPolicy<Extra>>,
): PolicyLoader<Extra> {
  const policyMap = new Map<string, McpPolicy<Extra>>()
  let loaded = false

  const allowSet = options.allowList && options.allowList.length > 0 ? new Set(options.allowList) : null
  const denySet = new Set(options.denyList ?? [])

  return {
    getPolicy(toolName) {
      return policyMap.get(toolName)
    },
    listPolicies() {
      return [...policyMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([toolName, policy]) => ({ toolName, policy }))
    },
    listAugmentedTools() {
      return [...policyMap.entries()]
        .filter(([, policy]) => !!policy.augment)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([toolName, policy]) => ({
          toolName,
          description: policy.augment!.description,
          inputSchema: policy.augment!.inputSchema,
          policy,
        }))
    },
    isToolAllowed(toolName) {
      if (allowSet && !allowSet.has(toolName)) return false
      if (denySet.has(toolName)) return false
      const policy = policyMap.get(toolName)
      if (policy?.hidden === true) return false
      return true
    },
    async loadAll() {
      if (loaded) return
      loaded = true

      if (staticPolicies) {
        for (const [toolName, policy] of Object.entries(staticPolicies)) {
          policyMap.set(toolName, policy)
          console.log(`[${logTag}] loaded:`, toolName)
        }
        return
      }

      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch (err) {
        console.warn(`[${logTag}] policy directory not readable:`, dir, err)
        return
      }

      const candidates = entries.filter((name) => {
        if (name.startsWith('_')) return false
        if (isBundledServerArtifact(name)) return false
        return name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.mjs')
      })

      for (const file of candidates) {
        const toolName = file.replace(/\.(ts|js|mjs)$/, '')
        const fullPath = path.join(dir, file)
        try {
          const mod = (await import(pathToFileURL(fullPath).href)) as { policy?: McpPolicy<Extra> }
          if (!mod.policy) {
            console.warn(`[${logTag}] file missing named export 'policy':`, file)
            continue
          }
          policyMap.set(toolName, mod.policy)
          console.log(`[${logTag}] loaded:`, toolName)
        } catch (err) {
          console.error(`[${logTag}] failed to load policy file:`, file, err)
        }
      }
    },
  }
}
