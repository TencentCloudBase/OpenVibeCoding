import { useState, useEffect } from 'react'
import { TaskForm } from '@/components/task-form'
import { SharedHeader } from '@/components/shared-header'
import { RepoSelector } from '@/components/repo-selector'
import { toast } from 'sonner'
import { useNavigate, useLocation } from 'react-router'
import { useTasks } from '@/components/app-layout'
import { setSelectedOwner, setSelectedRepo } from '@/lib/utils/cookies'
import type { Session } from '@/lib/session/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { MoreHorizontal, RefreshCw, Unlink, Settings, Plus, ExternalLink } from 'lucide-react'
import { GitHubIcon } from '@/components/icons/github-icon'
import { getEnabledAuthProviders } from '@/lib/auth/providers'
import { useSetAtom, useAtom, useAtomValue } from 'jotai'
import { taskPromptAtom } from '@/lib/atoms/task'
import { HomePageMobileFooter } from '@/components/home-page-mobile-footer'
import { multiRepoModeAtom, selectedReposAtom } from '@/lib/atoms/github'
import { sessionAtom } from '@/lib/atoms/session'
import { githubConnectionAtom, githubConnectionInitializedAtom } from '@/lib/atoms/github'
import { OpenRepoUrlDialog } from '@/components/open-repo-url-dialog'
import { MultiRepoDialog } from '@/components/multi-repo-dialog'

interface HomePageContentProps {
  initialSelectedOwner?: string
  initialSelectedRepo?: string
  initialInstallDependencies?: boolean
  initialMaxDuration?: number
  initialKeepAlive?: boolean
  initialEnableBrowser?: boolean
  maxSandboxDuration?: number
  user?: Session['user'] | null
}

function LocalSignInForm({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const setSession = useSetAtom(sessionAtom)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'An error occurred')
      } else {
        setSession({ user: data.user, envId: data.envId })
        onSuccess()
      }
    } catch {
      setError('Network error, please try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex gap-2 text-sm">
        <button
          type="button"
          className={`font-medium ${mode === 'login' ? 'text-foreground underline' : 'text-muted-foreground'}`}
          onClick={() => {
            setMode('login')
            setError('')
          }}
        >
          Login
        </button>
        <span className="text-muted-foreground">/</span>
        <button
          type="button"
          className={`font-medium ${mode === 'register' ? 'text-foreground underline' : 'text-muted-foreground'}`}
          onClick={() => {
            setMode('register')
            setError('')
          }}
        >
          Register
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="signin-username">Username</Label>
        <Input
          id="signin-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Enter username"
          autoComplete="username"
          required
          minLength={3}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="signin-password">Password</Label>
        <Input
          id="signin-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          minLength={6}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={loading} size="lg" className="w-full">
        {loading ? 'Loading...' : mode === 'login' ? 'Login' : 'Register'}
      </Button>
    </form>
  )
}

