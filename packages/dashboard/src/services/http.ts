/**
 * 共用 fetch 包装：必须显式传入 envId 与可选 taskId。
 *
 * - URL 自动追加 `?envId=xxx`（已有同名参数则不覆盖）
 * - Header 自动写入 `X-Task-Id`（如果传入）
 *
 * 不再从 jotai store 兜底读取，避免多实例 store 不同步导致丢失。
 */

export interface ApiContext {
  /** CloudBase 环境 ID — 必填。后端 requireUserEnv 用它解析对应凭证。 */
  envId: string
  /** 当前 task ID — 可选。task provision 模式下传入会优先解析 task 级凭证。 */
  taskId?: string
}

function appendQuery(url: string, key: string, value: string): string {
  if (!value) return url
  const hashIdx = url.indexOf('#')
  const head = hashIdx >= 0 ? url.slice(0, hashIdx) : url
  const tail = hashIdx >= 0 ? url.slice(hashIdx) : ''
  const re = new RegExp(`[?&]${key}=`)
  if (re.test(head)) return url
  const sep = head.includes('?') ? '&' : '?'
  return `${head}${sep}${key}=${encodeURIComponent(value)}${tail}`
}

export function tdFetch(ctx: ApiContext, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!ctx.envId) {
    // 显式拒绝：避免静默走 fallback 用户级凭证
    throw new Error('[tdFetch] envId is required')
  }

  let resolvedInput: RequestInfo | URL = input
  if (typeof input === 'string') {
    resolvedInput = appendQuery(input, 'envId', ctx.envId)
  } else if (input instanceof URL) {
    if (!input.searchParams.has('envId')) input.searchParams.set('envId', ctx.envId)
    resolvedInput = input
  }

  const headers = new Headers(init.headers)
  if (ctx.taskId && !headers.has('X-Task-Id')) headers.set('X-Task-Id', ctx.taskId)

  // DEBUG: 打印请求信息
  const reqHeaders: Record<string, string> = {}
  headers.forEach((v, k) => {
    reqHeaders[k] = v
  })
  console.log('[tdFetch] 请求:', init.method || 'GET', resolvedInput.toString())
  console.log('[tdFetch] 请求 headers:', JSON.stringify(reqHeaders, null, 2))
  if (init.body) {
    console.log('[tdFetch] 请求 body:', typeof init.body === 'string' ? init.body : '(non-string body)')
  }

  return fetch(resolvedInput, {
    credentials: 'include',
    ...init,
    headers,
  })
}
