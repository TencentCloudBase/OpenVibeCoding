import { eq, and, isNull, desc, sql, asc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { drizzleDb } from './client'
import {
  users,
  localCredentials,
  tasks,
  connectors,
  miniprogramApps,
  cronTasks,
  accounts,
  keys,
  userResources,
  settings,
  deployments,
  adminLogs,
  envPool,
} from '../schema'
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

// ─── User Repository ────────────────────────────────────────────────────────

class DrizzleUserRepository implements UserRepository {
  async findById(id: string): Promise<User | null> {
    const [row] = await drizzleDb.select().from(users).where(eq(users.id, id)).limit(1)
    return (row as User) ?? null
  }

  async findByProviderAndExternalId(provider: string, externalId: string): Promise<User | null> {
    const [row] = await drizzleDb
      .select()
      .from(users)
      .where(and(eq(users.provider, provider), eq(users.externalId, externalId)))
      .limit(1)
    return (row as User) ?? null
  }

  async findByApiKey(encryptedApiKey: string): Promise<User | null> {
    const [row] = await drizzleDb.select().from(users).where(eq(users.apiKey, encryptedApiKey)).limit(1)
    return (row as User) ?? null
  }

  async create(user: NewUser): Promise<User> {
    const ts = now()
    const values = {
      ...user,
      createdAt: user.createdAt ?? ts,
      updatedAt: user.updatedAt ?? ts,
      lastLoginAt: user.lastLoginAt ?? ts,
    }
    await drizzleDb.insert(users).values(values)
    return values as User
  }

  async update(id: string, data: Partial<Omit<User, 'id'>>): Promise<User | null> {
    await drizzleDb
      .update(users)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(eq(users.id, id))
    return this.findById(id)
  }

  async deleteById(id: string): Promise<void> {
    await drizzleDb.delete(users).where(eq(users.id, id))
  }

  // Admin methods
  async findAll(limit = 20, offset = 0): Promise<User[]> {
    const rows = await drizzleDb.select().from(users).limit(limit).offset(offset).orderBy(desc(users.createdAt))
    return rows as User[]
  }

  async count(): Promise<number> {
    const [result] = await drizzleDb.select({ count: users.id }).from(users)
    return result ? 1 : 0 // Simplified count
  }

  async updateRole(id: string, role: 'user' | 'admin'): Promise<User | null> {
    await drizzleDb.update(users).set({ role, updatedAt: now() }).where(eq(users.id, id))
    return this.findById(id)
  }

  async disable(id: string, reason: string, adminUserId: string): Promise<User | null> {
    await drizzleDb
      .update(users)
      .set({
        status: 'disabled',
        disabledReason: reason,
        disabledAt: now(),
        disabledBy: adminUserId,
        updatedAt: now(),
      })
      .where(eq(users.id, id))
    return this.findById(id)
  }

  async enable(id: string): Promise<User | null> {
    await drizzleDb
      .update(users)
      .set({
        status: 'active',
        disabledReason: null,
        disabledAt: null,
        disabledBy: null,
        updatedAt: now(),
      })
      .where(eq(users.id, id))
    return this.findById(id)
  }
}

// ─── LocalCredential Repository ─────────────────────────────────────────────

class DrizzleLocalCredentialRepository implements LocalCredentialRepository {
  async findByUserId(userId: string): Promise<LocalCredential | null> {
    const [row] = await drizzleDb.select().from(localCredentials).where(eq(localCredentials.userId, userId)).limit(1)
    return (row as LocalCredential) ?? null
  }

  async create(credential: NewLocalCredential): Promise<LocalCredential> {
    const ts = now()
    const values = {
      ...credential,
      createdAt: credential.createdAt ?? ts,
      updatedAt: credential.updatedAt ?? ts,
    }
    await drizzleDb.insert(localCredentials).values(values)
    return values as LocalCredential
  }

  async update(userId: string, data: Partial<Omit<LocalCredential, 'userId'>>): Promise<LocalCredential | null> {
    await drizzleDb
      .update(localCredentials)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(eq(localCredentials.userId, userId))
    return this.findByUserId(userId)
  }
}

// ─── Task Repository ────────────────────────────────────────────────────────

class DrizzleTaskRepository implements TaskRepository {
  async findById(id: string): Promise<Task | null> {
    const [row] = await drizzleDb.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    return (row as unknown as Task) ?? null
  }

  async findByIdAndUserId(id: string, userId: string): Promise<Task | null> {
    const [row] = await drizzleDb
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
      .limit(1)
    return (row as unknown as Task) ?? null
  }

  async findByUserId(userId: string, limit = 20): Promise<Task[]> {
    const rows = await drizzleDb
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
    return rows as unknown as Task[]
  }

  async findByRepoAndPr(userId: string, prNumber: number, repoUrl: string): Promise<Task[]> {
    const rows = await drizzleDb
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.prNumber, prNumber),
          eq(tasks.repoUrl, repoUrl),
          isNull(tasks.deletedAt),
        ),
      )
      .limit(1)
    return rows as unknown as Task[]
  }

  async findAll(limit: number, offset: number, filters?: { userId?: string; status?: string }): Promise<Task[]> {
    const conditions = [isNull(tasks.deletedAt)]
    if (filters?.userId) conditions.push(eq(tasks.userId, filters.userId))
    if (filters?.status) conditions.push(eq(tasks.status, filters.status))
    const rows = await drizzleDb
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .offset(offset)
    return rows as unknown as Task[]
  }

  async count(filters?: { userId?: string; status?: string }): Promise<number> {
    const conditions = [isNull(tasks.deletedAt)]
    if (filters?.userId) conditions.push(eq(tasks.userId, filters.userId))
    if (filters?.status) conditions.push(eq(tasks.status, filters.status))
    const rows = await drizzleDb
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(...conditions))
    return Number(rows[0]?.count ?? 0)
  }

  async create(task: NewTask): Promise<Task> {
    const ts = now()
    const values = {
      ...task,
      createdAt: task.createdAt ?? ts,
      updatedAt: task.updatedAt ?? ts,
    }
    await drizzleDb.insert(tasks).values(values)
    const [row] = await drizzleDb.select().from(tasks).where(eq(tasks.id, task.id)).limit(1)
    return row as unknown as Task
  }

  async update(id: string, data: Partial<Omit<Task, 'id'>>): Promise<Task | null> {
    await drizzleDb
      .update(tasks)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(eq(tasks.id, id))
    return this.findById(id)
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    await drizzleDb.update(tasks).set({ userId: toUserId }).where(eq(tasks.userId, fromUserId))
  }

  async softDelete(id: string): Promise<void> {
    await drizzleDb.update(tasks).set({ deletedAt: now() }).where(eq(tasks.id, id))
  }
}

