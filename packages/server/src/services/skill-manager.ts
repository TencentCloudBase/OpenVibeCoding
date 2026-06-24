/**
 * Skill Manager Service
 *
 * 业务逻辑层：skill 的生命周期管理（列表、安装、卸载、启用、禁用）。
 * 底层文件扫描和沙箱交互委托给 util/skill-loader-override.ts。
 */
import { type SkillDefinition, type SandboxConfig, scanAllSandboxSkillsDirs } from '../util/skill-loader-shared.js'

// ─── List Skills ─────────────────────────────────────────────────────────────

/**
 * listSkills — 获取所有 skills（bundled + 本地项目级 + 本地用户级 + 远端沙箱）
 */
export async function listSkills(sandboxConfig?: SandboxConfig, sandboxCwd?: string): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  // 远端沙箱 skills（通过 CODEBUDDY_TOOL_OVERRIDE_CONFIG 读取连接配置）
  if (sandboxConfig && sandboxConfig.url) {
    const cwd = sandboxCwd || '/home/user'
    const remoteSkills = await scanAllSandboxSkillsDirs(sandboxConfig, cwd, 'project').catch(
      () => [] as SkillDefinition[],
    )
    if (remoteSkills.length > 0) skills.push(...remoteSkills)
  }

  return skills
}

// ─── Uninstall Skill ─────────────────────────────────────────────────────────

/**
 * 通过沙箱 bash 删除指定 name 的 skill 目录
 * 先通过 listSkills 查找 skill 获取其 baseDirectory，再执行 rm -rf
 */
export async function uninstallSkill(
  sandbox: SandboxConfig,
  skillName: string,
  sandboxCwd?: string,
): Promise<{ success: boolean; error?: string }> {
  // 1. 查找 skill 获取其 baseDirectory
  const items = await listSkills(sandbox, sandboxCwd)
  const skill = items.find((s) => s && s.name === skillName)
  if (!skill) {
    return { success: false, error: 'Skill not found' }
  }

  const skillDir = skill.baseDirectory
  if (!skillDir) {
    return { success: false, error: 'Skill directory not found' }
  }

  // 2. 安全校验：确保目录在 skills/ / .codebuddy/skills/ / .agents/skills/ 下，防止误删
  const cwd = sandboxCwd || process.env.CODEBUDDY_SANDBOX_CWD || '/home/user'
  const allowedPrefixes = [`${cwd}/skills/`, `${cwd}/.codebuddy/skills/`, `${cwd}/.agents/skills/`]
  const isAllowed = allowedPrefixes.some((prefix) => skillDir.startsWith(prefix))
  if (!isAllowed) {
    return { success: false, error: 'Cannot uninstall skill outside of workspace skills directories' }
  }

  // 3. 删除 skill 目录
  const result = await execSandboxBash(sandbox, `rm -rf "${skillDir}"`)
  if (!result.success) {
    return { success: false, error: 'Failed to remove skill directory' }
  }

  console.log('[SkillManager] Skill uninstalled')
  return { success: true }
}

// ─── Init Skills (from cloud storage) ────────────────────────────────────────

/**
 * 初始化 skills 资源：通过 mcporter 的 downloadDirectory 工具将云存储中指定的 skill 目录
 * 下载到沙箱的 /tmp/workspace/{taskId}/.agents/skills 目录。
 * @param skillNames 要下载的 skill 名称列表
 */
export async function initSkills(
  sandbox: SandboxConfig,
  taskId: string,
  skillNames: string[],
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const skillsDir = `/tmp/workspace/${taskId}/.agents/skills`

  // 1. 确保目标目录存在
  const mkdirResult = await execSandboxBash(sandbox, `mkdir -p ${skillsDir}`)
  if (!mkdirResult.success) {
    return { success: false, error: 'Failed to create skills directory' }
  }

  // 2. 逐个下载指定的 skill 目录（先清理旧目录，确保干净的全量替换）
  const errors: string[] = []
  for (const name of skillNames) {
    // 先删除已存在的同名目录，避免旧文件残留，然后重新创建空目录
    // manageStorage download 要求 localPath 目录必须预先存在
    await execSandboxBash(sandbox, `rm -rf "${skillsDir}/${name}" && mkdir -p "${skillsDir}/${name}"`)

    const command = [
      'mcporter call cloudbase manageStorage',
      '--action download',
      `--cloud-path ${userId}/skills/${name}`,
      `--local-path ${skillsDir}/${name}`,
      '--is-directory true',
    ].join(' ')

    const downloadResult = await execSandboxBash(sandbox, `${command} 2>&1`, 120_000)

    if (!downloadResult.success) {
      const stderr =
        downloadResult.result?.result?.stderr ||
        downloadResult.result?.result?.output ||
        downloadResult.result?.stderr ||
        ''
      errors.push(`${name}: ${stderr || 'download failed'}`)
    }
  }

  if (errors.length > 0) {
    return { success: false, error: `Failed to download skills: ${errors.join('; ')}` }
  }

  console.log('[SkillManager] Skills initialized from cloud storage')
  return { success: true }
}

// ─── Sandbox Bash Helper ─────────────────────────────────────────────────────

async function execSandboxBash(
  sandbox: SandboxConfig,
  command: string,
  timeoutMs = 30_000,
): Promise<{ success: boolean; result?: any }> {
  try {
    const res = await fetch(`${sandbox.url}/api/tools/bash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sandbox.headers },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { success: false }
    const data = (await res.json()) as any
    const exitCode = data?.result?.exitCode ?? data?.exitCode
    return { success: exitCode === 0, result: data }
  } catch {
    return { success: false }
  }
}
