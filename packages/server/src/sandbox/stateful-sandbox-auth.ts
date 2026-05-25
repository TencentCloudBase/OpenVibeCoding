/**
 * AGS instance auth: TCB gateway key + optional instance access token (X-Access-Token).
 *
 * ENABLE_AUTH_MODE=false (default): StartSandboxInstance AuthMode NONE, no X-Access-Token.
 * ENABLE_AUTH_MODE=true: requires TCB_ACCESS_TOKEN (sit_*); gateway requests include X-Access-Token.
 */

export function isStatefulAuthModeEnabled(): boolean {
  return (process.env.ENABLE_AUTH_MODE || '').toLowerCase() === 'true'
}

export function getTcbAccessToken(): string {
  return process.env.TCB_ACCESS_TOKEN?.trim() || ''
}

/** Fail fast when auth is on but instance token is missing. */
export function assertStatefulSandboxAuthConfig(): void {
  if (isStatefulAuthModeEnabled() && !getTcbAccessToken()) {
    throw new Error('ENABLE_AUTH_MODE=true requires TCB_ACCESS_TOKEN (instance sit_* for X-Access-Token)')
  }
}

/** Injected into sandbox business image via PUT /api/workspace/env (not at Start boot). */
export function buildStatefulWorkspaceAuthEnv(): Record<string, string> {
  return { ENABLE_AUTH_MODE: isStatefulAuthModeEnabled() ? 'true' : 'false' }
}
