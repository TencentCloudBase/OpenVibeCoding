/**
 * applySessionUpdate — ExtendedSessionUpdate → React state 的纯业务分发器（P3）
 *
 * 为什么独立为模块函数：
 * - `use-chat-stream.ts` 超过 600 行时可读性差，7 种事件的 switch 占一大半
 * - 本函数是纯业务代码（协议不可见），不依赖任何 React Hook，只需 setter/ref 注入
 * - 抽离后 hook 仅保留薄 useCallback 包装，实现 P3 「hook ≤ 400 行」的目标
 *
 * 调用方约定：
 * - 所有 setter（setMessages / setToolConfirm / ...）由 hook 通过 useState 提供
 * - phaseRef 直接传 ref 对象，内部会 mutate current
 * - optionsRef 提供 scrollToBottom / onDeploymentDetected 等外部回调
 * - clearQuestionState 在 tool_call_update 里调用，hook 内部已 useCallback
 */
import type { Dispatch, SetStateAction, MutableRefObject } from 'react'
import type { ExtendedSessionUpdate, AgentPhaseName } from '@coder/shared'
import type { TaskMessage, ToolConfirmData, DeploymentInfo, ArtifactInfo } from '../types/task-chat'
import { extractPlanContent } from '../components/chat/plan-content'

type StreamPhase = 'idle' | 'streaming' | 'waiting_for_interaction'

/**
 * 归一化工具输出为字符串。
 *
 * ACP 1.0.0 的 rawOutput 是 SDK tool_result 的原始 content，可能是：
 *   - 纯字符串 "hello"
 *   - 内容块数组 [{ type: 'text', text: '...' }]
 *   - 任意 JSON 对象
 * 旧的 result 字段已被 runtime stringify 成字符串。本函数统一处理两种来源。
 */
function normalizeToolOutput(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  // 内容块数组：拼接其中的 text 块
  if (Array.isArray(value)) {
    const texts = value
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text?: unknown }).text
          return typeof t === 'string' ? t : ''
        }
        return ''
      })
      .filter(Boolean)
    if (texts.length > 0) return texts.join('')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

interface OptionsLike {
  scrollToBottom?: () => void
  wasAtBottomRef?: React.RefObject<boolean>
  onDeploymentDetected?: () => void
}

interface PlanModeLike {
  active: boolean
  planContent: string | null
  toolCallId: string | null
}

/**
 * Agent 执行阶段展示态（P4 前端）。
 *
 * - phase: 当前阶段（null 表示 idle,不展示指示器）
 * - toolName: 仅 phase='tool_executing' 时有值
 * - timestamp: 便于前端丢弃乱序事件(正常 SSE 时序即可,留给 reconnect 场景防陈旧覆盖)
 */
export interface AgentPhaseInfo {
  phase: AgentPhaseName | null
  toolName?: string
  timestamp: number
}

export interface ApplySessionUpdateCtx {
  update: ExtendedSessionUpdate
  assistantMsgId: string
  taskId: string
  phaseRef: MutableRefObject<StreamPhase>
  optionsRef: MutableRefObject<OptionsLike>
  setMessages: Dispatch<SetStateAction<TaskMessage[]>>
  setToolConfirm: Dispatch<SetStateAction<ToolConfirmData | null>>
  setArtifacts: Dispatch<SetStateAction<ArtifactInfo[]>>
  setDeploymentNotifications: Dispatch<SetStateAction<DeploymentInfo[]>>
  setPlanMode: Dispatch<SetStateAction<PlanModeLike>>
  setAgentPhase: Dispatch<SetStateAction<AgentPhaseInfo>>
  clearQuestionState: (toolCallId: string) => void
  /**
   * 当 ask_user / tool_confirm / ExitPlanMode 到达时需要立即解除 sending 状态，
   * 使表单按钮可点击。CodeBuddy SDK 会随即关闭 SSE，但 OpenCode 的 HTTP 长挂起
   * 不会关闭 SSE，必须显式重置以避免 UI 一直禁用。
   */
  setIsSending: Dispatch<SetStateAction<boolean>>
  setIsStreamingResponse: Dispatch<SetStateAction<boolean>>
}

