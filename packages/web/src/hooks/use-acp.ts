import { useState, useCallback, useRef } from 'react'
import type { ExtendedSessionUpdate, LogUpdate, TaskProgressUpdate } from '@coder/shared'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'error'
  result?: string
  isConfirmed?: boolean
}

export interface AskUserQuestionData {
  toolCallId: string
  assistantMessageId: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}

export interface ToolConfirmData {
  toolCallId: string
  assistantMessageId: string
  toolName: string
  input: Record<string, unknown>
}

export interface LogEntry {
  type: 'info' | 'error' | 'success' | 'command'
  message: string
  timestamp: number
}

let msgIdCounter = 0
const newId = () => `msg-${++msgIdCounter}-${Date.now()}`

export function useACP(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState(0)
  const [taskStatus, setTaskStatus] = useState<string>('pending')
  const [isStreaming, setIsStreaming] = useState(false)
  const [askUserQuestion, setAskUserQuestion] = useState<AskUserQuestionData | null>(null)
  const [toolConfirm, setToolConfirm] = useState<ToolConfirmData | null>(null)

  const initialized = useRef(false)
  const currentAssistantId = useRef<string | null>(null)

  const acpRequest = useCallback(async (method: string, params?: unknown) => {
    const res = await fetch('/api/agent/acp', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        id: Date.now(),
        params,
      }),
    })
    return res
  }, [])

  const initialize = useCallback(async () => {
    if (initialized.current) return
    initialized.current = true
    const res = await acpRequest('initialize', { protocolVersion: 1 })
    // drain stream
    const reader = res.body?.getReader()
    if (reader) {
      while (!(await reader.read()).done) {}
    }
  }, [acpRequest])

  const loadSession = useCallback(async () => {
    await initialize()
    // Try session/load first, if not found do session/new
    const res = await acpRequest('session/load', { sessionId })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      fullText += decoder.decode(value, { stream: true })
    }
    const lines = fullText.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue
      try {
        const event = JSON.parse(line.slice(6))
        if (event.error) {
          // Session not found, create new one with history
          const newRes = await acpRequest('session/new', { conversationId: sessionId })
          const newReader = newRes.body!.getReader()
          let newFullText = ''
          while (true) {
            const { done: newDone, value: newValue } = await newReader.read()
            if (newDone) break
            newFullText += decoder.decode(newValue, { stream: true })
          }
          const newLines = newFullText.split('\n')
          for (const newLine of newLines) {
            if (!newLine.startsWith('data: ') || newLine.trim() === 'data: [DONE]') continue
            try {
              const newEvent = JSON.parse(newLine.slice(6))
              if (newEvent.result?.history) {
                setMessages(newEvent.result.history)
              }
              if (newEvent.result?.toolCalls) {
                setToolCalls(newEvent.result.toolCalls)
              }
            } catch {
              // ignore parse errors
            }
          }
        } else if (event.result?.history) {
          // Session found, load history
          setMessages(event.result.history)
          if (event.result?.toolCalls) {
            setToolCalls(event.result.toolCalls)
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }, [acpRequest, sessionId, initialize])

  // 回答 AskUserQuestion
  const answerQuestion = useCallback(
    async (answers: Record<string, string>) => {
      if (!askUserQuestion) return

      setAskUserQuestion(null)
      setIsStreaming(true)

      try {
        const res = await acpRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: '' }], // 空提示，只传答案
          askAnswers: { [askUserQuestion.toolCallId]: answers },
        })

        await processStreamResponse(res)
      } finally {
        setIsStreaming(false)
        currentAssistantId.current = null
      }
    },
    [acpRequest, sessionId, askUserQuestion],
  )

  // 确认/拒绝工具调用
  const confirmTool = useCallback(
    async (action: 'allow' | 'deny') => {
      if (!toolConfirm) return

      setToolConfirm(null)
      setIsStreaming(true)

      try {
        const res = await acpRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: '' }],
          toolConfirmation: {
            interruptId: toolConfirm.toolCallId,
            payload: { action },
          },
        })

        await processStreamResponse(res)
      } finally {
        setIsStreaming(false)
        currentAssistantId.current = null
      }
    },
    [acpRequest, sessionId, toolConfirm],
  )

  // 处理流式响应
  const processStreamResponse = useCallback(async (res: Response) => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')

      for (const line of lines) {
        if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') continue
        try {
          const event = JSON.parse(line.slice(6))

          if (event.method === 'session/update') {
            const update: ExtendedSessionUpdate = event.params.update

            switch (update.sessionUpdate) {
              case 'agent_message_chunk':
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === currentAssistantId.current ? { ...m, content: m.content + update.content.text } : m,
                  ),
                )
                break
              case 'tool_call':
                setToolCalls((prev) => [
                  ...prev,
                  {
                    id: (update as any).toolCallId,
                    name: (update as any).title || 'tool',
                    input: (update as any).input || {},
                    status: 'running',
                  },
                ])
                break
              case 'tool_call_update':
                setToolCalls((prev) =>
                  prev.map((tc) => {
                    if (tc.id !== (update as any).toolCallId) return tc
                    const merged: ToolCall = { ...tc, status: (update as any).status || tc.status }
                    if ((update as any).result !== undefined) merged.result = (update as any).result
                    if ((update as any).input !== undefined) merged.input = (update as any).input
                    return merged
                  }),
                )
                break
              case 'ask_user':
                setAskUserQuestion({
                  toolCallId: (update as any).toolCallId,
                  assistantMessageId: (update as any).assistantMessageId,
                  questions: (update as any).questions || [],
                })
                break
              case 'tool_confirm':
                setToolConfirm({
                  toolCallId: (update as any).toolCallId,
                  assistantMessageId: (update as any).assistantMessageId,
                  toolName: (update as any).toolName,
                  input: (update as any).input || {},
                })
                break
              case 'log':
                setLogs((prev) => [
                  ...prev,
                  {
                    type: (update as LogUpdate).level,
                    message: (update as LogUpdate).message,
                    timestamp: (update as LogUpdate).timestamp,
                  },
                ])
                break
              case 'task_progress':
                setProgress((update as TaskProgressUpdate).progress)
                setTaskStatus((update as TaskProgressUpdate).status)
                break
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  }, [])

  const sendPrompt = useCallback(
    async (text: string) => {
      // Add user message
      setMessages((prev) => [...prev, { id: newId(), role: 'user', content: text, timestamp: Date.now() }])
      setIsStreaming(true)
      currentAssistantId.current = newId()
      setMessages((prev) => [
        ...prev,
        { id: currentAssistantId.current!, role: 'assistant', content: '', timestamp: Date.now() },
      ])

      try {
        const res = await acpRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        })

        await processStreamResponse(res)
      } finally {
        setIsStreaming(false)
        currentAssistantId.current = null
      }
    },
    [acpRequest, sessionId, processStreamResponse],
  )

  return {
    messages,
    toolCalls,
    logs,
    progress,
    taskStatus,
    isStreaming,
    askUserQuestion,
    toolConfirm,
    sendPrompt,
    loadSession,
    answerQuestion,
    confirmTool,
  }
}
