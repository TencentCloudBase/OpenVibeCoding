import { mkdirSync, appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, ExecutionError } from '@tencent-ai/agent-sdk'
import { z } from 'zod'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { v4 as uuidv4 } from 'uuid'
import { loadConfig } from '../config/store.js'
import { persistenceService } from './persistence.service.js'
import { scfSandboxManager, type SandboxInstance } from '../sandbox/scf-sandbox-manager.js'
import { createSandboxMcpClient } from '../sandbox/sandbox-mcp-proxy.js'
import { archiveToGit } from '../sandbox/git-archive.js'
import { initCodingProject, startDevServer, getCodingSystemPrompt } from './coding-mode.js'
import { getDb } from '../db/index.js'
import { nanoid } from 'nanoid'
import { decrypt } from '../lib/crypto.js'
import type { AgentCallbackMessage, AgentOptions, CodeBuddyMessage, ExtendedSessionUpdate } from '@coder/shared'
import { registerAgent, getAgentRun, completeAgent, removeAgent, isAgentRunning } from './agent-registry.js'
import { EventBuffer } from './event-buffer.js'

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'glm-5.0'
const OAUTH_TOKEN_ENDPOINT = 'https://copilot.tencent.com/oauth2/token'
const CONNECT_TIMEOUT_MS = 60_000
const ITERATION_TIMEOUT_MS = 45 * 1000
const HEALTH_MAX_RETRIES = 20
const HEALTH_INTERVAL_MS = 2000

// ─── Supported Models Cache ───────────────────────────────────────────────

export interface ModelInfo {
  id: string
  name: string
  vendor?: string
  credits?: string
  supportsImages?: boolean
  supportsReasoning?: boolean
  supportsToolCall?: boolean
  tags?: string[]
  [key: string]: any
}

let cachedModels: ModelInfo[] | null = null

// Static model list (temporary, replace with dynamic fetch when ready)
const STATIC_MODELS: ModelInfo[] = [
  { id: 'minimax-m2.5', name: 'MiniMax-M2.5' },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
  { id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking' },
  { id: 'glm-5.0', name: 'GLM-5.0' },
  { id: 'glm-4.7', name: 'GLM-4.7' },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2' },
]

// Dynamic model fetch from SDK (reserved for future use)
async function fetchSupportedModels(): Promise<ModelInfo[]> {
  try {
    const q = query({ prompt: '', options: { permissionMode: 'bypassPermissions' } })
    const models = await q.supportedModels()
    q.return?.()
    if (Array.isArray(models) && models.length > 0) {
      return models.map((m: any) =>
        typeof m === 'string'
          ? { id: m, name: m }
          : { id: m.id || m.name || DEFAULT_MODEL, name: m.name || m.id || DEFAULT_MODEL, ...m },
      )
    }
  } catch (e) {
    console.warn('[Agent] Failed to fetch supported models from SDK:', e)
  }
  return [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }]
}

export async function getSupportedModels(): Promise<ModelInfo[]> {
  if (cachedModels) return cachedModels
  // TODO: switch to dynamic fetch when SDK is ready
  // cachedModels = await fetchSupportedModels()
  cachedModels = STATIC_MODELS
  return cachedModels
}

// ─── Sandbox Helpers ──────────────────────────────────────────────────────

/**
 * 等待沙箱健康检查就绪（轮询 /health）
 */
async function waitForSandboxHealth(sandbox: SandboxInstance, callback: AgentCallback): Promise<boolean> {
  for (let i = 0; i < HEALTH_MAX_RETRIES; i++) {
    try {
      const res = await sandbox.request('/health', {
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        console.log('[Agent] Sandbox health check passed')
        return true
      }
    } catch {
      // 继续轮询
    }
    if (i === 0) {
      callback({ type: 'text', content: '正在等待工作空间就绪...\n' })
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  return false
}

/**
 * 初始化沙箱工作空间：POST /api/session/init 注入凭证和环境变量
 * 然后创建会话工作目录
 * 返回容器内的工作目录路径（可能为 undefined）
 */
async function initSandboxWorkspace(
  sandbox: SandboxInstance,
  secret: { envId: string; secretId: string; secretKey: string; token?: string },
  conversationId: string,
): Promise<string | undefined> {
  try {
    const res = await sandbox.request('/api/session/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        env: {
          CLOUDBASE_ENV_ID: secret.envId,
          TENCENTCLOUD_SECRETID: secret.secretId,
          TENCENTCLOUD_SECRETKEY: secret.secretKey,
          ...(secret.token ? { TENCENTCLOUD_SESSIONTOKEN: secret.token } : {}),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (res.ok) {
      const workspace = `/tmp/workspace/${secret.envId}/${conversationId}`
      console.log('[Agent] initSandboxWorkspace success, workspace:', workspace)

      // 创建会话工作目录
      const mkdirRes = await sandbox.request('/api/tools/bash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: `mkdir -p "${workspace}"`,
          timeout: 5000,
        }),
        signal: AbortSignal.timeout(10_000),
      })

      if (mkdirRes.ok) {
        console.log('[Agent] Workspace directory created:', workspace)
      }

      return workspace
    }
    console.error('[Agent] initSandboxWorkspace failed, status:', res.status)
  } catch (e) {
    console.error('[Agent] initSandboxWorkspace error:', (e as Error).message)
  }
  return undefined
}

/**
 * 需要用户确认的写操作 MCP 工具集合。
 * canUseTool 中对这些工具发起 interrupt，等待客户端确认后再执行。
 * 可通过 bypassToolConfirmation=true 跳过确认。
 */
const WRITE_TOOLS = true
  ? new Set([])
  : new Set([
      // 数据库相关 (4个)
      'writeNoSqlDatabaseStructure', // 修改 NoSQL 数据库结构
      'writeNoSqlDatabaseContent', // 修改 NoSQL 数据库内容
      'executeWriteSQL', // 执行写入 SQL
      'modifyDataModel', // 修改数据模型

      // 云函数相关 (7个)
      'createFunction', // 创建云函数
      'updateFunctionCode', // 更新云函数代码
      'updateFunctionConfig', // 更新云函数配置
      'invokeFunction', // 调用云函数
      'manageFunctionTriggers', // 管理云函数触发器
      'writeFunctionLayers', // 管理云函数层
      'createFunctionHTTPAccess', // 创建云函数 HTTP 访问

      // 存储相关 (2个) - uploadFiles 不拦截（静态托管部署需要）
      'deleteFiles', // 删除文件
      'manageStorage', // 管理云存储

      // 其他 (5个)
      'domainManagement', // 域名管理
      'interactiveDialog', // 交互式对话
      'manageCloudRun', // 管理云托管
      'writeSecurityRule', // 写入安全规则
      'activateInviteCode', // 激活邀请码
      'callCloudApi', // 调用云 API
    ])

// ─── Types ─────────────────────────────────────────────────────────────────

interface ToolCallInfo {
  name: string
  input: unknown
  inputJson: string
}

interface ToolCallTracker {
  pendingToolCalls: Map<string, ToolCallInfo>
  blockIndexToToolId: Map<number, string>
  toolInputJsonBuffers: Map<string, string>
}

type AgentCallback = (message: AgentCallbackMessage) => void | Promise<void>

// ─── OAuth Token Cache ────────────────────────────────────────────────────

let cachedToken: { token: string; expiry: number } | null = null

/**
 * 通过 OAuth2 client_credentials 获取 auth token
 * 参考 tcb-headless-service getOAuthToken 实现
 */
async function getOAuthToken(): Promise<string> {
  // 检查缓存
  if (cachedToken && Date.now() < cachedToken.expiry) {
    return cachedToken.token
  }

  const clientId = process.env.CODEBUDDY_CLIENT_ID
  const clientSecret = process.env.CODEBUDDY_CLIENT_SECRET
  const endpoint = process.env.CODEBUDDY_OAUTH_ENDPOINT || OAUTH_TOKEN_ENDPOINT

  if (!clientId || !clientSecret) {
    throw new Error('Missing CODEBUDDY_CLIENT_ID or CODEBUDDY_CLIENT_SECRET environment variables')
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(`OAuth token request failed: ${response.status}`)
  }

  const data = (await response.json()) as { access_token: string; expires_in: number }
  if (!data.access_token) {
    throw new Error('OAuth2 response missing access_token')
  }

  const token = data.access_token
  const expiresIn = data.expires_in || 3600
  // 提前 60 秒过期，避免边界问题
  const expiry = Date.now() + expiresIn * 1000 - 60000

  cachedToken = { token, expiry }

  return token
}

// ─── Helper Functions ──────────────────────────────────────────────────────

function createToolCallTracker(): ToolCallTracker {
  return {
    pendingToolCalls: new Map(),
    blockIndexToToolId: new Map(),
    toolInputJsonBuffers: new Map(),
  }
}

/**
 * Get the path to the tool-override module for injection
 */
function getToolOverridePath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  // In dev: __dirname = src/agent/ → ../../dist/sandbox/tool-override.cjs
  // In prod (bundled): __dirname = dist/ → ./sandbox/tool-override.cjs
  const devPath = path.resolve(__dirname, '../../dist/sandbox/tool-override.cjs')
  const prodPath = path.resolve(__dirname, 'sandbox/tool-override.cjs')
  return existsSync(prodPath) ? prodPath : devPath
}

