/**
 * OpencodeAcpRuntime
 *
 * 基于 ACP 协议的 OpenCode agent runtime。
 * 继承 BaseAgentRuntime 获取沙箱、MCP、系统提示等公共基础设施。
 *
 * 架构（"项目级 tool override + env 注入 + 共享沙箱"）：
 *
 *   工具文件直接 checked in 到 .opencode/tools/（无需安装步骤）。
 *   同名 custom tool 覆盖 opencode builtin — read/write/bash/edit/grep/glob。
 *
 *   每次 chatStream：
 *     1. BaseAgentRuntime.setupSandbox() 创建/获取 SCF 沙箱（共享实例）
 *     2. spawn opencode acp，通过 child env 注入：
 *          OPENCODE_CONFIG_DIR=<projectRoot>/.opencode  （隔离用户全局配置）
 *          SANDBOX_MODE=1
 *          SANDBOX_BASE_URL=<沙箱 HTTPS>（来自基类 sandbox）
 *          SANDBOX_AUTH_HEADERS_JSON=<凭证 JSON>
 *     3. 基类构建的 MCP endpoint 传给 opencode newSession，opencode 可直接调用
 *        CloudBase MCP 工具（数据库、云函数、存储等）
 *     4. 基类 systemPrompt 拼到 history context 前面，确保任务分类 + 沙箱上下文生效
 *     5. ACP 握手 → newSession → prompt → 收 session/update 流 → 翻译为 AgentCallbackMessage
 */

import { v4 as uuidv4 } from 'uuid'
import { ClientSideConnection } from '@agentclientprotocol/sdk'
import type { AgentCallback, AgentCallbackMessage, AgentOptions } from '@coder/shared'
import type { ChatStreamResult } from './types.js'
import type { ModelInfo } from '../cloudbase-agent.service.js'
import {
  registerAgent,
  isAgentRunning,
  getAgentRun,
  completeAgent,
  removeAgent,
  getNextSeq,
} from '../agent-registry.js'
import { persistenceService } from '../persistence.service.js'
import { CloudbaseAgentService } from '../cloudbase-agent.service.js'
import { getAcpTransportFactory, getResolvedBin, type AcpTransport } from './acp-transport.js'
import { getOpencodeConfigDir } from './opencode-installer.js'
import { resolveModels } from './opencode-catalog.js'
import { registerPending, resolvePending, rejectPendingForConversation } from './pending-permission-registry.js'
import { resolvePendingQuestion, rejectPendingQuestionsForConversation } from './pending-question-registry.js'
import { OpencodeMessageBuilder, findLastRecordIds, buildHistoryContextPrompt } from './opencode-message-builder.js'
import { BaseAgentRuntime } from './base-runtime.js'
import type { SandboxInstance } from '../../sandbox/scf-sandbox-manager.js'
import { archiveToGit } from '../../sandbox/git-archive.js'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// ─── Config ──────────────────────────────────────────────────────────────

// OPENCODE_BIN 常量已删除——统一使用 acp-transport.ts 的 getResolvedBin()
// 好处：单一权威来源，isAvailable() 与 spawn 使用同一路径，支持 fallback 候选
const DEFAULT_OPENCODE_MODEL = process.env.OPENCODE_DEFAULT_MODEL || 'custom/default'

/** 沙箱内工作目录（agent 看到的"当前目录"概念）。相对路径工具都会以此为根。 */
const SANDBOX_WORKSPACE_ROOT = process.env.SANDBOX_WORKSPACE_ROOT || '.'

// ─── State ───────────────────────────────────────────────────────────────

/**
 * 活跃 agent 的 liveCallback 注册表。
 *
 * 为什么需要？—— Resume 场景：第一轮 chatStream 的 SSE 流已结束（前端看到
 * tool_confirm 后切 waiting_for_interaction），第二轮 chatStream 是**新的
 * HTTP 请求**，带新的 callback。pending 恢复后，后续的 session/update 必须
 * 用**新 callback** 推给新 SSE 流（而不是第一轮的 callback，那个 stream 已关）。
 *
 * 所以每次 chatStream（包括 resume 入口）都要更新这个 map，launchAgent 内部的
 * emit 函数通过 getLiveCallback() 间接取最新值。
 */
