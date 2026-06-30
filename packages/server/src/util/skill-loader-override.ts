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
import { join } from 'path'
import {
  SkillDefinition,
  SandboxConfig,
  parseSkillFromRaw,
  scanSandboxSkillsDirectory,
  SKILL_DIR_RELS,
} from './skill-loader-shared.js'

type OriginalLoadSkills = () => Promise<SkillDefinition[]>
type OriginalScanSkillsDirectory = (dir: string, source: string) => Promise<SkillDefinition[]>
type OriginalParseSkillFile = (filePath: string, baseDir: string, source: string) => SkillDefinition | undefined

// ─── Skills 目录路径 ─────────────────────────────────────────────────────────

/** 项目根目录下的 skills/（通过 npx skills add 安装的领域 skill） */
export function getProjectRootSkillsDir(): string {
  return join(process.cwd(), 'skills')
}

/** .codebuddy/skills/（IDE 管理的 skill） */
export function getProjectSkillsDir(): string {
  return join(process.cwd(), '.codebuddy', 'skills')
}

export function getHomeSkillsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return join(home, '.codebuddy', 'skills')
}

// ─── Local FS Scanning ────────────────────────────────────────────────────────

export function scanLocalSkillsDirectory(dir: string, source: 'project' | 'user'): SkillDefinition[] {
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

// ─── Sandbox Config ─────────────────────────────────────────────────────────

export function getSandboxConfig(): SandboxConfig | null {
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

    // Scan sandbox skill directories concurrently (4 ListDir + N reads in parallel)
    const results = await Promise.all(
      SKILL_DIR_RELS.map((rel) =>
        scanSandboxSkillsDirectory(sandbox, `${sandboxCwd}/${rel}`, 'project').catch(() => [] as SkillDefinition[]),
      ),
    )

    for (let i = 0; i < SKILL_DIR_RELS.length; i++) {
      const batch = results[i]
      if (batch.length > 0) {
        skills.push(...batch)
        console.error(
          `[SkillLoaderOverride] Loaded ${batch.length} skill(s) from sandbox ${sandboxCwd}/${SKILL_DIR_RELS[i]}`,
        )
      }
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
