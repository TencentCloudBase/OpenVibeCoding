/**
 * Web terminal via 沙箱业务镜像 ttyd — virtual port 7681, proxied as /api/tasks/:id/preview/7681/.
 */

import { forwardRef, useImperativeHandle } from 'react'

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

export const Terminal = forwardRef<TerminalRef, TerminalProps>(function Terminal(
  { taskId, className, isActive, sandboxReady = true },
  ref,
) {
  useImperativeHandle(ref, () => ({
    clear: () => {},
    getTerminalText: () => '',
  }))

  if (!sandboxReady) {
    return (
      <div
        className={`h-full bg-black text-muted-foreground p-2 font-mono text-xs flex items-center justify-center ${className ?? ''}`}
      >
        沙箱未就绪，终端暂不可用
      </div>
    )
  }

  if (!isActive) {
    return <div className={`h-full min-h-0 bg-black ${className ?? ''}`} />
  }

  const src = `/api/tasks/${taskId}/preview/7681/`

  return (
    <iframe
      src={src}
      title="Web Terminal"
      className={`h-full min-h-0 w-full border-0 bg-black ${className ?? ''}`}
      allow="clipboard-read; clipboard-write"
    />
  )
})
