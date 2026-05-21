import type { SandboxInstance } from './provider/types.js'
import { getDb } from '../db/index.js'
import { IGitOptions, parseGitUrl } from '../services/git/git.js'

async function getGitConfig(taskId: string): Promise<IGitOptions | null> {
  const task = await getDb().tasks.findById(taskId)
  if (!task?.personalGitInfo) {
    return null
  }

  let info: { repoUrl?: string; branchName?: string }
  try {
    info = JSON.parse(task.personalGitInfo)
  } catch {
    return null
  }

  const repoUrl = info.repoUrl
  const branch = info.branchName
  if (!repoUrl || !branch) {
    return null
  }

  const parsed = parseGitUrl(repoUrl)
  if (!parsed) {
    return null
  }

  const auth = process.env.GIT_PERSONAL_AUTH
  if (!auth) {
    return null
  }

  return {
    platform: parsed.platform,
    auth,
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
  }
}

function createExecBash(sandbox: SandboxInstance) {
  return async (command: string, timeoutMs?: number) => {
    const options: any = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    }
    if (timeoutMs) {
      options.signal = AbortSignal.timeout(timeoutMs)
    }
    const res = await sandbox.request('/api/tools/bash', options)
    return (await res.json()) as any
  }
}

function isSuccess(result: any): boolean {
  return result?.result?.exitCode === 0 || result?.exitCode === 0
}

function getPersonalRepoUrl(config: IGitOptions): string {
  const credUser = config.platform === 'gitlab' ? 'oauth2' : config.owner
  return `https://${credUser}:${config.auth}@${config.platform}.com/${config.owner}/${config.repo}.git`
}

async function validateGitConfig(taskId: string): Promise<IGitOptions | null> {
  const config = await getGitConfig(taskId)
  if (!config) {
    return null
  }

  const { platform, auth, owner, repo, branch } = config
  if (!platform || !auth || !owner || !repo || !branch) {
    console.warn('[GitPersonal] Git config incomplete')
    return null
  }

  return config
}

// ─── initRepo ─────────────────────────────────────────────────────

/**
 * 初始化个人 Git 仓库
 * 更新 Git 凭证
 * 在归档仓库中作为 remote 绑定
 * @returns { success: boolean; result?: any }
 */
export async function initRepo(sandbox: SandboxInstance, taskId: string): Promise<{ success: boolean; result?: any }> {
  const config = await validateGitConfig(taskId)
  console.log('[GitPersonal] Git config loaded')
  if (!config) {
    return { success: false }
  }

  const { repo, branch } = config
  const personalRepoUrl = getPersonalRepoUrl(config)
  const execBash = createExecBash(sandbox)

  const checkResult = await execBash(`git remote get-url ${repo}`)
  if (isSuccess(checkResult)) {
    const updateResult = await execBash(`git remote set-url ${repo} "${personalRepoUrl}"`)
    if (!isSuccess(updateResult)) {
      console.warn('[GitPersonal] Update remote URL failed')
      return { success: false, result: updateResult }
    }
    return { success: true }
  }

  // 首次: 添加 remote → fetch → 若远端已是本地祖先则跳过 merge，否则执行 merge
  // 沙箱重建场景：归档仓库已包含最新 commit，但上次 push 到用户仓库可能失败，
  // 远端落后于本地，此时 merge-base --is-ancestor 成功，跳过 merge 避免旧数据覆盖新数据
  const initCommands = [
    `git remote add ${repo} "${personalRepoUrl}"`,
    `git fetch ${repo}`,
    `(git rev-parse HEAD || (git add . && git commit --allow-empty -m "Initial commit"))`,
    `(git merge-base --is-ancestor ${repo}/${branch} HEAD || git merge ${repo}/${branch} --allow-unrelated-histories -X theirs --no-edit)`,
  ].join(' && ')

  const initResult = await execBash(initCommands, 60_000)
  if (!isSuccess(initResult)) {
    console.warn('[GitPersonal] Init repo failed')
    await execBash(`git remote remove ${repo}`)
    return { success: false, result: initResult }
  }

  return { success: true }
}

// ─── pushToUserGit ────────────────────────────────────────────────

/**
 * 推送代码到用户绑定的个人 Git 仓库
 * 前置校验（字段检查、remote 检查）同步执行，实际 commit+push 异步执行不阻塞调用方
 *
 * @returns { success: boolean; result?: any }
 */
export async function pushToUserGit(
  sandbox: SandboxInstance,
  taskId: string,
  conversationId: string | undefined,
  prompt: string,
): Promise<{ success: boolean; result?: any }> {
  const config = await validateGitConfig(taskId)
  if (!config) {
    return { success: false }
  }

  const { repo, branch } = config
  const execBash = createExecBash(sandbox)

  const checkResult = await execBash(`git remote get-url ${repo}`)
  if (!isSuccess(checkResult)) {
    console.log('[GitPersonal] Remote not found, skipping push')
    return { success: false, result: 'Remote not found, initRepo may have failed' }
  }

  // 同步执行 git add + commit，防止归档仓库竞争 commit
  const promptSummary = prompt.slice(0, 50).replace(/\n/g, ' ')
  const commitMessage = `${conversationId}: ${promptSummary}`
  const escapedMsg = commitMessage.replace(/"/g, '\\"')
  const commitCommand = `git add ./ && (git diff --cached --quiet || git commit -m "${escapedMsg}")`
  const commitResult = await execBash(commitCommand, 10_000)

  if (!isSuccess(commitResult)) {
    console.warn('[GitPersonal] Commit failed')
    return { success: false, result: commitResult }
  }

  // 异步执行：fetch+merge 保护远端文件不丢失 → push
  const pushCommand = [
    `git fetch ${repo} ${branch}`,
    `(git merge-base --is-ancestor ${repo}/${branch} HEAD || git merge ${repo}/${branch} --no-edit -X ours)`,
    `git push ${repo} HEAD:${branch} --force`,
  ].join(' && ')

  execBash(pushCommand)
    .then((result) => {
      if (!isSuccess(result)) {
        console.warn('[GitPersonal] Push failed')
      }
    })
    .catch(() => {
      console.warn('[GitPersonal] Push error')
    })

  return { success: true }
}
