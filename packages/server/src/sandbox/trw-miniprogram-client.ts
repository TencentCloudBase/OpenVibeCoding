/**
 * TRW vibecoding miniprogram deploy HTTP client (shared by Stateful MCP + OpenCode middleware).
 *
 * TRW routes (ENABLE_VIBECODING):
 *   POST /api/jobs/miniprogram-deploy
 *   GET  /api/jobs/:jobId
 *
 * Legacy paths removed: /api/miniprogram/deploy, /api/miniprogram/deploy/status
 */

import { adaptDeployJobStatus, adaptMiniprogramDeployStart, type LegacyDeployEnvelope } from './trw-deploy-adapter.js'

export type TrwHttp = (path: string, init?: RequestInit) => Promise<Response>

export interface MiniprogramDeployRequest {
  appid: string
  privateKey: string
  action: 'preview' | 'upload'
  projectPath: string
  version?: string
  description?: string
  robot?: number
}

export type MiniprogramDeployOutcome =
  | { ok: true; envelope: LegacyDeployEnvelope; httpStatus: number }
  | { ok: false; message: string; httpStatus: number; result?: unknown }

function trwErrorMessage(raw: unknown, httpStatus: number): string {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const detail = r.detail ?? r.error ?? r.message ?? r.title
    if (typeof detail === 'string' && detail.length > 0) return detail
  }
  return `HTTP ${httpStatus}`
}

/** Start miniprogram deploy; adapts TRW Job / 202 body to legacy MCP envelope. */
export async function startTrwMiniprogramDeploy(
  http: TrwHttp,
  params: MiniprogramDeployRequest,
): Promise<MiniprogramDeployOutcome> {
  const res = await http('/api/jobs/miniprogram-deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appid: params.appid,
      privateKey: params.privateKey,
      action: params.action,
      projectPath: params.projectPath,
      version: params.version,
      description: params.description,
      robot: params.robot,
    }),
    signal: AbortSignal.timeout(120_000),
  })

  const raw = (await res.json().catch(() => null)) as unknown
  if (!res.ok && res.status !== 202) {
    return {
      ok: false,
      httpStatus: res.status,
      message: trwErrorMessage(raw, res.status),
      result: raw,
    }
  }

  return {
    ok: true,
    httpStatus: res.status,
    envelope: adaptMiniprogramDeployStart(res.status, raw),
  }
}

/** Poll deploy job status (GET /api/jobs/:jobId). */
export async function pollTrwMiniprogramJob(
  http: TrwHttp,
  jobId: string,
): Promise<{ ok: boolean; httpStatus: number; body: unknown }> {
  const res = await http(`/api/jobs/${encodeURIComponent(jobId)}`, {
    signal: AbortSignal.timeout(30_000),
  })
  const raw = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      body: raw ?? { error: true, message: trwErrorMessage(raw, res.status) },
    }
  }
  return { ok: true, httpStatus: res.status, body: adaptDeployJobStatus(raw) }
}

/** JSON string for MCP middleware tools from a deploy start outcome. */
export function miniprogramStartToJson(outcome: MiniprogramDeployOutcome): string {
  if (!outcome.ok) {
    return JSON.stringify({
      error: true,
      status: outcome.httpStatus,
      message: outcome.message,
      result: outcome.result,
    })
  }

  const body = outcome.envelope
  if (body.async) {
    return JSON.stringify({
      async: true,
      jobId: body.jobId,
      message: '部署仍在进行中，请稍后使用 getDeployJobStatus 工具查询结果',
    })
  }
  if (!body.success) {
    return JSON.stringify({
      error: true,
      message: body.error || (body.result as { errMsg?: string } | undefined)?.errMsg || 'Deploy failed',
      result: body.result,
    })
  }
  return JSON.stringify(body)
}
