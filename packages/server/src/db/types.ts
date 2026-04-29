// ─── Data Types ─────────────────────────────────────────────────────────────

export interface User {
  id: string
  provider: string
  externalId: string
  accessToken: string
  refreshToken: string | null
  scope: string | null
  username: string
  email: string | null
  name: string | null
  avatarUrl: string | null
  role: string // 'user' | 'admin'
  status: string // 'active' | 'disabled'
  disabledReason: string | null
  disabledAt: number | null
  disabledBy: string | null
  apiKey: string | null // Encrypted server API key
  createdAt: number
  updatedAt: number
  lastLoginAt: number
}

export interface LocalCredential {
  userId: string
  passwordHash: string
  createdAt: number
  updatedAt: number
}

export interface Task {
  id: string
  userId: string
  prompt: string
  title: string | null
  repoUrl: string | null
  selectedAgent: string | null
  selectedModel: string | null
  mode: string
  installDependencies: boolean | null
  maxDuration: number | null
  keepAlive: boolean | null
  enableBrowser: boolean | null
  status: string
  progress: number | null
  logs: string | null
  error: string | null
  branchName: string | null
  sandboxId: string | null
  sandboxSessionId: string | null
  sandboxCwd: string | null
  sandboxMode: string | null
  agentSessionId: string | null
  sandboxUrl: string | null
  previewUrl: string | null
  prUrl: string | null
  prNumber: number | null
  prStatus: string | null
  prMergeCommitSha: string | null
  mcpServerIds: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  deletedAt: number | null
}

export interface Connector {
  id: string
  userId: string
  name: string
  description: string | null
  type: string
  baseUrl: string | null
  oauthClientId: string | null
  oauthClientSecret: string | null
  command: string | null
  env: string | null
  status: string
  createdAt: number
  updatedAt: number
}

export interface MiniProgramApp {
  id: string
  userId: string
  name: string
  appId: string
  privateKey: string
  description: string | null
  createdAt: number
  updatedAt: number
}

