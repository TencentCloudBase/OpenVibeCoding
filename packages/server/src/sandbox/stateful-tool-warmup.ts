/**
 * AGS tool image pull window after CreateSandboxTool / UpdateSandboxTool.
 * See 一条龙.md pitfall #24: immediate StartSandboxInstance → InternalError (~37s).
 */

import type { SandboxProgressCallback } from './provider/types.js'
import { isAgsRetryableError } from './ags-error.js'

const WARMUP_POLL_MS = 10_000
const WARMUP_POLL_MAX = 6

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function emitWarmupProgress(onProgress: SandboxProgressCallback | undefined, round: number, hint?: string): void {
  const suffix = hint ? `（${hint}）` : ''
  onProgress?.({
    phase: 'template_warmup',
    message: `沙箱模板预热中 ${round}/${WARMUP_POLL_MAX}${suffix}...\n`,
  })
}

/** After CreateSandboxTool: short poll window before first StartSandboxInstance. */
export async function waitStatefulToolImageWarmup(onProgress?: SandboxProgressCallback): Promise<void> {
  for (let round = 1; round <= WARMUP_POLL_MAX; round++) {
    emitWarmupProgress(onProgress, round, '云平台拉取镜像')
    await sleep(WARMUP_POLL_MS)
  }
}

/** Start instance; on InternalError poll 10s × up to 6 attempts (一条龙 #24). */
export async function startStatefulInstanceWithWarmup(
  start: () => Promise<string>,
  onProgress?: SandboxProgressCallback,
): Promise<string> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= WARMUP_POLL_MAX; attempt++) {
    try {
      return await start()
    } catch (err) {
      lastErr = err
      if (!isAgsRetryableError(err) || attempt >= WARMUP_POLL_MAX) {
        throw err
      }
      emitWarmupProgress(onProgress, attempt, '镜像尚未就绪，稍后重试')
      await sleep(WARMUP_POLL_MS)
    }
  }
  throw lastErr
}
