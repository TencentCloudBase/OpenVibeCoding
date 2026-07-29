import type { RefObject } from 'react'
import type { AgentPhaseInfo } from '../../hooks/apply-session-update'
import type {
  AskUserQuestionData,
  DeploymentInfo,
  MessagePart,
  TaskMessage,
  ToolConfirmData,
} from '../../types/task-chat'
import { Card } from '../ui/card'
import { Check, Copy, Loader2, RotateCcw } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { mdComponents } from './markdown-block'
import { AgentStatusIndicator } from './agent-status-indicator'
import { SubagentCard } from './subagent-card'
import { ThinkingBlock } from './thinking-block'
import { ToolCallCard } from './tool-call-card'
import { AskUserForm } from './ask-user-form'
import { InterruptionCard } from './interruption-card'
import { TaskListPanel } from './task-list-panel'

const HIDDEN_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'todowrite', 'TodoWrite'])

export interface ChatTranscriptProps {
  messages: TaskMessage[]
  taskStatus: string
  taskLogs?: Array<{ message: string; type?: string }>
  readOnly?: boolean
  isSending: boolean
  isStreamingResponse: boolean
  agentPhase: AgentPhaseInfo
  toolConfirm: ToolConfirmData | null
  questionAnswersByTool: Record<string, Record<string, string>>
  manualInputsByTool: Record<string, Record<string, string>>
  copiedMessageId: string | null
  currentTime: number
  scrollContainerRef: RefObject<HTMLDivElement | null>
  messagesEndRef: RefObject<HTMLDivElement | null>
  messageRefs: RefObject<Record<string, HTMLDivElement | null>>
  contentRefs: RefObject<Record<string, HTMLDivElement | null>>
  overflowingMessages: Set<string>
  userMessageHeights: Record<string, number>
  deploymentNotifications?: DeploymentInfo[]
  onDeploymentNotificationClick?: (deployment: DeploymentInfo, index: number) => void
  onRetryMessage: (content: string) => void
  onCopyMessage: (messageId: string, content: string) => void
  onAnswerSelect: (toolCallId: string, question: string, value: string) => void
  onManualInput: (toolCallId: string, question: string, value: string) => void
  onAnswerQuestion: (askData: AskUserQuestionData) => void
  onConfirmTool: (action: any) => void
}

