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

import { useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import type { ExtendedSessionUpdate } from '@coder/shared'
import type { TaskMessage, AskUserQuestionData, ToolConfirmData, DeploymentInfo, ArtifactInfo } from '@/types/task-chat'

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

  // ── User interaction state ──
  const [toolConfirm, setToolConfirm] = useState<ToolConfirmData | null>(null)
  const [questionAnswersByTool, setQuestionAnswersByTool] = useState<Record<string, Record<string, string>>>({})
  const [manualInputsByTool, setManualInputsByTool] = useState<Record<string, Record<string, string>>>({})

  // ── Side-effect data from stream ──
  const [deploymentNotifications, setDeploymentNotifications] = useState<DeploymentInfo[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])

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
  }, [])

  const exitStreaming = useCallback(async () => {
    const wasWaiting = phaseRef.current === 'waiting_for_interaction'
    if (phaseRef.current !== 'waiting_for_interaction') {
      phaseRef.current = 'idle'
    }
    setIsSending(false)
    setIsStreamingResponse(false)
    if (!wasWaiting) {
      optionsRef.current.onStreamComplete?.()
    }
  }, [])

  // ════════════════════════════════════════════════════════════════════
  // SSE stream processing
  // ════════════════════════════════════════════════════════════════════

  /** Dispatch a single SSE sessionUpdate event to the appropriate state setter. */
  const applyStreamUpdate = useCallback(
    (update: ExtendedSessionUpdate, assistantMsgId: string) => {
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
          if (optionsRef.current.wasAtBottomRef?.current)
            requestAnimationFrame(() => optionsRef.current.scrollToBottom?.())
          break
        }

        case 'thinking': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantMsgId) return m
              const prevParts = m.parts || []
              const lastPart = prevParts[prevParts.length - 1]
              if (lastPart?.type === 'thinking') {
                return {
                  ...m,
                  parts: [...prevParts.slice(0, -1), { ...lastPart, text: lastPart.text + (u.content || '') }],
                }
              }
              return { ...m, parts: [...prevParts, { type: 'thinking' as const, text: u.content || '' }] }
            }),
          )
          break
        }

        case 'tool_call': {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantMsgId) return m
              const prevParts = m.parts || []
              const existingIdx = prevParts.findIndex((p) => p.type === 'tool_call' && p.toolCallId === u.toolCallId)
              const newPart = {
                type: 'tool_call' as const,
                toolCallId: u.toolCallId || '',
                toolName: u.title || 'tool',
                input: u.input,
                assistantMessageId: u.assistantMessageId || assistantMsgId,
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
          }
          break
        }

        case 'tool_call_update': {
          // Input update (from content_block_stop): merge input into existing tool_call part
          if (u.input !== undefined && u.result === undefined) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== assistantMsgId) return m
                const prevParts = m.parts || []
                return {
                  ...m,
                  parts: prevParts.map((p) =>
                    p.type === 'tool_call' && p.toolCallId === u.toolCallId ? { ...p, input: u.input } : p,
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
              if (prevParts.some((p) => p.type === 'tool_result' && p.toolCallId === u.toolCallId)) return m
              const toolCallPart = prevParts.find((p) => p.type === 'tool_call' && p.toolCallId === u.toolCallId)
              return {
                ...m,
                parts: [
                  ...prevParts,
                  {
                    type: 'tool_result' as const,
                    toolCallId: u.toolCallId || '',
                    toolName: toolCallPart?.type === 'tool_call' ? toolCallPart.toolName : undefined,
                    content: String(u.result || ''),
                    isError: u.status === 'failed',
                  },
                ],
              }
            }),
          )
          clearQuestionState(u.toolCallId || '')
          break
        }

        case 'tool_confirm':
          phaseRef.current = 'waiting_for_interaction'
          setToolConfirm({
            toolCallId: u.toolCallId,
            assistantMessageId: u.assistantMessageId,
            toolName: u.toolName,
            input: u.input || {},
          })
          break

        case 'ask_user':
          phaseRef.current = 'waiting_for_interaction'
          break

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
                if (prev.some((a) => a.contentType === u.artifact.contentType && a.data === u.artifact.data))
                  return prev
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
      }
    },
    [clearQuestionState, taskId],
  )

  /** Read an SSE response stream and dispatch each event via applyStreamUpdate. */
  const readSSEStream = useCallback(
    async (res: Response, assistantMsgId: string) => {
      if (!res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.error) {
              const errMsg = event.error.message || 'Agent error'
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantMsgId ? { ...m, content: `Error: ${errMsg}` } : m)),
              )
              toast.error(errMsg)
              continue
            }
            if (event.method === 'session/update') {
              applyStreamUpdate(event.params.update, assistantMsgId)
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    },
    [applyStreamUpdate],
  )

  // ════════════════════════════════════════════════════════════════════
  // ACP session
  // ════════════════════════════════════════════════════════════════════

  const ensureACPSession = useCallback(async () => {
    if (acpSessionReady.current) return true
    try {
      await fetch('/api/agent/acp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: 1 } }),
      })
      const loadRes = await fetch('/api/agent/acp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'session/load', id: 2, params: { sessionId: taskId } }),
      })
      const loadText = await loadRes.text()
      if (loadText.includes('error')) {
        await fetch('/api/agent/acp', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'session/new', id: 3, params: { conversationId: taskId } }),
        })
      }
      acpSessionReady.current = true
      return true
    } catch (err) {
      console.error('Failed to init ACP session:', err)
      return false
    }
  }, [taskId])

  // ════════════════════════════════════════════════════════════════════
  // Public operations
  // ════════════════════════════════════════════════════════════════════

  /** Send the initial prompt (from URL param). Only called once. */
  const sendInitialPrompt = useCallback(
    async (text: string) => {
      acpSessionReady.current = true

      const userMsg: TaskMessage = {
        id: `user-${Date.now()}`,
        taskId,
        role: 'user',
        content: text,
        parts: [{ type: 'text', text }],
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
        const res = await fetch('/api/agent/acp', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/prompt',
            id: Date.now(),
            params: { sessionId: taskId, prompt: [{ type: 'text', text }] },
          }),
        })
        if (!res.ok || !res.body) {
          const errData = await res.json().catch(() => ({ error: { message: 'Request failed' } }))
          const errMsg = errData.error?.message || 'Agent request failed'
          setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, content: `Error: ${errMsg}` } : m)))
          toast.error(errMsg)
          return
        }
        await readSSEStream(res, assistantMsgId)
      } catch (err) {
        console.error('Initial ACP trigger failed:', err)
      } finally {
        await exitStreaming()
      }
    },
    [enterStreaming, exitStreaming, readSSEStream, taskId],
  )

  /** Send a follow-up message in an existing conversation. */
  const sendMessage = useCallback(
    async (text: string, onRestoreDraft: (text: string) => void) => {
      const userMsg: TaskMessage = {
        id: `local-${Date.now()}`,
        taskId,
        role: 'user',
        content: text,
        parts: [{ type: 'text', text }],
        createdAt: Date.now(),
      }
      setMessages((prev) => [...prev, userMsg])

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
            toast.error(data.error || 'Failed to send message')
            onRestoreDraft(text)
          }
          return
        }

        const assistantMsgId = `stream-${Date.now()}`
        setMessages((prev) => [
          ...prev,
          { id: assistantMsgId, taskId, role: 'agent', content: '', parts: [], createdAt: Date.now() },
        ])
        enterStreaming()

        const res = await fetch('/api/agent/acp', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/prompt',
            id: Date.now(),
            params: { sessionId: taskId, prompt: [{ type: 'text', text }] },
          }),
        })

        if (!res.ok || !res.body) {
          const errData = await res.json().catch(() => ({ error: { message: 'Request failed' } }))
          const errMsg = errData.error?.message || 'Agent request failed'
          setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? { ...m, content: `Error: ${errMsg}` } : m)))
          toast.error(errMsg)
          return
        }

        await readSSEStream(res, assistantMsgId)
      } catch (err) {
        console.error('Error sending message:', err)
        toast.error('Failed to send message')
        onRestoreDraft(text)
      } finally {
        await exitStreaming()
      }
    },
    [ensureACPSession, enterStreaming, exitStreaming, readSSEStream, taskId],
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
        if (!answerValue) continue
        answers[question.question] = answerValue
      }

      phaseRef.current = 'streaming'
      enterStreaming()
      clearQuestionState(askData.toolCallId)

      // Remap local stream-xxx message id to server's assistantMessageId
      // so that readSSEStream events can match the message
      setMessages((prev) =>
        prev.map((m) => {
          if (
            m.role !== 'agent' ||
            !m.parts?.some((p) => p.type === 'tool_call' && p.toolCallId === askData.toolCallId)
          )
            return m
          if (m.id === askData.assistantMessageId) return m
          return { ...m, id: askData.assistantMessageId }
        }),
      )

      try {
        const res = await fetch('/api/agent/acp', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/prompt',
            id: Date.now(),
            params: {
              sessionId: taskId,
              prompt: [{ type: 'text', text: '' }],
              askAnswers: {
                [askData.assistantMessageId]: { toolCallId: askData.toolCallId, answers },
              },
            },
          }),
        })

        await readSSEStream(res, askData.assistantMessageId)
      } catch (err) {
        console.error('Error answering question:', err)
        toast.error('Failed to submit answer')
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
      readSSEStream,
      taskId,
    ],
  )

  /** Confirm or deny a tool execution and resume the stream. */
  const confirmTool = useCallback(
    async (action: 'allow' | 'deny') => {
      if (!toolConfirm) return

      const data = toolConfirm
      setToolConfirm(null)
      phaseRef.current = 'streaming'
      enterStreaming()

      try {
        const res = await fetch('/api/agent/acp', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/prompt',
            id: Date.now(),
            params: {
              sessionId: taskId,
              prompt: [{ type: 'text', text: '' }],
              toolConfirmation: { interruptId: data.toolCallId, payload: { action } },
            },
          }),
        })

        await readSSEStream(res, data.assistantMessageId)
      } catch (err) {
        console.error('Error confirming tool:', err)
        toast.error('Failed to confirm tool')
      } finally {
        await exitStreaming()
      }
    },
    [enterStreaming, exitStreaming, readSSEStream, taskId, toolConfirm],
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
        const res = await fetch(`/api/agent/observe/${taskId}?turnId=${assistantMsgId}`, {
          credentials: 'include',
        })
        if (!res.ok || !res.body) {
          console.error('Observe stream failed')
          return
        }
        await readSSEStream(res, assistantMsgId)
      } catch (err) {
        console.error('Reconnect to stream failed:', err)
      } finally {
        await exitStreaming()
      }
    },
    [enterStreaming, exitStreaming, readSSEStream, setMessages, taskId],
  )

  /** Cancel the current session/agent run via ACP. */
  const cancelSession = useCallback(async () => {
    try {
      await fetch('/api/agent/acp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/cancel',
          id: Date.now(),
          params: { sessionId: taskId },
        }),
      })
      phaseRef.current = 'idle'
      setIsSending(false)
      setIsStreamingResponse(false)
    } catch (err) {
      console.error('Failed to cancel session:', err)
    }
  }, [taskId])

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
    questionAnswersByTool,
    setQuestionAnswersByTool,
    manualInputsByTool,
    setManualInputsByTool,
    deploymentNotifications,
    setDeploymentNotifications,
    artifacts,

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
  }
}
