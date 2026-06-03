import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
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
import type { Connector } from '@/lib/session/types'
import { toast } from 'sonner'
import { useEffect, useState, useRef } from 'react'
import { useConnectors } from '@/components/connectors-provider'
import { Loader2, Plus, X, Eye, EyeOff, Pencil, Server } from 'lucide-react'
import BrowserbaseIcon from '@/components/icons/browserbase-icon'
import Context7Icon from '@/components/icons/context7-icon'
import ConvexIcon from '@/components/icons/convex-icon'
import FigmaIcon from '@/components/icons/figma-icon'
import HuggingFaceIcon from '@/components/icons/huggingface-icon'
import LinearIcon from '@/components/icons/linear-icon'
import NotionIcon from '@/components/icons/notion-icon'
import PlaywrightIcon from '@/components/icons/playwright-icon'
import SupabaseIcon from '@/components/icons/supabase-icon'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  connectorDialogViewAtom,
  editingConnectorAtom,
  selectedPresetAtom,
  serverTypeAtom,
  envVarsAtom,
  visibleEnvVarsAtom,
  customHeadersAtom,
  visibleCustomHeadersAtom,
  isEditingAtom,
  resetDialogStateAtom,
  setEditingConnectorActionAtom,
  startAddingConnectorAtom,
  selectPresetActionAtom,
  addCustomServerAtom,
  goBackFromFormAtom,
  onSuccessActionAtom,
  clearPresetActionAtom,
  type PresetConfig,
} from '@/lib/atoms/connector-dialog'

interface ConnectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnectorSaved?: (connector: Connector) => void | Promise<void>
  onCancelEdit?: () => void
  initialView?: 'list' | 'presets'
}

type FormState = {
  success: boolean
  message: string
  errors: Record<string, string>
}

const initialState: FormState = {
  success: false,
  message: '',
  errors: {},
}

