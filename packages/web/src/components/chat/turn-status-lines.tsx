import { Loader2, Rocket, Sparkles, Hammer, Archive, CheckCircle2, XCircle } from 'lucide-react'
import type { AgentPhaseName } from '@coder/shared'
import type { AgentPhaseInfo } from '@/hooks/apply-session-update'
import {
  sandboxPreparingLabel,
  sandboxTerminalLabel,
  refineOutcomeForMode,
  type SandboxLaneState,
} from '@/lib/sandbox-status'

interface TurnStatusLinesProps {
  agentPhase: AgentPhaseInfo
  sandboxMode?: 'shared' | 'isolated' | null
  /** Turn still in flight (streaming or sending). */
  isActive: boolean
  /** Assistant message already has visible content/parts. */
  hasAgentContent: boolean
  className?: string
}

function prettyToolName(name?: string): string {
  if (!name) return ''
  return name.replace(/^mcp__[^_]+__/, '')
}

function StatusLine({
  icon: Icon,
  iconClass,
  label,
  spinning = false,
  muted = false,
}: {
  icon: typeof Rocket
  iconClass: string
  label: string
  spinning?: boolean
  muted?: boolean
}) {
  return (
    <div
      className={`flex items-center gap-2 text-xs ${muted ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}
      aria-live="polite"
    >
      <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${iconClass}`} />
      <span className="truncate">{label}</span>
      {spinning && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60 flex-shrink-0" />}
    </div>
  )
}

function SandboxStatusLine({
  sandbox,
  sandboxMode,
}: {
  sandbox: SandboxLaneState
  sandboxMode?: 'shared' | 'isolated' | null
}) {
  if (sandbox.status === 'idle') return null

  if (sandbox.status === 'preparing') {
    return (
      <StatusLine icon={Rocket} iconClass="text-blue-500" label={sandboxPreparingLabel(sandbox.toolName)} spinning />
    )
  }

  if (sandbox.status === 'failed') {
    return <StatusLine icon={XCircle} iconClass="text-red-500/80" label={sandboxTerminalLabel('failed', sandboxMode)} />
  }

  const outcomeKey = refineOutcomeForMode(sandbox.outcomeKey ?? 'ready', sandbox.lastPrepareToolName, sandboxMode)
  return (
    <StatusLine
      icon={CheckCircle2}
      iconClass="text-green-600 dark:text-green-500"
      label={sandboxTerminalLabel(outcomeKey, sandboxMode)}
    />
  )
}

function AgentActivityLine({
  phase,
  toolName,
  sandbox,
  isActive,
  hasAgentContent,
}: {
  phase: AgentPhaseName | null
  toolName?: string
  sandbox: SandboxLaneState
  isActive: boolean
  hasAgentContent: boolean
}) {
  if (!isActive) return null

  if (phase === 'tool_executing') {
    const label = toolName ? `执行 ${prettyToolName(toolName)}…` : '工具执行中…'
    return <StatusLine icon={Hammer} iconClass="text-orange-500" label={label} spinning />
  }

  if (phase === 'compacting') {
    return <StatusLine icon={Archive} iconClass="text-muted-foreground" label="压缩上下文中…" spinning />
  }

  if (phase === 'model_responding') {
    return <StatusLine icon={Sparkles} iconClass="text-primary" label="模型响应中…" spinning />
  }

  // Sandbox still preparing: no LLM row (avoid "正在生成回复" false positive).
  if (sandbox.status === 'preparing') return null

  // Sandbox done but model has not started streaming yet.
  if (sandbox.status === 'success' || sandbox.status === 'failed') {
    if (!hasAgentContent) {
      const label = sandbox.status === 'failed' ? '等待模型（受限模式）…' : '等待模型响应…'
      return <StatusLine icon={Sparkles} iconClass="text-primary/70" label={label} spinning muted />
    }
  }

  return null
}

/**
 * Two-row turn status: sandbox lifecycle (terminal: reuse / start / fail) + LLM activity.
 */
export function TurnStatusLines({
  agentPhase,
  sandboxMode,
  isActive,
  hasAgentContent,
  className,
}: TurnStatusLinesProps) {
  const sandbox = agentPhase.sandbox
  const showSandbox = sandbox.status !== 'idle'
  const agentLine = AgentActivityLine({
    phase: agentPhase.phase,
    toolName: agentPhase.toolName,
    sandbox,
    isActive,
    hasAgentContent,
  })

  if (!showSandbox && !agentLine) return null

  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      {showSandbox && <SandboxStatusLine sandbox={sandbox} sandboxMode={sandboxMode} />}
      {agentLine}
    </div>
  )
}