export interface CronTask {
  id: string
  userId: string
  name: string
  prompt: string
  cronExpression: string
  enabled: boolean
  repoUrl: string | null
  selectedAgent: string | null
  selectedModel: string | null
  lastRunAt: number | null
  nextRunAt: number | null
  lockedBy: string | null
  lockedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Account {
  id: string
  userId: string
  provider: string
  externalUserId: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scope: string | null
  username: string
  createdAt: number
  updatedAt: number
}

export interface Key {
  id: string
  userId: string
  provider: string
  value: string
  createdAt: number
  updatedAt: number
}

export interface UserResource {
  id: string
  userId: string
  status: string
  envId: string | null
  camUsername: string | null
  camSecretId: string | null
  camSecretKey: string | null
  policyId: number | null
  failStep: string | null
  failReason: string | null
  createdAt: number
  updatedAt: number
}

export interface Setting {
  id: string
  userId: string
  key: string
  value: string
  createdAt: number
  updatedAt: number
}

export interface Deployment {
  id: string
  taskId: string
  type: string
  url: string | null
  path: string | null
  qrCodeUrl: string | null
  pagePath: string | null
  appId: string | null
  label: string | null
  metadata: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface AdminLog {
  id: string
  adminUserId: string
  action: string
  targetUserId: string | null
  details: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: number
}

// ─── Creation Types (omit auto-generated timestamps) ────────────────────────

export type NewUser = Omit<User, 'createdAt' | 'updatedAt' | 'lastLoginAt'> & {
  createdAt?: number
  updatedAt?: number
  lastLoginAt?: number
}

export type NewLocalCredential = Omit<LocalCredential, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export type NewTask = Omit<Task, 'createdAt' | 'updatedAt' | 'completedAt' | 'deletedAt'> & {
  createdAt?: number
  updatedAt?: number
  completedAt?: number | null
  deletedAt?: number | null
}

export type NewConnector = Omit<Connector, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export type NewMiniProgramApp = Omit<MiniProgramApp, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export type NewCronTask = Omit<CronTask, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export type NewAccount = Omit<Account, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export type NewKey = Omit<Key, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export type NewUserResource = Omit<UserResource, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export type NewSetting = Omit<Setting, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

export type NewDeployment = Omit<Deployment, 'createdAt' | 'updatedAt' | 'deletedAt'> & {
  createdAt?: number
  updatedAt?: number
  deletedAt?: number | null
}

export type NewAdminLog = Omit<AdminLog, 'createdAt'> & {
  createdAt?: number
}

// ─── Repository Interfaces ──────────────────────────────────────────────────

export interface UserRepository {
  findById(id: string): Promise<User | null>
  findByProviderAndExternalId(provider: string, externalId: string): Promise<User | null>
  findByApiKey(encryptedApiKey: string): Promise<User | null>
  create(user: NewUser): Promise<User>
  update(id: string, data: Partial<Omit<User, 'id'>>): Promise<User | null>
  deleteById(id: string): Promise<void>
  // Admin methods
  findAll(limit?: number, offset?: number): Promise<User[]>
  count(): Promise<number>
  updateRole(id: string, role: 'user' | 'admin'): Promise<User | null>
  disable(id: string, reason: string, adminUserId: string): Promise<User | null>
  enable(id: string): Promise<User | null>
}

export interface LocalCredentialRepository {
  findByUserId(userId: string): Promise<LocalCredential | null>
  create(credential: NewLocalCredential): Promise<LocalCredential>
  update(userId: string, data: Partial<Omit<LocalCredential, 'userId'>>): Promise<LocalCredential | null>
}

export interface TaskRepository {
  findById(id: string): Promise<Task | null>
  findByIdAndUserId(id: string, userId: string): Promise<Task | null>
  findByUserId(userId: string): Promise<Task[]>
  findByRepoAndPr(userId: string, prNumber: number, repoUrl: string): Promise<Task[]>
  findAll(limit: number, offset: number, filters?: { userId?: string; status?: string }): Promise<Task[]>
  count(filters?: { userId?: string; status?: string }): Promise<number>
  create(task: NewTask): Promise<Task>
  update(id: string, data: Partial<Omit<Task, 'id'>>): Promise<Task | null>
  updateUserId(fromUserId: string, toUserId: string): Promise<void>
  softDelete(id: string): Promise<void>
}

export interface ConnectorRepository {
  findByUserId(userId: string): Promise<Connector[]>
  findByIdAndUserId(id: string, userId: string): Promise<Connector | null>
  create(connector: NewConnector): Promise<Connector>
  update(id: string, userId: string, data: Partial<Omit<Connector, 'id' | 'userId'>>): Promise<Connector | null>
  updateUserId(fromUserId: string, toUserId: string): Promise<void>
  delete(id: string, userId: string): Promise<void>
}

export interface MiniProgramAppRepository {
  findByUserId(userId: string): Promise<MiniProgramApp[]>
  findByIdAndUserId(id: string, userId: string): Promise<MiniProgramApp | null>
  findByAppIdAndUserId(appId: string, userId: string): Promise<MiniProgramApp | null>
  create(app: NewMiniProgramApp): Promise<MiniProgramApp>
  update(
    id: string,
    userId: string,
    data: Partial<Omit<MiniProgramApp, 'id' | 'userId'>>,
  ): Promise<MiniProgramApp | null>
  delete(id: string, userId: string): Promise<void>
  updateUserId(fromUserId: string, toUserId: string): Promise<void>
}

export interface CronTaskRepository {
  findByUserId(userId: string): Promise<CronTask[]>
  findByIdAndUserId(id: string, userId: string): Promise<CronTask | null>
  findAllEnabled(): Promise<CronTask[]>
  create(task: NewCronTask): Promise<CronTask>
  update(id: string, userId: string, data: Partial<Omit<CronTask, 'id' | 'userId'>>): Promise<CronTask | null>
  delete(id: string, userId: string): Promise<void>
  updateUserId(fromUserId: string, toUserId: string): Promise<void>
  tryLock(id: string, lockerId: string, maxLockMs: number): Promise<boolean>
  releaseLock(id: string, lockerId: string): Promise<void>
}

export interface AccountRepository {
  findByUserIdAndProvider(userId: string, provider: string): Promise<Account | null>
  findByProviderAndExternalUserId(provider: string, externalUserId: string): Promise<Account | null>
  create(account: NewAccount): Promise<Account>
  update(id: string, data: Partial<Omit<Account, 'id'>>): Promise<Account | null>
  updateUserId(fromUserId: string, toUserId: string): Promise<void>
  delete(userId: string, provider: string): Promise<void>
}

export interface KeyRepository {
  findByUserId(userId: string): Promise<Key[]>
  findByUserIdAndProvider(userId: string, provider: string): Promise<Key | null>
  upsert(key: NewKey): Promise<Key>
  updateUserId(fromUserId: string, toUserId: string): Promise<void>
  delete(userId: string, provider: string): Promise<void>
}

export interface UserResourceRepository {
  findByUserId(userId: string): Promise<UserResource | null>
  create(resource: NewUserResource): Promise<UserResource>
  update(id: string, data: Partial<Omit<UserResource, 'id'>>): Promise<UserResource | null>
}

export interface SettingRepository {
  findByUserIdAndKey(userId: string, key: string): Promise<Setting | null>
  findByUserId(userId: string): Promise<Setting[]>
  upsert(setting: NewSetting): Promise<Setting>
}

export interface DeploymentRepository {
  findByTaskId(taskId: string): Promise<Deployment[]>
  findByTaskIdAndTypePath(taskId: string, type: string, path: string | null): Promise<Deployment | null>
  findByTaskIdAndUserId(taskId: string, userId: string): Promise<Deployment | null>
  create(deployment: NewDeployment): Promise<Deployment>
  update(id: string, data: Partial<Omit<Deployment, 'id'>>): Promise<Deployment | null>
  softDelete(id: string): Promise<void>
}

export interface AdminLogRepository {
  create(log: NewAdminLog): Promise<AdminLog>
  findByAdminUserId(adminUserId: string, limit?: number): Promise<AdminLog[]>
  findByTargetUserId(targetUserId: string, limit?: number): Promise<AdminLog[]>
  findAll(limit?: number, offset?: number): Promise<AdminLog[]>
}

// ─── Database Provider ──────────────────────────────────────────────────────

export interface DatabaseProvider {
  users: UserRepository
  localCredentials: LocalCredentialRepository
  tasks: TaskRepository
  connectors: ConnectorRepository
  miniprogramApps: MiniProgramAppRepository
  cronTasks: CronTaskRepository
  accounts: AccountRepository
  keys: KeyRepository
  userResources: UserResourceRepository
  settings: SettingRepository
  deployments: DeploymentRepository
  adminLogs: AdminLogRepository
}
