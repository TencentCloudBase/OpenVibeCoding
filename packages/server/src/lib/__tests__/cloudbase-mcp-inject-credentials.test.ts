/**
 * createInjectCredentials 单元测试
 *
 * 覆盖：
 *   - 缺 envId → 返回 undefined
 *   - 永久密钥 (camSecretId/Key) → 不调 issueTempCredentials
 *   - 无永久密钥 → 调 issueTempCredentials 拿临时密钥
 *   - 凭证查询失败 → 抛错
 *   - 沙箱响应非 success → 抛错
 *   - 401/403 → 调 on401（SDK runtime 用）
 *   - workspaceFolderPaths 注入与不注入两种 body 格式
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock 依赖（vi.hoisted 确保变量在 vi.mock factory 之前已初始化） ─────
const { findByUserIdMock, findByTaskIdMock, issueTempCredentialsMock } = vi.hoisted(() => ({
  findByUserIdMock: vi.fn(),
  findByTaskIdMock: vi.fn(),
  issueTempCredentialsMock: vi.fn(),
}))

vi.mock('../../db/index.js', () => ({
  getDb: () => ({
    userResources: {
      findByUserId: findByUserIdMock,
      findByTaskId: findByTaskIdMock,
    },
  }),
}))

vi.mock('../../middleware/auth.js', () => ({
  issueTempCredentials: issueTempCredentialsMock,
}))

import { createInjectCredentials } from '../cloudbase-mcp.js'

beforeEach(() => {
  findByUserIdMock.mockReset()
  findByTaskIdMock.mockReset()
  findByTaskIdMock.mockResolvedValue(null)
  issueTempCredentialsMock.mockReset()
})

function makeFetch(handler: (path: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(handler)
}

function makeOkResponse(body: unknown = { success: true }, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Matches createInjectCredentials envId/userId guards on user_resources rows. */
function mockUserResource(
  overrides: {
    userId?: string
    envId?: string
    camSecretId?: string | null
    camSecretKey?: string | null
  } = {},
) {
  return {
    userId: 'u1',
    envId: 'env-1',
    camSecretId: null,
    camSecretKey: null,
    ...overrides,
  }
}

describe('createInjectCredentials', () => {
  it('uses permanent credentials when camSecretId/camSecretKey present', async () => {
    findByUserIdMock.mockResolvedValue(mockUserResource({ camSecretId: 'AKID-PERM', camSecretKey: 'KEY-PERM' }))
    const fetcher = makeFetch(async () => makeOkResponse())

    const fn = createInjectCredentials({
      userId: 'u1',
      envId: 'env-1',
      conversationId: 'c1',
      sandboxFetch: fetcher,
    })

    await fn()

    // 不应调用 issueTempCredentials
    expect(issueTempCredentialsMock).not.toHaveBeenCalled()

    // 沙箱请求体应含永久 secretId / secretKey
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [path, init] = fetcher.mock.calls[0]
    expect(path).toBe('/api/workspace/env')
    expect(init?.method).toBe('PUT')
    const body = JSON.parse(init!.body as string)
    expect(body.CLOUDBASE_ENV_ID).toBe('env-1')
    expect(body.TENCENTCLOUD_SECRETID).toBe('AKID-PERM')
    expect(body.TENCENTCLOUD_SECRETKEY).toBe('KEY-PERM')
    expect(body.TENCENTCLOUD_SESSIONTOKEN).toBe('') // 永久密钥无 token
    expect(body.conversationId).toBeUndefined()
  })

  it('falls back to issueTempCredentials when no permanent credentials', async () => {
    findByUserIdMock.mockResolvedValue(mockUserResource())
    issueTempCredentialsMock.mockResolvedValue({
      secretId: 'AKID-TEMP',
      secretKey: 'KEY-TEMP',
      sessionToken: 'TOKEN-TEMP',
    })
    const fetcher = makeFetch(async () => makeOkResponse())

    const fn = createInjectCredentials({
      userId: 'u1',
      envId: 'env-1',
      conversationId: 'c1',
      sandboxFetch: fetcher,
    })

    await fn()

    expect(issueTempCredentialsMock).toHaveBeenCalledWith('env-1', 'u1')
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
    expect(body.TENCENTCLOUD_SECRETID).toBe('AKID-TEMP')
    expect(body.TENCENTCLOUD_SESSIONTOKEN).toBe('TOKEN-TEMP')
  })

  it('throws when neither permanent nor temp credentials available', async () => {
    findByUserIdMock.mockResolvedValue(null)
    issueTempCredentialsMock.mockResolvedValue(undefined)
    const fetcher = makeFetch(async () => makeOkResponse())

    const fn = createInjectCredentials({
      userId: 'u1',
      envId: 'env-1',
      conversationId: 'c1',
      sandboxFetch: fetcher,
    })

    await expect(fn()).rejects.toThrow(/Failed to obtain user credentials/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('throws when sandbox returns success=false', async () => {
    findByUserIdMock.mockResolvedValue(mockUserResource({ camSecretId: 'AKID', camSecretKey: 'KEY' }))
    const fetcher = makeFetch(async () => makeOkResponse({ success: false, error: 'env not ready' }))

    const fn = createInjectCredentials({
      userId: 'u1',
      envId: 'env-1',
      conversationId: 'c1',
      sandboxFetch: fetcher,
    })

    await expect(fn()).rejects.toThrow(/env not ready/)
  })

  it('calls on401 callback when sandbox returns 401', async () => {
    findByUserIdMock.mockResolvedValue(mockUserResource({ camSecretId: 'AKID', camSecretKey: 'KEY' }))
    const fetcher = makeFetch(async () => makeOkResponse({}, 401))
    const on401 = vi.fn((status: number) => {
      throw new Error(`AUTH_REQUIRED:${status}`)
    })

    const fn = createInjectCredentials({
      userId: 'u1',
      envId: 'env-1',
      conversationId: 'c1',
      sandboxFetch: fetcher,
      on401,
    })

    await expect(fn()).rejects.toThrow(/AUTH_REQUIRED:401/)
    expect(on401).toHaveBeenCalledWith(401)
  })

  it('includes WORKSPACE_FOLDER_PATHS only when provided', async () => {
    findByUserIdMock.mockResolvedValue(mockUserResource({ camSecretId: 'AKID', camSecretKey: 'KEY' }))
    const fetcher = makeFetch(async () => makeOkResponse())

    // 1. 不传 workspaceFolderPaths
    const fn1 = createInjectCredentials({
      userId: 'u1',
      envId: 'env-1',
      conversationId: 'c1',
      sandboxFetch: fetcher,
    })
    await fn1()
    const body1 = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
    expect(body1.WORKSPACE_FOLDER_PATHS).toBeUndefined()

    // 2. 传了 workspaceFolderPaths
    fetcher.mockClear()
    const fn2 = createInjectCredentials({
      userId: 'u1',
      envId: 'env-1',
      conversationId: 'c1',
      sandboxFetch: fetcher,
      workspaceFolderPaths: '/workspace/abc',
    })
    await fn2()
    const body2 = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
    expect(body2.WORKSPACE_FOLDER_PATHS).toBe('/workspace/abc')
  })
})
