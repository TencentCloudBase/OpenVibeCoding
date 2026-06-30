import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query, ExecutionError } from '@tencent-ai/agent-sdk'
import { v4 as uuidv4 } from 'uuid'
import { loadConfig } from '../config/store.js'
import { persistenceService } from './persistence.service.js'
import {
  scfSandboxManager,
  type SandboxInstance,
  type SandboxProgressCallback,
} from '../sandbox/scf-sandbox-manager.js'
import { createSandboxMcpClient } from '../sandbox/sandbox-mcp-proxy.js'
import { archiveToGit } from '../sandbox/git-archive.js'
import { getCodingSystemPrompt } from './coding-mode.js'
import { getDb } from '../db/index.js'
import { resolveSandboxConfig, backfillSandboxConfig } from '../lib/sandbox-config.js'
import { decrypt } from '../lib/crypto.js'
import { encryptJWE } from '../lib/session.js'
import type { AgentCallbackMessage, AgentOptions, CodeBuddyMessage, ExtendedSessionUpdate } from '@coder/shared'
import { registerAgent, getAgentRun, completeAgent, isAgentRunning, type StopReason } from './agent-registry.js'
import { EventBuffer } from './event-buffer.js'
import { sessionPermissions, normalizeToolName } from './session-permissions.js'
import { initRepo, pushToUserGit } from '../sandbox/git-personal'
import { initSkills } from '../services/skill-manager.js'

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'glm-5.1'
const OAUTH_TOKEN_ENDPOINT = 'https://copilot.tencent.com/oauth2/token'
const CONNECT_TIMEOUT_MS = 60_000
const ITERATION_TIMEOUT_MS = 2 * 60 * 1000
const DEBUG_JSONL = process.env.AGENT_DEBUG_JSONL === '1' || process.env.AGENT_DEBUG_JSONL === 'true'

/**
 * 把 CodeBuddy SDK 的 result subtype + stream stop_reason 映射成 ACP stopReason。
 *
 * SDK result subtype 可能值（来自 @tencent-ai/agent-sdk lib/types.d.ts）：
 *   'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd'
 *
 * SDK stream MessageDeltaEvent.delta.stop_reason 可能值：
 *   'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal'
 *
 * ACP 合法值（本仓库 registry.StopReason）：
 *   'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
 */
function mapCodebuddyStopReason(resultSubtype: string | undefined, streamStopReason: string | undefined): StopReason {
  if (resultSubtype === 'error_max_turns') return 'max_turn_requests'
  if (resultSubtype === 'error_max_budget_usd') return 'refusal'
  if (streamStopReason === 'max_tokens') return 'max_tokens'
  if (streamStopReason === 'refusal') return 'refusal'
  return 'end_turn'
}

/**
 * 把 ExecutionError.subtype（CLI 返回 result 时塞的 subtype）映射成 ACP stopReason。
 * 'error_max_turns' → max_turn_requests；其它情况（error_during_execution / error_max_budget_usd）
 * 统一映射为 refusal（ACP 没有 'error' 字面量）。
 */
function mapExecutionErrorStopReason(subtype: string | undefined): StopReason {
  if (subtype === 'error_max_turns') return 'max_turn_requests'
  return 'refusal'
}

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

// 是否使用自定义模型（通过 .codebuddy/models.json 注入到 SDK）
// true: 模型来自 packages/server/.config/.codebuddy/models.json
// false: 模型走 SDK 默认（账号绑定的官方模型列表）
function useCustomModels(): boolean {
  const v = process.env.CODEBUDDY_USE_CUSTOM_MODELS
  return v === '1' || v === 'true' || v === 'yes'
}

// 是否从 SDK 动态拉取模型列表（替代硬编码的 SYSTEM_MODELS）
// 开启后调用 query().supportedModels()，失败时降级到 SYSTEM_MODELS
function useDynamicModels(): boolean {
  const v = process.env.CODEBUDDY_DYNAMIC_MODELS
  return v === '1' || v === 'true' || v === 'yes'
}

// 解析 ${VAR_NAME} 占位符为环境变量值（与模板复制一致）
function resolveEnvPlaceholders(text: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, varName) => {
    return process.env[varName] || ''
  })
}

// 解析 .config/.codebuddy/models.json 模板路径（dev / prod 兼容）
function getModelsTemplatePath(): string | null {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const devTpl = path.resolve(__dirname, '../../.config/.codebuddy/models.json')
  const prodTpl = path.resolve(__dirname, '../.config/.codebuddy/models.json')
  if (existsSync(prodTpl)) return prodTpl
  if (existsSync(devTpl)) return devTpl
  return null
}

// 从模板读取自定义模型列表（用于前端 listModels 与 SDK modelId 验证）
function loadCustomModelsFromTemplate(): ModelInfo[] {
  try {
    const templatePath = getModelsTemplatePath()
    if (!templatePath) return []
    const raw = readFileSync(templatePath, 'utf-8')
    const config = JSON.parse(raw) as {
      models?: Array<{
        id: string
        name?: string
        vendor?: string
        supportsToolCall?: boolean
        supportsImages?: boolean
      }>
      availableModels?: string[]
    }
    const allowed = new Set(config.availableModels ?? [])
    const all = config.models ?? []
    const filtered = allowed.size > 0 ? all.filter((m) => allowed.has(m.id)) : all
    return filtered.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      vendor: m.vendor,
      supportsToolCall: m.supportsToolCall,
      supportsImages: m.supportsImages,
    }))
  } catch (err) {
    console.warn('[Agent] Failed to load custom models from template:', err)
    return []
  }
}

// SDK 系统模型（账号绑定的官方模型列表，不含自定义）
const SYSTEM_MODELS: ModelInfo[] = [
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7' },
  { id: 'hunyuan-2.0-thinking', name: 'Hunyuan-2.0-Thinking' },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2' },
]

// 从 SDK 动态拉取模型列表（CODEBUDDY_DYNAMIC_MODELS=1 时启用）
async function fetchSupportedModels(): Promise<ModelInfo[]> {
  try {
    const q = query({ prompt: '', options: { permissionMode: 'bypassPermissions' } })
    const models = await q.supportedModels()
    q.return?.()
    // SDK ModelInfo: { value, displayName, description }
    if (Array.isArray(models) && models.length > 0) {
      return models.map((m: any) =>
        typeof m === 'string'
          ? { id: m, name: m }
          : { id: m.value || m.id || DEFAULT_MODEL, name: m.displayName || m.name || m.value || DEFAULT_MODEL },
      )
    }
  } catch (e) {
    console.warn('[Agent] Failed to fetch supported models from SDK:', e)
  }
  return []
}

export async function getSupportedModels(): Promise<ModelInfo[]> {
  if (cachedModels) return cachedModels
  if (useCustomModels()) {
    const customModels = loadCustomModelsFromTemplate()
    cachedModels = customModels.length > 0 ? customModels : SYSTEM_MODELS
  } else if (useDynamicModels()) {
    const dynamic = await fetchSupportedModels()
    cachedModels = dynamic.length > 0 ? dynamic : SYSTEM_MODELS
  } else {
    cachedModels = SYSTEM_MODELS
  }
  return cachedModels
}

// 测试/调试：清空缓存（环境变量改了之后调用以刷新）
export function clearModelsCache(): void {
  cachedModels = null
}

// ─── Sandbox & Prompt Helpers (imported from base-runtime) ───────────────
// 集中在 base-runtime.ts 维护，所有 runtime 共用。
import {
  waitForSandboxHealth,
  initSandboxWorkspace,
  WRITE_TOOLS,
  buildAppendPrompt,
  getPublishableKey,
  persistDeploymentFromArtifact,
} from './runtime/base-runtime.js'

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

