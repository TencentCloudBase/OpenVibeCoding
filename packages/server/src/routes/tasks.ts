import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getDb } from '../db/index.js'
import { nanoid } from 'nanoid'
import { requireAuth, requireUserEnv, type AppEnv } from '../middleware/auth'
import { readFileSync } from 'node:fs'
import { createTaskLogger } from '../lib/task-logger'
import {
  STATEFUL_WORKSPACE_ROOT,
  resolveSandboxConfig,
  resolveSandboxModeForNewTask,
  backfillSandboxConfig,
  isValidSandboxInstanceMode,
} from '../lib/sandbox-config'
import { buildStatefulAcquireContext } from '../sandbox/acquire-context.js'
import { proxyTaskPreview } from '../sandbox/preview-proxy.js'
import { decrypt } from '../lib/crypto'
import { Octokit } from '@octokit/rest'
import { deleteArchiveBranch } from '../sandbox/index.js'
import { persistenceService } from '../agent/persistence.service'
import {
  deleteConversationViaSandbox,
  archiveToGit,
  getSandboxProvider,
  getTaskSandbox,
  runCommandInSandbox,
  downloadFileFromSandbox,
  readFileFromSandbox,
  writeFileToSandbox,
  detectPackageManager,
  type SandboxInstance,
} from '../sandbox/index.js'
import { isViteReadyResult, waitForSandboxViteReady } from '../sandbox/wait-vite-ready.js'
import {
  destroyProvisionedResources,
  provisionUserResources,
  rollbackProvisionedResources,
} from '../cloudbase/provision.js'
import { acquireEnv, releaseEnv } from '../cloudbase/env-lifecycle.js'
import { getProvisionMode } from '../lib/provision-config.js'
import type { Octokit as OctokitType } from '@octokit/rest'
import type { Task } from '../db/types.js'
import { GitService } from '../services/git/git'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SANDBOX_DURATION = parseInt(process.env.MAX_SANDBOX_DURATION || '300', 10)

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

async function getUserGitHubToken(userId: string): Promise<string | null> {
  try {
    const account = await getDb().accounts.findByUserIdAndProvider(userId, 'github')
    if (account?.accessToken) {
      return decrypt(account.accessToken)
    }

    const user = await getDb().users.findById(userId)
    if (user?.provider === 'github' && user.accessToken) {
      return decrypt(user.accessToken)
    }

    return null
  } catch (error) {
    console.error('Error fetching user GitHub token:', error)
    return null
  }
}

async function getOctokit(userId: string): Promise<OctokitType> {
  const token = await getUserGitHubToken(userId)
  return new Octokit({ auth: token || undefined })
}

function parseGitHubUrl(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/github\.com[/:]([\w-]+)\/([\w-]+?)(\.git)?$/)
  if (match) {
    return { owner: match[1], repo: match[2] }
  }
  return null
}

const STATEFUL_DEFAULT_VITE_PORT = 5173

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    sql: 'sql',
  }
  return langMap[ext || ''] || 'text'
}

function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'tif'].includes(ext || '')
}

function isBinaryFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  const binaryExtensions = [
    'zip',
    'tar',
    'gz',
    'rar',
    '7z',
    'bz2',
    'exe',
    'dll',
    'so',
    'dylib',
    'db',
    'sqlite',
    'sqlite3',
    'mp3',
    'mp4',
    'avi',
    'mov',
    'wav',
    'flac',
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'ttf',
    'otf',
    'woff',
    'woff2',
    'eot',
    'bin',
    'dat',
    'dmg',
    'iso',
    'img',
  ]
  return binaryExtensions.includes(ext || '') || isImageFile(filename)
}

async function getFileContentFromGitHub(
  octokit: OctokitType,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  isImage: boolean,
): Promise<{ content: string; isBase64: boolean }> {
  try {
    const response = await octokit.rest.repos.getContent({ owner, repo, path, ref })
    if ('content' in response.data && typeof response.data.content === 'string') {
      if (isImage) return { content: response.data.content, isBase64: true }
      return { content: Buffer.from(response.data.content, 'base64').toString('utf-8'), isBase64: false }
    }
    return { content: '', isBase64: false }
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
      return { content: '', isBase64: false }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const tasksRouter = new Hono<AppEnv>()

// List tasks
tasksRouter.get('/', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!
  const userTasks = await getDb().tasks.findByUserId(session.user.id)
  const parsedTasks = userTasks.map((t) => ({
    ...t,
    logs: t.logs ? JSON.parse(t.logs) : [],
    mcpServerIds: t.mcpServerIds ? JSON.parse(t.mcpServerIds) : null,
  }))
  return c.json({ tasks: parsedTasks })
})

// Create task
tasksRouter.post('/', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!
  const body = await c.req.json()
  const {
    prompt,
    repoUrl,
    selectedAgent = 'claude',
    selectedModel,
    selectedRuntime,
    mode = 'default',
    installDependencies = false,
    maxDuration = 300,
    keepAlive = false,
    enableBrowser = false,
    sandboxMode: bodySandboxMode,
  } = body
  if (!prompt || typeof prompt !== 'string') return c.json({ error: 'prompt is required' }, 400)
  if (bodySandboxMode != null && !isValidSandboxInstanceMode(String(bodySandboxMode))) {
    return c.json({ error: 'sandboxMode must be shared or isolated' }, 400)
  }

  const taskId = body.id || nanoid(12)
  const now = Date.now()
  const defaultSandboxMode = await resolveSandboxModeForNewTask(
    typeof bodySandboxMode === 'string' ? bodySandboxMode : null,
  )

  // 解析 envId：根据 provision_mode 决定 task.envId 怎么来
  //   - shared:   直接用 TCB_ENV_ID（不写 user_resources）
  //   - isolated: 复用 user_resources(scope='user') 的 envId（已在注册时预建；缺失时懒建兜底）
  //   - task:     同步建独立 env，env ready 后才返回 task
  const provisionMode = await getProvisionMode()
  let taskEnvId: string | null = null
  let sandboxConfig: ReturnType<typeof resolveSandboxConfig> | null = null
  let provisionedResourceId: string | null = null
  let provisionedCamUsername: string | null = null

  if (provisionMode === 'task') {
    // 同步获取 task 级独立环境（池化开启时从池认领，否则实时创建）
    if (!process.env.TCB_SECRET_ID || !process.env.TCB_SECRET_KEY) {
      return c.json({ error: 'TCB_SECRET_ID/KEY 未配置，无法创建 task 级环境' }, 500)
    }
    try {
      const result = await acquireEnv({
        userId: session.user.id,
        username: session.user.username,
        taskId,
        mode: 'task',
      })
      provisionedCamUsername = result.camUsername
      // 写入 user_resources（scope='task'）
      provisionedResourceId = nanoid()
      await getDb().userResources.create({
        id: provisionedResourceId,
        userId: session.user.id,
        scope: 'task',
        taskId,
        status: 'success',
        envId: result.envId,
        envAlias: result.envAlias,
        envRegion: result.envRegion,
        cosTagValue: result.cosTagValue,
        policyHash: result.policyHash,
        camUsername: result.camUsername,
        camSecretId: result.camSecretId,
        camSecretKey: result.camSecretKey || null,
        policyId: result.policyId,
        failStep: null,
        failReason: null,
        createdAt: now,
        updatedAt: now,
      })
      taskEnvId = result.envId
      sandboxConfig = resolveSandboxConfig({
        envId: result.envId,
        taskId,
        sandboxMode: defaultSandboxMode,
      })
      console.log('[tasks.create] task env ready', { taskId, envId: result.envId })
    } catch (err) {
      console.error('[tasks.create] task env acquire failed:', (err as Error).message)
      // 回滚已创建的腾讯云资源（best-effort）
      try {
        await rollbackProvisionedResources({
          camUsername: provisionedCamUsername || `vibe_t_${taskId.substring(0, 18)}`,
        })
      } catch {
        // best-effort
      }
      return c.json({ error: '创建 task 级 CloudBase 环境失败：' + (err as Error).message }, 500)
    }
  } else if (provisionMode === 'shared') {
    // shared 模式：直接用支撑账号 env，无需 user_resources
    if (process.env.TCB_ENV_ID) {
      taskEnvId = process.env.TCB_ENV_ID
      sandboxConfig = resolveSandboxConfig({
        envId: process.env.TCB_ENV_ID,
        taskId,
        sandboxMode: defaultSandboxMode,
      })
    }
  } else {
    // isolated：复用 user-level env；缺失时懒建兜底（覆盖 mode 切换场景）
    try {
      let resource = await getDb().userResources.findByUserId(session.user.id)
      if (!resource?.envId || resource.status !== 'success') {
        if (!process.env.TCB_SECRET_ID || !process.env.TCB_SECRET_KEY) {
          return c.json({ error: 'TCB_SECRET_ID/KEY 未配置，无法创建 user-level 环境' }, 500)
        }
        const result = await provisionUserResources(session.user.id, session.user.username)
        if (resource?.id) {
          await getDb().userResources.update(resource.id, {
            status: 'success',
            envId: result.envId,
            envAlias: result.envAlias,
            envRegion: result.envRegion,
            cosTagValue: result.cosTagValue,
            policyHash: result.policyHash,
            camUsername: result.camUsername,
            camSecretId: result.camSecretId,
            camSecretKey: result.camSecretKey || null,
            policyId: result.policyId,
            failStep: null,
            failReason: null,
            updatedAt: Date.now(),
          })
        } else {
          await getDb().userResources.create({
            id: nanoid(),
            userId: session.user.id,
            scope: 'user',
            taskId: null,
            status: 'success',
            envId: result.envId,
            envAlias: result.envAlias,
            envRegion: result.envRegion,
            cosTagValue: result.cosTagValue,
            policyHash: result.policyHash,
            camUsername: result.camUsername,
            camSecretId: result.camSecretId,
            camSecretKey: result.camSecretKey || null,
            policyId: result.policyId,
            failStep: null,
            failReason: null,
            createdAt: now,
            updatedAt: now,
          })
        }
        resource = await getDb().userResources.findByUserId(session.user.id)
      }
      if (resource?.envId) {
        taskEnvId = resource.envId
        sandboxConfig = resolveSandboxConfig({
          envId: resource.envId,
          taskId,
          sandboxMode: defaultSandboxMode,
        })
      }
    } catch (err) {
      console.error('[tasks.create] isolated user-level lazy provision failed:', (err as Error).message)
      return c.json({ error: '创建用户级 CloudBase 环境失败：' + (err as Error).message }, 500)
    }
  }

  await getDb().tasks.create({
    id: taskId,
    userId: session.user.id,
    prompt,
    title: null,
    repoUrl: repoUrl || null,
    envId: taskEnvId,
    selectedAgent,
    selectedModel: selectedModel || null,
    selectedRuntime: selectedRuntime || null,
    mode,
    installDependencies,
    maxDuration,
    keepAlive,
    enableBrowser,
    status: 'pending',
    progress: 0,
    logs: '[]',
    error: null,
    branchName: null,
    sandboxId: null,
    sandboxCwd: sandboxConfig?.sandboxCwd ?? null,
    sandboxMode: sandboxConfig?.sandboxMode ?? null,
    agentSessionId: null,
    sandboxUrl: null,
    previewUrl: null,
    prUrl: null,
    prNumber: null,
    prStatus: null,
    prMergeCommitSha: null,
    mcpServerIds: null,
    personalGitInfo: null,
    createdAt: now,
    updatedAt: now,
  })

  const newTask = await getDb().tasks.findById(taskId)
  return c.json({ task: { ...newTask, logs: [], mcpServerIds: null } })
})

// Get single task
tasksRouter.get('/:taskId', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!
  const { taskId } = c.req.param()
  const task = await getDb().tasks.findByIdAndUserId(taskId, session.user.id)
  if (!task || task.deletedAt) return c.json({ error: 'Task not found' }, 404)
  return c.json({
    task: {
      ...task,
      logs: task.logs ? JSON.parse(task.logs) : [],
      mcpServerIds: task.mcpServerIds ? JSON.parse(task.mcpServerIds) : null,
    },
  })
})

