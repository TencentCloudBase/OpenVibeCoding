import { useState, useEffect, createContext, useContext, useCallback, useRef } from 'react'
import { TaskSidebar } from '@/components/task-sidebar'
import type { Task } from '@coder/shared'
import { loadTaskList, prependTask } from '@/lib/task-list-store'
import { ConnectorsProvider } from '@/components/connectors-provider'
import { getSidebarWidth, setSidebarWidth, getSidebarOpen, setSidebarOpen } from '@/lib/utils/cookies'
import type { Connector } from '@/lib/session/types'

interface AppLayoutProps {
  children: React.ReactNode
  initialSidebarWidth?: number
  initialSidebarOpen?: boolean
  initialIsMobile?: boolean
}

interface TasksContextType {
  refreshTasks: () => Promise<void>
  toggleSidebar: () => void
  isSidebarOpen: boolean
  isSidebarResizing: boolean
  addTaskOptimistically: (taskData: {
    prompt: string
    repoUrl: string
    selectedAgent: string
    selectedModel: string
    installDependencies: boolean
    maxDuration: number
    keepAlive?: boolean
    enableBrowser?: boolean
    mcpServerList?: Array<Pick<Connector, 'name' | 'description' | 'type' | 'baseUrl' | 'command' | 'args' | 'headers'>> | null
  }) => { id: string; optimisticTask: Task }
}

const TasksContext = createContext<TasksContextType | undefined>(undefined)

export const useTasks = () => {
  const context = useContext(TasksContext)
  if (!context) {
    throw new Error('useTasks must be used within AppLayout')
  }
  return context
}

function generateId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36)
}

