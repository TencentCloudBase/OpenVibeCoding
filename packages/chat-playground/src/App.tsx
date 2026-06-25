/**
 * Chat Playground 主应用
 *
 * 极简对话调试器：
 * - 左侧：session 列表（来自 ACP `session/list`）+ 顶部 "+" 按钮（调 ACP `session/new`）
 * - 右侧：选中 session 的 <AcpChat />
 *
 * 不做：登录页、环境管理、文件浏览、PR/部署 —— 这些是 web 主应用的事。
 *
 * 认证：默认与本仓库的 server 同源，复用 web 已建立的 cookie；也可在配置面板里
 * 指向第三方 ACP server，并附加 headers（如 Authorization: Bearer ...）。
 *
 * URL 参数注入（部署到静态托管时方便分享/书签）：
 *   ?endpoint=<url>           ACP JSON-RPC endpoint
 *   ?observe=<url>            observe SSE endpoint（可选）
 *   ?token=<xxx>              等价于 Authorization: Bearer <xxx>
 *   ?headers=<Key:Value%0A…>  完整 headers 文本（每行一个 `Key: Value`，需 URL 编码）
 * URL 参数出现时覆盖 localStorage，并写入 localStorage 持久化。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AcpChat, AcpClient } from '@coder/chat-core'
import type { SessionInfo } from '@coder/shared'
import {
  Plus,
  Loader2,
  AlertTriangle,
  MessageSquare,
  RefreshCw,
  Settings as SettingsIcon,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

const STORAGE_KEY = 'chat-playground:config:v1'
const DEFAULT_ACP_BASE_URL = '/api/agent/acp'

interface PlaygroundConfig {
  acpBaseUrl: string
  acpObserveBaseUrl: string
  /** 自由文本（每行一个 `Key: Value`），保存时序列化解析为对象 */
  headersText: string
}

const DEFAULT_CONFIG: PlaygroundConfig = {
  acpBaseUrl: DEFAULT_ACP_BASE_URL,
  acpObserveBaseUrl: '',
  headersText: '',
}

/**
 * 从 URL search params 读取配置。仅返回出现的字段，未出现的字段不覆盖。
 * `token` 是 `Authorization: Bearer <token>` 的快捷方式；若同时提供 `headers`，
 * `headers` 中的 Authorization 会覆盖 `token`。
 */
function readConfigFromUrl(): Partial<PlaygroundConfig> {
  const params = new URLSearchParams(window.location.search)
  const out: Partial<PlaygroundConfig> = {}
  const endpoint = params.get('endpoint') || params.get('acp')
  if (endpoint) out.acpBaseUrl = endpoint
  const observe = params.get('observe')
  if (observe) out.acpObserveBaseUrl = observe
  const token = params.get('token')
  const headersText = params.get('headers')
  if (token || headersText) {
    const lines: string[] = []
    if (token) lines.push(`Authorization: Bearer ${token}`)
    if (headersText) lines.push(...headersText.split('\n'))
    out.headersText = lines.join('\n')
  }
  return out
}

function loadConfig(): PlaygroundConfig {
  let base = DEFAULT_CONFIG
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) base = { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<PlaygroundConfig>) }
  } catch {
    // ignore broken localStorage
  }
  const fromUrl = readConfigFromUrl()
  const hasUrlOverride = Object.keys(fromUrl).length > 0
  const merged = { ...base, ...fromUrl }
  if (hasUrlOverride) {
    // 持久化 URL 注入的配置，后续无参数访问也保留
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    } catch {
      // ignore
    }
    // 清理 URL 参数，避免分享/刷新时泄露 token
    const cleanUrl = window.location.pathname + window.location.hash
    window.history.replaceState(null, '', cleanUrl)
  }
  return merged
}

function saveConfig(config: PlaygroundConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

function parseHeaders(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key) result[key] = value
  }
  return result
}

