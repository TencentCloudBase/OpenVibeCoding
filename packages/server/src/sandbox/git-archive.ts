/**
 * Git Archive Service
 *
 * Simplified version for pushing changes to git archive repo.
 * - Uses env vars directly: GIT_ARCHIVE_REPO, GIT_ARCHIVE_TOKEN, GIT_ARCHIVE_USER
 * - Uses sandbox's git_push API endpoint
 */

import type { SandboxInstance } from './provider/types.js'
import { STATEFUL_WORKSPACE_ROOT } from '../lib/sandbox-config.js'
import { buildStatefulWorkspaceAuthEnv } from './stateful-sandbox-auth.js'

// ─── Types ────────────────────────────────────────────────────────

export interface GitArchiveConfig {
  /** Git 仓库 URL，例如：https://cnb.cool/tcb-playground/workspace-archive */
  repo: string
  /** Git 用户名（可选），用于沙箱中的 Git 认证 */
  user?: string
  /** Git 访问 Token */
  token: string
  /** CNB API 域名，例如：https://api.cnb.cool */
  apiDomain: string
}

// ─── Config from env vars ────────────────────────────────────────

function getConfig(): GitArchiveConfig | null {
  const repo = process.env.GIT_ARCHIVE_REPO
  const token = process.env.GIT_ARCHIVE_TOKEN
  const user = process.env.GIT_ARCHIVE_USER

  if (!repo || !token) {
    return null
  }

  // Extract API domain from repo URL
  // https://cnb.cool/tcb-playground/workspace-archive -> https://api.cnb.cool
  let apiDomain = 'https://api.cnb.cool'
  try {
    const url = new URL(repo)
    apiDomain = `https://api.${url.hostname}`
  } catch {
    // Use default
  }

  return { repo, token, user, apiDomain }
}

/**
 * 从仓库 URL 提取 repo 路径
 * "https://cnb.cool/tcb-playground/workspace-archive" → "tcb-playground/workspace-archive"
 */
function getRepoPath(repoUrl: string): string {
  return new URL(repoUrl).pathname.replace(/^\//, '')
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * 检查 Git 归档是否已配置
 */
export function isGitArchiveConfigured(): boolean {
  const config = getConfig()
  return !!(config?.repo && config?.token)
}

/**
 * Git archive vars for POST /api/workspace/init `env` only.
 * PUT /api/workspace/env accepts CloudBase credential keys only (not GIT_ARCHIVE_*).
 * Do not pass via StartSandboxInstance CustomConfiguration.Env — boot-time
 * ENABLE_GIT_ARCHIVE blocks /health and fails AGS port binding.
 */
export function buildGitArchiveInitEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const repo = process.env.GIT_ARCHIVE_REPO?.trim()
  const token = process.env.GIT_ARCHIVE_TOKEN?.trim()
  const user = process.env.GIT_ARCHIVE_USER?.trim()
  if (repo) env.GIT_ARCHIVE_REPO = repo
  if (token) env.GIT_ARCHIVE_TOKEN = token
  if (user) env.GIT_ARCHIVE_USER = user
  const personal = process.env.GIT_PERSONAL_AUTH?.trim()
  if (personal) env.GIT_PERSONAL_AUTH = personal
  if (repo && token && user) env.ENABLE_GIT_ARCHIVE = 'true'
  return { ...env, ...buildStatefulWorkspaceAuthEnv() }
}

/** @deprecated Use {@link buildGitArchiveInitEnv} — name kept for callers. */
export function buildGitArchiveWorkspaceEnv(): Record<string, string> {
  return buildGitArchiveInitEnv()
}

/** Debug-only: AGS CustomConfiguration.Env array shape. */
export function buildGitArchiveInstanceEnv(): Array<{ Name: string; Value: string }> {
  return Object.entries(buildGitArchiveInitEnv()).map(([Name, Value]) => ({ Name, Value }))
}

/**
 * 将沙箱中的变更推送到 Git 归档仓库
 *
 * 通过 沙箱业务镜像 POST /api/extend/git_push 端点执行 git 操作
 *
 * @param sandbox 沙箱实例
 * @param conversationId 会话 ID（用作分支名）
 * @param prompt 用户提示（用于生成 commit message）
 */
export type ArchiveToGitResult = 'skipped' | 'ok' | 'fail'

export async function archiveToGit(
  sandbox: SandboxInstance,
  conversationId: string | undefined,
  prompt: string,
): Promise<ArchiveToGitResult> {
  if (!conversationId) return 'skipped'

  const config = getConfig()
  if (!config) {
    console.log('[GitArchive] Not configured, skipping archive')
    return 'skipped'
  }

  try {
    const promptSummary = prompt.slice(0, 50).replace(/\n/g, ' ')
    const commitMessage = `${conversationId}: ${promptSummary}`

    const gitPushRes = await sandbox.request('/api/extend/git_push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMessage }),
      signal: AbortSignal.timeout(120_000),
    })

    const body = (await gitPushRes.json().catch(() => null)) as { success?: boolean; error?: string } | null
    if (gitPushRes.ok && body?.success !== false) {
      console.log('[GitArchive] Push completed')
      return 'ok'
    }
    console.warn('[GitArchive] Push failed')
    return 'fail'
  } catch (err) {
    console.error('[GitArchive] Error:', (err as Error)?.message)
    return 'fail'
  }
}