// ─── Connector Repository ───────────────────────────────────────────────────

class DrizzleConnectorRepository implements ConnectorRepository {
  async findByUserId(userId: string): Promise<Connector[]> {
    const rows = await drizzleDb.select().from(connectors).where(eq(connectors.userId, userId))
    return rows as Connector[]
  }

  async findByIdAndUserId(id: string, userId: string): Promise<Connector | null> {
    const [row] = await drizzleDb
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, id), eq(connectors.userId, userId)))
      .limit(1)
    return (row as Connector) ?? null
  }

  async create(connector: NewConnector): Promise<Connector> {
    const ts = now()
    const values = {
      ...connector,
      createdAt: connector.createdAt ?? ts,
      updatedAt: connector.updatedAt ?? ts,
    }
    await drizzleDb.insert(connectors).values(values)
    return values as Connector
  }

  async update(id: string, userId: string, data: Partial<Omit<Connector, 'id' | 'userId'>>): Promise<Connector | null> {
    await drizzleDb
      .update(connectors)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(and(eq(connectors.id, id), eq(connectors.userId, userId)))
    return this.findByIdAndUserId(id, userId)
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    await drizzleDb.update(connectors).set({ userId: toUserId }).where(eq(connectors.userId, fromUserId))
  }

  async delete(id: string, userId: string): Promise<void> {
    await drizzleDb.delete(connectors).where(and(eq(connectors.id, id), eq(connectors.userId, userId)))
  }
}

