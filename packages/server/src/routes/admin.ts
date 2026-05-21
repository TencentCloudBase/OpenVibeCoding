import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import { requireAdmin, type AppEnv } from '../middleware/admin'
import { issueTempCredentials } from '../middleware/auth.js'
import { provisionUserResources, destroyProvisionedResources } from '../cloudbase/provision.js'
import { getProvisionMode, isValidProvisionMode, resolveProvisionMode } from '../lib/provision-config.js'
import {
  isValidSandboxInstanceMode,
  resolveSandboxInstanceMode,
} from '../lib/sandbox-config.js'
import { persistenceService } from '../agent/persistence.service.js'
import { nanoid } from 'nanoid'
import bcrypt from 'bcryptjs'
import { encrypt } from '../lib/crypto.js'
import type { CloudBaseCredentials } from '../cloudbase/database.js'
import {
  listCollections,
  createCollection,
  deleteCollection,
  queryDocuments,
  insertDocument,
  updateDocument,
  deleteDocument,
} from '../cloudbase/database.js'
import { createManager } from '../cloudbase/database.js'
import {
  getBuckets,
  listStorageFiles,
  listHostingFiles,
  getDownloadUrl,
  deleteFile,
  deleteHostingFile,
} from '../cloudbase/storage.js'
import CloudBase from '@cloudbase/manager-node'

const admin = new Hono<AppEnv>()

// All admin routes require admin permission
admin.use('/*', requireAdmin)

// ─── Helper: Get proxy credentials for admin to access a specific env ────────

/** 管理员代理凭证缓存：envId -> { credentials, expireTime } */
const proxyCredentialCache = new Map<string, { credentials: CloudBaseCredentials; expireTime: number }>()

async function getProxyCreds(envId: string): Promise<CloudBaseCredentials> {
  const cached = proxyCredentialCache.get(envId)
  if (cached && cached.expireTime > Date.now() / 1000 + 300) {
    return cached.credentials
  }

  const tempCreds = await issueTempCredentials(envId, `admin-proxy-${envId.slice(0, 8)}`)
  if (!tempCreds) throw new Error('Failed to issue proxy credentials')

  const creds: CloudBaseCredentials = {
    envId,
    secretId: tempCreds.secretId,
    secretKey: tempCreds.secretKey,
    sessionToken: tempCreds.sessionToken,
  }

  proxyCredentialCache.set(envId, { credentials: creds, expireTime: Date.now() / 1000 + 6900 })
  return creds
}

// ─── User Management ─────────────────────────────────────────────────────

// Get user list (paginated)
admin.get('/users', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '20')

  const offset = (page - 1) * limit
  const db = getDb()

  const users = await db.users.findAll(limit, offset)
  const total = await db.users.count()

  // Batch fetch user resources
  const resourceMap = new Map<
    string,
    { envId: string | null; status: string; camSecretId: string | null; camSecretKey: string | null }
  >()
  await Promise.all(
    users.map(async (u) => {
      const resource = await db.userResources.findByUserId(u.id)
      if (resource) {
        resourceMap.set(u.id, {
          envId: resource.envId,
          status: resource.status,
          camSecretId: resource.camSecretId,
          camSecretKey: resource.camSecretKey,
        })
      }
    }),
  )

  return c.json({
    users: users.map((u) => {
      const res = resourceMap.get(u.id)
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        provider: u.provider,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        disabledReason: u.disabledReason,
        disabledAt: u.disabledAt,
        envId: res?.envId || null,
        envStatus: res?.status || null,
        credentialType: res?.camSecretId && res?.camSecretKey ? 'permanent' : res?.envId ? 'temp' : null,
        apiKey: u.apiKey || null,
      }
    }),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
})

// Get single user details
admin.get('/users/:userId', async (c) => {
  const userId = c.req.param('userId')
  const db = getDb()

  const user = await db.users.findById(userId)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Get user resource
  const resource = await db.userResources.findByUserId(userId)

  // Get user tasks stats
  const tasks = await db.tasks.findByUserId(userId)

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      provider: user.provider,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    },
    resource: resource
      ? {
          status: resource.status,
          envId: resource.envId,
          camUsername: resource.camUsername,
          failReason: resource.failReason,
          credentialType: resource.camSecretId && resource.camSecretKey ? 'permanent' : 'temp',
        }
      : null,
    taskStats: {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'error').length,
      pending: tasks.filter((t) => t.status === 'pending').length,
    },
  })
})

