import { CloudDashboard } from '@coder/dashboard/CloudDashboard'
import type { Theme } from '@coder/dashboard/CloudDashboard'
import type { Task } from '@coder/shared'
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
import { AskUserForm } from '@/components/chat/ask-user-form'
import { ToolConfirmDialog } from '@/components/chat/tool-confirm-dialog'
import { useState, useEffect, useRef, useCallback, Children, isValidElement } from 'react'
import { useTheme } from 'next-themes'
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
} from 'lucide-react'
import { toast } from 'sonner'
import { Streamdown } from 'streamdown'
import { useAtom, useAtomValue } from 'jotai'
import { taskChatInputAtomFamily } from '@/lib/atoms/task'
import { sessionAtom } from '@/lib/atoms/session'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function TaskChat({
  taskId,
  task,
  onStreamComplete,
  initialPrompt,
  onInitialPromptConsumed,
  readOnly = false,
  messagesApiBase = '',
}: TaskChatProps) {
  const { resolvedTheme } = useTheme()
  const dashboardTheme: Theme = resolvedTheme === 'light' ? 'light' : 'dark'
  const session = useAtomValue(sessionAtom)

  // ─── Local UI state ───────────────────────────────────────────────

  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newMessage, setNewMessage] = useAtom(taskChatInputAtomFamily(taskId))
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [isStopping, setIsStopping] = useState(false)
  const [activeTab, setActiveTab] = useState('chat')

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

  const sessionEnvId = session?.envId || ''

  // ─── Scroll helpers (defined before useChatStream — needed by hook options) ──

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [])

  // ─── Chat stream hook ──────────────────────────────────────────────

  const chat = useChatStream(taskId, {
    onStreamComplete,
    onDeploymentDetected: () => fetchDeployments(false),
    scrollToBottom,
    wasAtBottomRef,
  })

  const {
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
    canFetchMessages,
    sendInitialPrompt,
    sendMessage: chatSendMessage,
    answerQuestion: chatAnswerQuestion,
    confirmTool: chatConfirmTool,
    reconnectToStream,
  } = chat

  // useEffect(()=>{
  //   console.log('>>>>>>>>>>>>>messages', messages)
  // },[messages])

  // ─── Data fetching ──────────────────────────────────────────────────

  const fetchMessages = useCallback(
    async (showLoading = true) => {
      // Don't overwrite optimistic messages during streaming or interaction wait
      if (!canFetchMessages()) return
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
          // Auto-reconnect if the latest agent message is still pending (agent running in background)
          const latestAgent = [...data.messages].reverse().find((m: any) => m.role === 'agent')
          if (latestAgent && (latestAgent.status === 'pending' || latestAgent.status === 'streaming')) {
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
    [canFetchMessages, setMessages, taskId, messagesApiBase, reconnectToStream],
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

  // ─── Initial prompt ────────────────────────────────────────────────

  const initialTriggered = useRef(false)
  useEffect(() => {
    if (readOnly || !initialPrompt || initialTriggered.current) return
    initialTriggered.current = true
    onInitialPromptConsumed?.()
    sendInitialPrompt(initialPrompt)
  }, [initialPrompt, onInitialPromptConsumed, sendInitialPrompt, readOnly])

  // ─── Handlers ──────────────────────────────────────────────────────

  const handleSendMessage = async () => {
    if (!newMessage.trim() || isSending) return
    const text = newMessage.trim()
    setNewMessage('')
    await chatSendMessage(text, (draft) => setNewMessage(draft))
    await fetchMessages(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
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
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      })
      if (response.ok) toast.success('Task stopped successfully!')
      else {
        const err = await response.json()
        toast.error(err.error || 'Failed to stop task')
      }
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

    chatAnswerQuestion(askData).then(() => fetchMessages(false))
  }

  const handleConfirmTool = (action: 'allow' | 'deny') => chatConfirmTool(action)

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

  const mdComponents = {
    code: ({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'>) => (
      <code className={`${className} !text-xs`} {...props}>
        {children}
      </code>
    ),
    pre: ({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>) => (
      <pre className="!text-xs" {...props}>
        {children}
      </pre>
    ),
    p: ({ children, ...props }: React.ComponentPropsWithoutRef<'p'>) => <p {...props}>{children}</p>,
    ul: ({ children, ...props }: React.ComponentPropsWithoutRef<'ul'>) => (
      <ul className="text-xs list-disc ml-4" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }: React.ComponentPropsWithoutRef<'ol'>) => (
      <ol className="text-xs list-decimal ml-4" {...props}>
        {children}
      </ol>
    ),
    li: ({ children, ...props }: React.ComponentPropsWithoutRef<'li'>) => (
      <li className="text-xs mb-2" {...props}>
        {Children.toArray(children).filter((c) => typeof c === 'string' || isValidElement(c))}
      </li>
    ),
  }

  const isCodingMode = task.mode === 'coding'

  // ─── Tab content ───────────────────────────────────────────────────

  const renderTabContent = () => {
    if (activeTab === 'preview' && isCodingMode) {
      return (
        <div className="flex-1 overflow-hidden -mx-3 -mt-3 relative">
          <iframe
            src={`/api/tasks/${taskId}/preview/`}
            className="w-full h-full border-0"
            title="Project Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      )
    }

    if (activeTab === 'cloud') {
      return (
        <div className="flex-1 overflow-hidden -mx-3 -mt-3">
          <CloudDashboard envId={sessionEnvId} theme={dashboardTheme} style={{ height: '100%' }} />
        </div>
      )
    }

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
              <div className="text-sm md:text-base">
                No branch yet. GitHub Checks will appear here once a branch is created.
              </div>
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
              <div className="text-sm md:text-base">No checks running</div>
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
              <div className="text-sm md:text-base">No pull request yet. Create a PR to see comments here.</div>
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
              <div className="text-sm md:text-base">No comments yet</div>
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
                          Send as Follow-Up
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
          <div className="text-sm md:text-base">No messages yet</div>
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
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-4">
        {hiddenMessagesCount > 0 && (
          <div className="text-xs text-center text-muted-foreground opacity-50 mb-4 italic">
            {hiddenMessagesCount} older message{hiddenMessagesCount !== 1 ? 's' : ''} hidden
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
                const toolCallPartsReverse = agentMessage.parts?.filter((item) => item.type === 'tool_call')?.reverse()
                return (
                  <div key={agentMessage.id} className="mt-4">
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground px-2">
                        {!agentMessage.content.trim() && (task.status === 'processing' || task.status === 'pending') ? (
                          <div className="opacity-50">
                            <div className="italic">Generating response...</div>
                            <div className="text-right font-mono opacity-70 mt-1">
                              {formatDuration(group.userMessage.createdAt)}
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {agentMessage.parts?.map((part, pi, parts) => {
                              if (part.type === 'thinking' && part.text) {
                                const hasMoreThinking = agentMessage.parts
                                  ?.slice(pi + 1)
                                  .some((p) => p.type === 'thinking')
                                const isThinking =
                                  isStreamingResponse &&
                                  (hasMoreThinking || pi === (agentMessage.parts?.length || 0) - 1)
                                return <ThinkingBlock key={`thinking-${pi}`} text={part.text} isThinking={isThinking} />
                              }
                              if (part.type === 'tool_call') {
                                let isLatestToolCallPart = toolCallPartsReverse?.[0]?.toolCallId === part.toolCallId
                                const resultPart = agentMessage.parts?.find(
                                  (p) => p.type === 'tool_result' && p.toolCallId === part.toolCallId,
                                )
                                const resultStatus = resultPart?.type === 'tool_result' ? resultPart.status : undefined
                                const isPending = !resultPart || resultStatus === 'incomplete'
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
                      <span className="text-green-600">Deployment Ready</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">
                        {deployment.type === 'web' ? 'Web' : 'Mini Program'}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {deployment.type === 'web' ? deployment.url : deployment.pagePath || 'View QR Code'}
                    </div>
                  </div>
                  <span className="text-xs text-blue-500 flex-shrink-0">View →</span>
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
            if (isFirstMessage && setupLogs.length > 0) {
              return (
                <div className="mt-4">
                  <div className="text-xs px-2">
                    <div className="space-y-1">
                      <div className="text-muted-foreground font-medium mb-2 flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Setting up sandbox...
                      </div>
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
                      Awaiting response...
                    </div>
                    <div className="text-right font-mono opacity-70 mt-1">{formatDuration(lastMessage.createdAt)}</div>
                  </div>
                </div>
              </div>
            )
          })()}

        <div ref={messagesEndRef} />
      </div>
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
            Chat
          </button>
          <button
            onClick={() => setActiveTab('deployments')}
            className={`text-sm font-semibold px-2 py-1 rounded transition-colors whitespace-nowrap flex-shrink-0 ${currentTab === 'deployments' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Deployments
          </button>
          {isCodingMode && (
            <button
              onClick={() => setActiveTab('preview')}
              className={`text-sm font-semibold px-2 py-1 rounded transition-colors whitespace-nowrap flex-shrink-0 ${currentTab === 'preview' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Preview
            </button>
          )}
          {!readOnly && (
            <button
              onClick={() => setActiveTab('cloud')}
              className={`text-sm font-semibold px-2 py-1 rounded transition-colors whitespace-nowrap flex-shrink-0 ${currentTab === 'cloud' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Cloud
            </button>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 w-6 p-0 flex-shrink-0" title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0 px-3 pt-3 flex flex-col overflow-hidden">{renderTabContent()}</div>

      {/* ToolConfirm Dialog */}
      {!readOnly && activeTab === 'chat' && toolConfirm && (
        <div className="flex-shrink-0 px-3 pb-2">
          <ToolConfirmDialog data={toolConfirm} isSending={isSending} onConfirm={handleConfirmTool} />
        </div>
      )}

      {/* Input Area */}
      {!readOnly && activeTab === 'chat' && (
        <div className="flex-shrink-0 px-3 pb-3">
          <div className="relative">
            <Textarea
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Send a follow-up message..."
              className="w-full min-h-[60px] max-h-[120px] resize-none pr-12 text-base md:text-xs"
              disabled={isSending}
            />
            {(task.status === 'processing' || task.status === 'pending') && isSending ? (
              <button
                onClick={handleStopTask}
                disabled={isStopping}
                className="absolute bottom-2 right-2 rounded-full h-5 w-5 bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Square className="h-3 w-3" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSendMessage}
                disabled={!newMessage.trim() || isSending}
                className="absolute bottom-2 right-2 rounded-full h-5 w-5 bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUp className="h-3 w-3" />}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
