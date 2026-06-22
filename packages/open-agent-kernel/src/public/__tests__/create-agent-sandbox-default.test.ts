import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agsStatefulSandbox: vi.fn(),
}))

vi.mock('../../sandbox/index.js', () => {
  class MockAgsStatefulSandbox {
    readonly backend = 'ags-stateful'

    constructor(opts?: unknown) {
      mocks.agsStatefulSandbox(opts)
    }

    async acquire(): Promise<never> {
      throw new Error('not used in this test')
    }
  }

  return {
    AgsStatefulSandbox: MockAgsStatefulSandbox,
    validateDefaultSandboxRuntimeEnv: vi.fn(),
  }
})

const { createAgent } = await import('../create-agent.js')
const { validateDefaultSandboxRuntimeEnv } = await import('../../sandbox/index.js')

describe('createAgent — default sandbox runtime', () => {
  beforeEach(() => {
    mocks.agsStatefulSandbox.mockClear()
    delete process.env.CLOUDBASE_APIKEY
    process.env.OAK_SANDBOX_IMAGE = 'ccr.test.com/test/sandbox-image:tag'
    process.env.OAK_SANDBOX_TOOL_ROLE_ARN = 'qcs::cam::uin/123456789:roleName/test-sandbox-role'
  })

  afterEach(() => {
    delete process.env.OAK_SANDBOX_IMAGE
    delete process.env.OAK_SANDBOX_TOOL_ROLE_ARN
  })

  it('creates default AgsStatefulSandbox when sandbox is enabled', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        apiKey: 'sandbox-api-key',
      },
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'sandbox-api-key' })
  })

  it('reads CLOUDBASE_APIKEY for the default sandbox runtime', () => {
    process.env.CLOUDBASE_APIKEY = 'env-sandbox-api-key'

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
      },
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'env-sandbox-api-key' })
  })

  it('requires an api key when default sandbox runtime is enabled', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
        },
      }),
    ).toThrow(/sandbox\.apiKey/)
  })

  it('requires sandbox image env when default sandbox runtime is enabled', () => {
    vi.mocked(validateDefaultSandboxRuntimeEnv).mockImplementationOnce(() => {
      throw new Error('Default sandbox requires process.env.OAK_SANDBOX_IMAGE')
    })

    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
          apiKey: 'sandbox-api-key',
        },
      }),
    ).toThrow(/OAK_SANDBOX_IMAGE/)
  })

  it('requires sandbox tool role env when default sandbox runtime is enabled', () => {
    vi.mocked(validateDefaultSandboxRuntimeEnv).mockImplementationOnce(() => {
      throw new Error('Default sandbox requires process.env.OAK_SANDBOX_TOOL_ROLE_ARN')
    })

    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
          apiKey: 'sandbox-api-key',
        },
      }),
    ).toThrow(/OAK_SANDBOX_TOOL_ROLE_ARN/)
  })

  it('keeps custom sandbox runtime untouched', () => {
    const runtime = {
      backend: 'custom',
      async acquire(): Promise<never> {
        throw new Error('not used in this test')
      },
    }

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        runtime,
      },
    })

    expect(mocks.agsStatefulSandbox).not.toHaveBeenCalled()
  })
})
