import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { useAtomValue } from 'jotai'
import { useTasks } from '@/components/app-layout'
import { taskListAtom, taskListLoadingAtom } from '@/lib/atoms/task-list'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertCircle, Trash2, Square, StopCircle, CheckSquare, X, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Claude, CodeBuddy, Codex, Copilot, Cursor, Gemini, OpenCode } from '@/components/logos'
import { PRStatusIcon } from '@/components/pr-status-icon'
import { PRCheckStatus } from '@/components/pr-check-status'
import { SharedHeader } from '@/components/shared-header'
import type { Task } from '@coder/shared'

const AGENT_MODELS = {
  claude: [
    { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    { value: 'anthropic/claude-opus-4.6', label: 'Opus 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  codex: [
    { value: 'openai/gpt-5.1', label: 'GPT-5.1' },
    { value: 'openai/gpt-5.1-codex', label: 'GPT-5.1-Codex' },
    { value: 'openai/gpt-5', label: 'GPT-5' },
    { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
  ],
  copilot: [
    { value: 'claude-sonnet-4.5', label: 'Sonnet 4.5' },
    { value: 'gpt-5', label: 'GPT-5' },
  ],
  cursor: [
    { value: 'auto', label: 'Auto' },
    { value: 'composer-1', label: 'Composer' },
    { value: 'sonnet-4.5', label: 'Sonnet 4.5' },
  ],
  gemini: [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  opencode: [
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  ],
} as const

function getTimeAgo(date: Date | number | string): string {
  const now = new Date()
  const diffInMs = now.getTime() - new Date(date).getTime()
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60))
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60))
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24))

  if (diffInMinutes < 1) return 'just now'
  if (diffInMinutes === 1) return '1 minute ago'
  if (diffInMinutes < 60) return `${diffInMinutes} minutes ago`
  if (diffInHours === 1) return '1 hour ago'
  if (diffInHours < 24) return `${diffInHours} hours ago`
  if (diffInDays === 1) return 'yesterday'
  if (diffInDays < 7) return `${diffInDays} days ago`
  return new Date(date).toLocaleDateString()
}

function getAgentLogo(agent: string | null | undefined) {
  if (!agent) return null
  switch (agent.toLowerCase()) {
    case 'claude':
      return Claude
    case 'codex':
      return Codex
    case 'copilot':
      return Copilot
    case 'cursor':
      return Cursor
    case 'gemini':
      return Gemini
    case 'opencode':
      return OpenCode
    case 'codebuddy':
      return CodeBuddy
    default:
      return null
  }
}

function getHumanFriendlyModelName(agent: string | null | undefined, model: string | null | undefined) {
  if (!agent || !model) return model
  const agentModels = AGENT_MODELS[agent as keyof typeof AGENT_MODELS]
  if (!agentModels) return model
  const modelInfo = (agentModels as ReadonlyArray<{ value: string; label: string }>).find((m) => m.value === model)
  return modelInfo ? modelInfo.label : model
}

