/**
 * Skill Loader Override
 *
 * CLI 端 SkillExtensionLoader 三个核心方法的覆盖实现。
 * 通过 patch 后的 codebuddy-headless.js 注入，环境变量:
 *   CODEBUDDY_SKILL_LOADER_OVERRIDE=<编译后此文件的绝对路径>
 *
 * 覆盖函数签名（最后一个参数 originalFn 由 patch hook 自动注入）：
 *   loadSkills(originalFn)
 *   scanSkillsDirectory(dir, source, originalFn)
 *   parseSkillFile(filePath, baseDir, source, originalFn)
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, relative, basename, dirname } from 'path'
import matter from 'gray-matter'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SkillDefinition {
  name: string
  description: string
  instructions: string
  baseDirectory: string
  allowedTools?: string[]
  source: 'project' | 'user'
  location: string
  color: string
  disableModelInvocation?: boolean
  context?: string
  agent?: string
  userInvocable?: boolean
}

type OriginalLoadSkills = () => Promise<SkillDefinition[]>
type OriginalScanSkillsDirectory = (dir: string, source: string) => Promise<SkillDefinition[]>
type OriginalParseSkillFile = (filePath: string, baseDir: string, source: string) => SkillDefinition | undefined

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Run async tasks in batches to avoid overwhelming the sandbox with too many concurrent requests. */
async function batchedMap<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

function parseListField(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

function generateColorFromName(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue}, 65%, 55%)`
}

function extractFrontMatterWithContent(raw: string): {
  data: Record<string, any>
  content: string
} {
  const { data, content } = matter(raw)
  return { data, content }
}

// ─── Skills 目录路径 ─────────────────────────────────────────────────────────

/** 项目根目录下的 skills/（通过 npx skills add 安装的领域 skill） */
function getProjectRootSkillsDir(): string {
  return join(process.cwd(), 'skills')
}

/** .codebuddy/skills/（IDE 管理的 skill） */
function getProjectSkillsDir(): string {
  return join(process.cwd(), '.codebuddy', 'skills')
}

function getHomeSkillsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return join(home, '.codebuddy', 'skills')
}

// ─── Local FS Scanning ────────────────────────────────────────────────────────

function parseSkillFromRaw(
  raw: string,
  filePath: string,
  baseDir: string,
  source: 'project' | 'user',
): SkillDefinition | undefined {
  try {
    const { data: frontmatter, content } = extractFrontMatterWithContent(raw)
    const relPath = relative(baseDir, filePath)
    const dirName = basename(relPath.replace('/SKILL.md', ''))
    const name = frontmatter.name || dirName
    let description = frontmatter.description || name
    const sourceLabel = `(${source})`
    if (!description.includes(sourceLabel)) {
      description = `${description} ${sourceLabel}`
    }
    const allowedToolsList = parseListField(frontmatter['allowed-tools'])
    return {
      name,
      description,
      instructions: content.trim(),
      baseDirectory: dirname(filePath),
      allowedTools: allowedToolsList.length > 0 ? allowedToolsList : undefined,
      source,
      location: filePath,
      color: generateColorFromName(name),
      disableModelInvocation: frontmatter['disable-model-invocation'],
      context: frontmatter.context,
      agent: frontmatter.agent,
      userInvocable: frontmatter['user-invocable'],
    }
  } catch {
    return undefined
  }
}

function scanLocalSkillsDirectory(dir: string, source: 'project' | 'user'): SkillDefinition[] {
  const skills: SkillDefinition[] = []
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          const skillFile = join(fullPath, 'SKILL.md')
          if (existsSync(skillFile)) {
            const raw = readFileSync(skillFile, 'utf-8')
            const skill = parseSkillFromRaw(raw, skillFile, dir, source)
            if (skill) skills.push(skill)
          }
        } else if (entry === 'SKILL.md') {
          const raw = readFileSync(fullPath, 'utf-8')
          const skill = parseSkillFromRaw(raw, fullPath, dir, source)
          if (skill) skills.push(skill)
        }
      } catch {
        // skip individual entries on error
      }
    }
  } catch {
    // directory unreadable
  }
  return skills
}

// ─── Sandbox HTTP API Helpers（用于远端 skills 扫描）───────────────────────

interface SandboxConfig {
  url: string
  headers?: Record<string, string>
}

function getSandboxConfig(): SandboxConfig | null {
  const configStr = process.env.CODEBUDDY_TOOL_OVERRIDE_CONFIG
  if (!configStr) return null
  try {
    const config = JSON.parse(configStr)
    return {
      url: (config.url || '').replace(/\/mcp$/, ''),
      headers: config.headers || {},
    }
  } catch {
    return null
  }
}

async function sandboxReadFile(sandbox: SandboxConfig, filePath: string): Promise<string | null> {
  try {
    const res = await fetch(`${sandbox.url}/api/tools/read?from=skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sandbox.headers },
      body: JSON.stringify({ path: filePath }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as any
    if (!data.success) return null
    return data.result?.content ?? null
  } catch {
    return null
  }
}

