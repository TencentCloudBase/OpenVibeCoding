import { describe, expect, it } from 'vitest'
import { rewritePreviewPaths, shouldRewritePreviewBody } from '../preview-proxy.js'

describe('rewritePreviewPaths', () => {
  it('rewrites vite base asset URLs to task preview proxy', () => {
    const html =
      '<script type="module" src="/preview/5173/@vite/client"></script>' + '<link href="/preview/5173/src/main.css">'
    const out = rewritePreviewPaths(html, 'task-1', '5173')
    expect(out).toContain('/api/tasks/task-1/preview/5173/@vite/client')
    expect(out).not.toContain('"/preview/5173/')
  })

  it('does not rewrite ttyd virtual port HTML', () => {
    expect(shouldRewritePreviewBody('text/html', '7681')).toBe(false)
    expect(shouldRewritePreviewBody('text/html', '5173')).toBe(true)
  })
})
