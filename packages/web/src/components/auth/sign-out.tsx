import type { Session } from '@/lib/session/types'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { useNavigate, Link } from 'react-router'
import { useSetAtom, useAtomValue } from 'jotai'
import { sessionAtom } from '@/lib/atoms/session'
import { githubConnectionAtom } from '@/lib/atoms/github'
import { GitHubIcon } from '@/components/icons/github-icon'
import { ApiKeysDialog } from '@/components/api-keys-dialog'
import { SandboxesDialog } from '@/components/sandboxes-dialog'
import { ThemeToggle } from '@/components/theme-toggle'
import { Key, Server, Settings } from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'
import { getEnabledAuthProviders } from '@/lib/auth/providers'

interface RateLimitInfo {
  used: number
  total: number
  remaining: number
}

export function SignOut({ user, authProvider }: Pick<Session, 'user' | 'authProvider'>) {
  const navigate = useNavigate()
  const setSession = useSetAtom(sessionAtom)
  const githubConnection = useAtomValue(githubConnectionAtom)
  const setGitHubConnection = useSetAtom(githubConnectionAtom)
  const [showApiKeysDialog, setShowApiKeysDialog] = useState(false)
  const [showSandboxesDialog, setShowSandboxesDialog] = useState(false)
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null)

  const { github: hasGitHub } = getEnabledAuthProviders()

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/signout', { method: 'POST', credentials: 'include' })
    } catch {}
    toast.success('You have been logged out.')
    setSession({ user: undefined })
    navigate('/', { replace: true })
  }

  const handleGitHubDisconnect = async () => {
    try {
      const response = await fetch('/api/auth/github/disconnect', { method: 'POST', credentials: 'include' })
      if (response.ok) {
        setGitHubConnection({ connected: false })
        toast.success('GitHub disconnected')
      } else {
        toast.error('Failed to disconnect GitHub')
      }
    } catch {
      toast.error('Failed to disconnect GitHub')
    }
  }

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const response = await fetch('/api/auth/rate-limit', { credentials: 'include' })
        if (response.ok && mounted) {
          const data = await response.json()
          setRateLimit({ used: data.used, total: data.total, remaining: data.remaining })
        }
      } catch {}
    })()
    return () => {
      mounted = false
    }
  }, [])

  const fetchRateLimit = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/rate-limit', { credentials: 'include' })
      if (response.ok) {
        const data = await response.json()
        setRateLimit({ used: data.used, total: data.total, remaining: data.remaining })
      }
    } catch {}
  }, [])

  return (
    <DropdownMenu onOpenChange={(open) => open && fetchRateLimit()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary rounded-full"
        >
          <Avatar className="h-8 w-8">
            <AvatarImage src={user?.avatar ? `${user.avatar}&s=72` : undefined} alt={user.username} />
            <AvatarFallback>{user.username.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-2">
          <div className="text-sm font-medium">
            <span>{user.name ?? user.username}</span>
          </div>
          {user.email && <div className="text-sm text-muted-foreground">{user.email}</div>}
          {rateLimit && (
            <div className="text-xs text-muted-foreground mt-1">
              {rateLimit.remaining}/{rateLimit.total} messages remaining today
            </div>
          )}
        </div>

        <DropdownMenuSeparator />

        <ThemeToggle />

        {/* Admin link */}
        {user.role === 'admin' && (
          <DropdownMenuItem asChild className="cursor-pointer">
            <Link to="/admin">
              <Settings className="h-4 w-4 mr-2" />
              管理后台
            </Link>
          </DropdownMenuItem>
        )}

        {/* <DropdownMenuItem onClick={() => setShowApiKeysDialog(true)} className="cursor-pointer">
          <Key className="h-4 w-4 mr-2" />
          API Keys
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => setShowSandboxesDialog(true)} className="cursor-pointer">
          <Server className="h-4 w-4 mr-2" />
          Sandboxes
        </DropdownMenuItem> */}

        {false && hasGitHub && (
          <>
            {githubConnection.connected ? (
              <DropdownMenuItem onClick={handleGitHubDisconnect} className="cursor-pointer">
                <GitHubIcon className="h-4 w-4 mr-2" />
                Disconnect
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={() => (window.location.href = '/api/auth/github/signin')}
                className="cursor-pointer"
              >
                <GitHubIcon className="h-4 w-4 mr-2" />
                Connect
              </DropdownMenuItem>
            )}
          </>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
          登出
        </DropdownMenuItem>
      </DropdownMenuContent>

      <ApiKeysDialog open={showApiKeysDialog} onOpenChange={setShowApiKeysDialog} />
      <SandboxesDialog open={showSandboxesDialog} onOpenChange={setShowSandboxesDialog} />
    </DropdownMenu>
  )
}
