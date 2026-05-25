/**
 * Augmented tool: getDeployJobStatus
 *
 * Poll TRW: GET /api/jobs/:jobId (replaces /api/miniprogram/deploy/status)
 */

import type { McpPolicy } from './_index.js'
import { pollTrwMiniprogramJob } from '../../../sandbox/trw-miniprogram-client.js'

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
      const polled = await pollTrwMiniprogramJob(ctx.extra.sandboxFetch, jobId)
      return JSON.stringify(polled.body ?? { error: true, status: polled.httpStatus })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      return JSON.stringify({ error: true, message })
    }
  },
}
