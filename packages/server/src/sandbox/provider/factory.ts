/**
 * Stateful sandbox provider factory (single backend on this branch).
 */

import type { SandboxProvider } from './types.js'
import { statefulProvider } from './stateful-provider.js'

let cached: SandboxProvider | null = null

export function getSandboxProvider(): SandboxProvider {
  if (!cached) cached = statefulProvider
  return cached
}

/** Only for tests — reset the cached provider. */
export function __resetSandboxProviderCacheForTests(): void {
  cached = null
}