// ─── MiniProgramApp Repository ──────────────────────────────────────────────

class DrizzleMiniProgramAppRepository implements MiniProgramAppRepository {
  async findByUserId(userId: string): Promise<MiniProgramApp[]> {
    const rows = await drizzleDb.select().from(miniprogramApps).where(eq(miniprogramApps.userId, userId))
    return rows as MiniProgramApp[]
  }

  async findByIdAndUserId(id: string, userId: string): Promise<MiniProgramApp | null> {
    const [row] = await drizzleDb
      .select()
      .from(miniprogramApps)
      .where(and(eq(miniprogramApps.id, id), eq(miniprogramApps.userId, userId)))
      .limit(1)
    return (row as MiniProgramApp) ?? null
  }

  async findByAppIdAndUserId(appId: string, userId: string): Promise<MiniProgramApp | null> {
    const [row] = await drizzleDb
      .select()
      .from(miniprogramApps)
      .where(and(eq(miniprogramApps.appId, appId), eq(miniprogramApps.userId, userId)))
      .limit(1)
    return (row as MiniProgramApp) ?? null
  }

  async create(app: NewMiniProgramApp): Promise<MiniProgramApp> {
    const ts = now()
    const values = {
      ...app,
      createdAt: app.createdAt ?? ts,
      updatedAt: app.updatedAt ?? ts,
    }
    await drizzleDb.insert(miniprogramApps).values(values)
    return values as MiniProgramApp
  }

  async update(
    id: string,
    userId: string,
    data: Partial<Omit<MiniProgramApp, 'id' | 'userId'>>,
  ): Promise<MiniProgramApp | null> {
    await drizzleDb
      .update(miniprogramApps)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(and(eq(miniprogramApps.id, id), eq(miniprogramApps.userId, userId)))
    return this.findByIdAndUserId(id, userId)
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    await drizzleDb.update(miniprogramApps).set({ userId: toUserId }).where(eq(miniprogramApps.userId, fromUserId))
  }

  async delete(id: string, userId: string): Promise<void> {
    await drizzleDb.delete(miniprogramApps).where(and(eq(miniprogramApps.id, id), eq(miniprogramApps.userId, userId)))
  }
}

// ─── Account Repository ─────────────────────────────────────────────────────

// ─── CronTask Repository ────────────────────────────────────────────────────

class DrizzleCronTaskRepository implements CronTaskRepository {
  async findByUserId(userId: string): Promise<CronTask[]> {
    const rows = await drizzleDb.select().from(cronTasks).where(eq(cronTasks.userId, userId))
    return rows as CronTask[]
  }

  async findByIdAndUserId(id: string, userId: string): Promise<CronTask | null> {
    const [row] = await drizzleDb
      .select()
      .from(cronTasks)
      .where(and(eq(cronTasks.id, id), eq(cronTasks.userId, userId)))
      .limit(1)
    return (row as CronTask) ?? null
  }

  async findAllEnabled(): Promise<CronTask[]> {
    const rows = await drizzleDb.select().from(cronTasks).where(eq(cronTasks.enabled, true))
    return rows as CronTask[]
  }

  async create(task: NewCronTask): Promise<CronTask> {
    const ts = now()
    const values = {
      ...task,
      createdAt: task.createdAt ?? ts,
      updatedAt: task.updatedAt ?? ts,
    }
    await drizzleDb.insert(cronTasks).values(values)
    return values as CronTask
  }

  async update(id: string, userId: string, data: Partial<Omit<CronTask, 'id' | 'userId'>>): Promise<CronTask | null> {
    await drizzleDb
      .update(cronTasks)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(and(eq(cronTasks.id, id), eq(cronTasks.userId, userId)))
    return this.findByIdAndUserId(id, userId)
  }

  async delete(id: string, userId: string): Promise<void> {
    await drizzleDb.delete(cronTasks).where(and(eq(cronTasks.id, id), eq(cronTasks.userId, userId)))
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    await drizzleDb.update(cronTasks).set({ userId: toUserId }).where(eq(cronTasks.userId, fromUserId))
  }

