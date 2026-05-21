/**
 * Normalize @cloudbase/manager-node (CloudBaseError) for logs and user-facing text.
 *
 * AGS/Tencent API puts RequestId on the error object, NOT inside Error.message.
 * message is typically `[Action] ${apiMessage}` — using only .message drops requestId.
 */

type ManagerErr = Error & {
  code?: string
  action?: string
  requestId?: string
  data?: unknown
  cause?: unknown
  original?: { RequestId?: string; Code?: string; Message?: string; Error?: { Code?: string; Message?: string } }
}

/** Unwrap Error.cause chains from stateful-provider rethrows. */
export function unwrapManagerApiError(err: unknown): ManagerErr {
  let cur = err as ManagerErr
  for (let i = 0; i < 4; i++) {
    if (pickRequestId(cur) || pickCode(cur) || cur.action) return cur
    const next = cur.cause
    if (!next || typeof next !== 'object') break
    cur = next as ManagerErr
  }
  return cur
}

function pickRequestId(e: ManagerErr | undefined): string | undefined {
  if (!e) return undefined
  return (
    (
      e.requestId ||
      e.original?.RequestId ||
      (e.data && typeof e.data === 'object' && e.data !== null
        ? String((e.data as { RequestId?: string }).RequestId || '')
        : undefined) ||
      undefined
    )?.trim() || undefined
  )
}

function pickCode(e: ManagerErr | undefined): string | undefined {
  if (!e) return undefined
  return e.code || e.original?.Code || e.original?.Error?.Code
}

function pickApiMessage(e: ManagerErr | undefined): string {
  if (!e) return 'Unknown error'
  const fromOriginal = e.original?.Message || e.original?.Error?.Message
  if (fromOriginal) return fromOriginal
  const msg = e.message || ''
  const action = e.action
  if (action && msg.startsWith(`[${action}]`)) {
    return msg.slice(`[${action}]`.length).trim() || msg
  }
  return msg || 'Unknown error'
}

/** Server logs / engineers — pipe-separated, includes optional context. */
export function formatAgsManagerError(err: unknown, context?: string): string {
  const e = unwrapManagerApiError(err)
  const parts: string[] = []
  if (context) parts.push(context)
  const action = e.action
  const apiMsg = pickApiMessage(e)
  parts.push(action ? `[${action}] ${apiMsg}` : apiMsg)
  const code = pickCode(e)
  const requestId = pickRequestId(e)
  if (code) parts.push(`code=${code}`)
  if (requestId) parts.push(`requestId=${requestId}`)
  return parts.filter(Boolean).join(' | ') || String(err)
}

/**
 * End-user chat copy — RequestId on its own line for support escalation.
 */
export function formatAgsUserFacingError(err: unknown): string {
  const e = unwrapManagerApiError(err)
  const action = e.action
  const apiMsg = pickApiMessage(e)
  const code = pickCode(e)
  const requestId = pickRequestId(e)

  const lines: string[] = []
  lines.push(action ? `[${action}] ${apiMsg}` : apiMsg)
  if (code) lines.push(`错误码：${code}`)
  if (requestId) lines.push(`RequestId：${requestId}（报障时请提供此 ID）`)
  return lines.join('\n')
}

export function isAgsRetryableError(err: unknown): boolean {
  const msg = (err as Error)?.message || ''
  return /internal error has occurred/i.test(msg) || /ResourceInsufficient/i.test(msg)
}
