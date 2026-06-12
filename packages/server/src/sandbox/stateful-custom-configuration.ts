/**
 * Helpers for StartSandboxInstance / UpdateSandboxTool CustomConfiguration.
 * Production injects GIT_ARCHIVE via workspace/env after health — not at Start.
 * Describe may return read-only fields (e.g. ImageDigest) that Start rejects.
 */

export type StatefulEnvVar = { Name: string; Value: string }

const START_CUSTOM_CONFIGURATION_KEYS = [
  'Image',
  'ImageRegistryType',
  'Command',
  'Ports',
  'Resources',
  'Probe',
  'Env',
] as const

/** Tool template fields accepted by StartSandboxInstance (no Env). */
export function pickStartCustomConfigurationFromTool(
  toolCustomConfiguration: Record<string, unknown>,
): Record<string, unknown> {
  return pickStartCustomConfigurationFields(toolCustomConfiguration)
}

function pickStartCustomConfigurationFields(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of START_CUSTOM_CONFIGURATION_KEYS) {
    if (key in source && source[key] !== undefined) {
      out[key] = source[key]
    }
  }
  return out
}

/** Merge instance env into tool template fields accepted by StartSandboxInstance. */
export function mergeInstanceEnvIntoToolConfiguration(
  toolCustomConfiguration: Record<string, unknown>,
  instanceEnv: StatefulEnvVar[],
): Record<string, unknown> {
  const base = pickStartCustomConfigurationFields(toolCustomConfiguration)
  if (!instanceEnv.length) return base
  return { ...base, Env: instanceEnv }
}