  async tryLock(id: string, lockerId: string, maxLockMs: number): Promise<boolean> {
    const cutoff = Date.now() - maxLockMs
    // Atomic CAS: only acquire if unlocked or lock expired
    const result = await drizzleDb
      .update(cronTasks)
      .set({ lockedBy: lockerId, lockedAt: Date.now() })
      .where(and(eq(cronTasks.id, id), sql`(${cronTasks.lockedBy} IS NULL OR ${cronTasks.lockedAt} < ${cutoff})`))
    return (result as any).changes > 0
  }

  async releaseLock(id: string, lockerId: string): Promise<void> {
    await drizzleDb
      .update(cronTasks)
      .set({ lockedBy: null, lockedAt: null })
      .where(and(eq(cronTasks.id, id), eq(cronTasks.lockedBy, lockerId)))
  }
}

// ─── Account Repository ─────────────────────────────────────────────────────

class DrizzleAccountRepository implements AccountRepository {
  async findByUserIdAndProvider(userId: string, provider: string): Promise<Account | null> {
    const [row] = await drizzleDb
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)))
      .limit(1)
    return (row as Account) ?? null
  }

  async findByProviderAndExternalUserId(provider: string, externalUserId: string): Promise<Account | null> {
    const [row] = await drizzleDb
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, provider), eq(accounts.externalUserId, externalUserId)))
      .limit(1)
    return (row as Account) ?? null
  }

  async create(account: NewAccount): Promise<Account> {
    const ts = now()
    const values = {
      ...account,
      createdAt: account.createdAt ?? ts,
      updatedAt: account.updatedAt ?? ts,
    }
    await drizzleDb.insert(accounts).values(values)
    return values as Account
  }

  async update(id: string, data: Partial<Omit<Account, 'id'>>): Promise<Account | null> {
    await drizzleDb
      .update(accounts)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(eq(accounts.id, id))
    const [row] = await drizzleDb.select().from(accounts).where(eq(accounts.id, id)).limit(1)
    return (row as Account) ?? null
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    await drizzleDb.update(accounts).set({ userId: toUserId }).where(eq(accounts.userId, fromUserId))
  }

  async delete(userId: string, provider: string): Promise<void> {
    await drizzleDb.delete(accounts).where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)))
  }
}

// ─── Key Repository ─────────────────────────────────────────────────────────

class DrizzleKeyRepository implements KeyRepository {
  async findByUserId(userId: string): Promise<Key[]> {
    const rows = await drizzleDb.select().from(keys).where(eq(keys.userId, userId))
    return rows as Key[]
  }

  async findByUserIdAndProvider(userId: string, provider: string): Promise<Key | null> {
    const [row] = await drizzleDb
      .select()
      .from(keys)
      .where(and(eq(keys.userId, userId), eq(keys.provider, provider)))
      .limit(1)
    return (row as Key) ?? null
  }

  async upsert(key: NewKey): Promise<Key> {
    const ts = now()
    const existing = await this.findByUserIdAndProvider(key.userId, key.provider)
    if (existing) {
      await drizzleDb
        .update(keys)
        .set({ value: key.value, updatedAt: ts })
        .where(and(eq(keys.userId, key.userId), eq(keys.provider, key.provider)))
      return { ...existing, value: key.value, updatedAt: ts }
    }
    const values = {
      ...key,
      id: key.id || nanoid(),
      createdAt: key.createdAt ?? ts,
      updatedAt: key.updatedAt ?? ts,
    }
    await drizzleDb.insert(keys).values(values)
    return values as Key
  }

  async updateUserId(fromUserId: string, toUserId: string): Promise<void> {
    await drizzleDb.update(keys).set({ userId: toUserId }).where(eq(keys.userId, fromUserId))
  }

  async delete(userId: string, provider: string): Promise<void> {
    await drizzleDb.delete(keys).where(and(eq(keys.userId, userId), eq(keys.provider, provider)))
  }
}

// ─── UserResource Repository ────────────────────────────────────────────────