// Disable user
admin.post('/users/:userId/disable', async (c) => {
  const userId = c.req.param('userId')
  const adminUser = c.get('adminUser')
  const { reason } = await c.req.json()

  const db = getDb()

  // Cannot disable self
  if (userId === adminUser.id) {
    return c.json({ error: 'Cannot disable yourself' }, 400)
  }

  const user = await db.users.findById(userId)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Cannot disable other admins
  if (user.role === 'admin') {
    return c.json({ error: 'Cannot disable admin users' }, 403)
  }

  await db.users.disable(userId, reason || 'No reason provided', adminUser.id)

  // Log the action
  await db.adminLogs.create({
    id: nanoid(),
    adminUserId: adminUser.id,
    action: 'user_disable',
    targetUserId: userId,
    details: JSON.stringify({ reason }),
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
    userAgent: c.req.header('user-agent') || null,
  })

  return c.json({ success: true })
})

// Enable user
admin.post('/users/:userId/enable', async (c) => {
  const userId = c.req.param('userId')
  const adminUser = c.get('adminUser')

  const db = getDb()

  const user = await db.users.findById(userId)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  await db.users.enable(userId)

  // Log the action
  await db.adminLogs.create({
    id: nanoid(),
    adminUserId: adminUser.id,
    action: 'user_enable',
    targetUserId: userId,
    details: null,
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
    userAgent: c.req.header('user-agent') || null,
  })

  return c.json({ success: true })
})

// Reset user's API key (admin only)
admin.post('/users/:userId/api-key/reset', async (c) => {
  const userId = c.req.param('userId')
  const db = getDb()

  const user = await db.users.findById(userId)
  if (!user) return c.json({ error: 'User not found' }, 404)

  const plainKey = `sak_${nanoid(40)}`
  await db.users.update(userId, { apiKey: plainKey })
  return c.json({ apiKey: plainKey })
})

// Delete user
admin.delete('/users/:userId', async (c) => {
  const userId = c.req.param('userId')
  const adminUser = c.get('adminUser')

  if (userId === adminUser.id) {
    return c.json({ error: 'Cannot delete yourself' }, 400)
  }

  const db = getDb()

  const user = await db.users.findById(userId)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  if (user.role === 'admin') {
    return c.json({ error: 'Cannot delete admin user, remove admin role first' }, 400)
  }

  // Log before delete (targetUserId will be set to null by onDelete: 'set null')
  await db.adminLogs.create({
    id: nanoid(),
    adminUserId: adminUser.id,
    action: 'user_delete',
    targetUserId: userId,
    details: JSON.stringify({ username: user.username, email: user.email }),
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
    userAgent: c.req.header('user-agent') || null,
  })

  // Clean up cloud resources before deleting DB records.
  // 用户名下所有 user_resources（user-level + 每个 task-level）都要清：
  //   - CAM 子账号 + AccessKey
  //   - CAM 自定义策略
  //   - COS Tag
  //   - CloudBase 环境
  // 任一资源未清干净 → 保留 user_resources + users，返回错误让 admin 重试。
  const resources = await db.userResources.findAllByUserId(userId)
  const remaining: { resourceId: string; failed: unknown[] }[] = []
  for (const resource of resources) {
    let result: Awaited<ReturnType<typeof destroyProvisionedResources>> | null = null
    try {
      result = await destroyProvisionedResources({
        camUsername: resource.camUsername,
        policyId: resource.policyId,
        envId: resource.envId,
        cosTagValue: resource.cosTagValue,
      })
    } catch (e: any) {
      console.warn('[admin.deleteUser] destroy threw', { id: resource.id, message: e?.message })
      remaining.push({ resourceId: resource.id, failed: [{ message: e?.message }] })
      continue
    }
    if (result.failed.length > 0) {
      console.warn('[admin.deleteUser] partial failure', { id: resource.id, failed: result.failed })
      remaining.push({ resourceId: resource.id, failed: result.failed })
      continue
    }
    // 全清干净才删 DB row
    try {
      await db.userResources.deleteById(resource.id)
    } catch {
      // best-effort：DB 删不掉但云资源已清，留待孤立扫描脚本
    }
  }

  if (remaining.length > 0) {
    return c.json(
      {
        error: '部分云资源清理失败，用户保留可重试',
        remaining,
      },
      409,
    )
  }

  await db.users.deleteById(userId)

  return c.json({ success: true })
})

