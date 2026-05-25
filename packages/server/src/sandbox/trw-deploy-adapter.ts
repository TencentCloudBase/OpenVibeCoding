/**
 * 沙箱业务镜像 miniprogram deploy job adapter.
 *
 * As of the 沙箱业务镜像 route refactor (post commit f930f87), the miniprogram deploy
 * surface lives at:
 *
 *   POST /api/jobs/miniprogram-deploy   → start a job
 *   GET  /api/jobs/:jobId                → poll a job (any kind)
 *
 * Sync responses return a Job record directly; long-running responses
 * return HTTP 202 with `{ jobId, status: 'running' }`. Both differ from the
 * older `{ success, async, ... }` envelope this codebase was originally
 * written against. This helper translates the new shape back into the
 * legacy envelope so the MCP tool layer can stay simple and stable.
 */

/** 沙箱业务镜像 Job record returned by /api/jobs/* endpoints. */
export interface TrwJob {
  jobId: string
  kind: 'miniprogram-deploy' | string
  /** Kind-specific action label (e.g. 'preview' | 'upload'). */
  action: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
  /** Successful payload (e.g. miniprogram-ci subPackageInfo + qrcode). */
  result?: unknown
  /** Failure message. */
  error?: string
  /** Tool-specific error code (miniprogram-ci.errCode). */
  errCode?: unknown
  /** Tool-specific error message (miniprogram-ci.errMsg). */
  errMsg?: unknown
  logs: string[]
}

/** Legacy envelope the MCP tool layer consumes. */
export interface LegacyDeployEnvelope {
  /** When set, the tool must return immediately and tell the user to poll. */
  async?: true
  jobId?: string
  /** Final status of a synchronous response. Absent when async=true. */
  success?: boolean
  /** Success payload, mirrors TrwJob.result. */
  result?: unknown
  /** Failure message. */
  error?: string
}

/**
 * Adapt the body of `POST /api/jobs/miniprogram-deploy` (HTTP 200 or 202)
 * into the legacy `{ async / success / result / error }` envelope.
 *
 * - 202 with `{ status: "running", jobId }` → `{ async: true, jobId }`
 * - 200 with TrwJob, status=completed → `{ success: true, result }`
 * - 200 with TrwJob, status=failed → `{ success: false, error, result: { errCode, errMsg, logs } }`
 *
 * If the response body is missing or in an unexpected shape, returns a
 * failure envelope so the caller surfaces something useful to the user.
 */
export function adaptMiniprogramDeployStart(httpStatus: number, body: unknown): LegacyDeployEnvelope {
  if (!body || typeof body !== 'object') {
    return { success: false, error: `Empty or invalid response (HTTP ${httpStatus})` }
  }

  const obj = body as Record<string, unknown>

  // 202 — running job, hand back jobId for polling.
  if (httpStatus === 202 || obj.status === 'running') {
    if (typeof obj.jobId === 'string') {
      return { async: true, jobId: obj.jobId }
    }
    return {
      success: false,
      error: 'Async response missing jobId',
    }
  }

  // 200 — finished job.
  const job = obj as Partial<TrwJob>
  if (job.status === 'completed') {
    return { success: true, result: job.result }
  }
  if (job.status === 'failed') {
    return {
      success: false,
      error: job.error || 'Deploy failed',
      result: {
        errCode: job.errCode,
        errMsg: job.errMsg,
        logs: job.logs,
      },
    }
  }

  // Unknown shape — pass body through under success:false so caller can see it.
  return {
    success: false,
    error: `Unexpected response shape (HTTP ${httpStatus})`,
    result: body,
  }
}

/**
 * Adapt the body of `GET /api/jobs/:jobId` into a flat status payload the
 * MCP tool layer can stringify and return to the user.
 *
 * The MCP tool used to return raw body content unchanged, so we keep the
 * existing shape (just bubbled up untouched) — but we strip the verbose
 * `kind` discriminator that isn't useful at the caller end.
 */
export function adaptDeployJobStatus(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const job = body as Partial<TrwJob>
  return {
    jobId: job.jobId,
    action: job.action,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result,
    error: job.error,
    errCode: job.errCode,
    errMsg: job.errMsg,
    logs: job.logs,
  }
}
