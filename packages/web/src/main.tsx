import { StrictMode, useEffect, useState, useCallback, Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { Provider as JotaiProvider, useAtom, useAtomValue } from 'jotai'
import { AppLayout } from './components/app-layout'
import { HomePage } from './pages/HomePage'
import { TaskPage } from './pages/TaskPage'
import { TasksListPage } from './pages/TasksListPage'
import { LoginPage } from './pages/LoginPage'
import { MiniProgramPage } from './pages/miniprogram-page'
import { CronTaskPage } from './pages/crontask-page'
import { ToolRenderersPreviewPage } from './pages/tool-renderers-preview'
import { RequireAdmin } from './components/require-admin'
import { AdminLayout } from './components/admin/admin-layout'
import { AdminUsersPage } from './pages/admin/users-page'
import { AdminEnvironmentsPage } from './pages/admin/environments-page'
import { AdminTasksPage } from './pages/admin/tasks-page'
import { AdminLogsPage } from './pages/admin/logs-page'
import { AdminEnvDashboardPage } from './pages/admin/env-dashboard-page'
import { AdminTaskDetailPage } from './pages/admin/task-detail-page'
import { AdminSettingsPage } from './pages/admin/settings-page'
import { AdminEnvPoolPage } from './pages/admin/env-pool-page'
import { sessionAtom, sessionLoadedAtom } from './lib/atoms/session'
import { api } from './lib/api'
import { Loader2, AlertTriangle, RefreshCw, LogOut } from 'lucide-react'
import { ThemeProvider } from './components/theme-provider'
import { setAuthConfig } from './lib/auth/providers'
import type { AuthConfig } from './lib/auth/providers'
import './index.css'

// Error boundary to catch runtime errors
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen items-center justify-center bg-background p-8">
          <div className="text-center max-w-lg">
            <h1 className="text-xl font-bold text-red-600 mb-4">Runtime Error</h1>
            <pre className="text-sm text-left bg-red-50 p-4 rounded overflow-auto max-h-64">
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Auth provider that checks session on startup
function AuthProvider({ children }: { children: React.ReactNode }) {
  const [, setSession] = useAtom(sessionAtom)
  const [, setLoaded] = useAtom(sessionLoadedAtom)

  useEffect(() => {
    // Fetch auth config in parallel with session check
    fetch('/api/auth/auth-config', { credentials: 'include' })
      .then((res) => res.json())
      .then((config: AuthConfig) => setAuthConfig(config))
      .catch(() => {
        /* use defaults */
      })
  }, [])

  useEffect(() => {
    console.log('[AuthProvider] Checking session...')
    api
      .get<{
        user: { id: string; username: string; name?: string; email?: string; avatar?: string; role: 'user' | 'admin' }
        envId?: string
        provisionStatus?: string
      }>('/api/auth/me')
      .then((data) => {
        console.log('[AuthProvider] Session data:', data)
        setSession({
          user: data.user,
          envId: data.envId,
          provisionStatus: (data.provisionStatus as any) || 'not_started',
        })
        setLoaded(true)
      })
      .catch((err) => {
        console.log('[AuthProvider] No session:', err)
        setSession({ user: undefined })
        setLoaded(true)
      })
  }, [setSession, setLoaded])

  const loaded = useAtomValue(sessionLoadedAtom)
  console.log('[AuthProvider] loaded:', loaded)

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return <>{children}</>
}

// Login route that redirects if already authenticated
function LoginRoute() {
  const session = useAtomValue(sessionAtom)
  const loaded = useAtomValue(sessionLoadedAtom)
  const navigate = useNavigate()

  useEffect(() => {
    if (loaded && session.user) {
      navigate('/', { replace: true })
    }
  }, [loaded, session, navigate])

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (session.user) {
    return null
  }

  return <LoginPage />
}

// Protect routes that require authentication
function RequireAuth({ children }: { children: React.ReactNode }) {
  const session = useAtomValue(sessionAtom)
  const loaded = useAtomValue(sessionLoadedAtom)
  const navigate = useNavigate()

  useEffect(() => {
    if (loaded && !session.user) {
      navigate('/login', { replace: true })
    }
  }, [loaded, session, navigate])

  if (!loaded || !session.user) return null
  return <>{children}</>
}

// Block routes when environment provisioning is not ready
function ProvisionGuard({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useAtom(sessionAtom)
  const [retrying, setRetrying] = useState(false)
  const navigate = useNavigate()

  const status = session.provisionStatus

  const handleLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/signout', { method: 'POST', credentials: 'include' })
    } catch {}
    setSession({ user: undefined })
    navigate('/login', { replace: true })
  }, [setSession, navigate])

  // Poll provision status when processing
  useEffect(() => {
    if (status !== 'processing') return
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/auth/provision-status', { credentials: 'include' })
        const data = await res.json()
        if (data.status === 'success') {
          setSession((prev) => ({ ...prev, envId: data.envId, provisionStatus: 'success' }))
        } else if (data.status === 'failed') {
          setSession((prev) => ({ ...prev, provisionStatus: 'failed' }))
        }
      } catch {
        // ignore poll errors
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [status, setSession])

  const handleRetry = useCallback(async () => {
    setRetrying(true)
    try {
      const res = await fetch('/api/auth/provision-retry', {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok) {
        setSession((prev) => ({ ...prev, provisionStatus: 'processing' }))
      }
    } catch {
      // ignore
    } finally {
      setRetrying(false)
    }
  }, [setSession])

  // Admin users bypass the guard
  if (session.user?.role === 'admin') return <>{children}</>

  // Not started (shared mode or no TCB) or success — pass through
  if (!status || status === 'not_started' || status === 'success') {
    return <>{children}</>
  }

  // Processing — show spinner
  if (status === 'processing') {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center max-w-md space-y-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto" />
          <h2 className="text-lg font-semibold text-foreground">{'\u6B63\u5728\u521D\u59CB\u5316\u73AF\u5883...'}</h2>
          <p className="text-sm text-muted-foreground">
            {
              '\u6B63\u5728\u4E3A\u60A8\u521B\u5EFA\u4E13\u5C5E\u7684\u4E91\u5F00\u53D1\u73AF\u5883\uFF0C\u8BF7\u7A0D\u5019'
            }
          </p>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm border border-border rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            {'\u9000\u51FA\u767B\u5F55'}
          </button>
        </div>
      </div>
    )
  }

  // Failed — show error with retry
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="text-center max-w-md space-y-4">
        <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
        <h2 className="text-lg font-semibold text-foreground">{'\u73AF\u5883\u521D\u59CB\u5316\u5931\u8D25'}</h2>
        <p className="text-sm text-muted-foreground">
          {
            '\u60A8\u7684\u4E91\u5F00\u53D1\u73AF\u5883\u521B\u5EFA\u5931\u8D25\uFF0C\u8BF7\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u91CD\u8BD5\u3002\u5982\u6301\u7EED\u5931\u8D25\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u3002'
          }
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
            {retrying ? '\u91CD\u8BD5\u4E2D...' : '\u91CD\u8BD5'}
          </button>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm border border-border rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            {'\u9000\u51FA\u767B\u5F55'}
          </button>
        </div>
      </div>
    </div>
  )
}