/** Find SKILL.md paths under a directory via 沙箱业务镜像 /api/tools/glob. */
async function sandboxFindSkillMdPaths(sandbox: SandboxConfig, dirPath: string): Promise<string[]> {
  try {
    const res = await fetch(`${sandbox.url}/api/tools/glob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sandbox.headers },
      body: JSON.stringify({ pattern: '**/SKILL.md', path: dirPath }),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { success?: boolean; result?: { output?: string } }
    if (!data.success || !data.result?.output || data.result.output === 'No files found') return []
    return data.result.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('('))
  } catch {
    return []
  }
}

async function scanSandboxSkillsDirectory(
  sandbox: SandboxConfig,
  dir: string,
  source: 'project' | 'user',
): Promise<SkillDefinition[]> {
  const skillFilePaths = await sandboxFindSkillMdPaths(sandbox, dir)
  if (skillFilePaths.length === 0) return []

  // Fetch all SKILL.md files in batches of 30, concurrent within each batch
  const SKILL_READ_BATCH = 30
  const results = await batchedMap(skillFilePaths, SKILL_READ_BATCH, async (skillFile) => {
    const raw = await sandboxReadFile(sandbox, skillFile)
    if (!raw) return null
    return parseSkillFromRaw(raw, skillFile, dir, source)
  })

  return results.filter((s): s is SkillDefinition => s !== null)
}

// ─── 三个核心导出方法 ────────────────────────────────────────────────────────

/**
 * loadSkills — 加载所有 skills（bundled + 本地项目级 + 本地用户级 + 远端沙箱）
 */
export async function loadSkills(originalFn: OriginalLoadSkills): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  // 0. 容器预装 skills（CODEBUDDY_BUNDLED_SKILLS_DIR 或 /app/skills）
  const bundledDir = process.env.CODEBUDDY_BUNDLED_SKILLS_DIR || '/app/skills'
  if (existsSync(bundledDir)) {
    const bundledSkills = scanLocalSkillsDirectory(bundledDir, 'project')
    if (bundledSkills.length > 0) {
      skills.push(...bundledSkills)
    }
  }

  // 1. 项目根 skills/（领域 skill）
  const rootSkillsDir = getProjectRootSkillsDir()
  if (existsSync(rootSkillsDir)) {
    const rootSkills = scanLocalSkillsDirectory(rootSkillsDir, 'project')
    skills.push(...rootSkills)
  }

  // 2. .codebuddy/skills/（IDE 管理的 skill）
  const projectDir = getProjectSkillsDir()
  if (existsSync(projectDir)) {
    const projectSkills = scanLocalSkillsDirectory(projectDir, 'project')
    skills.push(...projectSkills)
  }

  // 3. 本地用户级 skills
  const homeDir = getHomeSkillsDir()
  if (existsSync(homeDir)) {
    const homeSkills = scanLocalSkillsDirectory(homeDir, 'user')
    skills.push(...homeSkills)
  }

  // 4. 远端沙箱 skills（通过 CODEBUDDY_TOOL_OVERRIDE_CONFIG 读取连接配置）
  const sandbox = getSandboxConfig()
  if (sandbox && sandbox.url) {
    const sandboxCwd = process.env.CODEBUDDY_SANDBOX_CWD || '/home/user'

    // Scan both sandbox skill directories concurrently (2 ListDir + N reads in parallel)
    const [remoteSkills, remoteCbSkills] = await Promise.all([
      scanSandboxSkillsDirectory(sandbox, `${sandboxCwd}/skills`, 'project').catch(() => []),
      scanSandboxSkillsDirectory(sandbox, `${sandboxCwd}/.codebuddy/skills`, 'project').catch(() => []),
    ])

    if (remoteSkills.length > 0) {
      skills.push(...remoteSkills)
      console.error(`[SkillLoaderOverride] Loaded ${remoteSkills.length} skill(s) from sandbox ${sandboxCwd}/skills`)
    }
    if (remoteCbSkills.length > 0) {
      skills.push(...remoteCbSkills)
      console.error(
        `[SkillLoaderOverride] Loaded ${remoteCbSkills.length} skill(s) from sandbox ${sandboxCwd}/.codebuddy/skills`,
      )
    }
  }

  console.error(`[SkillLoaderOverride] Total: ${skills.length} skill(s) loaded`)
  return skills
}

/**
 * scanSkillsDirectory — 扫描指定目录下的所有 SKILL.md（本地 fs）
 */
export async function scanSkillsDirectory(
  dir: string,
  source: string,
  _originalFn: OriginalScanSkillsDirectory,
): Promise<SkillDefinition[]> {
  return scanLocalSkillsDirectory(dir, source as 'project' | 'user')
}

/**
 * parseSkillFile — 解析单个 SKILL.md 文件（本地 fs）
 */
export function parseSkillFile(
  filePath: string,
  baseDir: string,
  source: string,
  _originalFn: OriginalParseSkillFile,
): SkillDefinition | undefined {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return parseSkillFromRaw(raw, filePath, baseDir, source as 'project' | 'user')
  } catch {
    return undefined
  }
}
