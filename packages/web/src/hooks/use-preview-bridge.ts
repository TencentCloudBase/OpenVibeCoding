import { useCallback, useEffect, useRef, useState } from 'react'

// ─── Types ──────────────────────────────────────────────────────────────────

export type HmrStatus = 'unknown' | 'connected' | 'disconnected' | 'reconnecting'

export interface PreviewErrorPayload {
  source?: string
  message?: string
  stack?: string
  componentStack?: string
  url?: string
}

export interface UsePreviewBridgeOptions {
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  previewUrl: string | null
  enabled?: boolean
  // ── Event callbacks (iframe → platform) ──
  onReady?: (url: string) => void
  onUrlChanged?: (url: string, path: string) => void
  onBuildError?: (message: string, stack?: string) => void
  onBuildCleared?: () => void
  onHmrStatus?: (status: 'connected' | 'disconnected' | 'reconnecting') => void
  onHmrUpdateStart?: () => void
  onHmrUpdateDone?: () => void
  onError?: (error: PreviewErrorPayload) => void
}

export interface PreviewBridge {
  // ── Fire-and-forget commands (platform → iframe) ──
  navigate: (path: string) => void
  navigateBack: () => void
  navigateForward: () => void
  reload: () => void
  // ── RPC (platform → iframe → platform) ──
  ping: (timeoutMs?: number) => Promise<number>
  callEval: (code: string, timeoutMs?: number) => Promise<unknown>
  // ── Reactive state ──
  hmrStatus: HmrStatus
  iframeReady: boolean
}

// ─── RPC internals ──────────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let rpcSeq = 0

// ─── Hook ───────────────────────────────────────────────────────────────────

export function usePreviewBridge(options: UsePreviewBridgeOptions): PreviewBridge {
  const {
    iframeRef,
    previewUrl,
    enabled = true,
    onReady,
    onUrlChanged,
    onBuildError,
    onBuildCleared,
    onHmrStatus,
    onHmrUpdateStart,
    onHmrUpdateDone,
    onError,
  } = options

  const [hmrStatus, setHmrStatus] = useState<HmrStatus>('unknown')
  const [iframeReady, setIframeReady] = useState(false)

  // Stable refs for callbacks so the message listener doesn't re-register on every render
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  // RPC pending map (persists across renders, cleaned up on unmount)
  const pendingRef = useRef(new Map<string, PendingRpc>())

  // Reset state when previewUrl changes
  useEffect(() => {
    setIframeReady(false)
    setHmrStatus('unknown')
  }, [previewUrl])

  // ── Send helper ───────────────────────────────────────────────────────────

  const send = useCallback(
    (type: string, payload?: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage({ type, ...payload }, '*')
    },
    [iframeRef],
  )

  // ── Message listener ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled || !previewUrl) return

    let iframeOrigin: string | null = null
    try {
      const base =
        typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
      iframeOrigin = new URL(previewUrl, base).origin
    } catch {
      iframeOrigin = null
    }

    const onMessage = (e: MessageEvent) => {
      // Only accept messages from the preview iframe
      if (e.source !== iframeRef.current?.contentWindow) return
      if (!e.data || typeof e.data !== 'object') return
      const msg = e.data as { type?: string; [key: string]: unknown }
      if (typeof msg.type !== 'string') return

      // Origin check
      if (iframeOrigin && e.origin !== iframeOrigin) return

      const cb = callbacksRef.current

      switch (msg.type) {
        // ── Lifecycle ──
        case 'preview:ready':
          setIframeReady(true)
          cb.onReady?.(msg.url as string)
          break

        // ── Routing ──
        case 'preview:url-changed':
          cb.onUrlChanged?.(msg.url as string, msg.path as string)
          break

        // ── Build errors ──
        case 'preview:build:error':
          cb.onBuildError?.(msg.message as string, msg.stack as string | undefined)
          break
        case 'preview:build:cleared':
          cb.onBuildCleared?.()
          break

        // ── HMR status ──
        case 'preview:hmr:connected':
          setHmrStatus('connected')
          cb.onHmrStatus?.('connected')
          break
        case 'preview:hmr:disconnected':
          setHmrStatus('disconnected')
          cb.onHmrStatus?.('disconnected')
          break
        case 'preview:hmr:reconnecting':
          setHmrStatus('reconnecting')
          cb.onHmrStatus?.('reconnecting')
          break
        case 'preview:hmr:update-start':
          cb.onHmrUpdateStart?.()
          break
        case 'preview:hmr:update-done':
          cb.onHmrUpdateDone?.()
          break

        // ── Runtime error ──
        case 'preview:error':
          cb.onError?.(msg as unknown as PreviewErrorPayload)
          break

        // ── RPC response ──
        case 'preview:call-result': {
          const requestId = msg.requestId as string | undefined
          const pending = pendingRef.current.get(requestId ?? '')
          if (!pending) break
          pendingRef.current.delete(requestId!)
          if (msg.ok) {
            pending.resolve(msg.value)
          } else {
            pending.reject(new Error((msg.error as string) ?? 'RPC failed'))
          }
          break
        }
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [enabled, previewUrl, iframeRef])

  // ── Cleanup pending RPCs on unmount ───────────────────────────────────────

  useEffect(() => {
    const pending = pendingRef.current
    return () => {
      for (const [, p] of pending) {
        p.reject(new Error('Preview bridge unmounted'))
      }
      pending.clear()
    }
  }, [])

  // ── RPC helper ────────────────────────────────────────────────────────────

  const rpc = useCallback(
    (type: string, payload?: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> => {
      const requestId = `rpc-${Date.now()}-${++rpcSeq}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId)
          reject(new Error(`RPC timeout: ${type}`))
        }, timeoutMs)

        pendingRef.current.set(requestId, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })

        iframeRef.current?.contentWindow?.postMessage({ type, requestId, ...payload }, '*')
      })
    },
    [iframeRef],
  )

  // ── Public API ────────────────────────────────────────────────────────────

  const navigate = useCallback((path: string) => send('platform:navigate', { path }), [send])
  const navigateBack = useCallback(() => send('platform:navigate-back'), [send])
  const navigateForward = useCallback(() => send('platform:navigate-forward'), [send])
  const reload = useCallback(() => send('platform:reload'), [send])

  const ping = useCallback(
    async (timeoutMs = 2000): Promise<number> => {
      const t0 = Date.now()
      await rpc('platform:ping', undefined, timeoutMs)
      return Date.now() - t0
    },
    [rpc],
  )

  const callEval = useCallback(
    async (code: string, timeoutMs = 5000): Promise<unknown> => {
      return rpc('platform:call', { command: 'eval', args: [code] }, timeoutMs)
    },
    [rpc],
  )

  return {
    navigate,
    navigateBack,
    navigateForward,
    reload,
    ping,
    callEval,
    hmrStatus,
    iframeReady,
  }
}