// Set/unset admin role
admin.post('/users/:userId/set-role', async (c) => {
  const userId = c.req.param('userId')
  const adminUser = c.get('adminUser')
  const { role } = await c.req.json()

  if (!['user', 'admin'].includes(role)) {
    return c.json({ error: 'Invalid role' }, 400)
  }

  const db = getDb()

  // Cannot change own role
  if (userId === adminUser.id) {
    return c.json({ error: 'Cannot change your own role' }, 400)
  }

  const user = await db.users.findById(userId)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const oldRole = user.role
  await db.users.updateRole(userId, role)

  // Log the action
  await db.adminLogs.create({
    id: nanoid(),
    adminUserId: adminUser.id,
    action: 'user_role_change',
    targetUserId: userId,
    details: JSON.stringify({ oldRole, newRole: role }),
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
    userAgent: c.req.header('user-agent') || null,
  })

  return c.json({ success: true })
})

// Reset user password (local users only)
admin.post('/users/:userId/reset-password', async (c) => {
  const userId = c.req.param('userId')
  const adminUser = c.get('adminUser')
  const { newPassword } = await c.req.json()

  if (!newPassword || newPassword.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400)
  }

  const db = getDb()

  const user = await db.users.findById(userId)
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  if (user.provider !== 'local') {
    return c.json({ error: 'Can only reset password for local users' }, 400)
  }

  const passwordHash = await bcrypt.hash(newPassword, 12)
  await db.localCredentials.update(userId, { passwordHash, updatedAt: Date.now() })

  // Log the action
  await db.adminLogs.create({
    id: nanoid(),
    adminUserId: adminUser.id,
    action: 'password_reset',
    targetUserId: userId,
    details: null,
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
    userAgent: c.req.header('user-agent') || null,
  })

  return c.json({ success: true })
})

// Create new user (admin only)
admin.post('/users/create', async (c) => {
  const adminUser = c.get('adminUser')
  const { username, password, email, role = 'user' } = await c.req.json()

  if (!username || !password) {
    return c.json({ error: 'Username and password are required' }, 400)
  }

  if (password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400)
  }

  if (!['user', 'admin'].includes(role)) {
    return c.json({ error: 'Invalid role' }, 400)
  }

  const db = getDb()

  // Check if user already exists
  const existingUser = await db.users.findByProviderAndExternalId('local', username)
  if (existingUser) {
    return c.json({ error: 'User already exists' }, 400)
  }

  const userId = nanoid()
  const now = Date.now()

  // Create user
  await db.users.create({
    id: userId,
    provider: 'local',
    externalId: username,
    accessToken: '',
    username,
    email: email || undefined,
    name: username,
    role,
    status: 'active',
    apiKey: encrypt(`sak_${nanoid(40)}`),
  })

  // Create credentials
  const passwordHash = await bcrypt.hash(password, 12)
  await db.localCredentials.create({
    userId,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  })

  // CloudBase 环境配置（与注册逻辑一致）
  // 仅 isolated 模式预建 user-level env；shared / task 不写 user_resources
  const provisionMode = await getProvisionMode()

  if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY && provisionMode === 'isolated') {
    const resourceId = nanoid()
    await db.userResources.create({
      id: resourceId,
      userId,
      status: 'processing',
      envId: null,
      envAlias: null,
      envRegion: null,
      cosTagValue: null,
      policyHash: null,
      camUsername: null,
      camSecretId: null,
      camSecretKey: null,
      policyId: null,
      failStep: null,
      failReason: null,
      createdAt: now,
      updatedAt: now,
    })

    provisionUserResources(userId, username)
      .then(async (result) => {
        await getDb().userResources.update(resourceId, {
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
          updatedAt: Date.now(),
        })
        console.log(`[admin-provision] User ${username} env ready: ${result.envId}`)
      })
      .catch(async (err) => {
        await getDb().userResources.update(resourceId, {
          status: 'failed',
          failStep: err.__provisionFailStep || null,
          failReason: err.message,
          updatedAt: Date.now(),
        })
        console.error(`[admin-provision] User ${username} failed:`, err.message)
      })
  }

  // Log the action
  await db.adminLogs.create({
    id: nanoid(),
    adminUserId: adminUser.id,
    action: 'user_create',
    targetUserId: userId,
    details: JSON.stringify({ username, email, role }),
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
    userAgent: c.req.header('user-agent') || null,
  })

  return c.json({
    success: true,
    user: {
      id: userId,
      username,
      email: email || null,
      role,
      status: 'active',
      provider: 'local',
      createdAt: now,
    },
  })
})

