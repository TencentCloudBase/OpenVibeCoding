import type { Task, LogEntry } from '@coder/shared'
import { Button } from '@/components/ui/button'
import { Copy, Check, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState, useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { useTasks } from '@/components/app-layout'
import { streamLogsAtomFamily } from '@/lib/atoms/stream-logs'
import { getLogsPaneHeight, setLogsPaneHeight, getLogsPaneCollapsed, setLogsPaneCollapsed } from '@/lib/utils/cookies'
import { Terminal, TerminalRef } from '@/components/terminal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface LogsPaneProps {
  task: Task
  onHeightChange?: (height: number) => void
}

type TabType = 'logs' | 'terminal'
type LogFilterType = 'all' | 'platform' | 'server'

/** ttyd/xterm needs a real pixel height; smaller panes render a blank black iframe */
const TERMINAL_PANE_MIN_HEIGHT = 200
const PANE_HEIGHT_MIN = 100
const PANE_HEIGHT_MAX_CAP = 600

export function LogsPane({ task, onHeightChange }: LogsPaneProps) {
  const [copiedLogs, setCopiedLogs] = useState(false)
  const [isCollapsed, setIsCollapsedState] = useState(true)
  const [paneHeight, setPaneHeight] = useState(200)
  const [isResizing, setIsResizing] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)
  const [hasMounted, setHasMounted] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>('logs')
  const [isClearingLogs, setIsClearingLogs] = useState(false)
  const [logFilter, setLogFilter] = useState<LogFilterType>('all')
  const logsContainerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<TerminalRef>(null)
  const prevLogsLengthRef = useRef<number>(0)
  const hasInitialScrolled = useRef<boolean>(false)
  const wasAtBottomRef = useRef<boolean>(true)
  const { isSidebarOpen, isSidebarResizing, refreshTasks } = useTasks()
  const setStreamLogs = useSetAtom(streamLogsAtomFamily(task.id))

  // Check if we're on desktop
  useEffect(() => {
    const checkDesktop = () => {
      setIsDesktop(window.innerWidth >= 1024)
    }

    checkDesktop()

    // Delay enabling transitions until after the browser has painted the correct position
    requestAnimationFrame(() => {
      setHasMounted(true)
    })

    window.addEventListener('resize', checkDesktop)
    return () => window.removeEventListener('resize', checkDesktop)
  }, [])

  // Initialize height and collapsed state from cookies on mount
  useEffect(() => {
    const savedHeight = getLogsPaneHeight()
    const savedCollapsed = getLogsPaneCollapsed()
    setPaneHeight(savedHeight)
    setIsCollapsedState(savedCollapsed)
    // Notify parent of initial height
    onHeightChange?.(savedCollapsed ? 40 : savedHeight)
  }, [onHeightChange])

  // Wrapper to update both state and cookie
  const setIsCollapsed = (collapsed: boolean) => {
    setIsCollapsedState(collapsed)
    setLogsPaneCollapsed(collapsed)
    // Notify parent of height change (collapsed = ~40px, expanded = paneHeight)
    onHeightChange?.(collapsed ? 40 : paneHeight)
  }

  // Notify parent when paneHeight changes
  useEffect(() => {
    if (!isCollapsed) {
      onHeightChange?.(paneHeight)
    }
  }, [paneHeight, isCollapsed, onHeightChange])

  const paneHeightMax = () => Math.min(PANE_HEIGHT_MAX_CAP, Math.floor(window.innerHeight * 0.75))

  // Drag top edge to resize (pointer capture — do not tie to header click-to-collapse)
  useEffect(() => {
    if (!isResizing) return

    const handlePointerMove = (e: PointerEvent) => {
      const maxHeight = paneHeightMax()
      const newHeight = window.innerHeight - e.clientY
      if (newHeight >= PANE_HEIGHT_MIN && newHeight <= maxHeight) {
        setPaneHeight(newHeight)
        setLogsPaneHeight(newHeight)
      }
    }

    const endResize = () => {
      setIsResizing(false)
      window.dispatchEvent(new Event('resize'))
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', endResize)
    document.addEventListener('pointercancel', endResize)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', endResize)
      document.removeEventListener('pointercancel', endResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  // Track if user is at the bottom of logs
  useEffect(() => {
    const logsContainer = logsContainerRef.current
    if (!logsContainer) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = logsContainer
      // Consider "at bottom" if within 50px of the bottom
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50
      wasAtBottomRef.current = isAtBottom
    }

    logsContainer.addEventListener('scroll', handleScroll)
    return () => logsContainer.removeEventListener('scroll', handleScroll)
  }, [])

  // Scroll to bottom on initial load
  useEffect(() => {
    if (task.logs && task.logs.length > 0 && !hasInitialScrolled.current && logsContainerRef.current) {
      setTimeout(() => {
        if (logsContainerRef.current) {
          logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight
          hasInitialScrolled.current = true
          wasAtBottomRef.current = true
        }
      }, 100)
    }
  }, [task.logs])

  // Auto-scroll to bottom when new logs are added (only if user was already at bottom)
  useEffect(() => {
    const currentLogsLength = task.logs?.length || 0

    if (currentLogsLength > prevLogsLengthRef.current && prevLogsLengthRef.current > 0) {
      // Only auto-scroll if user was at the bottom
      if (logsContainerRef.current && wasAtBottomRef.current) {
        logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight
      }
    }

    prevLogsLengthRef.current = currentLogsLength
  }, [task.logs])

  // Helper function to filter logs based on current filter
  const getFilteredLogs = (filter: LogFilterType) => {
    return (task.logs || []).filter((log) => {
      const isServerLog = log.message.startsWith('[SERVER]')
      if (filter === 'server') return isServerLog
      if (filter === 'platform') return !isServerLog
      return true
    })
  }

  const copyLogsToClipboard = async () => {
    try {
      const filteredLogs = getFilteredLogs(logFilter)
      const logsText = filteredLogs.map((log) => log.message).join('\n')

      await navigator.clipboard.writeText(logsText)
      setCopiedLogs(true)
      setTimeout(() => setCopiedLogs(false), 2000)
    } catch {
      toast.error('Failed to copy logs to clipboard')
    }
  }

  const clearLogs = async () => {
    if (isClearingLogs) return

    setIsClearingLogs(true)
    try {
      const response = await fetch(`/api/tasks/${task.id}/clear-logs`, {
        method: 'POST',
      })

      if (response.ok) {
        setStreamLogs([])
        refreshTasks()
      } else {
        const error = await response.json()
        toast.error(error.error || 'Failed to clear logs')
      }
    } catch (error) {
      console.error('Error clearing logs:', error)
      toast.error('Failed to clear logs')
    } finally {
      setIsClearingLogs(false)
    }
  }

  const clearTerminal = () => {
    if (terminalRef.current) {
      terminalRef.current.clear()
    }
  }

  const openTerminalTab = () => {
    if (isCollapsed) {
      setIsCollapsed(false)
    }
    if (paneHeight < TERMINAL_PANE_MIN_HEIGHT) {
      setPaneHeight(TERMINAL_PANE_MIN_HEIGHT)
      setLogsPaneHeight(TERMINAL_PANE_MIN_HEIGHT)
      onHeightChange?.(TERMINAL_PANE_MIN_HEIGHT)
    }
    setActiveTab('terminal')
  }

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setIsResizing(true)
  }

  return (
    <div
      className={`fixed bottom-0 right-0 z-10 bg-background ${isResizing || isSidebarResizing || !hasMounted ? '' : 'transition-[left] duration-300 ease-in-out'}`}
      style={{
        left: isDesktop && isSidebarOpen ? 'var(--sidebar-width)' : '0px',
        height: isCollapsed ? 'auto' : `${paneHeight}px`,
      }}
    >
      <div className={cn('flex flex-col border-t', isCollapsed ? '' : 'h-full min-h-0')}>
        {!isCollapsed && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize logs pane"
            className={cn(
              'flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center border-b',
              isResizing ? 'bg-primary/20' : 'bg-muted/40 hover:bg-muted/60',
            )}
            onPointerDown={handleResizePointerDown}
          >
            <div className="h-1 w-10 rounded-full bg-border" />
          </div>
        )}
        <div className="relative flex flex-shrink-0 items-center justify-between border-b">
          <div className="flex min-w-0 flex-1 items-center justify-between">
            <div className="flex flex-1 items-center gap-1.5 px-3 py-1.5">
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center rounded hover:bg-accent"
                aria-label={isCollapsed ? 'Expand logs pane' : 'Collapse logs pane'}
                onClick={() => setIsCollapsed(!isCollapsed)}
              >
                {isCollapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (isCollapsed) {
                      setIsCollapsed(false)
                    }
                    setActiveTab('logs')
                  }}
                  className={cn(
                    'text-xs font-medium uppercase tracking-wide transition-colors px-2 py-1 rounded',
                    activeTab === 'logs'
                      ? 'text-foreground bg-accent'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                  )}
                >
                  Logs
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    openTerminalTab()
                  }}
                  className={cn(
                    'text-xs font-medium uppercase tracking-wide transition-colors px-2 py-1 rounded',
                    activeTab === 'terminal'
                      ? 'text-foreground bg-accent'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                  )}
                >
                  Terminal
                </button>
              </div>
            </div>
            {activeTab === 'logs' && (
              <div className="flex items-center gap-1.5 mr-3" onClick={(e) => e.stopPropagation()}>
                <Select value={logFilter} onValueChange={(value) => setLogFilter(value as LogFilterType)}>
                  <SelectTrigger size="sm" className="h-6 text-xs px-2 py-0 min-w-[90px] border-0 shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="platform">Platform</SelectItem>
                    <SelectItem value="server">Server</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearLogs}
                  disabled={isClearingLogs}
                  className="h-5 w-5 p-0 hover:bg-accent"
                  title="Clear logs"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copyLogsToClipboard}
                  className="h-5 w-5 p-0 hover:bg-accent"
                  title="Copy logs to clipboard"
                >
                  {copiedLogs ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
            )}
            {activeTab === 'terminal' && (
              <div className="flex items-center gap-1 mr-3" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearTerminal}
                  className="h-5 w-5 p-0 hover:bg-accent"
                  title="重新加载终端"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        </div>
        <div
          ref={logsContainerRef}
          className={cn(
            'bg-black text-green-400 p-2 font-mono text-xs flex-1 overflow-y-auto leading-relaxed',
            (isCollapsed || activeTab !== 'logs') && 'hidden',
            isResizing && 'pointer-events-none select-none',
          )}
        >
          {getFilteredLogs(logFilter).length === 0 ? (
            <div className="text-muted-foreground/70 italic px-1 py-2">
              暂无日志。Agent 启动沙箱或执行任务后，平台进度会显示在这里。
            </div>
          ) : null}
          {getFilteredLogs(logFilter).map((log, index) => {
            const isServerLog = log.message.startsWith('[SERVER]')
            const messageContent = isServerLog ? log.message.substring(9) : log.message // Remove '[SERVER] '

            const getLogColor = (logType: LogEntry['type']) => {
              switch (logType) {
                case 'command':
                  return 'text-cyan-400'
                case 'error':
                  return 'text-red-400'
                case 'success':
                  return 'text-green-400'
                case 'info':
                default:
                  return 'text-white'
              }
            }

            const formatTime = (timestamp: number | Date | undefined) => {
              return new Date(timestamp ?? 0).toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                fractionalSecondDigits: 3,
              } as Intl.DateTimeFormatOptions)
            }

            return (
              <div key={index} className={cn('flex gap-1.5 leading-tight')}>
                <span className="text-white/40 text-[10px] shrink-0">[{formatTime(log.timestamp || Date.now())}]</span>
                <span className={cn('flex-1', getLogColor(log.type))}>
                  {isServerLog && <span className="text-purple-400">[SERVER]</span>}
                  {isServerLog && ' '}
                  {messageContent}
                </span>
              </div>
            )
          })}
        </div>
        <div
          className={cn(
            'relative flex-1 min-h-[12rem] overflow-hidden bg-black',
            (isCollapsed || activeTab !== 'terminal') && 'hidden',
            isResizing && 'pointer-events-none select-none',
          )}
        >
          <Terminal
            ref={terminalRef}
            taskId={task.id}
            isActive={activeTab === 'terminal' && !isCollapsed}
            isMobile={!isDesktop}
            sandboxReady={!!task.sandboxId}
          />
        </div>
      </div>
    </div>
  )
}
