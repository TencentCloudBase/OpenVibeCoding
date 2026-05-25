import { useState, useRef, useImperativeHandle, forwardRef } from 'react'

interface TerminalProps {
  taskId: string
  className?: string
  isActive?: boolean
  isMobile?: boolean
}

export interface TerminalRef {
  clear: () => void
  getTerminalText: () => string
}

export const Terminal = forwardRef<TerminalRef, TerminalProps>(function Terminal(
  { taskId: _taskId, className: _className, isActive: _isActive, isMobile: _isMobile },
  ref,
) {
  const [text, setText] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    clear: () => setText(''),
    getTerminalText: () => text,
  }))

  return (
    <div ref={containerRef} className="h-full bg-black text-green-400 p-2 font-mono text-xs overflow-y-auto">
      <div className="text-muted-foreground">Terminal (stub) - not yet connected</div>
    </div>
  )
})
