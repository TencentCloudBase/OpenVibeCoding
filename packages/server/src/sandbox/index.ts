/**
 * Sandbox module — stateful cloud sandbox (feature/stateful-infra).
 */

export { getSandboxProvider, __resetSandboxProviderCacheForTests } from './provider/factory.js'
export type {
  SandboxProvider,
  SandboxInstance,
  SandboxProgressCallback,
  SandboxProgressMessage,
  SessionEnv,
  McpClientBundle,
  ToolOverrideConfig,
} from './provider/types.js'
export { statefulProvider } from './provider/stateful-provider.js'
export { ensureStatefulTool, deleteStatefulToolForEnv, STATEFUL_TOOL_SETTINGS_KEY } from './ensure-stateful-tool.js'
export {
  getTaskSandbox,
  runCommandInSandbox,
  downloadFileFromSandbox,
  readFileFromSandbox,
  writeFileToSandbox,
  detectPackageManager,
  ensureDevServerStarted,
} from './task-sandbox.js'

export {
  archiveToGit,
  deleteArchiveDirectory,
  deleteArchiveDirectories,
  deleteArchiveBranch,
  deleteArchiveBranches,
  deleteConversationViaSandbox,
  isGitArchiveConfigured,
  type GitArchiveConfig,
} from './git-archive.js'

export { overrideTools, type ToolOverrideConfig as LegacyToolOverrideConfig, type ToolResult, type ToolContext } from './tool-override.js'

export {
  statefulReadTextFile,
  statefulReadBinaryFile,
  statefulWriteTextFile,
  statefulRunCommand,
} from './stateful/e2b-native-client.js'