const liveCallbacks = new Map<string, AgentCallback | null>()

function registerLiveCallback(conversationId: string, cb: AgentCallback | null): void {
  liveCallbacks.set(conversationId, cb)
}

function updateLiveCallback(conversationId: string, cb: AgentCallback | null): void {
  liveCallbacks.set(conversationId, cb)
}

function getLiveCallback(conversationId: string): AgentCallback | null {
  return liveCallbacks.get(conversationId) ?? null
}

function clearLiveCallback(conversationId: string): void {
  liveCallbacks.delete(conversationId)
}

/**
 * Per-conversation emitter 注册表：launchAgent 里写入闭包 emit，
 * 供 routes/acp.ts 的 /internal/ask-user handler 对 ask_user 消息广播。
 */
const emitters = new Map<string, (msg: AgentCallbackMessage) => Promise<void>>()

function registerEmitter(conversationId: string, emit: (m: AgentCallbackMessage) => Promise<void>): void {
  emitters.set(conversationId, emit)
}

function clearEmitter(conversationId: string): void {
  emitters.delete(conversationId)
}

/**
 * 对外暴露：routes/acp.ts 调此方法给指定 conversation 发 AgentCallbackMessage。
 * 主要用于 /internal/ask-user endpoint：tool 请求问用户 → emit ask_user → SSE 推前端。
 */
export async function emitForConversation(conversationId: string, msg: AgentCallbackMessage): Promise<void> {
  const emit = emitters.get(conversationId)
  if (!emit) throw new Error(`no emitter registered for conversation ${conversationId}`)
  await emit(msg)
}

/**
 * Internal-endpoint 共享 token。
 *
 * 在 server 启动时生成一次（惰性），通过 env 注入 opencode 子进程。
 * 子进程的 custom tool 通过 `X-Internal-Token` header 回调 server 时认证。
 */
let askUserToken: string | null = null
export function getAskUserToken(): string {
  if (!askUserToken) {
    // 16 字节十六进制，足够强的临时 token
    askUserToken = cryptoRandomToken()
  }
  return askUserToken
}

