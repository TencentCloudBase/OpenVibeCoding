/**
 * Augmented tool: getDeployJobStatus
 *
 * 查询 publishMiniprogram 异步返回的 jobId。
 *
 * 历史背景：原本在已删除的 sandbox-mcp-proxy.ts 中硬编码（DEPLOY_STATUS_*）。
 */

import type { McpPolicy } from './_index.js'

export const policy: McpPolicy = {
  description: 'Query miniprogram deploy job status by jobId',

  augment: {
    description: '查询小程序发布/预览任务的状态。当 publishMiniprogram 返回 async=true 时使用此工具轮询结果。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'publishMiniprogram 返回的 jobId' },
      },
      required: ['jobId'],
    },
  },

  async use(ctx) {
    const jobId = ctx.input.jobId as string
    try {
      const res = await ctx.extra.sandboxFetch(`/api/miniprogram/deploy/status?jobId=${encodeURIComponent(jobId)}`, {
        signal: AbortSignal.timeout(30_000),
      })
      const body = (await res.json().catch(() => null)) as any
      return JSON.stringify(body ?? { error: true, status: res.status })
    } catch (e: any) {
      return JSON.stringify({ error: true, message: e.message })
    }
  },
}