export function AppLayout({ children, initialSidebarWidth, initialSidebarOpen, initialIsMobile }: AppLayoutProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    if (initialIsMobile) return false
    return initialSidebarOpen ?? true
  })
  const [sidebarWidth, setSidebarWidthState] = useState(initialSidebarWidth || getSidebarWidth())
  const [isResizing, setIsResizing] = useState(false)
  const [isDesktop, setIsDesktop] = useState(!initialIsMobile)
  const [hasMounted, setHasMounted] = useState(false)

  const updateSidebarWidth = (newWidth: number) => {
    setSidebarWidthState(newWidth)
    setSidebarWidth(newWidth)
  }

  const updateSidebarOpen = useCallback((isOpen: boolean, saveToCookie = true) => {
    setIsSidebarOpen(isOpen)
    if (saveToCookie && typeof window !== 'undefined' && window.innerWidth >= 1024) {
      setSidebarOpen(isOpen)
    }
  }, [])

  useEffect(() => {
    const actualIsDesktop = window.innerWidth >= 1024
    if (actualIsDesktop !== isDesktop) {
      setIsDesktop(actualIsDesktop)
      if (!actualIsDesktop) {
        setIsSidebarOpen(false)
      } else if (actualIsDesktop && initialIsMobile) {
        const savedPreference = getSidebarOpen()
        setIsSidebarOpen(savedPreference ?? initialSidebarOpen ?? true)
      }
    }
    setHasMounted(true)
  }, [isDesktop, initialIsMobile, initialSidebarOpen])

  const refreshTasks = useCallback(async () => {
    await loadTaskList()
  }, [])

  useEffect(() => {
    void loadTaskList()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void loadTaskList()
    }, 15000)
    return () => clearInterval(interval)
  }, [])

  const toggleSidebar = useCallback(() => {
    updateSidebarOpen(!isSidebarOpen)
  }, [isSidebarOpen, updateSidebarOpen])

  useEffect(() => {
    const handleResize = () => {
      const newIsDesktop = window.innerWidth >= 1024
      setIsDesktop(newIsDesktop)
      if (!newIsDesktop && isSidebarOpen) setIsSidebarOpen(false)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [isSidebarOpen])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [toggleSidebar])

  const addTaskOptimistically = useCallback(
    (taskData: {
      prompt: string
      repoUrl: string
      selectedAgent: string
      selectedModel: string
      installDependencies: boolean
      maxDuration: number
      keepAlive?: boolean
      enableBrowser?: boolean
      mcpServerList?: Array<Pick<Connector, 'name' | 'description' | 'type' | 'baseUrl' | 'command' | 'args' | 'headers'>> | null
    }) => {
      const id = generateId()
      const optimisticTask: Task = {
        id,
        userId: 'temp',
        prompt: taskData.prompt,
        title: null,
        repoUrl: taskData.repoUrl,
        envId: null,
        selectedAgent: taskData.selectedAgent,
        selectedModel: taskData.selectedModel,
        installDependencies: taskData.installDependencies,
        maxDuration: taskData.maxDuration,
        keepAlive: taskData.keepAlive ?? false,
        enableBrowser: taskData.enableBrowser ?? false,
        mode: 'default',
        status: 'pending',
        progress: 0,
        logs: [],
        error: null,
        branchName: null,
        sandboxId: null,
        sandboxSessionId: null,
        sandboxCwd: null,
        sandboxMode: null,
        agentSessionId: null,
        sandboxUrl: null,
        previewUrl: null,
        mcpServerList: (taskData.mcpServerList as unknown as Task['mcpServerList']) ?? null,
        prUrl: null,
        prNumber: null,
        prStatus: null,
        prMergeCommitSha: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
        deletedAt: null,
      }
      prependTask(optimisticTask)
      return { id, optimisticTask }
    },
    [],
  )

  const closeSidebar = () => {
    updateSidebarOpen(false, false)
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const newWidth = e.clientX
      if (newWidth >= 200 && newWidth <= 600) updateSidebarWidth(newWidth)
    }
    const handleMouseUp = () => setIsResizing(false)
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  return (
    <TasksContext.Provider
      value={{
        refreshTasks,
        toggleSidebar,
        isSidebarOpen,
        isSidebarResizing: isResizing,
        addTaskOptimistically,
      }}
    >
      <ConnectorsProvider>
        <div
          className="h-dvh flex relative"
          style={
            {
              '--sidebar-width': `${sidebarWidth}px`,
              '--sidebar-open': isSidebarOpen ? '1' : '0',
            } as React.CSSProperties
          }
        >
          {isSidebarOpen && <div className="lg:hidden fixed inset-0 bg-black/50 z-30" onClick={closeSidebar} />}

          <div
            className={`
            fixed inset-y-0 left-0 z-40
            ${isResizing || !hasMounted ? '' : 'transition-all duration-300 ease-in-out'}
            ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
            ${isSidebarOpen ? 'pointer-events-auto' : 'pointer-events-none'}
          `}
            style={{ width: `${sidebarWidth}px` }}
          >
            <div className="h-full overflow-hidden" style={{ width: `${sidebarWidth}px` }}>
              <TaskSidebar width={sidebarWidth} />
            </div>
          </div>

          <div
            className={`
            hidden lg:block fixed inset-y-0 cursor-col-resize group z-50 hover:bg-primary/20
            ${isResizing || !hasMounted ? '' : 'transition-all duration-300 ease-in-out'}
            ${isSidebarOpen ? 'w-1 opacity-100' : 'w-0 opacity-0'}
          `}
            onMouseDown={isSidebarOpen ? handleMouseDown : undefined}
            style={{ left: isSidebarOpen ? `${sidebarWidth}px` : '0px' }}
          >
            <div className="absolute inset-0 w-2 -ml-0.5" />
            <div className="absolute inset-y-0 left-0 w-0.5 bg-primary/50 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>

          <div
            className={`flex-1 overflow-auto flex flex-col ${isResizing || !hasMounted ? '' : 'transition-all duration-300 ease-in-out'}`}
            style={{ marginLeft: isDesktop && isSidebarOpen ? `${sidebarWidth + 4}px` : '0px' }}
          >
            {children}
          </div>
        </div>
      </ConnectorsProvider>
    </TasksContext.Provider>
  )
}
