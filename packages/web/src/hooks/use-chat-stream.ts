/**
 * useChatStream — SSE 流处理核心 hook
 *
 * 状态机:
 *   IDLE ──► STREAMING ──► WAITING_FOR_INTERACTION ──► (用户提交) ──► STREAMING ──► IDLE
 *                       └──► IDLE (正常完成)
 *
 * IDLE:            可以 fetchMessages 同步服务端数据；可以发起新 stream
 * STREAMING:       isStreamingRef=true；fetchMessages 被阻止（防止覆盖 optimistic 数据）
 * WAITING:         流已结束，但 fetchMessages 仍被阻止（服务端 status='pending'，查不到当前消息）
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import type { ExtendedSessionUpdate, PermissionAction, AgentPermissionMode } from '@coder/shared'
import type { TaskMessage, AskUserQuestionData, ToolConfirmData, DeploymentInfo, ArtifactInfo } from '@/types/task-chat'
import { planModeAtomFamily } from '@/lib/atoms/plan-mode'
import { streamLogsAtomFamily } from '@/lib/atoms/stream-logs'
import type { LogEntry } from '@coder/shared'
import { AcpClient } from '@/lib/acp'
import { applySessionUpdate, IDLE_AGENT_PHASE, type AgentPhaseInfo } from './apply-session-update'

/** Agent 执行阶段的空闲态;Hook 初始化与 turn 结束时复位用 */
const IDLE_PHASE: AgentPhaseInfo = IDLE_AGENT_PHASE

// ─── Stream Phase ─────────────────────────────────────────────────────

type StreamPhase = 'idle' | 'streaming' | 'waiting_for_interaction'

// ─── Hook Options ─────────────────────────────────────────────────────

interface UseChatStreamOptions {
  onStreamComplete?: () => void
  onDeploymentDetected?: () => void
  /** 外部提供的滚动到底部方法 */
  scrollToBottom?: () => void
  /** 外部提供的 wasAtBottom 检测 */
  wasAtBottomRef?: React.RefObject<boolean>
}

// ─── Return type (exported for parent components) ─────────────────────

export type ChatStreamReturn = ReturnType<typeof useChatStream>

// ─── Hook ─────────────────────────────────────────────────────────────

