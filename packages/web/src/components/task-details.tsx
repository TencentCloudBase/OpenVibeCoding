import type { Task, McpServerConfig } from '@coder/shared'
import type { Connector } from '@/lib/session/types'
import { CloudDashboard } from '@coder/dashboard/CloudDashboard'
import { StorageAPI } from '@coder/dashboard/storage'
import type { Theme } from '@coder/dashboard/CloudDashboard'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  GitBranch,
  CheckCircle,
  AlertCircle,
  Loader2,
  Server,
  Cable,
  Square,
  GitPullRequest,
  RotateCcw,
  Trash2,
  ChevronDown,
  ChevronLeft,
  XCircle,
  Code,
  MessageSquare,
  FileText,
  Monitor,
  Eye,
  EyeOff,
  RefreshCw,
  Play,
  StopCircle,
  MoreVertical,
  X,
  ExternalLink,
  Plus,
  Maximize,
  Minimize,
  AlertTriangle,
  Cloud,
  Pencil,
  Zap,
  Download,
  FolderUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useTheme } from 'next-themes'
import { useAtomValue, useSetAtom } from 'jotai'
import { sessionAtom } from '@/lib/atoms/session'
import { setEditingConnectorActionAtom } from '@/lib/atoms/connector-dialog'
import { toast } from 'sonner'
import { Claude, CodeBuddy, Codex, Copilot, Cursor, Gemini, OpenCode } from '@/components/logos'
import { useTasks } from '@/components/app-layout'
import {
  getShowFilesPane,
  setShowFilesPane as saveShowFilesPane,
  getShowCodePane,
  setShowCodePane as saveShowCodePane,
  getShowPreviewPane,
  setShowPreviewPane as saveShowPreviewPane,
  getShowChatPane,
  setShowChatPane as saveShowChatPane,
  getFilesPaneWidth,
  setFilesPaneWidth as saveFilesPaneWidth,
  getChatPaneWidth,
  setChatPaneWidth as saveChatPaneWidth,
} from '@/lib/utils/cookies'
import { FileBrowser } from '@/components/file-browser'
import { FileDiffViewer } from '@/components/file-diff-viewer'
import { CreatePRDialog } from '@/components/create-pr-dialog'
import { MergePRDialog } from '@/components/merge-pr-dialog'
import { TaskChat, useChatStream } from '@coder/chat-core'
import { ConnectorDialog } from '@/components/connectors/manage-connectors'
import { BrowserControls } from '@/components/preview/browser-controls'
import { PreviewPlaceholder } from '@/components/preview/preview-placeholder'
import { useAutoFix } from '@/hooks/use-auto-fix'
import { usePreviewBridge } from '@/hooks/use-preview-bridge'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useNavigate } from 'react-router'
import { Link } from 'react-router'
import BrowserbaseIcon from '@/components/icons/browserbase-icon'
import Context7Icon from '@/components/icons/context7-icon'
import ConvexIcon from '@/components/icons/convex-icon'
import FigmaIcon from '@/components/icons/figma-icon'
import HuggingFaceIcon from '@/components/icons/huggingface-icon'
import LinearIcon from '@/components/icons/linear-icon'
import NotionIcon from '@/components/icons/notion-icon'
import PlaywrightIcon from '@/components/icons/playwright-icon'
import SupabaseIcon from '@/components/icons/supabase-icon'
import VercelIcon from '@/components/icons/vercel-icon'
import { PRStatusIcon } from '@/components/pr-status-icon'

interface TaskDetailsProps {
  task: Task
  maxSandboxDuration?: number
  onStreamComplete?: () => void
  initialPrompt?: string
  initialImages?: Array<{ data: string; mimeType: string }>
  onInitialPromptConsumed?: () => void
}

interface DiffData {
  filename: string
  oldContent: string
  newContent: string
  language: string
}

const CODING_AGENTS = [
  { value: 'codebuddy', label: 'CodeBuddy', icon: CodeBuddy, runtime: 'codebuddy' },
  { value: 'opencode', label: 'OpenCode', icon: OpenCode, runtime: 'opencode-acp' },
] as const

