/**
 * BaseAgentRuntime
 *
 * 抽象基类：提供所有 runtime 共享的基础设施：
 * - Stateful sandbox lifecycle (provider acquire + workspace init)
 * - MCP client (stateful-mcp-client)
 * - System Prompt（buildAppendPrompt + getCodingSystemPrompt）
 * - PublishableKey 获取
 *
 * 子类只需实现 `runAgent(ctx, prompt, options)` —— 具体 agent 驱动逻辑。
 *
 * 使用模板方法模式：chatStream() 编排公共流程，调 runAgent() 做子类特定工作。
 * 但目前 CodeBuddyRuntime 因历史原因仍直接委托到 cloudbase-agent.service.ts，
 * 仅 OpencodeAcpRuntime 使用基类提供的 sandbox/MCP/systemPrompt 设施。
 * 未来 CodeBuddyRuntime 迁移后可直接在 runAgent 中使用。
 */

import type { AgentCallback, AgentCallbackMessage, AgentOptions } from '@coder/shared'
import type { ChatStreamResult, IAgentRuntime } from './types.js'
import type { ModelInfo } from '../cloudbase-agent.service.js'
import { buildStatefulAcquireContext } from '../../sandbox/acquire-context.js'
import { formatAgsManagerError, formatAgsUserFacingError } from '../../sandbox/ags-error.js'
import { getSandboxProvider } from '../../sandbox/index.js'
import type {
  SandboxInstance,
  SandboxProgressCallback,
  McpClientBundle,
  ToolOverrideConfig,
} from '../../sandbox/provider/types.js'
import { getDb } from '../../db/index.js'
import type { Task } from '../../db/types.js'
import { STATEFUL_WORKSPACE_ROOT, resolveSandboxConfig, backfillSandboxConfig } from '../../lib/sandbox-config.js'
import { getCodingSystemPrompt } from '../coding-mode.js'
import { decrypt } from '../../lib/crypto.js'
import { encryptJWE } from '../../lib/session.js'
import { sessionPermissions } from '../session-permissions.js'

// ─── Constants ─────────────────────────────────────────────────────────────

const HEALTH_MAX_RETRIES = 20
const HEALTH_INTERVAL_MS = 2000

/**
 * 需要用户确认的写操作工具集合。
 * 所有 runtime 共享此白名单（TencentSdk 的 canUseTool + OpenCode 的 requestPermission）。
 */
export const WRITE_TOOLS = new Set([
  'writeNoSqlDatabaseStructure',
  'writeNoSqlDatabaseContent',
  'executeWriteSQL',
  'modifyDataModel',
  'createFunction',
  'updateFunctionCode',
  'updateFunctionConfig',
  'invokeFunction',
])

// ─── Shared Helpers ────────────────────────────────────────────────────────

/**
 * 等待沙箱健康检查就绪（轮询 /health）
 */
