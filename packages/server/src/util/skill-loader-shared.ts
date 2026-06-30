/**
 * Skill Loader Shared Utilities
 *
 * 被 skill-loader-override.ts 和 opencode-skill-plugin.ts 共享的扫描/解析逻辑。
 * 包含 SkillDefinition 类型、frontmatter 解析、沙箱 HTTP API 扫描等。
 */

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

export interface SandboxConfig {
  url: string
  headers?: Record<string, string>
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Run async tasks in batches to avoid overwhelming the sandbox with too many concurrent requests. */
export async function batchedMap<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

export function parseListField(value: unknown): string[] {
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

export function generateColorFromName(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue}, 65%, 55%)`
}

/**
 * 剥离沙箱 read API 返回内容中的行号前缀。
 * 格式为每行开头的 "数字: " 或 "数字:\t"，例如 "1: ---" → "---"
 * 只有当所有行都匹配该格式时才剥离，否则原样返回（避免误伤正文内容）。
 */
export function stripLineNumbers(content: string): string {
  const lines = content.split('\n')
  const lineNumPattern = /^\d+: /
  const allMatch = lines.every((line) => line === '' || lineNumPattern.test(line))
  if (!allMatch) return content
  return lines.map((line) => (line === '' ? '' : line.replace(/^\d+: /, ''))).join('\n')
}

/**
 * Sanitize YAML frontmatter: convert values containing unquoted colons to block scalars.
 */
export function sanitizeFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith('#') || line.trim() === '' || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === '' || value === '>' || value === '|' || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(':')) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join('\n'))
}

export function extractFrontMatterWithContent(raw: string): {
  data: Record<string, any>
  content: string
} {
  const sanitized = sanitizeFrontmatter(raw)
  const { data, content } = matter(sanitized)
  return { data, content }
}

export function parseSkillFromRaw(
  raw: string,
  filePath: string,
  baseDir: string,
  source: 'project' | 'user',
): SkillDefinition | undefined {
  try {
    const { data: frontmatter, content } = extractFrontMatterWithContent(raw)
    const relPath = filePath.startsWith(baseDir) ? filePath.slice(baseDir.length).replace(/^\//, '') : filePath
    const dirName = relPath.split('/')[0] || relPath.replace('/SKILL.md', '')
    const name = frontmatter.name || dirName
    let description = frontmatter.description || name
    const sourceLabel = `(${source})`
    if (!description.includes(sourceLabel)) {
      description = `${description} ${sourceLabel}`
    }
    const allowedToolsList = parseListField(frontmatter['allowed-tools'])
    const lastSlash = filePath.lastIndexOf('/')
    return {
      name,
      description,
      instructions: content.trim(),
      baseDirectory: lastSlash >= 0 ? filePath.substring(0, lastSlash) : filePath,
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

// ─── Sandbox HTTP API Helpers ───────────────────────────────────────────────

export async function sandboxReadFile(sandbox: SandboxConfig, filePath: string): Promise<string | null> {
  try {
    const res = await fetch(`${sandbox.url}/api/tools/read?from=skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sandbox.headers },
      body: JSON.stringify({ path: filePath }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as any
    if (!data.success) return null
    const raw = data.result?.content ?? null
    if (!raw) return null
    return stripLineNumbers(raw)
  } catch {
    return null
  }
}

export async function sandboxReadDir(
  sandbox: SandboxConfig,
  dirPath: string,
): Promise<Array<{ name: string; isDirectory: boolean }> | null> {
  try {
    const res = await fetch(`${sandbox.url}/e2b-compatible/filesystem.Filesystem/ListDir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sandbox.headers },
      body: JSON.stringify({ path: dirPath, depth: 1 }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { entries?: Array<{ name: string; type: string }> }
    if (!data.entries) return null
    return data.entries.map((e) => ({
      name: e.name,
      isDirectory: e.type === 'FILE_TYPE_DIRECTORY',
    }))
  } catch {
    return null
  }
}

/** 沙箱中默认扫描的 skill 目录相对路径列表（按优先级顺序） */
export const SKILL_DIR_RELS = ['skills', '.skills', '.codebuddy/skills', '.agents/skills'] as const

export type SkillDirRel = (typeof SKILL_DIR_RELS)[number]

/**
 * 批量扫描沙箱中所有默认 skill 目录，返回聚合后的 SkillDefinition 列表。
 * 每个目录扫描失败时静默返回空数组，不会阻塞其他目录。
 */
export async function scanAllSandboxSkillsDirs(
  sandbox: SandboxConfig,
  cwd: string,
  source: 'project' | 'user',
): Promise<SkillDefinition[]> {
  const batches = await Promise.all(
    SKILL_DIR_RELS.map((rel) =>
      scanSandboxSkillsDirectory(sandbox, `${cwd}/${rel}`, source).catch(() => [] as SkillDefinition[]),
    ),
  )
  return batches.flat()
}

export async function scanSandboxSkillsDirectory(
  sandbox: SandboxConfig,
  dir: string,
  source: 'project' | 'user',
): Promise<SkillDefinition[]> {
  const entries = await sandboxReadDir(sandbox, dir)
  if (!entries) return []

  const skillFilePaths: string[] = []
  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`
    if (entry.isDirectory) {
      skillFilePaths.push(`${fullPath}/SKILL.md`)
    } else if (entry.name === 'SKILL.md') {
      skillFilePaths.push(fullPath)
    }
  }

  const SKILL_READ_BATCH = 30
  const results = await batchedMap(skillFilePaths, SKILL_READ_BATCH, async (skillFile) => {
    const raw = await sandboxReadFile(sandbox, skillFile)
    if (!raw) return null
    return parseSkillFromRaw(raw, skillFile, dir, source)
  })

  return results.filter((s): s is SkillDefinition => s !== null)
}