const AGENT_MODELS = {
  claude: [
    { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    { value: 'anthropic/claude-opus-4.6', label: 'Opus 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  codex: [
    { value: 'openai/gpt-5.1', label: 'GPT-5.1' },
    { value: 'openai/gpt-5.1-codex', label: 'GPT-5.1-Codex' },
    { value: 'openai/gpt-5.1-codex-mini', label: 'GPT-5.1-Codex mini' },
    { value: 'openai/gpt-5', label: 'GPT-5' },
    { value: 'gpt-5-codex', label: 'GPT-5-Codex' },
    { value: 'openai/gpt-5-mini', label: 'GPT-5 mini' },
    { value: 'openai/gpt-5-nano', label: 'GPT-5 nano' },
    { value: 'gpt-5-pro', label: 'GPT-5 pro' },
    { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
  ],
  copilot: [
    { value: 'claude-sonnet-4.5', label: 'Sonnet 4.5' },
    { value: 'claude-sonnet-4', label: 'Sonnet 4' },
    { value: 'claude-haiku-4.5', label: 'Haiku 4.5' },
    { value: 'gpt-5', label: 'GPT-5' },
  ],
  cursor: [
    { value: 'auto', label: 'Auto' },
    { value: 'composer-1', label: 'Composer' },
    { value: 'sonnet-4.5', label: 'Sonnet 4.5' },
    { value: 'sonnet-4.5-thinking', label: 'Sonnet 4.5 Thinking' },
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { value: 'opus-4.1', label: 'Opus 4.1' },
    { value: 'grok', label: 'Grok' },
  ],
  gemini: [
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  opencode: [
    { value: 'gpt-5', label: 'GPT-5' },
    { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
    { value: 'gpt-4.1', label: 'GPT-4.1' },
    { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    { value: 'claude-opus-4-5', label: 'Opus 4.5' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
} as const

const DEFAULT_MODELS = {
  claude: 'claude-sonnet-4-5',
  codex: 'openai/gpt-5.1',
  copilot: 'claude-sonnet-4.5',
  cursor: 'auto',
  gemini: 'gemini-3-pro-preview',
  opencode: 'gpt-5',
} as const

export function TaskDetails({
  task,
  maxSandboxDuration = 300,
  onStreamComplete,
  initialPrompt,
  initialImages,
  onInitialPromptConsumed,
}: TaskDetailsProps) {
  // ── Theme & session (for CloudDashboard) ──
  const { resolvedTheme } = useTheme()
  const dashboardTheme: Theme = resolvedTheme === 'light' ? 'light' : 'dark'
  const session = useAtomValue(sessionAtom)
  // 优先用 task 自己的 envId（task provision 模式下每个 task 有独立 env）
  // 否则 fallback 到 user-level（shared / isolated 模式）
  const sessionEnvId = task.envId || session?.envId || ''
  const userId = session?.user?.id || ''

  // ── Chat stream — hoisted here so it survives TaskChat remounts ──
  // onStreamComplete 经包装：原回调先跑，然后异步探测 /__dev_errors，
  // 如有错误且 auto-fix 余量够，自动发 prompt 修复。
  // 因为 autoFix 依赖 chatStream 本身，用 ref 打破循环。
  const autoFixRef = useRef<{
    scheduleAutoFix: (err: { source: string; summary: string; detail?: string }) => void
  } | null>(null)

  const isCodingModeForAutoFix = task.mode === 'coding'

  const wrappedOnStreamComplete = useCallback(() => {
    onStreamComplete?.()
    if (!isCodingModeForAutoFix) return // 异步探测，不阻塞 chatStream 其它动作
    ;(async () => {
      try {
        const res = await fetch(`/api/tasks/${task.id}/preview-errors`, { credentials: 'include' })
        if (!res.ok) return
        const data = (await res.json()) as {
          ok?: boolean
          buildErrors?: Array<{ source?: string; message?: string; file?: string }>
          runtimeErrors?: Array<{ source?: string; message?: string; stack?: string; componentStack?: string }>
        }
        const buildErrs = data.buildErrors ?? []
        const runtimeErrs = data.runtimeErrors ?? []
        if (buildErrs.length === 0 && runtimeErrs.length === 0) return
        const summary = [
          ...buildErrs.map((e) => `[build:${e.source || 'vite'}] ${e.file ? e.file + ': ' : ''}${e.message || ''}`),
          ...runtimeErrs.map((e) => `[runtime:${e.source || 'unknown'}] ${e.message || ''}`),
        ].join('\n---\n')
        const detail = runtimeErrs
          .map((e) => [e.stack, e.componentStack].filter(Boolean).join('\n'))
          .filter(Boolean)
          .join('\n---\n')
        autoFixRef.current?.scheduleAutoFix({
          source: 'preview-errors-probe',
          summary,
          detail: detail || undefined,
        })
      } catch {
        /* 静默 */
      }
    })()
  }, [onStreamComplete, isCodingModeForAutoFix, task.id])

  const chatStream = useChatStream(task.id, { onStreamComplete: wrappedOnStreamComplete })

  // Handle initial prompt (once) at this level
  const initialTriggered = useRef(false)
  useEffect(() => {
    if (!initialPrompt || initialTriggered.current) return
    initialTriggered.current = true
    onInitialPromptConsumed?.()
    chatStream.sendInitialPrompt(initialPrompt, initialImages)
  }, [initialPrompt, initialImages, onInitialPromptConsumed, chatStream.sendInitialPrompt])

  const [optimisticStatus, setOptimisticStatus] = useState<Task['status'] | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([])
  const [loadingMcpServers, setLoadingMcpServers] = useState(false)
  const { refreshTasks } = useTasks()
  const [showTaskMcpDialog, setShowTaskMcpDialog] = useState(false)
  const [showConnectorDialog, setShowConnectorDialog] = useState(false)
  const [showSkillsDialog, setShowSkillsDialog] = useState(false)
  const [skillsTab, setSkillsTab] = useState<string>('user')
  const [skillsList, setSkillsList] = useState<Array<{ name: string; description: string }>>([])
  const [userSkillsList, setUserSkillsList] = useState<Array<{ name: string; description: string }>>([])
  const [checkedUserSkills, setCheckedUserSkills] = useState<Set<string>>(new Set())
  const [checkedProjectSkills, setCheckedProjectSkills] = useState<Set<string>>(new Set())
  const [deletingProjectSkills, setDeletingProjectSkills] = useState(false)
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [loadingUserSkills, setLoadingUserSkills] = useState(false)
  const [selectedSkillDetail, setSelectedSkillDetail] = useState<{
    name: string
    description: string
    instructions?: string
    baseDirectory?: string
    allowedTools?: string[]
    source?: string
    location?: string
  } | null>(null)
  const [loadingSkillDetail, setLoadingSkillDetail] = useState(false)

  const [uninstallingSkill, setUninstallingSkill] = useState(false)
  const [initializingSkills, setInitializingSkills] = useState(false)
  const setEditingConnectorAction = useSetAtom(setEditingConnectorActionAtom)
  const [diffsCache, setDiffsCache] = useState<Record<string, DiffData>>({})
  const loadingDiffsRef = useRef(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const previousStatusRef = useRef<Task['status']>(task.status)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showTryAgainDialog, setShowTryAgainDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isTryingAgain, setIsTryingAgain] = useState(false)
  const [showLinkRepoDialog, setShowLinkRepoDialog] = useState(false)
  const [linkRepoUrl, setLinkRepoUrl] = useState('')
  const [linkBranchName, setLinkBranchName] = useState('')
  const [isLinkingRepo, setIsLinkingRepo] = useState(false)
  const [showUnlinkRepoDialog, setShowUnlinkRepoDialog] = useState(false)
  const [isUnlinkingRepo, setIsUnlinkingRepo] = useState(false)
  const [personalGitInfo, setPersonalGitInfo] = useState<{ repoUrl: string; branchName: string } | null>(null)
  const [selectedAgent, setSelectedAgent] = useState(task.selectedAgent || 'codebuddy')
  const [selectedModel, setSelectedModel] = useState<string>(
    task.selectedModel || DEFAULT_MODELS[(task.selectedAgent as keyof typeof DEFAULT_MODELS) || 'claude'],
  )
  const [tryAgainInstallDeps, setTryAgainInstallDeps] = useState(task.installDependencies || false)
  const [tryAgainMaxDuration, setTryAgainMaxDuration] = useState(task.maxDuration || maxSandboxDuration)
  const [tryAgainKeepAlive, setTryAgainKeepAlive] = useState(task.keepAlive || false)
  const [tryAgainEnableBrowser, setTryAgainEnableBrowser] = useState(task.enableBrowser || false)
  const [tryAgainAgentModels, setTryAgainAgentModels] = useState<Record<string, Array<{ id: string; name: string }>>>(
    {},
  )
  const [tryAgainUnavailableAgents, setTryAgainUnavailableAgents] = useState<Set<string>>(new Set())
  const [deploymentUrl, setDeploymentUrl] = useState<string | null>(task.previewUrl || null)
  const [loadingDeployment, setLoadingDeployment] = useState(false)
  const [showPRDialog, setShowPRDialog] = useState(false)
  const [showMergePRDialog, setShowMergePRDialog] = useState(false)
  const [prUrl, setPrUrl] = useState<string | null>(task.prUrl || null)
  const [prNumber, setPrNumber] = useState<number | null>(task.prNumber || null)
  const [prStatus, setPrStatus] = useState<'open' | 'closed' | 'merged' | null>(task.prStatus || null)
  const [isClosingPR, setIsClosingPR] = useState(false)
  const [isReopeningPR, setIsReopeningPR] = useState(false)
  const [isMergingPR, setIsMergingPR] = useState(false)
  const hasBranch = !!(task.branchName && task.branchName.trim().length > 0)
  const [filesPane, setFilesPane] = useState<'files' | 'changes'>(hasBranch ? 'changes' : 'files')
  const [subMode, setSubMode] = useState<'local' | 'remote'>(hasBranch ? 'remote' : 'local')
  const viewMode: 'local' | 'remote' | 'all' | 'all-local' =
    filesPane === 'files' ? (subMode === 'local' ? 'all-local' : 'all') : subMode
  const [activeTab, setActiveTab] = useState<'code' | 'chat' | 'preview' | 'cloud'>('code')
  const [showFilesList, setShowFilesList] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [sandboxTimeRemaining, setSandboxTimeRemaining] = useState<string | null>(null)

  // Desktop pane toggles - initialize from cookies
  const [showFilesPane, setShowFilesPane] = useState(() => getShowFilesPane())
  const [showCodePane, setShowCodePane] = useState(() => getShowCodePane())
  // isCodingMode: 只有明确 mode==='coding' 才显示 preview，其他（'default' 或 null/undefined）均不显示
  const isCodingMode = task.mode === 'coding'
  // Preview pane:
  //   - non-coding mode: never show (no button, no pane regardless of cookie)
  //   - coding mode: open by default; user can close and it's remembered via cookie
  const [showPreviewPane, setShowPreviewPane] = useState(() => {
    if (!isCodingMode) return false
    // getShowPreviewPane() defaults to false when no cookie exists.
    // For coding mode we want "open" as the factory default, so only honour
    // the cookie when it has been explicitly set (i.e. !== undefined).
    const raw = typeof document !== 'undefined' ? document.cookie.match(/(^| )show-preview-pane=([^;]+)/) : null
    return raw ? raw[2] === 'true' : true // default open for coding mode
  })
  const [showChatPane, setShowChatPane] = useState(() => getShowChatPane())
  const [showCloudPane, setShowCloudPane] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)

  // Coding mode preview state (P6+: /api/tasks/:id/preview-url 接口驱动)
  const [previewGatewayUrl, setPreviewGatewayUrl] = useState<string | null>(null)
  const [previewGatewayLoading, setPreviewGatewayLoading] = useState(false)
  const [previewGatewayError, setPreviewGatewayError] = useState<string | null>(null)
  const [previewLoadingMessage, setPreviewLoadingMessage] = useState('正在启动预览...')
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [checkingErrors, setCheckingErrors] = useState(false)
  const [previewCurrentPath, setPreviewCurrentPath] = useState<string | undefined>(undefined)
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)

  // ── 预览错误自动修复 ────────────────────────────────────────────
  // 两个触发源：
  //   1. iframe 预览内 postMessage({type:'preview-error', ...})
  //   2. 每轮对话完成后探测 /api/tasks/:id/preview-errors（见 wrappedOnStreamComplete）
  // 单 task 最多自动修复 3 次，taskId 切换 / 用户手动发 prompt 重置计数。
  const autoFix = useAutoFix(task.id, { chatStream })
  useEffect(() => {
    autoFixRef.current = { scheduleAutoFix: autoFix.scheduleAutoFix }
  }, [autoFix.scheduleAutoFix])

  // ── Preview iframe 双向通信 (PostMessage 协议) ────────────────────────────
  const [previewBuildError, setPreviewBuildError] = useState<string | null>(null)
  const [hmrUpdating, setHmrUpdating] = useState(false)

  const previewBridge = usePreviewBridge({
    iframeRef: previewIframeRef,
    previewUrl: previewGatewayUrl,
    enabled: isCodingMode,
    onReady: () => {
      setIframeLoaded(true)
    },
    onUrlChanged: (_url, path) => {
      setPreviewCurrentPath(path)
    },
    onBuildError: (message, stack) => {
      setPreviewBuildError(message)
      autoFix.scheduleAutoFix({
        source: 'iframe:build',
        summary: `[build] ${message}`,
        detail: stack || undefined,
      })
    },
    onBuildCleared: () => {
      setPreviewBuildError(null)
    },
    onHmrUpdateStart: () => {
      setHmrUpdating(true)
    },
    onHmrUpdateDone: () => {
      setHmrUpdating(false)
    },
    onError: (error) => {
      const message = error.message || '(no message)'
      const source = error.source || 'unknown'
      autoFix.scheduleAutoFix({
        source: `iframe:${source}`,
        summary: `[${source}] ${message}`,
        detail: [error.stack, error.componentStack].filter(Boolean).join('\n') || undefined,
      })
    },
  })

  /**
   * 调后端 SSE 流，实时推送进度。
   * 后端会按需安装依赖 / 启动 dev server，完成后推 { stage:'ready', gatewayUrl }。
   */
  const loadPreviewGatewayUrl = useCallback(async () => {
    if (!isCodingMode) return

    // 取消上一次请求
    previewAbortRef.current?.abort()
    const ctrl = new AbortController()
    previewAbortRef.current = ctrl

    setPreviewGatewayLoading(true)
    setPreviewGatewayError(null)
    setPreviewGatewayUrl(null)
    setPreviewLoadingMessage('正在启动预览...')

    try {
      const res = await fetch(`/api/tasks/${task.id}/preview-url`, {
        credentials: 'include',
        signal: ctrl.signal,
      })

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setPreviewGatewayError(data.error || `启动失败 (${res.status})`)
        setPreviewGatewayLoading(false)
        return
      }

      // 解析 SSE 流
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6)) as {
              stage: 'progress' | 'ready' | 'error'
              message: string
              gatewayUrl?: string
              port?: number
            }

            if (event.stage === 'progress') {
              setPreviewLoadingMessage(event.message)
            } else if (event.stage === 'ready' && event.gatewayUrl) {
              setPreviewGatewayUrl(event.gatewayUrl)
              setPreviewGatewayLoading(false)
              return
            } else if (event.stage === 'error') {
              setPreviewGatewayError(event.message)
              setPreviewGatewayLoading(false)
              return
            }
          } catch {
            // skip unparseable lines
          }
        }
      }

      // 流结束但没收到 ready
      if (!ctrl.signal.aborted) {
        setPreviewGatewayError('Preview stream ended unexpectedly')
        setPreviewGatewayLoading(false)
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') return
      setPreviewGatewayError('Failed to load preview')
      setPreviewGatewayLoading(false)
    }
  }, [isCodingMode, task.id])

  // 组件卸载时取消请求
  useEffect(() => {
    return () => {
      previewAbortRef.current?.abort()
    }
  }, [])

  // coding mode: preview pane 打开时加载 URL（若尚未加载）
  // 注意: 必须检查 !previewGatewayError，否则出错后 loading=false+url=null
  // 会导致 effect 再次触发 → 无限轮询
  // 注意: 必须检查 task.previewUrl，等 agent 完成 initCodingProject + startDevServer 后才触发
  useEffect(() => {
    if (
      isCodingMode &&
      showPreviewPane &&
      task.previewUrl &&
      !previewGatewayUrl &&
      !previewGatewayLoading &&
      !previewGatewayError
    ) {
      loadPreviewGatewayUrl()
    }
  }, [
    isCodingMode,
    showPreviewPane,
    task.previewUrl,
    previewGatewayUrl,
    previewGatewayLoading,
    previewGatewayError,
    loadPreviewGatewayUrl,
  ])

  // previewKey / URL 变化时重置 iframe 加载状态
  // previewKey 增加（手动刷新）时，重新调后端拉起 dev server
  useEffect(() => {
    setIframeLoaded(false)
    if (previewKey > 0 && isCodingMode) {
      setPreviewGatewayUrl(null)
      setPreviewGatewayError(null)
      setPreviewLoadingMessage('正在重启预览...')
      void loadPreviewGatewayUrl()
    }
  }, [previewKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 健康检查：优先用 bridge.ping（快速、无后端开销），HMR 断连时停止轮询。
  // HMR disconnected 说明 dev server 已不可用，不再浪费 ping。
  // 页面不可见时暂停轮询；切回可见时立即查一次。
  useEffect(() => {
    if (!isCodingMode || !previewGatewayUrl || previewGatewayLoading) return
    // HMR 断连 → 不轮询，等用户手动刷新
    if (previewBridge.hmrStatus === 'disconnected') return

    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null

    const checkHealth = async () => {
      if (cancelled) return
      try {
        // 优先尝试 bridge ping（iframe 内部双向通信）
        if (previewBridge.iframeReady) {
          await previewBridge.ping(8000)
          return // ping 成功 → dev server 正常
        }
        // Fallback: bridge 还没 ready 时走后端健康检查
        const res = await fetch(`/api/tasks/${task.id}/preview-health`, {
          credentials: 'include',
          signal: AbortSignal.timeout(12000),
        })
        if (!res.ok) return
        const data = (await res.json()) as { status: string; vitePort?: number | null }
        if (data.status === 'stopped' && !cancelled) {
          console.log('[preview] Dev server stopped, restarting...')
          if (interval) clearInterval(interval)
          setPreviewLoadingMessage('Dev server 已停止，正在重启...')
          void loadPreviewGatewayUrl()
        }
      } catch {
        // ping 超时或网络错误 → dev server 可能已停止，走后端确认
        if (cancelled) return
        try {
          const res = await fetch(`/api/tasks/${task.id}/preview-health`, {
            credentials: 'include',
            signal: AbortSignal.timeout(12000),
          })
          if (!res.ok) return
          const data = (await res.json()) as { status: string }
          if (data.status === 'stopped' && !cancelled) {
            if (interval) clearInterval(interval)
            setPreviewLoadingMessage('Dev server 已停止，正在重启...')
            void loadPreviewGatewayUrl()
          }
        } catch {
          // 网络错误忽略
        }
      }
    }

    const startPolling = () => {
      if (interval) return
      interval = setInterval(checkHealth, 30000)
    }
    const stopPolling = () => {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkHealth()
        startPolling()
      } else {
        stopPolling()
      }
    }

    if (document.visibilityState === 'visible') {
      startPolling()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [isCodingMode, previewGatewayUrl, previewGatewayLoading, previewBridge, loadPreviewGatewayUrl, task.id])

  // Pane widths for resizing
  const [filesPaneWidth, setFilesPaneWidth] = useState(() => getFilesPaneWidth())
  const [chatPaneWidth, setChatPaneWidth] = useState(() => getChatPaneWidth())
  const [resizingPane, setResizingPane] = useState<'files' | 'chat' | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false)
  const [isRestartingDevServer, setIsRestartingDevServer] = useState(false)
  const [isStoppingSandbox, setIsStoppingSandbox] = useState(false)
  const [isStartingSandbox, setIsStartingSandbox] = useState(false)
  const [sandboxHealth, setSandboxHealth] = useState<'running' | 'starting' | 'error' | 'stopped' | 'not_available'>(
    'starting',
  )
  const healthyCountRef = useRef<number>(0)
  const lastHealthStatusRef = useRef<string | null>(null)

  useEffect(() => {
    const loadPersonalGitInfo = async () => {
      try {
        const res = await fetch(`/api/tasks/${task.id}`)
        const data = await res.json()
        if (data.task?.personalGitInfo) {
          const info = JSON.parse(data.task.personalGitInfo)
          setPersonalGitInfo({ repoUrl: info.repoUrl || '', branchName: info.branchName || '' })
        } else {
          setPersonalGitInfo(null)
        }
      } catch {
        setPersonalGitInfo(null)
      }
    }
    loadPersonalGitInfo()
  }, [task.id])

  // Initialize model correctly on mount and when agent changes in Try Again dialog
  useEffect(() => {
    const agent = selectedAgent as keyof typeof DEFAULT_MODELS
    const taskModel = task.selectedModel

    // Check if the task's model exists in the agent's model list
    const agentModels = AGENT_MODELS[agent]
    const modelExists = agentModels?.some((m) => m.value === taskModel)

    // Use task model if it exists for the agent, otherwise use default
    const correctModel = modelExists && taskModel ? taskModel : DEFAULT_MODELS[agent]

    if (correctModel !== selectedModel) {
      setSelectedModel(correctModel)
    }
  }, [selectedAgent, task.selectedModel, selectedModel])

  // File search state
  const [fileSearchQuery, setFileSearchQuery] = useState('')
  const [showFileDropdown, setShowFileDropdown] = useState(false)
  const [allFiles, setAllFiles] = useState<string[]>([])
  const fileSearchRef = useRef<HTMLDivElement>(null)
  const tabsContainerRef = useRef<HTMLDivElement>(null)
  const tabButtonRefs = useRef<{ [key: string]: HTMLButtonElement | null }>({})
  const navigate = useNavigate()

  // Tabs state for Code pane - each mode has its own tabs and selection
  const [openTabsByMode, setOpenTabsByMode] = useState<{
    local: string[]
    remote: string[]
    all: string[]
    'all-local': string[]
  }>({
    local: [],
    remote: [],
    all: [],
    'all-local': [],
  })
  const [activeTabIndexByMode, setActiveTabIndexByMode] = useState<{
    local: number
    remote: number
    all: number
    'all-local': number
  }>({
    local: 0,
    remote: 0,
    all: 0,
    'all-local': 0,
  })
  const [selectedFileByMode, setSelectedFileByMode] = useState<{
    local: string | undefined
    remote: string | undefined
    all: string | undefined
    'all-local': string | undefined
  }>({
    local: undefined,
    remote: undefined,
    all: undefined,
    'all-local': undefined,
  })
  const [selectedItemIsFolderByMode, setSelectedItemIsFolderByMode] = useState<{
    local: boolean
    remote: boolean
    all: boolean
    'all-local': boolean
  }>({
    local: false,
    remote: false,
    all: false,
    'all-local': false,
  })
  const [tabsWithUnsavedChanges, setTabsWithUnsavedChanges] = useState<Set<string>>(new Set())
  const [tabsSaving, setTabsSaving] = useState<Set<string>>(new Set())
  const [showCloseTabDialog, setShowCloseTabDialog] = useState(false)
  const [tabToClose, setTabToClose] = useState<number | null>(null)
  // Track loaded file content hashes to detect changes
  const [loadedFileHashes, setLoadedFileHashes] = useState<Record<string, string>>({})

  // Get current mode's tabs and selection
  const openTabs = openTabsByMode[viewMode]
  const activeTabIndex = activeTabIndexByMode[viewMode]
  const selectedFile = selectedFileByMode[viewMode]
  const selectedItemIsFolder = selectedItemIsFolderByMode[viewMode]

  // ─── Derived pane visibility flags ──────────────────────────────────
  const hasFilesSupport = hasBranch || !!task.sandboxId
  const showCodeViewer = (showCodePane && hasBranch) || (!!selectedFile && showFilesPane)
  const hasMiddlePane = showCodeViewer || showPreviewPane || showCloudPane

  // Helper function to format dates - show only time if same day as today
  const formatDateTime = (date: Date) => {
    const today = new Date()
    const isToday = date.toDateString() === today.toDateString()

    if (isToday) {
      return date.toLocaleTimeString()
    } else {
      return `${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`
    }
  }

  // View mode change handler
  const handleViewModeChange = useCallback((newMode: 'local' | 'remote' | 'all' | 'all-local') => {
    if (newMode === 'all' || newMode === 'all-local') {
      setFilesPane('files')
      setSubMode(newMode === 'all-local' ? 'local' : 'remote')
    } else {
      setFilesPane('changes')
      setSubMode(newMode)
    }
  }, [])

  // Tab management functions
  const openFileInTab = async (file: string, isFolder?: boolean) => {
    // If it's a folder, just update the selected file state (for creating files/folders in that location)
    if (isFolder) {
      setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: file }))
      setSelectedItemIsFolderByMode((prev) => ({ ...prev, [viewMode]: true }))
      return
    }

    // Mark as not a folder
    setSelectedItemIsFolderByMode((prev) => ({ ...prev, [viewMode]: false }))

    const currentTabs = openTabsByMode[viewMode]
    const existingIndex = currentTabs.indexOf(file)

    // For Changes mode (local or remote), only show one file at a time (no tabs)
    const isChangesMode = viewMode === 'local' || viewMode === 'remote'

    // Check if file is already loaded and has changed
    if (existingIndex !== -1 && loadedFileHashes[file]) {
      try {
        const params = new URLSearchParams()
        params.set('filename', file)

        const endpoint =
          viewMode === 'all' || viewMode === 'all-local'
            ? `/api/tasks/${task.id}/file-content`
            : `/api/tasks/${task.id}/diff`

        if (viewMode === 'local' || viewMode === 'all-local') {
          params.set('mode', 'local')
        }

        const response = await fetch(`${endpoint}?${params.toString()}`)
        const result = await response.json()

        if (result.success && result.data) {
          // Create a simple hash of the content
          const newContent = result.data.newContent || result.data.oldContent || ''
          const newHash = `${newContent.length}-${newContent.substring(0, 100)}`

          if (loadedFileHashes[file] !== newHash) {
            // Content has changed, show toast
            toast.info(`文件 "${file}" 已更新`, {
              description: '文件有新更改。是否重新加载？',
              duration: 10000,
              action: {
                label: '加载最新',
                onClick: () => {
                  // Update hash and force reload by changing selection
                  setLoadedFileHashes((prev) => ({ ...prev, [file]: newHash }))
                  // Force reload by briefly deselecting then reselecting
                  setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: undefined }))
                  setTimeout(() => {
                    setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: existingIndex }))
                    setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: file }))
                  }, 10)
                },
              },
              cancel: {
                label: '忽略',
                onClick: () => {
                  // Just switch to the tab without reloading
                  setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: existingIndex }))
                  setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: file }))
                },
              },
            })
            return
          }
        }
      } catch (err) {
        console.error('Error checking for file changes:', err)
        // Continue with normal flow on error
      }
    }

    if (isChangesMode) {
      // Replace the current file (only one file at a time)
      setOpenTabsByMode((prev) => ({ ...prev, [viewMode]: [file] }))
      setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: 0 }))
      setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: file }))
    } else {
      // Files mode: use tabs
      if (existingIndex !== -1) {
        // File already open in this mode, just switch to it
        setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: existingIndex }))
        setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: file }))
      } else {
        // Open new tab in current mode
        const newTabs = [...currentTabs, file]
        setOpenTabsByMode((prev) => ({ ...prev, [viewMode]: newTabs }))
        setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: newTabs.length - 1 }))
        setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: file }))
      }
    }
  }

  const handleUnsavedChanges = useCallback((filename: string, hasChanges: boolean) => {
    setTabsWithUnsavedChanges((prev) => {
      const newSet = new Set(prev)
      if (hasChanges) {
        newSet.add(filename)
      } else {
        newSet.delete(filename)
      }
      return newSet
    })
  }, [])

  const handleSavingStateChange = useCallback((filename: string, isSaving: boolean) => {
    setTabsSaving((prev) => {
      const newSet = new Set(prev)
      if (isSaving) {
        newSet.add(filename)
      } else {
        newSet.delete(filename)
      }
      return newSet
    })
  }, [])

  const handleSaveSuccess = useCallback(() => {
    // When a file is saved in 'all-local' mode, refresh the file browser
    // to update file status (show modified files in yellow)
    if (viewMode === 'all-local') {
      setRefreshKey((prev) => prev + 1)
    }
  }, [viewMode])

  const handleFileLoaded = useCallback((filename: string, content: string) => {
    // Create a simple hash of the content when file is loaded
    const hash = `${content.length}-${content.substring(0, 100)}`
    setLoadedFileHashes((prev) => ({ ...prev, [filename]: hash }))
  }, [])

  const attemptCloseTab = (index: number, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const currentTabs = openTabsByMode[viewMode]
    const fileToClose = currentTabs[index]

    // Check if the tab has unsaved changes
    if (tabsWithUnsavedChanges.has(fileToClose)) {
      setTabToClose(index)
      setShowCloseTabDialog(true)
    } else {
      closeTab(index)
    }
  }

  const closeTab = (index: number) => {
    const currentTabs = openTabsByMode[viewMode]
    const currentActiveIndex = activeTabIndexByMode[viewMode]
    const fileToClose = currentTabs[index]
    const newTabs = currentTabs.filter((_, i) => i !== index)

    setOpenTabsByMode((prev) => ({ ...prev, [viewMode]: newTabs }))

    // Remove from unsaved changes
    setTabsWithUnsavedChanges((prev) => {
      const newSet = new Set(prev)
      newSet.delete(fileToClose)
      return newSet
    })

    // Adjust active tab index
    if (newTabs.length === 0) {
      setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: 0 }))
      setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: undefined }))
      setSelectedItemIsFolderByMode((prev) => ({ ...prev, [viewMode]: false }))
    } else if (currentActiveIndex >= newTabs.length) {
      setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: newTabs.length - 1 }))
      setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: newTabs[newTabs.length - 1] }))
      setSelectedItemIsFolderByMode((prev) => ({ ...prev, [viewMode]: false }))
    } else if (currentActiveIndex === index) {
      // If closing the active tab, switch to the previous tab (or next if it's the first)
      const newIndex = Math.max(0, index - 1)
      setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: newIndex }))
      setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: newTabs[newIndex] }))
      setSelectedItemIsFolderByMode((prev) => ({ ...prev, [viewMode]: false }))
    } else if (currentActiveIndex > index) {
      // Adjust index if a tab before the active one was closed
      setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: currentActiveIndex - 1 }))
    }
  }

  const handleCloseTabConfirm = (save: boolean) => {
    if (tabToClose === null) return

    if (save) {
      // Trigger save by dispatching Cmd+S event
      const event = new KeyboardEvent('keydown', {
        key: 's',
        metaKey: true,
        bubbles: true,
      })
      document.dispatchEvent(event)
      // Wait a moment for save to complete, then close
      setTimeout(() => {
        closeTab(tabToClose)
        setShowCloseTabDialog(false)
        setTabToClose(null)
      }, 500)
    } else {
      closeTab(tabToClose)
      setShowCloseTabDialog(false)
      setTabToClose(null)
    }
  }

  const switchToTab = (index: number) => {
    const currentTabs = openTabsByMode[viewMode]
    setActiveTabIndexByMode((prev) => ({ ...prev, [viewMode]: index }))
    setSelectedFileByMode((prev) => ({ ...prev, [viewMode]: currentTabs[index] }))
    setSelectedItemIsFolderByMode((prev) => ({ ...prev, [viewMode]: false }))
  }

  // Use optimistic status if available, otherwise use actual task status
  const currentStatus = optimisticStatus || task.status

  // Clear optimistic status when task status actually changes
  useEffect(() => {
    if (optimisticStatus && task.status === optimisticStatus) {
      setOptimisticStatus(null)
    }
  }, [task.status, optimisticStatus])

  // Calculate and update sandbox time remaining
  useEffect(() => {
    // Show timer if keepAlive is enabled and sandbox has been created (not pending)
    if (!task.keepAlive || currentStatus === 'pending' || !task.createdAt) {
      setSandboxTimeRemaining(null)
      return
    }

    const calculateTimeRemaining = () => {
      // Sandbox timeout starts from when it was CREATED, not completed
      const createdTime = new Date(task.createdAt!).getTime()
      const now = Date.now()
      const maxDurationMs = (task.maxDuration || 300) * 60 * 1000 // maxDuration is in minutes
      const elapsed = now - createdTime
      const remaining = maxDurationMs - elapsed

      if (remaining <= 0) {
        return null
      }

      const hours = Math.floor(remaining / (60 * 60 * 1000))
      const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000))

      return `${hours}h ${minutes}m`
    }

    // Update immediately
    setSandboxTimeRemaining(calculateTimeRemaining())

    // Update every minute
    const interval = setInterval(() => {
      setSandboxTimeRemaining(calculateTimeRemaining())
    }, 60000) // 60 seconds

    return () => clearInterval(interval)
  }, [currentStatus, task.keepAlive, task.createdAt])

  // Periodic sandbox health check
  useEffect(() => {
    if (!task.sandboxUrl) {
      setSandboxHealth('not_available')
      healthyCountRef.current = 0
      lastHealthStatusRef.current = null
      return
    }

    // Set to starting initially until we confirm it's healthy
    setSandboxHealth('starting')

    const checkHealth = async () => {
      try {
        const response = await fetch(`/api/tasks/${task.id}/sandbox-health`)
        if (response.ok) {
          const data = await response.json()
          const currentStatus = data.status

          // If status is 'running', require it to be stable for 2 checks (4 seconds)
          if (currentStatus === 'running') {
            if (lastHealthStatusRef.current === 'running') {
              healthyCountRef.current += 1
              // Only set to running after 2 consecutive healthy checks (4 seconds)
              if (healthyCountRef.current >= 2) {
                setSandboxHealth('running')
              } else {
                // Still show starting while we're waiting for stability
                setSandboxHealth('starting')
              }
            } else {
              // First healthy check, reset counter
              healthyCountRef.current = 1
              lastHealthStatusRef.current = 'running'
              setSandboxHealth('starting')
            }
          } else {
            // Not running, reset counter and set status immediately
            healthyCountRef.current = 0
            lastHealthStatusRef.current = currentStatus
            setSandboxHealth(data.status)
          }
        }
      } catch (error) {
        console.error('Health check failed:', error)
        healthyCountRef.current = 0
        lastHealthStatusRef.current = null
      }
    }

    // Check immediately
    checkHealth()

    // Check every 2 seconds
    const interval = setInterval(checkHealth, 2000)

    return () => {
      clearInterval(interval)
      healthyCountRef.current = 0
      lastHealthStatusRef.current = null
    }
  }, [task.id, task.sandboxUrl])

  const getAgentLogo = (agent: string | null) => {
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

  // Model mappings for all agents
  const AGENT_MODELS: Record<string, Array<{ value: string; label: string }>> = {
    claude: [
      { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
      { value: 'anthropic/claude-opus-4.6', label: 'Opus 4.6' },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ],
    codex: [
      { value: 'openai/gpt-5', label: 'GPT-5' },
      { value: 'gpt-5-codex', label: 'GPT-5-Codex' },
      { value: 'openai/gpt-5-mini', label: 'GPT-5 mini' },
      { value: 'openai/gpt-5-nano', label: 'GPT-5 nano' },
      { value: 'gpt-5-pro', label: 'GPT-5 pro' },
      { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
    ],
    copilot: [
      { value: 'claude-sonnet-4.5', label: 'Sonnet 4.5' },
      { value: 'claude-sonnet-4', label: 'Sonnet 4' },
      { value: 'claude-haiku-4.5', label: 'Haiku 4.5' },
      { value: 'gpt-5', label: 'GPT-5' },
    ],
    cursor: [
      { value: 'auto', label: 'Auto' },
      { value: 'sonnet-4.5', label: 'Sonnet 4.5' },
      { value: 'sonnet-4.5-thinking', label: 'Sonnet 4.5 Thinking' },
      { value: 'gpt-5', label: 'GPT-5' },
      { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { value: 'opus-4.1', label: 'Opus 4.1' },
      { value: 'grok', label: 'Grok' },
    ],
    gemini: [
      { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    opencode: [
      { value: 'gpt-5', label: 'GPT-5' },
      { value: 'gpt-5-mini', label: 'GPT-5 mini' },
      { value: 'gpt-5-nano', label: 'GPT-5 nano' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
      { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
      { value: 'claude-opus-4-5', label: 'Opus 4.5' },
      { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ],
  }

  // Get readable model name
  const getModelName = (modelId: string | null, agent: string | null) => {
    if (!modelId || !agent) return modelId

    const agentModels = AGENT_MODELS[agent.toLowerCase()]
    if (!agentModels) return modelId

    const model = agentModels.find((m) => m.value === modelId)
    return model ? model.label : modelId
  }

  // Function to determine which icon to show for a connector
  const getConnectorIcon = (server: McpServerConfig) => {
    const lowerName = server.name?.toLowerCase() || ''
    const url = server.baseUrl?.toLowerCase() || ''
    const cmd = server.command?.toLowerCase() || ''

    // Check by name, URL, or command
    if (lowerName.includes('browserbase') || cmd.includes('browserbasehq') || cmd.includes('@browserbasehq/mcp')) {
      return <BrowserbaseIcon className="h-6 w-6 flex-shrink-0" />
    }
    if (lowerName.includes('context7') || url.includes('context7.com')) {
      return <Context7Icon className="h-6 w-6 flex-shrink-0" />
    }
    if (lowerName.includes('convex') || cmd.includes('convex') || url.includes('convex')) {
      return <ConvexIcon className="h-6 w-6 flex-shrink-0" />
    }
    if (lowerName.includes('figma') || url.includes('figma.com')) {
      return <FigmaIcon className="h-6 w-6 flex-shrink-0" />
    }
    if (lowerName.includes('hugging') || lowerName.includes('huggingface') || url.includes('hf.co')) {
      return <HuggingFaceIcon className="h-6 w-6 flex-shrink-0" />
    }
    if (lowerName.includes('linear') || url.includes('linear.app')) {
      return <LinearIcon className="h-6 w-6 flex-shrink-0" />
    }
    if (lowerName.includes('notion') || url.includes('notion.com')) {
      return <NotionIcon className="h-6 w-6 flex-shrink-0" />
    }
    if (lowerName.includes('playwright') || cmd.includes('playwright') || cmd.includes('@playwright/mcp')) {
      return <PlaywrightIcon className="h-6 w-6 flex-shrink-0" />
    }
    if (lowerName.includes('supabase') || url.includes('supabase.com')) {
      return <SupabaseIcon className="h-6 w-6 flex-shrink-0" />
    }

    // Default icon
    return <Server className="h-6 w-6 flex-shrink-0 text-muted-foreground" />
  }

  const persistTaskMcpServers = async (next: McpServerConfig[]) => {
    const response = await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update-mcp-servers', mcpServerList: next }),
    })

    if (!response.ok) {
      throw new Error('Failed to update MCP servers')
    }

    await refreshTasks()
  }

  const handleRemoveMcpServer = async (serverIndex: number) => {
    const previous = mcpServers
    const next = mcpServers.filter((_, index) => index !== serverIndex)
    setMcpServers(next)
    try {
      await persistTaskMcpServers(next)
      toast.success('MCP server removed')
    } catch {
      setMcpServers(previous)
      toast.error('Failed to update MCP servers')
    }
  }

  const handleEditMcpServer = (server: McpServerConfig) => {
    setEditingConnectorAction(server as any)
    setShowTaskMcpDialog(false)
    setShowConnectorDialog(true)
  }

  const fetchSkills = useCallback(async () => {
    setLoadingSkills(true)
    try {
      const res = await fetch(`/api/skills?taskId=${encodeURIComponent(task.id)}`, { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setSkillsList(data.skills ?? [])
        setSkillsLoaded(true)
      }
    } catch {
      // ignore
    } finally {
      setLoadingSkills(false)
    }
  }, [task.id])

  const fetchUserSkills = useCallback(async () => {
    setLoadingUserSkills(true)
    try {
      const params = new URLSearchParams({ prefix: `${userId}/skills/`, bucketType: 'storage' })
      const res = await fetch(`/api/storage/files?${params}`, { credentials: 'include' })
      if (res.ok) {
        const files: Array<{ name: string; isDir: boolean }> = await res.json()
        // 只取第一层目录，目录名作为 skill name
        const skills = files.filter((f) => f.isDir).map((f) => ({ name: f.name, description: '' }))
        setUserSkillsList(skills)
      }
    } catch {
      // ignore
    } finally {
      setLoadingUserSkills(false)
    }
  }, [])

  const refreshAllSkills = useCallback(async () => {
    await Promise.all([fetchSkills(), fetchUserSkills()])
  }, [fetchSkills, fetchUserSkills])

  // 预加载 skills 列表，用于对话框中的 / 命令补全
  useEffect(() => {
    if (!skillsLoaded) fetchSkills()
  }, [skillsLoaded, fetchSkills])

  const fetchSkillDetail = useCallback(
    async (skillName: string) => {
      setLoadingSkillDetail(true)
      setSelectedSkillDetail(null)
      try {
        const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}?taskId=${encodeURIComponent(task.id)}`, {
          credentials: 'include',
        })
        if (res.ok) {
          const data = await res.json()
          setSelectedSkillDetail(data)
        }
      } catch {
        // ignore
      } finally {
        setLoadingSkillDetail(false)
      }
    },
    [task.id],
  )

  const handleUninstallSkill = useCallback(
    async (skillName: string) => {
      setUninstallingSkill(true)
      try {
        const res = await fetch('/api/skills/delete', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: task.id, skillNames: [skillName] }),
        })
        if (res.ok) {
          setSelectedSkillDetail(null)
          fetchSkills()
        }
      } catch {
        // ignore
      } finally {
        setUninstallingSkill(false)
      }
    },
    [task.id, fetchSkills],
  )

  const handleInitSkills = useCallback(async () => {
    if (checkedUserSkills.size === 0) {
      toast.error('请先勾选要同步的 Skill')
      return
    }
    setInitializingSkills(true)
    try {
      const skillNames = Array.from(checkedUserSkills)
      const res = await fetch('/api/skills/init', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, skillNames }),
      })
      if (res.ok) {
        toast.success('Skills initialized successfully')
        fetchSkills()
      } else {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error || 'Failed to initialize skills')
      }
    } catch {
      toast.error('Failed to initialize skills')
    } finally {
      setInitializingSkills(false)
    }
  }, [task.id, fetchSkills, checkedUserSkills])

  const [deletingUserSkills, setDeletingUserSkills] = useState(false)
  const [uploadingSkill, setUploadingSkill] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null)
  const skillFolderInputRef = useRef<HTMLInputElement>(null)

  const handleUploadSkillFolder = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target
      const inputFiles = input.files ? [...input.files] : []
      if (!inputFiles.length) return

      // 从 webkitRelativePath 提取顶层文件夹名称（skill 名称）
      const firstRelPath = inputFiles[0].webkitRelativePath || inputFiles[0].name
      const skillName = firstRelPath.split('/')[0]
      if (!skillName) {
        toast.error('无法识别文件夹名称')
        input.value = ''
        return
      }

      // 检查是否包含 SKILL.md
      const hasSkillMd = inputFiles.some((f) => {
        const rel = f.webkitRelativePath || f.name
        const parts = rel.split('/')
        return parts.length === 2 && parts[1] === 'SKILL.md'
      })
      if (!hasSkillMd) {
        toast.error(`文件夹 "${skillName}" 中缺少 SKILL.md 文件`)
        input.value = ''
        return
      }

      setUploadingSkill(true)
      setUploadProgress({ current: 0, total: inputFiles.length })

      try {
        // 过滤掉隐藏文件和空目录占位
        const filesToUpload = inputFiles.filter((f) => {
          const rel = f.webkitRelativePath || f.name
          const parts = rel.split('/')
          return !parts.some((p) => p.startsWith('.') && p !== '.' && p !== '..')
        })

        setUploadProgress({ current: 0, total: filesToUpload.length })

        // 使用 dashboard StorageAPI 上传
        const storageAPI = new StorageAPI({ envId: sessionEnvId, taskId: task.id })
        const buckets = await storageAPI.getBuckets()
        const storageBucket = buckets.find((b) => b.type === 'storage')
        if (!storageBucket) {
          toast.error('未找到云存储桶')
          return
        }

        const { errors } = await storageAPI.uploadFiles({
          files: filesToUpload,
          bucket: storageBucket,
          prefix: `${userId}/skills/`,
          onProgress: (completed, total) => {
            setUploadProgress({ current: completed, total })
          },
        })

        if (errors.length > 0) {
          toast.error(`${errors.length} 个文件上传失败`)
        } else {
          toast.success(`Skill "${skillName}" 上传成功`)
        }
        fetchUserSkills()
      } catch {
        toast.error('上传失败')
      } finally {
        setUploadingSkill(false)
        setUploadProgress(null)
        input.value = ''
      }
    },
    [fetchUserSkills, sessionEnvId, task.id],
  )

  const handleDeleteUserSkills = useCallback(async () => {
    if (checkedUserSkills.size === 0) {
      toast.error('请先勾选要删除的 Skill')
      return
    }
    const confirmed = window.confirm(`确定要删除选中的 ${checkedUserSkills.size} 个 Skill 吗？此操作不可恢复。`)
    if (!confirmed) return

    setDeletingUserSkills(true)
    try {
      const skillNames = Array.from(checkedUserSkills)
      const errors: string[] = []

      await Promise.all(
        skillNames.map(async (name) => {
          const res = await fetch('/api/storage/files', {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: `${userId}/skills/${name}/`, bucketType: 'storage' }),
          })
          if (!res.ok) errors.push(name)
        }),
      )

      if (errors.length > 0) {
        toast.error(`部分 Skill 删除失败: ${errors.join(', ')}`)
      } else {
        toast.success('Skills deleted successfully')
      }
      setCheckedUserSkills(new Set())
      fetchUserSkills()
    } catch {
      toast.error('Failed to delete skills')
    } finally {
      setDeletingUserSkills(false)
    }
  }, [checkedUserSkills, fetchUserSkills])

  const handleDeleteProjectSkills = useCallback(async () => {
    if (checkedProjectSkills.size === 0) {
      toast.error('请先勾选要删除的 Skill')
      return
    }
    const confirmed = window.confirm(
      `确定要从沙箱中删除选中的 ${checkedProjectSkills.size} 个项目 Skill 吗？此操作不可恢复。`,
    )
    if (!confirmed) return

    setDeletingProjectSkills(true)
    try {
      const skillNames = Array.from(checkedProjectSkills)
      const res = await fetch('/api/skills/delete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, skillNames }),
      })

      if (res.ok) {
        toast.success('项目 Skills 删除成功')
      } else if (res.status === 207) {
        const data = await res.json()
        toast.error(`部分 Skill 删除失败: ${data.errors?.join(', ')}`)
      } else {
        toast.error('删除失败')
      }
      setCheckedProjectSkills(new Set())
      fetchSkills()
    } catch {
      toast.error('Failed to delete project skills')
    } finally {
      setDeletingProjectSkills(false)
    }
  }, [checkedProjectSkills, task.id, fetchSkills])

  const handleConnectorSaved = async (connector: Connector) => {
    const config: McpServerConfig = {
      name: connector.name,
      description: connector.description,
      type: connector.type,
      baseUrl: connector.baseUrl,
      command: connector.command,
      args: connector.args,
      headers: connector.headers,
    }
    const previous = mcpServers
    const exists = mcpServers.some((s) => s.name === config.name)
    const next = exists ? mcpServers.map((s) => (s.name === config.name ? config : s)) : [...mcpServers, config]
    setMcpServers(next)
    try {
      await persistTaskMcpServers(next)
      setShowConnectorDialog(false)
    } catch {
      setMcpServers(previous)
      toast.error('Failed to update MCP servers')
    }
  }

  // Fetch MCP servers if task has mcpServerList (only when IDs actually change)
  useEffect(() => {
    if (!task.mcpServerList || task.mcpServerList.length === 0) {
      setMcpServers([])
      return
    }

    setLoadingMcpServers(true)
    setMcpServers(task.mcpServerList ?? [])
    setLoadingMcpServers(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(task.mcpServerList)])

  // Fetch deployment info when task is completed and has a branch (only if not already cached)
  useEffect(() => {
    async function fetchDeployment() {
      // Skip if we already have a preview URL or task isn't ready
      if (deploymentUrl || currentStatus !== 'completed' || !task.branchName) {
        return
      }

      setLoadingDeployment(true)

      try {
        const response = await fetch(`/api/tasks/${task.id}/deployment`)
        if (response.ok) {
          const result = await response.json()
          if (result.success && result.data.hasDeployment && result.data.previewUrl) {
            setDeploymentUrl(result.data.previewUrl)
          }
        }
      } catch (error) {
        console.error('Failed to fetch deployment info:', error)
      } finally {
        setLoadingDeployment(false)
      }
    }

    fetchDeployment()
  }, [task.id, task.branchName, currentStatus, deploymentUrl])

  // Update deploymentUrl when task.previewUrl changes
  useEffect(() => {
    if (task.previewUrl && task.previewUrl !== deploymentUrl) {
      setDeploymentUrl(task.previewUrl)
    }
  }, [task.previewUrl, deploymentUrl])

  // Update prUrl, prNumber, and prStatus when task values change
  useEffect(() => {
    if (task.prUrl && task.prUrl !== prUrl) {
      console.log('[Update] prUrl changed:', task.prUrl)
      setPrUrl(task.prUrl)
    }
    if (task.prNumber && task.prNumber !== prNumber) {
      console.log('[Update] prNumber changed:', task.prNumber)
      setPrNumber(task.prNumber)
    }
    if (task.prStatus && task.prStatus !== prStatus) {
      console.log('[Update] prStatus changing from', prStatus, 'to', task.prStatus)
      setPrStatus(task.prStatus as 'open' | 'closed' | 'merged')
    }
  }, [task.prUrl, task.prNumber, task.prStatus, prUrl, prNumber, prStatus])

  // Clear loading states when PR status changes to expected value
  useEffect(() => {
    console.log(
      '[Clear] Check - prStatus:',
      prStatus,
      'isClosingPR:',
      isClosingPR,
      'isReopeningPR:',
      isReopeningPR,
      'isMergingPR:',
      isMergingPR,
    )

    if (prStatus === 'closed' && isClosingPR) {
      console.log('[Clear] Clearing isClosingPR and showing toast')
      setIsClosingPR(false)
      toast.success('Pull request closed successfully!')
    }
    if (prStatus === 'open' && isReopeningPR) {
      console.log('[Clear] Clearing isReopeningPR and showing toast')
      setIsReopeningPR(false)
      toast.success('Pull request reopened successfully!')
    }
    if (prStatus === 'merged' && isMergingPR) {
      console.log('[Clear] Clearing isMergingPR and showing toast')
      setIsMergingPR(false)
      toast.success('Pull request merged successfully!')
    }
  }, [prStatus, isClosingPR, isReopeningPR, isMergingPR])

  // Clear merge loading state if dialog closes without merging
  useEffect(() => {
    if (!showMergePRDialog && isMergingPR && prStatus !== 'merged') {
      setIsMergingPR(false)
    }
  }, [showMergePRDialog, isMergingPR, prStatus])

  // Sync PR status from GitHub when task has a PR
  useEffect(() => {
    async function syncPRStatus() {
      if (!task.prUrl || !task.prNumber || !task.repoUrl) {
        return
      }

      // Sync if status is 'open' (could have been merged/closed) OR if status is not set
      if (task.prStatus === 'open' || !task.prStatus) {
        try {
          const response = await fetch(`/api/tasks/${task.id}/sync-pr`, {
            method: 'POST',
          })
          const result = await response.json()

          if (response.ok && result.success && result.data.status) {
            // Update local state if status changed
            if (result.data.status !== prStatus) {
              setPrStatus(result.data.status)
              refreshTasks()
            }
          }
        } catch (error) {
          // Silently fail - not critical if sync doesn't work
          console.error('Failed to sync PR status:', error)
        }
      }
    }

    syncPRStatus()
    // Only run on mount and when prNumber changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.prNumber])

  // Fetch diffs for changed files only (in "changes" mode)
  const fetchAllDiffs = useCallback(
    async (filesList: string[]) => {
      if (!filesList.length || loadingDiffsRef.current) return

      // Store all files for search
      setAllFiles(filesList)

      // Only pre-fetch diffs in "local" or "remote" mode
      if (viewMode !== 'local' && viewMode !== 'remote') return

      loadingDiffsRef.current = true
      const newDiffsCache: Record<string, DiffData> = {}

      try {
        // Fetch all diffs in parallel
        const diffPromises = filesList.map(async (filename) => {
          try {
            const params = new URLSearchParams()
            params.set('filename', filename)

            const response = await fetch(`/api/tasks/${task.id}/diff?${params.toString()}`)
            const result = await response.json()

            if (response.ok && result.success) {
              newDiffsCache[filename] = result.data
            }
          } catch (err) {
            console.error('Error fetching diff for file:', err)
          }
        })

        await Promise.all(diffPromises)
        setDiffsCache(newDiffsCache)
      } catch (error) {
        console.error('Error fetching diffs:', error)
      } finally {
        loadingDiffsRef.current = false
      }
    },
    [task.id, viewMode],
  )

  // Handle click outside file dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (fileSearchRef.current && !fileSearchRef.current.contains(event.target as Node)) {
        setShowFileDropdown(false)
      }
    }

    if (showFileDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showFileDropdown])

  // Refs to track latest width values for resize handler (avoids stale closure)
  const filesPaneWidthRef = useRef(filesPaneWidth)
  const chatPaneWidthRef = useRef(chatPaneWidth)

  // Keep refs in sync with state
  useEffect(() => {
    filesPaneWidthRef.current = filesPaneWidth
  }, [filesPaneWidth])

  useEffect(() => {
    chatPaneWidthRef.current = chatPaneWidth
  }, [chatPaneWidth])

  // Handle pane resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingPane || !containerRef.current) return

      const containerRect = containerRef.current.getBoundingClientRect()

      if (resizingPane === 'files') {
        const newWidth = e.clientX - containerRect.left
        const minWidth = 150
        const maxWidth = 500

        if (newWidth >= minWidth && newWidth <= maxWidth) {
          setFilesPaneWidth(newWidth)
          filesPaneWidthRef.current = newWidth
        }
      } else if (resizingPane === 'chat') {
        const newWidth = containerRect.right - e.clientX
        const minWidth = 200
        const maxWidth = 500

        if (newWidth >= minWidth && newWidth <= maxWidth) {
          setChatPaneWidth(newWidth)
          chatPaneWidthRef.current = newWidth
        }
      }
    }

    const handleMouseUp = () => {
      if (resizingPane === 'files') {
        saveFilesPaneWidth(filesPaneWidthRef.current)
      } else if (resizingPane === 'chat') {
        saveChatPaneWidth(chatPaneWidthRef.current)
      }
      setResizingPane(null)
    }

    if (resizingPane) {
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
  }, [resizingPane])

  // Keyboard shortcuts for pane toggles and tab management
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return
      }

      // Tab management shortcuts (Cmd/Ctrl + W to close, Cmd/Ctrl + 1-9 to switch)
      if (event.metaKey || event.ctrlKey) {
        // Close current tab with Cmd/Ctrl + W
        if (event.key === 'w' && openTabs.length > 0) {
          event.preventDefault()
          attemptCloseTab(activeTabIndex)
          return
        }

        // Switch to tab 1-9 with Cmd/Ctrl + 1-9
        const digit = parseInt(event.key)
        if (digit >= 1 && digit <= 9 && openTabs.length >= digit) {
          event.preventDefault()
          switchToTab(digit - 1)
          return
        }
      }

      // Pane toggle shortcuts (Alt + 1-4)
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        // Use event.code instead of event.key to handle macOS Option key special characters
        switch (event.code) {
          case 'Digit1':
            event.preventDefault()
            setShowFilesPane((prev) => {
              const newValue = !prev
              saveShowFilesPane(newValue)
              return newValue
            })
            break
          case 'Digit2':
            event.preventDefault()
            setShowCodePane((prev) => {
              const newValue = !prev
              saveShowCodePane(newValue)
              return newValue
            })
            break
          case 'Digit3':
            event.preventDefault()
            setShowPreviewPane((prev) => {
              const newValue = !prev
              // Preview 和 Files 互斥:打开 Preview 时关 Files
              if (newValue) {
                setShowFilesPane(false)
                saveShowFilesPane(false)
              }
              saveShowPreviewPane(newValue)
              return newValue
            })
            break
          case 'Digit4':
            event.preventDefault()
            setShowChatPane((prev) => {
              const newValue = !prev
              saveShowChatPane(newValue)
              return newValue
            })
            break
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [openTabs, activeTabIndex])

  // Trigger refresh when task completes
  useEffect(() => {
    const currentStatus = optimisticStatus || task.status
    const previousStatus = previousStatusRef.current

    // If task transitions from processing/pending to completed/error/stopped, trigger refresh
    if (
      (previousStatus === 'processing' || previousStatus === 'pending') &&
      (currentStatus === 'completed' || currentStatus === 'error' || currentStatus === 'stopped')
    ) {
      setRefreshKey((prev) => prev + 1)
      // Clear diffs cache to force reload
      setDiffsCache({})
      // Clear selected files for all modes
      setSelectedFileByMode({ local: undefined, remote: undefined, all: undefined, 'all-local': undefined })
    }

    previousStatusRef.current = currentStatus
  }, [task.status, optimisticStatus])

  // Update model when agent changes
  useEffect(() => {
    if (selectedAgent) {
      const agentModels = AGENT_MODELS[selectedAgent as keyof typeof AGENT_MODELS]
      const defaultModel = DEFAULT_MODELS[selectedAgent as keyof typeof DEFAULT_MODELS]
      if (defaultModel && agentModels) {
        setSelectedModel(defaultModel)
      }
    }
  }, [selectedAgent])

  // Scroll active tab into view when it changes
  useEffect(() => {
    const tabKey = `${viewMode}-${activeTabIndex}`
    const activeTabButton = tabButtonRefs.current[tabKey]

    if (activeTabButton && tabsContainerRef.current) {
      // Use scrollIntoView with smooth behavior and inline: 'center' to center the tab in view
      activeTabButton.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      })
    }
  }, [activeTabIndex, selectedFile, viewMode])

  const handleOpenPR = () => {
    if (prUrl) {
      // If PR already exists, show merge dialog
      handleOpenMergeDialog()
    } else {
      // Otherwise, show the create PR dialog
      setShowPRDialog(true)
    }
  }

  const handlePRCreated = (newPrUrl: string, newPrNumber: number) => {
    setPrUrl(newPrUrl)
    setPrNumber(newPrNumber)
    setPrStatus('open')
    refreshTasks()
  }

  const handlePRMerged = () => {
    console.log('[Merge] PR merged successfully')
    // Don't update prStatus here - let it come from task refresh
    refreshTasks()
    // Keep loading state - will be cleared by useEffect when status changes
  }

  const handleOpenMergeDialog = () => {
    // Don't set loading state yet - wait for user confirmation
    setShowMergePRDialog(true)
  }

  const handleMergeDialogClose = (open: boolean) => {
    setShowMergePRDialog(open)
    if (!open && !isMergingPR) {
      // Dialog closed without merging
      console.log('[Merge] Dialog closed without merge')
    }
  }

  const handleMergeInitiated = () => {
    // User confirmed merge - now show loading state
    console.log('[Merge] User confirmed merge - setting loading state')
    setIsMergingPR(true)
  }

  const handleReopenPR = async () => {
    if (!prNumber || !task.repoUrl || isReopeningPR) return

    setIsReopeningPR(true)
    console.log('[Reopen] Starting reopen - isReopeningPR:', true, 'prStatus:', prStatus)
    try {
      const response = await fetch(`/api/tasks/${task.id}/reopen-pr`, {
        method: 'POST',
      })

      if (response.ok) {
        console.log('[Reopen] API success - keeping loading state active')
        // Don't show toast yet - wait for UI to update
        await refreshTasks()
      } else {
        const error = await response.json()
        toast.error(error.error || 'Failed to reopen pull request')
        setIsReopeningPR(false)
      }
    } catch (error) {
      console.error('Error reopening pull request:', error)
      toast.error('Failed to reopen pull request')
      setIsReopeningPR(false)
    }
  }

  const handleClosePR = async () => {
    if (!prNumber || !task.repoUrl || isClosingPR) return

    setIsClosingPR(true)
    console.log('[Close] Starting close - isClosingPR:', true, 'prStatus:', prStatus)
    try {
      const response = await fetch(`/api/tasks/${task.id}/close-pr`, {
        method: 'POST',
      })

      if (response.ok) {
        console.log('[Close] API success - keeping loading state active')
        // Don't show toast yet - wait for UI to update
        await refreshTasks()
      } else {
        const error = await response.json()
        toast.error(error.error || 'Failed to close pull request')
        setIsClosingPR(false)
      }
    } catch (error) {
      console.error('Error closing pull request:', error)
      toast.error('Failed to close pull request')
      setIsClosingPR(false)
    }
  }

  const handleTryAgain = async () => {
    setIsTryingAgain(true)
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: task.prompt,
          repoUrl: task.repoUrl,
          selectedAgent,
          selectedModel,
          installDependencies: tryAgainInstallDeps,
          maxDuration: tryAgainMaxDuration,
          keepAlive: tryAgainKeepAlive,
          enableBrowser: tryAgainEnableBrowser,
        }),
      })

      if (response.ok) {
        const result = await response.json()
        toast.success('新任务创建成功！')
        setShowTryAgainDialog(false)
        navigate(`/tasks/${result.task.id}`)
      } else {
        const error = await response.json()
        toast.error(error.error || '创建新任务失败')
      }
    } catch (error) {
      console.error('Error creating new task:', error)
      toast.error('创建新任务失败')
    } finally {
      setIsTryingAgain(false)
    }
  }

  const handleLinkRepo = useCallback(async () => {
    if (!linkRepoUrl.trim() || !linkBranchName.trim()) {
      toast.error('请输入仓库 URL 和分支名称')
      return
    }
    setIsLinkingRepo(true)
    try {
      const response = await fetch(`/api/tasks/${task.id}/git/associate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: linkRepoUrl.trim(), branchName: linkBranchName.trim() }),
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || '链接仓库失败')

      toast.success('仓库链接成功')
      setShowLinkRepoDialog(false)
      setLinkRepoUrl('')
      setLinkBranchName('')
      setPersonalGitInfo({ repoUrl: linkRepoUrl.trim(), branchName: linkBranchName.trim() })
      setRefreshKey((prev) => prev + 1)
      refreshTasks()
    } catch (err) {
      console.error('Error linking repository:', err)
      toast.error('链接仓库失败')
    } finally {
      setIsLinkingRepo(false)
    }
  }, [linkRepoUrl, linkBranchName, task.id, refreshTasks])

  const handleUnlinkRepo = useCallback(async () => {
    setIsUnlinkingRepo(true)
    try {
      const response = await fetch(`/api/tasks/${task.id}/git/disassociate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(result.error || '取消链接仓库失败')

      toast.success('仓库取消链接成功')
      setShowUnlinkRepoDialog(false)
      setPersonalGitInfo(null)
      setRefreshKey((prev) => prev + 1)
      refreshTasks()
    } catch (err) {
      console.error('Error unlinking repository:', err)
      toast.error('取消链接仓库失败')
    } finally {
      setIsUnlinkingRepo(false)
    }
  }, [task.id, refreshTasks])

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        toast.success('任务删除成功！')
        refreshTasks() // Refresh the sidebar
        navigate('/')
      } else {
        const error = await response.json()
        toast.error(error.error || '删除任务失败')
      }
    } catch (error) {
      console.error('Error deleting task:', error)
      toast.error('删除任务失败')
    } finally {
      setIsDeleting(false)
      setShowDeleteDialog(false)
    }
  }

  const handleRestartDevServer = async () => {
    setIsRestartingDevServer(true)
    try {
      const response = await fetch(`/api/tasks/${task.id}/restart-dev`, {
        method: 'POST',
      })

      if (response.ok) {
        toast.success('开发服务重启成功！')
        // 刷新预览以允许服务器启动
        setTimeout(() => {
          setPreviewKey((prev) => prev + 1)
        }, 2000)
      } else {
        const error = await response.json()
        toast.error(error.error || '重启开发服务失败')
      }
    } catch (error) {
      console.error('Error restarting dev server:', error)
      toast.error('重启开发服务失败')
    } finally {
      setIsRestartingDevServer(false)
    }
  }

  const handleStopSandbox = async () => {
    setIsStoppingSandbox(true)
    try {
      const response = await fetch(`/api/tasks/${task.id}/stop-sandbox`, {
        method: 'POST',
      })

      if (response.ok) {
        toast.success('沙箱停止成功！')
        // 刷新任务以更新 UI
        await refreshTasks()
      } else {
        const error = await response.json()
        toast.error(error.error || '停止沙箱失败')
      }
    } catch (error) {
      console.error('Error stopping sandbox:', error)
      toast.error('停止沙箱失败')
    } finally {
      setIsStoppingSandbox(false)
    }
  }

  const handleStartSandbox = async () => {
    setIsStartingSandbox(true)
    try {
      const response = await fetch(`/api/tasks/${task.id}/start-sandbox`, {
        method: 'POST',
      })

      if (response.ok) {
        toast.success('沙箱启动成功！')
        // 刷新任务以更新 UI
        await refreshTasks()
      } else {
        const error = await response.json()
        toast.error(error.error || '启动沙箱失败')
      }
    } catch (error) {
      console.error('Error starting sandbox:', error)
      toast.error('启动沙箱失败')
    } finally {
      setIsStartingSandbox(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Overview Section */}
      <div className="space-y-2 md:space-y-3 py-2 md:py-3 border-b px-3 flex-shrink-0">
        {/* Prompt */}
        <div className="flex items-center gap-2">
          {currentStatus === 'processing' ? (
            <Loader2 className="h-4 w-4 md:h-5 md:w-5 animate-spin text-muted-foreground" />
          ) : (
            prStatus && <PRStatusIcon status={prStatus} className="h-4 w-4 md:h-5 md:w-5" />
          )}
          <p className="text-lg md:text-2xl flex-1 truncate">{task.title || task.prompt}</p>
          {currentStatus === 'completed' && task.repoUrl && task.branchName && (
            <>
              {!prUrl && prStatus !== 'merged' && prStatus !== 'closed' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenPR}
                  className="h-7 md:h-8 px-2 md:px-3 flex-shrink-0"
                  title="Create PR"
                >
                  <GitPullRequest className="h-3.5 w-3.5 md:h-4 md:w-4 mr-1.5" />
                  <span className="text-xs md:text-sm">打开 PR</span>
                </Button>
              )}
              {prUrl &&
                (prStatus === 'open' || isClosingPR || isMergingPR) &&
                prStatus !== 'closed' &&
                !isReopeningPR &&
                (() => {
                  console.log(
                    '[Render] Merge button - prStatus:',
                    prStatus,
                    'isClosingPR:',
                    isClosingPR,
                    'isMergingPR:',
                    isMergingPR,
                    'showMergePRDialog:',
                    showMergePRDialog,
                    'isReopeningPR:',
                    isReopeningPR,
                  )
                  return true
                })() && (
                  <div className="flex items-center gap-0 flex-shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleOpenPR}
                      disabled={isClosingPR || isMergingPR}
                      className="h-7 md:h-8 px-2 md:px-3 rounded-r-none border-r-0"
                    >
                      {isClosingPR ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 md:h-4 md:w-4 mr-1.5 animate-spin" />
                          <span className="text-xs md:text-sm">正在关闭...</span>
                        </>
                      ) : isMergingPR ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 md:h-4 md:w-4 mr-1.5 animate-spin" />
                          <span className="text-xs md:text-sm">正在合并...</span>
                        </>
                      ) : (
                        <>
                          <GitPullRequest className="h-3.5 w-3.5 md:h-4 md:w-4 mr-1.5" />
                          <span className="text-xs md:text-sm">合并 PR</span>
                        </>
                      )}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isClosingPR || isMergingPR}
                          className="h-7 md:h-8 px-1.5 rounded-l-none"
                        >
                          <ChevronDown className="h-3.5 w-3.5 md:h-4 md:w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={handleClosePR} disabled={isClosingPR || isMergingPR}>
                          <XCircle className="h-4 w-4 mr-2" />
                          关闭 PR
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              {(prStatus === 'closed' || isReopeningPR) &&
                prUrl &&
                prNumber &&
                prStatus !== 'open' &&
                (() => {
                  console.log('[Render] Reopen button - prStatus:', prStatus, 'isReopeningPR:', isReopeningPR)
                  return true
                })() && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleReopenPR()}
                    disabled={isReopeningPR}
                    className="h-7 md:h-8 px-2 md:px-3 flex-shrink-0"
                    title="重新打开 PR"
                  >
                    {isReopeningPR ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 md:h-4 md:w-4 mr-1.5 animate-spin" />
                        <span className="text-xs md:text-sm">正在重新打开...</span>
                      </>
                    ) : (
                      <>
                        <GitPullRequest className="h-3.5 w-3.5 md:h-4 md:w-4 mr-1.5" />
                        <span className="text-xs md:text-sm">重新打开 PR</span>
                      </>
                    )}
                  </Button>
                )}
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 md:h-8 md:w-8 p-0 flex-shrink-0" title="更多选项">
                <MoreVertical className="h-3.5 w-3.5 md:h-4 md:w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  // Extract owner and repo from repoUrl
                  const repoUrl = task.repoUrl || ''
                  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/)
                  const owner = match?.[1] || ''
                  const repo = match?.[2] || ''

                  // Build the URL with query parameters
                  const params = new URLSearchParams()
                  if (owner) params.set('owner', owner)
                  if (repo) params.set('repo', repo)
                  if (task.selectedAgent) params.set('agent', task.selectedAgent)
                  if (task.selectedModel) params.set('model', task.selectedModel)

                  navigate(`/?${params.toString()}`)
                }}
              >
                <Plus className="h-4 w-4 mr-2" />
                新任务
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setShowTryAgainDialog(true)
                  // 打开时动态加载 runtimes，保持和新建任务一致
                  fetch('/api/agent/runtimes')
                    .then((r) => r.json())
                    .then(
                      (data: {
                        default: string
                        runtimes: Array<{
                          name: string
                          available: boolean
                          models: Array<{ id: string; name: string }>
                        }>
                      }) => {
                        const newAgentModels: Record<string, Array<{ id: string; name: string }>> = {}
                        const unavailable = new Set<string>()
                        for (const rt of data.runtimes) {
                          if (!rt.available) {
                            for (const agent of CODING_AGENTS) {
                              if ((agent as { runtime?: string }).runtime === rt.name) unavailable.add(agent.value)
                            }
                          } else if (rt.models.length > 0) {
                            for (const agent of CODING_AGENTS) {
                              if ((agent as { runtime?: string }).runtime === rt.name)
                                newAgentModels[agent.value] = rt.models
                            }
                          }
                        }
                        setTryAgainAgentModels(newAgentModels)
                        setTryAgainUnavailableAgents(unavailable)
                        // 校正当前选中的 agent/model
                        const currentAgent = task.selectedAgent || 'codebuddy'
                        const models = newAgentModels[currentAgent] ?? []
                        if (models.length > 0 && !models.some((m) => m.id === selectedModel)) {
                          setSelectedModel(models[0].id)
                        }
                      },
                    )
                    .catch(() => {})
                }}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                重试
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  let defaultRepoUrl = task.repoUrl || ''
                  let defaultBranchName = task.branchName || ''
                  try {
                    const res = await fetch(`/api/tasks/${task.id}`)
                    const data = await res.json()
                    if (data.task?.personalGitInfo) {
                      const info = JSON.parse(data.task.personalGitInfo)
                      defaultRepoUrl = info.repoUrl || ''
                      defaultBranchName = info.branchName || ''
                    }
                  } catch {
                    // ignore, fallback to props
                  }
                  setLinkRepoUrl(defaultRepoUrl)
                  setLinkBranchName(defaultBranchName)
                  setShowLinkRepoDialog(true)
                }}
              >
                <GitBranch className="h-4 w-4 mr-2" />
                关联 Git 仓库
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowDeleteDialog(true)} className="text-red-600">
                <Trash2 className="h-4 w-4 mr-2" />
                删除任务
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Compact info row */}
        <div className="flex items-center gap-2 md:gap-4 md:flex-wrap text-xs md:text-sm overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {/* Branch */}
          {task.branchName && (
            <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">
              <GitBranch className="h-3.5 w-3.5 md:h-4 md:w-4 flex-shrink-0 text-muted-foreground" />
              {task.repoUrl ? (
                <a
                  href={`${task.repoUrl.replace(/\.git$/, '')}/tree/${task.branchName}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground whitespace-nowrap"
                >
                  {task.branchName}
                </a>
              ) : (
                <span className="text-muted-foreground whitespace-nowrap">{task.branchName}</span>
              )}
            </div>
          )}

          {/* Pull Request */}
          {prUrl && prNumber && (
            <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">
              {prStatus === 'merged' ? (
                <svg
                  className="h-3.5 w-3.5 md:h-4 md:w-4 flex-shrink-0 text-purple-500"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M5 3.254V3.25v.005a.75.75 0 110-.005v.004zm.45 1.9a2.25 2.25 0 10-1.95.218v5.256a2.25 2.25 0 101.5 0V7.123A5.735 5.735 0 009.25 9h1.378a2.251 2.251 0 100-1.5H9.25a4.25 4.25 0 01-3.8-2.346zM12.75 9a.75.75 0 100-1.5.75.75 0 000 1.5zm-8.5 4.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
                </svg>
              ) : prStatus === 'closed' ? (
                <GitPullRequest className="h-3.5 w-3.5 md:h-4 md:w-4 flex-shrink-0 text-red-500" />
              ) : (
                <svg
                  className="h-3.5 w-3.5 md:h-4 md:w-4 flex-shrink-0 text-green-500"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zm5.677-.177L9.573.677A.25.25 0 0110 .854V2.5h1A2.5 2.5 0 0113.5 5v5.628a2.251 2.251 0 11-1.5 0V5a1 1 0 00-1-1h-1v1.646a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm0 9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm8.25.75a.75.75 0 101.5 0 .75.75 0 00-1.5 0z" />
                </svg>
              )}
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground whitespace-nowrap"
              >
                #{prNumber}
              </a>
            </div>
          )}

          {/* Agent */}
          {(task.selectedAgent || task.selectedModel) && (
            <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">
              {task.selectedAgent &&
                (() => {
                  const AgentLogo = getAgentLogo(task.selectedAgent)
                  return AgentLogo ? <AgentLogo className="w-3.5 h-3.5 md:w-4 md:h-4 flex-shrink-0" /> : null
                })()}
              {task.selectedModel && (
                <span className="text-muted-foreground whitespace-nowrap">
                  {getModelName(task.selectedModel, task.selectedAgent)}
                </span>
              )}
            </div>
          )}

          {/* MCP Servers */}
          {!loadingMcpServers && (
            <button
              type="button"
              onClick={() => setShowTaskMcpDialog(true)}
              className="flex items-center gap-1.5 md:gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Cable className="h-3.5 w-3.5 md:h-4 md:w-4 flex-shrink-0" />
              <span className="hidden sm:inline">
                {mcpServers.length} MCP Server{mcpServers.length !== 1 ? 's' : ''}
              </span>
              <span className="sm:hidden">{mcpServers.length} MCP</span>
            </button>
          )}

          {/* TODO: OpenCode 运行时暂不支持 skill 管理，等待 OpenCode 的升级 */}
          {task.selectedAgent !== 'opencode' && (
            <button
              type="button"
              onClick={() => {
                setShowSkillsDialog(true)
                if (!skillsLoaded || skillsList.length === 0) fetchSkills()
                if (userSkillsList.length === 0) fetchUserSkills()
              }}
              className="flex items-center gap-1.5 md:gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Zap className="h-3.5 w-3.5 md:h-4 md:w-4 flex-shrink-0" />
              <span className="hidden sm:inline">Skills</span>
            </button>
          )}

          {/* Desktop Pane Toggles - Only show on desktop */}
          <div className="hidden md:flex items-center gap-1 ml-auto">
            {hasFilesSupport && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Files 和 Preview/Cloud 互斥
                  if (showPreviewPane) {
                    setShowPreviewPane(false)
                    saveShowPreviewPane(false)
                  }
                  setShowCloudPane(false)
                  const newValue = !showFilesPane
                  setShowFilesPane(newValue)
                  saveShowFilesPane(newValue)
                }}
                className={cn(
                  'h-7 px-3 text-xs font-medium transition-colors',
                  showFilesPane && !showPreviewPane && !showCloudPane
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                )}
              >
                文件
              </Button>
            )}
            {/* Preview 按钮(仅 coding mode 显示) */}
            {isCodingMode && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Preview 和 Files/Cloud 互斥
                  if (!showPreviewPane) {
                    setShowFilesPane(false)
                    saveShowFilesPane(false)
                  }
                  setShowCloudPane(false)
                  const newValue = !showPreviewPane
                  setShowPreviewPane(newValue)
                  saveShowPreviewPane(newValue)
                }}
                className={cn(
                  'h-7 px-3 text-xs font-medium transition-colors',
                  showPreviewPane
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                )}
              >
                预览
              </Button>
            )}
            {/* Cloud 按钮 */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // Cloud 和 Files/Preview 互斥
                if (showFilesPane) {
                  setShowFilesPane(false)
                  saveShowFilesPane(false)
                }
                if (showPreviewPane) {
                  setShowPreviewPane(false)
                  saveShowPreviewPane(false)
                }
                setShowCloudPane(!showCloudPane)
              }}
              className={cn(
                'h-7 px-3 text-xs font-medium transition-colors',
                showCloudPane
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              云资源
            </Button>
            {/* Code pane toggle (注释保留以供将来恢复) */}
            {/* <Button variant="ghost" size="sm" ... Code </Button> */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const newValue = !showChatPane
                setShowChatPane(newValue)
                saveShowChatPane(newValue)
              }}
              className={cn(
                'h-7 px-3 text-xs font-medium transition-colors',
                showChatPane
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              Chat
            </Button>
          </div>
        </div>
      </div>

      {/* Changes Section - Show when a branch or sandbox exists */}
      {hasFilesSupport ? (
        <>
          {/* Desktop Layout */}
          <div ref={containerRef} className="hidden md:flex flex-1 min-h-0 overflow-hidden">
            {/* File Browser - Always rendered but hidden with CSS to ensure files are loaded */}
            <div
              className={cn('h-full overflow-y-auto flex-shrink-0', !showFilesPane && 'hidden')}
              style={{ width: showFilesPane ? `${filesPaneWidth}px` : 0 }}
            >
              <FileBrowser
                taskId={task.id}
                branchName={task.branchName}
                repoUrl={task.repoUrl}
                sandboxId={task.sandboxId}
                onFileSelect={openFileInTab}
                onFilesLoaded={fetchAllDiffs}
                selectedFile={selectedFile}
                refreshKey={refreshKey}
                viewMode={viewMode}
                onViewModeChange={handleViewModeChange}
              />
            </div>

            {/* Resize Handle - Files/Code */}
            {showFilesPane && showCodePane && (
              <div
                className="w-3 cursor-col-resize flex-shrink-0 relative group"
                onMouseDown={() => setResizingPane('files')}
              >
                <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            )}

            {/* Code Viewer - show when branch exists OR a file is selected with Files pane open */}
            {showCodeViewer ? (
              <div className="flex-1 min-h-0 min-w-0">
                <div className="overflow-hidden h-full flex flex-col">
                  {/* Tabs and Search Bar */}
                  <div className="flex flex-col border-b flex-shrink-0">
                    {/* Tabs Row */}
                    {openTabs.length > 0 && (viewMode === 'all' || viewMode === 'all-local') && (
                      <div
                        ref={tabsContainerRef}
                        className="flex items-center gap-0 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] border-b"
                      >
                        {openTabs.map((filename, index) => {
                          const hasUnsavedChanges = tabsWithUnsavedChanges.has(filename)
                          const isSaving = tabsSaving.has(filename)
                          const tabKey = `${viewMode}-${index}`
                          return (
                            <button
                              key={filename}
                              ref={(el) => {
                                tabButtonRefs.current[tabKey] = el
                              }}
                              onClick={() => switchToTab(index)}
                              className={cn(
                                'group flex items-center gap-2 px-3 py-2 text-sm border-r transition-colors flex-shrink-0 max-w-[240px]',
                                activeTabIndex === index
                                  ? 'bg-background text-foreground'
                                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                              )}
                            >
                              <FileText className="h-3.5 w-3.5 flex-shrink-0" />
                              <span className="truncate flex-1">{filename.split('/').pop()}</span>
                              <span
                                onClick={(e) => attemptCloseTab(index, e)}
                                className={cn(
                                  'flex items-center justify-center w-4 h-4 rounded transition-all cursor-pointer hover:bg-accent flex-shrink-0',
                                  hasUnsavedChanges || isSaving ? '' : 'opacity-0 group-hover:opacity-100',
                                )}
                                title={
                                  isSaving
                                    ? 'Saving...'
                                    : hasUnsavedChanges
                                      ? 'Unsaved changes • Click to close'
                                      : 'Close tab'
                                }
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    attemptCloseTab(index)
                                  }
                                }}
                              >
                                {isSaving ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : hasUnsavedChanges ? (
                                  <>
                                    <span className="w-2 h-2 rounded-full bg-foreground group-hover:hidden" />
                                    <X className="h-3 w-3 hidden group-hover:block" />
                                  </>
                                ) : (
                                  <X className="h-3 w-3" />
                                )}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {/* Search Bar */}
                    <div ref={fileSearchRef} className="relative flex items-center gap-2 px-3 h-[46px]">
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <input
                        type="text"
                        value={fileSearchQuery}
                        onChange={(e) => {
                          setFileSearchQuery(e.target.value)
                          setShowFileDropdown(true)
                        }}
                        onFocus={() => setShowFileDropdown(true)}
                        placeholder="Type to search files..."
                        className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                      />

                      {/* Dropdown */}
                      {showFileDropdown &&
                        (() => {
                          const query = fileSearchQuery.toLowerCase()
                          const filteredFiles = allFiles
                            .filter((file) => file.toLowerCase().includes(query))
                            .slice(0, 50)

                          if (filteredFiles.length === 0) return null

                          return (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-md max-h-[300px] overflow-y-auto z-50">
                              {filteredFiles.map((file) => (
                                <button
                                  key={file}
                                  onClick={() => {
                                    openFileInTab(file)
                                    setFileSearchQuery('')
                                    setShowFileDropdown(false)
                                  }}
                                  className={cn(
                                    'w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors',
                                    selectedFile === file && 'bg-accent',
                                  )}
                                >
                                  {file}
                                </button>
                              ))}
                            </div>
                          )
                        })()}
                    </div>
                  </div>

                  <div className="overflow-y-auto flex-1">
                    <FileDiffViewer
                      selectedFile={selectedItemIsFolder ? undefined : selectedFile}
                      diffsCache={diffsCache}
                      isInitialLoading={Object.keys(diffsCache).length === 0}
                      viewMode={viewMode}
                      taskId={task.id}
                      onUnsavedChanges={
                        selectedFile ? (hasChanges) => handleUnsavedChanges(selectedFile, hasChanges) : undefined
                      }
                      onSavingStateChange={
                        selectedFile ? (isSaving) => handleSavingStateChange(selectedFile, isSaving) : undefined
                      }
                      onOpenFile={(filename, lineNumber) => {
                        openFileInTab(filename)
                        // TODO: Optionally scroll to lineNumber after opening
                      }}
                      onSaveSuccess={handleSaveSuccess}
                      onFileLoaded={handleFileLoaded}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {/* Resize Handle - Code/Preview/Cloud */}
            {(showPreviewPane || showCloudPane) && (showCodeViewer || showFilesPane) && (
              <div className="w-3 cursor-col-resize flex-shrink-0 relative group">
                <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            )}

            {/* Preview */}
            {showPreviewPane && (
              <div className={cn('flex-1 min-h-0 min-w-0', isPreviewFullscreen && 'fixed inset-0 z-50 bg-background')}>
                {/* ── Coding mode: gateway URL 驱动的预览(P6+) ── */}
                {isCodingMode ? (
                  <div className="overflow-hidden h-full flex flex-col">
                    {/* 工具栏:BrowserControls + 刷新 + 全屏 */}
                    <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/20 px-2">
                      <BrowserControls
                        previewUrl={previewGatewayUrl || 'http://localhost:5173'}
                        bridge={previewBridge}
                        onHardRefresh={() => {
                          setPreviewKey((k) => k + 1)
                        }}
                        loading={previewGatewayLoading}
                        currentPath={previewCurrentPath}
                        hmrStatus={previewBridge.hmrStatus}
                        className="flex-1 min-w-0"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (previewGatewayUrl) window.open(previewGatewayUrl, '_blank')
                        }}
                        className="h-6 w-6 p-0 flex-shrink-0"
                        title="Open in new window"
                        disabled={!previewGatewayUrl}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          if (checkingErrors) return
                          setCheckingErrors(true)
                          try {
                            const res = await fetch(`/api/tasks/${task.id}/preview-errors`)
                            if (!res.ok) {
                              toast.error('Failed to check errors')
                              return
                            }
                            const data = (await res.json()) as {
                              ok?: boolean
                              buildErrors?: Array<{
                                source?: string
                                file?: string
                                message?: string
                                stack?: string
                              }>
                              runtimeErrors?: Array<{
                                source?: string
                                message?: string
                                stack?: string
                                componentStack?: string
                              }>
                            }
                            const buildErrs = data.buildErrors ?? []
                            const runtimeErrs = data.runtimeErrors ?? []
                            if (buildErrs.length === 0 && runtimeErrs.length === 0) {
                              toast.success('No errors found')
                              return
                            }
                            const summary = [
                              ...buildErrs.map(
                                (e) => `[build:${e.source || 'vite'}] ${e.file ? e.file + ': ' : ''}${e.message || ''}`,
                              ),
                              ...runtimeErrs.map((e) => `[runtime:${e.source || 'unknown'}] ${e.message || ''}`),
                            ].join('\n---\n')
                            const detail = runtimeErrs
                              .map((e) => [e.stack, e.componentStack].filter(Boolean).join('\n'))
                              .filter(Boolean)
                              .join('\n---\n')
                            const prompt = [
                              '预览页面有错误，请修复：',
                              '',
                              summary,
                              ...(detail ? ['', detail] : []),
                            ].join('\n')
                            // 手动点击视为用户发起，重置 auto-fix 计数
                            autoFix.notifyUserSend()
                            await chatStream.sendMessage(prompt, () => {})
                          } catch {
                            toast.error('Failed to check errors')
                          } finally {
                            setCheckingErrors(false)
                          }
                        }}
                        className="h-6 w-6 p-0 flex-shrink-0"
                        title="Fix preview errors"
                        disabled={!previewGatewayUrl || checkingErrors}
                      >
                        {checkingErrors ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <AlertTriangle className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsPreviewFullscreen(!isPreviewFullscreen)}
                        className="h-6 w-6 p-0 flex-shrink-0 ml-1"
                        title={isPreviewFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                      >
                        {isPreviewFullscreen ? (
                          <Minimize className="h-3.5 w-3.5" />
                        ) : (
                          <Maximize className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                    {/* 内容区 */}
                    <div className="relative flex-1 min-h-0">
                      {/* 项目未初始化：等 agent 完成 initCodingProject + startDevServer */}
                      {!task.previewUrl && !previewGatewayLoading && !previewGatewayUrl && !previewGatewayError && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground text-center">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            <span>AI 正在初始化项目，请稍候...</span>
                          </div>
                        </div>
                      )}
                      {/* Loading 状态：实时显示后端推送的进度 */}
                      {previewGatewayLoading && (
                        <>
                          <PreviewPlaceholder />
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground bg-background/80 backdrop-blur rounded-md px-4 py-3 shadow text-center">
                              <div className="flex items-center gap-2">
                                <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                                <span>{previewLoadingMessage}</span>
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                      {/* Error 状态 */}
                      {previewGatewayError && !previewGatewayLoading && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
                          <AlertCircle className="h-8 w-8 text-destructive/60" />
                          <p className="text-sm text-destructive max-w-[280px]">{previewGatewayError}</p>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              loadPreviewGatewayUrl()
                            }}
                          >
                            重试
                          </Button>
                        </div>
                      )}
                      {/* iframe：后端已确认 dev server 就绪才返回 URL，拿到即可渲染 */}
                      {previewGatewayUrl && !previewGatewayLoading && (
                        <>
                          {/* HMR 更新进度条 */}
                          {hmrUpdating && (
                            <div className="absolute top-0 left-0 right-0 z-30 h-0.5 bg-primary/20 overflow-hidden">
                              <div className="h-full bg-primary animate-pulse w-full" />
                            </div>
                          )}
                          {/* HMR 断连警告 banner */}
                          {previewBridge.hmrStatus === 'disconnected' && iframeLoaded && (
                            <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between gap-2 bg-amber-50 dark:bg-amber-950/80 border-b border-amber-200 dark:border-amber-800 px-3 py-1.5">
                              <span className="text-xs text-amber-700 dark:text-amber-300">
                                热重载已断开，页面无法继续更新
                              </span>
                              <button
                                type="button"
                                onClick={() => setPreviewKey((k) => k + 1)}
                                className="text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 underline underline-offset-2 flex-shrink-0"
                              >
                                刷新预览
                              </button>
                            </div>
                          )}
                          {/* Build error banner */}
                          {previewBuildError && iframeLoaded && (
                            <div className="absolute top-0 left-0 right-0 z-20 flex items-center gap-2 bg-destructive/10 border-b border-destructive/20 px-3 py-1.5">
                              <AlertCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
                              <span className="text-xs text-destructive truncate">{previewBuildError}</span>
                            </div>
                          )}
                          {/* 加载遮罩（等待 iframe onLoad / preview:ready） */}
                          {!iframeLoaded && (
                            <div className="absolute inset-0 z-10">
                              <PreviewPlaceholder />
                              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
                              </div>
                            </div>
                          )}
                          <iframe
                            key={previewKey}
                            ref={previewIframeRef}
                            src={previewGatewayUrl}
                            className={cn(
                              'w-full h-full border-0 transition-opacity duration-300',
                              iframeLoaded ? 'opacity-100' : 'opacity-0',
                            )}
                            title="Project Preview"
                            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                            onLoad={() => setIframeLoaded(true)}
                          />
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  /* ── 非 coding mode: 旧式 sandboxUrl 预览 ── */
                  <div className="overflow-hidden h-full flex flex-col">
                    {/* Preview Toolbar */}
                    <div className="flex items-center gap-2 px-3 border-b flex-shrink-0 h-[46px]">
                      <Monitor className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      {task.sandboxUrl && sandboxHealth !== 'stopped' ? (
                        <a
                          href={task.sandboxUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-muted-foreground hover:text-foreground truncate flex-1 transition-colors"
                          title={task.sandboxUrl}
                        >
                          {task.sandboxUrl}
                        </a>
                      ) : (
                        <span className="text-sm text-muted-foreground truncate flex-1">
                          {sandboxHealth === 'stopped'
                            ? 'Sandbox stopped'
                            : currentStatus === 'pending' || currentStatus === 'processing'
                              ? 'Creating sandbox...'
                              : 'Sandbox not running'}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPreviewKey((prev) => prev + 1)}
                        className="h-6 w-6 p-0 flex-shrink-0"
                        title="Refresh Preview"
                        disabled={!task.sandboxUrl}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsPreviewFullscreen(!isPreviewFullscreen)}
                        className="h-6 w-6 p-0 flex-shrink-0"
                        title={isPreviewFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                      >
                        {isPreviewFullscreen ? (
                          <Minimize className="h-3.5 w-3.5" />
                        ) : (
                          <Maximize className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 flex-shrink-0"
                            disabled={isRestartingDevServer || isStoppingSandbox || isStartingSandbox}
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {task.sandboxUrl && (
                            <>
                              <DropdownMenuItem onClick={() => window.open(task.sandboxUrl!, '_blank')}>
                                Open in New Tab
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => {
                                  navigator.clipboard.writeText(task.sandboxUrl!)
                                }}
                              >
                                Copy URL
                              </DropdownMenuItem>
                            </>
                          )}
                          {task.keepAlive && (
                            <>
                              {task.sandboxUrl && <DropdownMenuSeparator />}
                              {sandboxHealth === 'stopped' || !task.sandboxUrl ? (
                                <DropdownMenuItem onClick={handleStartSandbox} disabled={isStartingSandbox}>
                                  {isStartingSandbox ? (
                                    <>
                                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                      Starting...
                                    </>
                                  ) : (
                                    'Start Sandbox'
                                  )}
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onClick={handleStopSandbox} disabled={isStoppingSandbox}>
                                  {isStoppingSandbox ? (
                                    <>
                                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                      Stopping...
                                    </>
                                  ) : (
                                    'Stop Sandbox'
                                  )}
                                </DropdownMenuItem>
                              )}
                            </>
                          )}
                          {sandboxHealth === 'running' && (
                            <>
                              {(task.sandboxUrl || task.keepAlive) && <DropdownMenuSeparator />}
                              <DropdownMenuItem onClick={handleRestartDevServer} disabled={isRestartingDevServer}>
                                {isRestartingDevServer ? (
                                  <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    Restarting...
                                  </>
                                ) : (
                                  'Restart Dev Server'
                                )}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="overflow-y-auto flex-1">
                      {task.sandboxUrl ? (
                        <div className="relative w-full h-full">
                          {sandboxHealth === 'running' ? (
                            <iframe
                              key={previewKey}
                              src={task.sandboxUrl}
                              className="w-full h-full border-0"
                              title="Preview"
                              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                            />
                          ) : null}
                          {sandboxHealth === 'starting' && (
                            <div className="absolute inset-0 bg-background flex items-center justify-center">
                              <div className="text-center">
                                <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground">Starting dev server...</p>
                              </div>
                            </div>
                          )}
                          {sandboxHealth === 'stopped' && (
                            <div className="absolute inset-0 bg-background flex items-center justify-center">
                              <div className="text-center">
                                <StopCircle className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground mb-1">Sandbox Stopped</p>
                                <p className="text-xs text-muted-foreground">Start a new sandbox from the menu above</p>
                              </div>
                            </div>
                          )}
                          {sandboxHealth === 'error' && (
                            <div className="absolute inset-0 bg-background flex items-center justify-center">
                              <div className="text-center">
                                <AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
                                <p className="text-sm text-muted-foreground mb-1">Application Error</p>
                                <p className="text-xs text-muted-foreground">The dev server encountered an error</p>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-6 text-center">
                          <div>
                            {currentStatus === 'pending' || currentStatus === 'processing' ? (
                              <>
                                <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-muted-foreground" />
                                <p className="mb-1">Creating sandbox...</p>
                                <p className="text-xs">The preview will appear here once the dev server starts</p>
                              </>
                            ) : (
                              <>
                                <p className="mb-1">Sandbox not running</p>
                                <p className="text-xs">
                                  {task.keepAlive
                                    ? 'Start it from the menu above to view the preview'
                                    : 'This task does not have keep-alive enabled'}
                                </p>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Cloud Dashboard */}
            {showCloudPane && sessionEnvId && (
              <div className="flex-1 min-h-0 min-w-0">
                <CloudDashboard
                  envId={sessionEnvId}
                  taskId={task.id}
                  theme={dashboardTheme}
                  style={{ height: '100%' }}
                />
              </div>
            )}

            {/* Resize Handle - Preview/Chat or Code/Chat */}
            {showChatPane && (showPreviewPane || showCodeViewer || showFilesPane || showCloudPane) && (
              <div
                className="w-3 cursor-col-resize flex-shrink-0 relative group"
                onMouseDown={() => setResizingPane('chat')}
              >
                <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            )}

            {/* Chat */}
            {showChatPane && (
              <div
                className={cn('min-h-0', hasMiddlePane ? 'flex-shrink-0' : 'flex-1 min-w-0')}
                style={hasMiddlePane ? { width: `${chatPaneWidth}px` } : undefined}
              >
                <TaskChat
                  key={task.id}
                  taskId={task.id}
                  task={task}
                  chatStream={chatStream}
                  onStreamComplete={onStreamComplete}
                  onManualUserSend={autoFix.notifyUserSend}
                  skillsList={skillsList}
                />
              </div>
            )}
          </div>

          {/* Mobile Layout */}
          <div className="md:hidden flex flex-col flex-1 min-h-0 relative pb-14">
            {/* Content Area */}
            <div className="flex-1 overflow-hidden">
              {/* Code Tab */}
              <div className={cn('relative h-full', activeTab !== 'code' && 'hidden')}>
                {/* Current File Path Bar */}
                <div className="px-3 flex items-center gap-2 bg-background border-b h-[46px]">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowFilesList(true)}
                    className="h-6 w-6 p-0 flex-shrink-0"
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                  <span className="text-sm text-muted-foreground truncate flex-1">
                    {selectedFile || 'Select a file'}
                  </span>
                </div>

                {/* Diff Viewer */}
                <div className="overflow-hidden h-[calc(100%-46px)]">
                  <div className="overflow-y-auto h-full">
                    <FileDiffViewer
                      selectedFile={selectedItemIsFolder ? undefined : selectedFile}
                      diffsCache={diffsCache}
                      isInitialLoading={Object.keys(diffsCache).length === 0}
                      viewMode={viewMode}
                      taskId={task.id}
                      onUnsavedChanges={
                        selectedFile ? (hasChanges) => handleUnsavedChanges(selectedFile, hasChanges) : undefined
                      }
                      onSavingStateChange={
                        selectedFile ? (isSaving) => handleSavingStateChange(selectedFile, isSaving) : undefined
                      }
                      onOpenFile={(filename, lineNumber) => {
                        openFileInTab(filename)
                        // TODO: Optionally scroll to lineNumber after opening
                      }}
                      onFileLoaded={handleFileLoaded}
                      onSaveSuccess={handleSaveSuccess}
                    />
                  </div>
                </div>
              </div>

              {/* Chat Tab */}
              <div className={cn('h-full', activeTab !== 'chat' && 'hidden')}>
                <TaskChat
                  key={task.id}
                  taskId={task.id}
                  task={task}
                  chatStream={chatStream}
                  onStreamComplete={onStreamComplete}
                  onManualUserSend={autoFix.notifyUserSend}
                  skillsList={skillsList}
                />
              </div>

              {/* Preview Tab */}
              <div
                className={cn(
                  'h-full',
                  activeTab !== 'preview' && 'hidden',
                  isPreviewFullscreen && 'fixed inset-0 z-50 bg-background',
                )}
              >
                <div className="overflow-hidden h-full flex flex-col">
                  {/* Preview Toolbar */}
                  <div className="flex items-center gap-2 px-3 border-b flex-shrink-0 h-[46px]">
                    <Monitor className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    {task.sandboxUrl ? (
                      <a
                        href={task.sandboxUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-muted-foreground hover:text-foreground truncate flex-1 transition-colors"
                        title={task.sandboxUrl}
                      >
                        {task.sandboxUrl}
                      </a>
                    ) : (
                      <span className="text-sm text-muted-foreground truncate flex-1">
                        {currentStatus === 'pending' || currentStatus === 'processing'
                          ? 'Creating sandbox...'
                          : 'Sandbox not running'}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPreviewKey((prev) => prev + 1)}
                      className="h-6 w-6 p-0 flex-shrink-0"
                      title="Refresh Preview"
                      disabled={!task.sandboxUrl}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsPreviewFullscreen(!isPreviewFullscreen)}
                      className="h-6 w-6 p-0 flex-shrink-0"
                      title={isPreviewFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    >
                      {isPreviewFullscreen ? (
                        <Minimize className="h-3.5 w-3.5" />
                      ) : (
                        <Maximize className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 flex-shrink-0"
                          disabled={isRestartingDevServer || isStoppingSandbox || isStartingSandbox}
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {task.sandboxUrl && (
                          <>
                            <DropdownMenuItem onClick={() => window.open(task.sandboxUrl!, '_blank')}>
                              Open in New Tab
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                navigator.clipboard.writeText(task.sandboxUrl!)
                              }}
                            >
                              Copy URL
                            </DropdownMenuItem>
                          </>
                        )}
                        {task.keepAlive && (
                          <>
                            {task.sandboxUrl && <DropdownMenuSeparator />}
                            {task.sandboxUrl ? (
                              <DropdownMenuItem onClick={handleStopSandbox} disabled={isStoppingSandbox}>
                                {isStoppingSandbox ? (
                                  <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    Stopping...
                                  </>
                                ) : (
                                  'Stop Sandbox'
                                )}
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={handleStartSandbox} disabled={isStartingSandbox}>
                                {isStartingSandbox ? (
                                  <>
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    Starting...
                                  </>
                                ) : (
                                  'Start Sandbox'
                                )}
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                        {task.sandboxUrl && (
                          <>
                            {task.keepAlive && <DropdownMenuSeparator />}
                            <DropdownMenuItem onClick={handleRestartDevServer} disabled={isRestartingDevServer}>
                              {isRestartingDevServer ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  Restarting...
                                </>
                              ) : (
                                'Restart Dev Server'
                              )}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {task.sandboxUrl ? (
                    <div className="overflow-y-auto flex-1 relative">
                      {sandboxHealth === 'running' ? (
                        <iframe
                          key={previewKey}
                          src={task.sandboxUrl}
                          className="w-full h-full border-0"
                          title="Preview"
                          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                        />
                      ) : null}
                      {sandboxHealth === 'starting' && (
                        <div className="absolute inset-0 bg-background flex items-center justify-center">
                          <div className="text-center">
                            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">Starting dev server...</p>
                          </div>
                        </div>
                      )}
                      {sandboxHealth === 'stopped' && (
                        <div className="absolute inset-0 bg-background flex items-center justify-center">
                          <div className="text-center">
                            <StopCircle className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground mb-1">Sandbox Stopped</p>
                            <p className="text-xs text-muted-foreground">Start a new sandbox from the menu above</p>
                          </div>
                        </div>
                      )}
                      {sandboxHealth === 'error' && (
                        <div className="absolute inset-0 bg-background flex items-center justify-center">
                          <div className="text-center">
                            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
                            <p className="text-sm text-muted-foreground mb-1">Application Error</p>
                            <p className="text-xs text-muted-foreground">The dev server encountered an error</p>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm p-6 text-center">
                      <div>
                        {currentStatus === 'pending' || currentStatus === 'processing' ? (
                          <>
                            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-muted-foreground" />
                            <p className="mb-1">Creating sandbox...</p>
                            <p className="text-xs mb-4">The preview will appear here once the dev server starts</p>
                          </>
                        ) : (
                          <>
                            <p className="mb-1">Sandbox not running</p>
                            <p className="text-xs mb-4">
                              {task.keepAlive
                                ? 'Start the sandbox to view the preview'
                                : 'This task does not have keep-alive enabled'}
                            </p>
                          </>
                        )}
                        {task.keepAlive && !task.sandboxUrl && (
                          <Button size="sm" onClick={handleStartSandbox} disabled={isStartingSandbox} className="mt-2">
                            {isStartingSandbox ? (
                              <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Starting...
                              </>
                            ) : (
                              'Start Sandbox'
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Cloud Tab */}
              <div className={cn('h-full', activeTab !== 'cloud' && 'hidden')}>
                {sessionEnvId && (
                  <CloudDashboard
                    envId={sessionEnvId}
                    taskId={task.id}
                    theme={dashboardTheme}
                    style={{ height: '100%' }}
                  />
                )}
              </div>
            </div>

            {/* Bottom Tab Bar */}
            <div className="absolute bottom-0 left-0 right-0 border-t bg-background">
              <div className="flex h-14">
                <button
                  onClick={() => setActiveTab('code')}
                  className={cn(
                    'flex-1 flex flex-col items-center justify-center gap-1 transition-colors',
                    activeTab === 'code' ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  <Code className="h-5 w-5" />
                  <span className="text-xs font-medium">Code</span>
                </button>
                <button
                  onClick={() => setActiveTab('chat')}
                  className={cn(
                    'flex-1 flex flex-col items-center justify-center gap-1 transition-colors',
                    activeTab === 'chat' ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  <MessageSquare className="h-5 w-5" />
                  <span className="text-xs font-medium">Chat</span>
                </button>
                {isCodingMode && (
                  <button
                    onClick={() => setActiveTab('preview')}
                    className={cn(
                      'flex-1 flex flex-col items-center justify-center gap-1 transition-colors',
                      activeTab === 'preview' ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    <Monitor className="h-5 w-5" />
                    <span className="text-xs font-medium">Preview</span>
                  </button>
                )}
                <button
                  onClick={() => setActiveTab('cloud')}
                  className={cn(
                    'flex-1 flex flex-col items-center justify-center gap-1 transition-colors',
                    activeTab === 'cloud' ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  <Cloud className="h-5 w-5" />
                  <span className="text-xs font-medium">Cloud</span>
                </button>
              </div>
            </div>

            {/* Files List Drawer */}
            <Drawer open={showFilesList} onOpenChange={setShowFilesList}>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Files</DrawerTitle>
                  <div className="mt-2">
                    {/* Main Navigation with segment button on the right */}
                    <div className="py-2 flex items-center justify-between h-[46px]">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleViewModeChange(subMode === 'local' ? 'local' : 'remote')}
                          className={`text-sm font-semibold px-2 py-1 rounded transition-colors ${
                            filesPane === 'changes' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Changes
                        </button>
                        <button
                          onClick={() => handleViewModeChange(subMode === 'local' ? 'all-local' : 'all')}
                          className={`text-sm font-semibold px-2 py-1 rounded transition-colors ${
                            filesPane === 'files' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Files
                        </button>
                      </div>

                      {/* Segment Button for Remote/Sandbox sub-modes */}
                      <div className="inline-flex rounded-md border border-border bg-muted/50 p-0.5">
                        <Button
                          variant={subMode === 'remote' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => handleViewModeChange(filesPane === 'files' ? 'all' : 'remote')}
                          className={`h-6 px-2 text-xs rounded-sm ${
                            subMode === 'remote'
                              ? 'bg-background shadow-sm'
                              : 'hover:bg-transparent hover:text-foreground'
                          }`}
                        >
                          Remote
                        </Button>
                        <Button
                          variant={subMode === 'local' ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => handleViewModeChange(filesPane === 'files' ? 'all-local' : 'local')}
                          className={`h-6 px-2 text-xs rounded-sm ${
                            subMode === 'local'
                              ? 'bg-background shadow-sm'
                              : 'hover:bg-transparent hover:text-foreground'
                          }`}
                        >
                          Sandbox
                        </Button>
                      </div>
                    </div>
                  </div>
                </DrawerHeader>
                <div className="overflow-y-auto max-h-[60vh] px-4 pb-4">
                  <FileBrowser
                    taskId={task.id}
                    branchName={task.branchName}
                    repoUrl={task.repoUrl}
                    sandboxId={task.sandboxId}
                    onFileSelect={(file, isFolder) => {
                      openFileInTab(file, isFolder)
                      if (!isFolder) {
                        setShowFilesList(false)
                      }
                    }}
                    onFilesLoaded={fetchAllDiffs}
                    selectedFile={selectedFile}
                    refreshKey={refreshKey}
                    viewMode={viewMode}
                    onViewModeChange={handleViewModeChange}
                    hideHeader={true}
                  />
                </div>
              </DrawerContent>
            </Drawer>
          </div>
        </>
      ) : (
        /* No branch or sandbox yet - show chat panel only */
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 min-h-0 min-w-0">
            <TaskChat
              key={task.id}
              taskId={task.id}
              task={task}
              chatStream={chatStream}
              onStreamComplete={onStreamComplete}
              onManualUserSend={autoFix.notifyUserSend}
              skillsList={skillsList}
            />
          </div>
        </div>
      )}

      {/* Try Again Dialog */}
      <AlertDialog open={showTryAgainDialog} onOpenChange={setShowTryAgainDialog}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Try Again</AlertDialogTitle>
            <AlertDialogDescription>Create a new task with the same prompt and repository.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Agent</label>
                <Select
                  value={selectedAgent}
                  onValueChange={(v) => {
                    setSelectedAgent(v)
                    const models = tryAgainAgentModels[v] ?? []
                    if (models.length > 0 && !models.some((m) => m.id === selectedModel)) {
                      setSelectedModel(models[0].id)
                    }
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {CODING_AGENTS.map((agent) => {
                      const disabled = tryAgainUnavailableAgents.has(agent.value)
                      return (
                        <SelectItem key={agent.value} value={agent.value} disabled={disabled}>
                          <div className={`flex items-center gap-2 ${disabled ? 'opacity-40' : ''}`}>
                            <agent.icon className="w-4 h-4" />
                            <span>{agent.label}</span>
                            {disabled && <span className="text-xs">(unavailable)</span>}
                          </div>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Model</label>
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {(tryAgainAgentModels[selectedAgent] ?? []).map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Task Options — 暂不支持，已隐藏
            <div className="border-t pt-4">
              <h3 className="text-sm font-medium mb-3">Task Options</h3>
              <div className="space-y-4">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="try-again-install-deps"
                    checked={tryAgainInstallDeps}
                    onCheckedChange={(checked) => setTryAgainInstallDeps(!!checked)}
                  />
                  <Label
                    htmlFor="try-again-install-deps"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Install Dependencies?
                  </Label>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="try-again-max-duration" className="text-sm font-medium">
                    Maximum Duration
                  </Label>
                  <Select
                    value={tryAgainMaxDuration.toString()}
                    onValueChange={(value) => setTryAgainMaxDuration(parseInt(value))}
                  >
                    <SelectTrigger id="try-again-max-duration" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5 minutes</SelectItem>
                      <SelectItem value="10">10 minutes</SelectItem>
                      <SelectItem value="15">15 minutes</SelectItem>
                      <SelectItem value="30">30 minutes</SelectItem>
                      <SelectItem value="45">45 minutes</SelectItem>
                      <SelectItem value="60">1 hour</SelectItem>
                      <SelectItem value="120">2 hours</SelectItem>
                      <SelectItem value="180">3 hours</SelectItem>
                      <SelectItem value="240">4 hours</SelectItem>
                      <SelectItem value="300">5 hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="try-again-keep-alive"
                    checked={tryAgainKeepAlive}
                    onCheckedChange={(checked) => setTryAgainKeepAlive(!!checked)}
                  />
                  <Label
                    htmlFor="try-again-keep-alive"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Keep Alive ({maxSandboxDuration} minutes max)
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="try-again-enable-browser"
                    checked={tryAgainEnableBrowser}
                    onCheckedChange={(checked) => setTryAgainEnableBrowser(!!checked)}
                  />
                  <Label
                    htmlFor="try-again-enable-browser"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Enable Browser Automation
                  </Label>
                </div>
              </div>
            </div>
            */}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleTryAgain} disabled={isTryingAgain}>
              {isTryingAgain ? 'Creating...' : 'Create Task'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Link Git Repository Dialog */}
      <Dialog open={showLinkRepoDialog} onOpenChange={setShowLinkRepoDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link Git Repository</DialogTitle>
            <DialogDescription>Enter the repository URL and branch name to associate with this task.</DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div>
              <Label htmlFor="link-repo-url">Repository URL</Label>
              <Input
                id="link-repo-url"
                value={linkRepoUrl}
                onChange={(e) => setLinkRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repo.git"
                className="mt-2"
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="link-branch-name">Branch Name</Label>
              <Input
                id="link-branch-name"
                value={linkBranchName}
                onChange={(e) => setLinkBranchName(e.target.value)}
                placeholder="main"
                className="mt-2"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleLinkRepo()
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={!personalGitInfo || isLinkingRepo}
              onClick={() => {
                setShowLinkRepoDialog(false)
                setLinkRepoUrl('')
                setLinkBranchName('')
                setShowUnlinkRepoDialog(true)
              }}
            >
              Unlink Repository
            </Button>
            <Button onClick={handleLinkRepo} disabled={isLinkingRepo || !linkRepoUrl.trim() || !linkBranchName.trim()}>
              {isLinkingRepo ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Linking...
                </>
              ) : (
                'Link Repository'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unlink Git Repository Dialog */}
      <Dialog open={showUnlinkRepoDialog} onOpenChange={setShowUnlinkRepoDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlink Git Repository</DialogTitle>
            <DialogDescription>
              Are you sure you want to unlink the associated Git repository from this task?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUnlinkRepoDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleUnlinkRepo} disabled={isUnlinkingRepo} variant="destructive">
              {isUnlinkingRepo ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Unlinking...
                </>
              ) : (
                'Unlink Repository'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Task</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this task? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting} className="bg-red-600 hover:bg-red-700">
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create PR Dialog */}
      <CreatePRDialog
        taskId={task.id}
        defaultTitle={(task.title || task.prompt).slice(0, 255)}
        defaultBody=""
        open={showPRDialog}
        onOpenChange={setShowPRDialog}
        onPRCreated={handlePRCreated}
      />

      {/* Merge PR Dialog */}
      {prUrl && prNumber && (
        <MergePRDialog
          taskId={task.id}
          prUrl={prUrl}
          prNumber={prNumber}
          open={showMergePRDialog}
          onOpenChange={handleMergeDialogClose}
          onPRMerged={handlePRMerged}
          onMergeInitiated={handleMergeInitiated}
        />
      )}

      {/* Close Tab Confirmation Dialog */}
      <AlertDialog open={showCloseTabDialog} onOpenChange={setShowCloseTabDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              Do you want to save the changes you made to{' '}
              {tabToClose !== null
                ? (() => {
                    const currentTabs = openTabsByMode[viewMode]
                    const filename = currentTabs[tabToClose]
                    if (!filename) return 'this file'
                    const shortName = filename.split('/').pop()
                    return shortName
                  })()
                : 'this file'}
              ?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setShowCloseTabDialog(false)
                setTabToClose(null)
              }}
            >
              Cancel
            </AlertDialogCancel>
            <Button variant="outline" onClick={() => handleCloseTabConfirm(false)}>
              Don&apos;t Save
            </Button>
            <AlertDialogAction onClick={() => handleCloseTabConfirm(true)}>Save</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Task MCP Servers Dialog */}
      <Dialog open={showTaskMcpDialog} onOpenChange={setShowTaskMcpDialog}>
        <DialogContent className="w-[600px] max-w-[90vw] max-h-[80vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Task MCP Servers</DialogTitle>
            <DialogDescription>Manage MCP servers for this task.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4 overflow-y-auto flex-1 max-h-[60vh]">
            {mcpServers.length === 0 ? (
              <Card className="p-6 text-center">
                <p className="text-sm text-muted-foreground">No MCP servers configured for this task.</p>
              </Card>
            ) : (
              mcpServers.map((server, index) => (
                <Card
                  key={`${server.type}-${server.baseUrl ?? server.name ?? index}`}
                  className="flex flex-row items-center justify-between p-3"
                >
                  <div className="flex items-center space-x-3 flex-1 min-w-0">
                    {getConnectorIcon(server)}
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-sm">{server.name || server.baseUrl || server.type}</h4>
                      {server.description && (
                        <p className="text-xs text-muted-foreground truncate">{server.description}</p>
                      )}
                      {server.baseUrl && server.name && (
                        <p className="text-xs text-muted-foreground truncate">{server.baseUrl}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleEditMcpServer(server)}
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleRemoveMcpServer(index)}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </Card>
              ))
            )}
            <div className="flex justify-end pt-4">
              <Button type="button" variant="default" onClick={() => setShowConnectorDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add MCP Server
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConnectorDialog
        open={showConnectorDialog}
        onOpenChange={setShowConnectorDialog}
        onConnectorSaved={handleConnectorSaved}
        onCancelEdit={() => setShowTaskMcpDialog(true)}
        initialView="presets"
      />

      {/* Skills Dialog */}
      <Dialog
        open={showSkillsDialog}
        onOpenChange={(open) => {
          setShowSkillsDialog(open)
          if (!open) setSelectedSkillDetail(null)
        }}
      >
        <DialogContent className="w-[720px] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden">
          {selectedSkillDetail ? (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedSkillDetail(null)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <DialogTitle>{selectedSkillDetail.name}</DialogTitle>
                </div>
              </DialogHeader>
              <div className="space-y-4 py-4 overflow-y-auto flex-1 max-h-[60vh]">
                {selectedSkillDetail.description && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Description</h4>
                    <p className="text-base">{selectedSkillDetail.description}</p>
                  </div>
                )}
                {selectedSkillDetail.source && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Source</h4>
                    <p className="text-base">{selectedSkillDetail.source}</p>
                  </div>
                )}
                {selectedSkillDetail.location && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Location</h4>
                    <p className="text-base font-mono text-sm break-all">{selectedSkillDetail.location}</p>
                  </div>
                )}
                {selectedSkillDetail.baseDirectory && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Base Directory</h4>
                    <p className="text-base font-mono text-sm break-all">{selectedSkillDetail.baseDirectory}</p>
                  </div>
                )}
                {selectedSkillDetail.allowedTools && selectedSkillDetail.allowedTools.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Allowed Tools</h4>
                    <div className="flex flex-wrap gap-1">
                      {selectedSkillDetail.allowedTools.map((tool) => (
                        <span key={tool} className="px-2 py-0.5 bg-accent text-accent-foreground rounded text-sm">
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {selectedSkillDetail.instructions && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Instructions</h4>
                    <pre className="text-sm bg-muted p-4 rounded-md whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                      {selectedSkillDetail.instructions}
                    </pre>
                  </div>
                )}
              </div>
              <div className="flex justify-end pt-4 border-t border-border">
                <Button
                  variant="destructive"
                  size="default"
                  onClick={() => handleUninstallSkill(selectedSkillDetail.name)}
                  disabled={uninstallingSkill}
                >
                  {uninstallingSkill ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-1.5" />
                  )}
                  Uninstall
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <DialogTitle>Skills Manager</DialogTitle>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={refreshAllSkills}
                    disabled={loadingSkills || loadingUserSkills}
                    title="刷新所有 Skills"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </DialogHeader>
              <Tabs
                value={skillsTab}
                onValueChange={(v) => {
                  setSkillsTab(v)
                  if (v === 'user' && userSkillsList.length === 0) fetchUserSkills()
                }}
                className="flex flex-col flex-1 overflow-hidden"
              >
                <TabsList className="w-full shrink-0">
                  <TabsTrigger value="user" className="flex-1">
                    用户 Skill
                  </TabsTrigger>
                  <TabsTrigger value="project" className="flex-1">
                    项目 Skill
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="user" className="mt-3 flex flex-col flex-1 overflow-hidden">
                  <div className="space-y-1 overflow-y-auto flex-1">
                    {loadingUserSkills ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : userSkillsList.length === 0 ? (
                      <Card className="p-6 text-center">
                        <p className="text-base text-muted-foreground">No user skills found in cloud storage.</p>
                      </Card>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
                          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
                            <input
                              type="checkbox"
                              className="rounded border-border"
                              checked={checkedUserSkills.size === userSkillsList.length && userSkillsList.length > 0}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setCheckedUserSkills(new Set(userSkillsList.map((s) => s.name)))
                                } else {
                                  setCheckedUserSkills(new Set())
                                }
                              }}
                            />
                            全选
                          </label>
                          <span className="text-sm text-muted-foreground ml-auto">
                            已选 {checkedUserSkills.size}/{userSkillsList.length}
                          </span>
                        </div>
                        {(() => {
                          const projectSkillNames = new Set(skillsList.map((s) => s.name))
                          const sorted = [...userSkillsList].sort((a, b) => {
                            const aInProject = projectSkillNames.has(a.name) ? 1 : 0
                            const bInProject = projectSkillNames.has(b.name) ? 1 : 0
                            return aInProject - bInProject
                          })
                          return sorted.map((skill) => {
                            const existsInProject = projectSkillNames.has(skill.name)
                            return (
                              <label
                                key={skill.name}
                                className={`flex items-center gap-2 px-4 py-3 border-b border-border last:border-b-0 rounded transition-colors hover:bg-accent/50 cursor-pointer`}
                              >
                                <input
                                  type="checkbox"
                                  className="rounded border-border shrink-0"
                                  checked={checkedUserSkills.has(skill.name)}
                                  onChange={(e) => {
                                    const next = new Set(checkedUserSkills)
                                    if (e.target.checked) {
                                      next.add(skill.name)
                                    } else {
                                      next.delete(skill.name)
                                    }
                                    setCheckedUserSkills(next)
                                  }}
                                />
                                <div className="flex flex-col gap-0.5 min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-base">{skill.name}</span>
                                    {existsInProject && (
                                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 whitespace-nowrap">
                                        项目已存在
                                      </span>
                                    )}
                                  </div>
                                  {skill.description && (
                                    <p className="text-sm text-muted-foreground truncate">{skill.description}</p>
                                  )}
                                </div>
                              </label>
                            )
                          })
                        })()}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2 pt-4 border-t border-border">
                    <Button
                      size="default"
                      variant="destructive"
                      onClick={handleDeleteUserSkills}
                      disabled={deletingUserSkills || checkedUserSkills.size === 0}
                      title="Delete selected skills from cloud storage"
                    >
                      {deletingUserSkills ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      <span className="ml-1.5">
                        删除{checkedUserSkills.size > 0 ? ` (${checkedUserSkills.size})` : ''}
                      </span>
                    </Button>
                    <Button
                      size="default"
                      variant="outline"
                      onClick={() => skillFolderInputRef.current?.click()}
                      disabled={uploadingSkill}
                      title="上传 Skill 文件夹到云存储"
                    >
                      {uploadingSkill ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className="ml-1.5">
                            {uploadProgress ? `${uploadProgress.current}/${uploadProgress.total}` : '上传中...'}
                          </span>
                        </>
                      ) : (
                        <>
                          <FolderUp className="h-4 w-4" />
                          <span className="ml-1.5">上传 Skill</span>
                        </>
                      )}
                    </Button>
                    <input
                      ref={skillFolderInputRef}
                      type="file"
                      className="hidden"
                      onChange={handleUploadSkillFolder}
                      // @ts-expect-error webkitdirectory is a non-standard attribute
                      webkitdirectory=""
                      directory=""
                    />
                    <Button
                      size="default"
                      onClick={handleInitSkills}
                      disabled={initializingSkills || checkedUserSkills.size === 0}
                      title="Sync selected skills to sandbox"
                      className="ml-auto"
                    >
                      {initializingSkills ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      <span className="ml-1.5">
                        同步到沙箱{checkedUserSkills.size > 0 ? ` (${checkedUserSkills.size})` : ''}
                      </span>
                    </Button>
                  </div>
                </TabsContent>
                <TabsContent value="project" className="mt-3 flex flex-col flex-1 overflow-hidden">
                  <div className="space-y-1 overflow-y-auto flex-1">
                    {loadingSkills ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : skillsList.length === 0 ? (
                      <Card className="p-6 text-center">
                        <p className="text-base text-muted-foreground">No skills available.</p>
                      </Card>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
                          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
                            <input
                              type="checkbox"
                              className="rounded border-border"
                              checked={checkedProjectSkills.size === skillsList.length && skillsList.length > 0}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setCheckedProjectSkills(new Set(skillsList.map((s) => s.name)))
                                } else {
                                  setCheckedProjectSkills(new Set())
                                }
                              }}
                            />
                            全选
                          </label>
                          <span className="text-sm text-muted-foreground ml-auto">
                            已选 {checkedProjectSkills.size}/{skillsList.length}
                          </span>
                        </div>
                        {skillsList.map((skill) => (
                          <div
                            key={skill.name}
                            className="flex items-center gap-2 px-4 py-3 border-b border-border last:border-b-0 rounded transition-colors hover:bg-accent/50"
                          >
                            <input
                              type="checkbox"
                              className="rounded border-border shrink-0 cursor-pointer"
                              checked={checkedProjectSkills.has(skill.name)}
                              onChange={(e) => {
                                const next = new Set(checkedProjectSkills)
                                if (e.target.checked) {
                                  next.add(skill.name)
                                } else {
                                  next.delete(skill.name)
                                }
                                setCheckedProjectSkills(next)
                              }}
                            />
                            <div
                              className="flex flex-col gap-0.5 min-w-0 flex-1 cursor-pointer"
                              onClick={() => fetchSkillDetail(skill.name)}
                            >
                              <span className="font-semibold text-base">{skill.name}</span>
                              {skill.description && (
                                <p className="text-sm text-muted-foreground truncate">{skill.description}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2 pt-4 border-t border-border">
                    <Button
                      size="default"
                      variant="destructive"
                      onClick={handleDeleteProjectSkills}
                      disabled={deletingProjectSkills || checkedProjectSkills.size === 0}
                      title="删除选中的项目 Skills"
                    >
                      {deletingProjectSkills ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      <span className="ml-1.5">
                        删除{checkedProjectSkills.size > 0 ? ` (${checkedProjectSkills.size})` : ''}
                      </span>
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            </>
          )}
          {loadingSkillDetail && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