class DrizzleUserResourceRepository implements UserResourceRepository {
  async findByUserId(userId: string): Promise<UserResource | null> {
    // Return user-scoped resource (scope='user'), backwards compatible
    const [row] = await drizzleDb
      .select()
      .from(userResources)
      .where(and(eq(userResources.userId, userId), eq(userResources.scope, 'user')))
      .limit(1)
    return (row as UserResource) ?? null
  }

  async findByTaskId(taskId: string): Promise<UserResource | null> {
    const [row] = await drizzleDb
      .select()
      .from(userResources)
      .where(and(eq(userResources.scope, 'task'), eq(userResources.taskId, taskId)))
      .limit(1)
    return (row as UserResource) ?? null
  }

  async findAllByUserId(userId: string): Promise<UserResource[]> {
    const rows = await drizzleDb.select().from(userResources).where(eq(userResources.userId, userId))
    return rows as UserResource[]
  }

  async create(resource: NewUserResource): Promise<UserResource> {
    const ts = now()
    const values = {
      ...resource,
      scope: resource.scope || 'user',
      taskId: resource.taskId ?? null,
      createdAt: resource.createdAt ?? ts,
      updatedAt: resource.updatedAt ?? ts,
    }
    await drizzleDb.insert(userResources).values(values)
    return values as UserResource
  }

  async update(id: string, data: Partial<Omit<UserResource, 'id'>>): Promise<UserResource | null> {
    await drizzleDb
      .update(userResources)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(eq(userResources.id, id))
    const [row] = await drizzleDb.select().from(userResources).where(eq(userResources.id, id)).limit(1)
    return (row as UserResource) ?? null
  }

  async deleteById(id: string): Promise<void> {
    await drizzleDb.delete(userResources).where(eq(userResources.id, id))
  }
}

// ─── Setting Repository ─────────────────────────────────────────────────────

class DrizzleSettingRepository implements SettingRepository {
  async findByUserIdAndKey(userId: string, key: string): Promise<Setting | null> {
    const [row] = await drizzleDb
      .select()
      .from(settings)
      .where(and(eq(settings.userId, userId), eq(settings.key, key)))
      .limit(1)
    return (row as Setting) ?? null
  }

  async findByUserId(userId: string): Promise<Setting[]> {
    const rows = await drizzleDb.select().from(settings).where(eq(settings.userId, userId))
    return rows as Setting[]
  }

  async upsert(setting: NewSetting): Promise<Setting> {
    const ts = now()
    const existing = setting.userId
      ? await this.findByUserIdAndKey(setting.userId, setting.key)
      : await this.findSystemSetting(setting.key)
    if (existing) {
      const condition = setting.userId
        ? and(eq(settings.userId, setting.userId), eq(settings.key, setting.key))
        : and(isNull(settings.userId), eq(settings.key, setting.key))
      await drizzleDb.update(settings).set({ value: setting.value, updatedAt: ts }).where(condition)
      return { ...existing, value: setting.value, updatedAt: ts }
    }
    const values = {
      ...setting,
      id: setting.id || nanoid(),
      createdAt: setting.createdAt ?? ts,
      updatedAt: setting.updatedAt ?? ts,
    }
    await drizzleDb.insert(settings).values(values)
    return values as Setting
  }

  async findSystemSetting(key: string): Promise<Setting | null> {
    const [row] = await drizzleDb
      .select()
      .from(settings)
      .where(and(isNull(settings.userId), eq(settings.key, key)))
      .limit(1)
    return (row as Setting) ?? null
  }

  async upsertSystemSetting(key: string, value: string): Promise<Setting> {
    return this.upsert({ id: nanoid(), userId: null, key, value })
  }

  async deleteSystemSetting(key: string): Promise<boolean> {
    const result = await drizzleDb.delete(settings).where(and(isNull(settings.userId), eq(settings.key, key)))
    // drizzle 不同 driver 返回结构不一，统一通过 changes/affectedRows 判断
    const affected = (result as any).changes ?? (result as any).rowCount ?? (result as any).affectedRows ?? 0
    return affected > 0
  }