export function TasksListPage() {
  const navigate = useNavigate()
  const { refreshTasks } = useTasks()
  const tasks = useAtomValue(taskListAtom)
  const isInitialLoading = useAtomValue(taskListLoadingAtom)
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set())
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showStopDialog, setShowStopDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isStopping, setIsStopping] = useState(false)

  const activeTasks = useMemo(() => tasks.filter((task: Task) => !task.deletedAt), [tasks])

  const filteredTasks = useMemo(() => {
    if (statusFilter === 'all') return activeTasks
    return activeTasks.filter((task: Task) => task.status === statusFilter)
  }, [activeTasks, statusFilter])

  const handleSelectAll = () => {
    if (selectedTasks.size === filteredTasks.length) {
      setSelectedTasks(new Set())
    } else {
      setSelectedTasks(new Set(filteredTasks.map((task: Task) => task.id)))
    }
  }

  const handleSelectTask = (taskId: string) => {
    const next = new Set(selectedTasks)
    if (next.has(taskId)) {
      next.delete(taskId)
    } else {
      next.add(taskId)
    }
    setSelectedTasks(next)
  }

  const handleBulkDelete = async () => {
    setIsDeleting(true)
    try {
      const results = await Promise.all(
        Array.from(selectedTasks).map((id) => fetch(`/api/tasks/${id}`, { method: 'DELETE', credentials: 'include' })),
      )
      const successCount = results.filter((r) => r.ok).length
      const failCount = results.length - successCount
      if (successCount > 0) toast.success(`Deleted ${successCount} task${successCount > 1 ? 's' : ''}`)
      if (failCount > 0) {
        // 收集失败 task 的详细原因
        const failures = await Promise.all(
          results
            .filter((r) => !r.ok)
            .map(async (r) => {
              try {
                const data = await r.json()
                const detail = Array.isArray(data?.failed)
                  ? data.failed.map((f: any) => `[${f.step}] ${f.message || f.code || 'failed'}`).join('；')
                  : data?.detail || ''
                return detail ? `${data.error || ''}：${detail}` : data?.error || 'unknown'
              } catch {
                return 'unknown'
              }
            }),
        )
        const reasonSummary = failures.join(' | ')
        toast.error(
          `Failed to delete ${failCount} task${failCount > 1 ? 's' : ''}${reasonSummary ? `：${reasonSummary}` : ''}`,
        )
      }
      setSelectedTasks(new Set())
      setShowDeleteDialog(false)
      await refreshTasks()
    } catch {
      toast.error('Failed to delete tasks')
    } finally {
      setIsDeleting(false)
    }
  }

  const handleBulkStop = async () => {
    setIsStopping(true)
    try {
      const runningIds = Array.from(selectedTasks).filter((id) => {
        const task = tasks.find((t: Task) => t.id === id)
        return task?.status === 'processing'
      })
      if (runningIds.length === 0) {
        toast.error('No running tasks selected')
        setShowStopDialog(false)
        setIsStopping(false)
        return
      }
      const results = await Promise.all(
        runningIds.map((id) =>
          fetch(`/api/tasks/${id}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop' }),
          }),
        ),
      )
      const successCount = results.filter((r) => r.ok).length
      const failCount = results.length - successCount
      if (successCount > 0) toast.success(`Stopped ${successCount} task${successCount > 1 ? 's' : ''}`)
      if (failCount > 0) toast.error(`Failed to stop ${failCount} task${failCount > 1 ? 's' : ''}`)
      setSelectedTasks(new Set())
      setShowStopDialog(false)
      await refreshTasks()
    } catch {
      toast.error('Failed to stop tasks')
    } finally {
      setIsStopping(false)
    }
  }

  const selectedProcessingCount = Array.from(selectedTasks).filter((id) => {
    const task = tasks.find((t: Task) => t.id === id)
    return task?.status === 'processing'
  }).length

  return (
    <div className="flex-1 bg-background flex flex-col h-full overflow-hidden">
      <div className="flex-shrink-0 p-3">
        <SharedHeader />
      </div>

      <div className="flex-1 overflow-auto px-4 pb-4">
        <div className="max-w-7xl mx-auto">
          {/* Toolbar */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleSelectAll} disabled={filteredTasks.length === 0}>
                {selectedTasks.size === filteredTasks.length && filteredTasks.length > 0 ? (
                  <>
                    <CheckSquare className="h-4 w-4 mr-2" />
                    Deselect All
                  </>
                ) : (
                  <>
                    <Square className="h-4 w-4 mr-2" />
                    Select All
                  </>
                )}
              </Button>
              {selectedTasks.size > 0 && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setSelectedTasks(new Set())}>
                    <X className="h-4 w-4 mr-2" />
                    Clear Selection
                  </Button>
                  <span className="text-sm text-muted-foreground">{selectedTasks.size} selected</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px] h-9">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tasks</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="processing">Processing</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="error">Failed</SelectItem>
                  <SelectItem value="stopped">Stopped</SelectItem>
                </SelectContent>
              </Select>
              {selectedTasks.size > 0 && (
                <>
                  {selectedProcessingCount > 0 && (
                    <Button variant="outline" size="sm" onClick={() => setShowStopDialog(true)} disabled={isStopping}>
                      <StopCircle className="h-4 w-4" />
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setShowDeleteDialog(true)} disabled={isDeleting}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Tasks List */}
          {isInitialLoading ? (
            <div className="flex items-center justify-center h-64">
              <div className="text-muted-foreground">Loading tasks...</div>
            </div>
          ) : filteredTasks.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <div className="text-muted-foreground">
                  {statusFilter === 'all' ? 'No tasks yet. Create your first task!' : `No ${statusFilter} tasks.`}
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {filteredTasks.map((task: Task) => (
                <Card
                  key={task.id}
                  className={cn(
                    'transition-colors hover:bg-accent cursor-pointer p-0',
                    selectedTasks.has(task.id) && 'ring-2 ring-primary',
                  )}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('input[type="checkbox"]')) return
                    navigate(`/tasks/${task.id}`)
                  }}
                >
                  <CardContent className="px-3 py-2">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selectedTasks.has(task.id)}
                        onCheckedChange={() => handleSelectTask(task.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-sm font-medium truncate flex-1">{(task as any).title || task.prompt}</h3>
                          {task.status === 'error' && <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />}
                          {task.status === 'stopped' && (
                            <AlertCircle className="h-4 w-4 text-orange-500 flex-shrink-0" />
                          )}
                        </div>
                        {(task as any).repoUrl && (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                            {(task as any).prStatus && (
                              <div className="relative">
                                <PRStatusIcon status={(task as any).prStatus} />
                                <PRCheckStatus
                                  taskId={task.id}
                                  prStatus={(task as any).prStatus}
                                  isActive={task.status === 'processing'}
                                />
                              </div>
                            )}
                            <span className="truncate">
                              {(() => {
                                try {
                                  const url = new URL((task as any).repoUrl)
                                  const parts = url.pathname.split('/').filter(Boolean)
                                  if (parts.length >= 2) return `${parts[0]}/${parts[1].replace(/\.git$/, '')}`
                                  return 'Unknown repository'
                                } catch {
                                  return 'Invalid repository URL'
                                }
                              })()}
                            </span>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {(task as any).selectedAgent && (
                            <div className="flex items-center gap-1">
                              {(() => {
                                const AgentLogo = getAgentLogo((task as any).selectedAgent)
                                return AgentLogo ? <AgentLogo className="w-3 h-3" /> : null
                              })()}
                              {(task as any).selectedModel && (
                                <span>
                                  {getHumanFriendlyModelName((task as any).selectedAgent, (task as any).selectedModel)}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            <span>{getTimeAgo(task.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Selected Tasks</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectedTasks.size} task{selectedTasks.size > 1 ? 's' : ''}? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkDelete} disabled={isDeleting} className="bg-red-600 hover:bg-red-700">
              {isDeleting ? 'Deleting...' : 'Delete Tasks'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Stop Dialog */}
      <AlertDialog open={showStopDialog} onOpenChange={setShowStopDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop Running Tasks</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to stop {selectedProcessingCount} running task
              {selectedProcessingCount > 1 ? 's' : ''}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkStop}
              disabled={isStopping}
              className="bg-orange-600 hover:bg-orange-700"
            >
              {isStopping ? 'Stopping...' : 'Stop Tasks'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