/**
 * @deprecated
 * 删除远端归档分支上指定会话的目录
 *
 * 由于 session 共享改造后，分支名 = envId，同一分支上有多个 conversation 目录。
 * 此函数通过 CNB API 删除分支上的 {conversationId} 目录，而不是删除整个分支。
 *
 * @param envId 环境ID（分支名）
 * @param conversationId 会话ID（目录名）
 */
export async function deleteArchiveDirectory(envId: string, conversationId: string): Promise<void> {
  const config = getConfig()
  if (!config) {
    return // Git 归档未配置，跳过
  }

  const repoPath = getRepoPath(config.repo)
  // CNB API: 删除分支上的文件/目录
  // DELETE {apiDomain}/{repo}/-/git/files/{branch}/{path}
  const apiUrl = `${config.apiDomain}/${repoPath}/-/git/files/${encodeURIComponent(envId)}/${encodeURIComponent(conversationId)}`

  const res = await fetch(apiUrl, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.cnb.api+json',
      Authorization: config.token,
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (res.ok || res.status === 404) {
    // 200/204 = 删除成功, 404 = 目录不存在（等价于已删除）
    console.log(`[GitArchive] Directory deleted: ${envId}/${conversationId} (status=${res.status})`)
  } else {
    const body = await res.text().catch(() => '')
    const msg = `[GitArchive] Delete directory failed: ${envId}/${conversationId} (status=${res.status}, body=${body})`
    console.warn(msg)
    throw new Error(msg)
  }
}

/**
 * @deprecated
 * 批量删除远端归档目录
 *
 * @param items 要删除的 {envId, conversationId} 列表
 */
export async function deleteArchiveDirectories(items: Array<{ envId: string; conversationId: string }>): Promise<void> {
  if (items.length === 0) return

  if (!isGitArchiveConfigured()) return

  // 并发删除，但限制并发数避免 CNB API 压力
  const CONCURRENCY = 5
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY)
    await Promise.allSettled(batch.map((item) => deleteArchiveDirectory(item.envId, item.conversationId)))
  }
}

/**
 * 通过沙箱删除会话工作目录并触发 git 归档同步
 *
 * 在沙箱中执行 rm -rf 删除 conversationId 目录，然后通过 git_push 同步到归档仓库。
 * 沙箱不可用时静默跳过。
 *
 * @param sandbox 沙箱实例
 * @param envId 环境ID（用于构建目录路径）
 * @param conversationId 会话ID（目录名）
 */