// ─── Environment View ─────────────────────────────────────────────────────

// Get all user environments
admin.get('/environments', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '20')

  const db = getDb()
  // Note: This would require implementing userResources.findAll()
  // For now, we'll return an empty array
  // TODO: Implement findAll in UserResourceRepository

  return c.json({
    resources: [],
    pagination: {
      page,
      limit,
      total: 0,
      totalPages: 0,
    },
  })
})

// ─── Task View ─────────────────────────────────────────────────────────────

// Get all tasks
admin.get('/tasks', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '20')
  const userId = c.req.query('userId')
  const status = c.req.query('status')

  const db = getDb()
  const filters: { userId?: string; status?: string } = {}
  if (userId) filters.userId = userId
  if (status) filters.status = status

  const offset = (page - 1) * limit
  const tasks = await db.tasks.findAll(limit, offset, filters)
  const total = await db.tasks.count(filters)

  // Batch fetch usernames
  const userIds = [...new Set(tasks.map((t) => t.userId))]
  const userMap = new Map<string, string>()
  await Promise.all(
    userIds.map(async (id) => {
      const user = await db.users.findById(id)
      if (user) userMap.set(id, user.username)
    }),
  )

  return c.json({
    tasks: tasks.map((t) => ({
      id: t.id,
      userId: t.userId,
      username: userMap.get(t.userId) || t.userId,
      title: t.title,
      prompt: t.prompt,
      status: t.status,
      selectedAgent: t.selectedAgent,
      repoUrl: t.repoUrl,
      branchName: t.branchName,
      sandboxUrl: t.sandboxUrl,
      previewUrl: t.previewUrl,
      error: t.error,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
})

// Get single task details (admin, read-only)
admin.get('/tasks/:taskId', async (c) => {
  const taskId = c.req.param('taskId')
  const db = getDb()

  const task = await db.tasks.findById(taskId)
  if (!task || task.deletedAt) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const user = await db.users.findById(task.userId)

  return c.json({
    task: {
      id: task.id,
      userId: task.userId,
      username: user?.username || task.userId,
      title: task.title,
      prompt: task.prompt,
      status: task.status,
      progress: task.progress,
      selectedAgent: task.selectedAgent,
      selectedModel: task.selectedModel,
      installDependencies: task.installDependencies,
      maxDuration: task.maxDuration,
      keepAlive: task.keepAlive,
      enableBrowser: task.enableBrowser,
      repoUrl: task.repoUrl,
      branchName: task.branchName,
      sandboxId: task.sandboxId,
      agentSessionId: task.agentSessionId,
      sandboxUrl: task.sandboxUrl,
      previewUrl: task.previewUrl,
      prUrl: task.prUrl,
      prNumber: task.prNumber,
      prStatus: task.prStatus,
      prMergeCommitSha: task.prMergeCommitSha,
      mcpServerIds: task.mcpServerIds,
      error: task.error,
      logs: task.logs,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      deletedAt: task.deletedAt,
    },
  })
})

// Get task messages (admin, read-only) — mirrors /tasks/:taskId/messages but uses system credentials
admin.get('/tasks/:taskId/messages', async (c) => {
  const taskId = c.req.param('taskId')
  const db = getDb()

  const task = await db.tasks.findById(taskId)
  if (!task || task.deletedAt) {
    return c.json({ error: 'Task not found' }, 404)
  }

  // Look up user's envId from userResources
  const userResources = await db.userResources.findByUserId(task.userId)
  if (!userResources?.envId) {
    return c.json({ messages: [] })
  }

  try {
    const cloudbaseRecords = await persistenceService.loadDBMessages(taskId, userResources.envId, task.userId, 200)
    const messages = cloudbaseRecords.map((record) => {
      const parts = (record.parts || []).map((p) => {
        if (p.contentType === 'text') return { type: 'text' as const, text: p.content || '' }
        else if (p.contentType === 'reasoning') return { type: 'thinking' as const, text: p.content || '' }
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
        return { type: 'text' as const, text: p.content || '' }
      })
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

// ─── Operation Logs ─────────────────────────────────────────────────────

admin.get('/logs', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '50')

  const db = getDb()
  const logs = await db.adminLogs.findAll(limit, (page - 1) * limit)

  return c.json({ logs })
})

// ─── Admin Proxy Routes (Dashboard access with specified envId) ──────────
// These routes allow admins to access CloudBase APIs on behalf of a specific
// environment using system credentials. The Dashboard component can use these
// by setting apiBase to `/api/admin/proxy/:envId`.

// Database proxy
admin.get('/proxy/:envId/database/collections', async (c) => {
  try {
    const creds = await getProxyCreds(c.req.param('envId'))
    const result = await listCollections(creds)
    return c.json(result.collections)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.post('/proxy/:envId/database/collections', async (c) => {
  try {
    const { name } = await c.req.json()
    await createCollection(await getProxyCreds(c.req.param('envId')), name)
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.delete('/proxy/:envId/database/collections/:name', async (c) => {
  try {
    await deleteCollection(await getProxyCreds(c.req.param('envId')), c.req.param('name'))
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.get('/proxy/:envId/database/collections/:name/documents', async (c) => {
  try {
    const name = c.req.param('name')
    const page = Number(c.req.query('page') || '1')
    const pageSize = Number(c.req.query('pageSize') || '50')
    const search = c.req.query('search')?.trim()

    let where: Record<string, unknown> | undefined
    if (search) {
      if (search.includes(':')) {
        const [field, ...rest] = search.split(':')
        const val = rest.join(':')
        where = { [field.trim()]: val.trim() }
      } else {
        where = { _id: search }
      }
    }

    const result = await queryDocuments(await getProxyCreds(c.req.param('envId')), name, page, pageSize, where)
    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.post('/proxy/:envId/database/collections/:name/documents', async (c) => {
  try {
    const data = await c.req.json()
    const id = await insertDocument(await getProxyCreds(c.req.param('envId')), c.req.param('name'), data)
    return c.json({ _id: id })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.put('/proxy/:envId/database/collections/:name/documents/:id', async (c) => {
  try {
    const data = await c.req.json()
    await updateDocument(await getProxyCreds(c.req.param('envId')), c.req.param('name'), c.req.param('id'), data)
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.delete('/proxy/:envId/database/collections/:name/documents/:id', async (c) => {
  try {
    await deleteDocument(await getProxyCreds(c.req.param('envId')), c.req.param('name'), c.req.param('id'))
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// Storage proxy
admin.get('/proxy/:envId/storage/buckets', async (c) => {
  try {
    return c.json(await getBuckets(await getProxyCreds(c.req.param('envId'))))
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.get('/proxy/:envId/storage/files', async (c) => {
  try {
    const prefix = c.req.query('prefix') || ''
    const bucketType = c.req.query('bucketType') || 'storage'
    const cdnDomain = c.req.query('cdnDomain') || ''
    const creds = await getProxyCreds(c.req.param('envId'))

    const files =
      bucketType === 'static' ? await listHostingFiles(creds, prefix, cdnDomain) : await listStorageFiles(creds, prefix)

    return c.json(files)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.get('/proxy/:envId/storage/url', async (c) => {
  try {
    const path = c.req.query('path') || ''
    if (!path) return c.json({ error: '缺少 path 参数' }, 400)
    return c.json({ url: await getDownloadUrl(await getProxyCreds(c.req.param('envId')), path) })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.delete('/proxy/:envId/storage/files', async (c) => {
  try {
    const { path, bucketType } = await c.req.json()
    if (!path) return c.json({ error: '缺少 path 参数' }, 400)
    const creds = await getProxyCreds(c.req.param('envId'))
    if (bucketType === 'static') {
      await deleteHostingFile(creds, path)
    } else {
      await deleteFile(creds, path)
    }
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// CAPI proxy
admin.post('/proxy/:envId/capi', async (c) => {
  const envId = c.req.param('envId')

  let body: { service?: string; action?: string; params?: Record<string, unknown> }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '无效的请求体' }, 400)
  }

  const { service, action, params = {} } = body

  if (!service || !action) {
    return c.json({ error: '缺少 service / action 参数' }, 400)
  }

  try {
    const creds = await getProxyCreds(envId)
    const app = new CloudBase({
      secretId: creds.secretId,
      secretKey: creds.secretKey,
      token: creds.sessionToken || '',
      envId,
    })

    const result = await app.commonService(service).call({
      Action: action,
      Param: params,
    })

    return c.json({ result })
  } catch (e: any) {
    return c.json({ error: e.message, code: e.code }, 500)
  }
})

// Functions proxy
admin.get('/proxy/:envId/functions', async (c) => {
  try {
    const manager = createManager(await getProxyCreds(c.req.param('envId')))
    const result = await manager.functions.getFunctionList(100, 0)
    const functions = (result.Functions || []).map((f: any) => ({
      name: f.FunctionName,
      runtime: f.Runtime,
      status: f.Status,
      codeSize: f.CodeSize,
      description: f.Description,
      addTime: f.AddTime,
      modTime: f.ModTime,
      memSize: f.MemorySize,
      timeout: f.Timeout,
      type: f.Type,
    }))
    return c.json(functions)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.post('/proxy/:envId/functions/:name/invoke', async (c) => {
  try {
    const manager = createManager(await getProxyCreds(c.req.param('envId')))
    const name = c.req.param('name')
    const body = await c.req.json()
    const result = await manager.functions.invokeFunction(name, body)
    return c.json({ result: result.RetMsg })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── System Settings ──────────────────────────────────────────────────────

admin.get('/system-settings', async (c) => {
  try {
    const db = getDb()
    const allSettings = await db.settings.findAllSystemSettings()

    const settingsMap: Record<string, string> = {}
    for (const s of allSettings) {
      settingsMap[s.key] = s.value
    }

    // 对 provision_mode：返回值的来源信息（前端用于展示标签 + 重置按钮）
    const pm = await resolveProvisionMode()
    settingsMap['provision_mode'] = pm.value

    const sim = await resolveSandboxInstanceMode()
    settingsMap['sandbox_instance_mode'] = sim.value

    return c.json({
      settings: settingsMap,
      meta: {
        provision_mode: {
          source: pm.source, // 'db' | 'env' | 'default'
          envDefault: pm.envDefault, // 用户重置后会回落到的值
        },
        sandbox_instance_mode: {
          source: sim.source,
          envDefault: sim.envDefault,
        },
      },
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

admin.put('/system-settings/:key', async (c) => {
  try {
    const { key } = c.req.param()
    const body = await c.req.json()
    const { value } = body

    if (!value || typeof value !== 'string') {
      return c.json({ error: 'value is required' }, 400)
    }

    // Validate known settings
    if (key === 'provision_mode') {
      if (!isValidProvisionMode(value)) {
        return c.json({ error: 'Invalid provision mode. Must be: shared, isolated, or task' }, 400)
      }
    }
    if (key === 'sandbox_instance_mode') {
      if (!isValidSandboxInstanceMode(value)) {
        return c.json({ error: 'Invalid sandbox instance mode. Must be: shared or isolated' }, 400)
      }
    }

    const db = getDb()
    const setting = await db.settings.upsertSystemSetting(key, value)

    // Log the action
    const adminUser = c.get('session')!.user
    await db.adminLogs.create({
      id: nanoid(),
      adminUserId: adminUser.id,
      action: 'system_setting_update',
      targetUserId: null,
      details: JSON.stringify({ key, value }),
      ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
      userAgent: c.req.header('user-agent') || null,
    })

    return c.json({ success: true, setting: { key: setting.key, value: setting.value } })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

/**
 * DELETE /system-settings/:key — 重置为环境变量默认值。
 * 删除 DB 中的 system setting，让 getProvisionMode() 回落到 env / 内置默认。
 */
admin.delete('/system-settings/:key', async (c) => {
  try {
    const { key } = c.req.param()
    const db = getDb()
    const existed = await db.settings.deleteSystemSetting(key)

    if (existed) {
      const adminUser = c.get('session')!.user
      await db.adminLogs.create({
        id: nanoid(),
        adminUserId: adminUser.id,
        action: 'system_setting_reset',
        targetUserId: null,
        details: JSON.stringify({ key }),
        ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || null,
        userAgent: c.req.header('user-agent') || null,
      })
    }

    return c.json({ success: true, existed })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

export default admin
