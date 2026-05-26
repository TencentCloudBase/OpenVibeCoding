/**
 * AGS sandbox instance TTL (StartSandboxInstance.Timeout + CreateSandboxTool.DefaultTimeout).
 *
 * SANDBOX_TTL_SECONDS — positive integer seconds (default 1800 = 30m).
 * Distinct from task.maxDuration / MAX_SANDBOX_DURATION (product limit on tasks; not wired to AGS stop).
 */

export const DEFAULT_SANDBOX_TTL_SECONDS = 30 * 60

export function resolveSandboxTtlSeconds(): number {
  const raw = process.env.SANDBOX_TTL_SECONDS?.trim()
  if (!raw) return DEFAULT_SANDBOX_TTL_SECONDS
  const seconds = Number.parseInt(raw, 10)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('SANDBOX_TTL_SECONDS must be a positive integer (seconds)')
  }
  return seconds
}

/** AGS duration string (e.g. 30m, 1h, 90s). */
export function formatAgsSandboxTimeout(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export function resolveAgsSandboxTimeout(): string {
  return formatAgsSandboxTimeout(resolveSandboxTtlSeconds())
}