/**
 * Get the path to the skill-loader-override module for injection
 */
function getSkillLoaderOverridePath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  // In dev: __dirname = src/agent/ → ../../dist/util/skill-loader-override.cjs
  // In prod (bundled): __dirname = dist/ → ./util/skill-loader-override.cjs
  const devPath = path.resolve(__dirname, '../../dist/util/skill-loader-override.cjs')
  const prodPath = path.resolve(__dirname, 'util/skill-loader-override.cjs')
  return existsSync(prodPath) ? prodPath : devPath
}

/**
 * Get the path to the bundled skills directory
 */
function getBundledSkillsDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  // In dev: __dirname = src/agent/ → ../../skills/
  // In prod (bundled): __dirname = dist/ → ../skills/
  const devPath = path.resolve(__dirname, '../../skills')
  const prodPath = path.resolve(__dirname, '../skills')
  return existsSync(prodPath) ? prodPath : devPath
}

// ─── System Prompt Builder ─────────────────────────────────────────────────

function buildAppendPrompt(sandboxCwd?: string, conversationId?: string, envId?: string): string {
  const base = `你是一个通用 AI 编程助手，同时具备腾讯云开发（CloudBase）能力，可通过工具操作云函数、数据库、存储、云托管等资源。
优先使用工具完成任务；删除等破坏性操作需确认用户意图。
默认使用中文与用户沟通。

Bash 超时处理策略：对于耗时较长的命令（如 npm install、yarn install、大型项目构建等），如果执行超时：
1. 改为后台执行, 添加 run_in_background，可以获取 pid
2. 定期检查进程状态：ps aux | grep '<关键词>' | grep -v grep
3. 通过 BashOutput 结合 pid 查看输出结果
4. 也可以通过 KillShell 关闭后台执行的任务

${
  false
    ? `小程序开发规则：
当用户的需求涉及微信小程序开发（创建、修改、部署小程序项目）时：
1. 必须先使用 AskUserQuestion 工具获取用户的微信小程序 appId
   - options 的第一个选项的 label 必须固定为 "ask:miniprogram_appid"（系统据此识别问题类别并替换为预置内容）
   - 其余字段可任意填写，系统会自动替换为标准问题
   - 示例: AskUserQuestion({ questions: [{ question: "选择小程序", header: "AppId", options: [{ label: "ask:miniprogram_appid", description: "选择小程序" }, { label: "跳过", description: "跳过" }], multiSelect: false }] })
2. 获取到 appId 后，在生成 project.config.json 时使用该 appId
3. 在调用 publishMiniprogram 部署前，确保已获取到有效的 appId`
    : ''
}

定时任务规则：
当用户提到定时执行、定期运行、每天/每周/每小时执行某操作等需求时，必须使用 cronTask 工具来管理定时任务。
- 创建：action="create"，需要 name、prompt、cronExpression
- 查询：action="list"，查看当前所有定时任务
- 更新：action="update"，通过 id 修改已有任务（可改 prompt、cronExpression、enabled 等）
- 删除：action="delete"，通过 id 删除任务
Cron 表达式格式：分 时 日 月 周，例如 "0 20 * * *" 表示每天 20:00。`

  if (sandboxCwd) {
    return `${base}
工具默认在 Home: /tmp/workspace/${envId} 下执行
为项目开辟工作目录为: ${sandboxCwd}
使用的云开发环境为: ${envId}
请注意：
- 所有文件读写、终端命令都应在工作目录中执行，注意 cd 到工作目录操作。
- 使用 cloudbase_uploadFiles 部署文件时，localPath 必须是容器内的**绝对路径**（即当前工作目录 ${sandboxCwd} 下的路径），例如 ${sandboxCwd}/index.html
- 如用户没有特别要求，cloudPath 需要为 ${conversationId}，即在当前会话路径下
- 不要使用相对路径给 cloudbase_uploadFiles`
  }
  return base
}

// ─── CloudbaseAgentService ─────────────────────────────────────────────────