export async function waitForSandboxHealth(
  sandbox: SandboxInstance,
  onProgress?: SandboxProgressCallback,
): Promise<boolean> {
  onProgress?.({ phase: 'wait_ready', message: '等待沙箱就绪...\n' })
  for (let i = 0; i < HEALTH_MAX_RETRIES; i++) {
    try {
      const res = await sandbox.request('/health', {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        return true
      }
    } catch {
      // 继续轮询
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  return false
}

/**
 * @deprecated Use SandboxProvider.prepare() (沙箱业务镜像 POST /api/workspace/init).
 * Kept for exports/tests; stateful path returns 沙箱业务镜像 workspace root immediately.
 */
export async function initSandboxWorkspace(
  sandbox: SandboxInstance,
  secret: { envId: string; secretId: string; secretKey: string; token?: string },
  _conversationId: string,
  preferredCwd?: string,
  onProgress?: SandboxProgressCallback,
): Promise<{ workspace: string; vitePort?: number }> {
  const fallbackWorkspace = preferredCwd || STATEFUL_WORKSPACE_ROOT
  onProgress?.({ phase: 'init_mcp', message: '初始化工作空间...\n' })

  try {
    const provider = getSandboxProvider()
    const prepared = await provider.prepare(
      sandbox,
      {
        credentials: {
          envId: secret.envId,
          secretId: secret.secretId,
          secretKey: secret.secretKey,
          sessionToken: secret.token,
        },
        workspaceHint: fallbackWorkspace,
        backendOptions: { backend: 'stateful' },
      },
      onProgress,
    )
    onProgress?.({ phase: 'ready', message: '沙箱已就绪\n' })
    return { workspace: prepared.workspace || STATEFUL_WORKSPACE_ROOT }
  } catch (e) {
    console.warn('[BaseRuntime] initSandboxWorkspace via workspace/init failed:', (e as Error).message)
    return { workspace: fallbackWorkspace }
  }
}

// ─── System Prompt ─────────────────────────────────────────────────────────

/**
 * 获取 CloudBase 前端 SDK 的 publishableKey
 */
const publishableKeyCache = new Map<string, string>()

export async function getPublishableKey(envId: string): Promise<string> {
  if (publishableKeyCache.has(envId)) return publishableKeyCache.get(envId)!

  const secretId = process.env.TCB_SECRET_ID
  const secretKey = process.env.TCB_SECRET_KEY
  if (!secretId || !secretKey || !envId) return ''
  try {
    const CloudBase = (await import('@cloudbase/manager-node')).default
    const manager = new CloudBase({
      secretId,
      secretKey,
      envId,
      proxy: process.env.http_proxy,
    })
    const result = await manager.commonService('tcb', '2018-06-08').call({
      Action: 'CreateApiKey',
      Param: { EnvId: envId, KeyType: 'publish_key' },
    })
    const apiKey = result?.ApiKey || result?.Response?.ApiKey || ''
    if (apiKey) {
      publishableKeyCache.set(envId, apiKey)
    }
    return apiKey
  } catch (e) {
    console.warn('[BaseRuntime] Failed to get publishableKey:', (e as Error).message)
    return ''
  }
}

export interface BuildAppendPromptOptions {
  /** CodeBuddy SDK session dir on the OpenVibeCoding 服务端主机 (not the user workspace). */
  localHostCwd?: string
  /** Bash/Read/Write/Glob/Grep are routed to the remote 沙箱业务镜像 sandbox. */
  remoteToolsActive?: boolean
}

function buildRemoteWorkspaceSection(
  sandboxCwd: string,
  conversationId: string | undefined,
  options?: BuildAppendPromptOptions,
): string {
  const localHostCwd = options?.localHostCwd?.trim()
  const remoteActive = options?.remoteToolsActive === true

  if (remoteActive) {
    const localLine = localHostCwd
      ? `- **本机 SDK 会话目录** \`${localHostCwd}\`：仅用于 CodeBuddy 落盘 JSONL，**不是**用户工作区。禁止把该路径、\`/tmp\`、\`/var/folders\`、\`openvibecoding-agent\` 说成「当前工作目录」。`
      : `- **本机 SDK 会话目录**：仅用于 CodeBuddy 落盘，**不是**用户工作区。禁止把 \`/tmp\`、\`/var/folders\`、\`openvibecoding-agent\` 说成「当前工作目录」。`
    return `
<remote-workspace priority="highest">
你已连接 **CloudBase 远程沙箱**（Stateful 沙箱业务镜像）。用户项目只存在于沙箱 VM 内。

- **远程工作区根目录**：\`${sandboxCwd}\` — 所有 Bash / Read / Write / Glob / Grep 在该 VM 上执行。
${localLine}
- 用户问 **pwd、当前目录、有哪些文件、统计文件数、目录结构、du/wc/find** 等：必须先调用 **Bash 或 Read/Glob** 在远程执行（例如 \`cd ${sandboxCwd} && pwd\`、\`cd ${sandboxCwd} && find . -type f | wc -l\`），**仅根据工具输出**回答。
- **禁止**根据 SDK \`cwd\`、进程环境或未调用工具时的猜测回答工作区路径。
- 若工具调用失败：说明沙箱/工具异常并请用户重试，**不要**编造本机临时目录。
</remote-workspace>`
  }

  return `
<remote-workspace>
远程沙箱尚未连接或工具 override 未就绪。不要声称自己已在 \`/home/user\` 或本机临时目录中工作。
若用户询问 pwd/文件列表：说明需等待沙箱就绪后再用 Bash 查询，勿用本机路径作答。
</remote-workspace>`
}

/**
 * 构建通用 system prompt（任务分类 + CloudBase 指引 + 沙箱上下文）
 */
export function buildAppendPrompt(
  sandboxCwd?: string,
  conversationId?: string,
  envId?: string,
  sandboxMode?: 'shared' | 'isolated',
  isCodingMode?: boolean,
  promptOptions?: BuildAppendPromptOptions,
): string {
  const roleLine = isCodingMode
    ? '你是一个通用 AI 编程助手，同时具备腾讯云开发（CloudBase）能力。'
    : '你是一个通用 AI 助手，同时具备腾讯云开发（CloudBase）能力，可按需通过工具操作云函数、数据库、存储、云托管等资源。'

  const taskClassificationSection = isCodingMode
    ? ''
    : `
<task-classification priority="highest">
收到任务后，先判断类型再决定是否使用工具：

1) **对话/创作/咨询类**（写文案、写文章、翻译、起名、解释概念、讨论观点、情绪陪伴、海报/帖子**文本**、小红书/朋友圈文案、社交媒体内容等）
   → 直接在对话中以**文本/Markdown**形式输出，**不要**写文件、不要部署、不要调用开发相关工具。
   → 即使用户说"帮我做一个 XX 应援贴/海报/宣传文案"，默认先理解为"输出文案"，除非用户明确要求"做一个页面/网站/应用"。
   → **例外**：如果用户明确说"生成一张图""帮我画一张 XX 图片""做一张海报图片"，使用 ImageGen 工具生成图片。

2) **编程/工程类**（修改代码、调试、构建应用、部署服务、配置云资源、运维操作）
   → 使用工具完成任务：读文件、写文件、执行命令、部署、调用云开发 MCP 等。

3) **自动化/定时类**（"每天…"、"每周…"、"定期…"）
   → 使用 cronTask 工具管理定时任务（见下面 cron-task 章节）。

4) **工作区探查类**（pwd、当前目录、列文件、统计文件数、目录树、du/wc/find/ls）
   → 必须使用 Bash / Read / Glob 在**远程沙箱**执行并据实回答；**禁止**用本机 SDK 临时目录或未调工具时的猜测作答。

**不确定时优先问用户**："你希望我直接写文案给你，还是做一个可访问的网页？"，不要擅自升级为 2)。
</task-classification>
`

  const base = `<role>
${roleLine}
默认使用中文与用户沟通；删除等破坏性操作需确认用户意图。
</role>
${taskClassificationSection}
<cloudbase-guideline>
- 当前云开发环境为 ${envId || '(未指定)'}，必要时可通过 cloudbase MCP 工具操作。
- **仅当用户明确要求部署、开发应用、操作数据库、上传文件等**，才使用云开发工具。纯文案/咨询不涉及此。
- 部署云函数使用 manageFunctions 工具；上传文件到静态托管使用 cloudbase_uploadFiles 工具。
</cloudbase-guideline>

<bash-usage>
对于耗时较长的命令（如 npm install、yarn install、大型项目构建等），如果执行超时：
1. 改为后台执行, 添加 run_in_background，可以获取 pid
2. 定期检查进程状态：ps aux | grep '<关键词>' | grep -v grep
3. 通过 BashOutput 结合 pid 查看输出结果
4. 也可以通过 KillShell 关闭后台执行的任务
</bash-usage>

<cron-task-usage>
当用户提到定时执行、定期运行、每天/每周/每小时执行某操作等需求时，必须使用 cronTask 工具来管理定时任务。
- 创建：action="create"，需要 name、prompt、cronExpression
- 查询：action="list"，查看当前所有定时任务
- 更新：action="update"，通过 id 修改已有任务（可改 prompt、cronExpression、enabled 等）
- 删除：action="delete"，通过 id 删除任务
Cron 表达式格式：分 时 日 月 周，例如 "0 20 * * *" 表示每天 20:00。
</cron-task-usage>

<tools-extra-info>
- **ImageGen** — AI 图片生成。Usage: 用户明确要求生成/绘制图片时（"帮我画一张…""生成一张…的图""做一张海报图片"）。生成的图片会同时保存到工作区和静态托管，返回可公开访问的 CDN 链接。
- **ImageEdit** — AI 图片编辑。Usage: 用户提供一张已有图片，要求修改风格、添加元素、局部重绘等。
</tools-extra-info>`

  if (sandboxCwd) {
    const homeDir =
      sandboxCwd === STATEFUL_WORKSPACE_ROOT || sandboxCwd.startsWith('/home/user')
        ? sandboxCwd
        : sandboxMode === 'isolated'
          ? sandboxCwd
          : sandboxCwd.substring(0, sandboxCwd.lastIndexOf('/'))
    const sandboxPreamble = isCodingMode
      ? ''
      : '（以下仅在你已判定任务属于"编程/工程类"或"工作区探查类"、决定动手写文件或执行命令时适用；纯对话/创作类任务请忽略本节。）\n'
    const remoteSection = buildRemoteWorkspaceSection(sandboxCwd, conversationId, promptOptions)
    return `${base}
${remoteSection}

<sandbox-context>
${sandboxPreamble}工具默认在 Home: ${homeDir} 下执行
为项目开辟工作目录为: ${sandboxCwd}
使用的云开发环境为: ${envId}
请注意：
- 所有文件读写、终端命令都应在工作目录中执行，注意 cd 到工作目录操作。
- 使用 cloudbase_uploadFiles 部署文件时，localPath 必须是容器内的**绝对路径**（即当前工作目录 ${sandboxCwd} 下的路径），例如 ${sandboxCwd}/index.html
- 如用户没有特别要求，cloudPath 需要为 ${conversationId}/xxx，即在当前会话路径下
- 不要使用相对路径给 cloudbase_uploadFiles
</sandbox-context>`
  }
  return base
}

// ─── RuntimeContext ────────────────────────────────────────────────────────

/**
 * 由 BaseAgentRuntime 在 chatStream 中构建，传给子类 runAgent()。
 * 包含所有已初始化的公共资源。
 */
export interface RuntimeContext {
  conversationId: string
  envId: string
  userId: string
  userCredentials?: { secretId: string; secretKey: string; sessionToken?: string }
  model: string
  mode: 'default' | 'coding'
  isCodingMode: boolean

  /** Stateful sandbox instance (null when sandbox disabled or unavailable) */
  sandbox: SandboxInstance | null
  /** 沙箱内工作目录路径 */
  sandboxCwd: string | null
  /** sandbox isolation mode */
  sandboxMode: 'shared' | 'isolated'
  /** sandbox session id */
  sandboxSessionId: string

  /** MCP client (stateful in-process server) for CloudBase tools */
  mcpClient: McpClientBundle | null

  /** 构建好的 system prompt（含沙箱上下文 + coding mode） */
  systemPrompt: string
  /** CloudBase publishableKey */
  publishableKey: string

  /** tool override config（沙箱 → agent SDK 工具路由） */
  toolOverrideConfig: { url: string; headers: Record<string, string> } | null
}

// ─── BaseAgentRuntime ──────────────────────────────────────────────────────

export abstract class BaseAgentRuntime implements IAgentRuntime {
  abstract readonly name: string
  abstract isAvailable(): Promise<boolean>
  abstract getSupportedModels(): Promise<ModelInfo[]>
  abstract chatStream(prompt: string, callback: AgentCallback | null, options: AgentOptions): Promise<ChatStreamResult>

  // ─── 公共设施方法（子类可在 runAgent 中调用） ────────────────────

  /**
   * Initialize sandbox: acquire stateful instance → workspace init → MCP client.
   *
   * @returns RuntimeContext 中与沙箱相关的字段
   */
  protected async setupSandbox(options: {
    conversationId: string
    envId: string
    userId: string
    userCredentials?: { secretId: string; secretKey: string; sessionToken?: string }
    isCodingMode: boolean
    callback?: AgentCallback | null
    model?: string
  }): Promise<{
    sandbox: SandboxInstance | null
    sandboxCwd: string | null
    sandboxMode: 'shared' | 'isolated'
    sandboxSessionId: string
    toolOverrideConfig: { url: string; headers: Record<string, string> } | null
    mcpClient: McpClientBundle | null
    /** Short-lived JWE session cookie for authenticating localhost requests (e.g. /cloudbase-mcp) */
    sessionJwe: string | null
  }> {
    const { conversationId, envId, userId, userCredentials, isCodingMode, callback, model } = options

    const sandboxEnabled = !!(process.env.TCB_ENV_ID && process.env.TCB_API_KEY)
    if (!sandboxEnabled || !envId) {
      return {
        sandbox: null,
        sandboxCwd: null,
        sandboxMode: 'shared',
        sandboxSessionId: envId || conversationId,
        toolOverrideConfig: null,
        mcpClient: null,
        sessionJwe: null,
      }
    }

    // Read sandbox config from task record
    let sandboxConfig = resolveSandboxConfig({ envId, taskId: conversationId })
    let taskRecord: Task | null = null
    try {
      taskRecord = await getDb().tasks.findById(conversationId)
      await backfillSandboxConfig(
        conversationId,
        { sandboxMode: taskRecord?.sandboxMode, sandboxCwd: taskRecord?.sandboxCwd },
        envId,
        getDb(),
      )
      taskRecord = await getDb().tasks.findById(conversationId)
      sandboxConfig = resolveSandboxConfig({
        sandboxCwd: taskRecord?.sandboxCwd,
        sandboxMode: taskRecord?.sandboxMode,
        envId,
        taskId: conversationId,
      })
    } catch {
      // Non-critical
    }

    const progressBridge: SandboxProgressCallback = ({ phase }) => {
      if (callback) {
        callback({ type: 'agent_phase', phase: 'preparing', phaseToolName: `sandbox:${phase}` })
      }
    }

    const provider = getSandboxProvider()
    let sandboxInstance: SandboxInstance | null = null
    let toolOverrideConfig: ToolOverrideConfig | null = null
    let mcpClient: McpClientBundle | null = null
    let detectedCwd: string | null = null
    let capturedSessionJwe: string | null = null

    try {
      sandboxInstance = await provider.acquire(
        buildStatefulAcquireContext({
          envId,
          taskId: conversationId,
          userId,
          sandboxMode: sandboxConfig.sandboxMode,
          sandboxId: taskRecord?.sandboxId,
        }),
        progressBridge,
      )

      let hosting: ToolOverrideConfig['hosting'] | undefined
      try {
        const user = await getDb().users.findById(userId)
        if (user) {
          const session = {
            created: Date.now(),
            authProvider: (user.provider || 'local') as 'github' | 'local' | 'cloudbase' | 'api-key',
            user: {
              id: user.id,
              username: user.username,
              email: user.email || undefined,
              avatar: user.avatarUrl || '',
              name: user.name || undefined,
            },
          }
          capturedSessionJwe = await encryptJWE(session, '2h')
          const serverPort = Number(process.env.PORT) || 3001
          hosting = {
            presignUrl: `http://localhost:${serverPort}/api/storage/presign?bucketType=static`,
            sessionCookie: capturedSessionJwe,
            sessionId: conversationId,
          }
        }
      } catch {
        // optional
      }

      toolOverrideConfig = await provider.getToolOverrideConfig(sandboxInstance, hosting)

      let prepared: Awaited<ReturnType<typeof provider.prepare>> | null = null
      try {
        prepared = await provider.prepare(
          sandboxInstance,
          {
            credentials: {
              envId,
              secretId: userCredentials?.secretId || '',
              secretKey: userCredentials?.secretKey || '',
              sessionToken: userCredentials?.sessionToken,
            },
            workspaceHint: sandboxConfig.sandboxCwd || STATEFUL_WORKSPACE_ROOT,
            codingMode: isCodingMode,
            backendOptions: { backend: 'stateful' },
          },
          progressBridge,
        )
      } catch {
        if (callback) {
          callback({ type: 'text', content: '沙箱启动超时，将使用受限模式继续对话。\n\n' })
        }
        sandboxInstance = null
      }

      if (sandboxInstance && prepared) {
        if (prepared.workspace) detectedCwd = prepared.workspace

        mcpClient = await provider.createMcpClient({
          sandbox: sandboxInstance,
          getCredentials: async () => ({
            cloudbaseEnvId: envId,
            secretId: userCredentials?.secretId || '',
            secretKey: userCredentials?.secretKey || '',
            sessionToken: userCredentials?.sessionToken,
          }),
          workspaceFolderPaths: detectedCwd || sandboxConfig.sandboxCwd,
          log: (msg) => console.log(msg),
          onArtifact: (artifact) => {
            if (callback) callback({ type: 'artifact', artifact })
            persistDeploymentFromArtifact(conversationId, artifact).catch((err) => {
              console.error('[BaseRuntime] Failed to persist deployment:', err)
            })
          },
          getMpDeployCredentials: async (appId: string) => {
            const app = await getDb().miniprogramApps.findByAppIdAndUserId(appId, userId)
            if (!app) return null
            return { appId: app.appId, privateKey: decrypt(app.privateKey) }
          },
          userId,
          currentModel: model,
        })

        try {
          await getDb().tasks.update(conversationId, {
            sandboxId: sandboxInstance.id,
            sandboxCwd: detectedCwd || sandboxConfig.sandboxCwd,
            sandboxMode: sandboxConfig.sandboxMode,
            updatedAt: Date.now(),
          })
        } catch {
          // non-critical
        }
      }
    } catch (err) {
      const detail = formatAgsManagerError(err, 'sandbox.acquire')
      const userDetail = formatAgsUserFacingError(err)
      console.error('[BaseRuntime] Sandbox creation failed:', detail)
      if (callback) {
        callback({
          type: 'text',
          content: `【沙箱环境创建失败】\n${userDetail}\n\n将使用受限模式继续对话。\n\n`,
        })
      }
    }

    return {
      sandbox: sandboxInstance,
      sandboxCwd: detectedCwd,
      sandboxMode: sandboxConfig.sandboxMode,
      sandboxSessionId: envId,
      toolOverrideConfig,
      mcpClient,
      sessionJwe: capturedSessionJwe,
    }
  }

  /**
   * 构建完整 system prompt（含 coding mode + 沙箱上下文）。
   */
  protected async buildSystemPrompt(options: {
    envId: string
    isCodingMode: boolean
    sandboxCwd: string | null
    sandboxMode: 'shared' | 'isolated'
    conversationId: string
    remoteToolsActive?: boolean
    localHostCwd?: string
  }): Promise<{ systemPrompt: string; publishableKey: string }> {
    const { envId, isCodingMode, sandboxCwd, sandboxMode, conversationId, remoteToolsActive, localHostCwd } = options
    const publishableKey = await getPublishableKey(envId)
    const appendOpts: BuildAppendPromptOptions = {
      remoteToolsActive,
      localHostCwd,
    }
    const cwdForPrompt = sandboxCwd || undefined

    let systemPrompt: string
    if (isCodingMode) {
      systemPrompt =
        getCodingSystemPrompt(envId, publishableKey) +
        '\n\n' +
        buildAppendPrompt(cwdForPrompt, conversationId, envId, sandboxMode, true, appendOpts)
    } else {
      systemPrompt = buildAppendPrompt(cwdForPrompt, conversationId, envId, sandboxMode, false, appendOpts)
    }

    return { systemPrompt, publishableKey }
  }

  /**
   * Coding mode: 标记 preview ready。
   */
  protected async markCodingPreviewReady(conversationId: string, sandbox: SandboxInstance | null): Promise<void> {
    if (!sandbox) return
    try {
      const taskRecord = await getDb().tasks.findById(conversationId)
      if (!taskRecord?.previewUrl) {
        await getDb().tasks.update(conversationId, { previewUrl: 'ready' })
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Coding mode: 自动放行所有写工具。
   */
  protected allowAllWriteToolsForCodingMode(conversationId: string): void {
    for (const tool of WRITE_TOOLS) {
      sessionPermissions.allowAlways(conversationId, tool)
    }
  }
}

// ─── Artifact Helpers（所有 runtime 共用） ─────────────────────────────────

import { nanoid } from 'nanoid'

/**
 * 从 artifact 事件中持久化部署记录到 DB。
 * 所有 runtime 收到 type='artifact' 的回调时都应调用此函数。
 */
export async function persistDeploymentFromArtifact(
  taskId: string,
  artifact: NonNullable<AgentCallbackMessage['artifact']>,
): Promise<void> {
  const now = Date.now()
  const meta = artifact.metadata || {}
  const deploymentType = (meta.deploymentType as string) || (artifact.contentType === 'link' ? 'web' : 'miniprogram')
  const metadataJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null

  if (deploymentType === 'miniprogram') {
    const qrCodeUrl = artifact.contentType === 'image' ? artifact.data : (meta.qrCodeUrl as string) || null
    const pagePath = (meta.pagePath as string) || null
    const appId = (meta.appId as string) || null
    const label = artifact.title || null

    const existing = await getDb().deployments.findByTaskIdAndTypePath(taskId, 'miniprogram', null)

    if (existing) {
      await getDb().deployments.update(existing.id, {
        qrCodeUrl: qrCodeUrl || existing.qrCodeUrl,
        pagePath: pagePath || existing.pagePath,
        appId: appId || existing.appId,
        label: label || existing.label,
        metadata: metadataJson || existing.metadata,
        updatedAt: now,
      })
    } else {
      await getDb().deployments.create({
        id: nanoid(12),
        taskId,
        type: 'miniprogram',
        url: null,
        path: null,
        qrCodeUrl,
        pagePath,
        appId,
        label,
        metadata: metadataJson,
        createdAt: now,
        updatedAt: now,
      })
    }
  } else if (artifact.contentType === 'link' && artifact.data) {
    const url = artifact.data
    let urlPath: string | null = null
    try {
      const urlObj = new URL(url)
      urlPath = urlObj.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/'
    } catch {
      /* ignore */
    }

    if (urlPath) {
      const existing = await getDb().deployments.findByTaskIdAndTypePath(taskId, 'web', urlPath)

      if (existing) {
        await getDb().deployments.update(existing.id, {
          url,
          label: artifact.title || existing.label,
          metadata: metadataJson || existing.metadata,
          updatedAt: now,
        })
      } else {
        await getDb().deployments.create({
          id: nanoid(12),
          taskId,
          type: 'web',
          url,
          path: urlPath,
          qrCodeUrl: null,
          pagePath: null,
          appId: null,
          label: artifact.title || null,
          metadata: metadataJson,
          createdAt: now,
          updatedAt: now,
        })
      }
    }

    // Also update legacy previewUrl for backward compatibility
    try {
      await getDb().tasks.update(taskId, { previewUrl: url })
    } catch {
      // Non-critical
    }
  } else {
    // Other artifact types (json, image without miniprogram context, etc.)
    await getDb().deployments.create({
      id: nanoid(12),
      taskId,
      type: deploymentType as 'web' | 'miniprogram',
      url: artifact.contentType === 'link' ? artifact.data : null,
      path: null,
      qrCodeUrl: artifact.contentType === 'image' ? artifact.data : null,
      pagePath: null,
      appId: null,
      label: artifact.title || null,
      metadata: metadataJson,
      createdAt: now,
      updatedAt: now,
    })
  }
}

/**
 * 从 uploadFiles 工具结果 JSON 中递归提取 CloudBase 部署 URL。
 * 纯函数，支持 accessUrl / staticDomain 字段，最多递归 5 层。
 */
export function extractDeployUrl(rawText: string, isFile = false, depth = 0): string | null {
  if (depth > 5) return null
  try {
    const parsed = JSON.parse(rawText)

    if (Array.isArray(parsed)) {
      const firstText = parsed[0]?.text
      if (typeof firstText === 'string') {
        return extractDeployUrl(firstText, isFile, depth + 1)
      }
      return null
    }

    if (typeof parsed !== 'object' || parsed === null) return null

    if (parsed.accessUrl) {
      const url = new URL(parsed.accessUrl)
      if (!isFile && url.pathname !== '/' && !url.pathname.endsWith('/')) {
        url.pathname += '/'
      }
      if (!url.searchParams.get('t')) {
        url.searchParams.set('t', String(Date.now()))
      }
      return url.toString()
    }
    if (parsed.staticDomain) return `https://${parsed.staticDomain}/?t=${Date.now()}`

    const innerText = parsed?.res?.content?.[0]?.text || parsed?.content?.[0]?.text
    if (typeof innerText === 'string') {
      return extractDeployUrl(innerText, isFile, depth + 1)
    }
  } catch {
    // JSON parse 失败，忽略
  }
  return null
}
