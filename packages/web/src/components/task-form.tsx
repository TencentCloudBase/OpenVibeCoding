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
import { Loader2, ArrowUp, Settings, X, Cable, Users, Globe, Code } from 'lucide-react'
import { CodeBuddy, ProviderLogos, type ProviderKey } from '@/components/logos'
// import { Claude, Codex, Copilot, Cursor, Gemini, OpenCode } from '@/components/logos'
import { setInstallDependencies, setMaxDuration, setKeepAlive, setEnableBrowser } from '@/lib/utils/cookies'
import { useConnectors } from '@/components/connectors-provider'
import { ConnectorDialog } from '@/components/connectors/manage-connectors'
import { toast } from 'sonner'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { taskPromptAtom } from '@/lib/atoms/task'
import { lastSelectedModelAtomFamily, githubReposAtomFamily } from '@/lib/atoms/github'
import type { ModelInfo } from '@coder/shared'
import { useLocation } from 'react-router'

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
    installDependencies: boolean
    maxDuration: number
    keepAlive: boolean
    enableBrowser: boolean
    mode: 'default' | 'coding'
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

const CODING_AGENTS = [
  // CodeBuddy agent (default)
  { value: 'codebuddy', label: 'CodeBuddy', icon: CodeBuddy, isLogo: true },
  // --- Other agents (commented out, kept for reference) ---
  // { value: 'multi-agent', label: 'Compare', icon: Users, isLogo: false },
  // { value: 'claude', label: 'Claude', icon: Claude, isLogo: true },
  // { value: 'codex', label: 'Codex', icon: Codex, isLogo: true },
  // { value: 'copilot', label: 'Copilot', icon: Copilot, isLogo: true },
  // { value: 'cursor', label: 'Cursor', icon: Cursor, isLogo: true },
  // { value: 'gemini', label: 'Gemini', icon: Gemini, isLogo: true },
  // { value: 'opencode', label: 'opencode', icon: OpenCode, isLogo: true },
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
]

function getModelProviderKey(modelId: string): ProviderKey {
  const lower = modelId.toLowerCase()
  for (const [prefixes, key] of MODEL_PROVIDER_MAP) {
    if (prefixes.some((p) => lower.includes(p))) return key
  }
  return 'generic'
}

// Model options for each agent
const AGENT_MODELS: Record<string, Array<{ value: string; label: string }>> = {
  codebuddy: [{ value: 'glm-5.0', label: 'GLM 5.0' }],
  // --- Other agents (commented out, kept for reference) ---
  // claude: [
  //   { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  //   { value: 'anthropic/claude-opus-4.6', label: 'Opus 4.6' },
  //   { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  // ],
}

