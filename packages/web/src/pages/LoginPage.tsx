import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useSetAtom } from 'jotai'
import { api } from '../lib/api'
import { sessionAtom } from '../lib/atoms/session'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { GitHubIcon } from '@/components/icons/github-icon'
import { getEnabledAuthProviders, getGitHubAuthMode, getTcbEnvId } from '@/lib/auth/providers'

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const navigate = useNavigate()
  const setSession = useSetAtom(sessionAtom)

  const { github: hasGitHub, local: hasLocal } = getEnabledAuthProviders()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)
    try {
      const data = await api.post<{
        user: { id: string; username: string; name?: string; email?: string; avatar?: string; role: 'user' | 'admin' }
        envId?: string
      }>(`/api/auth/${mode}`, { username, password })
      // Update session atom so RequireAuth / protected routes see the user immediately
      setSession({ user: data.user, envId: data.envId })
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setIsLoading(false)
    }
  }

  const handleGitHubLogin = async () => {
    setError('')
    if (getGitHubAuthMode() === 'cloudbase') {
      setIsLoading(true)
      try {
        const { default: cloudbase } = await import('@cloudbase/js-sdk')
        const app = cloudbase.init({
          env: getTcbEnvId(),
          auth: { detectSessionInUrl: true },
        })
        const auth = app.auth({ persistence: 'local' })

        // Use signInWithOAuth for GitHub identity source
        // The provider ID is configured in CloudBase console
        await auth.signInWithOAuth({ provider: 'github' })

        // After redirect back, verify the OAuth result
        const loginState = await auth.getLoginState()
        if (!loginState) {
          setError('GitHub login failed')
          return
        }

        const userInfo = loginState.user
        await api.post('/api/auth/cloudbase/login', {
          uid: userInfo?.uid,
          customUserId: userInfo?.customUserId,
          nickName: userInfo?.name,
          email: userInfo?.email,
          avatarUrl: undefined,
        })

        // Refresh session
        const meData = await api.get<{
          user: {
            id: string
            username: string
            name?: string
            email?: string
            avatar?: string
            role: 'user' | 'admin'
          }
          envId?: string
        }>('/api/auth/me')
        setSession({ user: meData.user, envId: meData.envId })
        navigate('/')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'GitHub login failed')
      } finally {
        setIsLoading(false)
      }
    } else {
      // Direct OAuth: redirect to server endpoint
      window.location.href = '/api/auth/github/login'
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Coding Agent</CardTitle>
          <CardDescription>{mode === 'login' ? 'Sign in to your account' : 'Create a new account'}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasLocal && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</div>}
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  disabled={isLoading}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  disabled={isLoading}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {mode === 'login' ? 'Signing in...' : 'Creating account...'}
                  </>
                ) : mode === 'login' ? (
                  'Sign In'
                ) : (
                  'Create Account'
                )}
              </Button>
              <p className="text-sm text-center text-muted-foreground">
                {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                <button
                  type="button"
                  onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
                  className="text-primary hover:underline font-medium"
                  disabled={isLoading}
                >
                  {mode === 'login' ? 'Register' : 'Sign In'}
                </button>
              </p>
            </form>
          )}

          {hasGitHub && (
            <>
              {hasLocal && (
                <div className="relative my-4">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>
              )}
              {!hasLocal && error && (
                <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2 mb-4">{error}</div>
              )}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={isLoading}
                onClick={handleGitHubLogin}
              >
                {isLoading && !hasLocal ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <GitHubIcon className="h-4 w-4 mr-2" />
                )}
                Sign in with GitHub
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
