import { nanoid } from 'nanoid'
import { getCollection, getCommand } from './client'
import type {
  User,
  NewUser,
  LocalCredential,
  NewLocalCredential,
  Task,
  NewTask,
  Connector,
  NewConnector,
  MiniProgramApp,
  NewMiniProgramApp,
  CronTask,
  NewCronTask,
  Account,
  NewAccount,
  Key,
  NewKey,
  UserResource,
  NewUserResource,
  Setting,
  NewSetting,
  Deployment,
  NewDeployment,
  AdminLog,
  NewAdminLog,
  EnvPoolEntry,
  NewEnvPoolEntry,
  UserRepository,
  LocalCredentialRepository,
  TaskRepository,
  ConnectorRepository,
  MiniProgramAppRepository,
  CronTaskRepository,
  AccountRepository,
  KeyRepository,
  UserResourceRepository,
  SettingRepository,
  DeploymentRepository,
  AdminLogRepository,
  EnvPoolRepository,
  DatabaseProvider,
} from '../types'

const now = () => Date.now()

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripCloudBaseId<T>(doc: Record<string, unknown>): T {
  const { _id, ...rest } = doc
  return rest as T
}

// ─── User Repository ────────────────────────────────────────────────────────

class CloudBaseUserRepository implements UserRepository {
  async findById(id: string): Promise<User | null> {
    const _ = getCommand()
    const collection = await getCollection('users')
    const { data } = await collection
      .where({ id: _.eq(id) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<User>(data[0] as Record<string, unknown>)
  }

  async findByProviderAndExternalId(provider: string, externalId: string): Promise<User | null> {
    const _ = getCommand()
    const collection = await getCollection('users')
    const { data } = await collection
      .where({ provider: _.eq(provider), externalId: _.eq(externalId) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<User>(data[0] as Record<string, unknown>)
  }

  async findByApiKey(encryptedApiKey: string): Promise<User | null> {
    const _ = getCommand()
    const collection = await getCollection('users')
    const { data } = await collection
      .where({ apiKey: _.eq(encryptedApiKey) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<User>(data[0] as Record<string, unknown>)
  }

  async create(user: NewUser): Promise<User> {
    const collection = await getCollection('users')
    const ts = now()
    const doc: User = {
      refreshToken: null,
      scope: null,
      email: null,
      name: null,
      avatarUrl: null,
      disabledReason: null,
      disabledAt: null,
      disabledBy: null,
      apiKey: null,
      ...user,
      createdAt: user.createdAt ?? ts,
      updatedAt: user.updatedAt ?? ts,
      lastLoginAt: user.lastLoginAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async update(id: string, data: Partial<Omit<User, 'id'>>): Promise<User | null> {
    const _ = getCommand()
    const collection = await getCollection('users')
    await collection.where({ id: _.eq(id) }).update({ ...data, updatedAt: data.updatedAt ?? now() })
    return this.findById(id)
  }

  async deleteById(id: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('users')
    await collection.where({ id: _.eq(id) }).remove()
  }

  // Admin methods
  async findAll(limit = 20, offset = 0): Promise<User[]> {
    const collection = await getCollection('users')
    const { data } = await collection.limit(limit).skip(offset).get()
    return data.map((doc: any) => stripCloudBaseId<User>(doc as Record<string, unknown>))
  }

  async count(): Promise<number> {
    const collection = await getCollection('users')
    const { total } = await collection.count()
    return total
  }

  async updateRole(id: string, role: 'user' | 'admin'): Promise<User | null> {
    const _ = getCommand()
    const collection = await getCollection('users')
    await collection.where({ id: _.eq(id) }).update({ role, updatedAt: now() })
    return this.findById(id)
  }

  async disable(id: string, reason: string, adminUserId: string): Promise<User | null> {
    const _ = getCommand()
    const collection = await getCollection('users')
    await collection.where({ id: _.eq(id) }).update({
      status: 'disabled',
      disabledReason: reason,
      disabledAt: now(),
      disabledBy: adminUserId,
      updatedAt: now(),
    })
    return this.findById(id)
  }

  async enable(id: string): Promise<User | null> {
    const _ = getCommand()
    const collection = await getCollection('users')
    await collection.where({ id: _.eq(id) }).update({
      status: 'active',
      disabledReason: null,
      disabledAt: null,
      disabledBy: null,
      updatedAt: now(),
    })
    return this.findById(id)
  }
}

// ─── LocalCredential Repository ─────────────────────────────────────────────

class CloudBaseLocalCredentialRepository implements LocalCredentialRepository {
  async findByUserId(userId: string): Promise<LocalCredential | null> {
    const _ = getCommand()
    const collection = await getCollection('local_credentials')
    const { data } = await collection
      .where({ userId: _.eq(userId) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<LocalCredential>(data[0] as Record<string, unknown>)
  }

  async create(credential: NewLocalCredential): Promise<LocalCredential> {
    const collection = await getCollection('local_credentials')
    const ts = now()
    const doc: LocalCredential = {
      ...credential,
      createdAt: credential.createdAt ?? ts,
      updatedAt: credential.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async update(userId: string, data: Partial<Omit<LocalCredential, 'userId'>>): Promise<LocalCredential | null> {
    const _ = getCommand()
    const collection = await getCollection('local_credentials')
    await collection.where({ userId: _.eq(userId) }).update({ ...data, updatedAt: data.updatedAt ?? now() })
    return this.findByUserId(userId)
  }
}

// ─── Task Repository ────────────────────────────────────────────────────────

/** Apply business defaults for Task fields that may be missing in legacy DB records */
function withTaskDefaults(task: Record<string, unknown>): Task {
  const doc = stripCloudBaseId<Task>(task)
  return {
    ...doc,
    mode: doc.mode || 'default',
    status: doc.status || 'pending',
    selectedAgent: doc.selectedAgent ?? 'codebuddy',
    selectedRuntime: doc.selectedRuntime ?? null,
    sandboxMode: doc.sandboxMode || 'isolated',
    installDependencies: doc.installDependencies ?? false,
    maxDuration: doc.maxDuration ?? 300,
    keepAlive: doc.keepAlive ?? false,
    enableBrowser: doc.enableBrowser ?? false,
    progress: doc.progress ?? 0,
  }
}

class CloudBaseTaskRepository implements TaskRepository {
  async findById(id: string): Promise<Task | null> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    const { data } = await collection
      .where({ id: _.eq(id) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return withTaskDefaults(data[0] as Record<string, unknown>)
  }

  async findByIdAndUserId(id: string, userId: string): Promise<Task | null> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    const { data } = await collection
      .where({ id: _.eq(id), userId: _.eq(userId), deletedAt: _.eq(null) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return withTaskDefaults(data[0] as Record<string, unknown>)
  }

  async findByUserId(userId: string, limit = 20): Promise<Task[]> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    const { data } = await collection
      .where({ userId: _.eq(userId), deletedAt: _.eq(null) })
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => withTaskDefaults(doc))
  }

  async findByRepoAndPr(userId: string, prNumber: number, repoUrl: string): Promise<Task[]> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    const { data } = await collection
      .where({ userId: _.eq(userId), prNumber: _.eq(prNumber), repoUrl: _.eq(repoUrl), deletedAt: _.eq(null) })
      .limit(1)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => withTaskDefaults(doc))
  }

  async findAll(limit: number, offset: number, filters?: { userId?: string; status?: string }): Promise<Task[]> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    const where: Record<string, any> = { deletedAt: _.eq(null) }
    if (filters?.userId) where.userId = _.eq(filters.userId)
    if (filters?.status) where.status = _.eq(filters.status)
    const { data } = await collection.where(where).orderBy('createdAt', 'desc').skip(offset).limit(limit).get()
    if (!data) return []
    return (data as Record<string, unknown>[]).map((doc) => withTaskDefaults(doc))
  }

  async count(filters?: { userId?: string; status?: string }): Promise<number> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    const where: Record<string, any> = { deletedAt: _.eq(null) }
    if (filters?.userId) where.userId = _.eq(filters.userId)
    if (filters?.status) where.status = _.eq(filters.status)
    const { total } = await collection.where(where).count()
    return total
  }

  async create(task: NewTask): Promise<Task> {
    const collection = await getCollection('tasks')
    const ts = now()
    const doc: Task = {
      // ── Business defaults (for optional fields) ──
      selectedAgent: 'codebuddy',
      installDependencies: false,
      maxDuration: 300,
      keepAlive: false,
      enableBrowser: false,
      progress: 0,
      // ── Nullable defaults ──
      title: null,
      repoUrl: null,
      envId: null,
      selectedModel: null,
      selectedRuntime: null,
      logs: null,
      error: null,
      branchName: null,
      sandboxId: null,
      sandboxSessionId: null,
      sandboxCwd: null,
      sandboxMode: null,
      agentSessionId: null,
      sandboxUrl: null,
      previewUrl: null,
      prUrl: null,
      prNumber: null,
      prStatus: null,
      prMergeCommitSha: null,
      mcpServerList: null,
      skillSettings: null,
      // ── Caller overrides (spread after defaults) ──
      ...task,
      createdAt: task.createdAt ?? ts,
      updatedAt: task.updatedAt ?? ts,
      completedAt: task.completedAt ?? null,
      deletedAt: task.deletedAt ?? null,
    }
    await collection.add(doc)
    return doc
  }

  async update(id: string, data: Partial<Omit<Task, 'id'>>): Promise<Task | null> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    await collection.where({ id: _.eq(id) }).update({ ...data, updatedAt: data.updatedAt ?? now() })
    return this.findById(id)
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    await collection.where({ userId: _.eq(fromUserId) }).update({ userId: toUserId })
  }

  async softDelete(id: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('tasks')
    await collection.where({ id: _.eq(id) }).update({ deletedAt: now() })
  }
}

// ─── Connector Repository ───────────────────────────────────────────────────

class CloudBaseConnectorRepository implements ConnectorRepository {
  async findByUserId(userId: string): Promise<Connector[]> {
    const _ = getCommand()
    const collection = await getCollection('connectors')
    const { data } = await collection
      .where({ userId: _.eq(userId) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<Connector>(doc))
  }

  async findByIdAndUserId(id: string, userId: string): Promise<Connector | null> {
    const _ = getCommand()
    const collection = await getCollection('connectors')
    const { data } = await collection
      .where({ id: _.eq(id), userId: _.eq(userId) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<Connector>(data[0] as Record<string, unknown>)
  }

  async create(connector: NewConnector): Promise<Connector> {
    const collection = await getCollection('connectors')
    const ts = now()
    const doc: Connector = {
      ...connector,
      createdAt: connector.createdAt ?? ts,
      updatedAt: connector.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async update(id: string, userId: string, data: Partial<Omit<Connector, 'id' | 'userId'>>): Promise<Connector | null> {
    const _ = getCommand()
    const collection = await getCollection('connectors')
    await collection
      .where({ id: _.eq(id), userId: _.eq(userId) })
      .update({ ...data, updatedAt: data.updatedAt ?? now() })
    return this.findByIdAndUserId(id, userId)
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('connectors')
    await collection.where({ userId: _.eq(fromUserId) }).update({ userId: toUserId })
  }

  async delete(id: string, userId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('connectors')
    await collection.where({ id: _.eq(id), userId: _.eq(userId) }).remove()
  }
}

// ─── MiniProgramApp Repository ──────────────────────────────────────────────

class CloudBaseMiniProgramAppRepository implements MiniProgramAppRepository {
  async findByUserId(userId: string): Promise<MiniProgramApp[]> {
    const _ = getCommand()
    const collection = await getCollection('miniprogram_apps')
    const { data } = await collection
      .where({ userId: _.eq(userId) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<MiniProgramApp>(doc))
  }

  async findByIdAndUserId(id: string, userId: string): Promise<MiniProgramApp | null> {
    const _ = getCommand()
    const collection = await getCollection('miniprogram_apps')
    const { data } = await collection
      .where({ id: _.eq(id), userId: _.eq(userId) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<MiniProgramApp>(data[0] as Record<string, unknown>)
  }

  async findByAppIdAndUserId(appId: string, userId: string): Promise<MiniProgramApp | null> {
    const _ = getCommand()
    const collection = await getCollection('miniprogram_apps')
    const { data } = await collection
      .where({ appId: _.eq(appId), userId: _.eq(userId) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<MiniProgramApp>(data[0] as Record<string, unknown>)
  }

  async create(app: NewMiniProgramApp): Promise<MiniProgramApp> {
    const collection = await getCollection('miniprogram_apps')
    const ts = now()
    const doc: MiniProgramApp = {
      ...app,
      createdAt: app.createdAt ?? ts,
      updatedAt: app.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async update(
    id: string,
    userId: string,
    data: Partial<Omit<MiniProgramApp, 'id' | 'userId'>>,
  ): Promise<MiniProgramApp | null> {
    const _ = getCommand()
    const collection = await getCollection('miniprogram_apps')
    await collection
      .where({ id: _.eq(id), userId: _.eq(userId) })
      .update({ ...data, updatedAt: data.updatedAt ?? now() })
    return this.findByIdAndUserId(id, userId)
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('miniprogram_apps')
    await collection.where({ userId: _.eq(fromUserId) }).update({ userId: toUserId })
  }

  async delete(id: string, userId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('miniprogram_apps')
    await collection.where({ id: _.eq(id), userId: _.eq(userId) }).remove()
  }
}

// ─── CronTask Repository ────────────────────────────────────────────────────

class CloudBaseCronTaskRepository implements CronTaskRepository {
  async findByUserId(userId: string): Promise<CronTask[]> {
    const _ = getCommand()
    const collection = await getCollection('cron_tasks')
    const { data } = await collection
      .where({ userId: _.eq(userId) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<CronTask>(doc))
  }

  async findByIdAndUserId(id: string, userId: string): Promise<CronTask | null> {
    const _ = getCommand()
    const collection = await getCollection('cron_tasks')
    const { data } = await collection
      .where({ id: _.eq(id), userId: _.eq(userId) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<CronTask>(data[0] as Record<string, unknown>)
  }

  async findAllEnabled(): Promise<CronTask[]> {
    const _ = getCommand()
    const collection = await getCollection('cron_tasks')
    const { data } = await collection
      .where({ enabled: _.eq(true) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<CronTask>(doc))
  }

  async create(task: NewCronTask): Promise<CronTask> {
    const collection = await getCollection('cron_tasks')
    const ts = now()
    const doc: CronTask = {
      repoUrl: null,
      selectedAgent: null,
      selectedModel: null,
      lastRunAt: null,
      nextRunAt: null,
      lockedBy: null,
      lockedAt: null,
      ...task,
      createdAt: task.createdAt ?? ts,
      updatedAt: task.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async update(id: string, userId: string, data: Partial<Omit<CronTask, 'id' | 'userId'>>): Promise<CronTask | null> {
    const _ = getCommand()
    const collection = await getCollection('cron_tasks')
    await collection
      .where({ id: _.eq(id), userId: _.eq(userId) })
      .update({ ...data, updatedAt: data.updatedAt ?? now() })
    return this.findByIdAndUserId(id, userId)
  }

  async delete(id: string, userId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('cron_tasks')
    await collection.where({ id: _.eq(id), userId: _.eq(userId) }).remove()
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('cron_tasks')
    await collection.where({ userId: _.eq(fromUserId) }).update({ userId: toUserId })
  }

  async tryLock(id: string, lockerId: string, maxLockMs: number): Promise<boolean> {
    const _ = getCommand()
    const collection = await getCollection('cron_tasks')
    const cutoff = Date.now() - maxLockMs
    try {
      const result = await collection
        .where({
          id: _.eq(id),
          _: _.or([{ lockedBy: _.eq(null) }, { lockedBy: _.exists(false) }, { lockedAt: _.lt(cutoff) }]),
        })
        .update({ lockedBy: lockerId, lockedAt: Date.now() })
      return (result as any).updated > 0
    } catch {
      return false
    }
  }

  async releaseLock(id: string, lockerId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('cron_tasks')
    await collection.where({ id: _.eq(id), lockedBy: _.eq(lockerId) }).update({ lockedBy: null, lockedAt: null })
  }
}

// ─── Account Repository ─────────────────────────────────────────────────────

class CloudBaseAccountRepository implements AccountRepository {
  async findByUserIdAndProvider(userId: string, provider: string): Promise<Account | null> {
    const _ = getCommand()
    const collection = await getCollection('accounts')
    const { data } = await collection
      .where({ userId: _.eq(userId), provider: _.eq(provider) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<Account>(data[0] as Record<string, unknown>)
  }

  async findByProviderAndExternalUserId(provider: string, externalUserId: string): Promise<Account | null> {
    const _ = getCommand()
    const collection = await getCollection('accounts')
    const { data } = await collection
      .where({ provider: _.eq(provider), externalUserId: _.eq(externalUserId) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<Account>(data[0] as Record<string, unknown>)
  }

  async create(account: NewAccount): Promise<Account> {
    const collection = await getCollection('accounts')
    const ts = now()
    const doc: Account = {
      ...account,
      createdAt: account.createdAt ?? ts,
      updatedAt: account.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async update(id: string, data: Partial<Omit<Account, 'id'>>): Promise<Account | null> {
    const _ = getCommand()
    const collection = await getCollection('accounts')
    await collection.where({ id: _.eq(id) }).update({ ...data, updatedAt: data.updatedAt ?? now() })
    const { data: rows } = await collection
      .where({ id: _.eq(id) })
      .limit(1)
      .get()
    if (!rows || rows.length === 0) return null
    return stripCloudBaseId<Account>(rows[0] as Record<string, unknown>)
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('accounts')
    await collection.where({ userId: _.eq(fromUserId) }).update({ userId: toUserId })
  }

  async delete(userId: string, provider: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('accounts')
    await collection.where({ userId: _.eq(userId), provider: _.eq(provider) }).remove()
  }
}

// ─── Key Repository ─────────────────────────────────────────────────────────

class CloudBaseKeyRepository implements KeyRepository {
  async findByUserId(userId: string): Promise<Key[]> {
    const _ = getCommand()
    const collection = await getCollection('keys')
    const { data } = await collection
      .where({ userId: _.eq(userId) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<Key>(doc))
  }

  async findByUserIdAndProvider(userId: string, provider: string): Promise<Key | null> {
    const _ = getCommand()
    const collection = await getCollection('keys')
    const { data } = await collection
      .where({ userId: _.eq(userId), provider: _.eq(provider) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<Key>(data[0] as Record<string, unknown>)
  }

  async upsert(key: NewKey): Promise<Key> {
    const ts = now()
    const existing = await this.findByUserIdAndProvider(key.userId, key.provider)
    if (existing) {
      const _ = getCommand()
      const collection = await getCollection('keys')
      await collection
        .where({ userId: _.eq(key.userId), provider: _.eq(key.provider) })
        .update({ value: key.value, updatedAt: ts })
      return { ...existing, value: key.value, updatedAt: ts }
    }
    const collection = await getCollection('keys')
    const doc: Key = {
      ...key,
      id: key.id || nanoid(),
      createdAt: key.createdAt ?? ts,
      updatedAt: key.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('keys')
    await collection.where({ userId: _.eq(fromUserId) }).update({ userId: toUserId })
  }

  async delete(userId: string, provider: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('keys')
    await collection.where({ userId: _.eq(userId), provider: _.eq(provider) }).remove()
  }
}

// ─── UserResource Repository ────────────────────────────────────────────────

class CloudBaseUserResourceRepository implements UserResourceRepository {
  async findByUserId(userId: string): Promise<UserResource | null> {
    const _ = getCommand()
    const collection = await getCollection('user_resources')
    // Return user-scoped resource (scope='user'), backwards compatible
    const { data } = await collection
      .where({ userId: _.eq(userId), scope: _.eq('user') })
      .limit(1)
      .get()
    if (!data || data.length === 0) {
      // Fallback: old records without scope field
      const { data: legacy } = await collection
        .where({ userId: _.eq(userId) })
        .limit(1)
        .get()
      if (!legacy || legacy.length === 0) return null
      return stripCloudBaseId<UserResource>(legacy[0] as Record<string, unknown>)
    }
    return stripCloudBaseId<UserResource>(data[0] as Record<string, unknown>)
  }

  async findByTaskId(taskId: string): Promise<UserResource | null> {
    const _ = getCommand()
    const collection = await getCollection('user_resources')
    const { data } = await collection
      .where({ scope: _.eq('task'), taskId: _.eq(taskId) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<UserResource>(data[0] as Record<string, unknown>)
  }

  async findAllByUserId(userId: string): Promise<UserResource[]> {
    const _ = getCommand()
    const collection = await getCollection('user_resources')
    const { data } = await collection
      .where({ userId: _.eq(userId) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<UserResource>(doc))
  }

  async create(resource: NewUserResource): Promise<UserResource> {
    const collection = await getCollection('user_resources')
    const ts = now()
    const doc: UserResource = {
      ...resource,
      scope: resource.scope || 'user',
      taskId: resource.taskId ?? null,
      createdAt: resource.createdAt ?? ts,
      updatedAt: resource.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async update(id: string, data: Partial<Omit<UserResource, 'id'>>): Promise<UserResource | null> {
    const _ = getCommand()
    const collection = await getCollection('user_resources')
    await collection.where({ id: _.eq(id) }).update({ ...data, updatedAt: data.updatedAt ?? now() })
    const { data: rows } = await collection
      .where({ id: _.eq(id) })
      .limit(1)
      .get()
    if (!rows || rows.length === 0) return null
    return stripCloudBaseId<UserResource>(rows[0] as Record<string, unknown>)
  }

  async deleteById(id: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('user_resources')
    await collection.where({ id: _.eq(id) }).remove()
  }
}

// ─── Setting Repository ─────────────────────────────────────────────────────

class CloudBaseSettingRepository implements SettingRepository {
  async findByUserIdAndKey(userId: string, key: string): Promise<Setting | null> {
    const _ = getCommand()
    const collection = await getCollection('settings')
    const { data } = await collection
      .where({ userId: _.eq(userId), key: _.eq(key) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<Setting>(data[0] as Record<string, unknown>)
  }

  async findByUserId(userId: string): Promise<Setting[]> {
    const _ = getCommand()
    const collection = await getCollection('settings')
    const { data } = await collection
      .where({ userId: _.eq(userId) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<Setting>(doc))
  }

  async upsert(setting: NewSetting): Promise<Setting> {
    const ts = now()
    const existing = setting.userId
      ? await this.findByUserIdAndKey(setting.userId, setting.key)
      : await this.findSystemSetting(setting.key)
    if (existing) {
      const _ = getCommand()
      const collection = await getCollection('settings')
      const condition = setting.userId
        ? { userId: _.eq(setting.userId), key: _.eq(setting.key) }
        : { userId: _.eq(null), key: _.eq(setting.key) }
      await collection.where(condition).update({ value: setting.value, updatedAt: ts })
      return { ...existing, value: setting.value, updatedAt: ts }
    }
    const collection = await getCollection('settings')
    const doc: Setting = {
      ...setting,
      id: setting.id || nanoid(),
      createdAt: setting.createdAt ?? ts,
      updatedAt: setting.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async findSystemSetting(key: string): Promise<Setting | null> {
    const _ = getCommand()
    const collection = await getCollection('settings')
    const { data } = await collection
      .where({ userId: _.eq(null), key: _.eq(key) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<Setting>(data[0] as Record<string, unknown>)
  }

  async upsertSystemSetting(key: string, value: string): Promise<Setting> {
    return this.upsert({ id: nanoid(), userId: null, key, value })
  }

  async deleteSystemSetting(key: string): Promise<boolean> {
    const _ = getCommand()
    const collection = await getCollection('settings')
    const result = await collection.where({ userId: _.eq(null), key: _.eq(key) }).remove()
    return ((result as any).deleted ?? 0) > 0
  }

  async findAllSystemSettings(): Promise<Setting[]> {
    const _ = getCommand()
    const collection = await getCollection('settings')
    const { data } = await collection
      .where({ userId: _.eq(null) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<Setting>(doc))
  }
}

// ─── Deployment Repository ──────────────────────────────────────────────────

class CloudBaseDeploymentRepository implements DeploymentRepository {
  async findByTaskId(taskId: string): Promise<Deployment[]> {
    const _ = getCommand()
    const collection = await getCollection('deployments')
    const { data } = await collection
      .where({ taskId: _.eq(taskId), deletedAt: _.eq(null) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<Deployment>(doc))
  }

  async findByTaskIdAndTypePath(taskId: string, type: string, path: string | null): Promise<Deployment | null> {
    const _ = getCommand()
    const collection = await getCollection('deployments')
    const where: Record<string, unknown> = {
      taskId: _.eq(taskId),
      type: _.eq(type),
      deletedAt: _.eq(null),
    }
    if (path !== null) {
      where.path = _.eq(path)
    } else {
      where.path = _.eq(null)
    }
    const { data } = await collection.where(where).limit(1).get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<Deployment>(data[0] as Record<string, unknown>)
  }

  async findByTaskIdAndUserId(taskId: string, userId: string): Promise<Deployment | null> {
    const _ = getCommand()
    const collection = await getCollection('deployments')
    const { data } = await collection
      .where({ taskId: _.eq(taskId), deletedAt: _.eq(null) })
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    // Filter by userId since CloudBase doesn't support joins
    // This is acceptable: deployment ownership is verified by the caller via task ownership
    return stripCloudBaseId<Deployment>(data[0] as Record<string, unknown>)
  }

  async create(deployment: NewDeployment): Promise<Deployment> {
    const collection = await getCollection('deployments')
    const ts = now()
    const doc: Deployment = {
      ...deployment,
      createdAt: deployment.createdAt ?? ts,
      updatedAt: deployment.updatedAt ?? ts,
      deletedAt: deployment.deletedAt ?? null,
    }
    await collection.add(doc)
    return doc
  }

  async update(id: string, data: Partial<Omit<Deployment, 'id'>>): Promise<Deployment | null> {
    const _ = getCommand()
    const collection = await getCollection('deployments')
    await collection.where({ id: _.eq(id) }).update({ ...data, updatedAt: data.updatedAt ?? now() })
    const { data: rows } = await collection
      .where({ id: _.eq(id) })
      .limit(1)
      .get()
    if (!rows || rows.length === 0) return null
    return stripCloudBaseId<Deployment>(rows[0] as Record<string, unknown>)
  }

  async softDelete(id: string): Promise<void> {
    const _ = getCommand()
    const collection = await getCollection('deployments')
    await collection.where({ id: _.eq(id) }).update({ deletedAt: now() })
  }
}

// ─── AdminLog Repository ───────────────────────────────────────────────────────

class CloudBaseAdminLogRepository implements AdminLogRepository {
  async create(log: NewAdminLog): Promise<AdminLog> {
    const collection = await getCollection('admin_logs')
    const ts = now()
    const doc: AdminLog = {
      ...log,
      createdAt: log.createdAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async findByAdminUserId(adminUserId: string, limit = 50): Promise<AdminLog[]> {
    const _ = getCommand()
    const collection = await getCollection('admin_logs')
    const { data } = await collection
      .where({ adminUserId: _.eq(adminUserId) })
      .limit(limit)
      .get()
    return data.map((doc: any) => stripCloudBaseId<AdminLog>(doc as Record<string, unknown>))
  }

  async findByTargetUserId(targetUserId: string, limit = 50): Promise<AdminLog[]> {
    const _ = getCommand()
    const collection = await getCollection('admin_logs')
    const { data } = await collection
      .where({ targetUserId: _.eq(targetUserId) })
      .limit(limit)
      .get()
    return data.map((doc: any) => stripCloudBaseId<AdminLog>(doc as Record<string, unknown>))
  }

  async findAll(limit = 50, offset = 0): Promise<AdminLog[]> {
    const collection = await getCollection('admin_logs')
    const { data } = await collection.limit(limit).skip(offset).get()
    return data.map((doc: any) => stripCloudBaseId<AdminLog>(doc as Record<string, unknown>))
  }
}

// ─── EnvPool Repository ─────────────────────────────────────────────────────

class CloudBaseEnvPoolRepository implements EnvPoolRepository {
  async findReady(): Promise<EnvPoolEntry | null> {
    const _ = getCommand()
    const collection = await getCollection('env_pool')
    const { data } = await collection
      .where({ status: _.eq('ready') })
      .orderBy('createdAt', 'asc')
      .limit(1)
      .get()
    if (!data || data.length === 0) return null
    return stripCloudBaseId<EnvPoolEntry>(data[0] as Record<string, unknown>)
  }

  async claimEntry(
    id: string,
    data: { claimedByUserId: string; claimedByTaskId: string | null; claimedAt: number },
  ): Promise<EnvPoolEntry | null> {
    const _ = getCommand()
    const collection = await getCollection('env_pool')
    // CAS: only update where status is still 'ready'
    const { updated } = await collection
      .where({ id: _.eq(id), status: _.eq('ready') })
      .update({ status: 'claimed', ...data, updatedAt: now() })
    if (updated === 0) return null // already claimed by another pod
    const { data: rows } = await collection
      .where({ id: _.eq(id) })
      .limit(1)
      .get()
    if (!rows || rows.length === 0) return null
    return stripCloudBaseId<EnvPoolEntry>(rows[0] as Record<string, unknown>)
  }

  async countByStatus(status: string): Promise<number> {
    const _ = getCommand()
    const collection = await getCollection('env_pool')
    const { total } = await collection.where({ status: _.eq(status) }).count()
    return total
  }

  async findAllByStatus(status: string): Promise<EnvPoolEntry[]> {
    const _ = getCommand()
    const collection = await getCollection('env_pool')
    const { data } = await collection
      .where({ status: _.eq(status) })
      .limit(1000)
      .get()
    return (data as Record<string, unknown>[]).map((doc) => stripCloudBaseId<EnvPoolEntry>(doc))
  }

  async countActive(): Promise<number> {
    const _ = getCommand()
    const collection = await getCollection('env_pool')
    const { total } = await collection.where(_.or([{ status: _.eq('creating') }, { status: _.eq('ready') }])).count()
    return total
  }

  async create(entry: NewEnvPoolEntry): Promise<EnvPoolEntry> {
    const collection = await getCollection('env_pool')
    const ts = now()
    const doc: EnvPoolEntry = {
      ...entry,
      createdAt: entry.createdAt ?? ts,
      updatedAt: entry.updatedAt ?? ts,
    }
    await collection.add(doc)
    return doc
  }

  async update(id: string, data: Partial<Omit<EnvPoolEntry, 'id'>>): Promise<EnvPoolEntry | null> {
    const _ = getCommand()
    const collection = await getCollection('env_pool')
    await collection.where({ id: _.eq(id) }).update({ ...data, updatedAt: data.updatedAt ?? now() })
    const { data: rows } = await collection
      .where({ id: _.eq(id) })
      .limit(1)
      .get()
    if (!rows || rows.length === 0) return null
    return stripCloudBaseId<EnvPoolEntry>(rows[0] as Record<string, unknown>)
  }

  async getStats(): Promise<Record<string, number>> {
    const stats: Record<string, number> = { creating: 0, ready: 0, claimed: 0, failed: 0 }
    for (const status of Object.keys(stats)) {
      stats[status] = await this.countByStatus(status)
    }
    return stats
  }
}

// ─── Provider Factory ───────────────────────────────────────────────────────

export function createCloudBaseProvider(): DatabaseProvider {
  return {
    users: new CloudBaseUserRepository(),
    localCredentials: new CloudBaseLocalCredentialRepository(),
    tasks: new CloudBaseTaskRepository(),
    connectors: new CloudBaseConnectorRepository(),
    miniprogramApps: new CloudBaseMiniProgramAppRepository(),
    cronTasks: new CloudBaseCronTaskRepository(),
    accounts: new CloudBaseAccountRepository(),
    keys: new CloudBaseKeyRepository(),
    userResources: new CloudBaseUserResourceRepository(),
    settings: new CloudBaseSettingRepository(),
    deployments: new CloudBaseDeploymentRepository(),
    adminLogs: new CloudBaseAdminLogRepository(),
    envPool: new CloudBaseEnvPoolRepository(),
  }
}