  async findAllSystemSettings(): Promise<Setting[]> {
    const rows = await drizzleDb.select().from(settings).where(isNull(settings.userId))
    return rows as Setting[]
  }
}

// ─── Deployment Repository ──────────────────────────────────────────────────

class DrizzleDeploymentRepository implements DeploymentRepository {
  async findByTaskId(taskId: string): Promise<Deployment[]> {
    const rows = await drizzleDb
      .select()
      .from(deployments)
      .where(and(eq(deployments.taskId, taskId), isNull(deployments.deletedAt)))
    return rows as Deployment[]
  }

  async findByTaskIdAndTypePath(taskId: string, type: string, path: string | null): Promise<Deployment | null> {
    const conditions = [eq(deployments.taskId, taskId), eq(deployments.type, type), isNull(deployments.deletedAt)]
    if (path !== null) {
      conditions.push(eq(deployments.path, path))
    } else {
      conditions.push(isNull(deployments.path))
    }
    const [row] = await drizzleDb
      .select()
      .from(deployments)
      .where(and(...conditions))
      .limit(1)
    return (row as Deployment) ?? null
  }

  async findByTaskIdAndUserId(taskId: string, userId: string): Promise<Deployment | null> {
    const [row] = await drizzleDb
      .select()
      .from(deployments)
      .innerJoin(tasks, eq(deployments.taskId, tasks.id))
      .where(and(eq(deployments.taskId, taskId), eq(tasks.userId, userId), isNull(deployments.deletedAt)))
      .limit(1)
    return row ? (row.deployments as Deployment) : null
  }

  async create(deployment: NewDeployment): Promise<Deployment> {
    const ts = now()
    const values = {
      ...deployment,
      createdAt: deployment.createdAt ?? ts,
      updatedAt: deployment.updatedAt ?? ts,
    }
    await drizzleDb.insert(deployments).values(values)
    return values as Deployment
  }

  async update(id: string, data: Partial<Omit<Deployment, 'id'>>): Promise<Deployment | null> {
    await drizzleDb
      .update(deployments)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(eq(deployments.id, id))
    const [row] = await drizzleDb.select().from(deployments).where(eq(deployments.id, id)).limit(1)
    return (row as Deployment) ?? null
  }

  async softDelete(id: string): Promise<void> {
    await drizzleDb.update(deployments).set({ deletedAt: now() }).where(eq(deployments.id, id))
  }
}

// ─── AdminLog Repository ───────────────────────────────────────────────────────

class DrizzleAdminLogRepository implements AdminLogRepository {
  async create(log: NewAdminLog): Promise<AdminLog> {
    const ts = now()
    const values = {
      ...log,
      createdAt: log.createdAt ?? ts,
    }
    await drizzleDb.insert(adminLogs).values(values)
    return values as AdminLog
  }

  async findByAdminUserId(adminUserId: string, limit = 50): Promise<AdminLog[]> {
    const rows = await drizzleDb
      .select()
      .from(adminLogs)
      .where(eq(adminLogs.adminUserId, adminUserId))
      .limit(limit)
      .orderBy(desc(adminLogs.createdAt))
    return rows as AdminLog[]
  }

  async findByTargetUserId(targetUserId: string, limit = 50): Promise<AdminLog[]> {
    const rows = await drizzleDb
      .select()
      .from(adminLogs)
      .where(eq(adminLogs.targetUserId, targetUserId))
      .limit(limit)
      .orderBy(desc(adminLogs.createdAt))
    return rows as AdminLog[]
  }

  async findAll(limit = 50, offset = 0): Promise<AdminLog[]> {
    const rows = await drizzleDb.select().from(adminLogs).limit(limit).offset(offset).orderBy(desc(adminLogs.createdAt))
    return rows as AdminLog[]
  }
}

// ─── EnvPool Repository ────────────────────────────────────────────────────

class DrizzleEnvPoolRepository implements EnvPoolRepository {
  async findReady(): Promise<EnvPoolEntry | null> {
    const [row] = await drizzleDb
      .select()
      .from(envPool)
      .where(eq(envPool.status, 'ready'))
      .orderBy(asc(envPool.createdAt))
      .limit(1)
    return (row as EnvPoolEntry) ?? null
  }

