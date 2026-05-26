/**
 * Web terminal via TRW ttyd — virtual port 7681 only, proxied as /api/tasks/:id/preview/7681/.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TASK_LOG } from '@coder/shared'
import { pushLiveTaskLog } from '@/lib/push-live-task-log'

/** Must match packages/server/src/sandbox/ttyd-preview.ts TTYD_VIRTUAL_PORT */
const TTYD_PREVIEW_PORT = 7681

interface TerminalProps {
  taskId: string
  className?: string
  isActive?: boolean
  isMobile?: boolean
  sandboxReady?: boolean
}

export interface TerminalRef {
  clear: () => void
  getTerminalText: () => string
}

type TerminalGateStatus = 'idle' | 'no_sandbox' | 'checking' | 'ready' | 'starting' | 'unavailable' | 'error'

type TerminalHealthPayload = {
  status?: string
  retryable?: boolean
}

const POLL_MS = 2000
const MAX_POLLS = 30

function notifyTtydResize(iframe: HTMLIFrameElement | null) {
  if (!iframe?.contentWindow) return
  try {
    iframe.contentWindow.dispatchEvent(new Event('resize'))
  } catch {
    // ignore cross-origin (should be same-origin)
  }
}

export const Terminal = forwardRef<TerminalRef, TerminalProps>(function Terminal(
  { taskId, className, isActive, sandboxReady = true },
  ref,
) {
  const [gateStatus, setGateStatus] = useState<TerminalGateStatus>('idle')
  const [iframeEpoch, setIframeEpoch] = useState(0)
  const pollRef = useRef(0)
  const probeGenerationRef = useRef(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const platformLogRef = useRef<'none' | 'ready' | 'unavailable'>('none')
  const gateStatusRef = useRef<TerminalGateStatus>('idle')
  gateStatusRef.current = gateStatus

  const iframeSrc = `/api/tasks/${taskId}/preview/${TTYD_PREVIEW_PORT}/`

  useImperativeHandle(ref, () => ({
    clear: () => {
      probeGenerationRef.current += 1
      setIframeEpoch((n) => n + 1)
      if (isActive && sandboxReady) void runProbeLoop()
    },
    getTerminalText: () => '',
  }))

  const checkTerminal = useCallback(async (): Promise<TerminalGateStatus> => {
    if (!sandboxReady) return 'no_sandbox'
    try {
      const res = await fetch(`/api/tasks/${taskId}/terminal-health`, { credentials: 'include' })
      const data = (await res.json()) as TerminalHealthPayload
      switch (data.status) {
        case 'ready':
          return 'ready'
        case 'starting':
          return 'starting'
        case 'no_sandbox':
          return 'no_sandbox'
        case 'not_found':
        case 'unavailable':
          return data.retryable ? 'starting' : 'unavailable'
        case 'error':
          return data.retryable ? 'starting' : 'error'
        default:
          return data.retryable ? 'starting' : 'unavailable'
      }
    } catch {
      return 'starting'
    }
  }, [sandboxReady, taskId])

  const runProbeLoop = useCallback(
    async (options?: { force?: boolean }) => {
      // Parent re-renders (e.g. refreshTasks) must not tear down a working iframe.
      if (!options?.force && gateStatusRef.current === 'ready') return

      const generation = ++probeGenerationRef.current
      pollRef.current = 0
      setGateStatus(sandboxReady ? 'checking' : 'no_sandbox')
      if (!sandboxReady) return

      while (pollRef.current < MAX_POLLS) {
        if (generation !== probeGenerationRef.current) return

        const status = await checkTerminal()
        if (generation !== probeGenerationRef.current) return

        if (status === 'ready') {
          setGateStatus('ready')
          if (platformLogRef.current !== 'ready') {
            platformLogRef.current = 'ready'
            pushLiveTaskLog(taskId, { type: 'success', message: TASK_LOG.PLATFORM_TERMINAL_READY })
          }
          return
        }
        if (status === 'no_sandbox') {
          setGateStatus('no_sandbox')
          platformLogRef.current = 'none'
          return
        }
        if (status === 'unavailable' || status === 'error') {
          setGateStatus(status)
          if (platformLogRef.current !== 'unavailable') {
            platformLogRef.current = 'unavailable'
            pushLiveTaskLog(taskId, { type: 'error', message: TASK_LOG.PLATFORM_TERMINAL_UNAVAILABLE })
          }
          return
        }

        setGateStatus('starting')
        pollRef.current += 1
        await new Promise((r) => setTimeout(r, POLL_MS))
      }
      if (generation === probeGenerationRef.current) {
        setGateStatus('unavailable')
        if (platformLogRef.current !== 'unavailable') {
          platformLogRef.current = 'unavailable'
          pushLiveTaskLog(taskId, { type: 'error', message: TASK_LOG.PLATFORM_TERMINAL_UNAVAILABLE })
        }
      }
    },
    [checkTerminal, sandboxReady, taskId],
  )

  useEffect(() => {
    if (!isActive) {
      probeGenerationRef.current += 1
      setGateStatus('idle')
      return
    }
    void runProbeLoop()
  }, [isActive, runProbeLoop, taskId, sandboxReady])

  useEffect(() => {
    probeGenerationRef.current += 1
    platformLogRef.current = 'none'
    setIframeEpoch((n) => n + 1)
  }, [taskId])

  useEffect(() => {
    if (gateStatus !== 'ready' || !isActive) return
    const onResize = () => notifyTtydResize(iframeRef.current)
    window.addEventListener('resize', onResize)
    const t = window.setTimeout(onResize, 100)
    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(t)
    }
  }, [gateStatus, isActive, iframeEpoch])

  const handleRetry = () => {
    setIframeEpoch((n) => n + 1)
    probeGenerationRef.current += 1
    platformLogRef.current = 'none'
    void runProbeLoop({ force: true })
  }

  if (!isActive) {
    return null
  }

  if (gateStatus === 'no_sandbox') {
    return (
      <div
        className={`h-full min-h-0 bg-black text-muted-foreground p-4 font-mono text-xs flex flex-col items-center justify-center gap-2 text-center ${className ?? ''}`}
      >
        <p>沙箱未就绪，终端暂不可用</p>
        <p className="text-[10px] opacity-70">请先发送一条消息，待沙箱启动后再打开 Terminal</p>
      </div>
    )
  }

  if (gateStatus === 'checking' || gateStatus === 'starting' || gateStatus === 'idle') {
    return (
      <div
        className={`h-full min-h-0 bg-black text-muted-foreground p-4 font-mono text-xs flex flex-col items-center justify-center gap-2 ${className ?? ''}`}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        <p>{gateStatus === 'checking' ? '正在检查 Web 终端…' : '正在启动 Web 终端（ttyd）…'}</p>
      </div>
    )
  }

  if (gateStatus === 'unavailable' || gateStatus === 'error') {
    return (
      <div
        className={`h-full min-h-0 bg-black text-muted-foreground p-4 font-mono text-xs flex flex-col items-center justify-center gap-3 text-center ${className ?? ''}`}
      >
        <p>{gateStatus === 'error' ? '无法连接沙箱终端' : 'Web 终端暂不可用'}</p>
        <p className="text-[10px] opacity-70 max-w-md">
          终端走沙箱虚拟口 7681。若长时间不可用，点「重试」或先发一条消息等待沙箱就绪。
        </p>
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={handleRetry}>
          <RefreshCw className="h-3 w-3 mr-1" />
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className={`absolute inset-0 bg-black ${className ?? ''}`}>
      <iframe
        ref={iframeRef}
        key={`${taskId}-${iframeEpoch}`}
        src={iframeSrc}
        title="Web Terminal"
        className="size-full border-0 bg-black"
        allow="clipboard-read; clipboard-write"
        onLoad={() => notifyTtydResize(iframeRef.current)}
      />
    </div>
  )
})