export class CloudbaseAgentService {
  /**
   * 将内部 AgentCallbackMessage 转换为 ACP ExtendedSessionUpdate 格式
   */
  public static convertToSessionUpdate(msg: AgentCallbackMessage, sessionId: string): ExtendedSessionUpdate | null {
    if (msg.type === 'text' && msg.content) {
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: msg.content },
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'thinking' && msg.content) {
      return {
        sessionUpdate: 'thinking',
        content: msg.content,
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'tool_use') {
      return {
        sessionUpdate: 'tool_call',
        toolCallId: msg.id || '',
        title: msg.name || 'tool',
        kind: 'function',
        status: 'in_progress',
        input: msg.input,
        assistantMessageId: msg.assistantMessageId,
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'tool_input_update') {
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: msg.id || '',
        status: 'in_progress',
        input: msg.input,
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'tool_result') {
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: msg.tool_use_id || '',
        status: msg.is_error ? 'failed' : 'completed',
        result: msg.content,
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'error') {
      return {
        sessionUpdate: 'log',
        level: 'error',
        message: msg.content || 'Unknown error',
        timestamp: Date.now(),
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'artifact' && msg.artifact) {
      return {
        sessionUpdate: 'artifact',
        artifact: msg.artifact,
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'ask_user') {
      return {
        sessionUpdate: 'ask_user',
        toolCallId: msg.id || '',
        assistantMessageId: msg.assistantMessageId || '',
        questions: (msg.input as any)?.questions || [],
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'tool_confirm') {
      return {
        sessionUpdate: 'tool_confirm',
        toolCallId: msg.id || '',
        assistantMessageId: msg.assistantMessageId || '',
        toolName: msg.name || '',
        input: (msg.input as Record<string, unknown>) || {},
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'result') {
      // result events are not streamed as session updates
      return null
    }
    return null
  }

  /**
   * 启动 agent 执行。检查是否已有正在运行的 agent。
   * 如果已在运行，返回 { turnId, alreadyRunning: true }。
   * 否则在后台启动 agent，立即返回 { turnId, alreadyRunning: false }。
   */
  async chatStream(
    prompt: string,
    callback: AgentCallback | null,
    options: AgentOptions = {},
  ): Promise<{ turnId: string; alreadyRunning: boolean }> {
    const conversationId = options.conversationId || uuidv4()

    // Check if agent is already running
    if (isAgentRunning(conversationId)) {
      const run = getAgentRun(conversationId)!
      return { turnId: run.turnId, alreadyRunning: true }
    }

    // Compute turnId (assistantMessageId) upfront for the registry
    const turnId = await this.computeTurnId(conversationId, options)

    // Register in agent registry
    registerAgent({
      conversationId,
      turnId,
      envId: options.envId || '',
      userId: options.userId || 'anonymous',
      abortController: new AbortController(),
    })

    // Launch agent in background (fire-and-forget)
    this.launchAgent(prompt, callback, options, turnId).catch((err) => {
      console.error('[Agent] Background agent error:', err)
    })

    return { turnId, alreadyRunning: false }
  }

  /**
   * 计算本轮的 turnId (assistantMessageId)
   */
  private async computeTurnId(conversationId: string, options: AgentOptions): Promise<string> {
    const { askAnswers, toolConfirmation, envId, userId } = options
    const isResumeFromInterrupt = (askAnswers && Object.keys(askAnswers).length > 0) || !!toolConfirmation

    if (isResumeFromInterrupt && conversationId && envId) {
      const record = await persistenceService.getLatestRecordStatus(conversationId, userId || 'anonymous', envId)
      if (record) return record.recordId
    }
    return uuidv4()
  }

  /**
   * 后台执行 agent，包含完整的消息历史恢复、沙箱管理、SDK 调用、持久化等逻辑。
   */
  private async launchAgent(
    prompt: string,
    liveCallback: AgentCallback | null,
    options: AgentOptions = {},
    assistantMessageId: string,
  ): Promise<void> {
    const {
      conversationId = uuidv4(),
      envId,
      userId,
      userCredentials,
      maxTurns = 100,
      cwd,
      askAnswers,
      toolConfirmation,
      model,
      mode,
    } = options
    const modelId = model || DEFAULT_MODEL
    const isCodingMode = mode === 'coding'

    const userContext = { envId: envId || '', userId: userId || 'anonymous' }

    // Read sandbox config from task record (written at creation time)
    // Historical tasks missing these fields are backfilled as 'shared' mode
    let taskSandboxMode: string | null = null
    let taskSandboxSessionId: string | null = null
    let taskSandboxCwd: string | null = null
    try {
      const taskRecord = await getDb().tasks.findById(conversationId)
      taskSandboxMode = taskRecord?.sandboxMode || null
      taskSandboxSessionId = taskRecord?.sandboxSessionId || null
      taskSandboxCwd = taskRecord?.sandboxCwd || null

      // Backfill missing sandbox config for historical tasks (default to 'shared')
      if (!taskSandboxMode || !taskSandboxSessionId || !taskSandboxCwd) {
        taskSandboxMode = taskSandboxMode || 'shared'
        taskSandboxSessionId =
          taskSandboxSessionId || (taskSandboxMode === 'shared' ? userContext.envId : conversationId)
        taskSandboxCwd =
          taskSandboxCwd ||
          (taskSandboxMode === 'shared'
            ? `/tmp/workspace/${userContext.envId}/${conversationId}`
            : `/tmp/workspace/${conversationId}`)
        await getDb().tasks.update(conversationId, {
          sandboxMode: taskSandboxMode as 'shared' | 'isolated',
          sandboxSessionId: taskSandboxSessionId,
          sandboxCwd: taskSandboxCwd,
          updatedAt: Date.now(),
        })
      }
    } catch {
      // Non-critical
    }

    const sandboxMode = taskSandboxMode || (process.env.WORKSPACE_ISOLATION === 'isolated' ? 'isolated' : 'shared')
    const sandboxSessionId = taskSandboxSessionId || (sandboxMode === 'shared' ? userContext.envId : conversationId)
    const defaultCwd =
      sandboxMode === 'shared'
        ? `/tmp/workspace/${userContext.envId}/${conversationId}`
        : `/tmp/workspace/${conversationId}`

    const actualCwd = cwd || taskSandboxCwd || defaultCwd
    mkdirSync(actualCwd, { recursive: true })

    // ── 创建 EventBuffer 用于持久化 ACP 事件 ─────────────────────────
    const eventBuffer = new EventBuffer(conversationId, assistantMessageId, userContext.envId, userContext.userId)

    // ── 从 DB 恢复消息历史 ────────────────────────────────────────────
    let historicalMessages: CodeBuddyMessage[] = []
    let lastRecordId: string | null = null
    let hasHistory = false
    let sandboxMcpClient: Awaited<ReturnType<typeof createSandboxMcpClient>> | null = null

    // askAnswers / toolConfirmation 场景标记为 resume
    const isResumeFromInterrupt = (askAnswers && Object.keys(askAnswers).length > 0) || !!toolConfirmation

    if (conversationId && userContext.envId) {
      // Resume + askAnswers 场景：先直接更新 DB，再 restore 即可拿到最新数据
      // 新结构：askAnswers[messageId] = { toolCallId, answers }，用 toolCallId 作为 callId
      if (askAnswers && Object.keys(askAnswers).length > 0) {
        for (const [recordId, { toolCallId, answers }] of Object.entries(askAnswers)) {
          const output = {
            type: 'text',
            text: Object.entries(answers)
              .map(([key, value]) => ` · ${key} → ${value}`)
              .join('\n'),
          }
          await persistenceService.updateToolResult(conversationId, recordId, toolCallId, output, 'completed')
          if (recordId !== assistantMessageId) {
            await persistenceService.updateToolResult(
              conversationId,
              assistantMessageId,
              toolCallId,
              output,
              'completed',
            )
          }
        }
      }

      // Resume + toolConfirmation 场景：处理用户确认结果
      if (toolConfirmation) {
        const isAllowed = toolConfirmation.payload.action === 'allow'

        if (isAllowed && sandboxMcpClient) {
          // allow: 通过 MCP client 调用工具获取真实结果
          const mcpClient = sandboxMcpClient.client
          const toolCallInfo = await persistenceService.getToolCallInfo(
            conversationId,
            assistantMessageId,
            toolConfirmation.interruptId,
          )

          if (toolCallInfo) {
            const normalizedToolName = toolCallInfo.toolName.startsWith('mcp__')
              ? toolCallInfo.toolName.split('__').slice(2).join('__') || toolCallInfo.toolName
              : toolCallInfo.toolName

            try {
              // 通过 MCP client 调用工具
              const res = (await mcpClient.callTool({
                name: normalizedToolName,
                arguments: toolCallInfo.input,
              })) as { content?: Record<string, unknown> }
              const toolResult: Record<string, unknown> = res.content || { result: res }
              await persistenceService.updateToolResult(
                conversationId,
                assistantMessageId,
                toolConfirmation.interruptId,
                {
                  type: 'text',
                  text: JSON.stringify(toolResult),
                },
                'completed',
              )
            } catch (err) {
              // 工具执行失败，记录错误
              const errorResult = {
                error: true,
                message: (err as Error).message || '工具执行失败',
              }
              await persistenceService.updateToolResult(
                conversationId,
                assistantMessageId,
                toolConfirmation.interruptId,
                {
                  type: 'text',
                  text: JSON.stringify(errorResult),
                },
                'error',
              )
            }
          }
        } else {
          // deny 或无 MCP client: 更新为拒绝消息
          await persistenceService.updateToolResult(
            conversationId,
            assistantMessageId,
            toolConfirmation.interruptId,
            {
              type: 'text',
              text: '用户拒绝了此操作',
            },
            'completed',
          )
        }
      }

      // 从 DB 恢复消息历史（askAnswers / toolConfirmation 场景下 DB 已是最新）
      const restored = await persistenceService.restoreMessages(
        conversationId,
        userContext.envId,
        userContext.userId,
        actualCwd,
      )
      historicalMessages = restored.messages
      lastRecordId = restored.lastRecordId
      hasHistory = historicalMessages.length > 0

      // resume interrupt 场景下，即使 DB 中无历史，
      // 只要有 conversationId 就强制走 resume 路径
      if (!hasHistory && isResumeFromInterrupt) {
        hasHistory = true
      }
    }

    // ── 预保存 pending 记录 ──────────────────────────────────────────
    // resume 场景跳过预保存（assistant 记录已存在）
    let preSavedUserRecordId: string | null = null

    if (conversationId && userContext.envId && !isResumeFromInterrupt) {
      const preSaved = await persistenceService.preSavePendingRecords({
        conversationId,
        envId: userContext.envId,
        userId: userContext.userId,
        prompt,
        prevRecordId: lastRecordId,
        assistantRecordId: assistantMessageId,
      })
      preSavedUserRecordId = preSaved.userRecordId
    }

    // DEBUG: ACP SSE event log path (shared with message loop debug dir)
    const debugAcpLogDir = path.resolve(actualCwd, 'debug-jsonl')
    mkdirSync(debugAcpLogDir, { recursive: true })
    const debugAcpLogPath = path.join(debugAcpLogDir, `${conversationId}_acp_${Date.now()}.jsonl`)

    const wrappedCallback: AgentCallback = (msg) => {
      // Enrich message with assistantMessageId
      const enrichedMsg =
        msg.type === 'ask_user' || msg.type === 'tool_confirm'
          ? { ...msg, assistantMessageId }
          : { ...msg, id: msg.id || assistantMessageId, assistantMessageId }

      // 1. Always persist ACP event to DB via EventBuffer
      const acpEvent = CloudbaseAgentService.convertToSessionUpdate(enrichedMsg, conversationId)
      let eventSeq: number | undefined
      if (acpEvent) {
        eventSeq = eventBuffer.pushAndGetSeq(acpEvent)
      }

      // DEBUG: log raw AgentCallbackMessage and converted ACP event
      try {
        appendFileSync(debugAcpLogPath, JSON.stringify({ ts: Date.now(), raw: enrichedMsg, acp: acpEvent }) + '\n')
      } catch {
        // ignore
      }

      // 2. Persist deployment records (side-effect, fire-and-forget)
      if (msg.type === 'artifact' && msg.artifact) {
        this.persistDeploymentFromArtifact(conversationId, msg.artifact).catch((err) => {
          console.error('Failed to persist deployment:', err)
        })
      }

      // 3. Forward to live SSE callback if present (ignore errors on disconnect)
      if (liveCallback) {
        try {
          liveCallback(enrichedMsg, eventSeq)
        } catch {
          // SSE disconnected, ignore
        }
      }
    }

    // ── 获取 SCF 沙箱 ────────────────────────────────────────────────
    let sandboxInstance: SandboxInstance | null = null
    let toolOverrideConfig: { url: string; headers: Record<string, string> } | null = null
    let detectedSandboxCwd: string | undefined

    const sandboxEnabled = process.env.TCB_ENV_ID && process.env.SCF_SANDBOX_IMAGE_URI

    if (sandboxEnabled) {
      try {
        sandboxInstance = await scfSandboxManager.getOrCreate(conversationId, userContext.envId, {
          mode: 'shared',
          workspaceIsolation: sandboxMode as 'shared' | 'isolated',
          sandboxSessionId,
        })

        toolOverrideConfig = await sandboxInstance.getToolOverrideConfig()

        // ── 健康检查：等待沙箱就绪 ──────────────────────────────────
        const sandboxReady = await waitForSandboxHealth(sandboxInstance, wrappedCallback)
        if (!sandboxReady) {
          wrappedCallback({ type: 'text', content: '沙箱启动超时，将使用受限模式继续对话。\n\n' })
          sandboxInstance = null
        } else {
          // ── 初始化工作空间：注入【登录用户凭证】──────────────────
          const sandboxCwd = await initSandboxWorkspace(
            sandboxInstance,
            {
              envId: userContext.envId,
              secretId: userCredentials?.secretId || '',
              secretKey: userCredentials?.secretKey || '',
              token: userCredentials?.sessionToken,
            },
            conversationId,
          )
          if (sandboxCwd) {
            detectedSandboxCwd = sandboxCwd
            wrappedCallback({ type: 'session', sandboxCwd } as any)
            console.log(`[Agent] Sandbox workspace initialized, cwd: ${sandboxCwd}`)
          }

          // Create sandbox MCP client，使用【登录用户凭证】操作 CloudBase 资源
          sandboxMcpClient = await createSandboxMcpClient({
            baseUrl: sandboxInstance.baseUrl,
            scfSessionId: userContext.envId,
            conversationId,
            getAccessToken: () => sandboxInstance!.getAccessToken(),
            getCredentials: async () => ({
              cloudbaseEnvId: userContext.envId,
              secretId: userCredentials?.secretId || '',
              secretKey: userCredentials?.secretKey || '',
              sessionToken: userCredentials?.sessionToken,
            }),
            workspaceFolderPaths: actualCwd,
            log: (msg) => console.log(msg),
            onArtifact: (artifact) => {
              wrappedCallback({ type: 'artifact', artifact })
            },
            getMpDeployCredentials: async (appId: string) => {
              const app = await getDb().miniprogramApps.findByAppIdAndUserId(appId, userContext.userId)
              if (!app) return null
              return { appId: app.appId, privateKey: decrypt(app.privateKey) }
            },
            userId: userContext.userId,
            currentModel: modelId,
          })

          console.log('[Agent] Sandbox ready')

          // Persist sandboxId to task record so frontend can access file browser
          try {
            await getDb().tasks.update(conversationId, {
              sandboxId: sandboxInstance.functionName,
            })
          } catch {
            // Non-critical: file browser won't show but agent continues
          }
        }
      } catch (err) {
        console.error('[Agent] Sandbox creation failed:', (err as Error).message)
        wrappedCallback({
          type: 'text',
          content: `【沙箱环境创建失败】${(err as Error).message}。将使用受限模式继续对话。\n\n`,
        })
        // Continue without sandbox
      }
    }

    // ── Coding mode: initialize template project and start dev server ──
    if (isCodingMode && sandboxInstance) {
      try {
        wrappedCallback({ type: 'text', content: '正在初始化 Coding 项目...\n' })
        await initCodingProject(sandboxInstance, actualCwd)
        wrappedCallback({ type: 'text', content: '正在启动开发服务器...\n' })
        await startDevServer(sandboxInstance, actualCwd)
        wrappedCallback({ type: 'text', content: '开发服务器已启动，可在 Preview 标签页预览。\n\n' })
      } catch (err) {
        console.error('[Agent] Coding mode init failed:', (err as Error).message)
        wrappedCallback({
          type: 'text',
          content: `Coding 项目初始化失败: ${(err as Error).message}\n\n`,
        })
      }
    }

    // ── MCP Server ────────────────────────────────────────────────────
    // Note: createSdkMcpServer objects contain Zod schemas with circular references
    // which cannot be serialized by SDK 0.3.68's ProcessTransport.buildArgs.
    // Skip custom MCP tools for now - agent has built-in tools (Read/Write/Bash/etc.)

    // ── 获取认证凭据（API Key 或 OAuth Token）───────────────────────
    const envVars: Record<string, string> = {}

    if (process.env.CODEBUDDY_API_KEY) {
      // API Key 模式 - 直接使用密钥，无需 token 交换
      envVars.CODEBUDDY_API_KEY = process.env.CODEBUDDY_API_KEY
      if (process.env.CODEBUDDY_INTERNET_ENVIRONMENT) {
        envVars.CODEBUDDY_INTERNET_ENVIRONMENT = process.env.CODEBUDDY_INTERNET_ENVIRONMENT
      }
    } else {
      // OAuth 模式 - 通过 client_credentials 获取 token
      const authToken = await getOAuthToken()
      envVars.CODEBUDDY_AUTH_TOKEN = authToken
    }

    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let iterationTimeoutTimer: ReturnType<typeof setTimeout> | undefined
    let toolCallInProgress = false // Pause iteration timeout while tools are executing
    const abortController = new AbortController()

    function resetIterationTimeout() {
      if (iterationTimeoutTimer) clearTimeout(iterationTimeoutTimer)
      if (toolCallInProgress) return // Don't set timeout while tool is executing
      iterationTimeoutTimer = setTimeout(() => {
        abortController.abort()
        ;(currentQuery as any)?.cleanup?.()
      }, ITERATION_TIMEOUT_MS)
    }

    let currentQuery: any = null
    try {
      const sessionOpts: Record<string, unknown> = hasHistory
        ? { resume: conversationId, sessionId: conversationId }
        : { persistSession: true, sessionId: conversationId }

      // Build env vars for tool override
      if (toolOverrideConfig) {
        envVars.CODEBUDDY_TOOL_OVERRIDE = getToolOverridePath()
        envVars.CODEBUDDY_TOOL_OVERRIDE_CONFIG = JSON.stringify(toolOverrideConfig)
      }

      // Skill loader override: load bundled skills + project/user skills
      envVars.CODEBUDDY_SKILL_LOADER_OVERRIDE = getSkillLoaderOverridePath()
      envVars.CODEBUDDY_BUNDLED_SKILLS_DIR = getBundledSkillsDir()
      if (sandboxInstance && detectedSandboxCwd) {
        // Pass sandbox cwd so skill-loader can scan remote skills dirs
        envVars.CODEBUDDY_SANDBOX_CWD = detectedSandboxCwd
      }

      // Build MCP servers config - pass the SDK-wrapped McpServer to query()
      const mcpServers: Record<string, any> = {}

      if (sandboxMcpClient) {
        mcpServers.cloudbase = sandboxMcpClient.sdkServer
      }

      // ── 执行 query ─────────────────────────────────────────────────

      // 用于在 canUseTool 中捕获被中断的写工具调用信息
      const pendingToolInterrupt: {
        value: { callId: string; toolName: string; input: unknown } | null
      } = { value: null }

      // 构建 query 参数 - 和 tcb-headless-service buildQueryOptions 一致
      // 注意: cwd 必须是本地路径, 即使沙箱启用. 沙箱只提供 MCP 工具, agent 进程在本地运行.
      const queryArgs = {
        prompt,
        options: {
          model: modelId,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns,
          cwd: actualCwd,
          ...sessionOpts,
          includePartialMessages: true,
          systemPrompt: {
            append: isCodingMode
              ? getCodingSystemPrompt() + '\n\n' + buildAppendPrompt(actualCwd, conversationId, userContext.envId)
              : buildAppendPrompt(actualCwd, conversationId, userContext.envId),
          },
          mcpServers,
          abortController,
          canUseTool: async (toolName: string, input: unknown, _options: unknown) => {
            const toolUseId = (_options as any)?.toolUseID

            // AskUserQuestion 处理：统一由 resume 预处理（更新 DB + restore）驱动，不在 canUseTool 注入答案
            if (toolName === 'AskUserQuestion') {
              // 通知前端需要用户回答
              wrappedCallback({
                type: 'ask_user',
                id: toolUseId,
                input: input as Record<string, unknown>,
              })

              return {
                behavior: 'deny' as const,
                message: '等待用户回答问题',
                interrupt: true,
              }
            }

            // 写工具确认处理（提取工具名，去掉 mcp__server__ 前缀）
            const normalizedToolName = toolName.startsWith('mcp__')
              ? toolName.split('__').slice(2).join('__') || toolName
              : toolName

            if (WRITE_TOOLS.has(normalizedToolName)) {
              // Resume 场景：已有用户确认结果
              if (toolConfirmation && toolConfirmation.interruptId === toolUseId) {
                if (toolConfirmation.payload.action === 'allow') {
                  return {
                    behavior: 'allow' as const,
                    updatedInput: input as Record<string, unknown>,
                  }
                }
                return { behavior: 'deny' as const, message: '用户拒绝了此操作' }
              }

              // 捕获工具调用信息供 catch 持久化
              if (toolUseId && pendingToolInterrupt) {
                pendingToolInterrupt.value = {
                  callId: toolUseId,
                  toolName,
                  input: input as Record<string, unknown>,
                }
              }

              // 通知前端需要确认
              wrappedCallback({
                type: 'tool_confirm',
                id: toolUseId,
                name: toolName,
                input: input as Record<string, unknown>,
              })

              return {
                behavior: 'deny' as const,
                message: '等待用户确认写操作',
                interrupt: true,
              }
            }

            return { behavior: 'allow' as const, updatedInput: input as Record<string, unknown> }
          },
          hooks: {
            PreToolUse: [
              {
                // 匹配所有 MCP 工具（mcp__ 开头）
                matcher: '^mcp__',
                hooks: [
                  async (hookInput: unknown, toolUseId: string, { signal }: { signal: unknown }) => {
                    const toolName = (hookInput as any).tool_name
                    const toolInput = (hookInput as any).tool_input
                    const actualToolUseId = toolUseId || (hookInput as any).tool_use_id

                    // 提取工具名（去掉 mcp__server__ 前缀）
                    const normalizedToolName = toolName.startsWith('mcp__')
                      ? toolName.split('__').slice(2).join('__') || toolName
                      : toolName

                    // 检查是否为需要确认的写工具
                    if (WRITE_TOOLS.has(normalizedToolName)) {
                      // Resume 场景：已有用户确认结果
                      if (toolConfirmation && toolConfirmation.interruptId === actualToolUseId) {
                        if (toolConfirmation.payload.action === 'allow') {
                          return {
                            continue: true,
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              permissionDecision: 'allow',
                            },
                          }
                        }
                        return {
                          continue: false,
                          decision: 'block',
                          reason: '用户拒绝了此操作',
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason: '用户拒绝了此操作',
                          },
                        }
                      }

                      // 捕获工具调用信息供 catch 持久化
                      if (actualToolUseId && pendingToolInterrupt) {
                        pendingToolInterrupt.value = {
                          callId: actualToolUseId,
                          toolName,
                          input: toolInput as Record<string, unknown>,
                        }
                      }

                      // 返回 block 并中断
                      return {
                        continue: false,
                        decision: 'block',
                        reason: '等待用户确认写操作',
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'ask',
                          permissionDecisionReason: '等待用户确认写操作',
                        },
                      }
                    }

                    // 其他 MCP 工具直接允许
                    return { continue: true }
                  },
                ],
              },
            ],
          },
          env: envVars,
          stderr: (data: string) => {
            console.error('[Agent CLI stderr]', data.trim())
          },
          disallowedTools: ['AskUserQuestion', 'EnterPlanMode'],
        },
      }

      console.log('[Agent] calling query(), model:', modelId, 'sessionOpts:', JSON.stringify(sessionOpts))
      const q = query(queryArgs as any)
      currentQuery = q
      console.log('[Agent] query() returned, entering message loop...')

      connectTimer = setTimeout(() => {
        abortController.abort()
      }, CONNECT_TIMEOUT_MS)

      let firstMessageReceived = false
      const tracker = createToolCallTracker()

      resetIterationTimeout()

      try {
        console.log('[Agent] starting for-await loop...')

        // DEBUG: log all messages from messageLoop to a file
        const debugMsgLogDir = path.resolve(actualCwd, 'debug-jsonl')
        mkdirSync(debugMsgLogDir, { recursive: true })
        const debugMsgLogPath = path.join(debugMsgLogDir, `${conversationId}_messageloop_${Date.now()}.jsonl`)

        messageLoop: for await (const message of q) {
          console.log('[Agent] message type:', message.type, JSON.stringify(message).slice(0, 300))

          // DEBUG: write full message to log file
          try {
            appendFileSync(debugMsgLogPath, JSON.stringify({ ts: Date.now(), ...message }) + '\n')
          } catch {
            // ignore debug log errors
          }

          // Tool result (user message) means tool execution completed — resume timeout
          if (message.type === 'user') {
            toolCallInProgress = false
          }

          // Assistant message with tool_use means tool is about to execute — pause timeout
          if (message.type === 'assistant') {
            const content = (message as any).message?.content
            if (Array.isArray(content) && content.some((b: any) => b.type === 'tool_use')) {
              toolCallInProgress = true
              if (iterationTimeoutTimer) {
                clearTimeout(iterationTimeoutTimer)
                iterationTimeoutTimer = undefined
              }
            }
          }

          resetIterationTimeout()

          if (!firstMessageReceived) {
            firstMessageReceived = true
            clearTimeout(connectTimer)
          }

          switch (message.type) {
            case 'system': {
              const sid = (message as any).session_id
              if (sid) wrappedCallback({ type: 'session', sessionId: sid })
              break
            }
            case 'error': {
              const errorMsg = (message as any).error || 'Unknown error'
              throw new Error(errorMsg)
            }
            case 'stream_event':
              this.handleStreamEvent((message as any).event, tracker, wrappedCallback)
              break
            case 'user': {
              const content = (message as any).message?.content
              if (content) this.handleToolResults(content, tracker, wrappedCallback)
              break
            }
            case 'assistant':
              this.handleToolNotFoundErrors(message, tracker, wrappedCallback)
              this.handleAssistantToolUseInputs(message, tracker, wrappedCallback)
              break
            case 'result':
              wrappedCallback({
                type: 'result',
                content: JSON.stringify({
                  subtype: (message as any).subtype,
                  duration_ms: (message as any).duration_ms,
                }),
              })
              break messageLoop
            default:
              break
          }
        }
      } catch (err) {
        console.error('[Agent] message loop error:', err)
        if (err instanceof ExecutionError) {
          console.log('[Agent] ExecutionError (interrupt), returning')
          return
        }
        // Don't re-throw Transport closed errors - they're expected when CLI exits
        if (err instanceof Error && err.message === 'Transport closed') {
          console.error('[Agent] CLI process exited unexpectedly')
          return
        }
        throw err
      }
    } finally {
      console.log('[Agent] entering finally block')
      if (connectTimer) clearTimeout(connectTimer)
      if (iterationTimeoutTimer) clearTimeout(iterationTimeoutTimer)

      // Cleanup stream events first — messages will be synced to DB below,
      // so stream events (used only for SSE replay) are no longer needed.
      try {
        await persistenceService.cleanupStreamEvents(conversationId, assistantMessageId)
      } catch {
        // Non-critical
      }

      // Flush remaining events to DB
      try {
        await eventBuffer.close()
      } catch {
        // Non-critical
      }

      // Archive to git if sandbox was used
      if (sandboxInstance) {
        try {
          await archiveToGit(sandboxInstance, conversationId, prompt)
        } catch (err) {
          console.error('[Agent] Archive to git failed:', (err as Error).message)
        }
      }

      // Close sandbox MCP client
      if (sandboxMcpClient) {
        try {
          await sandboxMcpClient.close()
        } catch {
          // ignore
        }
      }

      // 同步消息 + 清理本地文件
      let syncError: Error | undefined
      let finalStatus: 'completed' | 'error' = 'completed'
      try {
        await persistenceService.syncMessages(
          conversationId,
          userContext.envId,
          userContext.userId,
          historicalMessages,
          lastRecordId,
          actualCwd,
          assistantMessageId,
          isResumeFromInterrupt,
          preSavedUserRecordId,
        )
        await persistenceService.finalizePendingRecords(assistantMessageId, 'done')
      } catch (err) {
        syncError = err instanceof Error ? err : new Error(String(err))
        finalStatus = 'error'
        console.error('[Agent] syncAndCleanup failed:', syncError.message)

        if (preSavedUserRecordId && conversationId) {
          try {
            await persistenceService.finalizePendingRecords(assistantMessageId, 'error')
          } catch {
            // finalize failure ignored
          }
        }
      }

      // Update task status in SQLite
      try {
        await getDb().tasks.update(conversationId, {
          status: finalStatus === 'error' ? 'error' : 'completed',
          completedAt: Date.now(),
          updatedAt: Date.now(),
        })
      } catch {
        // Non-critical
      }

      // Update agent registry
      completeAgent(conversationId, finalStatus, syncError?.message)

      // Schedule registry cleanup after observers have time to detect completion
      setTimeout(() => removeAgent(conversationId), 30_000)

      if (syncError) {
        throw syncError
      }
    }
  }

  // ─── Deployment Persistence ────────────────────────────────────────

  private async persistDeploymentFromArtifact(
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
        // Normalize path: strip trailing index.html and trailing slash for dedup
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

  // ─── Stream Event Handlers ──────────────────────────────────────────

  private handleStreamEvent(event: any, tracker: ToolCallTracker, callback: AgentCallback): void {
    if (!event) return
    switch (event.type) {
      case 'content_block_delta':
        this.handleContentBlockDelta(event, tracker, callback)
        break
      case 'content_block_start':
        this.handleContentBlockStart(event, tracker, callback)
        break
      case 'content_block_stop':
        this.handleContentBlockStop(event, tracker, callback)
        break
    }
  }

  private handleContentBlockStart(event: any, tracker: ToolCallTracker, callback: AgentCallback): void {
    const block = event?.content_block
    if (!block) return

    if (block.type === 'thinking') {
      tracker.blockIndexToToolId.set(event.index, '__thinking__')
      return
    }
    if (block.type !== 'tool_use') return

    if (event.index !== undefined) {
      tracker.blockIndexToToolId.set(event.index, block.id)
    }
    tracker.pendingToolCalls.set(block.id, {
      name: block.name,
      input: block.input || {},
      inputJson: '',
    })
    callback({ type: 'tool_use', name: block.name, input: block.input || {}, id: block.id })
  }

  private handleContentBlockDelta(event: any, tracker: ToolCallTracker, callback: AgentCallback): void {
    const delta = event?.delta
    if (!delta) return

    if (delta.type === 'thinking_delta' && delta.thinking) {
      callback({ type: 'thinking', content: delta.thinking })
    } else if (delta.type === 'text_delta' && delta.text) {
      callback({ type: 'text', content: delta.text })
    } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
      const toolId = tracker.blockIndexToToolId.get(event.index)
      if (toolId && toolId !== '__thinking__') {
        const toolInfo = tracker.pendingToolCalls.get(toolId)
        if (toolInfo) {
          toolInfo.inputJson = (toolInfo.inputJson || '') + delta.partial_json
        }
        tracker.toolInputJsonBuffers.set(toolId, (tracker.toolInputJsonBuffers.get(toolId) || '') + delta.partial_json)
      }
    }
  }

  private handleContentBlockStop(event: any, tracker: ToolCallTracker, callback: AgentCallback): void {
    const toolId = tracker.blockIndexToToolId.get(event.index)
    if (!toolId) return

    if (toolId === '__thinking__') {
      tracker.blockIndexToToolId.delete(event.index)
      return
    }

    const toolInfo = tracker.pendingToolCalls.get(toolId)
    if (toolInfo?.inputJson) {
      try {
        const parsedInput = JSON.parse(toolInfo.inputJson)
        toolInfo.input = parsedInput
        // Send input update (not a new tool_call) so frontend can merge
        callback({ type: 'tool_input_update', name: toolInfo.name, input: parsedInput, id: toolId })
      } catch {
        // ignore
      }
    }
    tracker.blockIndexToToolId.delete(event.index)
  }

  private handleToolResults(content: any[], tracker: ToolCallTracker, callback: AgentCallback): void {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const toolUseId = block.tool_use_id
      if (!toolUseId) continue

      // 提取 rawText 供部署URL、二维码解析使用
      const rawText =
        Array.isArray(block.content) && block.content[0]?.text
          ? block.content[0].text
          : typeof block.content === 'string'
            ? block.content
            : null

      // 检测 uploadFiles 结果，提取 CloudBase 部署 URL
      this.tryExtractDeployUrl(block.tool_use_id, rawText, tracker, callback)

      // 检测 publishMiniprogram 结果，提取预览二维码
      this.tryExtractQrcode(block.tool_use_id, rawText, tracker, callback)

      let processedContent = block.content
      if (Array.isArray(block.content) && block.content.length > 0) {
        const firstBlock = block.content[0]
        if (firstBlock.type === 'text' && typeof firstBlock.text === 'string') {
          try {
            processedContent = JSON.parse(firstBlock.text)
          } catch {
            processedContent = firstBlock.text
          }
        }
      }

      tracker.pendingToolCalls.delete(toolUseId)
      tracker.toolInputJsonBuffers.delete(toolUseId)
      callback({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: typeof processedContent === 'string' ? processedContent : JSON.stringify(processedContent),
        is_error: block.is_error,
      })
    }
  }

  /**
   * 尝试从 uploadFiles 工具结果中提取 CloudBase 静态托管部署 URL
   * 结果包含 accessUrl 或 staticDomain 则触发 artifact callback
   */
  private tryExtractDeployUrl(
    toolUseId: string,
    rawText: string | null,
    tracker: ToolCallTracker,
    callback: AgentCallback,
  ): void {
    const toolInfo = tracker.pendingToolCalls.get(toolUseId)
    const toolName = toolInfo?.name || ''
    if (!toolName.includes('uploadFiles') && !toolName.includes('cloudbase_uploadFiles')) return
    if (!rawText) return

    try {
      let localPath: string | undefined
      const inputJson = tracker.toolInputJsonBuffers.get(toolUseId)
      if (inputJson) {
        try {
          localPath = JSON.parse(inputJson)?.localPath
        } catch {
          /* ignore */
        }
      }
      if (!localPath) localPath = toolInfo?.input?.localPath as string | undefined

      const isFile = localPath ? /\.[a-zA-Z0-9]+$/.test(localPath.replace(/\/+$/, '').split('/').pop() || '') : false
      const deployUrl = CloudbaseAgentService.extractDeployUrl(rawText, isFile)
      if (deployUrl) {
        callback({
          type: 'artifact',
          artifact: {
            title: 'Web 应用已部署',
            contentType: 'link',
            data: deployUrl,
            metadata: { deploymentType: 'web' },
          },
        })
      }
    } catch {
      // 提取失败不影响主流程
    }
  }

  /**
   * 从 uploadFiles 工具结果 JSON 中递归提取 CloudBase 部署 URL
   * 支持 accessUrl / staticDomain 字段，最多递归 5 层
   */
  private static extractDeployUrl(rawText: string, isFile = false, depth = 0): string | null {
    if (depth > 5) return null
    try {
      const parsed = JSON.parse(rawText)

      if (Array.isArray(parsed)) {
        const firstText = parsed[0]?.text
        if (typeof firstText === 'string') {
          return CloudbaseAgentService.extractDeployUrl(firstText, isFile, depth + 1)
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
        return CloudbaseAgentService.extractDeployUrl(innerText, isFile, depth + 1)
      }
    } catch {
      // JSON parse 失败，忽略
    }
    return null
  }

  /**
   * 尝试从 publishMiniprogram 工具结果中提取小程序预览二维码
   * 成功则触发 artifact callback
   */
  private tryExtractQrcode(
    toolUseId: string,
    rawText: string | null,
    tracker: ToolCallTracker,
    callback: AgentCallback,
  ): void {
    const toolInfo = tracker.pendingToolCalls.get(toolUseId)
    const toolName = toolInfo?.name || ''
    if (!toolName.includes('publishMiniprogram') && !toolName.includes('Miniprogram')) return
    if (!rawText) return

    try {
      let parsedResult: any = null
      try {
        parsedResult = JSON.parse(rawText)
      } catch {
        return
      }

      const action = parsedResult?.action || (toolInfo?.input as any)?.action

      // 小程序预览二维码
      if (parsedResult?.result?.qrcode) {
        const qrcode = `data:${parsedResult?.result?.qrcode?.mimeType || 'image/png'};base64,${parsedResult?.result?.qrcode?.base64}`
        callback({
          type: 'artifact',
          artifact: {
            title: '小程序预览二维码',
            description: '使用微信扫码预览小程序',
            contentType: 'image',
            data: qrcode,
            metadata: parsedResult,
          },
        })
        return
      }

      // 上传成功但无二维码
      if (parsedResult?.success && action === 'upload') {
        callback({
          type: 'artifact',
          artifact: {
            title: '小程序上传成功',
            description: '代码已上传到微信后台，可前往微信公众平台提交审核',
            contentType: 'json',
            data: JSON.stringify(parsedResult),
          },
        })
      }
    } catch {
      // 提取失败不影响主流程
    }
  }

  private handleToolNotFoundErrors(msg: any, tracker: ToolCallTracker, callback: AgentCallback): void {
    if (!msg.message?.content) return
    for (const block of msg.message.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      const match = block.text.match(/Tool\s+(\S+)\s+not\s+found/i)
      if (!match) continue
      const toolName = match[1]
      for (const [toolUseId, toolInfo] of tracker.pendingToolCalls.entries()) {
        if (toolInfo.name === toolName) {
          callback({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: JSON.stringify({ error: block.text }),
            is_error: true,
          })
          tracker.pendingToolCalls.delete(toolUseId)
          break
        }
      }
    }
  }

  /**
   * 处理 assistant message 中 tool_use 块的完整 input。
   *
   * GLM 等非 Anthropic 模型不通过 content_block_delta / input_json_delta 流式传输工具参数，
   * 而是在 content_block_start 时 input 为空（{}），然后在 assistant message 里包含完整 input。
   * 此方法将完整 input 通过 tool_input_update 事件发送给前端，使前端能正确展示工具参数。
   */
  private handleAssistantToolUseInputs(msg: any, tracker: ToolCallTracker, callback: AgentCallback): void {
    const content = msg.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      const toolId = block.id
      if (!toolId) continue
      // Only send input update if we have actual input (non-empty object) and the
      // pending tool call still has an empty input (i.e. no input_json_delta was received)
      const pendingTool = tracker.pendingToolCalls.get(toolId)
      const hasInput = block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
      if (hasInput && pendingTool && Object.keys(pendingTool.input).length === 0) {
        pendingTool.input = block.input
        callback({ type: 'tool_input_update', name: block.name || pendingTool.name, input: block.input, id: toolId })
      }
    }
  }
}

export const cloudbaseAgentService = new CloudbaseAgentService()