// Update task (stop action)
tasksRouter.patch('/:taskId', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!
  const { taskId } = c.req.param()
  const body = await c.req.json()
  const existing = await getDb().tasks.findByIdAndUserId(taskId, session.user.id)
  if (!existing || existing.deletedAt) return c.json({ error: 'Task not found' }, 404)

  if (body.action === 'stop') {
    if (existing.status !== 'processing') return c.json({ error: 'Can only stop processing tasks' }, 400)
    const logger = createTaskLogger(taskId)
    await logger.info('Task stopped by user')
    await logger.updateStatus('stopped', 'Task was stopped by user')
    const updated = await getDb().tasks.findById(taskId)
    return c.json({ message: 'Task stopped', task: updated })
  }
  return c.json({ error: 'Invalid action' }, 400)
})

/** Task.status values that bulk delete may target (aliases: failed→error, done→completed). */
const BULK_DELETE_STATUSES = new Set(['completed', 'done', 'error', 'failed', 'stopped', 'processing', 'pending'])

function resolveBulkDeleteStatuses(action: string): Set<string> {
  const out = new Set<string>()
  for (const raw of action
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (raw === 'failed') {
      out.add('error')
      continue
    }
    if (raw === 'completed') {
      out.add('completed')
      out.add('done')
      continue
    }
    if (BULK_DELETE_STATUSES.has(raw)) out.add(raw)
  }
  return out
}

type DeleteTaskFailure = {
  status: number
  body: Record<string, unknown>
}

type DeleteTaskSuccess = {
  ok: true
  warning?: string
  provisionFailed?: Awaited<ReturnType<typeof destroyProvisionedResources>>['failed']
}

