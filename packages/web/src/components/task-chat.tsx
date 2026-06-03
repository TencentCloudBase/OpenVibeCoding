import type { Task, PermissionAction } from '@coder/shared'
import type {
  TaskMessage,
  AskUserQuestionData,
  TaskChatProps,
  PRComment,
  CheckRun,
  DeploymentInfo,
  ArtifactInfo,
} from '@/types/task-chat'
import { useChatStream } from '@/hooks/use-chat-stream'
import { ThinkingBlock } from '@/components/chat/thinking-block'
import { ToolCallCard } from '@/components/chat/tool-call-card'
import { SubagentCard } from '@/components/chat/subagent-card'
import { AskUserForm } from '@/components/chat/ask-user-form'
import { InterruptionCard } from '@/components/chat/interruption-card'
import { TurnStatusLines } from '@/components/chat/turn-status-lines'
import { extractPlanContent } from '@/components/chat/plan-content'
import { mdComponents } from '@/components/chat/markdown-block'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  ArrowUp,
  Loader2,
  Copy,
  Check,
  RotateCcw,
  Square,
  CheckCircle,
  AlertCircle,
  XCircle,
  RefreshCw,
  MoreVertical,
  MessageSquare,
  Trash2,
  X,
  ImageIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Streamdown } from 'streamdown'
import { useAtom } from 'jotai'
import { taskChatInputAtomFamily } from '@/lib/atoms/task'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TaskListPanel } from '@/components/chat/task-list-panel'

const HIDDEN_TOOLS = new Set([
  // CodeBuddy SDK task management 工具（由 TaskListPanel 独立展示）
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  // OpenCode 的 todowrite（同样交给 TaskListPanel 统一展示）
  'todowrite',
  'TodoWrite',
])