// Default models for each agent
const DEFAULT_MODELS = {
  codebuddy: 'glm-5.0',
  // --- Other agents (commented out) ---
  // claude: 'claude-sonnet-4-5',
  // codex: 'openai/gpt-5.1',
  // copilot: 'claude-sonnet-4.5',
  // cursor: 'auto',
  // gemini: 'gemini-3-pro-preview',
  // opencode: 'gpt-5',
} as const

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
  const selectedAgent = 'codebuddy'
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODELS.codebuddy)
  const [taskMode, setTaskMode] = useState<'default' | 'coding'>('default')
  const [codebuddyModels, setCodebuddyModels] = useState<ModelInfo[]>([{ id: 'glm-5.0', name: 'GLM 5.0' }])
  const [repos, setRepos] = useAtom(githubReposAtomFamily(selectedOwner))
  const [, setLoadingRepos] = useState(false)

  // Options state - initialize with server values
  const [installDependencies, setInstallDependenciesState] = useState(initialInstallDependencies)
  const [maxDuration, setMaxDurationState] = useState(initialMaxDuration)
  const [keepAlive, setKeepAliveState] = useState(initialKeepAlive)
  const [enableBrowser, setEnableBrowserState] = useState(initialEnableBrowser)
  const [showMcpServersDialog, setShowMcpServersDialog] = useState(false)

  // Connectors state
  const { connectors } = useConnectors()

  // Fetch supported models from backend on mount
  useEffect(() => {
    fetch('/api/agent/acp', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: 1 } }),
    })
      .then((res) => res.json())
      .then((data) => {
        const models = data?.result?.supportedModels
        if (Array.isArray(models) && models.length > 0) {
          setCodebuddyModels(models)
          const ids = models.map((m: ModelInfo) => m.id)
          if (!ids.includes(selectedModel)) {
            setSelectedModel(models[0].id)
          }
        }
      })
      .catch(() => {
        // Silently ignore - fall back to static defaults
      })
  }, [])

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

  // Get URL search params
  const location = useLocation()
  const searchParams = new URLSearchParams(location.search)

  // Load saved model and options on mount, and focus the prompt input
  useEffect(() => {
    // Check URL params for model override
    const urlModel = searchParams.get('model')
    if (urlModel) {
      const agentModels = AGENT_MODELS['claude' as keyof typeof AGENT_MODELS]
      if (agentModels?.some((model) => model.value === urlModel)) {
        setSelectedModel(urlModel)
      }
    }

    // Focus the prompt input when the component mounts
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Get saved model atom for current agent
  const savedModelAtom = lastSelectedModelAtomFamily(selectedAgent)
  const savedModel = useAtomValue(savedModelAtom)
  const setSavedModel = useSetAtom(savedModelAtom)

  // Update model when agent changes
  useEffect(() => {
    // Load saved model for this agent or use default
    const agentModels = AGENT_MODELS[selectedAgent as keyof typeof AGENT_MODELS]
    if (savedModel && agentModels?.some((model) => model.value === savedModel)) {
      setSelectedModel(savedModel)
    } else {
      const defaultModel = DEFAULT_MODELS[selectedAgent as keyof typeof DEFAULT_MODELS]
      if (defaultModel) {
        setSelectedModel(defaultModel)
      }
    }
  }, [selectedAgent, savedModel])

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    console.log('[TaskForm] handleSubmit called, prompt:', prompt?.slice(0, 20), 'isSubmitting:', isSubmitting)
    if (!prompt.trim()) {
      console.log('[TaskForm] empty prompt, returning')
      return
    }

    // If owner/repo not selected, let parent handle it (will show sign-in if needed)
    // Don't clear localStorage here - user might need to sign in and come back
    if (!selectedOwner || !selectedRepo) {
      console.log('[TaskForm] no repo selected, calling onSubmit directly')
      onSubmit({
        prompt: prompt.trim(),
        repoUrl: '',
        selectedAgent,
        selectedModel,
        installDependencies,
        maxDuration,
        keepAlive,
        enableBrowser,
        mode: taskMode,
      })
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
    onSubmit({
      prompt: prompt.trim(),
      repoUrl: selectedRepoData?.clone_url || '',
      selectedAgent,
      selectedModel,
      installDependencies,
      maxDuration,
      keepAlive,
      enableBrowser,
      mode: taskMode,
    })
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold mb-4">Coding Agent Template</h1>
        <p className="text-lg text-muted-foreground mb-2">
          Vibe coding platform powered by{' '}
          <a
            href="https://tcb.cloud.tencent.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            CloudBase
          </a>
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="relative border rounded-2xl shadow-sm overflow-hidden bg-muted/30 cursor-text">
          {/* Prompt Input */}
          <div className="relative bg-transparent">
            <Textarea
              ref={textareaRef}
              id="prompt"
              placeholder="Describe what you want the AI agent to do..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleTextareaKeyDown}
              disabled={isSubmitting}
              required
              rows={4}
              className="w-full border-0 resize-none focus-visible:ring-0 focus-visible:ring-offset-0 p-4 text-base !bg-transparent shadow-none!"
            />
          </div>

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
                  <Code className="h-3 w-3" />
                  {taskMode === 'coding' ? 'Coding' : 'Default'}
                </button>
                <span className="text-muted-foreground/50">·</span>
                <div className="flex items-center gap-2 text-sm text-muted-foreground px-2 h-8">
                  {(() => {
                    const agent = CODING_AGENTS.find((a) => a.value === selectedAgent)
                    return agent ? (
                      <>
                        <agent.icon className="w-4 h-4" />
                        <span>{agent.label}</span>
                      </>
                    ) : null
                  })()}
                  <span className="text-muted-foreground/50">·</span>
                  <Select value={selectedModel} onValueChange={setSelectedModel}>
                    <SelectTrigger className="h-7 border-0 shadow-none px-1 py-0 text-sm text-muted-foreground hover:text-foreground bg-transparent focus:ring-0 gap-1 w-auto min-w-[120px]">
                      {(() => {
                        const current = codebuddyModels.find((m) => m.id === selectedModel)
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
                      {codebuddyModels.map((m) => {
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
                {(!installDependencies || maxDuration !== maxSandboxDuration || keepAlive) && (
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
                )}
              </div>

              {/* Right side: Action Icons and Submit Button */}
              <div className="flex items-center gap-2 shrink-0">
                {/* Buttons */}
                <div className="flex items-center gap-2">
                  <TooltipProvider delayDuration={1500} skipDelayDuration={1500}>
                    <Tooltip>
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
                    </Tooltip>

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
                        <p>MCP Servers</p>
                      </TooltipContent>
                    </Tooltip>

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
                  </TooltipProvider>

                  <Button
                    type="submit"
                    disabled={isSubmitting || !prompt.trim()}
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
