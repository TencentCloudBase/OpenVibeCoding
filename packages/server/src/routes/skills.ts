import { Hono } from 'hono'
import { requireAuth, requireUserEnv, type AppEnv } from '../middleware/auth'
import { listSkills, uninstallSkill, initSkills } from '../services/skill-manager'
import { getDb } from '../db/index.js'
import { scfSandboxManager, type SandboxInstance } from '../sandbox/index.js'
import { archiveToGit } from '../sandbox/git-archive.js'
import { listStorageFiles } from '../cloudbase/storage.js'
import type { CloudBaseCredentials } from '../cloudbase/database.js'

const skills = new Hono<AppEnv>()

// ─── Helper: 通过 taskId 解析沙箱连接配置 ──────────────────────────────────────

interface SandboxResolved {
  sandboxConfig: { url: string; headers: Record<string, string> }
  sandboxCwd: string
  sandboxInstance: SandboxInstance
}

/**
 * 根据 taskId + envId 获取对应沙箱的连接配置和工作目录。
 * 找不到时返回 null。
 */
async function resolveSandboxForTask(taskId: string, envId: string): Promise<SandboxResolved | null> {
  const task = await getDb().tasks.findById(taskId)
  if (!task || !task.sandboxId) return null

  const scfSessionId = task.sandboxSessionId || envId
  const sandboxInstance = await scfSandboxManager.getExisting(taskId, scfSessionId, {
    sandboxMode: (task.sandboxMode || 'isolated') as 'shared' | 'isolated',
    isCodingMode: (task as any).mode === 'coding',
  })
  if (!sandboxInstance) return null

  const sandboxConfig = await sandboxInstance.getToolOverrideConfig()
  if (!sandboxConfig || !sandboxConfig.url) return null

  return { sandboxConfig, sandboxCwd: `/tmp/workspace/${taskId}`, sandboxInstance }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /api/skills - List all skills for user
// 支持 ?taskId=xxx 查询参数，传入后会额外扫描对应 workspace 下的 skills
skills.get('/', requireUserEnv, async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr

  const { envId } = c.get('userEnv')!
  const taskId = c.req.query('taskId')

  const resolved = taskId ? await resolveSandboxForTask(taskId, envId) : null
  const items = await listSkills(resolved?.sandboxConfig, resolved?.sandboxCwd)
  return c.json({
    skills: items.filter(Boolean).map(({ name, description }) => ({
      name,
      description: description.replace(/\s*\((project|user)\)$/, ''),
    })),
  })
})

// GET /api/skills/:skillName - Get single skill by name
// 支持 ?taskId=xxx 查询参数，传入后会额外扫描对应 workspace 下的 skills
skills.get('/:skillName', requireUserEnv, async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr

  const { envId } = c.get('userEnv')!
  const { skillName } = c.req.param()
  const taskId = c.req.query('taskId')

  const resolved = taskId ? await resolveSandboxForTask(taskId, envId) : null
  const items = await listSkills(resolved?.sandboxConfig, resolved?.sandboxCwd)
  const skill = items.find((s) => s && s.name === skillName)
  if (!skill) return c.json({ error: 'Skill not found' }, 404)
  return c.json({
    ...skill,
    description: skill.description.replace(/\s*\((project|user)\)$/, ''),
  })
})

// POST /api/skills/init - Initialize skills resources from cloud storage into sandbox
// 将云存储 skills 目录下的资源下载到沙箱的 /tmp/workspace/{taskId}/.agents/skills 目录
// body: { taskId: string, skillNames: string[] }
skills.post('/init', requireUserEnv, async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr

  const { envId, userId, credentials } = c.get('userEnv')!
  const body = await c.req.json().catch(() => ({}))
  const { taskId, skillNames } = body as { taskId?: string; skillNames?: string[] }
  if (!taskId) {
    return c.json({ error: 'Missing taskId' }, 400)
  }
  if (!Array.isArray(skillNames) || skillNames.length === 0) {
    return c.json({ error: 'Missing or empty skillNames' }, 400)
  }

  // 校验每个 skill 目录下是否存在 SKILL.md
  const creds: CloudBaseCredentials = {
    envId,
    secretId: credentials.secretId,
    secretKey: credentials.secretKey,
    sessionToken: credentials.sessionToken,
  }
  const invalidSkills: string[] = []
  await Promise.all(
    skillNames.map(async (name) => {
      const files = await listStorageFiles(creds, `${userId}/skills/${name}/`)
      const hasSkillMd = files.some((f) => !f.isDir && f.name === 'SKILL.md')
      if (!hasSkillMd) invalidSkills.push(name)
    }),
  )
  if (invalidSkills.length > 0) {
    return c.json({ error: `Invalid skills (missing SKILL.md): ${invalidSkills.join(', ')}` }, 400)
  }

  const resolved = await resolveSandboxForTask(taskId, envId)
  if (!resolved) {
    return c.json({ error: 'Sandbox not available' }, 503)
  }

  // 轻量凭证注入：用 PUT /api/session/env 确保沙箱 session 中有有效凭证，
  // 否则沙箱重建后 mcporter 因缺少凭证无法访问云存储。
  try {
    const credPayload: Record<string, string> = { CLOUDBASE_ENV_ID: envId }
    if (credentials.secretId) credPayload.TENCENTCLOUD_SECRETID = credentials.secretId
    if (credentials.secretKey) credPayload.TENCENTCLOUD_SECRETKEY = credentials.secretKey
    if (credentials.sessionToken) credPayload.TENCENTCLOUD_SESSIONTOKEN = credentials.sessionToken
    await fetch(`${resolved.sandboxConfig.url}/api/session/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...resolved.sandboxConfig.headers },
      body: JSON.stringify(credPayload),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    console.warn('[skills/init] session/env credential injection failed')
  }

  const result = await initSkills(resolved.sandboxConfig, taskId, skillNames, userId)
  if (!result.success) {
    return c.json({ error: result.error }, 500)
  }

  // 归档：确保 skills 文件在沙箱恢复后不会丢失
  archiveToGit(resolved.sandboxInstance, taskId, 'init skills').catch(() => {
    // Non-critical: skills are saved in sandbox, git push is best-effort
  })

  return c.json({ success: true }, 201)
})

// POST /api/skills/delete - Uninstall one or more skills by names (unified delete endpoint)
// body: { taskId: string, skillNames: string[] }
// 支持单个删除（传入 1 个 name）和批量删除（传入多个 name）
skills.post('/delete', requireUserEnv, async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr

  const { envId } = c.get('userEnv')!
  const body = await c.req.json().catch(() => ({}))
  const { taskId, skillNames } = body as { taskId?: string; skillNames?: string[] }

  if (!taskId) {
    return c.json({ error: 'Missing taskId' }, 400)
  }
  if (!Array.isArray(skillNames) || skillNames.length === 0) {
    return c.json({ error: 'Missing or empty skillNames' }, 400)
  }

  const resolved = await resolveSandboxForTask(taskId, envId)
  if (!resolved) {
    return c.json({ error: 'Sandbox not available' }, 503)
  }

  const errors: string[] = []
  await Promise.all(
    skillNames.map(async (name) => {
      const result = await uninstallSkill(resolved.sandboxConfig, name, resolved.sandboxCwd)
      if (!result.success) errors.push(name)
    }),
  )

  // 归档：确保卸载操作在沙箱恢复后仍然生效
  archiveToGit(resolved.sandboxInstance, taskId, 'uninstall skills').catch(() => {})

  if (errors.length > 0) {
    return c.json({ success: false, errors }, 207)
  }
  return c.json({ success: true })
})

export default skills
