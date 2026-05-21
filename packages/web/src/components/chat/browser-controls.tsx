import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Loader2, RotateCw } from 'lucide-react'
import type { PreviewBridge, HmrStatus } from '@/hooks/use-preview-bridge'

/**
 * BrowserControls — 预览 iframe 的浏览器工具栏
 *
 * 通过 PreviewBridge 发送 postMessage 指令控制 iframe 导航，
 * 并通过 currentPath prop 实时同步 iframe 内部 SPA 路由。
 * 支持 hash router 模式（`/#/path`）的正确解析与同步。
 */
interface BrowserControlsProps {
  /** 预览 URL 的完整地址(提取 origin 作为显示基础) */
  previewUrl: string
  /** PreviewBridge 实例，提供 navigate / back / forward / reload 指令 */
  bridge: PreviewBridge
  /** 刷新时让父级重新调 preview-url 接口验证沙箱状态 */
  onHardRefresh?: () => void
  /** 是否正在加载（preview-url 接口进行中） */
  loading?: boolean
  /** iframe 内部当前路径（由 preview:url-changed 事件推送），自动同步到地址栏 */
  currentPath?: string
  /** HMR 连接状态 */
  hmrStatus?: HmrStatus
  className?: string
}

export function BrowserControls({
  previewUrl,
  bridge,
  onHardRefresh,
  loading,
  currentPath,
  hmrStatus = 'unknown',
  className,
}: BrowserControlsProps) {
  // 地址栏编辑内容(只存可视路径部分)
  const [urlValue, setUrlValue] = useState(() => extractDisplayPath(previewUrl))
  // 是否正在手动编辑地址栏（手动编辑时不自动同步）
  const [editing, setEditing] = useState(false)

  // previewUrl 由外部更新时(如切换任务 / 重启预览),同步到输入框
  useEffect(() => {
    if (!editing) {
      setUrlValue(extractDisplayPath(previewUrl))
    }
  }, [previewUrl, editing])

  // iframe 内部路由变化时自动同步地址栏（仅在非编辑状态下）
  useEffect(() => {
    if (currentPath && !editing) {
      setUrlValue(currentPath)
    }
  }, [currentPath, editing])

  const handleNavigate = (path: string) => {
    if (loading) return
    const normalizedPath = path.startsWith('/') || path.startsWith('#') ? path : `/${path}`
    setUrlValue(normalizedPath)
    setEditing(false)
    bridge.navigate(normalizedPath)
  }

  const handleReload = () => {
    if (loading) return
    if (onHardRefresh) {
      onHardRefresh()
      return
    }
    bridge.reload()
  }

  const handleBack = () => {
    if (loading) return
    bridge.navigateBack()
  }

  const handleForward = () => {
    if (loading) return
    bridge.navigateForward()
  }

  return (
    <div className={`flex items-center gap-1 ${className ?? ''}`}>
      <button
        type="button"
        onClick={handleBack}
        disabled={loading}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
        title="后退"
        aria-label="后退"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={handleForward}
        disabled={loading}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
        title="前进"
        aria-label="前进"
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={handleReload}
        disabled={loading}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
        title="刷新"
        aria-label="刷新"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
      </button>
      {/* HMR 连接状态指示灯 */}
      <HmrIndicator status={hmrStatus} />
      <form
        className="ml-1 flex-1 min-w-0"
        onSubmit={(e) => {
          e.preventDefault()
          handleNavigate(urlValue)
        }}
      >
        <input
          type="text"
          value={urlValue}
          onChange={(e) => setUrlValue(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          disabled={loading}
          className="h-6 w-full rounded-md bg-muted/50 px-2 text-[11px] text-foreground transition-colors outline-none focus:bg-muted focus:ring-1 focus:ring-ring disabled:opacity-50"
          aria-label="URL 路径"
          placeholder="/"
        />
      </form>
    </div>
  )
}

// ─── HMR Status Indicator ───────────────────────────────────────────────────

const HMR_STATUS_CONFIG: Record<HmrStatus, { color: string; title: string }> = {
  unknown: { color: 'bg-muted-foreground/30', title: '等待连接...' },
  connected: { color: 'bg-emerald-500', title: 'HMR 已连接' },
  disconnected: { color: 'bg-destructive', title: 'HMR 已断开' },
  reconnecting: { color: 'bg-amber-500 animate-pulse', title: 'HMR 重连中...' },
}

function HmrIndicator({ status }: { status: HmrStatus }) {
  const config = HMR_STATUS_CONFIG[status]
  return (
    <span
      className={`inline-block size-2 rounded-full flex-shrink-0 ${config.color}`}
      title={config.title}
      aria-label={config.title}
    />
  )
}

// ─── URL Helpers ────────────────────────────────────────────────────────────

/**
 * Extract display path from full URL.
 * Handles both pathname-based routing and hash routing (`/#/path`).
 */
function extractDisplayPath(url: string): string {
  try {
    const base =
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    const u = new URL(url, base)
    const proxyMatch = /^\/api\/tasks\/[^/]+\/preview\/\d+/.exec(u.pathname)
    if (proxyMatch) {
      const rest = u.pathname.slice(proxyMatch[0].length) || '/'
      return rest + u.search + u.hash
    }
    // Hash router: `/#/dashboard` → display `#/dashboard`
    if (u.hash && u.hash.startsWith('#/')) {
      return u.hash
    }
    return u.pathname + u.search + u.hash
  } catch {
    return '/'
  }
}
