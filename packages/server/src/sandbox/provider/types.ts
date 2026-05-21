/**
 * Stateful sandbox provider types (feature/stateful-infra branch).
 */

export type SandboxBackend = 'stateful'

export interface SandboxProgressMessage {
  phase: string
  message: string
}

export type SandboxProgressCallback = (m: SandboxProgressMessage) => void

export interface AcquireContext {
  envId: string
  conversationId: string
  backendOptions?: StatefulAcquireOptions
  meta?: Record<string, unknown>
}

export interface PrepareContext {
  credentials: {
    envId: string
    secretId: string
    secretKey: string
    sessionToken?: string
  }
  workspaceHint?: string
  codingMode?: boolean
  backendOptions?: StatefulPrepareOptions
  meta?: Record<string, unknown>
}

export interface ReleaseContext {
  conversationId: string
  prompt?: string
  reason: 'completed' | 'cancelled' | 'error'
  backendOptions?: StatefulReleaseOptions
  meta?: Record<string, unknown>
}

export interface DeleteConversationContext {
  envId: string
  conversationId: string
  sandboxCwd?: string
  sandboxMode?: 'shared' | 'isolated'
}

export interface StatefulAcquireOptions {
  backend: 'stateful'
  /** shared = one AGS instance per envId; isolated = one instance per task (conversationId). */
  sandboxMode?: 'shared' | 'isolated'
}

export interface StatefulPrepareOptions {
  backend: 'stateful'
}

export interface StatefulReleaseOptions {
  backend: 'stateful'
  flushSnapshot?: boolean
}

export type BackendAcquireOptions = StatefulAcquireOptions
export type BackendPrepareOptions = StatefulPrepareOptions
export type BackendReleaseOptions = StatefulReleaseOptions

export interface SessionEnv {
  workspace: string
  vitePort?: number
  meta?: Record<string, unknown>
}

export interface McpConfig {
  type: 'sse' | 'http'
  url: string
  headers?: Record<string, string | undefined>
  credential?: Record<string, string>
}

export interface SandboxInstance {
  readonly backend: SandboxBackend
  readonly id: string
  readonly templateId: string
  readonly baseUrl: string
  readonly meta: Record<string, unknown>
  readonly mcpConfig?: McpConfig
  getAuthHeaders(): Promise<Record<string, string>>
  request(path: string, opts?: RequestInit): Promise<Response>
}

export interface McpDeps {
  sandbox: SandboxInstance
  getCredentials: () => Promise<{
    cloudbaseEnvId: string
    secretId: string
    secretKey: string
    sessionToken?: string
  }>
  bashTimeoutMs?: number
  workspaceFolderPaths?: string
  log?: (msg: string) => void
  onArtifact?: (artifact: {
    title: string
    contentType: 'image' | 'link' | 'json'
    data: string
    metadata?: Record<string, unknown>
  }) => void
  getMpDeployCredentials?: (appId: string) => Promise<{ appId: string; privateKey: string } | null>
  userId?: string
  currentModel?: string
}

export interface MinimalMcpClient {
  callTool(req: { name: string; arguments?: unknown }): Promise<{ content?: unknown; isError?: boolean } | unknown>
  listTools?(): Promise<unknown>
  close?(): Promise<void>
}

export interface McpClientBundle {
  client: MinimalMcpClient
  server: unknown
  sdkServer: unknown
  close: () => Promise<void>
}

export interface ToolOverrideHosting {
  presignUrl: string
  sessionCookie: string
  sessionId: string
}

export interface ToolOverrideConfig {
  url: string
  headers: Record<string, string>
  modulePath: string
  hosting?: ToolOverrideHosting
}

export interface SandboxProvider {
  readonly backend: SandboxBackend
  acquire(ctx: AcquireContext, onProgress?: SandboxProgressCallback): Promise<SandboxInstance>
  prepare(inst: SandboxInstance, ctx: PrepareContext, onProgress?: SandboxProgressCallback): Promise<SessionEnv>
  release(inst: SandboxInstance, ctx: ReleaseContext): Promise<void>
  createMcpClient(deps: McpDeps): Promise<McpClientBundle>
  getToolOverrideConfig(inst: SandboxInstance, hosting?: ToolOverrideHosting): Promise<ToolOverrideConfig>
  getPreviewBaseUrl(inst: SandboxInstance): Promise<string>
  getExisting?(ctx: AcquireContext): Promise<SandboxInstance | null>
  destroy?(inst: SandboxInstance): Promise<void>
  deleteConversation?(inst: SandboxInstance, ctx: DeleteConversationContext): Promise<void>
}
