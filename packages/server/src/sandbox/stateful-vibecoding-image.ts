/**
 * Vibecoding sandbox image resolution for sandbox infra CreateSandboxTool / UpdateSandboxTool.
 *
 * Default: team public TCR (开箱即用). Override with STATEFUL_SANDBOX_IMAGE or tenant TCR_IMAGE.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Public CCR namespace for OpenVibeCoding / vibecoding (see code_sandbox/一条龙.md §账号与 CCR). */
export const VIBECODING_PUBLIC_TCR_REGISTRY = 'ccr.ccs.tencentyun.com'
export const VIBECODING_PUBLIC_TCR_NAMESPACE = 'tcb-sandbox-public-cbe88d'

/** Repository name under public namespace (一条龙 CCR repo 名一般为 tcb-sandbox-ags；公开 ns 用团队约定名). */
export const VIBECODING_PUBLIC_TCR_REPO =
  process.env.STATEFUL_PUBLIC_TCR_REPOSITORY?.trim() || 'tcb-sandbox-public-cbe88d'

/** Default tag when URI has no `:tag` (一条龙格式 YYMMDD-HHMM-…-vibecoding). */
export const VIBECODING_PUBLIC_TCR_DEFAULT_TAG =
  process.env.STATEFUL_SANDBOX_IMAGE_TAG?.trim() || '260521-1705-vibecoding'

/** GHCR source used by pnpm setup:tcr before pushing to tenant TCR. */
export const VIBECODING_GHCR_IMAGE = 'ghcr.io/yhsunshining/cloudbase-workspace:260515-01342a05'

export function buildPublicVibecodingTcrImage(tag: string = VIBECODING_PUBLIC_TCR_DEFAULT_TAG): string {
  return `${VIBECODING_PUBLIC_TCR_REGISTRY}/${VIBECODING_PUBLIC_TCR_NAMESPACE}/${VIBECODING_PUBLIC_TCR_REPO}:${tag}`
}

/** Team public vibecoding image on TCR (no per-tenant setup:tcr required for first CreateTool). */
export const DEFAULT_STATEFUL_SANDBOX_IMAGE = buildPublicVibecodingTcrImage()

const REPO_ROOT_ENV_LOCAL = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.local')

let cachedEnvLocal: Record<string, string> | null = null

function loadRepoRootEnvLocal(): Record<string, string> {
  if (cachedEnvLocal) return cachedEnvLocal
  cachedEnvLocal = {}
  if (!existsSync(REPO_ROOT_ENV_LOCAL)) return cachedEnvLocal
  for (const line of readFileSync(REPO_ROOT_ENV_LOCAL, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    const v = t.slice(eq + 1).trim()
    if (k) cachedEnvLocal[k] = v
  }
  return cachedEnvLocal
}

/** Append :tag when env value is registry/namespace/repo only. */
function normalizeImageUri(uri: string): string {
  const t = uri.trim()
  if (!t) return ''
  if (t.includes('@')) return t
  const lastSlash = t.lastIndexOf('/')
  const repoPart = lastSlash >= 0 ? t.slice(lastSlash + 1) : t
  if (!repoPart.includes(':')) {
    return `${t}:${VIBECODING_PUBLIC_TCR_DEFAULT_TAG}`
  }
  return t
}

/** Image URI for CreateSandboxTool: explicit env → tenant TCR → public TCR default. */
export function resolveStatefulSandboxImage(): string {
  const fromProcess = process.env.STATEFUL_SANDBOX_IMAGE?.trim() || process.env.TCR_IMAGE?.trim() || ''
  if (fromProcess) return normalizeImageUri(fromProcess)

  const local = loadRepoRootEnvLocal()
  const fromLocal = local.STATEFUL_SANDBOX_IMAGE?.trim() || local.TCR_IMAGE?.trim() || ''
  if (fromLocal) return normalizeImageUri(fromLocal)

  return DEFAULT_STATEFUL_SANDBOX_IMAGE
}

/** Sandbox infra ImageRegistryType for CustomConfiguration.Image. */
export function resolveStatefulImageRegistryType(image: string): string {
  const explicit = process.env.STATEFUL_IMAGE_REGISTRY?.trim()
  if (explicit) return explicit
  if (image.includes('ccr.ccs.tencentyun.com')) return 'personal'
  return 'personal'
}

export function formatMissingStatefulSandboxImageError(): string {
  return [
    'Missing STATEFUL_SANDBOX_IMAGE (vibecoding image URI for sandbox infra CreateSandboxTool).',
    `Expected public default: ${DEFAULT_STATEFUL_SANDBOX_IMAGE}`,
    'Set STATEFUL_SANDBOX_IMAGE or run pnpm setup:tcr for a private TCR copy.',
  ].join(' ')
}