export async function deleteConversationViaSandbox(
  sandbox: SandboxInstance,
  envId: string,
  conversationId: string,
  sandboxCwd?: string,
): Promise<void> {
  const workspace = sandboxCwd || STATEFUL_WORKSPACE_ROOT

  // Stateful: one shared /home/user per env instance — never rm -rf the workspace root.
  if (workspace === STATEFUL_WORKSPACE_ROOT || workspace === '/home/user') {
    try {
      await archiveToGit(sandbox, conversationId, `delete conversation ${conversationId}`)
    } catch (err) {
      console.warn(`[GitArchive] deleteConversationViaSandbox archive only failed: ${(err as Error).message}`)
    }
    return
  }

  try {
    console.log(`[GitArchive] deleteConversationViaSandbox ${workspace}`)
    const command = `rm -rf "${workspace}"`
    const res = await sandbox.request('/api/tools/bash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, timeout: 10000 }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(
        `[GitArchive] deleteConversationViaSandbox HTTP ${res.status} ${res.statusText} ` +
          `conversationId=${conversationId} workspace=${workspace} command=${JSON.stringify(command)} body=${body.slice(0, 500)}`,
      )
      return
    }

    // HTTP 200 but sandbox may still report a bash failure in the body.
    const data = (await res.json().catch(() => null)) as {
      success?: boolean
      error?: string
      result?: { output?: string; stderr?: string; exitCode?: number }
    } | null
    if (!data || data.success === false) {
      console.warn(
        `[GitArchive] deleteConversationViaSandbox bash failed ` +
          `conversationId=${conversationId} workspace=${workspace} command=${JSON.stringify(command)} ` +
          `error=${data?.error ?? '<no error>'} exitCode=${data?.result?.exitCode ?? '<n/a>'} ` +
          `stderr=${(data?.result?.stderr ?? '').slice(0, 500)} output=${(data?.result?.output ?? '').slice(0, 500)}`,
      )
      return
    }

    // Sync deletion to git archive
    await archiveToGit(sandbox, conversationId, `delete conversation ${conversationId}`)
  } catch (err) {
    console.warn(`[GitArchive] deleteConversationViaSandbox failed: ${(err as Error).message}`)
  }
}

/**
 * 删除远端归档分支（分支名 = sessionId）
 */
export async function deleteArchiveBranch(sessionId: string): Promise<void> {
  const config = getConfig()
  if (!config) {
    return // Git 归档未配置，跳过
  }

  const repoPath = getRepoPath(config.repo)
  const apiUrl = `${config.apiDomain}/${repoPath}/-/git/branches/${encodeURIComponent(sessionId)}`

  const res = await fetch(apiUrl, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.cnb.api+json',
      Authorization: config.token,
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (res.ok || res.status === 404) {
    // 200/204 = 删除成功, 404 = 分支不存在（等价于已删除）
    console.log(`[GitArchive] Branch deleted: ${sessionId} (status=${res.status})`)
  } else {
    const body = await res.text().catch(() => '')
    const msg = `[GitArchive] Delete failed: ${sessionId} (status=${res.status}, body=${body})`
    console.warn(msg)
    throw new Error(msg)
  }
}

/**
 * @deprecated 使用 deleteArchiveDirectories 替代
 * 批量删除远端归档分支
 *
 * @param sessionIds 要删除的分支名列表
 */
export async function deleteArchiveBranches(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return

  if (!isGitArchiveConfigured()) return

  // 并发删除，但限制并发数避免 CNB API 压力
  const CONCURRENCY = 5
  for (let i = 0; i < sessionIds.length; i += CONCURRENCY) {
    const batch = sessionIds.slice(i, i + CONCURRENCY)
    await Promise.allSettled(batch.map((id) => deleteArchiveBranch(id)))
  }
}