function cryptoRandomToken(): string {
  // 16 bytes hex, no external deps
  const bytes = new Uint8Array(16)
  // Node runtime 保证有 crypto.getRandomValues
  ;(globalThis.crypto as Crypto).getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── Runtime ─────────────────────────────────────────────────────────────

export class OpencodeAcpRuntime extends BaseAgentRuntime {
  readonly name = 'opencode-acp'

  async isAvailable(): Promise<boolean> {
    // getResolvedBin() 是纯同步 existsSync，不需要子进程 --version
    // 优点：更快（无 spawn 开销）、更可靠（不受 PATH 环境变量/shell 变更影响）
    return getResolvedBin() !== null
  }

  async getSupportedModels(): Promise<ModelInfo[]> {
    // 合并 models.dev catalog + .opencode/opencode.json 的 provider override，按 env 过滤。
    // 行为对齐 opencode 自身：
    //   - provider 写 `{}` 即启用（catalog 已有的 provider 自动获得 name/npm/api/models）
    //   - provider 级 env（如 DEEPSEEK_API_KEY）命中则算可用
    //   - options.apiKey 中的 {env:VAR} 占位符会被解析
    //   - whitelist/blacklist/enabled_providers/disabled_providers 支持
    const models = await resolveModels({
      opencodeConfigDir: getOpencodeConfigDir(),
      env: process.env,
    })
    if (models.length > 0) return models
    // 兜底：env 默认模型（保留旧行为，避免前端空列表）
    const defaultModel = DEFAULT_OPENCODE_MODEL
    const vendor = process.env.OPENCODE_PROVIDER_NAME || 'Custom'
    return [{ id: defaultModel, name: defaultModel.split('/').pop() || defaultModel, vendor }]
  }

  async chatStream(prompt: string, callback: AgentCallback | null, options: AgentOptions): Promise<ChatStreamResult> {
    const conversationId = options.conversationId || uuidv4()

    // Resume path：已有挂起的 agent + 携带 toolConfirmation / askAnswers
    //   → 不 spawn 新进程，直接 resolve 挂起的 permission Promise / question HTTP
    //   → opencode 收到 outcome/answers 后继续执行，session/update 流继续
    if (isAgentRunning(conversationId)) {
      const run = getAgentRun(conversationId)!

      // 更新 liveCallback 到新 SSE 流（第一轮的 SSE 可能已关）
      updateLiveCallback(conversationId, callback)

      if (options.toolConfirmation) {
        const resolved = resolvePending(
          conversationId,
          options.toolConfirmation.interruptId,
          options.toolConfirmation.payload.action,
        )
        if (!resolved) {
          console.warn(
            `[OpencodeAcpRuntime] toolConfirmation arrived but no pending registration for interruptId=${options.toolConfirmation.interruptId}`,
          )
        }
      }

      if (options.askAnswers) {
        // askAnswers 结构：{ [assistantMessageId|recordId]: { toolCallId, answers } }
        // 我们只关心 value 里的 toolCallId + answers
        for (const entry of Object.values(options.askAnswers)) {
          const resolved = resolvePendingQuestion(conversationId, entry.toolCallId, entry.answers)
          if (!resolved) {
            console.warn(
              `[OpencodeAcpRuntime] askAnswers arrived but no pending question for toolCallId=${entry.toolCallId}`,
            )
          }
        }
      }

      if (!options.toolConfirmation && !options.askAnswers && process.env.OPENCODE_ACP_DEBUG) {
        console.log(
          `[OpencodeAcpRuntime] chatStream re-entered without resume payload (conv=${conversationId}); returning existing turn`,
        )
      }
      return { turnId: run.turnId, alreadyRunning: true }
    }

    // 非 resume：preSave user + assistant(pending) 记录，取 assistantRecordId 作为 turnId
    // (与 Tencent SDK runtime 一致：turnId == assistantMessageId)
    let preSaved: { userRecordId: string; assistantRecordId: string } | null = null
    if (options.envId) {
      try {
        // 找上一轮 record ids，维护 replyTo / parentId 链
        const { prevRecordId, lastAssistantRecordId } = await findLastRecordIds(
          conversationId,
          options.envId,
          options.userId || 'anonymous',
        )
        preSaved = await persistenceService.preSavePendingRecords({
          conversationId,
          envId: options.envId,
          userId: options.userId || 'anonymous',
          prompt,
          prevRecordId,
          lastAssistantRecordId,
        })
      } catch (e) {
        console.warn(
          '[OpencodeAcpRuntime] preSavePendingRecords failed (continuing without persistence):',
          (e as Error).message,
        )
      }
    }

    const turnId = preSaved?.assistantRecordId ?? uuidv4()
    const abortController = new AbortController()

    registerAgent({
      conversationId,
      turnId,
      envId: options.envId || '',
      userId: options.userId || 'anonymous',
      abortController,
    })

    // 记录本轮的 liveCallback（resume 时可替换，因为 SSE 流可能已更新）
    registerLiveCallback(conversationId, callback)

    // 本轮预存的 user/assistant record ids（用于 buildHistoryContextPrompt 排除）
    const currentRecordIds = preSaved ? new Set<string>([preSaved.userRecordId, preSaved.assistantRecordId]) : undefined

    this.launchAgent(prompt, callback, options, conversationId, turnId, abortController, currentRecordIds).catch(
      (err) => {
        console.error('[OpencodeAcpRuntime] background agent error:', err)
      },
    )

    return { turnId, alreadyRunning: false }
  }

  private async launchAgent(
    prompt: string,
    _liveCallback: AgentCallback | null,
    options: AgentOptions,
    conversationId: string,
    turnId: string,
    abortController: AbortController,
    excludeHistoryRecordIds?: ReadonlySet<string>,
  ): Promise<void> {
    const envId = options.envId || ''
    const userId = options.userId || 'anonymous'
    const modelId = options.model || DEFAULT_OPENCODE_MODEL

    // 消息持久化 builder：累积事件 → UnifiedMessagePart[] → 落 messages 集合
    // turnId 即是 preSave 返回的 assistantRecordId
    const messageBuilder = envId
      ? new OpencodeMessageBuilder({
          conversationId,
          assistantRecordId: turnId,
          envId,
          userId,
        })
      : null

    // emit 每次动态取 liveCallback（resume 时回调会被替换）
    // 第一轮由 chatStream 调用 registerLiveCallback 写入；第二轮（resume）由
    // chatStream 的 resume 分支更新。
    // 同时把消息喂给 messageBuilder 做持久化
    const emit = makeEmitter({ envId, userId, conversationId, turnId, messageBuilder })
    registerEmitter(conversationId, emit)

    // 记录最终 record 状态；finally 里用它调 messageBuilder.finalize()
    let finalRecordStatus: 'done' | 'error' | 'cancel' = 'error'

    let transport: AcpTransport | null = null
    let sandbox: SandboxInstance | null = null
    let sandboxMcpClient: { close: () => Promise<void> } | null = null
    let sessionWorkingDir: string | null = null

    try {
      // 0. 确保 opencode.json 已从 example 初始化（若不存在）

      // 1. 使用基类共享设施初始化沙箱 + MCP + 系统提示
      const isCodingMode = options.mode === 'coding'
      let sandboxResult: Awaited<ReturnType<typeof this.setupSandbox>> | null = null

      if (envId) {
        await emit({ type: 'agent_phase', phase: 'preparing' })
        sandboxResult = await this.setupSandbox({
          conversationId,
          envId,
          userId,
          userCredentials: options.userCredentials,
          isCodingMode,
          callback: getLiveCallback(conversationId),
          model: modelId,
        })
        sandbox = sandboxResult.sandbox
        sandboxMcpClient = sandboxResult.mcpClient
        // Coding mode: auto-allow all write tools + mark preview ready
        if (isCodingMode && conversationId) {
          this.allowAllWriteToolsForCodingMode(conversationId)
          await this.markCodingPreviewReady(conversationId, sandbox)
        }
      }

      // 构建系统提示
      let systemPrompt = ''
      if (envId) {
        const promptResult = await this.buildSystemPrompt({
          envId,
          isCodingMode,
          sandboxCwd: sandboxResult?.sandboxCwd || null,
          sandboxMode: sandboxResult?.sandboxMode || 'shared',
          conversationId,
        })
        systemPrompt = promptResult.systemPrompt
      }

      // 2. 工作目录
      //    - 沙箱模式：opencode cwd 用临时占位目录（opencode 需要一个本地目录启动，
      //      但真实读写由 tools 转发到沙箱，不依赖这个目录）
      //    - 本地模式：用 options.cwd 或临时目录
      sessionWorkingDir = options.cwd ?? path.join(os.tmpdir(), `opencode-session-${uuidv4()}`)
      if (!fs.existsSync(sessionWorkingDir)) {
        fs.mkdirSync(sessionWorkingDir, { recursive: true })
      }

      // 3. 构造 spawn env — 把沙箱凭证 + AskUser 回调 URL 通过 env 注入 opencode 子进程
      const childEnv: Record<string, string> = {
        // 指向项目内 .opencode/，隔离用户全局配置
        OPENCODE_CONFIG_DIR: getOpencodeConfigDir(),
      }
      if (sandbox) {
        const authHeaders = await sandbox.getAuthHeaders()
        childEnv.SANDBOX_MODE = '1'
        childEnv.SANDBOX_BASE_URL = sandbox.baseUrl
        childEnv.SANDBOX_AUTH_HEADERS_JSON = JSON.stringify(authHeaders)
        childEnv.SANDBOX_WORKSPACE_ROOT = SANDBOX_WORKSPACE_ROOT
      } else {
        childEnv.SANDBOX_MODE = '0'
      }

      // AskUser 内部 HTTP 回调：question custom tool execute 时 fetch 此 URL
      // URL 从 ASK_USER_BASE_URL env（server 启动时设置）+ path + 查询参数拼成
      const askUserBase = process.env.ASK_USER_BASE_URL || ''
      if (askUserBase) {
        childEnv.ASK_USER_URL = `${askUserBase.replace(/\/$/, '')}/api/agent/internal/ask-user`
        childEnv.ASK_USER_TOKEN = getAskUserToken()
        childEnv.ASK_USER_CONVERSATION_ID = conversationId
      }

      // 4. spawn opencode acp
      const factory = getAcpTransportFactory('local-stdio')
      transport = await factory({
        cwd: sessionWorkingDir,
        signal: abortController.signal,
        debug: process.env.OPENCODE_ACP_DEBUG === '1',
        env: childEnv,
      })

      // 5. 建立 ACP connection
      const conn = new ClientSideConnection(
        () => ({
          sessionUpdate: async (params) => {
            await this.handleSessionUpdate(params.update, emit)
          },
          requestPermission: async (params) => {
            // ACP 权限请求 → 桥接到前端 ToolConfirm UI
            //
            // 流程：
            //   1. 生成/取 interruptId（前端用来回传 toolConfirmation）
            //   2. 发 AgentCallbackMessage(type='tool_confirm')：前端显示确认卡片
            //   3. registerPending 注册一个挂起 Promise
            //   4. await pending：handler 卡住 → opencode 也卡住
            //   5. 前端用户选择 → 下一轮 chatStream 带 toolConfirmation
            //   6. chatStream 调 resolvePending → 本 Promise resolve → handler 返回
            //   7. opencode 收到 outcome 后继续
            const interruptId = params.toolCall?.toolCallId || uuidv4()
            const toolName = params.toolCall?.title || 'unknown'
            const toolInput = (params.toolCall?.rawInput as Record<string, unknown>) || {}

            await emit({
              type: 'tool_confirm',
              id: interruptId,
              name: toolName,
              input: toolInput,
            })

            try {
              // 这里会长时间挂起 — 直到外部 resolvePending 或 rejectPendingForConversation
              return await registerPending(conversationId, interruptId, params.options as any[])
            } catch (e) {
              // abort/reject 时 fallback：让 opencode 收到拒绝（避免它卡死）
              const reject =
                params.options.find((o: { kind: string }) => o.kind === 'reject_once') ??
                params.options[params.options.length - 1]
              console.warn(
                `[OpencodeAcpRuntime] pending permission rejected (conv=${conversationId}, interrupt=${interruptId}):`,
                (e as Error).message,
              )
              return { outcome: { outcome: 'selected', optionId: reject!.optionId } }
            }
          },
        }),
        transport.stream,
      )

      // 6. ACP 握手
      await conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      })

      // 7. 创建 session — 注入 CloudBase MCP server（全局 /cloudbase-mcp 路由）
      // 全局 HTTP MCP server 挂载在 server 进程的 /cloudbase-mcp 路径。
      // 认证：复用 base-runtime.setupSandbox() 已签发的 sessionJwe（同 nex_session cookie 格式），
      //      与 storage/presign 的 tool-override 机制完全一致。
      // sandboxAuth 来自 sandbox.getAuthHeaders()，包含所有沙箱需要的 headers。
      // X-Session-Id 仅用于本地工具 schema 缓存 key，不传给沙箱。
      const mcpServers: Array<{
        type: 'http'
        name: string
        url: string
        headers: Array<{ name: string; value: string }>
      }> = []
      if (sandbox && sandboxResult?.sessionJwe) {
        const authHeaders = await sandbox.getAuthHeaders()
        const serverPort = Number(process.env.PORT) || 3001
        mcpServers.push({
          type: 'http',
          name: 'cloudbase',
          url: `http://localhost:${serverPort}/cloudbase-mcp`,
          headers: [
            { name: 'X-Sandbox-Url', value: sandbox.baseUrl },
            { name: 'X-Sandbox-Auth', value: JSON.stringify(authHeaders) },
            { name: 'X-Session-Id', value: conversationId },
            { name: 'Cookie', value: `nex_session=${sandboxResult.sessionJwe}` },
          ],
        })
      }
      const newRes = await conn.newSession({
        cwd: sessionWorkingDir,
        mcpServers,
      })
      const opencodeSessionId = newRes.sessionId

      // 8. 选择模型
      try {
        await conn.unstable_setSessionModel({
          sessionId: opencodeSessionId,
          modelId,
        })
      } catch (e) {
        console.warn('[OpencodeAcpRuntime] setSessionModel failed:', (e as Error).message)
      }

      // 9. 发送 prompt（阻塞直到完成）
      //
      // OpenCode 每次新 session 是空白上下文，如果之前 conversation 有历史消息，
      // 把它们作为 context prefix 拼到本轮 prompt 前面，让 LLM 能做多轮记忆。
      // 同时注入基类构建的 systemPrompt（任务分类 + 沙箱上下文 + CloudBase 指引）。
      //
      // 注意：Resume 场景（toolConfirmation/askAnswers）不会走到这里（早 return 了），
      // 所以 resume 时用的是原 opencode session 自带的上下文，不需要重新注入。
      let contextPrompt: string
      if (envId) {
        const historyPrompt = await buildHistoryContextPrompt(conversationId, envId, userId, prompt, {
          excludeRecordIds: excludeHistoryRecordIds,
        })
        // Prepend system prompt before history+user prompt
        contextPrompt = systemPrompt ? `${systemPrompt}\n\n${historyPrompt}` : historyPrompt
      } else {
        contextPrompt = prompt
      }
      const promptRes = await conn.prompt({
        sessionId: opencodeSessionId,
        prompt: [{ type: 'text', text: contextPrompt }],
      })

      // 非正常停止原因：LLM provider 拒绝 (refusal) / 超出 token 上限 (max_tokens) /
      // 超过最大 turn 请求数 (max_turn_requests) 时，assistant 可能没有产出任何 text，
      // 只有截断的 reasoning。给用户显式提示，避免"空回复"的困惑。
      //
      // 注意：'cancelled' 不在此处提示（abort 流程走 catch 分支处理），'end_turn' 是正常完成。
      const stopReason = promptRes.stopReason
      if (stopReason === 'refusal' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
        const hint = buildStopReasonHint(stopReason)
        try {
          await emit({ type: 'text', content: hint })
        } catch {
          /* noop */
        }
      }

      await emit({ type: 'agent_phase', phase: 'idle' })
      await emit({
        type: 'result',
        content: JSON.stringify({
          stopReason: promptRes.stopReason,
          usage: (promptRes as { _meta?: { usage?: unknown } })._meta?.usage ?? null,
          sandbox: sandbox ? { baseUrl: sandbox.baseUrl, conversationId: sandbox.conversationId } : null,
          workingDir: sessionWorkingDir,
        }),
      })

      completeAgent(conversationId, 'completed')
      finalRecordStatus = 'done'
    } catch (error: any) {
      const isAbort = abortController.signal.aborted || error?.name === 'AbortError'
      console.error('[OpencodeAcpRuntime] launchAgent error:', error)
      // 释放挂起的权限请求（否则 opencode 子进程卡住 + chatStream 永远不返回）
      const rejectedCount = rejectPendingForConversation(
        conversationId,
        isAbort ? 'Aborted' : `runtime error: ${error?.message || error}`,
      )
      const rejectedQ = rejectPendingQuestionsForConversation(
        conversationId,
        isAbort ? 'Aborted' : `runtime error: ${error?.message || error}`,
      )
      if ((rejectedCount > 0 || rejectedQ > 0) && process.env.OPENCODE_ACP_DEBUG) {
        console.log(
          `[OpencodeAcpRuntime] rejected ${rejectedCount} pending permissions + ${rejectedQ} pending questions due to error`,
        )
      }
      try {
        await emit({
          type: 'error',
          content: isAbort ? 'Aborted' : `OpenCode runtime error: ${error?.message || String(error)}`,
        })
      } catch {
        /* noop */
      }
      completeAgent(conversationId, isAbort ? 'cancelled' : 'error', String(error?.message || error))
      finalRecordStatus = isAbort ? 'cancel' : 'error'
    } finally {
      if (transport) {
        try {
          transport.close()
        } catch {
          /* noop */
        }
      }
      // Archive to git（含 error/cancel 场景，保留最终工作状态）
      if (sandbox) {
        archiveToGit(sandbox, conversationId, prompt).catch((err) => {
          console.error('[OpencodeAcpRuntime] archiveToGit failed:', err)
        })
      }
      // Close sandbox MCP client（同 CodeBuddy runtime 对齐）
      if (sandboxMcpClient) {
        try {
          await sandboxMcpClient.close()
        } catch {
          /* noop */
        }
      }
      // 清理临时工作目录（如果是我们自己建的）
      if (sessionWorkingDir && !options.cwd && sessionWorkingDir.startsWith(os.tmpdir())) {
        try {
          fs.rmSync(sessionWorkingDir, { recursive: true, force: true })
        } catch {
          /* noop */
        }
      }
      // 消息持久化 finalize：写入最终 parts + 更新 record status
      if (messageBuilder) {
        try {
          await messageBuilder.finalize(finalRecordStatus)
        } catch (e) {
          console.error('[OpencodeAcpRuntime] messageBuilder.finalize error:', e)
        }
      }
      // 清掉临时 SSE stream_events（turn 结束后已无用，持久化已在 messages 集合）
      // 与 Tencent SDK runtime 的 finally 块对齐，避免 CloudBase 积累孤儿数据
      if (envId) {
        persistenceService.cleanupStreamEvents(conversationId, turnId).catch(() => {
          /* Non-critical */
        })
      }
      // 清掉 liveCallback + emitter 注册，避免 map 泄漏
      clearLiveCallback(conversationId)
      clearEmitter(conversationId)
      setTimeout(() => removeAgent(conversationId, turnId), 5000)
    }
  }

  /**
   * ACP session/update → 内部 AgentCallbackMessage。
   */
  private async handleSessionUpdate(update: any, emit: (msg: AgentCallbackMessage) => Promise<void>): Promise<void> {
    const tag = update.sessionUpdate as string | undefined
    if (!tag) return

    switch (tag) {
      case 'agent_message_chunk': {
        const text = update.content?.text
        if (typeof text === 'string' && text.length > 0) {
          await emit({ type: 'text', content: text })
        }
        break
      }
      case 'agent_thought_chunk': {
        const text = update.content?.text
        if (typeof text === 'string' && text.length > 0) {
          await emit({ type: 'thinking', content: text })
        }
        break
      }
      case 'tool_call': {
        await emit({
          type: 'tool_use',
          id: update.toolCallId,
          name: update.title || update.kind || 'tool',
          input: update.rawInput ?? {},
        })
        break
      }
      case 'tool_call_update': {
        const status = update.status
        if (status === 'completed' || status === 'failed') {
          await emit({
            type: 'tool_result',
            tool_use_id: update.toolCallId,
            content: typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput ?? ''),
            is_error: status === 'failed',
          })
        } else {
          await emit({
            type: 'tool_input_update',
            id: update.toolCallId,
            input: (update.rawInput ?? {}) as Record<string, unknown>,
          })
        }
        break
      }
      case 'plan': {
        await emit({
          type: 'thinking',
          content: `[plan] ${JSON.stringify(update.entries ?? [])}`,
        })
        break
      }
      case 'available_commands_update':
      case 'usage_update':
      case 'current_mode_update':
        break
      default:
        if (process.env.OPENCODE_ACP_DEBUG) {
          console.log('[OpencodeAcpRuntime] unhandled session/update:', tag, JSON.stringify(update).slice(0, 200))
        }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeEmitter(ctx: {
  envId: string
  userId: string
  conversationId: string
  turnId: string
  messageBuilder: OpencodeMessageBuilder | null
}): (msg: AgentCallbackMessage) => Promise<void> {
  const { envId, userId, conversationId, turnId, messageBuilder } = ctx
  return async (msg) => {
    const enriched: AgentCallbackMessage = {
      ...msg,
      sessionId: conversationId,
      assistantMessageId: turnId,
    }

    // 1. 喂给消息 builder（持久化）
    if (messageBuilder) {
      messageBuilder.pushEvent(enriched)
      // 里程碑 flushToDb：
      //   - tool_use：工具开始执行 → 立刻落库，让前端在挂起期间能看到"待回答/待确认"卡片
      //     （尤其 AskUserQuestion / ToolConfirm 场景，会等很久才有 tool_result）
      //   - tool_result：工具执行完毕 → 反映最新状态
      if (msg.type === 'tool_use' || msg.type === 'tool_result') {
        messageBuilder.flushToDb().catch((e) => {
          console.error('[OpencodeAcpRuntime] flushToDb error:', e)
        })
      }
    }

    // 2. 动态取 liveCallback：resume 时第二轮 SSE 的 callback 会替换第一轮的
    const liveCallback = getLiveCallback(conversationId)
    if (liveCallback) {
      try {
        const seq = getNextSeq(conversationId)
        await liveCallback(enriched, seq)
      } catch (e) {
        console.error('[OpencodeAcpRuntime] liveCallback error:', e)
      }
    }
    if (envId) {
      const acpEvent = CloudbaseAgentService.convertToSessionUpdate(enriched, conversationId)
      if (acpEvent) {
        const seq = getAgentRun(conversationId)?.lastSeq ?? 0
        persistenceService
          .appendStreamEvents([
            {
              eventId: uuidv4(),
              conversationId,
              turnId,
              envId,
              userId,
              event: acpEvent,
              seq,
              createTime: Date.now(),
            },
          ])
          .catch((e) => console.error('[OpencodeAcpRuntime] appendStreamEvents error:', e))
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

export const opencodeAcpRuntime = new OpencodeAcpRuntime()

/**
 * 为非正常 stopReason 生成面向用户的提示文本，塞到 assistant 消息尾部。
 *
 * - refusal：LLM provider 内容审查拒绝生成（如腾讯 MiMo 的 high risk 拦截）。
 *   LLM 通常在这种情况下直接中断流，没有产出 text，只剩截断的 reasoning。
 * - max_tokens：触发输出 token 上限，回复被截断。
 * - max_turn_requests：LLM 在单轮内调用工具次数过多（通常是死循环）。
 */
function buildStopReasonHint(stopReason: 'refusal' | 'max_tokens' | 'max_turn_requests'): string {
  switch (stopReason) {
    case 'refusal':
      return [
        '',
        '---',
        '⚠️ **模型拒绝回复**：当前提问被 LLM provider 的内容安全策略拦截了。',
        '',
        '可能的原因：',
        '- 提问或上下文中包含被模型方风险模型判定为敏感的内容（人名、专有名词、政治/安全相关话题等）。',
        '- 多轮对话累积的 history 中有 provider 敏感词。',
        '',
        '建议：换一种表述方式重试，或清空当前会话重新开始；必要时切换到其他模型。',
      ].join('\n')
    case 'max_tokens':
      return [
        '',
        '---',
        '⚠️ **输出被截断**：回复达到了模型的最大 token 上限，内容可能不完整。你可以回复"继续"让模型接着写。',
      ].join('\n')
    case 'max_turn_requests':
      return [
        '',
        '---',
        '⚠️ **单轮工具调用次数达到上限**：为避免死循环，本轮已停止。',
        '',
        '建议：拆分任务，或重新描述目标让模型更聚焦地执行。',
      ].join('\n')
  }
}