export function TaskChat({
  taskId,
  task,
  onStreamComplete,
  chatStream: externalChatStream,
  readOnly = false,
  messagesApiBase = '',
  onManualUserSend,
}: TaskChatProps) {
  // ─── Local UI state ───────────────────────────────────────────────

  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newMessage, setNewMessage] = useAtom(taskChatInputAtomFamily(taskId))
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [isStopping, setIsStopping] = useState(false)
  const [activeTab, setActiveTab] = useState('chat')
  const [pendingImages, setPendingImages] = useState<
    Array<{ id: string; url: string; data: string; mimeType: string }>
  >([])
  const imageInputRef = useRef<HTMLInputElement>(null)

  // Tab data
  const [prComments, setPrComments] = useState<PRComment[]>([])
  const [checkRuns, setCheckRuns] = useState<CheckRun[]>([])
  const [deployments, setDeployments] = useState<DeploymentInfo[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [loadingActions, setLoadingActions] = useState(false)
  const [actionsError, setActionsError] = useState<string | null>(null)
  const [loadingDeployment, setLoadingDeployment] = useState(false)
  const [deploymentError, setDeploymentError] = useState<string | null>(null)

  // Scroll refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const previousMessageCountRef = useRef(0)
  const previousMessagesHashRef = useRef('')
  const [userMessageHeights, setUserMessageHeights] = useState<Record<string, number>>({})
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [overflowingMessages, setOverflowingMessages] = useState<Set<string>>(new Set())
  const contentRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Tab loading cache
  const commentsLoadedRef = useRef(false)
  const actionsLoadedRef = useRef(false)

  // ─── Scroll helpers (defined before useChatStream — needed by hook options) ──

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [])

  // ─── Chat stream hook ──────────────────────────────────────────────
  // Use externally-provided chatStream (hoisted to TaskDetails) if available,
  // otherwise create our own (backwards-compatible for readOnly / admin views).

  const internalChatStream = useChatStream(taskId, {
    onStreamComplete,
    onDeploymentDetected: () => fetchDeployments(false),
    scrollToBottom,
    wasAtBottomRef,
  })
  const chat = externalChatStream || internalChatStream

  // When using external chatStream, inject scroll/deployment callbacks
  // so the hoisted hook can trigger them (optionsRef is updated every render).
  if (externalChatStream) {
    externalChatStream.optionsRef.current = {
      ...externalChatStream.optionsRef.current,
      scrollToBottom,
      wasAtBottomRef,
      onDeploymentDetected: () => fetchDeployments(false),
    }
  }

  const {
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
    agentPhase,
    canFetchMessages,
    sendInitialPrompt,
    sendMessage: chatSendMessage,
    answerQuestion: chatAnswerQuestion,
    confirmTool: chatConfirmTool,
    reconnectToStream,
    cancelSession,
    cancelledRef,
  } = chat

  // useEffect(()=>{
  //   console.log('>>>>>>>>>>>>>messages', messages)
  // },[messages])

  // ─── Data fetching ──────────────────────────────────────────────────

  const fetchMessages = useCallback(
    async (showLoading = true) => {
      // Don't overwrite optimistic messages during streaming or interaction wait
      if (!canFetchMessages()) {
        if (showLoading) setIsLoading(false)
        return
      }
      if (showLoading) setIsLoading(true)
      setError(null)

      try {
        const messagesPath = messagesApiBase
          ? `${messagesApiBase}/tasks/${taskId}/messages`
          : `/api/tasks/${taskId}/messages`
        const response = await fetch(messagesPath)
        const data = await response.json()
        // Re-check after async
        if (!canFetchMessages()) return
        if (response.ok && data.messages) {
          setMessages(data.messages)
          // ── 刷新恢复 InterruptionCard ──────────────────────────────
          // 服务端 finally 会把 message status 标为 done(即使是 ExecutionError 中断),
          // 同时 cleanupStreamEvents 也清掉 SSE 事件 → 客户端没法靠 reconnect 重放
          // tool_confirm 事件。但 DB 持久化的 parts 中,被中断的工具 call 会留下一条
          // tool_result 且 status === 'incomplete' (CLI 写入)。这里据此识别中断态,
          // 直接根据 tool_call 的 input 重建 toolConfirm,让 InterruptionCard 在
          // 对应消息末尾再次显示。
          const latestAgent = [...data.messages].reverse().find((m: any) => m.role === 'agent')
          if (latestAgent && latestAgent.parts && latestAgent.parts.length > 0) {
            const parts = latestAgent.parts
            // 找最后一个 tool_result(从尾部往前扫,跳过 text/thinking)
            let lastResult: { type: string; toolCallId?: string; status?: string } | null = null
            for (let i = parts.length - 1; i >= 0; i--) {
              const p = parts[i]
              if (p.type === 'tool_result') {
                lastResult = p
                break
              }
              if (p.type === 'tool_call') break // tool_call 没有匹配的 tool_result -> 也算未完成
            }
            if (lastResult && lastResult.status === 'incomplete' && lastResult.toolCallId) {
              const toolCall = parts.find(
                (p: { type: string; toolCallId?: string }) =>
                  p.type === 'tool_call' && p.toolCallId === lastResult!.toolCallId,
              )
              if (toolCall) {
                const rawInput = (toolCall as { input?: unknown }).input
                // DB 持久化的 tool_call.input 是 JSON 字符串(由 persistence layer
                // arguments=part.content 写入);实时 SSE 路径下则是对象。两种格式
                // 都要规范成对象,否则下游 InterruptionCard.JSON.stringify 会双重转义。
                let toolInput: Record<string, unknown> = {}
                if (rawInput && typeof rawInput === 'object') {
                  toolInput = rawInput as Record<string, unknown>
                } else if (typeof rawInput === 'string') {
                  try {
                    const parsed = JSON.parse(rawInput)
                    if (parsed && typeof parsed === 'object') toolInput = parsed
                  } catch {
                    // 解析失败时保留为 raw 字段,InterruptionCard 仍能展示
                    toolInput = { raw: rawInput }
                  }
                }
                const toolName = (toolCall as { toolName?: string }).toolName || 'tool'
                setToolConfirm({
                  toolCallId: lastResult.toolCallId,
                  assistantMessageId: latestAgent.id,
                  toolName,
                  input: toolInput,
                  ...(toolName === 'ExitPlanMode' ? { planContent: extractPlanContent(toolInput) || undefined } : {}),
                })
              }
            }
          }
          // Auto-reconnect if the latest agent message is still pending (agent running in background)
          // 但如果刚刚取消了，不要重连（后端状态可能还没完全更新）
          if (
            latestAgent &&
            (latestAgent.status === 'pending' || latestAgent.status === 'streaming') &&
            canFetchMessages() &&
            !cancelledRef.current
          ) {
            reconnectToStream(latestAgent.id)
          }
        } else {
          setError(data.error || 'Failed to fetch messages')
        }
      } catch {
        setError('Failed to fetch messages')
      } finally {
        if (showLoading) setIsLoading(false)
      }
    },
    [canFetchMessages, setMessages, setToolConfirm, taskId, messagesApiBase, reconnectToStream],
  )

  const fetchPRComments = useCallback(async () => {
    if (!task.prNumber || !task.repoUrl) return
    setLoadingComments(true)
    setCommentsError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/pr-comments`)
      const data = await res.json()
      if (res.ok) setPrComments(data.comments || [])
      else setCommentsError(data.error || 'Failed to fetch PR comments')
    } catch {
      setCommentsError('Failed to fetch PR comments')
    } finally {
      setLoadingComments(false)
    }
  }, [task.prNumber, task.repoUrl, taskId])

  const fetchCheckRuns = useCallback(async () => {
    if (!task.branchName) return
    setLoadingActions(true)
    setActionsError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/check-runs`)
      const data = await res.json()
      if (res.ok) setCheckRuns(data.checkRuns || [])
      else setActionsError(data.error || 'Failed to fetch check runs')
    } catch {
      setActionsError('Failed to fetch check runs')
    } finally {
      setLoadingActions(false)
    }
  }, [task.branchName, taskId])

  const fetchDeployments = useCallback(
    async (showLoading = true) => {
      if (showLoading) setLoadingDeployment(true)
      setDeploymentError(null)
      try {
        const res = await fetch(`/api/tasks/${taskId}/deployments`)
        const data = await res.json()
        if (res.ok) {
          setDeployments(data.deployments || [])
          if (data.artifacts) setDeploymentNotifications((prev) => [...prev, ...data.artifacts])
        } else {
          setDeploymentError(data.error || 'Failed to fetch deployments')
        }
      } catch {
        setDeploymentError('Failed to fetch deployments')
      } finally {
        if (showLoading) setLoadingDeployment(false)
      }
    },
    [setDeploymentNotifications, taskId],
  )

  // ─── Effects ────────────────────────────────────────────────────────

  // Load messages on mount
  useEffect(() => {
    fetchMessages(true)
  }, [fetchMessages])

  // Reset tab caches when data becomes available
  useEffect(() => {
    if (task.prNumber) {
      commentsLoadedRef.current = false
    }
  }, [task.prNumber])

  useEffect(() => {
    if (task.branchName) {
      actionsLoadedRef.current = false
    }
  }, [task.branchName])

  // Auto-refresh non-chat tabs
  useEffect(() => {
    if (activeTab === 'chat') return
    const interval = setInterval(() => {
      if (activeTab === 'comments') fetchPRComments()
      else if (activeTab === 'actions') fetchCheckRuns()
      else if (activeTab === 'deployments') fetchDeployments(false)
    }, 30000)
    return () => clearInterval(interval)
  }, [activeTab, fetchPRComments, fetchCheckRuns, fetchDeployments])

  // Load tab data on switch
  useEffect(() => {
    if (activeTab === 'comments' && !commentsLoadedRef.current && task.prNumber) {
      commentsLoadedRef.current = true
      fetchPRComments()
    }
  }, [activeTab, task.prNumber, fetchPRComments])

  useEffect(() => {
    if (activeTab === 'actions' && !actionsLoadedRef.current && task.branchName) {
      actionsLoadedRef.current = true
      fetchCheckRuns()
    }
  }, [activeTab, task.branchName, fetchCheckRuns])

  useEffect(() => {
    if (activeTab === 'deployments') fetchDeployments(false)
  }, [activeTab, fetchDeployments])

  // Scroll tracking
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const onScroll = () => {
      wasAtBottomRef.current = container.scrollTop + container.clientHeight >= container.scrollHeight - 100
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll on new content
  useEffect(() => {
    const count = messages.length
    const hash = messages.map((m) => `${m.id}:${(m.content || '').slice(-20)}`).join('|')
    if (count !== previousMessageCountRef.current || hash !== previousMessagesHashRef.current) {
      if (wasAtBottomRef.current) requestAnimationFrame(scrollToBottom)
      previousMessageCountRef.current = count
      previousMessagesHashRef.current = hash
    }
  }, [messages, scrollToBottom])

  // Measure user message heights
  useEffect(() => {
    for (const [id, el] of Object.entries(contentRefs.current)) {
      if (!el) continue
      const height = el.scrollHeight
      if (height > 72 && !userMessageHeights[id]) {
        setUserMessageHeights((prev) => ({ ...prev, [id]: height }))
        setOverflowingMessages((prev) => new Set([...prev, id]))
      }
    }
  }, [messages, userMessageHeights])

  // Duration timer
  useEffect(() => {
    if (task.status !== 'processing' && task.status !== 'pending') return
    const interval = setInterval(() => setCurrentTime(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [task.status])

  // ─── Handlers ──────────────────────────────────────────────────────

  const isAgentBusy = task.status === 'processing' || task.status === 'pending'

  const handleSendMessage = async () => {
    if ((!newMessage.trim() && pendingImages.length === 0) || isSending || isAgentBusy) return
    const text = newMessage.trim()
    const images = pendingImages.map(({ data, mimeType }) => ({ data, mimeType }))
    setNewMessage('')
    setPendingImages([])
    // 通知上层这是用户手动发送（用于重置自动修复计数等）
    onManualUserSend?.()
    const usedAcp = await chatSendMessage(text, (draft) => setNewMessage(draft), images.length > 0 ? images : undefined)
    // ACP 流式路径下 SSE 已实时更新本地 messages，服务端异步落 DB，
    // 过早 fetchMessages 会用陈旧数据覆盖本地内容（表现为“答完后消息消失”）。
    // REST fallback 路径则需要同步服务器状态。
    if (!usedAcp) {
      await fetchMessages(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isAgentBusy) return
      handleSendMessage()
    }
  }

  const processImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      // dataUrl = "data:image/png;base64,<data>"
      const base64 = dataUrl.split(',')[1]
      const url = URL.createObjectURL(file)
      setPendingImages((prev) => [
        ...prev,
        { id: `img-${Date.now()}-${Math.random()}`, url, data: base64, mimeType: file.type },
      ])
    }
    reader.readAsDataURL(file)
  }

  const handlePasteImage = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    items.forEach((item) => {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) processImageFile(file)
      }
    })
  }

  const handleImageFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(processImageFile)
    e.target.value = ''
  }

  const removeImage = (id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id)
      if (img) URL.revokeObjectURL(img.url)
      return prev.filter((i) => i.id !== id)
    })
  }

  const handleCopyMessage = async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedMessageId(messageId)
      setTimeout(() => setCopiedMessageId(null), 2000)
    } catch {
      toast.error('Failed to copy message')
    }
  }

  const handleRetryMessage = async (content: string) => {
    if (isSending) return
    setIsSending(true)
    try {
      const response = await fetch(`/api/tasks/${taskId}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content }),
      })
      const data = await response.json()
      if (response.ok) {
        await fetchMessages(false)
      } else {
        toast.error(data.error || 'Failed to resend message')
      }
    } catch {
      toast.error('Failed to resend message')
    } finally {
      setIsSending(false)
    }
  }

  const handleStopTask = async () => {
    setIsStopping(true)
    try {
      await cancelSession()
      toast.success('Task stopped successfully!')
      // Refetch task data so task.status updates from 'processing' to 'stopped'
      onStreamComplete?.()
    } catch {
      toast.error('Failed to stop task')
    } finally {
      setIsStopping(false)
    }
  }

  const handleAnswerQuestion = (askData: AskUserQuestionData) => {
    // Optimistically mark the tool_result as completed so the form hides immediately
    const toolAnswers = questionAnswersByTool[askData.toolCallId] || {}
    const toolInputs = manualInputsByTool[askData.toolCallId] || {}
    const answerSummary = askData.questions
      .map((q) => {
        const val = toolInputs[q.question] || toolAnswers[q.question] || ''
        return val ? `· ${q.question} -> ${val}` : null
      })
      .filter(Boolean)
      .join('\n')

    setMessages((prev) =>
      prev.map((m) => {
        if (!m.parts?.some((p) => p.type === 'tool_call' && p.toolCallId === askData.toolCallId)) return m
        // Skip if tool_result already exists
        if (m.parts.some((p) => p.type === 'tool_result' && p.toolCallId === askData.toolCallId)) return m
        return {
          ...m,
          parts: [
            ...m.parts,
            {
              type: 'tool_result' as const,
              toolCallId: askData.toolCallId,
              content: answerSummary || '已提交',
              isError: false,
            },
          ],
        }
      }),
    )

    // 不在此处调用 fetchMessages：SSE 流已经把所有 chunk/tool_call apply 到本地 state，
    // 而服务端 syncMessages 在 SSE [DONE] 之后才异步落 DB，过早 fetchMessages 会用陈旧 DB
    // 状态覆盖本地最新内容（用户表现为"答完后没有新消息出现"）。
    chatAnswerQuestion(askData)
  }

  const handleConfirmTool = (action: PermissionAction) => {
    // Optimistic local update: 在 chatConfirmTool(网络 resume) 之前先本地 mutate 一下
    // 对应 tool_call 的结果态,UI 立刻反馈,不必等服务端 SSE 推回 tool_result。
    // 对齐 handleAnswerQuestion 的做法(line 509)。
    //
    // deny  → 插入一条终态 tool_result(isError=true,"用户拒绝了此操作")。
    //         服务端也会写同样语义的占位,到时 apply-session-update 发现
    //         "已存在 tool_result" 会跳过,不会重复。
    // allow → 插入一条过渡态 tool_result(status='executing'),ToolCallCard
    //         读到 status!=='incomplete' 就会把 Loader2 换成 CheckCircle,
    //         给用户立即的"已允许"反馈。真实结果回来时 apply-session-update
    //         会因为已存在 tool_result 而跳过 —— 这对 *可视化* 是 OK 的,
    //         最终 DB 回流(fetchMessages)仍会用真实内容刷新。
    if (toolConfirm) {
      const { toolCallId } = toolConfirm
      const isDeny = action === 'deny'
      setMessages((prev) =>
        prev.map((m) => {
          if (!m.parts?.some((p) => p.type === 'tool_call' && p.toolCallId === toolCallId)) return m
          if (m.parts.some((p) => p.type === 'tool_result' && p.toolCallId === toolCallId)) return m
          const toolCallPart = m.parts.find((p) => p.type === 'tool_call' && p.toolCallId === toolCallId)
          return {
            ...m,
            parts: [
              ...m.parts,
              {
                type: 'tool_result' as const,
                toolCallId,
                toolName: toolCallPart?.type === 'tool_call' ? toolCallPart.toolName : undefined,
                content: isDeny ? '用户拒绝了此操作' : '',
                isError: isDeny,
                ...(isDeny ? {} : { status: 'executing' }),
                ...(toolCallPart?.type === 'tool_call' && toolCallPart.parentToolCallId
                  ? { parentToolCallId: toolCallPart.parentToolCallId }
                  : {}),
              },
            ],
          }
        }),
      )
    }

    return chatConfirmTool(action)
  }

  const handleAnswerSelect = (toolCallId: string, question: string, label: string) => {
    setQuestionAnswersByTool((prev) => ({
      ...prev,
      [toolCallId]: { ...(prev[toolCallId] || {}), [question]: label },
    }))
    setManualInputsByTool((prev) => {
      const next = { ...(prev[toolCallId] || {}) }
      delete next[question]
      return { ...prev, [toolCallId]: next }
    })
  }

  const handleManualInput = (toolCallId: string, question: string, value: string) => {
    setManualInputsByTool((prev) => ({
      ...prev,
      [toolCallId]: { ...(prev[toolCallId] || {}), [question]: value },
    }))
    setQuestionAnswersByTool((prev) => {
      const next = { ...(prev[toolCallId] || {}) }
      delete next[question]
      return { ...prev, [toolCallId]: next }
    })
  }

  const handleSendCommentAsFollowUp = (comment: PRComment) => {
    const formattedMessage = `**PR Comment from @${comment.user.login}:**\n\n${comment.body}\n\n---\n\nPlease address the above PR comment and make the necessary changes to ensure the feedback is accurately addressed.`
    setNewMessage(formattedMessage)
    setActiveTab('chat')
    toast.success('Comment added to chat input')
  }

  const handleRefresh = () => {
    if (activeTab === 'chat') fetchMessages(false)
    else if (activeTab === 'comments' && task.prNumber) {
      commentsLoadedRef.current = false
      fetchPRComments()
    } else if (activeTab === 'actions' && task.branchName) {
      actionsLoadedRef.current = false
      fetchCheckRuns()
    } else if (activeTab === 'deployments') fetchDeployments(false)
  }

  // ─── Utilities ─────────────────────────────────────────────────────

  const formatDuration = (userMessageCreatedAt: number) => {
    const userMessages = messages.filter((m) => m.role === 'user')
    if (userMessages.length === 0) return '00:00'
    const lastUserMsg = userMessages[userMessages.length - 1]
    const agentMessages = messages.filter((m) => m.role === 'agent')
    const lastAgentMsg = agentMessages.length > 0 ? agentMessages[agentMessages.length - 1] : null

    const startTime = new Date(userMessageCreatedAt).getTime()
    const endTime = lastAgentMsg
      ? new Date(lastAgentMsg.createdAt).getTime()
      : task.completedAt
        ? new Date(task.completedAt).getTime()
        : currentTime

    const durationMs = Math.max(0, endTime - startTime)
    const durationSeconds = Math.floor(durationMs / 1000)
    const minutes = Math.floor(durationSeconds / 60)
    const seconds = durationSeconds % 60
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }

  const parseAgentMessage = (message: TaskMessage): string => {
    if (message.parts && message.parts.length > 0) {
      return message.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('')
    }
    const content = message.content || ''
    try {
      const parsed = JSON.parse(content)
      if (parsed && typeof parsed === 'object' && 'result' in parsed && typeof parsed.result === 'string') {
        return parsed.result
      }
    } catch {}
    return content
  }

  const currentTab = activeTab as string

  // ─── Loading / Error ───────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-destructive mb-2 text-xs md:text-sm">{error}</p>
        </div>
      </div>
    )
  }

  // ─── Shared markdown components ────────────────────────────────────
  // P6+: `mdComponents` 已统一到 `@/components/chat/markdown-block`,
  //      在页面顶部 import;这里不再重复定义,避免不同位置样式漂移。

  // ─── Tab content ───────────────────────────────────────────────────

  const renderTabContent = () => {
    if (activeTab === 'deployments') {
      const handleDeleteDeployment = async (deploymentId: string) => {
        try {
          const response = await fetch(`/api/tasks/${taskId}/deployments/${deploymentId}`, { method: 'DELETE' })
          if (response.ok) setDeployments((prev) => prev.filter((d) => d.id !== deploymentId))
        } catch (err) {
          console.error('Error deleting deployment:', err)
        }
      }

      return (
        <div className="flex-1 overflow-y-auto pb-4">
          {loadingDeployment ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : deploymentError ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-destructive text-xs md:text-sm">{deploymentError}</p>
            </div>
          ) : deployments.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center text-muted-foreground px-4">
              <div className="text-sm md:text-base">暂无部署结果</div>
            </div>
          ) : (
            <div className="space-y-2 px-2 pt-2">
              {deployments.map((deployment) => (
                <div key={deployment.id} className="flex items-center gap-2 group">
                  {deployment.url ? (
                    <a
                      href={deployment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors border border-border flex-1"
                    >
                      <svg
                        className="w-5 h-5 flex-shrink-0 text-blue-500"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium">{deployment.label || 'Web Preview'}</div>
                        <div className="text-xs text-muted-foreground truncate">{deployment.url}</div>
                        <div className="text-xs text-muted-foreground">{`部署于 ${new Date(deployment.createdAt).toLocaleString()}`}</div>
                      </div>
                    </a>
                  ) : deployment.qrCodeUrl ? (
                    <div className="flex items-center gap-3 p-2 rounded-md border border-border flex-1">
                      <img src={deployment.qrCodeUrl} alt="QR Code" className="w-16 h-16 rounded" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium">{deployment.label || '小程序'}</div>
                        {deployment.pagePath && (
                          <div className="text-xs text-muted-foreground">Page: {deployment.pagePath}</div>
                        )}
                        {deployment.appId && (
                          <div className="text-xs text-muted-foreground">AppID: {deployment.appId}</div>
                        )}
                        <div className="text-xs text-muted-foreground">{`部署于 ${new Date(deployment.createdAt).toLocaleString()}`}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 p-2 rounded-md border border-border flex-1">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium">{deployment.label || 'Deployment'}</div>
                        {deployment.metadata && (
                          <pre className="text-xs bg-muted/50 rounded p-1 mt-1 overflow-auto max-h-20 whitespace-pre-wrap break-all">
                            {typeof deployment.metadata === 'string'
                              ? deployment.metadata
                              : JSON.stringify(deployment.metadata, null, 2)}
                          </pre>
                        )}
                        <div className="text-xs text-muted-foreground">{`部署于 ${new Date(deployment.createdAt).toLocaleString()}`}</div>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => handleDeleteDeployment(deployment.id)}
                    className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }

    if (activeTab === 'actions') {
      const getStatusIcon = (status: string, conclusion: string | null) => {
        if (status === 'completed') {
          if (conclusion === 'success') return <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
          if (conclusion === 'failure') return <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
          if (conclusion === 'cancelled') return <XCircle className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        } else if (status === 'in_progress') {
          return <Loader2 className="h-4 w-4 text-blue-500 animate-spin flex-shrink-0" />
        }
        return <Square className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      }

      return (
        <div className="flex-1 overflow-y-auto pb-4">
          {!task.branchName ? (
            <div className="flex items-center justify-center h-full text-center text-muted-foreground px-4">
              <div className="text-sm md:text-base">尚未创建分支，当分支创建时将在此处显示 GitHub 检查。</div>
            </div>
          ) : loadingActions ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : actionsError ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-destructive text-xs md:text-sm">{actionsError}</p>
            </div>
          ) : checkRuns.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center text-muted-foreground">
              <div className="text-sm md:text-base">没有正在运行的检查</div>
            </div>
          ) : (
            <div className="space-y-2 px-2">
              {checkRuns.map((check) => (
                <a
                  key={check.id}
                  href={check.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors"
                >
                  {getStatusIcon(check.status, check.conclusion)}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{check.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {check.status === 'completed' && check.completed_at
                        ? `Completed ${new Date(check.completed_at).toLocaleString()}`
                        : check.status === 'in_progress'
                          ? 'In progress...'
                          : 'Queued'}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      )
    }

    if (activeTab === 'comments') {
      return (
        <div className="flex-1 overflow-y-auto pb-4">
          {!task.prNumber ? (
            <div className="flex items-center justify-center h-full text-center text-muted-foreground px-4">
              <div className="text-sm md:text-base">暂无拉取请求。创建 PR 以查看评论。</div>
            </div>
          ) : loadingComments ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : commentsError ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-destructive text-xs md:text-sm">{commentsError}</p>
            </div>
          ) : prComments.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center text-muted-foreground">
              <div className="text-sm md:text-base">暂无评论</div>
            </div>
          ) : (
            <div className="space-y-4">
              {prComments.map((comment) => (
                <div key={comment.id} className="px-2">
                  <div className="flex items-start gap-2 mb-2">
                    <img
                      src={comment.user.avatar_url}
                      alt={comment.user.login}
                      className="w-6 h-6 rounded-full flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold">{comment.user.login}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(comment.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-xs text-foreground">
                        <Streamdown components={mdComponents}>{comment.body}</Streamdown>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted transition-colors">
                          <MoreVertical className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleSendCommentAsFollowUp(comment)}>
                          <MessageSquare className="h-4 w-4 mr-2" />
                          作为后续发送
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }

    // ─── Chat tab ────────────────────────────────────────────────────

    if (messages.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center text-center text-muted-foreground">
          <div className="text-sm md:text-base">暂无消息</div>
        </div>
      )
    }

    const displayMessages = messages.slice(-10)
    const hiddenMessagesCount = messages.length - displayMessages.length

    const messageGroups: { userMessage: TaskMessage; agentMessages: TaskMessage[]; minHeight: number }[] = []
    displayMessages.forEach((message) => {
      if (message.role === 'user') {
        messageGroups.push({ userMessage: message, agentMessages: [], minHeight: 0 })
      } else if (messageGroups.length > 0) {
        messageGroups[messageGroups.length - 1].agentMessages.push(message)
      }
    })

    messageGroups.forEach((group, groupIndex) => {
      let minHeight = 0
      for (let i = groupIndex + 1; i < messageGroups.length; i++) {
        const height = userMessageHeights[messageGroups[i].userMessage.id]
        if (height !== undefined) minHeight += height + 16
      }
      group.minHeight = minHeight
    })

    return (
      <>
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-4 min-h-0">
          {hiddenMessagesCount > 0 && (
            <div className="text-xs text-center text-muted-foreground opacity-50 mb-4 italic">
              {hiddenMessagesCount} 条较早消息已隐藏
            </div>
          )}
          {messageGroups.map((group, groupIndex, groups) => {
            const isLatestGroup = groupIndex === groups.length - 1
            return (
              <div
                key={group.userMessage.id}
                className="flex flex-col"
                style={group.minHeight > 0 ? { minHeight: `${group.minHeight}px` } : undefined}
              >
                <div
                  ref={(el) => {
                    messageRefs.current[group.userMessage.id] = el
                  }}
                  className={`${groupIndex > 0 ? 'mt-4' : ''} sticky top-0 z-10 before:content-[""] before:absolute before:inset-0 before:bg-background before:-z-10`}
                >
                  <Card className="px-2 py-2 bg-card rounded-md relative z-10 gap-0.5">
                    {/* Render image parts outside height-limited container */}
                    {group.userMessage.parts?.some((p) => p.type === 'image') && (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {group.userMessage.parts
                          .filter((p) => p.type === 'image')
                          .map((p, i) =>
                            p.type === 'image' ? (
                              <img
                                key={i}
                                src={`data:${p.mimeType};base64,${p.data}`}
                                alt=""
                                className="h-14 max-w-[100px] rounded object-cover border border-border"
                              />
                            ) : null,
                          )}
                      </div>
                    )}
                    <div
                      ref={(el) => {
                        contentRefs.current[group.userMessage.id] = el
                      }}
                      className="relative max-h-[72px] overflow-hidden"
                    >
                      <div className="text-xs">
                        <Streamdown components={mdComponents}>{group.userMessage.content}</Streamdown>
                      </div>
                      {overflowingMessages.has(group.userMessage.id) && (
                        <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent pointer-events-none" />
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 justify-end">
                      {!readOnly && (
                        <button
                          onClick={() => handleRetryMessage(group.userMessage.content)}
                          disabled={isSending}
                          className="h-3.5 w-3.5 opacity-30 hover:opacity-70 flex items-center justify-center disabled:opacity-20"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                      <button
                        onClick={() => handleCopyMessage(group.userMessage.id, group.userMessage.content)}
                        className="h-3.5 w-3.5 opacity-30 hover:opacity-70 flex items-center justify-center"
                      >
                        {copiedMessageId === group.userMessage.id ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </Card>
                </div>

                {group.agentMessages.map((agentMessage, messageIndex, messges) => {
                  const isLatestMessage = messageIndex === messges.length - 1
                  const toolCallPartsReverse = agentMessage.parts
                    ?.filter((item) => item.type === 'tool_call')
                    ?.reverse()
                  return (
                    <div key={agentMessage.id} className="mt-4">
                      <div className="space-y-1">
                        {/*
                          P4: AgentStatusIndicator 必须在 "Generating response..." / parts map 三元判断
                          之外渲染,否则首轮 agent message 还没任何 content/parts 时,会走 Generating 分支
                          导致 phase 指示器完全不显示(即使 agentPhase state 正确)。
                        */}
                        {!readOnly &&
                          isLatestGroup &&
                          isLatestMessage &&
                          (isStreamingResponse || isSending) &&
                          (agentPhase.sandbox.status !== 'idle' ||
                            (agentPhase.phase && agentPhase.phase !== 'idle')) && (
                            <div className="px-2 pb-1">
                              <TurnStatusLines
                                agentPhase={agentPhase}
                                sandboxMode={
                                  task.sandboxMode === 'isolated' || task.sandboxMode === 'shared'
                                    ? task.sandboxMode
                                    : 'shared'
                                }
                                isActive={isStreamingResponse || isSending}
                                hasAgentContent={
                                  !!agentMessage.content.trim() ||
                                  !!agentMessage.parts?.some(
                                    (p) =>
                                      p.type === 'tool_call' || p.type === 'thinking' || (p.type === 'text' && p.text),
                                  )
                                }
                              />
                            </div>
                          )}
                        <div className="text-xs text-muted-foreground px-2">
                          {!agentMessage.content.trim() &&
                          !agentMessage.parts?.some(
                            (p) => p.type === 'tool_call' || p.type === 'thinking' || (p.type === 'text' && p.text),
                          ) &&
                          (task.status === 'processing' || task.status === 'pending') ? (
                            <div className="opacity-50">
                              {agentPhase?.phase &&
                              agentPhase.phase !== 'idle' &&
                              !readOnly &&
                              isLatestGroup &&
                              isLatestMessage ? null : (
                                <div className="italic">正在生成回复...</div>
                              )}
                              <div className="text-right font-mono opacity-70 mt-1">
                                {formatDuration(group.userMessage.createdAt)}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {agentMessage.parts?.map((part, pi, parts) => {
                                // P7-1: 子部件（有 parentToolCallId）由 SubagentCard 内部渲染 —— 主 timeline 跳过
                                // 但必须先确认 parent 确实存在于同一 agentMessage，防止乱序导致信息丢失
                                if (
                                  (part.type === 'tool_call' || part.type === 'tool_result') &&
                                  part.parentToolCallId
                                ) {
                                  const parentExists = agentMessage.parts?.some(
                                    (p) => p.type === 'tool_call' && p.toolCallId === part.parentToolCallId,
                                  )
                                  if (parentExists) return null
                                  // parent 尚未到达 → 兜底正常渲染（避免信息丢失）
                                }

                                // Hide task management tool calls — shown in TaskListPanel instead
                                if (part.type === 'tool_call' && HIDDEN_TOOLS.has(part.toolName)) return null
                                if (part.type === 'tool_result') {
                                  const matchingCall = agentMessage.parts?.find(
                                    (p) => p.type === 'tool_call' && p.toolCallId === part.toolCallId,
                                  )
                                  const toolName =
                                    part.toolName ||
                                    (matchingCall?.type === 'tool_call' ? matchingCall.toolName : undefined)
                                  if (toolName && HIDDEN_TOOLS.has(toolName)) return null
                                }

                                // P7-2: Task 工具渲染为紫色 SubagentCard（嵌套子工具）
                                if (part.type === 'tool_call' && part.toolName === 'Task') {
                                  const childParts =
                                    agentMessage.parts?.filter(
                                      (p) =>
                                        (p.type === 'tool_call' || p.type === 'tool_result') &&
                                        p.parentToolCallId === part.toolCallId,
                                    ) ?? []
                                  const taskResult = agentMessage.parts?.find(
                                    (p) => p.type === 'tool_result' && p.toolCallId === part.toolCallId,
                                  )
                                  return (
                                    <SubagentCard
                                      key={`subagent-${pi}`}
                                      taskToolCall={part}
                                      taskToolResult={taskResult?.type === 'tool_result' ? taskResult : undefined}
                                      childParts={childParts}
                                      isStreaming={isStreamingResponse}
                                      allParts={agentMessage.parts}
                                    />
                                  )
                                }

                                if (part.type === 'thinking' && part.text) {
                                  const hasMoreThinking = agentMessage.parts
                                    ?.slice(pi + 1)
                                    .some((p) => p.type === 'thinking')
                                  const isThinking =
                                    isStreamingResponse &&
                                    (hasMoreThinking || pi === (agentMessage.parts?.length || 0) - 1)
                                  return (
                                    <ThinkingBlock key={`thinking-${pi}`} text={part.text} isThinking={isThinking} />
                                  )
                                }
                                if (part.type === 'tool_call') {
                                  let isLatestToolCallPart = toolCallPartsReverse?.[0]?.toolCallId === part.toolCallId
                                  const resultPart = agentMessage.parts?.find(
                                    (p) => p.type === 'tool_result' && p.toolCallId === part.toolCallId,
                                  )
                                  const resultStatus =
                                    resultPart?.type === 'tool_result' ? resultPart.status : undefined
                                  // 'executing' 是前端 optimistic 插入的过渡态:用户已允许,
                                  // 但真实执行结果还没到,保持 Loader2 继续转,直到真实 result 回来。
                                  const isPending =
                                    !resultPart || resultStatus === 'incomplete' || resultStatus === 'executing'
                                  const isAskUserQuestion = part.toolName === 'AskUserQuestion'
                                  let askQuestions = []

                                  try {
                                    const args =
                                      typeof part.input === 'string' ? JSON.parse(part.input as any) : part.input
                                    askQuestions = args.questions || []
                                  } catch (e) {}

                                  const resolvedAskData: AskUserQuestionData | undefined =
                                    isAskUserQuestion &&
                                    isPending &&
                                    Array.isArray(askQuestions) &&
                                    askQuestions.length > 0 &&
                                    !!part.toolCallId
                                      ? {
                                          toolCallId: part.toolCallId || '',
                                          assistantMessageId: (part as any).assistantMessageId || agentMessage.id,
                                          questions: askQuestions,
                                        }
                                      : undefined

                                  return (
                                    <div key={`tool-${pi}`} className="space-y-2">
                                      <ToolCallCard
                                        toolName={part.toolName || 'tool'}
                                        toolCallId={part.toolCallId}
                                        input={part.input}
                                        result={resultPart?.type === 'tool_result' ? resultPart.content : undefined}
                                        isError={resultPart?.type === 'tool_result' ? resultPart.isError : false}
                                        isPending={isPending}
                                        isStreaming={isStreamingResponse}
                                      />
                                      {resolvedAskData &&
                                        !readOnly &&
                                        isLatestGroup &&
                                        isLatestMessage &&
                                        isLatestToolCallPart && (
                                          <AskUserForm
                                            askData={resolvedAskData}
                                            agentMessageId={resolvedAskData.assistantMessageId}
                                            toolCallId={part.toolCallId || ''}
                                            questionAnswers={questionAnswersByTool[part.toolCallId || ''] || {}}
                                            manualInputs={manualInputsByTool[part.toolCallId || ''] || {}}
                                            isSending={isSending}
                                            onAnswerSelect={handleAnswerSelect}
                                            onManualInput={handleManualInput}
                                            onSubmit={handleAnswerQuestion}
                                          />
                                        )}
                                      {isAskUserQuestion &&
                                        resultPart?.type === 'tool_result' &&
                                        resultPart.status !== 'incomplete' && (
                                          <Card className="p-2 border-border/40 bg-muted/20">
                                            <div className="text-xs text-muted-foreground mb-1">问答结果</div>
                                            <pre className="text-[11px] whitespace-pre-wrap break-all">
                                              {String(resultPart.content || '')}
                                            </pre>
                                          </Card>
                                        )}
                                    </div>
                                  )
                                }
                                if (part.type === 'text' && part.text) {
                                  return (
                                    <Streamdown key={`text-${pi}`} components={mdComponents}>
                                      {part.text}
                                    </Streamdown>
                                  )
                                }
                                return null
                              })}
                              {!readOnly &&
                                toolConfirm &&
                                agentMessage.parts?.some(
                                  (p) => p.type === 'tool_call' && p.toolCallId === toolConfirm.toolCallId,
                                ) && (
                                  <div className="pt-1">
                                    <InterruptionCard
                                      data={toolConfirm}
                                      isSending={isSending}
                                      isStreaming={isStreamingResponse}
                                      onDecision={handleConfirmTool}
                                    />
                                  </div>
                                )}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 justify-end">
                          {task.status !== 'processing' && task.status !== 'pending' && (
                            <button
                              onClick={() => handleCopyMessage(agentMessage.id, parseAgentMessage(agentMessage))}
                              className="h-3.5 w-3.5 opacity-30 hover:opacity-70 flex items-center justify-center"
                            >
                              {copiedMessageId === agentMessage.id ? (
                                <Check className="h-3 w-3" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}

          {/* Deployment notifications */}
          {deploymentNotifications.length > 0 && (
            <div className="mt-4 px-2">
              <div className="space-y-2">
                {deploymentNotifications.map((deployment, idx) => (
                  <button
                    key={deployment.id}
                    onClick={() => {
                      setActiveTab('deployments')
                      setDeploymentNotifications((prev) => prev.filter((_, i) => i !== idx))
                    }}
                    className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors border border-border bg-muted/30 text-left"
                  >
                    {deployment.type === 'web' ? (
                      <svg
                        className="w-5 h-5 flex-shrink-0 text-green-500"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                    ) : (
                      <svg
                        className="w-5 h-5 flex-shrink-0 text-purple-500"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                        <line x1="12" y1="18" x2="12.01" y2="18" />
                      </svg>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium flex items-center gap-1">
                        <span className="text-green-600">部署完成</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">{deployment.type === 'web' ? 'Web' : '小程序'}</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {deployment.type === 'web' ? deployment.url : deployment.pagePath || 'View QR Code'}
                      </div>
                    </div>
                    <span className="text-xs text-blue-500 flex-shrink-0">查看 →</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Sandbox setup / awaiting response placeholder */}
          {(task.status === 'processing' || task.status === 'pending') &&
            displayMessages.length > 0 &&
            (() => {
              const lastMessage = displayMessages[displayMessages.length - 1]
              if (lastMessage.role !== 'user') return null
              const userMessages = displayMessages.filter((m) => m.role === 'user')
              const isFirstMessage = userMessages.length === 1
              const setupLogs = (task.logs || []).filter((log) => !log.message.startsWith('[SERVER]')).slice(-8)
              const sandboxLaneActive = (agentPhase?.sandbox.status ?? 'idle') !== 'idle'
              if (isFirstMessage && (setupLogs.length > 0 || sandboxLaneActive)) {
                return (
                  <div className="mt-4">
                    <div className="text-xs px-2">
                      <div className="space-y-1">
                        {!readOnly && sandboxLaneActive && agentPhase ? (
                          <div className="mb-2">
                            <TurnStatusLines
                              agentPhase={agentPhase}
                              sandboxMode={
                                task.sandboxMode === 'isolated' || task.sandboxMode === 'shared'
                                  ? task.sandboxMode
                                  : 'shared'
                              }
                              isActive={isStreamingResponse || isSending}
                              hasAgentContent={false}
                            />
                          </div>
                        ) : (
                          <div className="text-muted-foreground font-medium mb-2 flex items-center gap-2">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            环境准备中...
                          </div>
                        )}
                        {setupLogs.length > 0 && (
                          <div className="space-y-0.5 pl-5">
                            {setupLogs.map((log, idx) => (
                              <div
                                key={idx}
                                className={`truncate ${idx === setupLogs.length - 1 ? 'text-foreground' : log.type === 'error' ? 'text-red-500/60' : log.type === 'success' ? 'text-green-500/60' : 'text-muted-foreground/60'}`}
                              >
                                {log.message}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="text-right font-mono text-muted-foreground/50 mt-2">
                          {formatDuration(lastMessage.createdAt)}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              }
              return (
                <div className="mt-4">
                  <div className="text-xs text-muted-foreground px-2">
                    <div className="opacity-50">
                      <div className="italic flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        等待响应...
                      </div>
                      <div className="text-right font-mono opacity-70 mt-1">
                        {formatDuration(lastMessage.createdAt)}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })()}

          <div ref={messagesEndRef} />
        </div>
        <TaskListPanel messages={messages} isStreaming={isStreamingResponse} />
      </>
    )
  }

  // ─── Main layout ────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header Tabs */}
      <div className="py-2 px-3 flex items-center justify-between gap-1 flex-shrink-0 h-[46px] overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] border-b">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('chat')}
            className={`text-sm font-semibold px-2 py-1 rounded transition-colors whitespace-nowrap flex-shrink-0 ${currentTab === 'chat' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            聊天
          </button>
          <button
            onClick={() => setActiveTab('deployments')}
            className={`text-sm font-semibold px-2 py-1 rounded transition-colors whitespace-nowrap flex-shrink-0 ${currentTab === 'deployments' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            部署产物
          </button>
        </div>
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 w-6 p-0 flex-shrink-0" title="刷新">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0 px-3 pt-3 flex flex-col overflow-hidden">{renderTabContent()}</div>

      {/* InterruptionCard — 工具权限确认卡片（四值决策） */}
      {/*
        InterruptionCard / AgentStatusIndicator 已就地渲染到对应 agentMessage 末尾。
        这里保留备注便于将来查找；**不要**在此处再次渲染，否则会出现"固定在输入框上方"的 UI bug。
      */}

      {/* Input Area */}
      {!readOnly && activeTab === 'chat' && (
        <div className="flex-shrink-0 px-3 pb-3">
          {/* Pending images preview */}
          {pendingImages.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {pendingImages.map((img) => (
                <div key={img.id} className="relative group">
                  <img src={img.url} alt="" className="h-16 w-16 rounded-lg object-cover border border-border" />
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1 -right-1 w-4 h-4 bg-background border border-border rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="relative">
            <Textarea
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePasteImage}
              placeholder="发送后续消息...（使用 Ctrl+V 粘贴图片）"
              className="w-full min-h-[60px] max-h-[120px] resize-none pr-16 text-base md:text-xs"
              disabled={isSending}
            />
            {/* Image picker button */}
            {!isAgentBusy && !isSending && (
              <button
                onClick={() => imageInputRef.current?.click()}
                className="absolute bottom-2 right-8 rounded-full h-5 w-5 text-muted-foreground hover:text-foreground flex items-center justify-center"
                title="Attach image"
              >
                <ImageIcon className="h-3 w-3" />
              </button>
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={handleImageFiles}
            />
            {isAgentBusy || isSending ? (
              <button
                onClick={handleStopTask}
                disabled={isStopping}
                className="absolute bottom-2 right-2 rounded-full h-5 w-5 bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                title="停止 Agent"
              >
                {isStopping ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Square className="h-3 w-3" fill="currentColor" />
                )}
              </button>
            ) : (
              <button
                onClick={handleSendMessage}
                disabled={!newMessage.trim() && pendingImages.length === 0}
                className="absolute bottom-2 right-2 rounded-full h-5 w-5 bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                title="发送消息"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
