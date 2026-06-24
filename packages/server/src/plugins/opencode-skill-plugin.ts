/**
 * OpenCode Sandbox Skill Loader Plugin
 *
 * 扫描远端 SCF 沙箱内的 skill 目录，将 SKILL.md 加载为 opencode 的 embedded skill。
 *
 * 环境变量（由 opencode-acp-runtime.ts 在 spawn 时注入）：
 *   SANDBOX_BASE_URL            — 沙箱 HTTP 端点
 *   SANDBOX_AUTH_HEADERS_JSON   — 认证头 JSON 字符串
 *   SANDBOX_WORKSPACE_ROOT      — 沙箱工作目录（默认 /home/user）
 *
 * 扫描的 4 个沙箱目录：
 *   skills/, .skills/, .codebuddy/skills/, .agents/skills/
 *
 * 共享逻辑在 skill-loader-shared.ts 中，仅沙箱配置获取方式不同
 * （通过 SANDBOX_BASE_URL 而非 CODEBUDDY_TOOL_OVERRIDE_CONFIG）。
 */

import { define } from '@opencode-ai/plugin/v2/promise'
import { SkillDefinition, SandboxConfig, scanAllSandboxSkillsDirs } from '../util/skill-loader-shared.js'

function getSandboxConfig(): SandboxConfig | null {
  const baseUrl = process.env.SANDBOX_BASE_URL
  if (!baseUrl) return null
  try {
    const headers = JSON.parse(process.env.SANDBOX_AUTH_HEADERS_JSON || '{}') as Record<string, string>
    return { url: baseUrl.replace(/\/mcp$/, ''), headers }
  } catch {
    return null
  }
}

export default define({
  id: 'opencode-sandbox-skill-loader',
  setup: async (ctx) => {
    const sandbox = getSandboxConfig()
    if (!sandbox) {
      console.error('[SandboxSkillLoader] SANDBOX_BASE_URL not set, skipping sandbox skill scan')
      return
    }

    const sandboxCwd = process.env.SANDBOX_WORKSPACE_ROOT || '/home/user'

    console.error(`[SandboxSkillLoader] Scanning sandbox skills from ${sandboxCwd}...`)

    const allSkills = await scanAllSandboxSkillsDirs(sandbox, sandboxCwd, 'project').catch(
      () => [] as SkillDefinition[],
    )

    if (allSkills.length === 0) {
      console.error('[SandboxSkillLoader] No sandbox skills found')
      return
    }

    console.error(`[SandboxSkillLoader] Loading ${allSkills.length} skill(s) from sandbox`)

    await ctx.skill.transform((draft) => {
      for (const skill of allSkills) {
        draft.source({
          type: 'embedded',
          skill: {
            name: skill.name,
            description: skill.description,
            location: skill.location,
            content: skill.instructions,
          },
        })
      }
    })
    ctx.skill.reload()
  },
})