const PRESETS: PresetConfig[] = [
  {
    name: 'Browserbase',
    type: 'STDIO',
    command: 'npx',
    args: ['@browserbasehq/mcp'],
    envKeys: ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'],
  },
  {
    name: 'Context7',
    type: 'HTTP',
    url: 'https://mcp.context7.com/mcp',
  },
  {
    name: 'Convex',
    type: 'STDIO',
    command: 'npx',
    args: ['-y', 'convex@latest', 'mcp', 'start'],
  },
  {
    name: 'Figma',
    type: 'HTTP',
    url: 'https://mcp.figma.com/mcp',
  },
  {
    name: 'Hugging Face',
    type: 'HTTP',
    url: 'https://hf.co/mcp',
  },
  {
    name: 'Linear',
    type: 'SSE',
    url: 'https://mcp.linear.app/sse',
  },
  {
    name: 'Notion',
    type: 'HTTP',
    url: 'https://mcp.notion.com/mcp',
  },
  {
    name: 'Playwright',
    type: 'STDIO',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
  {
    name: 'Supabase',
    type: 'HTTP',
    url: 'https://mcp.supabase.com/mcp',
  },
]

export function ConnectorDialog({
  open,
  onOpenChange,
  onConnectorSaved,
  onCancelEdit,
  initialView = 'list',
}: ConnectorDialogProps) {
  const {
    connectors,
    refreshConnectors,
    addConnector,
    updateConnector,
    deleteConnector,
    isLoading: connectorsLoading,
  } = useConnectors()
  const [loadingConnectors, setLoadingConnectors] = useState<Set<string>>(new Set())

  // Jotai atoms
  const [view, setView] = useAtom(connectorDialogViewAtom)
  const editingConnector = useAtomValue(editingConnectorAtom)
  const isEditing = useAtomValue(isEditingAtom)
  const [serverType, setServerType] = useAtom(serverTypeAtom)
  const [envVars, setEnvVars] = useAtom(envVarsAtom)
  const selectedPreset = useAtomValue(selectedPresetAtom)
  const [visibleEnvVars, setVisibleEnvVars] = useAtom(visibleEnvVarsAtom)
  const [customHeaders, setCustomHeaders] = useAtom(customHeadersAtom)
  const [visibleCustomHeaders, setVisibleCustomHeaders] = useAtom(visibleCustomHeadersAtom)
  const resetDialogState = useSetAtom(resetDialogStateAtom)
  const setEditingConnectorAction = useSetAtom(setEditingConnectorActionAtom)
  const startAddingConnector = useSetAtom(startAddingConnectorAtom)
  const selectPresetAction = useSetAtom(selectPresetActionAtom)
  const addCustomServer = useSetAtom(addCustomServerAtom)
  const goBackFromForm = useSetAtom(goBackFromFormAtom)
  const onSuccessAction = useSetAtom(onSuccessActionAtom)
  const clearPreset = useSetAtom(clearPresetActionAtom)

  // Form state managed locally (replaces useActionState)
  const [createState, setCreateState] = useState<FormState>(initialState)
  const [updateState, setUpdateState] = useState<FormState>(initialState)
  const [createPending, setCreatePending] = useState(false)
  const [updatePending, setUpdatePending] = useState(false)

  // Use the appropriate state and action based on whether we're editing
  const state = isEditing ? updateState : createState
  const setState = isEditing ? setUpdateState : setCreateState
  const pending = isEditing ? updatePending : createPending
  const setPending = isEditing ? setUpdatePending : setCreatePending

  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [testPending, setTestPending] = useState(false)
  const [connectionVerified, setConnectionVerified] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // Reset view when dialog opens (skip if already editing an existing connector)
  useEffect(() => {
    if (open && !editingConnector) {
      resetDialogState()
      setConnectionVerified(false)
      setCreateState(initialState)
      setUpdateState(initialState)
      setCreatePending(false)
      setUpdatePending(false)
      if (initialView === 'presets') {
        startAddingConnector()
      }
    }
  }, [open, initialView, resetDialogState, startAddingConnector, editingConnector])

  // Initialize connectionVerified when entering form view
  useEffect(() => {
    if (view === 'form') {
      setConnectionVerified(isEditing)
    }
  }, [view, isEditing])

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '' }])
  }

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index))
    // Update visible indices after removal
    const newVisible = new Set<number>()
    visibleEnvVars.forEach((i) => {
      if (i < index) {
        newVisible.add(i)
      } else if (i > index) {
        newVisible.add(i - 1)
      }
    })
    setVisibleEnvVars(newVisible)
  }

  const updateEnvVar = (index: number, field: 'key' | 'value', value: string) => {
    const newEnvVars = [...envVars]
    newEnvVars[index][field] = value
    setEnvVars(newEnvVars)
  }

  const addHeaderVar = () => {
    setCustomHeaders([...customHeaders, { key: '', value: '' }])
  }

  const removeHeaderVar = (index: number) => {
    setCustomHeaders(customHeaders.filter((_, i) => i !== index))
    // Update visible indices after removal
    const newVisible = new Set<number>()
    visibleCustomHeaders.forEach((i) => {
      if (i < index) {
        newVisible.add(i)
      } else if (i > index) {
        newVisible.add(i - 1)
      }
    })
    setVisibleCustomHeaders(newVisible)
  }

  const updateHeaderVar = (index: number, field: 'key' | 'value', value: string) => {
    const newHeaders = [...customHeaders]
    newHeaders[index][field] = value
    setCustomHeaders(newHeaders)
  }

  const toggleHeaderVisibility = (index: number) => {
    const newVisible = new Set(visibleCustomHeaders)
    if (newVisible.has(index)) {
      newVisible.delete(index)
    } else {
      newVisible.add(index)
    }
    setVisibleCustomHeaders(newVisible)
  }

  const handleToggleConnectorStatus = async (id: string, currentStatus: 'connected' | 'disconnected') => {
    const newStatus = currentStatus === 'connected' ? 'disconnected' : 'connected'
    updateConnector(id, { status: newStatus })
    toast.success(`Connector ${newStatus === 'connected' ? 'connected' : 'disconnected'}`)
  }

  const handleDelete = async () => {
    if (!editingConnector) return

    setIsDeleting(true)
    try {
      deleteConnector(editingConnector.id)
      toast.success('Connector deleted successfully')
      // Go back to list view
      onSuccessAction()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete MCP server')
    } finally {
      setIsDeleting(false)
      setShowDeleteDialog(false)
    }
  }

  const handleTestConnection = async () => {
    setTestPending(true)
    try {
      const form = formRef.current
      if (!form) {
        toast.error('Form not found')
        setConnectionVerified(false)
        return
      }
      const formData = new FormData(form)
      const baseUrl = String(formData.get('baseUrl') || '')
      const command = String(formData.get('command') || '')
      const args = String(formData.get('args') || '')
      const headersObj = customHeaders.reduce(
        (acc, { key, value }) => {
          if (key && value) acc[key] = value
          return acc
        },
        {} as Record<string, string>,
      )

      if (serverType === 'HTTP' || serverType === 'SSE') {
        if (!baseUrl) {
          toast.error('Base URL is required to test connection')
          setConnectionVerified(false)
          return
        }
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 8000)
        try {
          if (serverType === 'SSE') {
            // SSE MCP server: open an event-stream connection to verify reachability
            const sseHeaders = new Headers({
              Accept: 'text/event-stream',
            })
            Object.entries(headersObj).forEach(([k, v]) => {
              sseHeaders.set(k, v)
            })
            const response = await fetch(baseUrl, {
              method: 'GET',
              headers: sseHeaders,
              signal: controller.signal,
            })
            clearTimeout(timeoutId)
            if (response.ok) {
              const contentType = response.headers.get('content-type') || ''
              if (contentType.includes('text/event-stream')) {
                toast.success('SSE connection successful')
                setConnectionVerified(true)
                setState(initialState)
              } else {
                toast.error('Connected but response is not a valid SSE stream')
                setConnectionVerified(false)
              }
            } else {
              const body = await response.text().catch(() => '')
              console.error('[SSE test] server error:', response.status, body.slice(0, 500))
              toast.error(`SSE connection failed: ${response.status} ${response.statusText}`)
              setConnectionVerified(false)
            }
          } else {
            // HTTP MCP server: POST JSON-RPC initialize
            const initHeaders = new Headers({
              'content-type': 'application/json; charset=utf-8',
              Accept: 'application/json',
            })
            Object.entries(headersObj).forEach(([k, v]) => {
              initHeaders.set(k, v)
            })
            const response = await fetch(baseUrl, {
              method: 'POST',
              headers: initHeaders,
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 0,
                method: 'initialize',
                params: {
                  protocolVersion: '2025-03-26',
                  capabilities: {
                    prompts: {},
                    resources: {},
                    tools: {},
                  },
                  clientInfo: {
                    name: 'streamable-http-client',
                    version: '1.0.0',
                  },
                },
              }),
              signal: controller.signal,
            })
            clearTimeout(timeoutId)
            if (response.ok) {
              toast.success('Connection successful')
              setConnectionVerified(true)
              setState(initialState)
            } else {
              toast.error(`Connection failed: ${response.status} ${response.statusText}`)
              setConnectionVerified(false)
            }
          }
        } catch (err) {
          clearTimeout(timeoutId)
          if (err instanceof Error && err.name === 'AbortError') {
            toast.error('Connection timed out')
          } else {
            toast.error(err instanceof Error ? err.message : 'Connection failed')
          }
          setConnectionVerified(false)
        }
      } else {
        if (!command) {
          toast.error('Command is required to test connection')
          setConnectionVerified(false)
          return
        }
        toast.info('Local server connection cannot be tested from the browser')
      }
    } finally {
      setTestPending(false)
    }
  }

  const toggleEnvVarVisibility = (index: number) => {
    const newVisible = new Set(visibleEnvVars)
    if (newVisible.has(index)) {
      newVisible.delete(index)
    } else {
      newVisible.add(index)
    }
    setVisibleEnvVars(newVisible)
  }

  const getConnectorIcon = (connector: {
    name: string
    type: string
    baseUrl?: string | null
    command?: string | null
  }) => {
    const lowerName = connector.name.toLowerCase()
    const url = connector.baseUrl?.toLowerCase() || ''
    const cmd = connector.command?.toLowerCase() || ''

    if (lowerName.includes('browserbase') || cmd.includes('browserbasehq') || cmd.includes('@browserbasehq/mcp')) {
      return <BrowserbaseIcon className="h-8 w-8 flex-shrink-0" />
    }
    if (lowerName.includes('context7') || url.includes('context7.com')) {
      return <Context7Icon className="h-8 w-8 flex-shrink-0" />
    }
    if (lowerName.includes('convex') || cmd.includes('convex') || url.includes('convex')) {
      return <ConvexIcon className="h-8 w-8 flex-shrink-0" />
    }
    if (lowerName.includes('figma') || url.includes('figma.com')) {
      return <FigmaIcon className="h-8 w-8 flex-shrink-0" />
    }
    if (lowerName.includes('hugging') || lowerName.includes('huggingface') || url.includes('hf.co')) {
      return <HuggingFaceIcon className="h-8 w-8 flex-shrink-0" />
    }
    if (lowerName.includes('linear') || url.includes('linear.app')) {
      return <LinearIcon className="h-8 w-8 flex-shrink-0" />
    }
    if (lowerName.includes('notion') || url.includes('notion.com')) {
      return <NotionIcon className="h-8 w-8 flex-shrink-0" />
    }
    if (lowerName.includes('playwright') || cmd.includes('playwright') || cmd.includes('@playwright/mcp')) {
      return <PlaywrightIcon className="h-8 w-8 flex-shrink-0" />
    }
    if (lowerName.includes('supabase') || url.includes('supabase.com')) {
      return <SupabaseIcon className="h-8 w-8 flex-shrink-0" />
    }

    return <Server className="h-8 w-8 flex-shrink-0 text-muted-foreground" />
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(val) => {
          if (!val) {
            if (view !== 'list' && !isEditing) {
              // In add-mode sub-views, click X to go back to list instead of closing the dialog
              resetDialogState()
              return
            }
            if (isEditing) {
              onCancelEdit?.()
            }
            resetDialogState()
          }
          onOpenChange(val)
        }}
      >
        <DialogContent className="w-[800px] max-w-[90vw] max-h-[80vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {view === 'list' && 'MCP Servers'}
              {view === 'presets' && 'Add MCP Server'}
              {view === 'form' && (isEditing ? 'Edit MCP Server' : 'Add MCP Server')}
            </DialogTitle>
            <DialogDescription>
              {view === 'list' && 'Manage your Model Context Protocol servers.'}
              {view === 'presets' && 'Choose a preset or add a custom server.'}
              {view === 'form' && 'Allow agents to reference other apps and services for more context.'}
            </DialogDescription>
          </DialogHeader>

          {view === 'list' ? (
            <div className="space-y-3 py-4 overflow-y-auto flex-1 max-h-[60vh]">
              {connectorsLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Card key={i} className="flex flex-row items-center justify-between p-4">
                      <div className="flex items-start space-x-4 flex-1">
                        <div className="w-full space-y-2">
                          <div className="h-4 bg-muted animate-pulse rounded w-1/4"></div>
                          <div className="h-3 bg-muted animate-pulse rounded w-3/4"></div>
                        </div>
                      </div>
                      <div className="w-12 h-6 bg-muted animate-pulse rounded-full"></div>
                    </Card>
                  ))}
                </div>
              ) : connectors.length === 0 ? (
                <Card className="p-6 text-center">
                  <p className="text-sm text-muted-foreground">No MCP servers configured yet.</p>
                </Card>
              ) : (
                connectors.map((connector) => (
                  <Card key={connector.id} className="flex flex-row items-center justify-between p-3">
                    <div className="flex items-center space-x-3 flex-1 min-w-0">
                      {getConnectorIcon(connector)}
                      <div className="flex-1 min-w-0">
                        <h4 className="font-semibold text-sm">{connector.name}</h4>
                        {connector.description && (
                          <p className="text-xs text-muted-foreground truncate">{connector.description}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEditingConnectorAction(connector)}
                      >
                        <Pencil className="h-4 w-4 text-muted-foreground" />
                      </Button>
                      <Switch
                        checked={connector.status === 'connected'}
                        disabled={loadingConnectors.has(connector.id)}
                        onCheckedChange={() => handleToggleConnectorStatus(connector.id, connector.status)}
                      />
                    </div>
                  </Card>
                ))
              )}
              <div className="flex justify-end pt-4">
                <Button type="button" variant="default" onClick={() => startAddingConnector()}>
                  Add MCP Server
                </Button>
              </div>
            </div>
          ) : view === 'presets' ? (
            <div className="space-y-4 overflow-y-auto max-h-[60vh]">
              <div className="grid grid-cols-3 gap-6">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    className="flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-muted transition-colors cursor-pointer"
                    onClick={() => selectPresetAction(preset)}
                    type="button"
                  >
                    {preset.name === 'Browserbase' ? (
                      <BrowserbaseIcon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : preset.name === 'Context7' ? (
                      <Context7Icon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : preset.name === 'Convex' ? (
                      <ConvexIcon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : preset.name === 'Figma' ? (
                      <FigmaIcon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : preset.name === 'Hugging Face' ? (
                      <HuggingFaceIcon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : preset.name === 'Linear' ? (
                      <LinearIcon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : preset.name === 'Notion' ? (
                      <NotionIcon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : preset.name === 'Playwright' ? (
                      <PlaywrightIcon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : preset.name === 'Supabase' ? (
                      <SupabaseIcon style={{ width: 48, height: 48 }} className="flex-shrink-0" />
                    ) : null}
                    <span className="text-sm font-medium text-center">{preset.name}</span>
                  </button>
                ))}
              </div>
              <Button variant="outline" className="w-full" onClick={() => addCustomServer()}>
                Add Custom MCP Server
              </Button>
            </div>
          ) : (
            <div className="space-y-4 overflow-y-auto max-h-[60vh]">
              <form
                ref={formRef}
                onChange={() => setConnectionVerified(false)}
                onSubmit={async (e) => {
                  e.preventDefault()
                  setPending(true)
                  setState(initialState)

                  if ((serverType === 'HTTP' || serverType === 'SSE') && !connectionVerified) {
                    const msg = 'Please test the connection before adding this MCP server'
                    toast.error(msg)
                    setState({ success: false, message: msg, errors: { connection: msg } })
                    setPending(false)
                    return
                  }

                  const formData = new FormData(e.currentTarget)
                  const envObj = envVars.reduce(
                    (acc, { key, value }) => {
                      if (key && value) acc[key] = value
                      return acc
                    },
                    {} as Record<string, string>,
                  )
                  const headersObj = customHeaders.reduce(
                    (acc, { key, value }) => {
                      if (key && value) acc[key] = value
                      return acc
                    },
                    {} as Record<string, string>,
                  )

                  const now = Date.now()
                  const connectorData: Connector = {
                    id:
                      isEditing && editingConnector
                        ? editingConnector.id
                        : `conn_${now}_${Math.random().toString(36).slice(2, 8)}`,
                    userId: 'local',
                    name: String(formData.get('name') || ''),
                    description: String(formData.get('description') || '') || null,
                    type: serverType,
                    baseUrl:
                      selectedPreset?.type === 'HTTP' || selectedPreset?.type === 'SSE'
                        ? selectedPreset.url
                        : (formData.get('baseUrl') as string) || null,
                    oauthClientId: String(formData.get('oauthClientId') || '') || null,
                    oauthClientSecret: String(formData.get('oauthClientSecret') || '') || null,
                    command:
                      selectedPreset?.type === 'STDIO'
                        ? selectedPreset.command
                        : (formData.get('command') as string) || null,
                    args:
                      selectedPreset?.type === 'STDIO'
                        ? (selectedPreset.args ?? null)
                        : (formData.get('args') as string)?.trim().split(/\s+/).filter(Boolean) || null,
                    env: Object.keys(envObj).length > 0 ? envObj : null,
                    headers: Object.keys(headersObj).length > 0 ? headersObj : null,
                    status: 'connected',
                    createdAt: isEditing && editingConnector ? editingConnector.createdAt : now,
                    updatedAt: now,
                  }

                  try {
                    if (isEditing && editingConnector) {
                      updateConnector(editingConnector.id, connectorData)
                      toast.success('Connector updated successfully')
                      await onConnectorSaved?.(connectorData)
                    } else {
                      addConnector(connectorData)
                      toast.success('Connector created successfully')
                      await onConnectorSaved?.(connectorData)
                    }
                    await refreshConnectors()
                    onSuccessAction()
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Failed to save connector'
                    toast.error(message)
                    setState({ success: false, message, errors: {} })
                  } finally {
                    setPending(false)
                  }
                }}
                className="space-y-4"
              >
                {selectedPreset && (
                  <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
                    {selectedPreset.name === 'Browserbase' ? (
                      <BrowserbaseIcon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : selectedPreset.name === 'Context7' ? (
                      <Context7Icon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : selectedPreset.name === 'Convex' ? (
                      <ConvexIcon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : selectedPreset.name === 'Figma' ? (
                      <FigmaIcon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : selectedPreset.name === 'Hugging Face' ? (
                      <HuggingFaceIcon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : selectedPreset.name === 'Linear' ? (
                      <LinearIcon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : selectedPreset.name === 'Notion' ? (
                      <NotionIcon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : selectedPreset.name === 'Playwright' ? (
                      <PlaywrightIcon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : selectedPreset.name === 'Supabase' ? (
                      <SupabaseIcon style={{ width: 32, height: 32 }} className="flex-shrink-0" />
                    ) : null}
                    <div className="flex-1">
                      <p className="text-sm font-medium">Configuring {selectedPreset.name}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        clearPreset()
                        setConnectionVerified(false)
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    name="name"
                    placeholder="Example MCP Server"
                    defaultValue={editingConnector?.name || selectedPreset?.name || ''}
                    required
                  />
                  {state.errors?.name && <p className="text-sm text-red-600">{state.errors.name}</p>}
                </div>

                {!selectedPreset && !isEditing && (
                  <div className="space-y-2">
                    <Label>Server Type</Label>
                    <Select
                      value={serverType}
                      onValueChange={(value) => {
                        setServerType(value as 'HTTP' | 'SSE' | 'STDIO')
                        setConnectionVerified(false)
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select server type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="HTTP">HTTP</SelectItem>
                        <SelectItem value="SSE">SSE</SelectItem>
                        <SelectItem value="STDIO">STDIO</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {serverType === 'HTTP' || serverType === 'SSE' ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="baseUrl">Base URL</Label>
                      <Input
                        id="baseUrl"
                        name="baseUrl"
                        type="url"
                        placeholder="https://api.example.com"
                        defaultValue={editingConnector?.baseUrl || selectedPreset?.url || ''}
                        required={serverType === 'HTTP' || serverType === 'SSE'}
                        disabled={!!selectedPreset}
                      />
                      {state.errors?.baseUrl && <p className="text-sm text-red-600">{state.errors.baseUrl}</p>}
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center">
                        <Label className="flex-1">Custom Headers (optional)</Label>
                        <Button type="button" size="sm" variant="outline" className="w-32" onClick={addHeaderVar}>
                          <Plus className="h-4 w-4 mr-1" />
                          Add Header
                        </Button>
                      </div>
                      {customHeaders.length > 0 && (
                        <div className="space-y-2">
                          {customHeaders.map((header, index) => (
                            <div key={index} className="flex gap-2">
                              <Input
                                placeholder="Header-Name"
                                value={header.key}
                                onChange={(e) => updateHeaderVar(index, 'key', e.target.value)}
                                className="flex-1"
                              />
                              <div className="relative flex-1">
                                <Input
                                  placeholder="value"
                                  type={visibleCustomHeaders.has(index) ? 'text' : 'password'}
                                  value={header.value}
                                  onChange={(e) => updateHeaderVar(index, 'value', e.target.value)}
                                  className="pr-10"
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="absolute right-0 top-0 h-full hover:bg-transparent"
                                  onClick={() => toggleHeaderVisibility(index)}
                                >
                                  {visibleCustomHeaders.has(index) ? (
                                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                                  ) : (
                                    <Eye className="h-4 w-4 text-muted-foreground" />
                                  )}
                                </Button>
                              </div>
                              <Button type="button" variant="ghost" size="icon" onClick={() => removeHeaderVar(index)}>
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="command">Command</Label>
                      <Input
                        id="command"
                        name="command"
                        placeholder="Command"
                        defaultValue={
                          editingConnector ? (editingConnector.command ?? '') : (selectedPreset?.command ?? '')
                        }
                        required={serverType === 'STDIO'}
                        disabled={!!selectedPreset}
                      />
                      {state.errors?.command && <p className="text-sm text-red-600">{state.errors.command}</p>}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="args">Arguments</Label>
                      <Input
                        id="args"
                        name="args"
                        placeholder="Arguments (space-separated)"
                        defaultValue={
                          editingConnector
                            ? (editingConnector.args?.join(' ') ?? '')
                            : (selectedPreset?.args?.join(' ') ?? '')
                        }
                        disabled={!!selectedPreset}
                      />
                    </div>
                  </>
                )}

                <div className="space-y-2">
                  <div className="flex items-center">
                    <Label className="flex-1">
                      Environment Variables{' '}
                      {selectedPreset && selectedPreset.envKeys && selectedPreset.envKeys.length > 0
                        ? ''
                        : '(optional)'}
                    </Label>
                    <Button type="button" size="sm" variant="outline" className="w-32" onClick={addEnvVar}>
                      <Plus className="h-4 w-4 mr-1" />
                      Add Variable
                    </Button>
                  </div>
                  {envVars.length > 0 && (
                    <div className="space-y-2">
                      {envVars.map((envVar, index) => (
                        <div key={index} className="flex gap-2">
                          <Input
                            placeholder="KEY"
                            value={envVar.key}
                            onChange={(e) => updateEnvVar(index, 'key', e.target.value)}
                            disabled={selectedPreset?.envKeys?.includes(envVar.key)}
                            className="flex-1"
                          />
                          <div className="relative flex-1">
                            <Input
                              placeholder="value"
                              type={visibleEnvVars.has(index) ? 'text' : 'password'}
                              value={envVar.value}
                              onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                              className="pr-10"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="absolute right-0 top-0 h-full hover:bg-transparent"
                              onClick={() => toggleEnvVarVisibility(index)}
                            >
                              {visibleEnvVars.has(index) ? (
                                <EyeOff className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <Eye className="h-4 w-4 text-muted-foreground" />
                              )}
                            </Button>
                          </div>
                          {!selectedPreset?.envKeys?.includes(envVar.key) && (
                            <Button type="button" variant="ghost" size="icon" onClick={() => removeEnvVar(index)}>
                              <X className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {(serverType === 'HTTP' || serverType === 'SSE') && (
                  <Accordion type="single" collapsible className="w-full">
                    <AccordionItem value="advanced" className="border-none">
                      <AccordionTrigger className="text-sm py-2">Advanced Settings</AccordionTrigger>
                      <AccordionContent className="space-y-4 pt-2">
                        <div className="space-y-2">
                          <Label htmlFor="oauthClientId">OAuth Client ID (optional)</Label>
                          <Input id="oauthClientId" name="oauthClientId" placeholder="OAuth Client ID (optional)" />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="oauthClientSecret">OAuth Client Secret (optional)</Label>
                          <Input
                            id="oauthClientSecret"
                            name="oauthClientSecret"
                            type="password"
                            placeholder="OAuth Client Secret (optional)"
                          />
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                )}

                <div className="flex justify-between items-center pt-4">
                  {isEditing && (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setShowDeleteDialog(true)
                      }}
                      disabled={pending || isDeleting || testPending}
                    >
                      Delete
                    </Button>
                  )}
                  <div className={`flex flex-col items-end space-y-1 ${isEditing ? 'ml-auto' : 'w-full'}`}>
                    {state.errors?.connection && <p className="text-sm text-red-600">{state.errors.connection}</p>}
                    <div className={`flex space-x-2 ${isEditing ? '' : 'w-full justify-end'}`}>
                      {!isEditing && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setConnectionVerified(false)
                            setCreateState(initialState)
                            setUpdateState(initialState)
                            goBackFromForm()
                          }}
                          disabled={pending || isDeleting || testPending}
                        >
                          Back
                        </Button>
                      )}
                      {serverType !== 'STDIO' && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            handleTestConnection()
                          }}
                          disabled={pending || isDeleting || testPending}
                        >
                          {testPending ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Connecting...
                            </>
                          ) : (
                            'Connect'
                          )}
                        </Button>
                      )}
                      <Button type="submit" disabled={pending || isDeleting || testPending}>
                        {pending ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {isEditing ? 'Saving...' : 'Creating...'}
                          </>
                        ) : isEditing ? (
                          'Save Changes'
                        ) : (
                          'Add MCP Server'
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP Server</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{editingConnector?.name}&quot;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
