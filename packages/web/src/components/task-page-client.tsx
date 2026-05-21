import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router'
import { useTask } from '@/hooks/use-task'
import { TaskDetails } from '@/components/task-details'
import { SharedHeader } from '@/components/shared-header'
import { TaskActions } from '@/components/task-actions'
import { LogsPane } from '@/components/logs-pane'
import type { Session } from '@/lib/session/types'

interface TaskPageClientProps {
  taskId: string
  user: Session['user'] | null
  authProvider: Session['authProvider'] | null
  maxSandboxDuration?: number
}

function parseRepoFromUrl(repoUrl: string | null): { owner: string; repo: string } | null {
  if (!repoUrl) return null
  try {
    const url = new URL(repoUrl)
    const pathParts = url.pathname.split('/').filter(Boolean)
    if (pathParts.length >= 2) {
      return {
        owner: pathParts[0],
        repo: pathParts[1].replace(/\.git$/, ''),
      }
    }
    return null
  } catch {
    return null
  }
}

export function TaskPageClient({
  taskId,
  user: _user,
  authProvider: _authProvider,
  maxSandboxDuration = 300,
}: TaskPageClientProps) {
  const { task, isLoading, error, refetch } = useTask(taskId)
  const [logsPaneHeight, setLogsPaneHeight] = useState(40)

  // 读取 URL ?prompt= 参数，只读一次然后清除
  const [searchParams, setSearchParams] = useSearchParams()
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined)
  const [initialImages, setInitialImages] = useState<Array<{ data: string; mimeType: string }> | undefined>(undefined)
  const promptExtracted = useRef(false)

  useEffect(() => {
    if (promptExtracted.current) return
    promptExtracted.current = true
    const p = searchParams.get('prompt')
    if (p) {
      setInitialPrompt(p)
      // Pick up any images saved to sessionStorage when the task was created
      const storedImages = sessionStorage.getItem(`task-images-${taskId}`)
      if (storedImages) {
        try {
          setInitialImages(JSON.parse(storedImages))
        } catch {
          /* ignore */
        }
        sessionStorage.removeItem(`task-images-${taskId}`)
      }
      // 用 replace 清除 URL 参数，不增加历史记录
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams, taskId])

  const handleInitialPromptConsumed = useCallback(() => {
    setInitialPrompt(undefined)
  }, [])

  const repoInfo = useMemo(() => parseRepoFromUrl(task?.repoUrl ?? null), [task?.repoUrl])

  const headerLeftActions = repoInfo ? (
    <div className="flex items-center gap-2 min-w-0">
      <h1 className="text-lg font-semibold truncate">
        {repoInfo.owner}/{repoInfo.repo}
      </h1>
    </div>
  ) : null

  if (isLoading) {
    return (
      <div className="flex-1 bg-background">
        <div className="p-3">
          <SharedHeader />
        </div>
      </div>
    )
  }

  if (error || !task) {
    return (
      <div className="flex-1 bg-background">
        <div className="p-3">
          <SharedHeader />
        </div>
        <div className="mx-auto p-3">
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <h2 className="text-lg font-semibold mb-2">Task Not Found</h2>
              <p className="text-muted-foreground">{error || 'The requested task could not be found.'}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-background relative flex flex-col h-full overflow-hidden">
      <div className="flex-shrink-0 px-3 py-2 border-b">
        <SharedHeader leftActions={headerLeftActions} extraActions={<TaskActions task={task} />} />
      </div>

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ paddingBottom: `${logsPaneHeight}px` }}>
        <TaskDetails
          task={task}
          maxSandboxDuration={maxSandboxDuration}
          onStreamComplete={refetch}
          onTaskRefetch={refetch}
          initialPrompt={initialPrompt}
          initialImages={initialImages}
          onInitialPromptConsumed={handleInitialPromptConsumed}
        />
      </div>

      <LogsPane task={task} onHeightChange={setLogsPaneHeight} />
    </div>
  )
}
