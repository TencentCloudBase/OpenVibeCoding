import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, Loader2, Square } from 'lucide-react'
import { useChatStream } from '../hooks/use-chat-stream'
import type { AskUserQuestionData } from '../types/task-chat'
import { Textarea } from './ui/textarea'
import { ChatTranscript } from './chat/chat-transcript'

export interface AcpChatProps {
  sessionId: string
  onStreamComplete?: () => void
  /** ACP JSON-RPC endpoint，默认 `/api/agent/acp`（同源 web）。 */
  acpBaseUrl?: string
  /** ACP observe SSE endpoint，默认从 acpBaseUrl 推导。 */
  acpObserveBaseUrl?: string
  /** 每次 ACP 请求附加的 headers（如第三方 server 的 Bearer token）。 */
  getAcpHeaders?: () => Record<string, string> | undefined
  /** 是否带 X-Task-Id header，默认 true。跨域 playground 可关闭。 */
  sendTaskIdHeader?: boolean
}

/**
 * ACP-only chat surface.
 *
 * 只负责标准对话：history replay + message stream + prompt input。
 * 不包含 web 产品层的部署产物、PR 评论、Actions tab、预览等能力。
 * Transcript 样式复用 TaskChat 已定稿的 ChatTranscript。
 */
export function AcpChat({ sessionId, onStreamComplete, acpBaseUrl, acpObserveBaseUrl, getAcpHeaders, sendTaskIdHeader }: AcpChatProps) {
  const [draft, setDraft] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const contentRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [overflowingMessages, setOverflowingMessages] = useState<Set<string>>(new Set())
  const [userMessageHeights, setUserMessageHeights] = useState<Record<string, number>>({})
  const loadedSessionRef = useRef<string | null>(null)

  const chat = useChatStream(sessionId, {
    onStreamComplete,
    scrollToBottom: () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
    acpBaseUrl,
    acpObserveBaseUrl,
    getAcpHeaders,
    sendTaskIdHeader,
  })

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true)
    try {
      await chat.loadHistoryPage({ limit: 100, sort: 'DESC' })
    } finally {
      setLoadingHistory(false)
    }
  }, [chat])

  useEffect(() => {
    if (loadedSessionRef.current === sessionId) return
    loadedSessionRef.current = sessionId
    loadHistory()
  }, [sessionId, loadHistory])

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const nextOverflowing = new Set<string>()
    const nextHeights: Record<string, number> = {}
    for (const message of chat.messages) {
      if (message.role !== 'user') continue
      const contentEl = contentRefs.current[message.id]
      const messageEl = messageRefs.current[message.id]
      if (contentEl && contentEl.scrollHeight > contentEl.clientHeight) nextOverflowing.add(message.id)
      if (messageEl) nextHeights[message.id] = messageEl.offsetHeight
    }
    setOverflowingMessages(nextOverflowing)
    setUserMessageHeights(nextHeights)
  }, [chat.messages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.messages.length])

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (!text || chat.isSending) return
    setDraft('')
    await chat.sendMessage(text, setDraft)
  }, [chat, draft])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCopyMessage = useCallback(async (messageId: string, content: string) => {
    await navigator.clipboard.writeText(content)
    setCopiedMessageId(messageId)
    setTimeout(() => setCopiedMessageId(null), 1500)
  }, [])

  const handleRetryMessage = useCallback((content: string) => {
    setDraft(content)
  }, [])

  const handleAnswerSelect = useCallback(
    (toolCallId: string, question: string, value: string) => {
      chat.setQuestionAnswersByTool((prev) => ({
        ...prev,
        [toolCallId]: { ...(prev[toolCallId] || {}), [question]: value },
      }))
    },
    [chat],
  )

  const handleManualInput = useCallback(
    (toolCallId: string, question: string, value: string) => {
      chat.setManualInputsByTool((prev) => ({
        ...prev,
        [toolCallId]: { ...(prev[toolCallId] || {}), [question]: value },
      }))
    },
    [chat],
  )

  const handleAnswerQuestion = useCallback(
    (askData: AskUserQuestionData) => {
      chat.answerQuestion(askData).then(() => loadHistory())
    },
    [chat, loadHistory],
  )

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 px-3 pt-3 flex flex-col overflow-hidden">
        {loadingHistory ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ChatTranscript
            messages={chat.messages}
            taskStatus={chat.isSending || chat.isStreamingResponse ? 'processing' : 'created'}
            readOnly={false}
            isSending={chat.isSending}
            isStreamingResponse={chat.isStreamingResponse}
            agentPhase={chat.agentPhase}
            toolConfirm={chat.toolConfirm}
            questionAnswersByTool={chat.questionAnswersByTool}
            manualInputsByTool={chat.manualInputsByTool}
            copiedMessageId={copiedMessageId}
            currentTime={currentTime}
            scrollContainerRef={scrollContainerRef}
            messagesEndRef={messagesEndRef}
            messageRefs={messageRefs}
            contentRefs={contentRefs}
            overflowingMessages={overflowingMessages}
            userMessageHeights={userMessageHeights}
            onRetryMessage={handleRetryMessage}
            onCopyMessage={handleCopyMessage}
            onAnswerSelect={handleAnswerSelect}
            onManualInput={handleManualInput}
            onAnswerQuestion={handleAnswerQuestion}
            onConfirmTool={chat.confirmTool}
          />
        )}
      </div>

      <div className="flex-shrink-0 px-3 pb-3">
        <div className="relative">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="发送消息..."
            disabled={chat.isSending}
            className="w-full min-h-[60px] max-h-[120px] resize-none pr-12 text-base md:text-xs"
          />
          {chat.isSending || chat.isStreamingResponse ? (
            <button
              onClick={chat.cancelSession}
              className="absolute bottom-2 right-2 rounded-full h-5 w-5 bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center"
              title="停止 Agent"
            >
              <Square className="h-3 w-3" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!draft.trim()}
              className="absolute bottom-2 right-2 rounded-full h-5 w-5 bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              title="发送消息"
            >
              <ArrowUp className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