export function ChatTranscript({
  messages,
  taskStatus,
  taskLogs = [],
  readOnly = false,
  isSending,
  isStreamingResponse,
  agentPhase,
  toolConfirm,
  questionAnswersByTool,
  manualInputsByTool,
  copiedMessageId,
  currentTime,
  scrollContainerRef,
  messagesEndRef,
  messageRefs,
  contentRefs,
  overflowingMessages,
  userMessageHeights,
  deploymentNotifications = [],
  onDeploymentNotificationClick,
  onRetryMessage,
  onCopyMessage,
  onAnswerSelect,
  onManualInput,
  onAnswerQuestion,
  onConfirmTool,
}: ChatTranscriptProps) {
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
                        onClick={() => onRetryMessage(group.userMessage.content)}
                        disabled={isSending}
                        className="h-3.5 w-3.5 opacity-30 hover:opacity-70 flex items-center justify-center disabled:opacity-20"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={() => onCopyMessage(group.userMessage.id, group.userMessage.content)}
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

              {group.agentMessages.map((agentMessage, messageIndex, agentMessages) => {
                const isLatestMessage = messageIndex === agentMessages.length - 1
                const toolCallPartsReverse = agentMessage.parts?.filter((item) => item.type === 'tool_call')?.reverse()
                return (
                  <div key={agentMessage.id} className="mt-4">
                    <div className="space-y-1">
                      {!readOnly &&
                        isLatestGroup &&
                        isLatestMessage &&
                        isStreamingResponse &&
                        agentPhase?.phase &&
                        agentPhase.phase !== 'idle' && (
                          <div className="px-2 pb-1">
                            <AgentStatusIndicator phase={agentPhase.phase} toolName={agentPhase.toolName} />
                          </div>
                        )}
                      <div className="text-xs text-muted-foreground px-2">
                        {!agentMessage.content.trim() &&
                        !agentMessage.parts?.some(
                          (p) => p.type === 'tool_call' || p.type === 'thinking' || (p.type === 'text' && p.text),
                        ) &&
                        (taskStatus === 'processing' || taskStatus === 'pending') ? (
                          <div className="opacity-50">
                            <div className="italic">正在生成回复...</div>
                            <div className="text-right font-mono opacity-70 mt-1">
                              {formatDuration(group.userMessage.createdAt, currentTime)}
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {agentMessage.parts?.map((part, pi) => {
                              if ((part.type === 'tool_call' || part.type === 'tool_result') && part.parentToolCallId) {
                                const parentExists = agentMessage.parts?.some(
                                  (p) => p.type === 'tool_call' && p.toolCallId === part.parentToolCallId,
                                )
                                if (parentExists) return null
                              }

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
                                return <ThinkingBlock key={`thinking-${pi}`} text={part.text} isThinking={isThinking} />
                              }

                              if (part.type === 'tool_call') {
                                const isLatestToolCallPart = toolCallPartsReverse?.[0]?.toolCallId === part.toolCallId
                                const resultPart = agentMessage.parts?.find(
                                  (p) => p.type === 'tool_result' && p.toolCallId === part.toolCallId,
                                )
                                const resultStatus = resultPart?.type === 'tool_result' ? resultPart.status : undefined
                                const isPending =
                                  !resultPart || resultStatus === 'incomplete' || resultStatus === 'executing'
                                const resolvedAskData = resolveAskUserQuestion(agentMessage, part, isPending)

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
                                          onAnswerSelect={onAnswerSelect}
                                          onManualInput={onManualInput}
                                          onSubmit={onAnswerQuestion}
                                        />
                                      )}
                                    {part.toolName === 'AskUserQuestion' &&
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
                                    onDecision={onConfirmTool}
                                  />
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-0.5 justify-end">
                        {taskStatus !== 'processing' && taskStatus !== 'pending' && (
                          <button
                            onClick={() => onCopyMessage(agentMessage.id, parseAgentMessage(agentMessage))}
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

        {deploymentNotifications.length > 0 && onDeploymentNotificationClick && (
          <div className="mt-4 px-2">
            <div className="space-y-2">
              {deploymentNotifications.map((deployment, idx) => (
                <button
                  key={deployment.id}
                  onClick={() => onDeploymentNotificationClick(deployment, idx)}
                  className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors border border-border bg-muted/30 text-left"
                >
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

        {(taskStatus === 'processing' || taskStatus === 'pending') &&
          displayMessages.length > 0 &&
          (() => {
            const lastMessage = displayMessages[displayMessages.length - 1]
            if (lastMessage.role !== 'user') return null
            const userMessages = displayMessages.filter((m) => m.role === 'user')
            const isFirstMessage = userMessages.length === 1
            const setupLogs = taskLogs.filter((log) => !log.message.startsWith('[SERVER]')).slice(-8)
            if (isFirstMessage && setupLogs.length > 0) {
              return (
                <div className="mt-4">
                  <div className="text-xs px-2">
                    <div className="space-y-1">
                      <div className="text-muted-foreground font-medium mb-2 flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        正在设置沙箱...
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
                        {formatDuration(lastMessage.createdAt, currentTime)}
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
                      {formatDuration(lastMessage.createdAt, currentTime)}
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

function formatDuration(startTime: number, currentTime: number): string {
  const seconds = Math.floor((currentTime - startTime) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

function parseAgentMessage(message: TaskMessage): string {
  if (message.parts?.length) {
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

function resolveAskUserQuestion(
  message: TaskMessage,
  part: Extract<MessagePart, { type: 'tool_call' }>,
  isPending: boolean,
) {
  if (part.toolName !== 'AskUserQuestion' || !isPending || !part.toolCallId) return undefined
  try {
    const args = typeof part.input === 'string' ? JSON.parse(part.input) : part.input
    // 两种 input 格式：
    //   1. 旧/opencode: { questions: [{ question, header, options:[{label,description}], multiSelect }] }
    //   2. OAK kernel:  { question: string, options?: string[] }（单问题，options 为字符串数组）
    let questions = args?.questions
    if (!Array.isArray(questions) || questions.length === 0) {
      // 尝试 OAK 单问题格式
      if (args && typeof args.question === 'string') {
        const opts: string[] = Array.isArray(args.options) ? args.options : []
        questions = [
          {
            question: args.question,
            header: 'Agent asks a question',
            options: opts.map((o: string) => ({ label: o, description: '' })),
            multiSelect: false,
          },
        ]
      } else {
        return undefined
      }
    }
    return {
      toolCallId: part.toolCallId,
      assistantMessageId: part.assistantMessageId || message.id,
      questions,
    } satisfies AskUserQuestionData
  } catch {
    return undefined
  }
}