  async claimEntry(
    id: string,
    data: { claimedByUserId: string; claimedByTaskId: string | null; claimedAt: number },
  ): Promise<EnvPoolEntry | null> {
    // CAS: only update if status is still 'ready'
    const result = await drizzleDb
      .update(envPool)
      .set({ status: 'claimed', ...data, updatedAt: now() })
      .where(and(eq(envPool.id, id), eq(envPool.status, 'ready')))
    // SQLite: changes === 0 means row was already claimed by another pod
    if ((result as any).changes === 0 && (result as any).rowsAffected === undefined) {
      // Drizzle returns different shapes depending on driver; check by re-reading
      const [row] = await drizzleDb.select().from(envPool).where(eq(envPool.id, id)).limit(1)
      if (!row || row.status !== 'claimed' || row.claimedByUserId !== data.claimedByUserId) return null
      return row as EnvPoolEntry
    }
    const [row] = await drizzleDb.select().from(envPool).where(eq(envPool.id, id)).limit(1)
    if (!row || row.status !== 'claimed') return null
    return row as EnvPoolEntry
  }

  async countByStatus(status: string): Promise<number> {
    const [row] = await drizzleDb
      .select({ count: sql<number>`count(*)` })
      .from(envPool)
      .where(eq(envPool.status, status))
    return row?.count ?? 0
  }

  async findAllByStatus(status: string): Promise<EnvPoolEntry[]> {
    const rows = await drizzleDb.select().from(envPool).where(eq(envPool.status, status))
    return rows as EnvPoolEntry[]
  }

  async countActive(): Promise<number> {
    const [row] = await drizzleDb
      .select({ count: sql<number>`count(*)` })
      .from(envPool)
      .where(sql`${envPool.status} IN ('creating', 'ready')`)
    return row?.count ?? 0
  }

  async create(entry: NewEnvPoolEntry): Promise<EnvPoolEntry> {
    const ts = now()
    const values = {
      ...entry,
      createdAt: entry.createdAt ?? ts,
      updatedAt: entry.updatedAt ?? ts,
    }
    await drizzleDb.insert(envPool).values(values)
    return values as EnvPoolEntry
  }

  async update(id: string, data: Partial<Omit<EnvPoolEntry, 'id'>>): Promise<EnvPoolEntry | null> {
    await drizzleDb
      .update(envPool)
      .set({ ...data, updatedAt: data.updatedAt ?? now() })
      .where(eq(envPool.id, id))
    const [row] = await drizzleDb.select().from(envPool).where(eq(envPool.id, id)).limit(1)
    return (row as EnvPoolEntry) ?? null
  }

  async getStats(): Promise<Record<string, number>> {
    const rows = await drizzleDb
      .select({ status: envPool.status, count: sql<number>`count(*)` })
      .from(envPool)
      .groupBy(envPool.status)
    const stats: Record<string, number> = { creating: 0, ready: 0, claimed: 0, failed: 0 }
    for (const row of rows) {
      stats[row.status] = row.count
    }
    return stats
  }
}

// ─── Provider Factory ───────────────────────────────────────────────────────

export function createDrizzleProvider(): DatabaseProvider {
  return {
    users: new DrizzleUserRepository(),
    localCredentials: new DrizzleLocalCredentialRepository(),
    tasks: new DrizzleTaskRepository(),
    connectors: new DrizzleConnectorRepository(),
    miniprogramApps: new DrizzleMiniProgramAppRepository(),
    cronTasks: new DrizzleCronTaskRepository(),
    accounts: new DrizzleAccountRepository(),
    keys: new DrizzleKeyRepository(),
    userResources: new DrizzleUserResourceRepository(),
    settings: new DrizzleSettingRepository(),
    deployments: new DrizzleDeploymentRepository(),
    adminLogs: new DrizzleAdminLogRepository(),
    envPool: new DrizzleEnvPoolRepository(),
  }
}
