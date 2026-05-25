import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { GitHubIcon } from '@/components/icons/github-icon'
import { useState } from 'react'
import { getEnabledAuthProviders, getGitHubAuthMode } from '@/lib/auth/providers'

type LocalMode = 'login' | 'register'

export function SignIn() {
  const [showDialog, setShowDialog] = useState(false)
  const [loadingGitHub, setLoadingGitHub] = useState(false)

  // Local auth state
  const [localMode, setLocalMode] = useState<LocalMode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState('')
  const [loadingLocal, setLoadingLocal] = useState(false)

  const { github: hasGitHub, local: hasLocal } = getEnabledAuthProviders()

  const handleGitHubSignIn = () => {
    if (getGitHubAuthMode() === 'cloudbase') {
      // CloudBase mode requires the full LoginPage with SDK handler
      window.location.href = '/login'
    } else {
      setLoadingGitHub(true)
      window.location.href = '/api/auth/github/login'
    }
  }

  const handleLocalSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLocalError('')
    setLoadingLocal(true)
    try {
      const endpoint = localMode === 'login' ? '/api/auth/login' : '/api/auth/register'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setLocalError(data.error || '发生错误')
      } else {
        window.location.reload()
      }
    } catch {
      setLocalError('网络错误，请重试')
    } finally {
      setLoadingLocal(false)
    }
  }

  const Spinner = () => (
    <svg className="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )

  return (
    <>
      <Button onClick={() => setShowDialog(true)} variant="outline" size="sm">
        登录
      </Button>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>登录</DialogTitle>
            <DialogDescription>
              {hasGitHub && hasLocal
                ? '使用 GitHub 或本地账户登录。'
                : hasGitHub
                  ? '使用 GitHub 登录以继续。'
                  : '使用本地账户登录以继续。'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-4">
            {hasGitHub && (
              <Button
                onClick={handleGitHubSignIn}
                disabled={loadingGitHub || loadingLocal}
                variant="outline"
                size="lg"
                className="w-full"
              >
                {loadingGitHub ? (
                  <>
                    <Spinner />
                    正在加载...
                  </>
                ) : (
                  <>
                    <GitHubIcon className="h-4 w-4 mr-2" />
                    使用 GitHub 登录
                  </>
                )}
              </Button>
            )}

            {hasGitHub && hasLocal && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">或</span>
                </div>
              </div>
            )}

            {/* Local account */}
            {hasLocal && (
              <form onSubmit={handleLocalSubmit} className="flex flex-col gap-3">
                <div className="flex gap-2 text-sm">
                  <button
                    type="button"
                    className={`font-medium ${localMode === 'login' ? 'text-foreground underline' : 'text-muted-foreground'}`}
                    onClick={() => {
                      setLocalMode('login')
                      setLocalError('')
                    }}
                  >
                    登录
                  </button>
                  <span className="text-muted-foreground">/</span>
                  <button
                    type="button"
                    className={`font-medium ${localMode === 'register' ? 'text-foreground underline' : 'text-muted-foreground'}`}
                    onClick={() => {
                      setLocalMode('register')
                      setLocalError('')
                    }}
                  >
                    注册
                  </button>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="username">用户名</Label>
                  <Input
                    id="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="输入用户名"
                    autoComplete="username"
                    required
                    minLength={3}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">密码</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="输入密码"
                    autoComplete={localMode === 'login' ? 'current-password' : 'new-password'}
                    required
                    minLength={6}
                  />
                </div>

                {localError && <p className="text-sm text-destructive">{localError}</p>}

                <Button type="submit" disabled={loadingLocal || loadingGitHub} size="lg" className="w-full">
                  {loadingLocal ? (
                    <>
                      <Spinner />
                      正在加载...
                    </>
                  ) : localMode === 'login' ? (
                    '登录'
                  ) : (
                    '注册'
                  )}
                </Button>
              </form>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
