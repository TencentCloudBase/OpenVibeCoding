/**
 * Environment file layout (repo root):
 *
 *   .env.example  — committed template / documentation only (no secrets)
 *   .env.local    — generated (init option 1): local dev only
 *   .env.cloud    — generated (init option 2): pnpm deploy:cloud reads + syncs to service
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = process.cwd()

export const ENV_EXAMPLE = resolve(ROOT, '.env.example')
export const ENV_LOCAL = resolve(ROOT, '.env.local')
export const ENV_CLOUD = resolve(ROOT, '.env.cloud')

/** Keys only used on the deploy machine / CLI — not pushed to CloudRun */
export const DEPLOY_ONLY_KEYS = new Set(['TCB_TOKEN'])

/** Written by init when user skips ASK_USER_BASE_URL before first deploy */
export const ASK_USER_BASE_URL_PLACEHOLDER = 'https://YOUR-SERVICE.run.tcloudbase.com'

/** True when URL is empty, init placeholder, or obviously local-only */
export function isAskUserBaseUrlUnset(url) {
  const v = (url || '').trim()
  if (!v) return true
  if (v === ASK_USER_BASE_URL_PLACEHOLDER) return true
  if (/YOUR-SERVICE/i.test(v)) return true
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(v)) return true
  return false
}

export function normalizeAskUserBaseUrl(url) {
  const v = (url || '').trim()
  if (!v) return ''
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}

/**
 * Parse KEY=VALUE lines (no export prefix). Last duplicate key wins.
 * @param {string} [filePath]
 */
export function loadEnvFile(filePath = ENV_LOCAL) {
  const env = {}
  if (!filePath || !existsSync(filePath)) return env
  readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key) env[key] = value
  })
  return env
}

export function saveEnvVar(filePath, key, value) {
  const env = loadEnvFile(filePath)
  if (env[key] !== undefined) {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').map((line) => {
      if (line.trim().startsWith(`${key}=`)) return `${key}=${value}`
      return line
    })
    writeFileSync(filePath, lines.join('\n'))
  } else {
    const content = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
    const newline = Object.keys(env).length > 0 ? '\n' : ''
    writeFileSync(filePath, `${content}${newline}${key}=${value}`)
  }
}

/** Runtime vars for CloudRun container (from .env.cloud) */
export function cloudRuntimeEnvFromFile(filePath = ENV_CLOUD) {
  const raw = loadEnvFile(filePath)
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (DEPLOY_ONLY_KEYS.has(key)) continue
    if (value === '') continue
    out[key] = value
  }
  return out
}