type AgentCallback = (message: AgentCallbackMessage, seq?: number) => void | Promise<void>

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
        // P7: 子代理产生的工具带 parentToolCallId
        ...(msg.parent_tool_use_id ? { parentToolCallId: msg.parent_tool_use_id } : {}),
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'tool_input_update') {
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: msg.id || '',
        status: 'in_progress',
        input: msg.input,
        ...(msg.parent_tool_use_id ? { parentToolCallId: msg.parent_tool_use_id } : {}),
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'tool_result') {
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: msg.tool_use_id || '',
        status: msg.is_error ? 'failed' : 'completed',
        result: msg.content,
        ...(msg.parent_tool_use_id ? { parentToolCallId: msg.parent_tool_use_id } : {}),
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
      const input = (msg.input as Record<string, unknown>) || {}
      const toolName = msg.name || ''
      // P2: ExitPlanMode 工具额外提取计划内容为 planContent，供前端 PlanModeCard 渲染
      // Claude Agent SDK 的 ExitPlanMode input schema 是开放的，不同版本/模型下字段名不一，
      // 这里仅做"能提取到字符串就注入"的最小处理；完整的多字段兜底在前端 plan-content.ts。
      let planContent: string | undefined
      if (toolName === 'ExitPlanMode') {
        if (typeof input.plan === 'string' && input.plan.trim()) {
          planContent = input.plan as string
        }
        // 其它字段形态由前端 extractPlanContent 统一处理，服务端不重复实现
      }
      return {
        sessionUpdate: 'tool_confirm',
        toolCallId: msg.id || '',
        assistantMessageId: msg.assistantMessageId || '',
        toolName,
        input,
        ...(planContent !== undefined ? { planContent } : {}),
      } as ExtendedSessionUpdate
    }
    if (msg.type === 'result') {
      // result events are not streamed as session updates
      return null
    }
    // P4: 代理执行阶段上报 — 非里程碑事件(不强制 flush),用于前端后续展示"代理在做什么"
    if (msg.type === 'agent_phase' && msg.phase) {
      return {
        sessionUpdate: 'agent_phase',
        phase: msg.phase,
        ...(msg.phaseToolName ? { toolName: msg.phaseToolName } : {}),
        timestamp: Date.now(),
      } as ExtendedSessionUpdate
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
      maxTurns = 500,
      cwd,
      askAnswers,
      toolConfirmation,
      mode,
      permissionMode: requestedPermissionMode,
      imageBlocks,
    } = options
    let { model } = options
    // 模型选择策略：
    // - 自定义模型模式：优先用前端传入；不在自定义白名单内则回落到模板第一个 model
    // - 系统模型模式：优先用前端传入；否则用 DEFAULT_MODEL
    let modelId: string
    if (useCustomModels()) {
      const customModels = loadCustomModelsFromTemplate()
      const allowed = new Set(customModels.map((m) => m.id))
      if (model && allowed.has(model)) {
        modelId = model
      } else {
        modelId = customModels[0]?.id || DEFAULT_MODEL
      }
    } else {
      modelId = model || DEFAULT_MODEL
    }
    const isCodingMode = mode === 'coding'

    const userContext = { envId: envId || '', userId: userId || 'anonymous' }

    const taskRecord = await getDb().tasks.findById(conversationId)
    // Read sandbox config from task record (written at creation time)
    // Historical tasks missing these fields are backfilled as 'shared' mode
    let sandboxConfig: ReturnType<typeof resolveSandboxConfig> | null = null
    try {
      // const taskRecord = await getDb().tasks.findById(conversationId)
      await backfillSandboxConfig(
        conversationId,
        {
          sandboxMode: taskRecord?.sandboxMode,
          sandboxSessionId: taskRecord?.sandboxSessionId,
          sandboxCwd: taskRecord?.sandboxCwd,
        },
        userContext.envId,
        getDb(),
      )
      sandboxConfig = resolveSandboxConfig({
        sandboxMode: taskRecord?.sandboxMode,
        sandboxSessionId: taskRecord?.sandboxSessionId,
        sandboxCwd: taskRecord?.sandboxCwd,
        envId: userContext.envId,
        taskId: conversationId,
      })
    } catch {
      // Non-critical
    }

    // Fallback when task record was unavailable
    if (!sandboxConfig) {
      sandboxConfig = resolveSandboxConfig({ envId: userContext.envId, taskId: conversationId })
    }

    const { sandboxMode, sandboxSessionId, sandboxCwd: resolvedCwd } = sandboxConfig
    const actualCwd = cwd || resolvedCwd
    console.log(
      `[Agent] sandboxConfig: mode=${sandboxMode}, sessionId=${sandboxSessionId}, resolvedCwd=${resolvedCwd}, cwd=${cwd}, actualCwd=${actualCwd}`,
    )
    mkdirSync(actualCwd, { recursive: true })

    // ── 复制 .codebuddy/models.json 模板供 SDK 读取自定义模型 ────────────
    // 仅当 CODEBUDDY_USE_CUSTOM_MODELS=true 时启用
    if (useCustomModels()) {
      try {
        const modelsJsonPath = path.join(actualCwd, '.codebuddy', 'models.json')
        if (!existsSync(modelsJsonPath)) {
          const templatePath = getModelsTemplatePath()
          if (templatePath) {
            mkdirSync(path.join(actualCwd, '.codebuddy'), { recursive: true })
            const raw = readFileSync(templatePath, 'utf-8')
            writeFileSync(modelsJsonPath, resolveEnvPlaceholders(raw), 'utf-8')
            console.log('[Agent] models.json written to cwd:', modelsJsonPath, 'from template:', templatePath)
          } else {
            console.warn('[Agent] CODEBUDDY_USE_CUSTOM_MODELS=true but template not found')
          }
        } else {
          console.log('[Agent] models.json already exists at:', modelsJsonPath)
        }
      } catch (err) {
        console.error('[Agent] failed to write models.json:', err)
      }
    } else {
      // 系统模型模式：清理掉旧的 models.json，避免 SDK 误读
      try {
        const modelsJsonPath = path.join(actualCwd, '.codebuddy', 'models.json')
        if (existsSync(modelsJsonPath)) {
          unlinkSync(modelsJsonPath)
          console.log('[Agent] CODEBUDDY_USE_CUSTOM_MODELS=false, removed stale models.json')
        }
      } catch (err) {
        console.warn('[Agent] failed to remove stale models.json:', err)
      }
    }

    // Coding 模式：自动放行所有写工具（agent 需要自由操作数据库和部署）
    if (isCodingMode && conversationId) {
      for (const tool of WRITE_TOOLS) {
        sessionPermissions.allowAlways(conversationId, tool)
      }
    }

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
      //
      // 与 toolConfirmation 分支对齐:除了覆盖 output/status,还要补齐
      // providerData.{messageId, model, agent, toolResult{content, renderer}}
      // + 顶层 sessionId,让 restore 后的 JSONL 结构与 baseline 一致。
      // 否则 SDK resume 看到残缺的 function_call_result 会重发 AskUserQuestion。
      if (askAnswers && Object.keys(askAnswers).length > 0) {
        for (const [recordId, { toolCallId, answers }] of Object.entries(askAnswers)) {
          const text = Object.entries(answers)
            .map(([key, value]) => ` · ${key} → ${value}`)
            .join('\n')
          const output = { type: 'text', text }

          // 从原 function_call.metadata.providerData 继承 messageId/model/agent
          const toolCallInfo = await persistenceService.getToolCallInfo(conversationId, recordId, toolCallId)
          const tcProviderData = (toolCallInfo?.metadata?.providerData ?? {}) as Record<string, unknown>
          const inheritedProviderData: Record<string, unknown> = {}
          if (tcProviderData.messageId) inheritedProviderData.messageId = tcProviderData.messageId
          if (tcProviderData.model) inheritedProviderData.model = tcProviderData.model
          if (tcProviderData.agent) inheritedProviderData.agent = tcProviderData.agent

          // baseline 里 toolResult.content 是 MCP 返回的 [{type:text,text:...}] 的 stringify
          // AskUserQuestion 没经过真实 MCP 调用,手动构造等价结构。
          const askPayload = [{ type: 'text', text }]
          const contentStr = JSON.stringify(askPayload)

          const extraMetadata = {
            sessionId: conversationId,
            providerData: {
              ...inheritedProviderData,
              toolResult: {
                content: contentStr,
                renderer: { type: 'media' },
              },
            },
          }

          await persistenceService.updateToolResult(
            conversationId,
            recordId,
            toolCallId,
            output,
            'completed',
            extraMetadata,
          )
          if (recordId !== assistantMessageId) {
            // 次要 recordId 的 tool_call 可能在另一条 DB record,同样需要继承它自己的 providerData
            const secondaryInfo = await persistenceService.getToolCallInfo(
              conversationId,
              assistantMessageId,
              toolCallId,
            )
            const secondaryPd = (secondaryInfo?.metadata?.providerData ?? {}) as Record<string, unknown>
            const secondaryInherited: Record<string, unknown> = {}
            if (secondaryPd.messageId) secondaryInherited.messageId = secondaryPd.messageId
            if (secondaryPd.model) secondaryInherited.model = secondaryPd.model
            if (secondaryPd.agent) secondaryInherited.agent = secondaryPd.agent

            await persistenceService.updateToolResult(
              conversationId,
              assistantMessageId,
              toolCallId,
              output,
              'completed',
              {
                sessionId: conversationId,
                providerData: {
                  ...secondaryInherited,
                  toolResult: {
                    content: contentStr,
                    renderer: { type: 'media' },
                  },
                },
              },
            )
          }
        }
      }

      // Resume + toolConfirmation 场景:**真实**处理在 sandbox + sandboxMcpClient
      // ready 之后再做(见下方注释 "Resume toolConfirmation: 真实执行" 块)。
      // 此处只在原位置做 askAnswers 这种不依赖 sandbox 的处理。
      // 真正的 allow/allow_always/deny 写 DB result 推迟,避免 sandbox 未就绪时
      // 写入占位文本"已允许,请继续。"导致 SDK 误以为工具已执行,从而重新生成
      // 一个新 toolCallId 再次申请权限的死循环。
      // 同理 restoreMessages / preSavePendingRecords 也推迟。
    }

    // ── 预保存 pending 记录(已推迟到 sandbox + restoreMessages 之后) ──
    // 见下方 "Resume toolConfirmation: 真实执行" 块
    let preSavedUserRecordId: string | null = null

    // DEBUG: ACP SSE event log (enabled via AGENT_DEBUG_JSONL=1)
    let debugAcpLogPath: string | null = null
    if (DEBUG_JSONL) {
      const debugAcpLogDir = path.resolve(actualCwd, 'debug-jsonl')
      mkdirSync(debugAcpLogDir, { recursive: true })
      debugAcpLogPath = path.join(debugAcpLogDir, `${conversationId}_acp_${Date.now()}.jsonl`)
    }

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
      if (debugAcpLogPath) {
        try {
          appendFileSync(debugAcpLogPath, JSON.stringify({ ts: Date.now(), raw: enrichedMsg, acp: acpEvent }) + '\n')
        } catch {
          // ignore
        }
      }

      // 2. Persist deployment records (side-effect, fire-and-forget)
      if (msg.type === 'artifact' && msg.artifact) {
        persistDeploymentFromArtifact(conversationId, msg.artifact).catch((err) => {
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

    const sandboxEnabled =
      process.env.TCB_ENV_ID && (process.env.SANDBOX_IMAGE_URI || process.env.SCF_SANDBOX_IMAGE_URI)

    // P4: 代理阶段上报助手 —— 在关键边界向前端透传当前状态
    // 去重:只在 phase 或 toolName 变化时 emit,避免密集的 tool_use stream_event 刷屏
    let lastEmittedPhase: { phase: string; toolName?: string } | null = null
    const emitPhase = (
      phase: 'preparing' | 'model_responding' | 'tool_executing' | 'compacting' | 'idle',
      toolName?: string,
    ) => {
      if (lastEmittedPhase && lastEmittedPhase.phase === phase && lastEmittedPhase.toolName === toolName) return
      lastEmittedPhase = { phase, toolName }
      wrappedCallback({ type: 'agent_phase', phase, phaseToolName: toolName })
    }

    // 首个 phase:准备阶段(沙箱启动、工作空间初始化、历史恢复全部发生在 query() 之前)
    emitPhase('preparing')

    // 沙箱子阶段 → emitPhase('preparing', 'sandbox:xxx') 桥接
    // 让前端 AgentStatusIndicator 能在长耗时的沙箱创建流程中持续看到细粒度进度
    const sandboxProgressBridge: SandboxProgressCallback = ({ phase }) => {
      emitPhase('preparing', `sandbox:${phase}`)
    }

    if (sandboxEnabled) {
      try {
        sandboxInstance = await scfSandboxManager.getOrCreate(
          conversationId,
          userContext.envId,
          {
            mode: 'shared',
            workspaceIsolation: sandboxMode as 'shared' | 'isolated',
            sandboxSessionId,
            isCodingMode,
          },
          sandboxProgressBridge,
        )

        toolOverrideConfig = await sandboxInstance.getToolOverrideConfig()

        // ── 注入静态托管预签名配置（用于 ImageGen 上传）──
        // tool-override 运行在 CLI 子进程，没有 session cookie。
        // 这里用 encryptJWE 签发一个短期 session JWE（同 nex_session 格式），
        // 让 tool-override fetch 时带上 Cookie: nex_session=<jwe>，
        // 这样 server 侧 authMiddleware 直接走 session 认证。
        try {
          const user = await getDb().users.findById(userContext.userId)
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
            // 有效期与 agent 任务生命周期匹配（2h 足够）
            const sessionJwe = await encryptJWE(session, '2h')
            const serverPort = Number(process.env.PORT) || 3001
            ;(toolOverrideConfig as any).hosting = {
              presignUrl: `http://localhost:${serverPort}/api/storage/presign?bucketType=static`,
              sessionCookie: sessionJwe,
              sessionId: conversationId,
            }
          }
        } catch {
          // hosting presign 失败不影响主流程，图片会 fallback 到沙箱存储
        }

        // ── 健康检查：等待沙箱就绪 ──────────────────────────────────
        const sandboxReady = await waitForSandboxHealth(sandboxInstance, sandboxProgressBridge)
        if (!sandboxReady) {
          wrappedCallback({ type: 'text', content: '沙箱启动超时，将使用受限模式继续对话。\n\n' })
          sandboxInstance = null
        } else {
          // ── 初始化工作空间：注入【登录用户凭证】──────────────────
          const initResult = await initSandboxWorkspace(
            sandboxInstance,
            {
              envId: userContext.envId,
              secretId: userCredentials?.secretId || '',
              secretKey: userCredentials?.secretKey || '',
              token: userCredentials?.sessionToken,
            },
            conversationId,
            resolvedCwd || undefined,
            sandboxProgressBridge,
          )
          if (initResult.workspace) {
            detectedSandboxCwd = initResult.workspace
            wrappedCallback({ type: 'session', sandboxCwd: initResult.workspace } as any)
            console.log(`[Agent] Sandbox workspace initialized, cwd: ${initResult.workspace}`)
          }

          try {
            const { success } = await initRepo(sandboxInstance, conversationId)
            if (success) {
              console.log(`[Agent] Sandbox user repo initialized`)
            }
          } catch (e) {
            console.log(`[Agent] Sandbox initialized user repo err: ${e}`)
          }

          // ── Skills 初始化：检查 skillSettings.initialized，仅首次执行 ──
          if (toolOverrideConfig) {
            try {
              const taskForSkills = await getDb().tasks.findById(conversationId)
              if (taskForSkills?.skillSettings) {
                const skillSettings = JSON.parse(taskForSkills.skillSettings)
                if (
                  !skillSettings.initialized &&
                  Array.isArray(skillSettings.skillList) &&
                  skillSettings.skillList.length > 0
                ) {
                  sandboxProgressBridge({ phase: 'init_skills', message: '初始化 Skills...\n' })
                  const skillResult = await initSkills(toolOverrideConfig, conversationId, skillSettings.skillList)
                  if (skillResult.success) {
                    console.log('[Agent] Skills initialized successfully')
                  } else {
                    console.error('[Agent] Skills initialization failed')
                  }
                  // 无论成功失败都标记为已初始化，避免重复执行
                  skillSettings.initialized = true
                  await getDb().tasks.update(conversationId, {
                    skillSettings: JSON.stringify(skillSettings),
                    updatedAt: Date.now(),
                  })
                }
              }
            } catch (e) {
              console.error('[Agent] Skills initialization error')
            }
          }

          // Create sandbox MCP client，使用【登录用户凭证】操作 CloudBase 资源
          sandboxMcpClient = await createSandboxMcpClient({
            sandbox: sandboxInstance,
            userId: userContext.userId,
            envId: userContext.envId,
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

    // ── Coding mode: mark preview ready ─────────────────────────────────────
    // 沙箱 /api/session/init 已内置完整的项目初始化流程：
    //   - seedCodingTemplate: 从内置模板复制（零延迟）
    //   - ensureViteDev: 自动启动 vite dev server + crash 重启
    //   - node_modules 恢复: tar.gz 缓存 / npm install
    // server 端只需写 previewUrl 信号，让前端触发 preview-url SSE
    if (isCodingMode && sandboxInstance) {
      try {
        // const taskRecord = await getDb().tasks.findById(conversationId)
        if (!taskRecord?.previewUrl) {
          await getDb()
            .tasks.update(conversationId, { previewUrl: 'ready' })
            .catch(() => {})
          console.log('[Agent] Coding mode: previewUrl set to ready')
        }
      } catch {}
    }

    // ════════════════════════════════════════════════════════════════════
    // Resume toolConfirmation: 真实执行 + restoreMessages + preSavePending
    // ════════════════════════════════════════════════════════════════════
    // 此前这一段在 sandbox 启动**之前**执行,导致 allow/allow_always 命中
    // sandboxMcpClient=null 时只能写占位文本"已允许,请继续。",SDK 误以为
    // 工具已执行 → 重新生成新 toolCallId 再次申请权限,死循环。
    //
    // 现搬到 sandbox + sandboxMcpClient ready 之后,按以下顺序:
    //   1. toolConfirmation 真实执行(allow/allow_always 走 MCP,deny/ExitPlanMode 写文本)
    //   2. restoreMessages(把含真实 result 的最新 DB 状态写入 JSONL)
    //   3. preSavePendingRecords(非 resume 路径才需要)
    if (conversationId && userContext.envId && toolConfirmation) {
      const action = toolConfirmation.payload.action

      // 预查 toolCallInfo: allow_always 写白名单 + 识别 ExitPlanMode 特殊语义
      let resumedToolName: string | undefined
      try {
        const info = await persistenceService.getToolCallInfo(
          conversationId,
          assistantMessageId,
          toolConfirmation.interruptId,
        )
        resumedToolName = info?.toolName
      } catch {
        // 读取失败不影响主流程
      }
      const isExitPlanMode = resumedToolName === 'ExitPlanMode'

      const isAllowed =
        action === 'allow' || action === 'allow_always' || (isExitPlanMode && action === 'reject_and_exit_plan')

      if (action === 'allow_always' && resumedToolName) {
        const normalized = normalizeToolName(resumedToolName)
        sessionPermissions.allowAlways(conversationId, normalized)
      }

      if (isAllowed && sandboxMcpClient && !isExitPlanMode) {
        // allow / allow_always: 通过 MCP client 调用工具获取真实结果
        const mcpClient = sandboxMcpClient.client
        const toolCallInfo = await persistenceService.getToolCallInfo(
          conversationId,
          assistantMessageId,
          toolConfirmation.interruptId,
        )
        if (toolCallInfo) {
          const normalizedToolName = normalizeToolName(toolCallInfo.toolName)

          // ── 从原 function_call.metadata.providerData 继承 messageId/model/agent ──
          // baseline JSONL 中 function_call_result.providerData.messageId 与
          // function_call.providerData.messageId 同源；不能让它缺失,否则 SDK
          // resume 时认为这条 result 格式不完整 → 重发调用 → 死循环。
          const tcProviderData = (toolCallInfo.metadata?.providerData ?? {}) as Record<string, unknown>
          const inheritedProviderData: Record<string, unknown> = {}
          if (tcProviderData.messageId) inheritedProviderData.messageId = tcProviderData.messageId
          if (tcProviderData.model) inheritedProviderData.model = tcProviderData.model
          if (tcProviderData.agent) inheritedProviderData.agent = tcProviderData.agent

          try {
            const res = (await mcpClient.callTool({
              name: normalizedToolName,
              arguments: toolCallInfo.input,
            })) as { content?: unknown; isError?: boolean }

            // MCP 标准 CallToolResult.content 是 [{type:'text', text:...}] 数组。
            // baseline 将其 JSON.stringify 后既作为 output.text 也作为
            // providerData.toolResult.content（两处字符串完全相同）。
            const rawContent = res.content ?? [{ type: 'text', text: '' }]
            const contentStr = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)

            await persistenceService.updateToolResult(
              conversationId,
              assistantMessageId,
              toolConfirmation.interruptId,
              { type: 'text', text: contentStr },
              'completed',
              {
                sessionId: conversationId,
                providerData: {
                  ...inheritedProviderData,
                  toolResult: {
                    content: contentStr,
                    renderer: { type: 'media' },
                  },
                },
              },
            )
          } catch (err) {
            const errorPayload = [
              {
                type: 'text',
                text: `Error: ${(err as Error).message || '工具执行失败'}`,
              },
            ]
            const errorStr = JSON.stringify(errorPayload)
            await persistenceService.updateToolResult(
              conversationId,
              assistantMessageId,
              toolConfirmation.interruptId,
              { type: 'text', text: errorStr },
              'error',
              {
                sessionId: conversationId,
                providerData: {
                  ...inheritedProviderData,
                  toolResult: {
                    content: errorStr,
                    renderer: { type: 'media' },
                  },
                },
              },
            )
          }
        }
      } else if (isAllowed) {
        // ExitPlanMode 允许:不需要真实执行,只需告诉 Agent 计划已被接受
        // sandbox 不可用(sandboxMcpClient 仍 null)且非 ExitPlanMode 则只能写占位
        // —— 这是降级路径,正常情况下走上面 MCP 真实执行
        let text: string
        if (isExitPlanMode) {
          text =
            action === 'reject_and_exit_plan'
              ? '用户选择退出 Plan 模式，请直接进入执行阶段（后续对话已切回 default 模式）。'
              : '用户已批准计划，请开始执行。'
        } else {
          text = action === 'allow_always' ? '已允许此类操作（本会话），请继续。' : '已允许，请继续。'
        }
        await persistenceService.updateToolResult(
          conversationId,
          assistantMessageId,
          toolConfirmation.interruptId,
          { type: 'text', text },
          'completed',
        )
      } else {
        // deny: 写拒绝消息
        const text = isExitPlanMode ? '用户希望继续规划，请完善计划后再调用 ExitPlanMode。' : '用户拒绝了此操作'
        await persistenceService.updateToolResult(
          conversationId,
          assistantMessageId,
          toolConfirmation.interruptId,
          { type: 'text', text },
          'completed',
        )
      }
    }

    // 从 DB 恢复消息历史(含上方 toolConfirmation 真实执行后的 tool_result)
    let lastAssistantRecordId: string | null = null
    if (conversationId && userContext.envId) {
      const restored = await persistenceService.restoreMessages(
        conversationId,
        userContext.envId,
        userContext.userId,
        actualCwd,
      )
      historicalMessages = restored.messages
      lastRecordId = restored.lastRecordId
      lastAssistantRecordId = restored.lastAssistantRecordId
      hasHistory = historicalMessages.length > 0

      // resume interrupt 场景下,即使 DB 中无历史,只要有 conversationId 就强制走 resume
      if (!hasHistory && isResumeFromInterrupt) {
        hasHistory = true
      }
    }

    // 预保存 pending 记录(resume 跳过,assistant 记录已存在)
    if (conversationId && userContext.envId && !isResumeFromInterrupt) {
      const preSaved = await persistenceService.preSavePendingRecords({
        conversationId,
        envId: userContext.envId,
        userId: userContext.userId,
        prompt,
        prevRecordId: lastRecordId,
        assistantRecordId: assistantMessageId,
        lastAssistantRecordId,
        imageBlocks: imageBlocks?.length ? imageBlocks : undefined,
      })
      preSavedUserRecordId = preSaved.userRecordId
    }

    // ── MCP Server ────────────────────────────────────────────────────

    // ── 获取认证凭据（API Key 或 OAuth Token）───────────────────────
    const envVars: Record<string, string> = {}

    if (process.env.CODEBUDDY_API_KEY) {
      // API Key 模式 - 直接使用密钥，无需 token 交换
      envVars.CODEBUDDY_API_KEY = process.env.CODEBUDDY_API_KEY
      if (process.env.CODEBUDDY_INTERNET_ENVIRONMENT) {
        envVars.CODEBUDDY_INTERNET_ENVIRONMENT = process.env.CODEBUDDY_INTERNET_ENVIRONMENT
      }
    } else if (useCustomModels()) {
      // 自定义模型模式 - DeepSeek 等第三方模型自带 url + apiKey (见 .config/.codebuddy/models.json)，
      // 实际 chat completions 请求用 model.apiKey，不需要 codebuddy 的 access token。
      // 但 codebuddy-headless 的 prepareRequest() 硬性检查 accessToken 非空（否则抛
      // AuthenticationRequiredError），这里塞个占位 token 绕过该检查。
      envVars.CODEBUDDY_AUTH_TOKEN = 'dummy-token-for-custom-models'
    } else {
      // OAuth 模式 - 通过 client_credentials 获取 token
      const authToken = await getOAuthToken()
      envVars.CODEBUDDY_AUTH_TOKEN = authToken
    }

    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let iterationTimeoutTimer: ReturnType<typeof setTimeout> | undefined
    let toolCallInProgress = false // Pause iteration timeout while tools are executing
    // Use the registry's AbortController so that session/cancel can directly abort the LLM query
    const registryRun = getAgentRun(conversationId)
    const abortController = registryRun?.abortController ?? new AbortController()

    function resetIterationTimeout() {
      if (iterationTimeoutTimer) clearTimeout(iterationTimeoutTimer)
      if (toolCallInProgress) return // Don't set timeout while tool is executing
      iterationTimeoutTimer = setTimeout(() => {
        abortController.abort()
        Promise.resolve((currentQuery as any)?.cleanup?.()).catch(() => {})
      }, ITERATION_TIMEOUT_MS)
    }

    let currentQuery: any = null
    // 记录 message loop 中捕获的真实运行错误（非 tool interrupt / 非用户 cancel），
    // 让 finally 块据此把 task.status / agent run.status 标为 'error'，
    // 进而让 routes/acp.ts 的 SSE 终结报文使用 stopReason='error' + ⚠️ 提示。
    let runtimeError: Error | undefined
    // 记录 runtime 计算出的真实 ACP stopReason（优先级高于 status 派生）
    let runtimeStopReason: StopReason | undefined
    // 流式阶段观察到的最近一次非中间态 stop_reason（end_turn/max_tokens/refusal/stop_sequence）
    let lastStreamStopReason: string | undefined
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
      // envVars.CODEBUDDY_BUNDLED_SKILLS_DIR = getBundledSkillsDir()
      if (sandboxInstance && detectedSandboxCwd) {
        // Pass sandbox cwd so skill-loader can scan remote skills dirs
        envVars.CODEBUDDY_SANDBOX_CWD = detectedSandboxCwd
      }

      // Build MCP servers config - pass the SDK-wrapped McpServer to query()
      const mcpServers: Record<string, any> = {}

      if (sandboxMcpClient) {
        mcpServers.cloudbase = sandboxMcpClient.sdkServer
      }

      const taskMcpList = JSON.parse(taskRecord?.mcpServerList || '[]') || []
      for (const mcp of taskMcpList) {
        if (!mcp.name) continue
        const serverType = mcp.type?.toLowerCase()
        if (serverType === 'http' || serverType === 'sse') {
          mcpServers[mcp.name] = {
            type: serverType,
            url: mcp.baseUrl,
            headers: mcp.headers || {},
          }
        } else if (serverType === 'stdio') {
          mcpServers[mcp.name] = {
            type: serverType,
            command: mcp.command,
            args: mcp.args,
            env: mcp.env,
          }
        }
      }

      // ── 执行 query ─────────────────────────────────────────────────

      // 用于在 canUseTool 中捕获被中断的写工具调用信息
      const pendingToolInterrupt: {
        value: { callId: string; toolName: string; input: unknown } | null
      } = { value: null }

      // Plan 模式映射：
      // - 前端传 `permissionMode: 'plan'` → SDK 切到 'plan',此时 agent 只规划不写
      //   （Plan 模式下 SDK 会把除 Read/Glob/Grep/ExitPlanMode 等"只读"工具外的写操作挡住）
      // - 其它情况沿用 'bypassPermissions'(与原有 canUseTool/hook 拦截协同)
      const sdkPermissionMode = requestedPermissionMode === 'plan' ? 'plan' : 'bypassPermissions'

      const publishableKey = await getPublishableKey(userContext.envId)

      // 构建 query 参数 - 和 tcb-headless-service buildQueryOptions 一致
      // 注意: cwd 必须是本地路径, 即使沙箱启用. 沙箱只提供 MCP 工具, agent 进程在本地运行.

      // 多模态 prompt：有图片时构建 ContentBlock[] 作为 UserMessage，否则直接用字符串
      let queryPrompt: string | any
      if (imageBlocks && imageBlocks.length > 0) {
        // SDK ImageContentBlock 格式: { type:'image', source:{ type:'base64', media_type, data } }
        const contentBlocks: any[] = imageBlocks.map((img) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.data,
          },
        }))
        if (prompt.trim()) {
          contentBlocks.push({ type: 'text', text: prompt })
        }
        // Wrap as AsyncIterable<UserMessage>
        const userMsg = {
          type: 'user' as const,
          session_id: conversationId,
          message: { role: 'user' as const, content: contentBlocks },
          parent_tool_use_id: null,
        }
        queryPrompt = (async function* () {
          yield userMsg
        })()
      } else {
        queryPrompt = prompt
      }

      const queryArgs = {
        prompt: queryPrompt,
        options: {
          model: modelId,
          permissionMode: sdkPermissionMode,
          allowDangerouslySkipPermissions: sdkPermissionMode === 'bypassPermissions',
          maxTurns,
          cwd: actualCwd,
          ...sessionOpts,
          includePartialMessages: true,
          systemPrompt: {
            append: isCodingMode
              ? getCodingSystemPrompt(userContext.envId, publishableKey) +
                '\n\n' +
                buildAppendPrompt(actualCwd, conversationId, userContext.envId, sandboxMode, true)
              : buildAppendPrompt(actualCwd, conversationId, userContext.envId, sandboxMode, false),
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

            // ExitPlanMode 处理（P2）：模型在 Plan 模式规划完毕后调用此工具呈交计划。
            // - 首次调用：发 tool_confirm 中断，input.plan 传给前端作为 planContent
            // - Resume 场景：按用户决策：
            //   · allow → 允许本次（SDK 会自动切出 plan 模式）
            //   · allow_always → 同 allow（ExitPlanMode 不适合加白名单，每次 plan 应单独审批）
            //   · deny → 继续停留在 Plan 模式
            //   · reject_and_exit_plan → 允许本次（让 SDK 自动退出 plan 模式），后续 turn 前端应传 permissionMode=default
            if (toolName === 'ExitPlanMode') {
              if (toolConfirmation && toolConfirmation.interruptId === toolUseId) {
                const action = toolConfirmation.payload.action
                if (action === 'allow' || action === 'allow_always' || action === 'reject_and_exit_plan') {
                  return {
                    behavior: 'allow' as const,
                    updatedInput: input as Record<string, unknown>,
                  }
                }
                // deny：继续规划
                return {
                  behavior: 'deny' as const,
                  message: '用户希望继续规划，请完善计划后再调用 ExitPlanMode',
                }
              }

              // 首次：发 tool_confirm 给前端展示 PlanModeCard
              if (toolUseId && pendingToolInterrupt) {
                pendingToolInterrupt.value = {
                  callId: toolUseId,
                  toolName,
                  input: input as Record<string, unknown>,
                }
              }
              wrappedCallback({
                type: 'tool_confirm',
                id: toolUseId,
                name: toolName,
                input: input as Record<string, unknown>,
              })
              return {
                behavior: 'deny' as const,
                message: '等待用户审批 Plan',
                interrupt: true,
              }
            }

            // 写工具确认处理（提取工具名，去掉 mcp__server__ 前缀）
            const normalizedToolName = normalizeToolName(toolName)

            if (WRITE_TOOLS.has(normalizedToolName)) {
              // (A) 白名单命中：直接放行，不打断
              if (conversationId && sessionPermissions.isAllowed(conversationId, normalizedToolName)) {
                return {
                  behavior: 'allow' as const,
                  updatedInput: input as Record<string, unknown>,
                }
              }

              // (B) Resume 场景：已有用户确认结果
              if (toolConfirmation && toolConfirmation.interruptId === toolUseId) {
                const action = toolConfirmation.payload.action

                if (action === 'allow_always') {
                  // 写入会话级白名单，后续同工具免确认
                  if (conversationId) {
                    sessionPermissions.allowAlways(conversationId, normalizedToolName)
                  }
                  return {
                    behavior: 'allow' as const,
                    updatedInput: input as Record<string, unknown>,
                  }
                }
                if (action === 'allow') {
                  return {
                    behavior: 'allow' as const,
                    updatedInput: input as Record<string, unknown>,
                  }
                }
                // 'deny' | 'reject_and_exit_plan' — 本次均按拒绝处理
                // TODO(P2): reject_and_exit_plan 需退出 Plan 模式
                return { behavior: 'deny' as const, message: '用户拒绝了此操作' }
              }

              // (C) 首次调用：发 tool_confirm 中断，等待用户决策
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
                    const normalizedToolName = normalizeToolName(toolName)

                    // 检查是否为需要确认的写工具
                    if (WRITE_TOOLS.has(normalizedToolName)) {
                      // (A) 白名单命中：直接放行，不打断
                      if (conversationId && sessionPermissions.isAllowed(conversationId, normalizedToolName)) {
                        return {
                          continue: true,
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'allow',
                          },
                        }
                      }

                      // (B) Resume 场景：已有用户确认结果
                      if (toolConfirmation && toolConfirmation.interruptId === actualToolUseId) {
                        const action = toolConfirmation.payload.action

                        if (action === 'allow_always') {
                          // 写入会话级白名单，后续同工具免确认
                          if (conversationId) {
                            sessionPermissions.allowAlways(conversationId, normalizedToolName)
                          }
                          return {
                            continue: true,
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              permissionDecision: 'allow',
                            },
                          }
                        }
                        if (action === 'allow') {
                          return {
                            continue: true,
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              permissionDecision: 'allow',
                            },
                          }
                        }
                        // 'deny' | 'reject_and_exit_plan' — 本次均按拒绝处理
                        // TODO(P2): reject_and_exit_plan 需退出 Plan 模式
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

                      // (C) 首次：捕获工具调用信息供 catch 持久化
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
          settingSources: ['project'],
          // P2: 移除 EnterPlanMode 的禁用——Plan 模式现改由显式 permissionMode='plan' + ExitPlanMode 工具驱动
          // disallowedTools: ['AskUserQuestion'],
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
      let resultEmitted = false // 防止双发 result（break messageLoop 路径 vs 自然结束路径）
      let lastMessageType = '' // 追踪最后一条消息类型，用于检测 GLM 截断
      let glmResumeCount = 0 // GLM end_turn 截断后自动 resume 的次数
      const MAX_GLM_RESUME = 5 // 最多自动 resume 次数，防止无限循环
      const tracker = createToolCallTracker()

      resetIterationTimeout()

      try {
        console.log('[Agent] starting for-await loop...')

        // DEBUG: log all messages from messageLoop to a file (enabled via AGENT_DEBUG_JSONL=1)
        let debugMsgLogPath: string | null = null
        if (DEBUG_JSONL) {
          const debugMsgLogDir = path.resolve(actualCwd, 'debug-jsonl')
          mkdirSync(debugMsgLogDir, { recursive: true })
          debugMsgLogPath = path.join(debugMsgLogDir, `${conversationId}_messageloop_${Date.now()}.jsonl`)
        }

        messageLoop: for await (const message of q) {
          console.log('[Agent] message type:', message.type, JSON.stringify(message).slice(0, 300))

          // DEBUG: write full message to log file
          if (debugMsgLogPath) {
            try {
              appendFileSync(debugMsgLogPath, JSON.stringify({ ts: Date.now(), ...message }) + '\n')
            } catch {
              // ignore debug log errors
            }
          }

          // Tool result (user message) means tool execution completed — resume timeout
          if (message.type === 'user') {
            lastMessageType = 'user'
            toolCallInProgress = false
            // P4: 工具结果已回流,代理即将再次让模型推理
            emitPhase('model_responding')
          }

          // Assistant message with tool_use means tool is about to execute — pause timeout
          if (message.type === 'assistant') {
            lastMessageType = 'assistant'
            const content = (message as any).message?.content
            const toolUseBlock = Array.isArray(content) ? content.find((b: any) => b.type === 'tool_use') : undefined
            if (toolUseBlock) {
              toolCallInProgress = true
              if (iterationTimeoutTimer) {
                clearTimeout(iterationTimeoutTimer)
                iterationTimeoutTimer = undefined
              }
              // P4: 模型决定调用工具 → 进入工具执行阶段,附带工具名
              emitPhase('tool_executing', (toolUseBlock as any).name)
            } else if (Array.isArray(content)) {
              // 纯文本/思考型 assistant 消息 → 模型仍在响应中
              emitPhase('model_responding')
            }
          }

          // P4: 收到第一条 agent 消息时,从 preparing 切到 model_responding
          if (!firstMessageReceived) {
            emitPhase('model_responding')
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
            case 'stream_event': {
              lastMessageType = 'stream_event'
              // P7: SDKPartialAssistantMessage 顶层 parent_tool_use_id 透传到子工具链路
              const parentId = (message as any).parent_tool_use_id ?? null
              const event = (message as any).event
              // 捕获本轮模型 stop_reason 作为 ACP stopReason 的参考（最终以 result.subtype 为主）
              if (event?.type === 'message_delta') {
                const sr = event?.delta?.stop_reason
                if (sr && sr !== 'tool_use' && sr !== 'pause_turn') {
                  lastStreamStopReason = sr
                }
              }
              this.handleStreamEvent(event, tracker, wrappedCallback, parentId)
              break
            }
            case 'user': {
              const content = (message as any).message?.content
              // P7: SDKUserMessage.parent_tool_use_id 透传
              const parentId = (message as any).parent_tool_use_id ?? null
              if (content) this.handleToolResults(content, tracker, wrappedCallback, parentId)
              break
            }
            case 'assistant': {
              // P7: SDKAssistantMessage.parent_tool_use_id 透传
              const parentId = (message as any).parent_tool_use_id ?? null
              this.handleToolNotFoundErrors(message, tracker, wrappedCallback)
              this.handleAssistantToolUseInputs(message, tracker, wrappedCallback, parentId)
              break
            }
            case 'result': {
              // P4: agent 本轮执行完毕
              resultEmitted = true
              emitPhase('idle')
              const resultSubtype = (message as any).subtype as string | undefined
              runtimeStopReason = mapCodebuddyStopReason(resultSubtype, lastStreamStopReason)
              wrappedCallback({
                type: 'result',
                content: JSON.stringify({
                  subtype: resultSubtype,
                  duration_ms: (message as any).duration_ms,
                }),
              })
              break messageLoop
            }
            default:
              break
          }
        }
        // for-await 循环自然结束（SDK 没有发 'result' 消息，如 GLM 的 end_turn 行为）
        // 检测最后一条消息类型：如果是 user（tool_result），说明模型还想继续
        // 但被 SDK 的 end_turn 双发 bug 截断了——自动发起 resume 继续执行
        let consecutiveDryResumes = 0
        const MAX_DRY_RESUMES = 2 // 连续 N 次 resume 无任何内容产出则放弃
        while (
          !resultEmitted &&
          lastMessageType === 'user' &&
          glmResumeCount < MAX_GLM_RESUME &&
          consecutiveDryResumes < MAX_DRY_RESUMES
        ) {
          glmResumeCount++
          console.log(
            `[Agent] GLM end_turn truncation detected (last msg=user), auto-resuming (${glmResumeCount}/${MAX_GLM_RESUME})...`,
          )
          emitPhase('model_responding')
          // 重新发起 query，使用 resume 模式继续当前会话
          const resumeArgs = {
            ...queryArgs,
            prompt: '', // resume 不需要新 prompt，模型从 tool_result 继续
            options: {
              ...(queryArgs as any).options,
              ...sessionOpts,
              resume: conversationId,
              sessionId: conversationId,
            },
          } as any
          const q2 = query(resumeArgs)
          currentQuery = q2

          let resumeHadContent = false // 追踪本次 resume 是否产出了有意义的内容
          for await (const message of q2) {
            console.log('[Agent] [resume] message type:', message.type, JSON.stringify(message).slice(0, 300))
            if (debugMsgLogPath) {
              try {
                appendFileSync(debugMsgLogPath, JSON.stringify({ ts: Date.now(), resumed: true, ...message }) + '\n')
              } catch {
                /* ignore */
              }
            }

            // assistant / stream_event 表示模型产出了内容（非空 resume）
            if (message.type === 'assistant' || message.type === 'stream_event') {
              resumeHadContent = true
            }

            if (message.type === 'user') {
              lastMessageType = 'user'
              toolCallInProgress = false
              emitPhase('model_responding')
            }
            if (message.type === 'assistant') {
              lastMessageType = 'assistant'
              const content = (message as any).message?.content
              const toolUseBlock = Array.isArray(content) ? content.find((b: any) => b.type === 'tool_use') : undefined
              if (toolUseBlock) {
                toolCallInProgress = true
                if (iterationTimeoutTimer) {
                  clearTimeout(iterationTimeoutTimer)
                  iterationTimeoutTimer = undefined
                }
                emitPhase('tool_executing', (toolUseBlock as any).name)
              } else if (Array.isArray(content)) {
                emitPhase('model_responding')
              }
            }
            if (message.type === 'stream_event') {
              lastMessageType = 'stream_event'
              const parentId = (message as any).parent_tool_use_id ?? null
              this.handleStreamEvent((message as any).event, tracker, wrappedCallback, parentId)
            }

            resetIterationTimeout()

            switch (message.type) {
              case 'error':
                throw new Error((message as any).error || 'Unknown error')
              case 'user': {
                const content = (message as any).message?.content
                const parentId = (message as any).parent_tool_use_id ?? null
                if (content) this.handleToolResults(content, tracker, wrappedCallback, parentId)
                break
              }
              case 'assistant': {
                const parentId = (message as any).parent_tool_use_id ?? null
                this.handleToolNotFoundErrors(message, tracker, wrappedCallback)
                this.handleAssistantToolUseInputs(message, tracker, wrappedCallback, parentId)
                break
              }
              case 'result':
                resultEmitted = true
                emitPhase('idle')
                wrappedCallback({
                  type: 'result',
                  content: JSON.stringify({
                    subtype: (message as any).subtype,
                    duration_ms: (message as any).duration_ms,
                  }),
                })
                break
              default:
                break
            }
            if (resultEmitted) break
          }

          // 检测本次 resume 是否为"dry"（无任何 assistant/stream_event 内容产出）
          if (!resumeHadContent && !resultEmitted) {
            consecutiveDryResumes++
            console.log(
              `[Agent] Resume ${glmResumeCount} was dry (no content), consecutiveDry=${consecutiveDryResumes}/${MAX_DRY_RESUMES}`,
            )
          } else {
            consecutiveDryResumes = 0
          }
        }

        // 仍然没有 result，补发 synthetic result
        if (!resultEmitted) {
          console.log('[Agent] for-await loop ended without result message, emitting synthetic result')
          emitPhase('idle')
          wrappedCallback({
            type: 'result',
            content: JSON.stringify({ subtype: 'success', duration_ms: 0 }),
          })
        }
      } catch (err) {
        console.error('[Agent] message loop error:', err)

        // 工具被 deny+interrupt 中断 → SDK 内部把 interrupt_result 转成
        //   Error("Permission denied for tool(s): <toolName>")
        // 并回填到 ExecutionError.errors[0]。这是预期内的"等待用户审批"路径，
        // 已经通过 canUseTool callback 触发了 tool_confirm/ask_user 回调，静默返回即可。
        if (err instanceof ExecutionError && err.errors?.[0]?.startsWith('Permission denied for tool(s):')) {
          console.log('[Agent] ExecutionError (tool interrupt), returning')
          return
        }

        // Transport closed：CLI 子进程退出。如果用户已经 cancel，是预期路径，静默返回；
        // 否则视为异常，走错误分支让 finally 标 error 状态。
        if (err instanceof Error && err.message === 'Transport closed') {
          if (getAgentRun(conversationId)?.status === 'cancelled') {
            console.error('[Agent] CLI process exited (cancelled by user)')
            return
          }
          console.error('[Agent] CLI process exited unexpectedly')
          runtimeError = err
          runtimeStopReason = 'refusal'
          wrappedCallback({ type: 'error', content: 'Agent CLI 子进程异常退出' })
          return
        }

        // 真实运行错误（如 SDK 反序列化失败、模型返回异常等）：
        // 1) 通过 wrappedCallback 实时发一条 type:'error' → SSE log/agent_message_chunk
        // 2) 记录 runtimeError + runtimeStopReason，让 finally 块把 task/run 标为 'error'
        //    + 让 routes/acp.ts 终结时按 ACP 合法值发 stopReason（error_max_turns →
        //    max_turn_requests，其它 → refusal），并发 ⚠️ 提示
        if (err instanceof ExecutionError) {
          const message = err.errors?.[0] || err.message || 'Agent 执行失败'
          const subtype = (err as { subtype?: string }).subtype
          runtimeStopReason = mapExecutionErrorStopReason(subtype)
          wrappedCallback({ type: 'error', content: message })
          runtimeError = err
          return
        }

        throw err
      }
    } finally {
      console.log('[Agent] entering finally block')
      if (connectTimer) clearTimeout(connectTimer)
      if (iterationTimeoutTimer) clearTimeout(iterationTimeoutTimer)

      // Explicitly signal the query iterator to stop, preventing the SDK's
      // internal stdio pipe from writing after the for-await loop exits.
      // This avoids EPIPE errors when the child process tries to write to
      // a closed pipe during cleanup.
      // Note: these may reject with "Session not found" when cancel races with
      // the SDK's internal ProcessTransport cleanup — safe to ignore.
      try {
        if (currentQuery) {
          const returnResult = typeof currentQuery.return === 'function' ? currentQuery.return() : undefined
          const cleanupResult = typeof currentQuery.cleanup === 'function' ? currentQuery.cleanup() : undefined
          await Promise.allSettled([returnResult, cleanupResult].filter(Boolean))
        }
      } catch {
        // ignore cleanup errors
      }

      // Flush remaining events to DB FIRST — this must happen before completeAgent,
      // so any in-flight events are persisted for SSE replay on reconnect.
      try {
        await eventBuffer.close()
      } catch {
        // Non-critical
      }

      // ── 判断是否被用户取消 ──
      const wasCancelled = getAgentRun(conversationId)?.status === 'cancelled'

      // ═══════════════════════════════════════════════════════════════════════
      // CRITICAL: Call completeAgent EARLY — right after eventBuffer flush.
      //
      // Without this, the finally block spends 5-15s on syncMessages/git etc.
      // while the registry still shows status='running'. If the user confirms
      // a tool during this window, chatStream() sees isAgentRunning()=true
      // and silently drops the confirmation.
      //
      // Strategy: complete now with what we know (runtimeError). If syncError
      // occurs later, upgrade the status to 'error' via a second completeAgent.
      // ═══════════════════════════════════════════════════════════════════════
      const earlyStatus: 'completed' | 'error' | 'cancelled' = wasCancelled
        ? 'cancelled'
        : runtimeError
          ? 'error'
          : 'completed'
      const earlyStopReason: StopReason | undefined = wasCancelled ? 'cancelled' : runtimeStopReason
      completeAgent(conversationId, earlyStatus, runtimeError?.message, earlyStopReason)
      // Cleanup stream events NOW — after completeAgent() so the poll loop sees
      // isDone=true and drains remaining events before we remove them from DB.
      // Give poll loop one cycle (500ms) to drain before cleaning.
      setTimeout(() => {
        persistenceService.cleanupStreamEvents(conversationId, assistantMessageId).catch(() => {
          // Non-critical
        })
      }, 600)

      // ── Post-run cleanup (SSE can now detect completion) ────────────────

      // Archive to git if sandbox was used
      if (sandboxInstance) {
        try {
          await pushToUserGit(sandboxInstance, conversationId, conversationId, prompt)
        } catch (err) {
          console.error('[Agent] Push to user git failed:', (err as Error).message)
        }

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
        await persistenceService.finalizePendingRecords(assistantMessageId, wasCancelled ? 'cancel' : 'done')
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

      if (runtimeError && !syncError) {
        finalStatus = 'error'
      }

      // Update task status in DB
      if (!wasCancelled) {
        try {
          await getDb().tasks.update(conversationId, {
            status: finalStatus === 'error' ? 'error' : 'completed',
            completedAt: Date.now(),
            updatedAt: Date.now(),
          })
        } catch {
          // Non-critical
        }
      }

      // 兜底: finalizePendingRecords 失败时延迟重试
      if (syncError) {
        setTimeout(async () => {
          try {
            await persistenceService.finalizePendingRecords(assistantMessageId, 'error')
            console.log('[Agent] Deferred finalize succeeded for', conversationId)
          } catch {
            console.error('[Agent] Deferred finalize also failed for', conversationId)
          }
        }, 5000)

        // Upgrade the early-completed status to 'error'
        completeAgent(conversationId, 'error', syncError.message, 'refusal')
      }

      if (syncError) {
        throw syncError
      }
    }
  }

  // ─── Stream Event Handlers ──────────────────────────────────────────

  private handleStreamEvent(
    event: any,
    tracker: ToolCallTracker,
    callback: AgentCallback,
    parentToolUseId: string | null = null,
  ): void {
    if (!event) return
    switch (event.type) {
      case 'content_block_delta':
        this.handleContentBlockDelta(event, tracker, callback)
        break
      case 'content_block_start':
        this.handleContentBlockStart(event, tracker, callback, parentToolUseId)
        break
      case 'content_block_stop':
        this.handleContentBlockStop(event, tracker, callback, parentToolUseId)
        break
    }
  }

  private handleContentBlockStart(
    event: any,
    tracker: ToolCallTracker,
    callback: AgentCallback,
    parentToolUseId: string | null = null,
  ): void {
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
    callback({
      type: 'tool_use',
      name: block.name,
      input: block.input || {},
      id: block.id,
      parent_tool_use_id: parentToolUseId,
    })
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

  private handleContentBlockStop(
    event: any,
    tracker: ToolCallTracker,
    callback: AgentCallback,
    parentToolUseId: string | null = null,
  ): void {
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
        callback({
          type: 'tool_input_update',
          name: toolInfo.name,
          input: parsedInput,
          id: toolId,
          parent_tool_use_id: parentToolUseId,
        })
      } catch {
        // ignore
      }
    }
    tracker.blockIndexToToolId.delete(event.index)
  }

  private handleToolResults(
    content: any[],
    tracker: ToolCallTracker,
    callback: AgentCallback,
    parentToolUseId: string | null = null,
  ): void {
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
        parent_tool_use_id: parentToolUseId,
      })
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
  private handleAssistantToolUseInputs(
    msg: any,
    tracker: ToolCallTracker,
    callback: AgentCallback,
    parentToolUseId: string | null = null,
  ): void {
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
      if (hasInput && pendingTool && Object.keys(pendingTool.input as object).length === 0) {
        pendingTool.input = block.input
        callback({
          type: 'tool_input_update',
          name: block.name || pendingTool.name,
          input: block.input,
          id: toolId,
          parent_tool_use_id: parentToolUseId,
        })
      }
    }
  }
}

export const cloudbaseAgentService = new CloudbaseAgentService()