export function useChatStream(taskId: string, options: UseChatStreamOptions = {}) {
  // Store options in refs so callback deps stay stable across renders
  const optionsRef = useRef(options)
  optionsRef.current = options

  // ── Messages ──
  const [messages, setMessages] = useState<TaskMessage[]>([])

  // ── Streaming state ──
  const [isSending, setIsSending] = useState(false)
  const [isStreamingResponse, setIsStreamingResponse] = useState(false)
  const phaseRef = useRef<StreamPhase>('idle')

  // ── ACP session ──
  const acpSessionReady = useRef(false)

  // ── ACP protocol client (P3) ──
  // 每 taskId 一个实例；构造后引用稳定，可安全纳入 useCallback 依赖。
  const acpClient = useMemo(
    () => new AcpClient({ baseUrl: '/api/agent/acp', observeBaseUrl: '/api/agent/observe', taskId }),
    [taskId],
  )

  // ── User interaction state ──
  const [toolConfirm, setToolConfirm] = useState<ToolConfirmData | null>(null)
  const [questionAnswersByTool, setQuestionAnswersByTool] = useState<Record<string, Record<string, string>>>({})
  const [manualInputsByTool, setManualInputsByTool] = useState<Record<string, Record<string, string>>>({})

  // ── Plan mode state (P2) ──
  //   · 绑定到全局 atomFamily，以便多组件（输入框、Card、路由）共享
  //   · `planMode.active` 决定下一轮 prompt 的 permissionMode
  //   · planContent + toolCallId 用于回显审批卡片
  const [planMode, setPlanMode] = useAtom(planModeAtomFamily(taskId))
  const [streamLogs, setStreamLogs] = useAtom(streamLogsAtomFamily(taskId))

  // ── Agent phase state (P4) ──
  //   · 服务端在关键边界推送 `sessionUpdate: 'agent_phase'` 事件
  //   · applySessionUpdate 内调用 setAgentPhase 更新
  //   · phase === null 表示 idle,UI 不展示指示器
  //   · 本 state 完全独立于 phaseRef (phaseRef 控制 idle/streaming/waiting 三态交互流)
  const [agentPhase, setAgentPhase] = useState<AgentPhaseInfo>(IDLE_PHASE)

  // ── Side-effect data from stream ──
  const [deploymentNotifications, setDeploymentNotifications] = useState<DeploymentInfo[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])

  // ── Task 切换时重置交互态 ──
  //   hook 实例虽然随 taskId 变化重建 AcpClient（useMemo deps），
  //   但 useState 初值只在首次 mount 生效；taskId 变而组件未卸载时，
  //   toolConfirm / agentPhase / 交互态会"串"到新 task 上。
  //
  //   关键：只在 **真正切换** 时 reset，跳过 initial mount，
  //   否则首次 mount 时的 reset 会踩踏 sendInitialPrompt 已经启动的流式状态，
  //   导致 phaseRef.current 被清回 idle → 触发 fetchMessages → reconnectToStream，
  //   最终覆盖掉正在流式接收的 ACP 响应，页面短暂显示 "no message"。
  const prevTaskIdRef = useRef<string>(taskId)
  useEffect(() => {
    if (prevTaskIdRef.current === taskId) return
    prevTaskIdRef.current = taskId
    setToolConfirm(null)
    setAgentPhase(IDLE_PHASE)
    setQuestionAnswersByTool({})
    setManualInputsByTool({})
    setDeploymentNotifications([])
    setArtifacts([])
    setStreamLogs([])
    phaseRef.current = 'idle'
    setIsSending(false)
    setIsStreamingResponse(false)
  }, [setStreamLogs, taskId])

  // ════════════════════════════════════════════════════════════════════
  // AskUser / ToolConfirm cleanup helpers
  // ════════════════════════════════════════════════════════════════════

  const clearQuestionState = useCallback((toolCallId: string) => {
    if (!toolCallId) return
    setQuestionAnswersByTool((prev) => {
      if (!prev[toolCallId]) return prev
      const next = { ...prev }
      delete next[toolCallId]
      return next
    })
    setManualInputsByTool((prev) => {
      if (!prev[toolCallId]) return prev
      const next = { ...prev }
      delete next[toolCallId]
      return next
    })
  }, [])

  // ════════════════════════════════════════════════════════════════════
  // Phase transitions
  // ════════════════════════════════════════════════════════════════════

  const enterStreaming = useCallback(() => {
    phaseRef.current = 'streaming'
    setIsSending(true)
    setIsStreamingResponse(true)
    setAgentPhase(IDLE_PHASE)
    setStreamLogs([])
  }, [setStreamLogs])

  const exitStreaming = useCallback(async () => {
    const wasWaiting = phaseRef.current === 'waiting_for_interaction'
    if (phaseRef.current !== 'waiting_for_interaction') {
      phaseRef.current = 'idle'
    }
    setIsSending(false)
    setIsStreamingResponse(false)
    // P4: turn 结束(无论正常完成 / 等待交互)都把 agentPhase 复位,
    // 避免上一轮的 "执行 Bash" 之类的指示器残留到下一轮启动前。
    setAgentPhase(IDLE_PHASE)
    if (!wasWaiting) {
      const onDone = optionsRef.current.onStreamComplete?.()
      if (onDone && typeof (onDone as Promise<unknown>).then === 'function') {
        await onDone
      }
    }
    setStreamLogs([])
  }, [setStreamLogs])

  // ════════════════════════════════════════════════════════════════════
  // SSE stream processing
  // ════════════════════════════════════════════════════════════════════

  const appendStreamLog = useCallback(
    (entry: LogEntry) => {
      setStreamLogs((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.message === entry.message && last.type === entry.type) return prev
        return [...prev, entry]
      })
    },
    [setStreamLogs],
  )

  /** Dispatch a single SSE sessionUpdate event to the appropriate state setter. */
  const applyStreamUpdate = useCallback(
    (update: ExtendedSessionUpdate, assistantMsgId: string) => {
      applySessionUpdate({
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
        appendStreamLog,
      })
    },
    [appendStreamLog, clearQuestionState, setPlanMode, taskId],
  )

  // ════════════════════════════════════════════════════════════════════
  // ACP session
  // ════════════════════════════════════════════════════════════════════

  const ensureACPSession = useCallback(async () => {
    if (acpSessionReady.current) return true
    try {
      await acpClient.initializeSession()
      acpSessionReady.current = true
      return true
    } catch (err) {
      console.error('Failed to init ACP session:', err)
      return false
    }
  }, [acpClient])

  // ════════════════════════════════════════════════════════════════════
  // Public operations
  // ════════════════════════════════════════════════════════════════════

  /**
   * 内部 helper：执行一次 session/prompt 流，统一负责 for-await 循环 + 错误提示 + finally 清理。
   * 调用方只需准备 assistantMsgId 和 params（prompt/askAnswers/toolConfirmation/permissionMode），
   * 不需要重复写 try/catch 模板。
   */
  const runPromptStream = useCallback(
    async (assistantMsgId: string, params: Record<string, unknown>) => {
      try {
        console.log('[runPromptStream] starting stream for', assistantMsgId)
        for await (const update of acpClient.stream('session/prompt', params)) {
          applyStreamUpdate(update, assistantMsgId)
        }
        console.log('[runPromptStream] stream completed normally')
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Agent request failed'
        console.error('[runPromptStream] stream error:', errMsg, err)
        // Remove the empty agent placeholder message
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId))
        toast.error(errMsg)
        throw err // re-throw so callers (sendMessage etc.) can restore draft
      }
    },
    [acpClient, applyStreamUpdate],
  )

  /** Send the initial prompt (from URL param). Only called once. */
  const sendInitialPrompt = useCallback(
    async (text: string, imageBlocks?: Array<{ data: string; mimeType: string }>) => {
      acpSessionReady.current = true
      const userMsg: TaskMessage = {
        id: `user-${Date.now()}`,
        taskId,
        role: 'user',
        content: text,
        parts: [
          ...(imageBlocks?.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })) ?? []),
          { type: 'text', text },
        ],
        createdAt: Date.now(),
      }
      const assistantMsgId = `stream-${Date.now()}`
      const agentMsg: TaskMessage = {
        id: assistantMsgId,
        taskId,
        role: 'agent',
        content: '',
        parts: [],
        createdAt: Date.now(),
      }
      setMessages([userMsg, agentMsg])
      enterStreaming()
      try {
        await runPromptStream(assistantMsgId, {
          sessionId: taskId,
          prompt: [
            ...(imageBlocks?.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })) ?? []),
            { type: 'text', text },
          ],
          // P2: Plan 模式激活时让 Agent 以 permissionMode='plan' 启动
          ...(planMode.active ? { permissionMode: 'plan' as const } : {}),
        })
      } finally {
        await exitStreaming()
      }
    },
    [enterStreaming, exitStreaming, planMode.active, runPromptStream, taskId],
  )

  /**
   * Send a follow-up message in an existing conversation.
   *
   * opts.isAutoFix —— 自动修复触发的发送（如预览错误自动修复）。
   * 当前 hook 不根据此 flag 改变行为，仅供外部 wrapper 判断是否为"用户手动发送"
   * 以做计数重置等副作用。若日后想在 server 侧记录自动触发来源，可通过
   * runPromptStream 透传。
   */
  const sendMessage = useCallback(
    async (
      text: string,
      onRestoreDraft: (text: string) => void,
      imageBlocks?: Array<{ data: string; mimeType: string }>,
      _opts?: { isAutoFix?: boolean },
    ) => {
      const userMsgId = `local-${Date.now()}`
      const userMsg: TaskMessage = {
        id: userMsgId,
        taskId,
        role: 'user',
        content: text,
        parts: [
          ...(imageBlocks?.map((img) => ({
            type: 'image' as const,
            data: img.data,
            mimeType: img.mimeType,
          })) ?? []),
          { type: 'text', text },
        ],
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, userMsg])

      let assistantMsgId: string | null = null
      try {
        const ready = await ensureACPSession()
        if (!ready) {
          // Fallback to REST API
          const response = await fetch(`/api/tasks/${taskId}/continue`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text }),
          })
          if (!response.ok) {
            const data = await response.json()
            throw new Error(data.error || 'Failed to send message')
          }
          return
        }

        assistantMsgId = `stream-${Date.now()}`
        setMessages((prev) => [
          ...prev,
          { id: assistantMsgId!, taskId, role: 'agent', content: '', parts: [], createdAt: Date.now() },
        ])
        enterStreaming()
        await runPromptStream(assistantMsgId, {
          sessionId: taskId,
          prompt: [
            ...(imageBlocks?.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })) ?? []),
            { type: 'text', text },
          ],
          ...(planMode.active ? { permissionMode: 'plan' as const } : {}),
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Failed to send message'
        console.error('[sendMessage] error:', errMsg)
        // Remove both the optimistic user message and the empty agent placeholder
        // (server rejected the prompt, so neither exists in DB)
        setMessages((prev) => prev.filter((m) => m.id !== userMsgId && m.id !== assistantMsgId))
        toast.error(errMsg)
        onRestoreDraft(text)
      } finally {
        await exitStreaming()
      }
    },
    [ensureACPSession, enterStreaming, exitStreaming, planMode.active, runPromptStream, taskId],
  )

  /** Submit answers to an AskUserQuestion and resume the stream. */
  const answerQuestion = useCallback(
    async (askData: AskUserQuestionData) => {
      if (!askData?.toolCallId || !askData?.assistantMessageId) return

      const toolAnswers = questionAnswersByTool[askData.toolCallId] || {}
      const toolInputs = manualInputsByTool[askData.toolCallId] || {}
      const answers: Record<string, string> = {}
      for (const question of askData.questions) {
        const answerValue = toolInputs[question.question] || toolAnswers[question.question]
        // Key 约定: 使用 question.header（与 opencode AskUserQuestion custom tool 对齐，
        // 后者通过 `data.answers[q.header]` 取值）。CodeBuddy SDK 也使用 header。
        if (answerValue) answers[question.header] = answerValue
      }

      phaseRef.current = 'streaming'
      enterStreaming()
      clearQuestionState(askData.toolCallId)

      // Remap local stream-xxx message id to server's assistantMessageId so subsequent events match
      setMessages((prev) =>
        prev.map((m) => {
          if (
            m.role !== 'agent' ||
            !m.parts?.some((p) => p.type === 'tool_call' && p.toolCallId === askData.toolCallId)
          )
            return m
          return m.id === askData.assistantMessageId ? m : { ...m, id: askData.assistantMessageId }
        }),
      )

      try {
        await runPromptStream(askData.assistantMessageId, {
          sessionId: taskId,
          prompt: [{ type: 'text', text: '' }],
          askAnswers: { [askData.assistantMessageId]: { toolCallId: askData.toolCallId, answers } },
        })
      } finally {
        await exitStreaming()
      }
    },
    [
      clearQuestionState,
      enterStreaming,
      exitStreaming,
      manualInputsByTool,
      questionAnswersByTool,
      runPromptStream,
      taskId,
    ],
  )

  /** Confirm or deny a tool execution and resume the stream. */
  const confirmTool = useCallback(
    async (action: PermissionAction) => {
      if (!toolConfirm) return

      const data = toolConfirm
      const isExitPlanMode = data.toolName === 'ExitPlanMode'
      setToolConfirm(null)
      phaseRef.current = 'streaming'
      enterStreaming()

      // 对齐 answerQuestion：把本地 "stream-xxx" 消息 id remap 到服务端 assistantMessageId，
      // 否则 resume 后 SSE 里的 tool_call / agent_message_chunk 等事件的 `setMessages` 匹配
      // (m.id === assistantMsgId) 会全部 false —— UI 不会再更新，用户看到"允许后没反应"。
      setMessages((prev) =>
        prev.map((m) => {
          if (m.role !== 'agent' || !m.parts?.some((p) => p.type === 'tool_call' && p.toolCallId === data.toolCallId))
            return m
          return m.id === data.assistantMessageId ? m : { ...m, id: data.assistantMessageId }
        }),
      )

      // P2: 根据用户在 PlanModeCard 的决策更新本地 plan-mode atom
      //   · allow / allow_always / reject_and_exit_plan → 退出 Plan 模式，permissionMode='default'
      //   · deny → 保持 Plan 模式，permissionMode='plan' 继续规划
      let nextPermissionMode: AgentPermissionMode | undefined
      if (isExitPlanMode) {
        if (action === 'deny') {
          setPlanMode((prev) => ({ ...prev, toolCallId: null, active: true }))
          nextPermissionMode = 'plan'
        } else {
          setPlanMode({ active: false, planContent: null, toolCallId: null })
          nextPermissionMode = 'default'
        }
      }

      try {
        await runPromptStream(data.assistantMessageId, {
          sessionId: taskId,
          prompt: [{ type: 'text', text: '' }],
          toolConfirmation: { interruptId: data.toolCallId, payload: { action } },
          ...(nextPermissionMode ? { permissionMode: nextPermissionMode } : {}),
        })
      } finally {
        await exitStreaming()
      }
    },
    [enterStreaming, exitStreaming, runPromptStream, setPlanMode, taskId, toolConfirm],
  )

  /** Reconnect to an ongoing agent stream after page refresh. */
  const reconnectToStream = useCallback(
    async (assistantMsgId: string) => {
      if (phaseRef.current !== 'idle') return
      // Add a placeholder agent message if not already present
      setMessages((prev) => {
        if (prev.some((m) => m.id === assistantMsgId)) return prev
        return [
          ...prev,
          { id: assistantMsgId, taskId, role: 'agent' as const, content: '', parts: [], createdAt: Date.now() },
        ]
      })
      enterStreaming()
      try {
        for await (const update of acpClient.observe(assistantMsgId)) {
          applyStreamUpdate(update, assistantMsgId)
        }
      } catch (err) {
        console.error('Reconnect to stream failed:', err)
      } finally {
        await exitStreaming()
      }
    },
    [acpClient, applyStreamUpdate, enterStreaming, exitStreaming, taskId],
  )

  /** Cancel the current session/agent run via ACP. */
  const cancelledRef = useRef(false)
  const cancelSession = useCallback(async () => {
    try {
      cancelledRef.current = true
      await acpClient.cancel()
      // 后端已 await updateRecordStatus + task.status='stopped'
      // 短暂延迟确保 DB 写入对后续 fetchMessages 可见
      await new Promise((r) => setTimeout(r, 300))
      phaseRef.current = 'idle'
      setIsSending(false)
      setIsStreamingResponse(false)
      // 500ms 后清除 cancelled 标记（防止 auto-reconnect 误触发）
      setTimeout(() => {
        cancelledRef.current = false
      }, 500)
    } catch (err) {
      console.error('Failed to cancel session:', err)
      cancelledRef.current = false
    }
  }, [acpClient])

  // ════════════════════════════════════════════════════════════════════
  // Public API
  // ════════════════════════════════════════════════════════════════════

  /** Real-time check — stable function that reads phaseRef so it's always current, not stale from render */
  const canFetchMessages = useCallback(() => phaseRef.current === 'idle', [])

  return {
    // State
    messages,
    setMessages,
    isSending,
    setIsSending,
    isStreamingResponse,
    toolConfirm,
    setToolConfirm,
    questionAnswersByTool,
    setQuestionAnswersByTool,
    manualInputsByTool,
    setManualInputsByTool,
    deploymentNotifications,
    setDeploymentNotifications,
    artifacts,

    // Plan mode (P2)
    planMode,
    setPlanMode,

    // Agent phase (P4)
    agentPhase,
    setAgentPhase,

    // Live platform logs (SSE log → LogsPane)
    streamLogs,

    // Phase (for fetchMessages guard)
    canFetchMessages,
    phaseRef,

    // Options ref (allows child components to inject scrollToBottom etc.)
    optionsRef,

    // Operations
    sendInitialPrompt,
    sendMessage,
    answerQuestion,
    confirmTool,
    reconnectToStream,
    cancelSession,
    cancelledRef,
  }
}