function App() {
  console.log('[App] Rendering...')
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          {/* DEV preview (无需鉴权/环境),仅供开发期验证 P6 工具渲染器 */}
          <Route path="/__preview/tool-renderers" element={<ToolRenderersPreviewPage />} />

          {/* Admin routes */}
          <Route
            path="/admin/*"
            element={
              <RequireAdmin>
                <AdminLayout />
              </RequireAdmin>
            }
          >
            <Route index element={<Navigate to="/admin/users" replace />} />
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="environments" element={<AdminEnvironmentsPage />} />
            <Route path="tasks" element={<AdminTasksPage />} />
            <Route path="logs" element={<AdminLogsPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
            <Route path="env-pool" element={<AdminEnvPoolPage />} />
            <Route path="dashboard/:userId" element={<AdminEnvDashboardPage />} />
            <Route path="tasks/:taskId" element={<AdminTaskDetailPage />} />
          </Route>

          {/* Regular routes */}
          <Route
            path="/tasks"
            element={
              <RequireAuth>
                <ProvisionGuard>
                  <AppLayout>
                    <TasksListPage />
                  </AppLayout>
                </ProvisionGuard>
              </RequireAuth>
            }
          />
          <Route
            path="/"
            element={
              <ProvisionGuard>
                <AppLayout>
                  <HomePage />
                </AppLayout>
              </ProvisionGuard>
            }
          />
          <Route
            path="/tasks/:taskId"
            element={
              <RequireAuth>
                <ProvisionGuard>
                  <AppLayout>
                    <TaskPage />
                  </AppLayout>
                </ProvisionGuard>
              </RequireAuth>
            }
          />
          <Route
            path="/miniprogram"
            element={
              <RequireAuth>
                <ProvisionGuard>
                  <AppLayout>
                    <MiniProgramPage />
                  </AppLayout>
                </ProvisionGuard>
              </RequireAuth>
            }
          />
          <Route
            path="/crontask"
            element={
              <RequireAuth>
                <ProvisionGuard>
                  <AppLayout>
                    <CronTaskPage />
                  </AppLayout>
                </ProvisionGuard>
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </ErrorBoundary>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <JotaiProvider>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster />
      </ThemeProvider>
    </JotaiProvider>
  </StrictMode>,
)