/**
 * 将单条 SessionUpdate 事件分发到对应的 React state 更新。
 *
 * 覆盖的事件类型：
 * - agent_message_chunk：追加文本到 parts
 * - thinking：追加/合并 thinking part
 * - tool_call：创建/更新 tool_call part；若是 AskUserQuestion 则切 waiting
 * - tool_call_update：input 合并或追加 tool_result；完成后清理问卷状态
 * - tool_confirm：设 toolConfirm state，ExitPlanMode 时联动 plan-mode atom
 * - ask_user：切 waiting
 * - artifact：去重追加 artifact + deploymentNotification
 * - agent_phase：同步代理阶段到 UI(P4)
 */
export function applySessionUpdate(ctx: ApplySessionUpdateCtx): void {
  const {
    update,
    assistantMsgId,
    taskId,
    phaseRef,
    optionsRef,
    setMessages,
    setToolConfirm,
    setArtifacts,
    setDeploymentNotifications,
    setPlanMode,
    setAgentPhase,
    clearQuestionState,
    setIsSending,
    setIsStreamingResponse,
  } = ctx
  const u = update as any

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m
          const newText = u.content?.text || ''
          if (!newText) return m
          const prevParts = m.parts || []
          const lastPart = prevParts[prevParts.length - 1]
          const newParts =
            lastPart?.type === 'text'
              ? [...prevParts.slice(0, -1), { ...lastPart, text: lastPart.text + newText }]
              : [...prevParts, { type: 'text' as const, text: newText }]
          return { ...m, content: (m.content || '') + newText, parts: newParts }
        }),
      )
      if (optionsRef.current.wasAtBottomRef?.current) requestAnimationFrame(() => optionsRef.current.scrollToBottom?.())
      break
    }

    case 'thinking':
    case 'agent_thought_chunk': {
      // ACP 1.0.0: agent_thought_chunk uses content: { type: 'text', text }
      // @deprecated 'thinking' uses content: string (old format)
      const thoughtText = typeof u.content === 'string' ? u.content : u.content?.text || ''
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m
          const prevParts = m.parts || []
          const lastPart = prevParts[prevParts.length - 1]
          if (lastPart?.type === 'thinking') {
            return {
              ...m,
              parts: [...prevParts.slice(0, -1), { ...lastPart, text: lastPart.text + thoughtText }],
            }
          }
          return { ...m, parts: [...prevParts, { type: 'thinking' as const, text: thoughtText }] }
        }),
      )
      break
    }

    case 'tool_call': {
      // ACP 1.0.0: rawInput (new) with fallback to input (deprecated)
      const rawInput = u.rawInput ?? u.input
      const metaAssistantId = u._meta?.assistantMessageId ?? u.assistantMessageId
      const metaParentId = u._meta?.parentToolCallId ?? u.parentToolCallId
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m
          const prevParts = m.parts || []
          const existingIdx = prevParts.findIndex((p) => p.type === 'tool_call' && p.toolCallId === u.toolCallId)
          // P7: 防御 —— 若服务端误把 parentToolCallId 设为自身（SDK 语义边界），忽略
          const hasValidParent = metaParentId && metaParentId !== u.toolCallId
          const newPart = {
            type: 'tool_call' as const,
            toolCallId: u.toolCallId || '',
            toolName: u.title || 'tool',
            input: rawInput,
            assistantMessageId: metaAssistantId || assistantMsgId,
            // P7: 子代理产生的工具链到父 Task；前端据此构建 SubagentCard 嵌套视图
            ...(hasValidParent ? { parentToolCallId: metaParentId as string } : {}),
          }
          if (existingIdx >= 0) {
            const updated = [...prevParts]
            updated[existingIdx] = newPart
            return { ...m, parts: updated }
          }
          return { ...m, parts: [...prevParts, newPart] }
        }),
      )
      // Block fetchMessages when AskUserQuestion arrives
      if (String(u.title || '') === 'AskUserQuestion') {
        phaseRef.current = 'waiting_for_interaction'
        // 立即解除 sending 状态（OpenCode 情况）
        setIsSending(false)
        setIsStreamingResponse(false)
      }
      break
    }

    case 'tool_call_update': {
      // ACP 1.0.0: rawInput/rawOutput/content (new) with fallback to input/result/error (deprecated)
      // NOTE: rawOutput is the SDK's raw tool_result content — may be a string,
      // an array [{type:'text',text}], or any JSON. Old `result` was already
      // stringified by the runtime. normalizeToolOutput() handles both.
      const updateInput = u.rawInput ?? u.input
      const updateOutput = u.rawOutput ?? u.result
      // Input update (from content_block_stop): merge input into existing tool_call part
      if (updateInput !== undefined && updateOutput === undefined) {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantMsgId) return m
            const prevParts = m.parts || []
            return {
              ...m,
              parts: prevParts.map((p) =>
                p.type === 'tool_call' && p.toolCallId === u.toolCallId ? { ...p, input: updateInput } : p,
              ),
            }
          }),
        )
        break
      }
      // Result update: add tool_result part
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m
          const prevParts = m.parts || []
          const existingResultIdx = prevParts.findIndex(
            (p) => p.type === 'tool_result' && p.toolCallId === u.toolCallId,
          )
          const toolCallPart = prevParts.find((p) => p.type === 'tool_call' && p.toolCallId === u.toolCallId)
          const newResult = {
            type: 'tool_result' as const,
            toolCallId: u.toolCallId || '',
            toolName: toolCallPart?.type === 'tool_call' ? toolCallPart.toolName : undefined,
            content: normalizeToolOutput(updateOutput),
            isError: u.status === 'failed',
            // P7: 从同 toolCallId 的 tool_call part 继承 parentToolCallId
            //     服务端也在 tool_call_update 注入该字段(冗余安全兜底)
            ...(toolCallPart?.type === 'tool_call' && toolCallPart.parentToolCallId
              ? { parentToolCallId: toolCallPart.parentToolCallId }
              : {}),
          }
          if (existingResultIdx >= 0) {
            // Optimistic 占位 (status='executing') 替换为真实结果;
            // 其它终态(已完成/已失败) 保持幂等,不覆盖。
            const existing = prevParts[existingResultIdx]
            if (existing.type !== 'tool_result' || existing.status !== 'executing') return m
            const nextParts = [...prevParts]
            nextParts[existingResultIdx] = newResult
            return { ...m, parts: nextParts }
          }
          return {
            ...m,
            parts: [...prevParts, newResult],
          }
        }),
      )
      clearQuestionState(u.toolCallId || '')
      break
    }

    case 'request_permission': {
      // ACP 1.0.0: request_permission nests fields under toolCall + uses rawInput
      // @deprecated tool_confirm uses flat toolCallId/toolName/input
      const isNew = update.sessionUpdate === 'request_permission'
      const pcToolCallId = isNew ? u.toolCall?.toolCallId : u.toolCallId
      const pcToolName = isNew ? u.toolCall?.title : u.toolName
      const pcInput = (isNew ? u.toolCall?.rawInput : u.input) || {}
      const pcPlanContent = isNew ? u._meta?.planContent : u.planContent
      const pcAssistantMessageId = isNew ? u._meta?.assistantMessageId : u.assistantMessageId

      phaseRef.current = 'waiting_for_interaction'
      // 立即解除 sending 状态，使确认按钮可点击
      // （OpenCode runtime 的 SSE 不会在中断时关闭，必须显式重置）
      setIsSending(false)
      setIsStreamingResponse(false)
      setToolConfirm({
        toolCallId: pcToolCallId,
        assistantMessageId: pcAssistantMessageId,
        toolName: pcToolName,
        input: pcInput,
        // P2: ExitPlanMode 额外携带 planContent（服务端在 convert 时注入）
        ...(pcPlanContent !== undefined ? { planContent: pcPlanContent as string } : {}),
      })
      // P2: 当收到 ExitPlanMode 的 tool_confirm 时，同步更新 plan-mode atom，
      //     PlanModeCard 和输入框可据此判断当前会话是否处于 Plan 审批流。
      if (pcToolName === 'ExitPlanMode') {
        // planContent 优先级：
        //   1. 服务端显式注入（pcPlanContent）—— 目前仅覆盖 input.plan 为字符串的情况
        //   2. 从 input 中宽松提取（allowedPrompts / description+steps / 兜底 JSON）
        const planText = (pcPlanContent as string | undefined) || extractPlanContent(pcInput)
        setPlanMode({
          active: true,
          planContent: planText || null,
          toolCallId: pcToolCallId,
        })
      }
      break
    }

    case 'artifact':
      if (u.artifact) {
        setArtifacts((prev) => {
          // Deduplicate: for links, compare by origin+pathname (ignore query string and index.html)
          if (u.artifact.contentType === 'link') {
            try {
              const newUrl = new URL(u.artifact.data)
              const newKey = newUrl.origin + newUrl.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '')
              if (
                prev.some((a) => {
                  if (a.contentType !== 'link') return false
                  try {
                    const eu = new URL(a.data)
                    return eu.origin + eu.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '') === newKey
                  } catch {
                    return false
                  }
                })
              )
                return prev
            } catch {
              if (prev.some((a) => a.contentType === 'link' && a.data === u.artifact.data)) return prev
            }
          } else {
            if (prev.some((a) => a.contentType === u.artifact.contentType && a.data === u.artifact.data)) return prev
          }
          return [...prev, u.artifact]
        })
        // All artifacts are deployments — update deployment notifications
        const meta = u.artifact.metadata || {}
        const isMP = meta.deploymentType === 'miniprogram' || u.artifact.contentType === 'image'
        setDeploymentNotifications((prev) => {
          // Deduplicate: link by normalized URL path, image by qrCodeUrl
          if (u.artifact.contentType === 'link') {
            try {
              const nu = new URL(u.artifact.data)
              const nk = nu.origin + nu.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '')
              if (
                prev.some((d) => {
                  if (!d.url) return false
                  try {
                    const eu = new URL(d.url)
                    return eu.origin + eu.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '') === nk
                  } catch {
                    return false
                  }
                })
              )
                return prev
            } catch {
              if (prev.some((d) => d.url === u.artifact.data)) return prev
            }
          }
          if (u.artifact.contentType === 'image' && prev.some((d) => d.qrCodeUrl === u.artifact.data)) return prev
          return [
            ...prev,
            {
              id: `notify-${Date.now()}`,
              taskId,
              type: isMP ? 'miniprogram' : 'web',
              url: u.artifact.contentType === 'link' ? u.artifact.data : null,
              path: null,
              qrCodeUrl: u.artifact.contentType === 'image' ? u.artifact.data : null,
              pagePath: (meta.pagePath as string) || null,
              appId: (meta.appId as string) || null,
              label: u.artifact.title || null,
              metadata: meta,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ]
        })
        optionsRef.current.onDeploymentDetected?.()
      }
      break

    case 'agent_phase': {
      // P4: 代理执行阶段上报。服务端在关键边界(preparing/model_responding/tool_executing/
      // compacting/idle)推送,前端只负责把 phase + toolName 映射到状态指示器。
      //
      // 同一 turn 内服务端已做过去重(lastEmittedPhase),这里直接覆盖即可;
      // reconnect 场景若有乱序事件,用 timestamp 保证后到的旧事件不覆盖新 phase。
      const nextPhase = (u.phase ?? null) as AgentPhaseName | null
      const nextToolName = typeof u.toolName === 'string' ? u.toolName : undefined
      const nextTs = typeof u.timestamp === 'number' ? u.timestamp : Date.now()
      setAgentPhase((prev) => {
        if (prev.timestamp > nextTs) return prev
        return { phase: nextPhase, toolName: nextToolName, timestamp: nextTs }
      })
      break
    }

    case 'usage_update':
      // ACP 1.0.0: token usage. Not currently displayed in the UI; no-op.
      break
  }
}