export function HomePageContent({
  initialSelectedOwner = '',
  initialSelectedRepo = '',
  initialInstallDependencies = false,
  initialMaxDuration = 300,
  initialKeepAlive = false,
  initialEnableBrowser = false,
  maxSandboxDuration = 300,
  user = null,
}: HomePageContentProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [selectedOwner, setSelectedOwnerState] = useState(initialSelectedOwner)
  const [selectedRepo, setSelectedRepoState] = useState(initialSelectedRepo)
  const [showSignInDialog, setShowSignInDialog] = useState(false)
  const [loadingGitHub, setLoadingGitHub] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showOpenRepoDialog, setShowOpenRepoDialog] = useState(false)
  const [showMultiRepoDialog, setShowMultiRepoDialog] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const searchParams = new URLSearchParams(location.search)
  const { refreshTasks, addTaskOptimistically } = useTasks()
  const setTaskPrompt = useSetAtom(taskPromptAtom)

  // Multi-repo mode state
  const multiRepoMode = useAtomValue(multiRepoModeAtom)
  const [selectedRepos, setSelectedRepos] = useAtom(selectedReposAtom)

  // GitHub connection state
  const session = useAtomValue(sessionAtom)
  const githubConnection = useAtomValue(githubConnectionAtom)
  const githubConnectionInitialized = useAtomValue(githubConnectionInitializedAtom)
  const setGitHubConnection = useSetAtom(githubConnectionAtom)
  const isGitHubAuthUser = session.authProvider === 'github'

  // Check which auth providers are enabled
  const { github: hasGitHub } = getEnabledAuthProviders()

  // Show toast if GitHub was connected (user was already logged in)
  useEffect(() => {
    if (searchParams.get('github_connected') === 'true') {
      toast.success('GitHub account connected successfully!')
      // Remove the query parameter from URL
      const newUrl = new URL(window.location.href)
      newUrl.searchParams.delete('github_connected')
      window.history.replaceState({}, '', newUrl.toString())
    }
  }, [])

  // Check for newly created repo and select it
  useEffect(() => {
    const newlyCreatedRepo = localStorage.getItem('newly-created-repo')
    if (newlyCreatedRepo) {
      try {
        const { owner, repo } = JSON.parse(newlyCreatedRepo)
        if (owner && repo) {
          // Set owner and repo directly without triggering the clear logic
          setSelectedOwnerState(owner)
          setSelectedOwner(owner)
          setSelectedRepoState(repo)
          setSelectedRepo(repo)
        }
      } catch (error) {
        console.error('Error parsing newly created repo:', error)
      } finally {
        // Clear the localStorage item after using it
        localStorage.removeItem('newly-created-repo')
      }
    }
  }, []) // Run only on mount

  // Check for URL query parameters for owner and repo
  useEffect(() => {
    const urlOwner = searchParams.get('owner')
    const urlRepo = searchParams.get('repo')

    if (urlOwner && urlOwner !== selectedOwner) {
      setSelectedOwnerState(urlOwner)
      setSelectedOwner(urlOwner)
    }
    if (urlRepo && urlRepo !== selectedRepo) {
      setSelectedRepoState(urlRepo)
      setSelectedRepo(urlRepo)
    }
  }, [location.search, selectedOwner, selectedRepo])

  // Wrapper functions to update both state and cookies
  const handleOwnerChange = (owner: string) => {
    setSelectedOwnerState(owner)
    setSelectedOwner(owner)
    // Clear repo when owner changes
    if (selectedRepo) {
      setSelectedRepoState('')
      setSelectedRepo('')
    }
  }

  const handleRepoChange = (repo: string) => {
    setSelectedRepoState(repo)
    setSelectedRepo(repo)
  }

  const handleRefreshOwners = () => {
    setIsRefreshing(true)
    localStorage.removeItem('github-owners')
    toast.success('Refreshing owners...')
    window.location.reload()
  }

  const handleRefreshRepos = () => {
    setIsRefreshing(true)
    if (selectedOwner) {
      localStorage.removeItem(`github-repos-${selectedOwner}`)
      toast.success('Refreshing repositories...')
    } else {
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('github-repos-')) {
          localStorage.removeItem(key)
        }
      })
      toast.success('Refreshing all repositories...')
    }
    window.location.reload()
  }

  const handleDisconnectGitHub = async () => {
    try {
      const response = await fetch('/api/auth/github/disconnect', {
        method: 'POST',
        credentials: 'include',
      })

      if (response.ok) {
        toast.success('GitHub disconnected')
        localStorage.removeItem('github-owners')
        Object.keys(localStorage).forEach((key) => {
          if (key.startsWith('github-repos-')) {
            localStorage.removeItem(key)
          }
        })
        handleOwnerChange('')
        handleRepoChange('')
        setGitHubConnection({ connected: false })
      } else {
        const error = await response.json()
        console.error('Failed to disconnect GitHub:', error)
        toast.error(error.error || 'Failed to disconnect GitHub')
      }
    } catch (error) {
      console.error('Failed to disconnect GitHub:', error)
      toast.error('Failed to disconnect GitHub')
    }
  }

  const handleNewRepo = () => {
    const url = selectedOwner ? `/repos/new?owner=${selectedOwner}` : '/repos/new'
    navigate(url)
  }

  const handleConnectGitHub = () => {
    window.location.href = '/api/auth/github/signin'
  }

  const handleReconfigureGitHub = () => {
    window.location.href = '/api/auth/github/signin'
  }

  const handleOpenRepoUrl = async (repoUrl: string) => {
    try {
      if (!user) {
        toast.error('Sign in required', {
          description: 'Please sign in to create tasks with custom repository URLs.',
        })
        return
      }

      const taskData = {
        prompt: 'Work on this repository',
        repoUrl: repoUrl,
        selectedAgent: localStorage.getItem('last-selected-agent') || 'claude',
        selectedModel: localStorage.getItem('last-selected-model-claude') || 'claude-sonnet-4-5',
        installDependencies: true,
        maxDuration: 300,
        keepAlive: false,
      }

      const { id } = addTaskOptimistically(taskData)

      // 原子操作：创建 task + 初始化 ACP session
      const [taskRes, initRes] = await Promise.all([
        fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...taskData, id }),
        }),
        fetch('/api/agent/acp', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: 1 } }),
        }),
      ])

      if (!taskRes.ok) {
        const err = await taskRes.json()
        toast.error(err.message || err.error || 'Failed to create task')
        return
      }
      if (!initRes.ok) {
        toast.error('Failed to initialize agent session')
        return
      }

      await fetch('/api/agent/acp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'session/new', id: 2, params: { conversationId: id } }),
      })

      navigate(`/tasks/${id}?prompt=${encodeURIComponent(taskData.prompt)}`)
    } catch (error) {
      console.error('Error creating task:', error)
      toast.error('Failed to create task')
    }
  }

  // Build leftActions for the header
  const headerLeftActions = (
    <div className="flex items-center gap-1 sm:gap-2 h-8 min-w-0 flex-1">
      {!githubConnectionInitialized ? null : githubConnection.connected || isGitHubAuthUser ? (
        <>
          <RepoSelector
            selectedOwner={selectedOwner}
            selectedRepo={selectedRepo}
            onOwnerChange={handleOwnerChange}
            onRepoChange={handleRepoChange}
            size="sm"
            onMultiRepoClick={() => setShowMultiRepoDialog(true)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 flex-shrink-0" title="More options">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={handleNewRepo}>
                <Plus className="h-4 w-4 mr-2" />
                New Repo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowOpenRepoDialog(true)}>
                <ExternalLink className="h-4 w-4 mr-2" />
                Open Repo URL
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleRefreshOwners} disabled={isRefreshing}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                Refresh Owners
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleRefreshRepos} disabled={isRefreshing}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                Refresh Repos
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleReconfigureGitHub}>
                <Settings className="h-4 w-4 mr-2" />
                Manage Access
              </DropdownMenuItem>
              {!isGitHubAuthUser && (
                <DropdownMenuItem onClick={handleDisconnectGitHub}>
                  <Unlink className="h-4 w-4 mr-2" />
                  Disconnect GitHub
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : user ? (
        <Button onClick={handleConnectGitHub} variant="outline" size="sm" className="h-8 flex-shrink-0">
          <GitHubIcon className="h-4 w-4 mr-2" />
          Connect GitHub
        </Button>
      ) : selectedOwner || selectedRepo ? (
        <RepoSelector
          selectedOwner={selectedOwner}
          selectedRepo={selectedRepo}
          onOwnerChange={handleOwnerChange}
          onRepoChange={handleRepoChange}
          size="sm"
        />
      ) : null}
    </div>
  )

  const handleTaskSubmit = async (data: {
    prompt: string
    repoUrl: string
    selectedAgent: string
    selectedModel: string
    selectedModels?: string[]
    installDependencies: boolean
    maxDuration: number
    keepAlive: boolean
    enableBrowser: boolean
    mode: 'default' | 'coding'
  }) => {
    console.log(
      '[TaskSubmit] called, isSubmitting:',
      isSubmitting,
      'user:',
      !!user,
      'prompt:',
      data.prompt?.slice(0, 20),
    )
    // Check if user is authenticated
    if (!user) {
      console.log('[TaskSubmit] no user, showing sign-in dialog')
      setShowSignInDialog(true)
      return
    }

    // Check if multi-repo mode is enabled
    if (multiRepoMode) {
      if (selectedRepos.length === 0) {
        toast.error('Please select repositories', {
          description: 'Click on "0 repos selected" to choose repositories.',
        })
        return
      }
    } else {
      // Repository is optional in the new version
    }

    // Clear the saved prompt since we're actually submitting it now
    setTaskPrompt('')

    setIsSubmitting(true)
    console.log('[TaskSubmit] setIsSubmitting(true), multiRepoMode:', multiRepoMode)

    // Check if this is multi-repo mode
    if (multiRepoMode && selectedRepos.length > 0) {
      // Create multiple tasks, one for each selected repo
      const taskIds: string[] = []
      const tasksData = selectedRepos.map((repo) => {
        const { id } = addTaskOptimistically({
          prompt: data.prompt,
          repoUrl: repo.clone_url,
          selectedAgent: data.selectedAgent,
          selectedModel: data.selectedModel,
          installDependencies: data.installDependencies,
          maxDuration: data.maxDuration,
        })
        taskIds.push(id)
        return {
          id,
          prompt: data.prompt,
          repoUrl: repo.clone_url,
          selectedAgent: data.selectedAgent,
          selectedModel: data.selectedModel,
          installDependencies: data.installDependencies,
          maxDuration: data.maxDuration,
          keepAlive: data.keepAlive,
          enableBrowser: data.enableBrowser,
        }
      })

      // Navigate to the first task
      navigate(`/tasks/${taskIds[0]}`)

      try {
        // Create all tasks in parallel
        const responses = await Promise.all(
          tasksData.map((taskData) =>
            fetch('/api/tasks', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(taskData),
            }),
          ),
        )

        const successCount = responses.filter((r) => r.ok).length
        const failCount = responses.length - successCount

        if (successCount === responses.length) {
          toast.success(`${successCount} tasks created successfully!`)
        } else if (successCount > 0) {
          toast.warning(`${successCount} tasks created, ${failCount} failed`)
        } else {
          toast.error('Failed to create tasks')
        }

        // Clear selected repos after creating tasks
        setSelectedRepos([])

        // Refresh sidebar to get the real task data from server
        await refreshTasks()
      } catch (error) {
        console.error('Error creating tasks:', error)
        toast.error('Failed to create tasks')
        await refreshTasks()
      } finally {
        setIsSubmitting(false)
      }
      return
    }

    // Check if this is multi-agent mode with multiple models selected
    const isMultiAgent = data.selectedAgent === 'multi-agent' && data.selectedModels && data.selectedModels.length > 0

    if (isMultiAgent) {
      // Create multiple tasks, one for each selected model
      const taskIds: string[] = []
      const tasksData = data.selectedModels!.map((modelValue) => {
        // Parse agent:model format
        const [agent, model] = modelValue.split(':')
        const { id } = addTaskOptimistically({
          prompt: data.prompt,
          repoUrl: data.repoUrl,
          selectedAgent: agent,
          selectedModel: model,
          installDependencies: data.installDependencies,
          maxDuration: data.maxDuration,
        })
        taskIds.push(id)
        return {
          id,
          prompt: data.prompt,
          repoUrl: data.repoUrl,
          selectedAgent: agent,
          selectedModel: model,
          installDependencies: data.installDependencies,
          maxDuration: data.maxDuration,
          keepAlive: data.keepAlive,
          enableBrowser: data.enableBrowser,
        }
      })

      // Navigate to the first task
      navigate(`/tasks/${taskIds[0]}`)

      try {
        // Create all tasks in parallel
        const responses = await Promise.all(
          tasksData.map((taskData) =>
            fetch('/api/tasks', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(taskData),
            }),
          ),
        )

        const successCount = responses.filter((r) => r.ok).length
        const failCount = responses.length - successCount

        if (successCount === responses.length) {
          toast.success(`${successCount} tasks created successfully!`)
          setIsSubmitting(false)
          navigate(`/tasks/${taskIds[0]}`)
        } else if (successCount > 0) {
          toast.warning(`${successCount} tasks created, ${failCount} failed`)
          setIsSubmitting(false)
        } else {
          toast.error('Failed to create tasks')
          setIsSubmitting(false)
        }

        // Refresh sidebar to get the real task data from server
        await refreshTasks()
      } catch (error) {
        console.error('Error creating tasks:', error)
        toast.error('Failed to create tasks')
        setIsSubmitting(false)
        await refreshTasks()
      }
    } else {
      // Single task creation
      const { id } = addTaskOptimistically(data)
      console.log('[TaskSubmit] single task, id:', id)

      try {
        // 原子操作：创建 task + 初始化 ACP session，全部成功才跳转
        const [taskRes, initRes] = await Promise.all([
          fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...data, id }),
          }),
          fetch('/api/agent/acp', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: 1 } }),
          }),
        ])
        console.log('[TaskSubmit] task+init done, taskRes.ok:', taskRes.ok, 'initRes.ok:', initRes.ok)

        if (!taskRes.ok) {
          const err = await taskRes.json()
          toast.error(err.message || err.error || 'Failed to create task')
          setIsSubmitting(false)
          await refreshTasks()
          return
        }

        if (!initRes.ok) {
          toast.error('Failed to initialize agent session')
          setIsSubmitting(false)
          await refreshTasks()
          return
        }

        // ACP session/new
        const sessionRes = await fetch('/api/agent/acp', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'session/new', id: 2, params: { conversationId: id } }),
        })

        if (!sessionRes.ok) {
          toast.error('Failed to create agent session')
          setIsSubmitting(false)
          await refreshTasks()
          return
        }

        // 全部成功，重置状态后再跳转
        console.log('[TaskSubmit] all success, navigating to /tasks/' + id)
        setIsSubmitting(false)
        navigate(`/tasks/${id}?prompt=${encodeURIComponent(data.prompt)}`)
        await refreshTasks()
      } catch (error) {
        console.error('Error creating task:', error)
        toast.error('Failed to create task')
        setIsSubmitting(false)
        await refreshTasks()
      }
    }
  }

  const handleGitHubSignIn = () => {
    setLoadingGitHub(true)
    window.location.href = '/api/auth/signin/github'
  }

  return (
    <div className="flex-1 bg-background flex flex-col">
      <div className="p-3">
        <SharedHeader leftActions={headerLeftActions} />
      </div>

      <div className="flex-1 flex items-center justify-center px-4 pb-20 md:pb-4">
        <TaskForm
          onSubmit={handleTaskSubmit}
          isSubmitting={isSubmitting}
          selectedOwner={selectedOwner}
          selectedRepo={selectedRepo}
          initialInstallDependencies={initialInstallDependencies}
          initialMaxDuration={initialMaxDuration}
          initialKeepAlive={initialKeepAlive}
          initialEnableBrowser={initialEnableBrowser}
          maxSandboxDuration={maxSandboxDuration}
        />
      </div>

      {/* Mobile Footer with Stars and Deploy Button - Show when logged in OR when owner/repo are selected */}
      {(user || selectedOwner || selectedRepo) && <HomePageMobileFooter />}

      {/* Dialogs */}
      <OpenRepoUrlDialog open={showOpenRepoDialog} onOpenChange={setShowOpenRepoDialog} onSubmit={handleOpenRepoUrl} />
      <MultiRepoDialog open={showMultiRepoDialog} onOpenChange={setShowMultiRepoDialog} />

      {/* Sign In Dialog */}
      <Dialog open={showSignInDialog} onOpenChange={setShowSignInDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in to continue</DialogTitle>
            <DialogDescription>You need to sign in to create tasks.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-4">
            {/* GitHub sign-in (disabled)
            {hasGitHub && (
              <Button
                onClick={handleGitHubSignIn}
                disabled={loadingGitHub}
                variant="outline"
                size="lg"
                className="w-full"
              >
                {loadingGitHub ? (
                  <>
                    <svg
                      className="animate-spin -ml-1 mr-2 h-4 w-4"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Loading...
                  </>
                ) : (
                  <>
                    <GitHubIcon className="h-4 w-4 mr-2" />
                    Sign in with GitHub
                  </>
                )}
              </Button>
            )}
            */}
            <LocalSignInForm onSuccess={() => setShowSignInDialog(false)} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
