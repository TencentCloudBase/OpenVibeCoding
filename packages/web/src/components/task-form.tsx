import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Loader2, ArrowUp, Settings, X, Cable, Globe, Code2, ImageIcon } from 'lucide-react'
import { CodeBuddy, MiMo, OpenCode, ProviderLogos, type ProviderKey } from '@/components/logos'
// import { Claude, Codex, Copilot, Cursor, Gemini } from '@/components/logos'
import { setInstallDependencies, setMaxDuration, setKeepAlive, setEnableBrowser } from '@/lib/utils/cookies'
import { useConnectors } from '@/components/connectors-provider'
import { ConnectorDialog } from '@/components/connectors/manage-connectors'
import type { Connector } from '@/lib/session/types'
import { toast } from 'sonner'
import { useAtom, useSetAtom } from 'jotai'
import { taskPromptAtom } from '@/lib/atoms/task'
import { lastSelectedModelAtomFamily, githubReposAtomFamily } from '@/lib/atoms/github'
import type { ModelInfo } from '@coder/shared'

interface GitHubRepo {
  name: string
  full_name: string
  description: string
  private: boolean
  clone_url: string
  language: string
}

interface TaskFormProps {
  onSubmit: (data: {
    prompt: string
    repoUrl: string
    selectedAgent: string
    selectedModel: string
    selectedModels?: string[]
    selectedRuntime?: string
    mode: 'default' | 'coding'
    installDependencies: boolean
    maxDuration: number
    keepAlive: boolean
    enableBrowser: boolean
    mcpServerList?: Connector[]
    imageBlocks?: Array<{ data: string; mimeType: string }>
  }) => void
  isSubmitting: boolean
  selectedOwner: string
  selectedRepo: string
  initialInstallDependencies?: boolean
  initialMaxDuration?: number
  initialKeepAlive?: boolean
  initialEnableBrowser?: boolean
  maxSandboxDuration?: number
}

/** runtime name → agent value 的映射（让 CODING_AGENTS 与后端 runtime name 对齐） */
const RUNTIME_TO_AGENT: Record<string, string> = {
  codebuddy: 'codebuddy',
  'opencode-acp': 'opencode',
}

const CODING_AGENTS = [
  { value: 'codebuddy', label: 'CodeBuddy', icon: CodeBuddy, isLogo: true, runtime: 'codebuddy' },
  { value: 'opencode', label: 'OpenCode', icon: OpenCode, isLogo: true, runtime: 'opencode-acp' },
  // --- Other agents (commented out, kept for reference) ---
  // { value: 'claude', label: 'Claude', icon: Claude, isLogo: true, runtime: 'claude' },
  // { value: 'codex', label: 'Codex', icon: Codex, isLogo: true, runtime: 'codex' },
  // { value: 'copilot', label: 'Copilot', icon: Copilot, isLogo: true, runtime: 'copilot' },
  // { value: 'cursor', label: 'Cursor', icon: Cursor, isLogo: true, runtime: 'cursor' },
  // { value: 'gemini', label: 'Gemini', icon: Gemini, isLogo: true, runtime: 'gemini' },
] as const

// Map model name prefix to provider logo key
const MODEL_PROVIDER_MAP: [string[], ProviderKey][] = [
  [['gpt', 'openai'], 'openai'],
  [['claude', 'anthropic'], 'anthropic'],
  [['gemini', 'google'], 'google'],
  [['glm', 'chatglm'], 'zhipu'],
  [['deepseek'], 'deepseek'],
  [['hunyuan'], 'tencent'],
  [['kimi', 'moonshot'], 'kimi'],
  [['qwen', 'tongyi'], 'alibaba'],
  [['doubao', 'bytedance'], 'bytedance'],
  [['ernie', 'wenxin', 'baidu'], 'baidu'],
  [['llama', 'meta'], 'generic'],
  [['minimax'], 'minimax'],
  [['mimo'], 'mimo'],
]

function getModelProviderKey(modelId: string): ProviderKey {
  const lower = modelId.toLowerCase()
  for (const [prefixes, key] of MODEL_PROVIDER_MAP) {
    if (prefixes.some((p) => lower.includes(p))) return key
  }
  return 'generic'
}

