/**
 * CloudBase MCP middleware 入口。
 *
 * 复用通用框架 `lib/mcp-middleware`，声明 cloudbase 特有的 Extra 字段，
 * 并把本目录注册为 policy 扫描根。
 *
 * 路由层 `routes/cloudbase-mcp.ts` 与沙箱层 `sandbox/sandbox-mcp-proxy.ts`
 * 都直接 import 本模块。
 *
 * 环境变量：
 *   CLOUDBASE_MCP_DISABLE_TOOLS  逗号分隔的工具黑名单（不暴露给 AI）
 *   CLOUDBASE_MCP_ENABLE_TOOLS   逗号分隔的工具白名单（非空时只暴露这些）
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPolicyLoader, runWithPolicy, runAugmentedTool, isToolHidden } from '../../../lib/mcp-middleware/index.js'
import type { McpContext, McpPolicy as GenericMcpPolicy } from '../../../lib/mcp-middleware/index.js'
import { policy as authPolicy } from './auth.js'
import { policy as cronTaskPolicy } from './cronTask.js'
import { policy as downloadTemplatePolicy } from './downloadTemplate.js'
import { policy as getDeployJobStatusPolicy } from './getDeployJobStatus.js'
import { policy as publishMiniprogramPolicy } from './publishMiniprogram.js'
import { policy as uploadFilesPolicy } from './uploadFiles.js'

/** CloudBase 特有的上下文扩展字段 */
export interface CloudbaseExtra {
  // ── 沙箱访问 ────────────────────────────────────────────────
  /** 沙箱 URL（HTTP 路径前缀） */
  sandboxUrl: string
  /** 沙箱认证 headers */
  sandboxAuth: Record<string, string>
  /**
   * 沙箱请求快捷方式：拼 URL + 合并 sandboxAuth。
   * policy 优先用这个，避免自己拼 URL / 拼 headers。
   */
  sandboxFetch: (path: string, init?: RequestInit) => Promise<Response>
  /** 当前沙箱实例的 conversationId（注入凭证时必填） */
  conversationId?: string

  // ── 凭证注入（auth/login 工具用） ───────────────────────────
  /** 重新注入 CloudBase 凭证到沙箱 */
  injectCredentials?: () => Promise<void>

  // ── 部署相关副作用 ────────────────────────────────────────
  /** uploadFiles 等工具产出 artifact 时的回调（前端展示二维码/链接） */
  onArtifact?: (artifact: {
    title: string
    contentType: 'image' | 'link' | 'json'
    data: string
    metadata?: Record<string, unknown>
  }) => void
  /** 根据 appId 查询小程序部署凭证（publishMiniprogram 用） */
  getMpDeployCredentials?: (appId: string) => Promise<{ appId: string; privateKey: string } | null>

  // ── 任务调度（cronTask 用） ───────────────────────────────
  /** 当前模型 ID（cronTask 创建时复用） */
  currentModel?: string
}

/** 给 policy 作者用的便捷别名 */
export type CloudbaseMcpContext = McpContext<CloudbaseExtra>
export type McpPolicy = GenericMcpPolicy<CloudbaseExtra>

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const parseList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const CLOUDBASE_STATIC_POLICIES: Record<string, McpPolicy> = {
  auth: authPolicy,
  cronTask: cronTaskPolicy,
  downloadTemplate: downloadTemplatePolicy,
  getDeployJobStatus: getDeployJobStatusPolicy,
  publishMiniprogram: publishMiniprogramPolicy,
  uploadFiles: uploadFilesPolicy,
}

const loader = createPolicyLoader<CloudbaseExtra>(
  __dirname,
  'cloudbase-mcp-policies',
  {
    denyList: parseList(process.env.CLOUDBASE_MCP_DISABLE_TOOLS),
    allowList: parseList(process.env.CLOUDBASE_MCP_ENABLE_TOOLS),
  },
  CLOUDBASE_STATIC_POLICIES,
)

export const loadAllPolicies = () => loader.loadAll()
export const listPolicies = () => loader.listPolicies()
export const listAugmentedTools = () => loader.listAugmentedTools()
export const isNativeToolAllowed = (toolName: string) => loader.isToolAllowed(toolName)

/** runWithPolicy 的预绑定版本 */
export function runCloudbasePolicy(
  ctxBase: Omit<CloudbaseMcpContext, 'scratch' | 'callOriginal'>,
  defaultImpl: (input: Record<string, unknown>) => Promise<string>,
  callOriginal: (toolName: string, input: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  return runWithPolicy(loader, ctxBase, defaultImpl, callOriginal)
}

/** runAugmentedTool 的预绑定版本 */
export function runCloudbaseAugmented(
  ctxBase: Omit<CloudbaseMcpContext, 'scratch' | 'callOriginal'>,
  callOriginal: (toolName: string, input: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  return runAugmentedTool(loader, ctxBase, callOriginal)
}

/** isToolHidden 的预绑定版本 */
export function isCloudbaseToolHidden(
  toolName: string,
  base: Omit<CloudbaseMcpContext, 'toolName' | 'input' | 'scratch' | 'callOriginal'>,
): Promise<boolean> {
  return isToolHidden(loader, toolName, base)
}