export default function App() {
  const [config, setConfig] = useState<PlaygroundConfig>(() => loadConfig())
  const [showSettings, setShowSettings] = useState(false)

  const acpBaseUrl = config.acpBaseUrl || DEFAULT_ACP_BASE_URL
  const acpObserveBaseUrl = config.acpObserveBaseUrl || undefined
  const parsedHeaders = useMemo(() => parseHeaders(config.headersText), [config.headersText])
  const getHeaders = useCallback(() => parsedHeaders, [parsedHeaders])

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const refreshSessions = useCallback(async () => {
    setLoadingList(true)
    setListError(null)
    try {
      const result = await AcpClient.listSessions(acpBaseUrl, {}, parsedHeaders)
      setSessions(result.sessions)
    } catch (err) {
      setListError((err as Error).message)
    } finally {
      setLoadingList(false)
    }
  }, [acpBaseUrl, parsedHeaders])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  // 默认打开列表第一个会话
  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[0].sessionId)
    }
  }, [sessions, activeSessionId])

  const handleCreate = useCallback(async () => {
    setCreating(true)
    try {
      const result = await AcpClient.createSession(
        acpBaseUrl,
        {
          meta: { title: '新会话 ' + new Date().toLocaleString() },
        },
        parsedHeaders,
      )
      await refreshSessions()
      setActiveSessionId(result.sessionId)
      toast.success('会话已创建')
    } catch (err) {
      toast.error('创建失败: ' + (err as Error).message)
    } finally {
      setCreating(false)
    }
  }, [acpBaseUrl, parsedHeaders, refreshSessions])

  const applyConfig = useCallback((next: PlaygroundConfig) => {
    setConfig(next)
    saveConfig(next)
    setActiveSessionId(null) // endpoint 切了之后旧 session 不一定属于新 server
  }, [])

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (!confirm('确定删除这个会话？此操作不可撤销。')) return
      try {
        await AcpClient.deleteSession(acpBaseUrl, { sessionId }, parsedHeaders)
        if (activeSessionId === sessionId) setActiveSessionId(null)
        await refreshSessions()
        toast.success('会话已删除')
      } catch (err) {
        toast.error('删除失败: ' + (err as Error).message)
      }
    },
    [acpBaseUrl, activeSessionId, parsedHeaders, refreshSessions],
  )

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground dark">
      {/* 左侧 session 列表 */}
      <aside className="w-72 shrink-0 border-r border-border flex flex-col">
        <header className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h1 className="text-sm font-semibold">Chat Playground</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSettings(true)}
              className="p-1.5 rounded hover:bg-muted"
              title="配置 ACP endpoint / headers"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={refreshSessions}
              disabled={loadingList}
              className="p-1.5 rounded hover:bg-muted disabled:opacity-50"
              title="刷新列表"
            >
              <RefreshCw className={'h-3.5 w-3.5 ' + (loadingList ? 'animate-spin' : '')} />
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="p-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              title="新建会话"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loadingList && sessions.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-xs">
              <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
              加载中...
            </div>
          ) : listError ? (
            <div className="p-4 text-xs">
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">无法加载会话</div>
                  <div className="text-muted-foreground mt-1 break-words">{listError}</div>
                  <div className="text-muted-foreground mt-2">
                    提示：默认 endpoint 复用 web 的登录 cookie，请先到{' '}
                    <a
                      href="http://localhost:5174"
                      target="_blank"
                      rel="noreferrer"
                      className="underline text-foreground"
                    >
                      web (5174)
                    </a>{' '}
                    登录；或点齿轮配置第三方 ACP server。
                  </div>
                </div>
              </div>
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-xs">暂无会话。点右上角 + 创建。</div>
          ) : (
            <ul className="py-1">
              {sessions.map((s) => (
                <SessionItem
                  key={s.sessionId}
                  session={s}
                  active={s.sessionId === activeSessionId}
                  onSelect={() => setActiveSessionId(s.sessionId)}
                  onDelete={() => handleDelete(s.sessionId)}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground space-y-0.5">
          <div className="truncate" title={acpBaseUrl}>
            ACP: {acpBaseUrl}
          </div>
          {Object.keys(parsedHeaders).length > 0 && (
            <div className="truncate text-muted-foreground/70">headers: {Object.keys(parsedHeaders).join(', ')}</div>
          )}
        </footer>
      </aside>

      {/* 右侧对话区 */}
      <main className="flex-1 min-w-0 flex flex-col">
        {activeSessionId ? (
          <SessionChat
            key={activeSessionId + ':' + acpBaseUrl}
            sessionId={activeSessionId}
            acpBaseUrl={acpBaseUrl}
            acpObserveBaseUrl={acpObserveBaseUrl}
            getHeaders={getHeaders}
            onTaskUpdated={refreshSessions}
          />
        ) : (
          <EmptyState />
        )}
      </main>

      {showSettings && <SettingsDialog initial={config} onClose={() => setShowSettings(false)} onSave={applyConfig} />}
    </div>
  )
}

// ─── 配置弹层 ────────────────────────────────────────────────────

function SettingsDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: PlaygroundConfig
  onClose: () => void
  onSave: (config: PlaygroundConfig) => void
}) {
  const [draft, setDraft] = useState<PlaygroundConfig>(initial)

  const handleSubmit = () => {
    onSave({
      acpBaseUrl: draft.acpBaseUrl.trim() || DEFAULT_ACP_BASE_URL,
      acpObserveBaseUrl: draft.acpObserveBaseUrl.trim(),
      headersText: draft.headersText,
    })
    onClose()
  }

  const handleReset = () => {
    setDraft(DEFAULT_CONFIG)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[480px] max-w-[92vw] rounded-lg bg-card border border-border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">ACP 配置</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="p-4 space-y-4 text-xs">
          <div>
            <label className="block font-medium mb-1.5">ACP endpoint (POST)</label>
            <input
              type="text"
              value={draft.acpBaseUrl}
              onChange={(e) => setDraft({ ...draft, acpBaseUrl: e.target.value })}
              placeholder={DEFAULT_ACP_BASE_URL}
              className="w-full px-2.5 py-1.5 rounded border border-border bg-background"
              spellCheck={false}
            />
            <div className="text-[10px] text-muted-foreground mt-1">
              JSON-RPC endpoint。为空时使用默认 {DEFAULT_ACP_BASE_URL}（同源 web）。
            </div>
          </div>

          <div>
            <label className="block font-medium mb-1.5">Observe endpoint (GET, 可选)</label>
            <input
              type="text"
              value={draft.acpObserveBaseUrl}
              onChange={(e) => setDraft({ ...draft, acpObserveBaseUrl: e.target.value })}
              placeholder="留空则自动从上面 endpoint 推导（替换尾部 /acp → /observe）"
              className="w-full px-2.5 py-1.5 rounded border border-border bg-background"
              spellCheck={false}
            />
          </div>

          <div>
            <label className="block font-medium mb-1.5">Headers</label>
            <textarea
              value={draft.headersText}
              onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
              placeholder={'Authorization: Bearer xxxxx'}
              className="w-full h-24 px-2.5 py-1.5 rounded border border-border bg-background font-mono text-[11px] resize-none"
              spellCheck={false}
            />
            <div className="text-[10px] text-muted-foreground mt-1">
              每行一个 `Key: Value`。会被附加到所有 ACP 请求（用于第三方 server 的 token 鉴权）。
            </div>
          </div>
        </div>

        <footer className="px-4 py-3 border-t border-border flex items-center justify-between">
          <button onClick={handleReset} className="text-xs text-muted-foreground hover:text-foreground">
            恢复默认
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded text-xs border border-border hover:bg-muted">
              取消
            </button>
            <button
              onClick={handleSubmit}
              className="px-3 py-1.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90"
            >
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

// ─── 列表项 ──────────────────────────────────────────────────────

function SessionItem({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: SessionInfo
  active: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const time = session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  const status = session._meta?.status as string | undefined

  return (
    <li className="group relative">
      <button
        onClick={onSelect}
        className={
          'w-full text-left px-3 py-2.5 pr-8 hover:bg-muted/50 transition-colors border-l-2 ' +
          (active ? 'bg-muted border-primary' : 'border-transparent')
        }
      >
        <div className="flex items-center gap-2 mb-0.5">
          <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" />
          <div className="text-sm truncate flex-1">{session.title || '(无标题)'}</div>
          {status && <StatusBadge status={status} />}
        </div>
        <div className="text-[10px] text-muted-foreground pl-5 truncate">
          {time}
          <span className="mx-1.5">·</span>
          <code className="text-[9px]">{session.sessionId.slice(0, 8)}</code>
        </div>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-opacity"
        title="删除会话"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </li>
  )
}

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, string> = {
    created: 'bg-muted text-muted-foreground',
    pending: 'bg-amber-500/20 text-amber-400',
    processing: 'bg-blue-500/20 text-blue-400',
    streaming: 'bg-blue-500/20 text-blue-400',
    completed: 'bg-emerald-500/20 text-emerald-400',
    stopped: 'bg-muted text-muted-foreground',
    error: 'bg-destructive/20 text-destructive',
  }
  const cls = palette[status] || 'bg-muted text-muted-foreground'
  return <span className={'text-[9px] px-1.5 py-0.5 rounded ' + cls}>{status}</span>
}

// ─── 空态 ────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="text-center max-w-sm space-y-2">
        <MessageSquare className="h-10 w-10 mx-auto opacity-30" />
        <p className="text-sm">选择左侧会话，或点击 + 创建新会话</p>
      </div>
    </div>
  )
}

// ─── 单个会话的对话视图 ──────────────────────────────────────────

function SessionChat({
  sessionId,
  acpBaseUrl,
  acpObserveBaseUrl,
  getHeaders,
  onTaskUpdated,
}: {
  sessionId: string
  acpBaseUrl: string
  acpObserveBaseUrl?: string
  getHeaders: () => Record<string, string>
  onTaskUpdated: () => void
}) {
  return (
    <AcpChat
      sessionId={sessionId}
      acpBaseUrl={acpBaseUrl}
      acpObserveBaseUrl={acpObserveBaseUrl}
      getAcpHeaders={getHeaders}
      sendTaskIdHeader={false}
      onStreamComplete={onTaskUpdated}
    />
  )
}