export function TaskForm({
  onSubmit,
  isSubmitting,
  selectedOwner,
  selectedRepo,
  initialInstallDependencies = false,
  initialMaxDuration = 300,
  initialKeepAlive = false,
  initialEnableBrowser = false,
  maxSandboxDuration = 300,
}: TaskFormProps) {
  const [prompt, setPrompt] = useAtom(taskPromptAtom)
  const [selectedAgent, setSelectedAgent] = useState<string>('codebuddy')
  const [selectedModel, setSelectedModel] = useState<string>('glm-5.1')
  // Default to 'coding' mode — tasks without a git repo are always coding/sandbox tasks
  const [taskMode, setTaskMode] = useState<'default' | 'coding'>('coding')
  const [repos, setRepos] = useAtom(githubReposAtomFamily(selectedOwner))
  const [, setLoadingRepos] = useState(false)
  const [pendingImages, setPendingImages] = useState<
    Array<{ id: string; url: string; data: string; mimeType: string }>
  >([])
  const imageInputRef = useRef<HTMLInputElement>(null)

  // Per-agent model lists and availability, loaded from /api/agent/runtimes
  const [agentModels, setAgentModels] = useState<Record<string, ModelInfo[]>>({
    codebuddy: [{ id: 'glm-5.1', name: 'GLM 5.1' }],
  })
  const [unavailableAgents, setUnavailableAgents] = useState<Set<string>>(new Set())
  const [selectedRuntime, setSelectedRuntime] = useState<string>('codebuddy')

  useEffect(() => {
    fetch('/api/agent/runtimes')
      .then((r) => r.json())
      .then((data: { default: string; runtimes: Array<{ name: string; available: boolean; models: ModelInfo[] }> }) => {
        const newAgentModels: Record<string, ModelInfo[]> = {}
        const unavailable = new Set<string>()

        for (const rt of data.runtimes) {
          if (!rt.available) {
            // mark all agents that use this runtime as unavailable
            for (const agent of CODING_AGENTS) {
              if (agent.runtime === rt.name) unavailable.add(agent.value)
            }
          } else if (rt.models.length > 0) {
            // assign models to every agent that maps to this runtime
            for (const agent of CODING_AGENTS) {
              if (agent.runtime === rt.name) newAgentModels[agent.value] = rt.models
            }
          }
        }

        setAgentModels((prev) => ({ ...prev, ...newAgentModels }))
        setUnavailableAgents(unavailable)

        // Set default agent/runtime from server
        const defaultAgentValue = RUNTIME_TO_AGENT[data.default]
        if (defaultAgentValue) {
          setSelectedAgent(defaultAgentValue)
          setSelectedRuntime(data.default)
          const defaultModels = newAgentModels[defaultAgentValue]
          if (defaultModels && defaultModels.length > 0) {
            setSelectedModel(defaultModels[0].id)
          }
        }
      })
      .catch(() => {
        /* silently ignore */
      })
  }, [])

  // Options state - initialize with server values
  const [installDependencies, setInstallDependenciesState] = useState(initialInstallDependencies)
  const [maxDuration, setMaxDurationState] = useState(initialMaxDuration)
  const [keepAlive, setKeepAliveState] = useState(initialKeepAlive)
  const [enableBrowser, setEnableBrowserState] = useState(initialEnableBrowser)
  const [showMcpServersDialog, setShowMcpServersDialog] = useState(false)

  // Connectors state
  const { connectors, clearConnectors } = useConnectors()

  // Ref for the textarea to focus it programmatically
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Wrapper functions to update both state and cookies
  const updateInstallDependencies = (value: boolean) => {
    setInstallDependenciesState(value)
    setInstallDependencies(value)
  }

  const updateMaxDuration = (value: number) => {
    setMaxDurationState(value)
    setMaxDuration(value)
  }

  const updateKeepAlive = (value: boolean) => {
    setKeepAliveState(value)
    setKeepAlive(value)
  }

  const updateEnableBrowser = (value: boolean) => {
    setEnableBrowserState(value)
    setEnableBrowser(value)
  }

  // Handle keyboard events in textarea
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      // On desktop: Enter submits, Shift+Enter creates new line
      // On mobile: Enter creates new line, must use submit button
      const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
      if (!isMobile && !e.shiftKey) {
        e.preventDefault()
        if (prompt.trim()) {
          // Find the form and submit it
          const form = e.currentTarget.closest('form')
          if (form) {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
          }
        }
      }
      // For all other cases (mobile Enter, desktop Shift+Enter), let default behavior create new line
    }
  }

  // Focus the prompt input when the component mounts
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  // When agent changes: switch runtime + reset model if current selection not in new list
  const handleAgentChange = (agentValue: string) => {
    setSelectedAgent(agentValue)
    const agentDef = CODING_AGENTS.find((a) => a.value === agentValue)
    if (agentDef) setSelectedRuntime(agentDef.runtime)
    const models = agentModels[agentValue] ?? []
    if (models.length === 0) return
    if (!models.some((m) => m.id === selectedModel)) {
      setSelectedModel(models[0].id)
    }
  }

  // Validate selectedModel whenever agent or its models change.
  // Catches races where agentModels arrives after selectedAgent update.
  useEffect(() => {
    const models = agentModels[selectedAgent] ?? []
    if (models.length === 0) return
    if (!models.some((m) => m.id === selectedModel)) {
      setSelectedModel(models[0].id)
    }
  }, [selectedAgent, agentModels, selectedModel])

  // Get saved model atom for current agent (persists selection across page loads)
  const savedModelAtom = lastSelectedModelAtomFamily(selectedAgent)
  const setSavedModel = useSetAtom(savedModelAtom)

  // Fetch repositories when owner changes
  useEffect(() => {
    if (!selectedOwner) {
      setRepos(null)
      return
    }

    const fetchRepos = async () => {
      setLoadingRepos(true)
      try {
        // Check cache first (repos is from the atom)
        if (repos && repos.length > 0) {
          setLoadingRepos(false)
          return
        }

        const response = await fetch(`/api/github/repos?owner=${selectedOwner}`)
        if (response.ok) {
          const reposList = await response.json()
          setRepos(reposList)
        }
      } catch (error) {
        console.error('Error fetching repositories:', error)
      } finally {
        setLoadingRepos(false)
      }
    }

    fetchRepos()
  }, [selectedOwner, repos, setRepos])

  const processImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      const base64 = dataUrl.split(',')[1]
      const url = URL.createObjectURL(file)
      setPendingImages((prev) => [
        ...prev,
        { id: `img-${Date.now()}-${Math.random()}`, url, data: base64, mimeType: file.type },
      ])
    }
    reader.readAsDataURL(file)
  }

  const handlePasteImage = (e: React.ClipboardEvent) => {
    Array.from(e.clipboardData.items).forEach((item) => {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) processImageFile(file)
      }
    })
  }

  const handleImageFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(e.target.files ?? []).forEach(processImageFile)
    e.target.value = ''
  }

  const removeImage = (id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id)
      if (img) URL.revokeObjectURL(img.url)
      return prev.filter((i) => i.id !== id)
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    console.log('[TaskForm] handleSubmit called, prompt:', prompt?.slice(0, 20), 'isSubmitting:', isSubmitting)
    if (!prompt.trim()) {
      console.log('[TaskForm] empty prompt, returning')
      return
    }

    // Clear connectors from localStorage and memory on new task creation
    clearConnectors()

    // If owner/repo not selected, let parent handle it (will show sign-in if needed)
    // Don't clear localStorage here - user might need to sign in and come back
    if (!selectedOwner || !selectedRepo) {
      console.log('[TaskForm] no repo selected, calling onSubmit directly')
      const connectedMcps = connectors
        .filter((c) => c.status === 'connected')
        .map((c) => ({
          name: c.name,
          description: c.description,
          type: c.type,
          baseUrl: c.baseUrl,
          command: c.command,
          args: c.args,
          headers: c.headers,
        }))
      onSubmit({
        prompt: prompt.trim(),
        repoUrl: '',
        selectedAgent,
        selectedModel,
        selectedRuntime: selectedRuntime || undefined,
        mode: taskMode,
        installDependencies,
        maxDuration,
        keepAlive,
        enableBrowser,
        mcpServerList: connectedMcps.length > 0 ? connectedMcps : undefined,
        imageBlocks:
          pendingImages.length > 0 ? pendingImages.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
      })
      setPendingImages([])
      return
    }

    // Check if API key is required and available for the selected agent and model
    // Skip this check if we don't have repo data (likely not signed in)
    const selectedRepoData = repos?.find((repo) => repo.name === selectedRepo)

    if (selectedRepoData) {
      try {
        console.log('[TaskForm] checking API key for agent:', selectedAgent, 'model:', selectedModel)
        const response = await fetch(`/api/api-keys/check?agent=${selectedAgent}&model=${selectedModel}`)
        const data = await response.json()
        console.log('[TaskForm] API key check result:', data)

        if (!data.hasKey) {
          // Show error message with provider name
          const providerNames: Record<string, string> = {
            anthropic: 'Anthropic',
            openai: 'OpenAI',
            cursor: 'Cursor',
            gemini: 'Gemini',
            aigateway: 'AI Gateway',
          }
          const providerName = providerNames[data.provider] || data.provider

          toast.error(`${providerName} API key required`, {
            description: `Please add your ${providerName} API key in the user menu to use the ${data.agentName} agent with this model.`,
          })
          return
        }
      } catch (error) {
        console.error('Error checking API key:', error)
        // Don't show error toast - might just be not authenticated, let parent handle it
      }
    }

    console.log('[TaskForm] repo selected, calling onSubmit with repoUrl:', selectedRepoData?.clone_url)
    const connectedMcps = connectors
      .filter((c) => c.status === 'connected')
      .map((c) => ({
        name: c.name,
        description: c.description,
        type: c.type,
        baseUrl: c.baseUrl,
        command: c.command,
        args: c.args,
        headers: c.headers,
      }))
    onSubmit({
      prompt: prompt.trim(),
      repoUrl: selectedRepoData?.clone_url || '',
      selectedAgent,
      selectedModel,
      selectedRuntime: selectedRuntime || undefined,
      mode: taskMode,
      installDependencies,
      maxDuration,
      keepAlive,
      enableBrowser,
      mcpServerList: connectedMcps.length > 0 ? connectedMcps : undefined,
      imageBlocks:
        pendingImages.length > 0 ? pendingImages.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
    })
    setPendingImages([])
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold mb-4">Coding Agent</h1>
        <p className="text-lg text-muted-foreground mb-2">
          基于{' '}
          <a
            href="https://tcb.cloud.tencent.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            CloudBase
          </a>{' '}
          的 VibeCoding 全栈应用开发平台
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="relative border rounded-2xl shadow-sm overflow-hidden bg-muted/30 cursor-text">
          {/* Pending images preview */}
          {pendingImages.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {pendingImages.map((img) => (
                <div key={img.id} className="relative group">
                  <img src={img.url} alt="" className="h-16 w-16 rounded-lg object-cover border border-border" />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1 -right-1 w-4 h-4 bg-background border border-border rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Prompt Input */}
          <div className="relative bg-transparent">
            <Textarea
              ref={textareaRef}
              id="prompt"
              placeholder="描述您希望 Agent 做什么... (使用 Ctrl+V 粘贴图片)"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleTextareaKeyDown}
              onPaste={handlePasteImage}
              disabled={isSubmitting}
              required
              rows={4}
              className="w-full border-0 resize-none focus-visible:ring-0 focus-visible:ring-offset-0 p-4 text-base !bg-transparent shadow-none!"
            />
          </div>
          {/* Hidden file input */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={handleImageFiles}
          />

          {/* Mode + Agent/Model selector */}
          <div className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {/* Mode toggle */}
                <button
                  type="button"
                  onClick={() => setTaskMode(taskMode === 'default' ? 'coding' : 'default')}
                  className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full border transition-colors ${
                    taskMode === 'coding'
                      ? 'bg-primary/10 text-primary border-primary/30'
                      : 'text-muted-foreground border-border hover:border-primary/30'
                  }`}
                >
                  <Code2 className="h-3 w-3" />
                  {taskMode === 'coding' ? 'Coding' : 'Default'}
                </button>
                <span className="text-muted-foreground/50">·</span>
                <div className="flex items-center gap-2 text-sm text-muted-foreground px-2 h-8">
                  {/* Agent selector */}
                  <Select value={selectedAgent} onValueChange={handleAgentChange}>
                    <SelectTrigger className="h-7 border-0 shadow-none px-1 py-0 text-sm text-muted-foreground hover:text-foreground bg-transparent focus:ring-0 gap-1 w-auto min-w-[90px]">
                      {(() => {
                        const agent = CODING_AGENTS.find((a) => a.value === selectedAgent)
                        return agent ? (
                          <>
                            <agent.icon className="w-4 h-4" />
                            <span className="truncate">{agent.label}</span>
                          </>
                        ) : null
                      })()}
                    </SelectTrigger>
                    <SelectContent>
                      {CODING_AGENTS.map((agent) => {
                        const disabled = unavailableAgents.has(agent.value)
                        return (
                          <SelectItem key={agent.value} value={agent.value} disabled={disabled}>
                            <span className={`flex items-center gap-2 ${disabled ? 'opacity-40' : ''}`}>
                              <agent.icon className="w-4 h-4" />
                              <span>{agent.label}</span>
                              {disabled && <span className="text-xs">（不可用）</span>}
                            </span>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground/50">·</span>
                  {/* Model selector — options change per agent */}
                  <Select
                    value={selectedModel}
                    onValueChange={(v) => {
                      setSelectedModel(v)
                      setSavedModel(v)
                    }}
                  >
                    <SelectTrigger className="h-7 border-0 shadow-none px-1 py-0 text-sm text-muted-foreground hover:text-foreground bg-transparent focus:ring-0 gap-1 w-auto min-w-[120px]">
                      {(() => {
                        const models = agentModels[selectedAgent] ?? []
                        const current = models.find((m) => m.id === selectedModel)
                        const ProviderIcon = ProviderLogos[getModelProviderKey(selectedModel)]
                        return (
                          <>
                            <ProviderIcon className="w-3.5 h-3.5 shrink-0 opacity-70" />
                            <span className="truncate">{current?.name || selectedModel}</span>
                          </>
                        )
                      })()}
                    </SelectTrigger>
                    <SelectContent>
                      {(agentModels[selectedAgent] ?? []).map((m) => {
                        const ProviderIcon = ProviderLogos[getModelProviderKey(m.id)]
                        return (
                          <SelectItem key={m.id} value={m.id}>
                            <span className="flex items-center gap-2">
                              <ProviderIcon className="w-3.5 h-3.5 shrink-0 opacity-70" />
                              <span>{m.name}</span>
                            </span>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                </div>

                {/* Option Chips - Only visible on desktop */}
                {/* {(!installDependencies || maxDuration !== maxSandboxDuration || keepAlive) && (
                  <div className="hidden sm:flex items-center gap-2 flex-wrap">
                    {!installDependencies && (
                      <Badge variant="secondary" className="text-xs h-6 px-2 gap-1 bg-transparent border-0">
                        Skip Install
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-3 w-3 p-0 hover:bg-transparent"
                          onClick={(e) => {
                            e.stopPropagation()
                            updateInstallDependencies(true)
                          }}
                        >
                          <X className="h-2 w-2" />
                        </Button>
                      </Badge>
                    )}
                    {maxDuration !== maxSandboxDuration && (
                      <Badge variant="secondary" className="text-xs h-6 px-2 gap-1 bg-transparent border-0">
                        {maxDuration}m
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-3 w-3 p-0 hover:bg-transparent"
                          onClick={(e) => {
                            e.stopPropagation()
                            updateMaxDuration(maxSandboxDuration)
                          }}
                        >
                          <X className="h-2 w-2" />
                        </Button>
                      </Badge>
                    )}
                    {keepAlive && (
                      <Badge variant="secondary" className="text-xs h-6 px-2 gap-1 bg-transparent border-0">
                        Keep Alive
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-3 w-3 p-0 hover:bg-transparent"
                          onClick={(e) => {
                            e.stopPropagation()
                            updateKeepAlive(false)
                          }}
                        >
                          <X className="h-2 w-2" />
                        </Button>
                      </Badge>
                    )}
                  </div>
                )} */}
              </div>

              {/* Right side: Action Icons and Submit Button */}
              <div className="flex items-center gap-2 shrink-0">
                {/* Buttons */}
                <div className="flex items-center gap-2">
                  <TooltipProvider delayDuration={1500} skipDelayDuration={1500}>
                    {/* <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="rounded-full h-8 w-8 p-0 relative"
                          onClick={() => updateEnableBrowser(!enableBrowser)}
                        >
                          <Globe className="h-4 w-4" />
                          {enableBrowser && (
                            <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-green-500" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Agent Browser</p>
                      </TooltipContent>
                    </Tooltip> */}

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="rounded-full h-8 w-8 p-0 relative"
                          onClick={() => setShowMcpServersDialog(true)}
                        >
                          <Cable className="h-4 w-4" />
                          {connectors.filter((c) => c.status === 'connected').length > 0 && (
                            <Badge
                              variant="secondary"
                              className="absolute -top-1 -right-1 h-4 min-w-4 p-0 flex items-center justify-center text-[10px] rounded-full"
                            >
                              {connectors.filter((c) => c.status === 'connected').length}
                            </Badge>
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>MCP</p>
                      </TooltipContent>
                    </Tooltip>

                    {/* Task Options — 暂不支持，已隐藏
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="rounded-full h-8 w-8 p-0 relative"
                            >
                              <Settings className="h-4 w-4" />
                              {(() => {
                                const customOptionsCount = [
                                  !installDependencies,
                                  maxDuration !== maxSandboxDuration,
                                  keepAlive,
                                ].filter(Boolean).length
                                return customOptionsCount > 0 ? (
                                  <Badge
                                    variant="secondary"
                                    className="absolute -top-1 -right-1 h-4 min-w-4 p-0 flex items-center justify-center text-[10px] rounded-full sm:hidden"
                                  >
                                    {customOptionsCount}
                                  </Badge>
                                ) : null
                              })()}
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Task Options</p>
                        </TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent className="w-72" align="end">
                        <DropdownMenuLabel>Task Options</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <div className="p-2 space-y-4">
                          <div className="flex items-center space-x-2">
                            <Checkbox
                              id="install-deps"
                              checked={installDependencies}
                              onCheckedChange={(checked) => updateInstallDependencies(checked === true)}
                            />
                            <Label
                              htmlFor="install-deps"
                              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                            >
                              Install Dependencies?
                            </Label>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="max-duration" className="text-sm font-medium">
                              Maximum Duration
                            </Label>
                            <Select
                              value={maxDuration.toString()}
                              onValueChange={(value) => updateMaxDuration(parseInt(value))}
                            >
                              <SelectTrigger id="max-duration" className="w-full h-8">
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
                          <div className="space-y-2">
                            <div className="flex items-center space-x-2">
                              <Checkbox
                                id="keep-alive"
                                checked={keepAlive}
                                onCheckedChange={(checked) => updateKeepAlive(checked === true)}
                              />
                              <Label
                                htmlFor="keep-alive"
                                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                              >
                                Keep Alive ({maxSandboxDuration}m max)
                              </Label>
                            </div>
                            <p className="text-xs text-muted-foreground pl-6">Keep sandbox running after completion.</p>
                          </div>
                        </div>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    */}
                  </TooltipProvider>

                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    className="flex items-center justify-center h-8 w-8 rounded-full text-muted-foreground hover:text-foreground transition-colors"
                    title="添加图片"
                  >
                    <ImageIcon className="h-4 w-4" />
                  </button>

                  <Button
                    type="submit"
                    disabled={isSubmitting || (!prompt.trim() && pendingImages.length === 0)}
                    size="sm"
                    className="rounded-full h-8 w-8 p-0"
                  >
                    {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>

      <ConnectorDialog open={showMcpServersDialog} onOpenChange={setShowMcpServersDialog} />
    </div>
  )
}