async function deleteTaskForUser(
  existing: Task,
  envId: string,
): Promise<DeleteTaskSuccess | { ok: false; failure: DeleteTaskFailure }> {
  const taskId = existing.id
  let provisionFailed: DeleteTaskSuccess['provisionFailed']

  const taskResource = await getDb().userResources.findByTaskId(taskId)
  if (taskResource && taskResource.scope === 'task') {
    let result: Awaited<ReturnType<typeof releaseEnv>>
    try {
      result = await releaseEnv({
        camUsername: taskResource.camUsername,
        policyId: taskResource.policyId,
        envId: taskResource.envId,
        cosTagValue: taskResource.cosTagValue,
      })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn('[task-delete] releaseEnv threw', { message })
      return {
        ok: false,
        failure: {
          status: 500,
          body: { error: '云资源清理失败，请稍后重试', detail: message },
        },
      }
    }
    if (result.failed.length > 0) {
      provisionFailed = result.failed
      console.warn('[task-delete] some resources failed to destroy; soft-deleting task anyway', {
        failed: result.failed,
      })
    } else {
      try {
        await getDb().userResources.deleteById(taskResource.id)
        console.log('[task-delete] user_resources row removed', { resourceId: taskResource.id })
      } catch (e: unknown) {
        console.warn('[task-delete] failed to delete user_resources row', {
          message: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  await getDb().tasks.softDelete(taskId)

  void (async () => {
    try {
      const sandbox = await getTaskSandbox(existing, envId).catch(() => null)
      if (sandbox) {
        if (existing.sandboxMode === 'isolated') {
          const provider = getSandboxProvider()
          if (provider.destroy) {
            await provider.destroy(sandbox)
          }
        } else {
          await deleteConversationViaSandbox(sandbox, envId, taskId, existing.sandboxCwd || undefined)
        }
      }
    } catch {
      console.log('clean conversation workspace error')
    }
  })()

  if (provisionFailed?.length) {
    return {
      ok: true,
      warning: '部分云资源清理失败，任务已从列表移除，后台可重试清理',
      provisionFailed,
    }
  }
  return { ok: true }
}

// Bulk delete by status (sidebar: completed / failed / stopped)
tasksRouter.delete('/', requireUserEnv, async (c) => {
  const session = c.get('session')!
  const { envId } = c.get('userEnv')!
  const action = c.req.query('action') ?? ''
  const statusSet = resolveBulkDeleteStatuses(action)

  if (statusSet.size === 0) {
    return c.json({ error: 'Invalid or empty action query (e.g. ?action=completed,failed,stopped)' }, 400)
  }
  const candidates = await getDb().tasks.findAll(500, 0, { userId: session.user.id })
  const toDelete = candidates.filter((t) => statusSet.has(t.status))

  let deleted = 0
  const failures: Array<{ taskId: string; error: string; detail?: string }> = []

  for (const task of toDelete) {
    const result = await deleteTaskForUser(task, envId)
    if (result.ok) {
      deleted += 1
      if (result.warning) {
        failures.push({
          taskId: task.id,
          error: result.warning,
        })
      }
    } else {
      const body = result.failure.body
      failures.push({
        taskId: task.id,
        error: String(body.error ?? 'delete failed'),
        detail: typeof body.detail === 'string' ? body.detail : undefined,
      })
    }
  }

  if (deleted === 0 && failures.length > 0) {
    return c.json(
      {
        error: '未能删除任何任务',
        deleted,
        failed: failures,
      },
      409,
    )
  }

  return c.json({
    message: `Deleted ${deleted} task${deleted === 1 ? '' : 's'}`,
    deleted,
    failed: failures,
  })
})

// Delete task (soft delete + git archive cleanup)
tasksRouter.delete('/:taskId', requireUserEnv, async (c) => {
  const session = c.get('session')!
  const { envId } = c.get('userEnv')!
  const { taskId } = c.req.param()
  const existing = await getDb().tasks.findByIdAndUserId(taskId, session.user.id)
  if (!existing || existing.deletedAt) return c.json({ error: 'Task not found' }, 404)

  const result = await deleteTaskForUser(existing, envId)
  if (!result.ok) {
    return c.json(result.failure.body, result.failure.status as 409 | 500)
  }

  return c.json({
    message: 'Task deleted',
    ...(result.warning ? { warning: result.warning, failed: result.provisionFailed } : {}),
  })
})

// Get task messages
tasksRouter.get('/:taskId/messages', requireUserEnv, async (c) => {
  const session = c.get('session')!
  const { envId, userId } = c.get('userEnv')!
  const { taskId } = c.req.param()
  const task = await getDb().tasks.findByIdAndUserId(taskId, session.user.id)
  if (!task || task.deletedAt) return c.json({ error: 'Task not found' }, 404)

  try {
    const cloudbaseRecords = await persistenceService.loadDBMessages(taskId, envId, userId, 100)
    const messages = cloudbaseRecords.map((record) => {
      const parts = (record.parts || [])
        .map((p) => {
          if (p.contentType === 'text') {
            // contentBlocks may be in p.metadata (TypeScript model) or directly on p
            // (when CloudBase flattens the nested metadata object on read-back)
            const contentBlocks = ((p.metadata as any)?.contentBlocks ?? (p as any).contentBlocks) as any[] | undefined
            if (contentBlocks) {
              const imageParts: any[] = []
              for (const b of contentBlocks) {
                if (b.type === 'image_blob_ref') {
                  // Post-syncMessages: read from local blob file
                  try {
                    const data = readFileSync(b.blob_path as string).toString('base64')
                    imageParts.push({ type: 'image' as const, data, mimeType: b.mime as string })
                  } catch (e) {
                    console.error('[messages] blob read failed:', b.blob_path, (e as Error).message)
                  }
                }
              }
              if (imageParts.length > 0) {
                return [...imageParts, { type: 'text' as const, text: p.content || '' }]
              }
            }
            return { type: 'text' as const, text: p.content || '' }
          } else if (p.contentType === 'reasoning') return { type: 'thinking' as const, text: p.content || '' }
          else if (p.contentType === 'tool_call')
            return {
              type: 'tool_call' as const,
              toolCallId: p.toolCallId || p.partId,
              toolName: (p.metadata?.toolCallName as string) || (p.metadata?.toolName as string) || 'tool',
              input: p.content || p.metadata?.input,
              status: (p.metadata?.status as string) || undefined,
            }
          else if (p.contentType === 'tool_result')
            return {
              type: 'tool_result' as const,
              toolCallId: p.toolCallId || p.partId,
              toolName: (p.metadata?.toolName as string) || undefined,
              content: p.content || '',
              isError: p.metadata?.isError as boolean | undefined,
              status: (p.metadata?.status as string) || undefined,
            }
          else if (p.contentType === 'image')
            return {
              type: 'image' as const,
              data: p.content || '',
              mimeType: (p.metadata?.mimeType as string) || 'image/png',
            }
          return { type: 'text' as const, text: p.content || '' }
        })
        .flat()
      const textContent = parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { type: 'text'; text: string }).text)
        .join('')
      return {
        id: record.recordId,
        taskId,
        role: record.role === 'user' ? 'user' : 'agent',
        content: textContent,
        parts,
        status: record.status,
        createdAt: record.createTime || Date.now(),
      }
    })
    return c.json({ messages })
  } catch {
    return c.json({ messages: [] })
  }
})

// Continue task
tasksRouter.post('/:taskId/continue', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!
  const { taskId } = c.req.param()
  const body = await c.req.json()
  const { prompt } = body
  if (!prompt) return c.json({ error: 'prompt is required' }, 400)
  const task = await getDb().tasks.findByIdAndUserId(taskId, session.user.id)
  if (!task || task.deletedAt) return c.json({ error: 'Task not found' }, 404)
  await getDb().tasks.update(taskId, { status: 'processing', updatedAt: Date.now() })
  return c.json({ message: 'Message sent' })
})

// ---------------------------------------------------------------------------
// Helper: find task by id+userId with deletedAt check
// ---------------------------------------------------------------------------
async function findActiveTask(taskId: string, userId: string) {
  const task = await getDb().tasks.findByIdAndUserId(taskId, userId)
  if (!task || task.deletedAt) return null
  return task
}

// ---------------------------------------------------------------------------
// GET /:taskId/files
// ---------------------------------------------------------------------------

interface FileChange {
  filename: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  changes: number
}

interface FileTreeNode {
  type: 'file' | 'directory'
  filename?: string
  status?: string
  additions?: number
  deletions?: number
  changes?: number
  children?: Record<string, FileTreeNode>
}

function addToFileTree(tree: Record<string, FileTreeNode>, filename: string, fileObj: FileChange) {
  const parts = filename.split('/')
  let currentLevel = tree
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const isLastPart = i === parts.length - 1
    if (isLastPart) {
      currentLevel[part] = {
        type: 'file',
        filename: fileObj.filename,
        status: fileObj.status,
        additions: fileObj.additions,
        deletions: fileObj.deletions,
        changes: fileObj.changes,
      }
    } else {
      if (!currentLevel[part]) currentLevel[part] = { type: 'directory', children: {} }
      currentLevel = currentLevel[part].children!
    }
  }
}

tasksRouter.get('/:taskId/files', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const mode = c.req.query('mode') || 'remote'

    // Allow admins to view any task's files (remote/GitHub mode only)
    const db = getDb()
    const currentUser = await db.users.findById(session.user.id)
    const isAdmin = currentUser?.role === 'admin'

    const task = isAdmin
      ? await db.tasks.findById(taskId).then((t) => (t && !t.deletedAt ? t : null))
      : await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.branchName) return c.json({ success: true, files: [], fileTree: {}, branchName: null })
    const repoUrl = task.repoUrl
    if (!repoUrl) return c.json({ success: true, files: [], fileTree: {}, branchName: task.branchName })

    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ success: false, error: 'GitHub authentication required' }, 401)
    const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (!githubMatch) return c.json({ success: false, error: 'Invalid repository URL format' }, 400)
    const [, owner, repo] = githubMatch
    let files: FileChange[] = []

    if (mode === 'local') {
      if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox is not running' }, 410)
      try {
        const sandbox = await getTaskSandbox(task, envId)
        if (!sandbox)
          return c.json({
            success: true,
            files: [],
            fileTree: {},
            branchName: task.branchName,
            message: 'Sandbox not found',
          })

        const statusResult = await runCommandInSandbox(sandbox, 'git status --porcelain')
        if (!statusResult.success)
          return c.json({
            success: true,
            files: [],
            fileTree: {},
            branchName: task.branchName,
            message: 'Failed to get local changes',
          })

        const statusOutput = statusResult.output || ''
        const statusLines = statusOutput
          .trim()
          .split('\n')
          .filter((line) => line.trim())
        const checkRemoteResult = await runCommandInSandbox(sandbox, `git rev-parse --verify origin/${task.branchName}`)
        const remoteBranchExists = checkRemoteResult.success
        const compareRef = remoteBranchExists ? `origin/${task.branchName}` : 'HEAD'
        const numstatResult = await runCommandInSandbox(sandbox, `git diff --numstat ${compareRef}`)
        const diffStats: Record<string, { additions: number; deletions: number }> = {}
        if (numstatResult.success) {
          const numstatOutput = numstatResult.output || ''
          for (const line of numstatOutput
            .trim()
            .split('\n')
            .filter((l) => l.trim())) {
            const parts = line.split('\t')
            if (parts.length >= 3)
              diffStats[parts[2]] = { additions: parseInt(parts[0]) || 0, deletions: parseInt(parts[1]) || 0 }
          }
        }
        const filePromises = statusLines.map(async (line) => {
          const indexStatus = line.charAt(0)
          const worktreeStatus = line.charAt(1)
          let filename = line.substring(2).trim()
          if (indexStatus === 'R' || worktreeStatus === 'R') {
            const arrowIndex = filename.indexOf(' -> ')
            if (arrowIndex !== -1) filename = filename.substring(arrowIndex + 4).trim()
          }
          let status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified'
          if (indexStatus === 'R' || worktreeStatus === 'R') status = 'renamed'
          else if (indexStatus === 'A' || worktreeStatus === 'A' || (indexStatus === '?' && worktreeStatus === '?'))
            status = 'added'
          else if (indexStatus === 'D' || worktreeStatus === 'D') status = 'deleted'
          let stats = diffStats[filename] || { additions: 0, deletions: 0 }
          if (
            (indexStatus === '?' && worktreeStatus === '?') ||
            (indexStatus === 'A' && !stats.additions && !stats.deletions)
          ) {
            const wcResult = await runCommandInSandbox(sandbox, `wc -l '${filename.replace(/'/g, "'\\''")}'`)
            if (wcResult.success) {
              stats = { additions: parseInt((wcResult.output || '').trim().split(/\s+/)[0]) || 0, deletions: 0 }
            }
          }
          return {
            filename,
            status,
            additions: stats.additions,
            deletions: stats.deletions,
            changes: stats.additions + stats.deletions,
          }
        })
        files = await Promise.all(filePromises)
      } catch {
        return c.json({ success: false, error: 'Failed to fetch local changes' }, 500)
      }
    } else if (mode === 'all-local') {
      if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox is not running' }, 410)
      try {
        const sandbox = await getTaskSandbox(task, envId)
        if (!sandbox)
          return c.json({
            success: true,
            files: [],
            fileTree: {},
            branchName: task.branchName,
            message: 'Sandbox not found',
          })
        const findResult = await runCommandInSandbox(
          sandbox,
          "find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.vercel/*'",
        )
        if (!findResult.success)
          return c.json({
            success: true,
            files: [],
            fileTree: {},
            branchName: task.branchName,
            message: 'Failed to list files',
          })
        const findOutput = findResult.output || ''
        const fileLines = findOutput
          .trim()
          .split('\n')
          .filter((line) => line.trim() && line !== '.')
          .map((line) => line.replace(/^\.\//, ''))
        const statusResult = await runCommandInSandbox(sandbox, 'git status --porcelain')
        const changedFilesMap: Record<string, 'added' | 'modified' | 'deleted' | 'renamed'> = {}
        if (statusResult.success) {
          const statusOutput = statusResult.output || ''
          for (const line of statusOutput
            .trim()
            .split('\n')
            .filter((l) => l.trim())) {
            const indexStatus = line.charAt(0)
            const worktreeStatus = line.charAt(1)
            let filename = line.substring(2).trim()
            if (indexStatus === 'R' || worktreeStatus === 'R') {
              const arrowIndex = filename.indexOf(' -> ')
              if (arrowIndex !== -1) filename = filename.substring(arrowIndex + 4).trim()
            }
            let status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified'
            if (indexStatus === 'R' || worktreeStatus === 'R') status = 'renamed'
            else if (indexStatus === 'A' || worktreeStatus === 'A' || (indexStatus === '?' && worktreeStatus === '?'))
              status = 'added'
            else if (indexStatus === 'D' || worktreeStatus === 'D') status = 'deleted'
            changedFilesMap[filename] = status
          }
        }
        files = fileLines.map((filename) => {
          const trimmed = filename.trim()
          const status = changedFilesMap[trimmed] || ('renamed' as const)
          return { filename: trimmed, status, additions: 0, deletions: 0, changes: 0 }
        })
      } catch {
        return c.json({ success: false, error: 'Failed to fetch local files' }, 500)
      }
    } else if (mode === 'all') {
      try {
        const treeResponse = await octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: task.branchName,
          recursive: 'true',
        })
        files = treeResponse.data.tree
          .filter((item) => item.type === 'blob' && item.path)
          .map((item) => ({
            filename: item.path!,
            status: 'modified' as const,
            additions: 0,
            deletions: 0,
            changes: 0,
          }))
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404)
          return c.json({
            success: true,
            files: [],
            fileTree: {},
            branchName: task.branchName,
            message: 'Branch not found or still being created',
          })
        return c.json({ success: false, error: 'Failed to fetch repository tree from GitHub' }, 500)
      }
    } else {
      try {
        try {
          await octokit.rest.repos.getBranch({ owner, repo, branch: task.branchName })
        } catch (branchError: unknown) {
          if (
            branchError &&
            typeof branchError === 'object' &&
            'status' in branchError &&
            (branchError as { status: number }).status === 404
          )
            return c.json({
              success: true,
              files: [],
              fileTree: {},
              branchName: task.branchName,
              message: 'Branch is being created...',
            })
          throw branchError
        }
        let comparison
        try {
          comparison = await octokit.rest.repos.compareCommits({ owner, repo, base: 'main', head: task.branchName })
        } catch (mainError: unknown) {
          if (
            mainError &&
            typeof mainError === 'object' &&
            'status' in mainError &&
            (mainError as { status: number }).status === 404
          ) {
            try {
              comparison = await octokit.rest.repos.compareCommits({
                owner,
                repo,
                base: 'master',
                head: task.branchName,
              })
            } catch (masterError: unknown) {
              if (
                masterError &&
                typeof masterError === 'object' &&
                'status' in masterError &&
                (masterError as { status: number }).status === 404
              )
                return c.json({
                  success: true,
                  files: [],
                  fileTree: {},
                  branchName: task.branchName,
                  message: 'No base branch found for comparison',
                })
              throw masterError
            }
          } else {
            throw mainError
          }
        }
        files =
          comparison.data.files?.map((file) => ({
            filename: file.filename,
            status: file.status as 'added' | 'modified' | 'deleted' | 'renamed',
            additions: file.additions || 0,
            deletions: file.deletions || 0,
            changes: file.changes || 0,
          })) || []
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404)
          return c.json({
            success: true,
            files: [],
            fileTree: {},
            branchName: task.branchName,
            message: 'Branch not found or still being created',
          })
        return c.json({ success: false, error: 'Failed to fetch file changes from GitHub' }, 500)
      }
    }

    const fileTree: Record<string, FileTreeNode> = {}
    for (const file of files) addToFileTree(fileTree, file.filename, file)
    return c.json({ success: true, files, fileTree, branchName: task.branchName })
  } catch (error) {
    console.error('Error fetching task files:', error)
    return c.json({ success: false, error: 'Failed to fetch task files' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/files/list-dir — Lazy load single directory level from sandbox
// ---------------------------------------------------------------------------

tasksRouter.get('/:taskId/files/list-dir', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const dirPath = c.req.query('path') || '.'

    const db = getDb()
    const currentUser = await db.users.findById(session.user.id)
    const isAdmin = currentUser?.role === 'admin'

    const task = isAdmin
      ? await db.tasks.findById(taskId).then((t) => (t && !t.deletedAt ? t : null))
      : await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox is not running' }, 410)

    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not found' }, 410)

    // Sanitize path to prevent directory traversal
    const safePath = dirPath.replace(/\.\./g, '').replace(/^\/+/, '')
    const targetPath = safePath || '.'

    // List single directory level: -1 = one entry per line, -A = exclude . and ..
    const lsResult = await runCommandInSandbox(sandbox, `ls -1AF '${targetPath.replace(/'/g, "'\\''")}'`)
    if (!lsResult.success) {
      return c.json({ success: false, error: 'Failed to list directory' }, 500)
    }

    const output = lsResult.output || ''
    const lines = output
      .trim()
      .split('\n')
      .filter((l) => l.trim())

    // Parse ls -F output: directories end with /, executables with *, symlinks with @
    const entries: Array<{ name: string; type: 'file' | 'directory'; path: string }> = []
    const hiddenDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.vercel'])

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      if (trimmed.endsWith('/')) {
        const name = trimmed.slice(0, -1)
        if (hiddenDirs.has(name)) continue
        const fullPath = targetPath === '.' ? name : `${targetPath}/${name}`
        entries.push({ name, type: 'directory', path: fullPath })
      } else {
        // Remove trailing indicator characters (* for executable, @ for symlink, etc.)
        const name = trimmed.replace(/[*@|=]$/, '')
        if (!name) continue
        const fullPath = targetPath === '.' ? name : `${targetPath}/${name}`
        entries.push({ name, type: 'file', path: fullPath })
      }
    }

    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return c.json({ success: true, entries })
  } catch {
    return c.json({ success: false, error: 'Failed to list directory' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/file-content
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/file-content', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const rawFilename = c.req.query('filename')
    const mode = c.req.query('mode') || 'remote'
    if (!rawFilename) return c.json({ error: 'Missing filename parameter' }, 400)
    const filename = decodeURIComponent(rawFilename)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)

    // For local/sandbox mode, read directly from sandbox without requiring branch/repo
    if (mode === 'local' && task.sandboxId && (!task.branchName || !task.repoUrl)) {
      const sandbox = await getTaskSandbox(task, envId)
      if (!sandbox) return c.json({ error: 'Sandbox not found' }, 410)
      const normalizedPath = filename.startsWith('/') ? filename.substring(1) : filename
      const isImage = isImageFile(filename)
      const isBinary = isBinaryFile(filename)
      if (isBinary && !isImage)
        return c.json({
          success: true,
          data: { filename, oldContent: '', newContent: '', language: 'text', isBinary: true, isImage: false },
        })
      const result = await readFileFromSandbox(sandbox, normalizedPath, { isImage })
      if (!result.found) return c.json({ error: 'File not found in sandbox' }, 404)
      const ext = filename.split('.').pop()?.toLowerCase() || ''
      const langMap: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        css: 'css',
        json: 'json',
        md: 'markdown',
        html: 'html',
        py: 'python',
        sh: 'shell',
        yml: 'yaml',
        yaml: 'yaml',
        xml: 'xml',
        sql: 'sql',
      }
      return c.json({
        success: true,
        data: {
          filename,
          oldContent: '',
          newContent: result.content,
          language: langMap[ext] || 'text',
          isBinary: false,
          isImage,
          isBase64: result.isBase64 ?? false,
        },
      })
    }

    if (!task.branchName || !task.repoUrl)
      return c.json({ error: 'Task does not have branch or repository information' }, 400)
    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ error: 'GitHub authentication required' }, 401)
    const githubMatch = task.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (!githubMatch) return c.json({ error: 'Invalid GitHub repository URL' }, 400)
    const [, owner, repo] = githubMatch
    const isImage = isImageFile(filename)
    const isBinary = isBinaryFile(filename)
    if (isBinary && !isImage)
      return c.json({
        success: true,
        data: { filename, oldContent: '', newContent: '', language: 'text', isBinary: true, isImage: false },
      })

    const isNodeModulesFile = filename.includes('/node_modules/')
    let oldContent = ''
    let newContent = ''
    let isBase64 = false
    let fileFound = false

    if (mode === 'local') {
      if (!isNodeModulesFile) {
        const remoteResult = await getFileContentFromGitHub(octokit, owner, repo, filename, task.branchName, isImage)
        oldContent = remoteResult.content
        isBase64 = remoteResult.isBase64
      }
      if (task.sandboxId) {
        try {
          const sandbox = await getTaskSandbox(task, envId)
          if (sandbox) {
            const normalizedPath = filename.startsWith('/') ? filename.substring(1) : filename
            const result = await readFileFromSandbox(sandbox, normalizedPath, { isImage })
            if (result.found) {
              newContent = result.content
              if (result.isBase64) isBase64 = true
              fileFound = true
            }
          }
        } catch (sandboxError) {
          console.error('Error reading from sandbox:', sandboxError)
        }
      }
      if (!fileFound) return c.json({ error: 'File not found in sandbox' }, 404)
    } else {
      let content = ''
      if (isNodeModulesFile && task.sandboxId) {
        try {
          const sandbox = await getTaskSandbox(task, envId)
          if (sandbox) {
            const normalizedPath = filename.startsWith('/') ? filename.substring(1) : filename
            const result = await readFileFromSandbox(sandbox, normalizedPath, { isImage })
            if (result.found) {
              content = result.content
              if (result.isBase64) isBase64 = true
              fileFound = true
            }
          }
        } catch (sandboxError) {
          console.error('Error reading node_modules file from sandbox:', sandboxError)
        }
      } else {
        const result = await getFileContentFromGitHub(octokit, owner, repo, filename, task.branchName, isImage)
        content = result.content
        isBase64 = result.isBase64
        if (content || isImage) fileFound = true
      }
      if (!fileFound && !isImage && !isNodeModulesFile && task.sandboxId) {
        try {
          const sandbox = await getTaskSandbox(task, envId)
          if (sandbox) {
            const normalizedPath = filename.startsWith('/') ? filename.substring(1) : filename
            const result = await readFileFromSandbox(sandbox, normalizedPath, { isImage })
            if (result.found) {
              content = result.content
              if (result.isBase64) isBase64 = true
              fileFound = true
            }
          }
        } catch (sandboxError) {
          console.error('Error reading from sandbox:', sandboxError)
        }
      }
      if (!fileFound && !isImage) return c.json({ error: 'File not found in branch' }, 404)
      oldContent = ''
      newContent = content
    }
    return c.json({
      success: true,
      data: {
        filename,
        oldContent,
        newContent,
        language: getLanguageFromFilename(filename),
        isBinary: false,
        isImage,
        isBase64,
      },
    })
  } catch (error) {
    console.error('Error in file-content API:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/save-file
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/save-file', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { filename, content } = body
    if (!filename || content === undefined) return c.json({ error: 'Missing filename or content' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ error: 'Task does not have an active sandbox' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ error: 'Sandbox not available' }, 400)
    const success = await writeFileToSandbox(sandbox, filename, content)
    if (!success) return c.json({ error: 'Failed to write file to sandbox' }, 500)

    // Persist changes to git archive in background (don't block response)
    archiveToGit(sandbox, taskId, `Edit ${filename}`).catch(() => {
      // Non-critical: file is saved in sandbox, git push is best-effort
    })

    return c.json({ success: true, message: 'File saved successfully' })
  } catch (error) {
    console.error('Error in save-file API:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/create-file
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/create-file', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { filename } = body
    if (!filename || typeof filename !== 'string') return c.json({ success: false, error: 'Filename is required' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox not available' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not found or inactive' }, 400)
    const pathParts = filename.split('/')
    if (pathParts.length > 1) {
      const dirPath = pathParts.slice(0, -1).join('/')
      const mkdirResult = await runCommandInSandbox(sandbox, `mkdir -p '${dirPath.replace(/'/g, "'\\''")}'`)
      if (!mkdirResult.success) return c.json({ success: false, error: 'Failed to create parent directories' }, 500)
    }
    const touchResult = await runCommandInSandbox(sandbox, `touch '${filename.replace(/'/g, "'\\''")}'`)
    if (!touchResult.success) return c.json({ success: false, error: 'Failed to create file' }, 500)
    return c.json({ success: true, message: 'File created successfully', filename })
  } catch {
    return c.json({ success: false, error: 'An error occurred while creating the file' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/create-folder
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/create-folder', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { foldername } = body
    if (!foldername || typeof foldername !== 'string')
      return c.json({ success: false, error: 'Foldername is required' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox not available' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not found or inactive' }, 400)
    const mkdirResult = await runCommandInSandbox(sandbox, `mkdir -p '${foldername.replace(/'/g, "'\\''")}'`)
    if (!mkdirResult.success) return c.json({ success: false, error: 'Failed to create folder' }, 500)
    return c.json({ success: true, message: 'Folder created successfully', foldername })
  } catch {
    return c.json({ success: false, error: 'An error occurred while creating the folder' }, 500)
  }
})

// ---------------------------------------------------------------------------
// DELETE /:taskId/delete-file
// ---------------------------------------------------------------------------
tasksRouter.delete('/:taskId/delete-file', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { filename } = body
    if (!filename || typeof filename !== 'string') return c.json({ success: false, error: 'Filename is required' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox not available' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not found or inactive' }, 400)
    const rmResult = await runCommandInSandbox(sandbox, `rm '${filename.replace(/'/g, "'\\''")}'`)
    if (!rmResult.success) return c.json({ success: false, error: 'Failed to delete file' }, 500)
    return c.json({ success: true, message: 'File deleted successfully', filename })
  } catch {
    return c.json({ success: false, error: 'An error occurred while deleting the file' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/discard-file-changes
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/discard-file-changes', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { filename } = body
    if (!filename) return c.json({ success: false, error: 'Missing filename parameter' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox not available' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not found or inactive' }, 400)
    const escapedFilename = filename.replace(/'/g, "'\\''")
    const lsFilesResult = await runCommandInSandbox(sandbox, `git ls-files '${escapedFilename}'`)
    const isTracked = (lsFilesResult.output || '').trim().length > 0
    if (isTracked) {
      const checkoutResult = await runCommandInSandbox(sandbox, `git checkout HEAD -- '${escapedFilename}'`)
      if (!checkoutResult.success) return c.json({ success: false, error: 'Failed to discard changes' }, 500)
    } else {
      const rmResult = await runCommandInSandbox(sandbox, `rm '${escapedFilename}'`)
      if (!rmResult.success) return c.json({ success: false, error: 'Failed to delete file' }, 500)
    }
    return c.json({
      success: true,
      message: isTracked ? 'Changes discarded successfully' : 'New file deleted successfully',
    })
  } catch {
    return c.json({ success: false, error: 'An error occurred while discarding changes' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/diff
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/diff', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const filename = c.req.query('filename')
    const mode = c.req.query('mode')
    if (!filename) return c.json({ error: 'Missing filename parameter' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.branchName || !task.repoUrl)
      return c.json({ error: 'Task does not have branch or repository information' }, 400)

    if (mode === 'local') {
      if (!task.sandboxId) return c.json({ error: 'Sandbox not available' }, 400)
      try {
        const sandbox = await getTaskSandbox(task, envId)
        if (!sandbox) return c.json({ error: 'Sandbox not found or inactive' }, 400)
        await runCommandInSandbox(sandbox, `git fetch origin ${task.branchName}`)
        const checkRemoteResult = await runCommandInSandbox(sandbox, `git rev-parse --verify origin/${task.branchName}`)
        const remoteBranchExists = checkRemoteResult.success
        if (!remoteBranchExists) {
          const oldContentResult = await runCommandInSandbox(sandbox, `git show HEAD:${filename}`)
          const oldContent = oldContentResult.success ? oldContentResult.output || '' : ''
          const newContentFile = await readFileFromSandbox(sandbox, filename)
          const newContent = newContentFile.found ? newContentFile.content : ''
          return c.json({
            success: true,
            data: {
              filename,
              oldContent,
              newContent,
              language: getLanguageFromFilename(filename),
              isBinary: false,
              isImage: false,
            },
          })
        }
        const remoteBranchRef = `origin/${task.branchName}`
        const oldContentResult = await runCommandInSandbox(sandbox, `git show ${remoteBranchRef}:${filename}`)
        const oldContent = oldContentResult.success ? oldContentResult.output || '' : ''
        const newContentFile = await readFileFromSandbox(sandbox, filename)
        const newContent = newContentFile.found ? newContentFile.content : ''
        return c.json({
          success: true,
          data: {
            filename,
            oldContent,
            newContent,
            language: getLanguageFromFilename(filename),
            isBinary: false,
            isImage: false,
          },
        })
      } catch {
        return c.json({ error: 'Failed to get local diff' }, 500)
      }
    }

    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ error: 'GitHub authentication required' }, 401)
    const githubMatch = task.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (!githubMatch) return c.json({ error: 'Invalid GitHub repository URL' }, 400)
    const [, owner, repo] = githubMatch
    const isImage = isImageFile(filename)
    const isBinary = isBinaryFile(filename)
    if (isBinary && !isImage)
      return c.json({
        success: true,
        data: { filename, oldContent: '', newContent: '', language: 'text', isBinary: true, isImage: false },
      })

    let oldContent = ''
    let newContent = ''
    let newIsBase64 = false
    let baseRef = 'main'
    let headRef = task.branchName
    if (task.prNumber) {
      try {
        const prResponse = await octokit.rest.pulls.get({ owner, repo, pull_number: task.prNumber })
        baseRef = prResponse.data.base.sha
        headRef = prResponse.data.head.sha
        if (prResponse.data.merged_at && prResponse.data.merge_commit_sha && !task.prMergeCommitSha) {
          await getDb().tasks.update(task.id, {
            prMergeCommitSha: prResponse.data.merge_commit_sha,
            updatedAt: Date.now(),
          })
        }
      } catch {
        /* fall through */
      }
    }
    try {
      const result = await getFileContentFromGitHub(octokit, owner, repo, filename, baseRef, isImage)
      oldContent = result.content
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error as { status: number }).status === 404 &&
        baseRef === 'main'
      ) {
        try {
          const result = await getFileContentFromGitHub(octokit, owner, repo, filename, 'master', isImage)
          oldContent = result.content
        } catch {
          oldContent = ''
        }
      }
    }
    try {
      const result = await getFileContentFromGitHub(octokit, owner, repo, filename, headRef, isImage)
      newContent = result.content
      newIsBase64 = result.isBase64
    } catch {
      newContent = ''
    }
    if (!oldContent && !newContent) return c.json({ error: 'File not found in either branch' }, 404)
    return c.json({
      success: true,
      data: {
        filename,
        oldContent: oldContent || '',
        newContent: newContent || '',
        language: getLanguageFromFilename(filename),
        isBinary: false,
        isImage,
        isBase64: newIsBase64,
      },
    })
  } catch (error) {
    console.error('Error in diff API:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/pr
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/pr', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { title, body: prBody, baseBranch = 'main' } = body
    if (!title) return c.json({ error: 'PR title is required' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.repoUrl || !task.branchName)
      return c.json({ error: 'Task does not have repository or branch information' }, 400)
    if (task.prUrl)
      return c.json({ success: true, data: { prUrl: task.prUrl, prNumber: task.prNumber, alreadyExists: true } })
    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ error: 'GitHub account not connected' }, 401)
    const parsed = parseGitHubUrl(task.repoUrl)
    if (!parsed) return c.json({ error: 'Invalid GitHub repository URL' }, 400)
    const { owner, repo } = parsed
    const response = await octokit.rest.pulls.create({
      owner,
      repo,
      title,
      body: prBody || '',
      head: task.branchName,
      base: baseBranch,
    })
    const updatedTask = await getDb().tasks.update(taskId, {
      prUrl: response.data.html_url,
      prNumber: response.data.number,
      prStatus: 'open',
      updatedAt: Date.now(),
    })
    return c.json({
      success: true,
      data: { prUrl: response.data.html_url, prNumber: response.data.number, task: updatedTask },
    })
  } catch (error) {
    console.error('Error creating pull request:', error)
    return c.json({ error: 'Failed to create pull request' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/sync-changes
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/sync-changes', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const { commitMessage } = body
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox not available' }, 400)
    if (!task.branchName) return c.json({ success: false, error: 'Branch not available' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not found or inactive' }, 400)
    const addResult = await runCommandInSandbox(sandbox, 'git add .')
    if (!addResult.success) return c.json({ success: false, error: 'Failed to add changes' }, 500)
    const statusResult = await runCommandInSandbox(sandbox, 'git status --porcelain')
    if (!statusResult.success) return c.json({ success: false, error: 'Failed to check status' }, 500)
    const statusOutput = statusResult.output || ''
    if (!statusOutput.trim())
      return c.json({ success: true, message: 'No changes to sync', committed: false, pushed: false })
    const message = commitMessage || 'Sync local changes'
    const escapedMessage = message.replace(/'/g, "'\\''")
    const commitResult = await runCommandInSandbox(sandbox, `git commit -m '${escapedMessage}'`)
    if (!commitResult.success) return c.json({ success: false, error: 'Failed to commit changes' }, 500)
    const pushResult = await runCommandInSandbox(sandbox, `git push origin ${task.branchName}`)
    if (!pushResult.success) return c.json({ success: false, error: 'Failed to push changes' }, 500)
    return c.json({ success: true, message: 'Changes synced successfully', committed: true, pushed: true })
  } catch {
    return c.json({ success: false, error: 'An error occurred while syncing changes' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/sync-pr
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/sync-pr', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.repoUrl || !task.prNumber)
      return c.json({ error: 'Task does not have repository or PR information' }, 400)
    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ error: 'GitHub account not connected' }, 401)
    const parsed = parseGitHubUrl(task.repoUrl)
    if (!parsed) return c.json({ error: 'Invalid GitHub repository URL' }, 400)
    const { owner, repo } = parsed
    const response = await octokit.rest.pulls.get({ owner, repo, pull_number: task.prNumber })
    let status: 'open' | 'closed' | 'merged'
    if (response.data.merged_at) status = 'merged'
    else if (response.data.state === 'closed') status = 'closed'
    else status = 'open'
    const mergeCommitSha = response.data.merge_commit_sha || null
    const updateData: { prStatus: string; prMergeCommitSha: string | null; completedAt?: number; updatedAt: number } = {
      prStatus: status,
      prMergeCommitSha: mergeCommitSha,
      updatedAt: Date.now(),
    }
    if (status === 'merged') updateData.completedAt = Date.now()
    await getDb().tasks.update(taskId, updateData)
    return c.json({ success: true, data: { status, mergeCommitSha } })
  } catch (error) {
    console.error('Error syncing pull request status:', error)
    return c.json({ error: 'Failed to sync pull request status' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/merge-pr
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/merge-pr', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { commitTitle, commitMessage, mergeMethod = 'squash' } = body
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.repoUrl || !task.prNumber)
      return c.json({ error: 'Task does not have repository or PR information' }, 400)
    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ error: 'GitHub account not connected' }, 401)
    const parsed = parseGitHubUrl(task.repoUrl)
    if (!parsed) return c.json({ error: 'Invalid GitHub repository URL' }, 400)
    const { owner, repo } = parsed
    const response = await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: task.prNumber,
      commit_title: commitTitle,
      commit_message: commitMessage,
      merge_method: mergeMethod,
    })
    await getDb().tasks.update(taskId, {
      prStatus: 'merged',
      prMergeCommitSha: response.data.sha || null,
      sandboxId: null,
      sandboxUrl: null,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    })
    return c.json({
      success: true,
      data: { merged: response.data.merged, message: response.data.message, sha: response.data.sha },
    })
  } catch (error) {
    console.error('Error merging pull request:', error)
    return c.json({ error: 'Failed to merge pull request' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/close-pr
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/close-pr', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.repoUrl || !task.prNumber) return c.json({ error: 'Task does not have a pull request' }, 400)
    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ error: 'GitHub authentication required' }, 401)
    const parsed = parseGitHubUrl(task.repoUrl)
    if (!parsed) return c.json({ error: 'Invalid GitHub repository URL' }, 400)
    const { owner, repo } = parsed
    try {
      await octokit.rest.pulls.update({ owner, repo, pull_number: task.prNumber, state: 'closed' })
      await getDb().tasks.update(task.id, { prStatus: 'closed', updatedAt: Date.now() })
      return c.json({ success: true, message: 'Pull request closed successfully' })
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error) {
        const status = (error as { status: number }).status
        if (status === 404) return c.json({ error: 'Pull request not found' }, 404)
        if (status === 403) return c.json({ error: 'Permission denied. Check repository access' }, 403)
      }
      return c.json({ error: 'Failed to close pull request' }, 500)
    }
  } catch (error) {
    console.error('Error in close PR API:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/reopen-pr
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/reopen-pr', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.repoUrl || !task.prNumber) return c.json({ error: 'Task does not have a pull request' }, 400)
    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ error: 'GitHub authentication required' }, 401)
    const parsed = parseGitHubUrl(task.repoUrl)
    if (!parsed) return c.json({ error: 'Invalid GitHub repository URL' }, 400)
    const { owner, repo } = parsed
    try {
      await octokit.rest.pulls.update({ owner, repo, pull_number: task.prNumber, state: 'open' })
      await getDb().tasks.update(task.id, { prStatus: 'open', updatedAt: Date.now() })
      return c.json({ success: true, message: 'Pull request reopened successfully' })
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error) {
        const status = (error as { status: number }).status
        if (status === 404) return c.json({ error: 'Pull request not found' }, 404)
        if (status === 403) return c.json({ error: 'Permission denied. Check repository access' }, 403)
      }
      return c.json({ error: 'Failed to reopen pull request' }, 500)
    }
  } catch (error) {
    console.error('Error in reopen PR API:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/project-files
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/project-files', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ error: 'Task does not have an active sandbox' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ error: 'Sandbox not available' }, 400)
    return c.json({ success: true, files: [] })
  } catch (error) {
    console.error('Error in project-files API:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/lsp
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/lsp', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const task = await getDb().tasks.findById(taskId)
    if (!task || task.userId !== session.user.id) return c.json({ error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ error: 'Task does not have an active sandbox' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ error: 'Sandbox not available' }, 400)
    const body = await c.req.json()
    const { method, filename, position } = body
    const absoluteFilename = filename.startsWith('/') ? filename : `/${filename}`
    switch (method) {
      case 'textDocument/definition': {
        const scriptPath = '.lsp-helper.mjs'
        const helperScript = `
import ts from 'typescript';
import fs from 'fs';
import path from 'path';
const filename = '${absoluteFilename.replace(/'/g, "\\'")}';
const line = ${position.line};
const character = ${position.character};
let configPath = process.cwd();
while (configPath !== '/') { const tsconfigPath = path.join(configPath, 'tsconfig.json'); if (fs.existsSync(tsconfigPath)) { break; } configPath = path.dirname(configPath); }
const tsconfigPath = path.join(configPath, 'tsconfig.json');
const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configPath);
const files = new Map();
const host = {
  getScriptFileNames: () => parsedConfig.fileNames,
  getScriptVersion: (fileName) => { const file = files.get(fileName); return file && file.version ? file.version.toString() : '0'; },
  getScriptSnapshot: (fileName) => { if (!fs.existsSync(fileName)) return undefined; const content = fs.readFileSync(fileName, 'utf8'); return ts.ScriptSnapshot.fromString(content); },
  getCurrentDirectory: () => configPath,
  getCompilationSettings: () => parsedConfig.options,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const fullPath = path.resolve(configPath, filename.replace(/^\\/*/g, ''));
const program = service.getProgram();
if (!program) { console.error(JSON.stringify({ error: 'Failed to get program' })); process.exit(1); }
const sourceFile = program.getSourceFile(fullPath);
if (!sourceFile) { console.error(JSON.stringify({ error: 'File not found', filename: fullPath })); process.exit(1); }
const offset = ts.getPositionOfLineAndCharacter(sourceFile, line, character);
const definitions = service.getDefinitionAtPosition(fullPath, offset);
if (definitions && definitions.length > 0) {
  const results = definitions.map(def => { const defSourceFile = program.getSourceFile(def.fileName); if (!defSourceFile) return null; const start = ts.getLineAndCharacterOfPosition(defSourceFile, def.textSpan.start); const end = ts.getLineAndCharacterOfPosition(defSourceFile, def.textSpan.start + def.textSpan.length); return { uri: 'file://' + def.fileName, range: { start, end } }; }).filter(def => def !== null);
  console.log(JSON.stringify({ definitions: results }));
} else { console.log(JSON.stringify({ definitions: [] })); }
`
        const writeSuccess = await writeFileToSandbox(sandbox, scriptPath, helperScript)
        if (!writeSuccess) return c.json({ definitions: [], error: 'Failed to write helper script' })
        const result = await runCommandInSandbox(sandbox, `node ${scriptPath}`)
        await runCommandInSandbox(sandbox, `rm ${scriptPath}`)
        if (!result.success) return c.json({ definitions: [], error: 'Script execution failed' })
        try {
          return c.json(JSON.parse((result.output || '').trim()))
        } catch {
          return c.json({ definitions: [], error: 'Failed to parse TypeScript response' })
        }
      }
      case 'textDocument/hover':
        return c.json({ hover: null })
      case 'textDocument/completion':
        return c.json({ completions: [] })
      default:
        return c.json({ error: 'Unsupported LSP method' }, 400)
    }
  } catch (error) {
    console.error('LSP request error:', error)
    return c.json({ error: 'Failed to process LSP request' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/terminal
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/terminal', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const { command } = await c.req.json()
    if (!command || typeof command !== 'string') return c.json({ success: false, error: 'Command is required' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'No sandbox found for this task' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not available' }, 400)
    try {
      const result = await runCommandInSandbox(sandbox, command)
      return c.json({
        success: true,
        data: {
          exitCode: result.exitCode ?? (result.success ? 0 : 1),
          stdout: result.output || '',
          stderr: result.error || '',
        },
      })
    } catch (error) {
      console.error('Error executing command:', error)
      return c.json({ success: false, error: 'Command execution failed' }, 500)
    }
  } catch (error) {
    console.error('Error in terminal endpoint:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/autocomplete
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/autocomplete', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const { partial, cwd } = await c.req.json()
    if (typeof partial !== 'string') return c.json({ success: false, error: 'Partial text is required' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'No sandbox found for this task' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not available' }, 400)
    try {
      const pwdResult = await runCommandInSandbox(sandbox, 'pwd')
      let actualCwd = cwd || '/home/user'
      if (pwdResult.success && pwdResult.output && pwdResult.output.trim()) {
        actualCwd = pwdResult.output.trim()
      }
      const parts = partial.split(/\s+/)
      const lastPart = parts[parts.length - 1] || ''
      let dir = actualCwd
      let prefix = ''
      if (lastPart.includes('/')) {
        const lastSlash = lastPart.lastIndexOf('/')
        const pathPart = lastPart.substring(0, lastSlash + 1)
        prefix = lastPart.substring(lastSlash + 1)
        if (pathPart.startsWith('/')) dir = pathPart
        else if (pathPart.startsWith('~/')) dir = '/home/user/' + pathPart.substring(2)
        else dir = `${actualCwd}/${pathPart}`
      } else {
        prefix = lastPart
      }
      const escapedDir = "'" + dir.replace(/'/g, "'\\''") + "'"
      const lsCommand = `cd ${escapedDir} 2>/dev/null && ls -1ap 2>/dev/null || echo ""`
      const result = await runCommandInSandbox(sandbox, lsCommand)
      const stdout = result.output || ''
      if (!stdout) return c.json({ success: true, data: { completions: [] } })
      const completionFiles = stdout
        .trim()
        .split('\n')
        .filter((f) => f && f.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((f) => ({ name: f, isDirectory: f.endsWith('/') }))
      return c.json({ success: true, data: { completions: completionFiles, prefix } })
    } catch (error) {
      console.error('Error getting completions:', error)
      return c.json({ success: false, error: 'Failed to get completions' }, 500)
    }
  } catch (error) {
    console.error('Error in autocomplete endpoint:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/check-runs
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/check-runs', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.branchName || !task.repoUrl) return c.json({ success: false, error: 'Task does not have a branch' }, 400)
    const repoMatch = task.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (!repoMatch) return c.json({ success: false, error: 'Invalid repository URL' }, 400)
    const [, owner, repo] = repoMatch
    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ success: false, error: 'GitHub authentication required' }, 401)
    let branchData
    try {
      branchData = await octokit.rest.repos.getBranch({ owner, repo, branch: task.branchName })
    } catch (branchError) {
      if (
        branchError &&
        typeof branchError === 'object' &&
        'status' in branchError &&
        (branchError as { status: number }).status === 404
      )
        return c.json({ success: true, checkRuns: [] })
      throw branchError
    }
    const commitSha = branchData.data.commit.sha
    const { data: checkRunsData } = await octokit.rest.checks.listForRef({ owner, repo, ref: commitSha })
    return c.json({
      success: true,
      checkRuns: checkRunsData.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        html_url: run.html_url,
        started_at: run.started_at,
        completed_at: run.completed_at,
      })),
    })
  } catch (error) {
    console.error('Error fetching check runs:', error)
    return c.json({ success: false, error: 'Failed to fetch check runs' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/deployment
// ---------------------------------------------------------------------------
function convertFeedbackUrlToDeploymentUrl(url: string): string {
  const feedbackMatch = url.match(/vercel\.live\/open-feedback\/(.+)/)
  if (feedbackMatch) return `https://${feedbackMatch[1]}`
  return url
}

tasksRouter.get('/:taskId/deployment', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (task.previewUrl) {
      const previewUrl = convertFeedbackUrlToDeploymentUrl(task.previewUrl)
      if (previewUrl !== task.previewUrl) await getDb().tasks.update(taskId, { previewUrl })
      return c.json({ success: true, data: { hasDeployment: true, previewUrl, cached: true } })
    }
    if (!task.branchName || !task.repoUrl)
      return c.json({
        success: true,
        data: { hasDeployment: false, message: 'Task does not have branch or repository information' },
      })
    const githubMatch = task.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (!githubMatch)
      return c.json({ success: true, data: { hasDeployment: false, message: 'Invalid GitHub repository URL' } })
    const [, owner, repo] = githubMatch
    try {
      const octokit = await getOctokit(session.user.id)
      if (!octokit.auth)
        return c.json({ success: true, data: { hasDeployment: false, message: 'GitHub account not connected' } })
      let latestCommitSha: string | null = null
      try {
        const { data: branch } = await octokit.rest.repos.getBranch({ owner, repo, branch: task.branchName })
        latestCommitSha = branch.commit.sha
      } catch (branchError) {
        if (
          branchError &&
          typeof branchError === 'object' &&
          'status' in branchError &&
          (branchError as { status: number }).status === 404
        )
          return c.json({ success: true, data: { hasDeployment: false, message: 'Branch not found' } })
        throw branchError
      }
      if (latestCommitSha) {
        try {
          const { data: checkRuns } = await octokit.rest.checks.listForRef({
            owner,
            repo,
            ref: latestCommitSha,
            per_page: 100,
          })
          const extractPreviewUrl = (check: {
            output?: { summary?: string | null; text?: string | null } | null
          }): string | null => {
            if (check.output?.summary) {
              const urlMatch = check.output.summary.match(/https?:\/\/[^\s\)\]<]+\.vercel\.app/i)
              if (urlMatch) return urlMatch[0]
            }
            if (check.output?.text) {
              const urlMatch = check.output.text.match(/https?:\/\/[^\s\)\]<]+\.vercel\.app/i)
              if (urlMatch) return urlMatch[0]
            }
            return null
          }
          const vercelPreviewCheck = checkRuns.check_runs.find(
            (check) =>
              check.app?.slug === 'vercel' && check.name === 'Vercel Preview Comments' && check.status === 'completed',
          )
          const vercelDeploymentCheck = checkRuns.check_runs.find(
            (check) =>
              check.app?.slug === 'vercel' &&
              check.name === 'Vercel' &&
              check.conclusion === 'success' &&
              check.status === 'completed',
          )
          let previewUrl: string | null = null
          if (vercelPreviewCheck) previewUrl = extractPreviewUrl(vercelPreviewCheck)
          if (!previewUrl && vercelDeploymentCheck) previewUrl = extractPreviewUrl(vercelDeploymentCheck)
          if (!previewUrl && vercelDeploymentCheck?.details_url)
            previewUrl = convertFeedbackUrlToDeploymentUrl(vercelDeploymentCheck.details_url)
          if (previewUrl) {
            await getDb().tasks.update(taskId, { previewUrl })
            return c.json({
              success: true,
              data: {
                hasDeployment: true,
                previewUrl,
                checkId: vercelDeploymentCheck?.id || vercelPreviewCheck?.id,
                createdAt: vercelDeploymentCheck?.completed_at || vercelPreviewCheck?.completed_at,
              },
            })
          }
        } catch (checksError) {
          console.error('Error checking GitHub Checks:', checksError)
        }
      }
      try {
        const { data: ghDeployments } = await octokit.rest.repos.listDeployments({
          owner,
          repo,
          ref: task.branchName,
          per_page: 10,
        })
        if (ghDeployments && ghDeployments.length > 0) {
          for (const deployment of ghDeployments) {
            if (
              deployment.environment === 'Preview' ||
              deployment.environment === 'preview' ||
              deployment.description?.toLowerCase().includes('vercel')
            ) {
              const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
                owner,
                repo,
                deployment_id: deployment.id,
                per_page: 1,
              })
              if (statuses && statuses.length > 0) {
                const status = statuses[0]
                if (status.state === 'success') {
                  let previewUrl = status.environment_url || status.target_url
                  if (previewUrl) {
                    previewUrl = convertFeedbackUrlToDeploymentUrl(previewUrl)
                    await getDb().tasks.update(taskId, { previewUrl })
                    return c.json({
                      success: true,
                      data: {
                        hasDeployment: true,
                        previewUrl,
                        deploymentId: deployment.id,
                        createdAt: deployment.created_at,
                      },
                    })
                  }
                }
              }
            }
          }
        }
      } catch (deploymentsError) {
        console.error('Error checking GitHub Deployments:', deploymentsError)
      }
      if (latestCommitSha) {
        try {
          const { data: statuses } = await octokit.rest.repos.listCommitStatusesForRef({
            owner,
            repo,
            ref: latestCommitSha,
            per_page: 100,
          })
          const vercelStatus = statuses.find(
            (s) => s.context?.toLowerCase().includes('vercel') && s.state === 'success' && s.target_url,
          )
          if (vercelStatus && vercelStatus.target_url) {
            const previewUrl = convertFeedbackUrlToDeploymentUrl(vercelStatus.target_url)
            await getDb().tasks.update(taskId, { previewUrl })
            return c.json({
              success: true,
              data: { hasDeployment: true, previewUrl, createdAt: vercelStatus.created_at },
            })
          }
        } catch (statusError) {
          console.error('Error checking commit statuses:', statusError)
        }
      }
      return c.json({ success: true, data: { hasDeployment: false, message: 'No successful deployment found' } })
    } catch (error) {
      console.error('Error fetching deployment status:', error)
      if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404)
        return c.json({ success: true, data: { hasDeployment: false, message: 'Branch or repository not found' } })
      return c.json({ success: true, data: { hasDeployment: false, message: 'Failed to fetch deployment status' } })
    }
  } catch (error) {
    console.error('Error in deployment API:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/deployments
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/deployments', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    const taskDeployments = await getDb().deployments.findByTaskId(taskId)
    return c.json({
      deployments: taskDeployments.map((d) => ({ ...d, metadata: d.metadata ? JSON.parse(d.metadata) : null })),
    })
  } catch (error) {
    console.error('Error fetching deployments:', error)
    return c.json({ error: 'Failed to fetch deployments' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/deployments
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/deployments', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { type = 'web', url, qrCodeUrl, pagePath, appId, label, metadata } = body
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)

    let path: string | null = null
    if (type === 'web' && url) {
      try {
        const urlObj = new URL(url)
        path = urlObj.pathname
      } catch {
        /* ignore */
      }
    }
    const now = Date.now()
    const deploymentId = nanoid(12)

    if (type === 'miniprogram') {
      const existing = await getDb().deployments.findByTaskIdAndTypePath(taskId, 'miniprogram', null)
      if (existing) {
        const updated = await getDb().deployments.update(existing.id, {
          qrCodeUrl: qrCodeUrl || existing.qrCodeUrl,
          pagePath: pagePath || existing.pagePath,
          appId: appId || existing.appId,
          label: label || existing.label,
          metadata: metadata ? JSON.stringify(metadata) : existing.metadata,
          updatedAt: now,
        })
        return c.json({ deployment: { ...updated, metadata } })
      }
    } else if (type === 'web' && path) {
      const existing = await getDb().deployments.findByTaskIdAndTypePath(taskId, 'web', path)
      if (existing) {
        const updated = await getDb().deployments.update(existing.id, {
          url: url || existing.url,
          label: label || existing.label,
          metadata: metadata ? JSON.stringify(metadata) : existing.metadata,
          updatedAt: now,
        })
        return c.json({ deployment: { ...updated, metadata } })
      }
    }

    const newDeployment = await getDb().deployments.create({
      id: deploymentId,
      taskId,
      type,
      url: url || null,
      path: path || null,
      qrCodeUrl: qrCodeUrl || null,
      pagePath: pagePath || null,
      appId: appId || null,
      label: label || null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt: now,
      updatedAt: now,
    })
    return c.json({ deployment: { ...newDeployment, metadata } })
  } catch (error) {
    console.error('Error creating deployment:', error)
    return c.json({ error: 'Failed to create deployment' }, 500)
  }
})

// ---------------------------------------------------------------------------
// DELETE /:taskId/deployments/:deploymentId
// ---------------------------------------------------------------------------
tasksRouter.delete('/:taskId/deployments/:deploymentId', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId, deploymentId } = c.req.param()
    // Complex join query: verify deployment belongs to user's task
    const deployment = await getDb().deployments.findByTaskIdAndUserId(taskId, session.user.id)
    if (!deployment || deployment.id !== deploymentId) return c.json({ error: 'Deployment not found' }, 404)
    await getDb().deployments.softDelete(deploymentId)
    return c.json({ success: true })
  } catch (error) {
    console.error('Error deleting deployment:', error)
    return c.json({ error: 'Failed to delete deployment' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/sandbox-health
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/sandbox-health', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ status: 'not_found' })
    if (!task.sandboxId) return c.json({ status: 'not_available', message: 'Sandbox not created yet' })
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ status: 'stopped', message: 'Sandbox not available' })
    const result = await runCommandInSandbox(sandbox, 'echo ok')
    if (result.success) return c.json({ status: 'running', message: 'Sandbox is running' })
    return c.json({ status: 'error', message: 'Sandbox is not responding' })
  } catch (error) {
    console.error('Error checking sandbox health:', error)
    return c.json({ status: 'error', message: 'Failed to check sandbox health' })
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/preview-health — dev server via TRW GET /preview/ports
// ---------------------------------------------------------------------------

tasksRouter.get('/:taskId/preview-health', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ status: 'not_found' })
    if (!task.sandboxId) return c.json({ status: 'no_sandbox' })

    const taskMode = (task as any).mode as string | null | undefined
    const isCodingMode = taskMode === 'coding'
    const sandbox = await getTaskSandbox(task, envId, { isCodingMode })
    if (!sandbox) return c.json({ status: 'no_sandbox' })

    const res = await sandbox.request('/preview/ports', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      return c.json({ status: 'error', message: `preview/ports returned ${res.status}` })
    }
    const info = (await res.json()) as { ports?: Array<{ port: number }> }
    const ports = Array.isArray(info.ports) ? info.ports.map((p) => p.port) : []
    const vitePort = ports.includes(STATEFUL_DEFAULT_VITE_PORT) ? STATEFUL_DEFAULT_VITE_PORT : (ports[0] ?? null)
    const alive = vitePort !== null
    return c.json({ status: alive ? 'running' : 'stopped', vitePort })
  } catch (error) {
    return c.json({ status: 'error', message: (error as Error).message })
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/start-sandbox
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/start-sandbox', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const task = await getDb().tasks.findById(taskId)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (task.userId !== session.user.id) return c.json({ error: 'Unauthorized' }, 403)
    if (!task.keepAlive) return c.json({ error: 'Keep-alive is not enabled for this task' }, 400)
    const logger = createTaskLogger(taskId)
    if (task.sandboxId) {
      try {
        const existingSandbox = await getTaskSandbox(task, envId)
        if (existingSandbox) {
          const testResult = await runCommandInSandbox(existingSandbox, 'echo test')
          if (testResult.success) return c.json({ error: 'Sandbox is already running' }, 400)
        }
      } catch {
        await logger.info('Existing sandbox not accessible, creating new one')
        await getDb().tasks.update(taskId, { sandboxId: null, sandboxUrl: null, updatedAt: Date.now() })
      }
    }
    await logger.info('Starting sandbox')
    const provider = getSandboxProvider()
    const sandbox = await provider.acquire(
      buildStatefulAcquireContext({
        envId,
        taskId,
        userId: task.userId,
        sandboxMode: task.sandboxMode,
        sandboxId: null,
      }),
    )
    await getDb().tasks.update(taskId, { sandboxId: sandbox.id, updatedAt: Date.now() })
    await logger.info('Sandbox started successfully')
    return c.json({ success: true, message: 'Sandbox started successfully', sandboxId: sandbox.id })
  } catch (error) {
    console.error('Error starting sandbox:', error)
    return c.json({ error: 'Failed to start sandbox' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/stop-sandbox
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/stop-sandbox', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const task = await getDb().tasks.findById(taskId)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (task.userId !== session.user.id) return c.json({ error: 'Unauthorized' }, 403)
    if (!task.sandboxId) return c.json({ error: 'Sandbox is not active' }, 400)
    const sandbox = await getTaskSandbox(task, envId).catch(() => null)
    if (sandbox && task.sandboxMode === 'isolated') {
      const provider = getSandboxProvider()
      if (provider.destroy) await provider.destroy(sandbox)
    }
    await getDb().tasks.update(taskId, { sandboxId: null, sandboxUrl: null, updatedAt: Date.now() })
    return c.json({ success: true, message: 'Sandbox stopped successfully' })
  } catch (error) {
    console.error('Error stopping sandbox:', error)
    return c.json({ error: 'Failed to stop sandbox' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/restart-dev
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/restart-dev', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const task = await getDb().tasks.findById(taskId)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (task.userId !== session.user.id) return c.json({ error: 'Unauthorized' }, 403)
    if (!task.sandboxId) return c.json({ error: 'Sandbox is not active' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ error: 'Sandbox not available' }, 400)

    const packageJsonFile = await readFileFromSandbox(sandbox, 'package.json')
    if (!packageJsonFile.found) return c.json({ error: 'No package.json found in sandbox' }, 400)
    let packageJson: {
      scripts?: { dev?: string }
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    try {
      packageJson = JSON.parse(packageJsonFile.content)
    } catch {
      return c.json({ error: 'Could not parse package.json' }, 500)
    }
    if (!packageJson?.scripts?.dev) return c.json({ error: 'No dev script found in package.json' }, 400)

    const hasVite = packageJson?.dependencies?.vite || packageJson?.devDependencies?.vite
    const devPort = hasVite ? 5173 : 3000
    await runCommandInSandbox(sandbox, `lsof -ti:${devPort} | xargs -r kill -9 2>/dev/null || true`)

    const packageManager = await detectPackageManager(sandbox)
    const devCommand = packageManager === 'npm' ? 'npm run dev' : `${packageManager} dev`
    await runCommandInSandbox(sandbox, `nohup ${devCommand} > /dev/null 2>&1 &`)

    return c.json({ success: true, message: 'Dev server restarted successfully' })
  } catch (error) {
    console.error('Error restarting dev server:', error)
    return c.json({ error: 'Failed to restart dev server' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/clear-logs
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/clear-logs', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    await getDb().tasks.update(taskId, { logs: '[]' })
    return c.json({ success: true, message: 'Logs cleared successfully' })
  } catch (error) {
    console.error('Error clearing logs:', error)
    return c.json({ success: false, error: 'Failed to clear logs' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/pr-comments
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/pr-comments', async (c) => {
  try {
    const authErr = requireAuth(c)
    if (authErr) return authErr
    const session = c.get('session')!
    const { taskId } = c.req.param()
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.prNumber || !task.repoUrl) return c.json({ success: false, error: 'Task does not have a PR' }, 400)
    const repoMatch = task.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/)
    if (!repoMatch) return c.json({ success: false, error: 'Invalid repository URL' }, 400)
    const [, owner, repo] = repoMatch
    const octokit = await getOctokit(session.user.id)
    if (!octokit.auth) return c.json({ success: false, error: 'GitHub authentication required' }, 401)
    const [issueCommentsResponse, reviewCommentsResponse] = await Promise.all([
      octokit.rest.issues.listComments({ owner, repo, issue_number: task.prNumber }),
      octokit.rest.pulls.listReviewComments({ owner, repo, pull_number: task.prNumber }),
    ])
    const allComments = [
      ...issueCommentsResponse.data.map((comment) => ({
        id: comment.id,
        user: { login: comment.user?.login || 'unknown', avatar_url: comment.user?.avatar_url || '' },
        body: comment.body || '',
        created_at: comment.created_at,
        html_url: comment.html_url,
      })),
      ...reviewCommentsResponse.data.map((comment) => ({
        id: comment.id,
        user: { login: comment.user?.login || 'unknown', avatar_url: comment.user?.avatar_url || '' },
        body: comment.body || '',
        created_at: comment.created_at,
        html_url: comment.html_url,
      })),
    ]
    allComments.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    return c.json({ success: true, comments: allComments })
  } catch (error) {
    console.error('Error fetching PR comments:', error)
    return c.json({ success: false, error: 'Failed to fetch PR comments' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/file-operation
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/file-operation', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const body = await c.req.json()
    const { operation, sourceFile, targetPath } = body
    if (!operation || !sourceFile) return c.json({ success: false, error: 'Missing required parameters' }, 400)
    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ success: false, error: 'Sandbox not available' }, 400)
    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ success: false, error: 'Sandbox not found' }, 404)
    const sourceBasename = sourceFile.split('/').pop()
    const targetFile = targetPath ? `${targetPath}/${sourceBasename}` : sourceBasename
    const escapedSource = sourceFile.replace(/'/g, "'\\''")
    const escapedTarget = targetFile.replace(/'/g, "'\\''")
    if (operation === 'copy') {
      const copyResult = await runCommandInSandbox(sandbox, `cp -r '${escapedSource}' '${escapedTarget}'`)
      if (!copyResult.success) return c.json({ success: false, error: 'Failed to copy file' }, 500)
      return c.json({ success: true, message: 'File copied successfully' })
    } else if (operation === 'cut') {
      const mvResult = await runCommandInSandbox(sandbox, `mv '${escapedSource}' '${escapedTarget}'`)
      if (!mvResult.success) return c.json({ success: false, error: 'Failed to move file' }, 500)
      return c.json({ success: true, message: 'File moved successfully' })
    } else return c.json({ success: false, error: 'Invalid operation' }, 400)
  } catch (error) {
    console.error('Error performing file operation:', error)
    return c.json({ success: false, error: 'Failed to perform file operation' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/preview-url — streaming SSE: 逐步推送启动进度，最终发 gatewayUrl
// ---------------------------------------------------------------------------
// 事件格式: data: {"stage":"...","message":"..."}
//   stage = "progress" | "ready" | "error"
//   "ready" 事件包含 gatewayUrl，前端收到即可显示 iframe
// ---------------------------------------------------------------------------
//
// 超时策略（与 stage 相关）:
//   - 沙箱冷启动: ~60s
//   - 已有 node_modules: 检测 ~5s，启动 dev server ~10s
//   - 需要 npm install: ~60-120s
//   - dev server 启动: ~30s (PTY polling)

tasksRouter.get('/:taskId/preview-url', requireUserEnv, async (c) => {
  const session = c.get('session')!
  const { envId } = c.get('userEnv')!
  const { taskId } = c.req.param()

  const task = await findActiveTask(taskId, session.user.id)
  if (!task) return c.json({ error: 'Task not found' }, 404)

  return streamSSE(c, async (stream) => {
    const emit = async (stage: 'progress' | 'ready' | 'error', message: string, extra?: Record<string, unknown>) => {
      await stream.writeSSE({ data: JSON.stringify({ stage, message, ...extra }) }).catch(() => {})
    }

    try {
      const sandboxConfig = resolveSandboxConfig({
        sandboxCwd: task.sandboxCwd,
        sandboxMode: task.sandboxMode,
        envId,
        taskId,
      })
      let sandbox: SandboxInstance | null = null
      const resolvedCwd = sandboxConfig.sandboxCwd
      const taskMode = (task as any).mode as string | null | undefined
      const isCodingMode = taskMode === 'coding'
      const provider = getSandboxProvider()
      const { credentials: userCredentials } = c.get('userEnv')!

      if (task.sandboxId) {
        sandbox = await getTaskSandbox(task, envId, { isCodingMode })
      }

      if (!sandbox) {
        await emit('progress', '正在启动沙箱...')
        try {
          sandbox = await getTaskSandbox(task, envId, { isCodingMode, allowCreate: true })
          if (sandbox) {
            await getDb().tasks.update(taskId, {
              sandboxId: sandbox.id,
              sandboxCwd: STATEFUL_WORKSPACE_ROOT,
              sandboxMode: sandboxConfig.sandboxMode,
              updatedAt: Date.now(),
            })
          }
        } catch (err) {
          await emit('error', `沙箱启动失败: ${(err as Error).message}`)
          return
        }
      }

      if (!sandbox) {
        await emit('error', '沙箱启动失败')
        return
      }

      try {
        const prepared = await provider.prepare(sandbox, {
          credentials: {
            envId,
            secretId: userCredentials?.secretId || '',
            secretKey: userCredentials?.secretKey || '',
            sessionToken: userCredentials?.sessionToken || undefined,
          },
          workspaceHint: STATEFUL_WORKSPACE_ROOT,
          codingMode: isCodingMode,
          backendOptions: { backend: 'stateful' },
        })
        const workspace = prepared.workspace || STATEFUL_WORKSPACE_ROOT
        await getDb().tasks.update(taskId, {
          sandboxCwd: workspace,
          sandboxMode: sandboxConfig.sandboxMode,
          updatedAt: Date.now(),
        })
      } catch (err) {
        await emit('error', `工作空间初始化失败: ${(err as Error).message}`)
        return
      }

      if (isCodingMode) {
        try {
          await emit('progress', '正在初始化工作空间...')
          const envPayload = {
            CLOUDBASE_ENV_ID: envId,
            ...(userCredentials?.secretId ? { TENCENTCLOUD_SECRETID: userCredentials.secretId } : {}),
            ...(userCredentials?.secretKey ? { TENCENTCLOUD_SECRETKEY: userCredentials.secretKey } : {}),
            ...(userCredentials?.sessionToken ? { TENCENTCLOUD_SESSIONTOKEN: userCredentials.sessionToken } : {}),
          }
          await sandbox
            .request('/api/workspace/env', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(envPayload),
              signal: AbortSignal.timeout(30_000),
            })
            .catch((err: Error) => {
              console.warn('[preview-url] workspace env failed:', err.message)
            })
        } catch (err) {
          console.warn('[preview-url] workspace/env setup failed:', (err as Error).message)
        }
      }

      await emit('progress', '正在等待 TRW Vite 开发服务器就绪...')
      const viteReady = await waitForSandboxViteReady(sandbox, {
        port: STATEFUL_DEFAULT_VITE_PORT,
        maxWaitMs: 120_000,
        onProgress: async ({ message }) => {
          await emit('progress', message)
        },
      })
      const port = viteReady.port
      if (!isViteReadyResult(viteReady)) {
        await emit('error', viteReady.message ?? '开发服务器未就绪')
        return
      }

      // ── 获取网关 URL ──────────────────────────────────────────────────
      let previewBase: string
      try {
        previewBase = await getSandboxProvider().getPreviewBaseUrl(sandbox!)
      } catch {
        previewBase = `${sandbox!.baseUrl}/preview`
      }

      // Stateful: browser cannot attach gateway auth headers — proxy via OVC.
      const gatewayUrl = `/api/tasks/${taskId}/preview/${port}/`
      await emit('ready', 'Dev server ready', { gatewayUrl, port })
    } catch (err) {
      // 顶层异常兜底：确保前端总能收到 error 事件而非静默关闭
      console.error('[preview-url] Unhandled error in SSE callback:', err)
      await emit('error', `预览启动失败: ${(err as Error).message || '未知错误'}`)
    }
  })
})

// ---------------------------------------------------------------------------
// GET /:taskId/preview-errors — 代理沙箱内 Vite dev server 的 /__dev_errors
// 返回 { ok, buildErrors, runtimeErrors } 原样透传（来自 vite dev plugin）。
// 前端在两处消费：
//   1) task-details.tsx 手动"Fix errors"按钮
//   2) use-auto-fix hook：每轮对话完成 / iframe postMessage 触发时探测
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/preview-errors', requireUserEnv, async (c) => {
  const session = c.get('session')!
  const { taskId } = c.req.param()

  const task = await findActiveTask(taskId, session.user.id)
  if (!task) return c.json({ error: 'Task not found' }, 404)

  // 沙箱没启动：等价于"没有错误"（预览不存在就无从谈错）
  if (!task.sandboxId) {
    return c.json({ ok: true, buildErrors: [], runtimeErrors: [] })
  }

  try {
    const { envId } = c.get('userEnv')!
    const taskMode = (task as any).mode as string | null | undefined
    const isCodingMode = taskMode === 'coding'

    const sandbox = await getTaskSandbox(task, envId, { isCodingMode })
    if (!sandbox) {
      return c.json({ ok: true, buildErrors: [], runtimeErrors: [] })
    }

    // 1) TRW GET /preview/ports — no vite → no errors
    let vitePort: number | null = null
    try {
      const portsRes = await sandbox.request('/preview/ports', {
        signal: AbortSignal.timeout(4_000),
      })
      if (portsRes.ok) {
        const info = (await portsRes.json()) as { ports?: Array<{ port: number }> }
        const ports = Array.isArray(info.ports) ? info.ports.map((p) => p.port) : []
        vitePort = ports.includes(STATEFUL_DEFAULT_VITE_PORT) ? STATEFUL_DEFAULT_VITE_PORT : (ports[0] ?? null)
      }
    } catch {
      // preview/ports unavailable → treat as no vite
    }
    if (!vitePort) {
      return c.json({ ok: true, buildErrors: [], runtimeErrors: [] })
    }

    // 2) Same path as preview iframe: TRW /preview/{port}/__dev_errors via gateway auth
    const authHeaders = await sandbox.getAuthHeaders()
    const devErrorsUrl = `${sandbox.baseUrl}/preview/${vitePort}/__dev_errors`
    const res = await fetch(devErrorsUrl, {
      headers: authHeaders,
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      return c.json({ error: `dev server __dev_errors returned ${res.status}` }, 500 as const)
    }
    const data = (await res.json()) as {
      ok?: boolean
      buildErrors?: unknown[]
      runtimeErrors?: unknown[]
    }
    return c.json({
      ok:
        data.ok ??
        (Array.isArray(data.buildErrors) &&
          data.buildErrors.length === 0 &&
          Array.isArray(data.runtimeErrors) &&
          data.runtimeErrors.length === 0),
      buildErrors: Array.isArray(data.buildErrors) ? data.buildErrors : [],
      runtimeErrors: Array.isArray(data.runtimeErrors) ? data.runtimeErrors : [],
    })
  } catch (err) {
    console.error('[preview-errors] Failed to fetch __dev_errors:', err)
    return c.json({ error: (err as Error).message || 'internal error' }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /:taskId/files/download — Download file or folder (as zip) from sandbox
// ---------------------------------------------------------------------------
tasksRouter.get('/:taskId/files/download', requireUserEnv, async (c) => {
  try {
    const session = c.get('session')!
    const { envId } = c.get('userEnv')!
    const { taskId } = c.req.param()
    const rawPath = c.req.query('path')
    if (!rawPath) return c.json({ error: 'path is required' }, 400)
    const filePath = decodeURIComponent(rawPath).replace(/\.\./g, '').replace(/^\/+/, '') || '.'

    const task = await findActiveTask(taskId, session.user.id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.sandboxId) return c.json({ error: 'Sandbox is not running' }, 410)

    const sandbox = await getTaskSandbox(task, envId)
    if (!sandbox) return c.json({ error: 'Sandbox not found' }, 410)

    const basename = filePath === '.' ? 'workspace' : filePath.split('/').pop() || 'download'

    // Check if directory
    const statResult = await runCommandInSandbox(
      sandbox,
      `test -d '${filePath.replace(/'/g, "'\\''")}' && echo dir || echo file`,
    )
    const isDir = statResult.output?.trim() === 'dir'

    if (!isDir) {
      // Single file: fetch directly
      const ext = basename.split('.').pop()?.toLowerCase() || ''
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
        zip: 'application/zip',
        json: 'application/json',
        txt: 'text/plain',
        md: 'text/markdown',
        html: 'text/html',
        css: 'text/css',
        js: 'text/javascript',
        ts: 'text/typescript',
      }
      const bytes = await downloadFileFromSandbox(sandbox, filePath)
      if (!bytes) return c.json({ error: 'File not found' }, 404)
      const fileBuf = Buffer.from(bytes)
      return new Response(fileBuf, {
        headers: {
          'Content-Type': mimeMap[ext] || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${basename}"`,
          'Content-Length': String(fileBuf.byteLength),
        },
      })
    }

    // Directory: zip in sandbox → fetch the zip file → stream to browser
    const tmpZip = `.tmp/__dl_${Date.now()}.zip`
    const quoted = filePath.replace(/'/g, "'\\''")
    const cleanup = () => runCommandInSandbox(sandbox!, `rm -f '${tmpZip}'`).catch(() => {})

    try {
      const zipResult = await runCommandInSandbox(
        sandbox,
        `mkdir -p .tmp && cd '${quoted}' && zip -r '${tmpZip}' . && echo ok`,
        60000,
      )
      if (!zipResult.success || zipResult.output?.trim() !== 'ok') {
        return c.json({ error: 'Failed to create zip in sandbox' }, 500)
      }

      const zipBytes = await downloadFileFromSandbox(sandbox, tmpZip)
      if (!zipBytes) return c.json({ error: 'Failed to fetch zip from sandbox' }, 500)

      const zipBuf = Buffer.from(zipBytes)
      return new Response(zipBuf, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${basename}.zip"`,
          'Content-Length': String(zipBuf.byteLength),
        },
      })
    } finally {
      cleanup()
    }
  } catch (err) {
    console.error('[files/download] error:', err)
    return c.json({ error: 'Download failed' }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /:taskId/git/associate - Associate a Git repository with a task
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/git/associate', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!
  const { taskId } = c.req.param()
  const body = await c.req.json()
  const { repoUrl, branchName } = body

  const task = await findActiveTask(taskId, session.user.id)
  if (!task) return c.json({ success: false, error: 'Task not found' }, 404)

  // const parsed = parseGitUrl(repoUrl)
  // if (!parsed) return c.json({ success: false, error: 'Invalid repoUrl' }, 400)

  try {
    const gitService = new GitService({ repoUrl, branch: branchName })
    await gitService.createOrGetRepo()
  } catch (error) {
    console.error('Failed to create or get repo:', error)
    return c.json({ success: false, error: 'Failed to create or get repository' }, 500)
  }

  await getDb().tasks.update(taskId, {
    personalGitInfo: JSON.stringify({ repoUrl, branchName }),
    updatedAt: Date.now(),
  })

  return c.json({ success: true, message: 'Repository associated successfully' })
})

// ---------------------------------------------------------------------------
// POST /:taskId/git/disassociate - Disassociate a Git repository from a task
// ---------------------------------------------------------------------------
tasksRouter.post('/:taskId/git/disassociate', async (c) => {
  const authErr = requireAuth(c)
  if (authErr) return authErr
  const session = c.get('session')!
  const { taskId } = c.req.param()

  const task = await findActiveTask(taskId, session.user.id)
  if (!task) return c.json({ success: false, error: 'Task not found' }, 404)

  await getDb().tasks.update(taskId, {
    personalGitInfo: null,
    updatedAt: Date.now(),
  })

  return c.json({ success: true, message: 'Repository disassociated successfully' })
})

// ---------------------------------------------------------------------------
// Preview proxy — browser iframe cannot send X-Cloudbase-Authorization / E2b-* headers
// ---------------------------------------------------------------------------

const PREVIEW_PROXY_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

async function handleTaskPreviewProxy(c: Context<AppEnv>) {
  const session = c.get('session')!
  const { envId } = c.get('userEnv')!
  const { taskId, port } = c.req.param()
  const task = await findActiveTask(taskId, session.user.id)
  if (!task) return c.json({ error: 'Task not found' }, 404)
  if (!task.sandboxId) return c.json({ error: 'Sandbox is not running' }, 410)

  const taskMode = (task as { mode?: string | null }).mode
  const sandbox = await getTaskSandbox(task, envId, { isCodingMode: taskMode === 'coding' })
  if (!sandbox) return c.json({ error: 'Sandbox not available' }, 410)

  const prefix = `/api/tasks/${taskId}/preview/${port}`
  let subpath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '/'
  if (!subpath || subpath === '') subpath = '/'

  return proxyTaskPreview(c, sandbox, taskId, port, subpath)
}

for (const method of PREVIEW_PROXY_METHODS) {
  tasksRouter.on(method, '/:taskId/preview/:port', requireUserEnv, handleTaskPreviewProxy)
  tasksRouter.on(method, '/:taskId/preview/:port/*', requireUserEnv, handleTaskPreviewProxy)
}

export default tasksRouter
