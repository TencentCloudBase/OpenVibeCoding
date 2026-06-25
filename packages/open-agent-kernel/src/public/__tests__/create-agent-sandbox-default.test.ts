import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agsStatefulSandbox: vi.fn(),
  localRuntimeSandbox: vi.fn(),
  cloudBaseCosLocalWorkspaceStore: vi.fn(),
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
  class MockLocalRuntimeSandbox {
    readonly backend = 'local'

    constructor(opts?: unknown) {
      mocks.localRuntimeSandbox(opts)
    }

    async acquire(): Promise<never> {
      throw new Error('not used in this test')
    }
  }
  class MockCloudBaseCosLocalWorkspaceStore {
    constructor(opts?: unknown) {
      mocks.cloudBaseCosLocalWorkspaceStore(opts)
    }
  }

  return {
    AgsStatefulSandbox: MockAgsStatefulSandbox,
    LocalRuntimeSandbox: MockLocalRuntimeSandbox,
    CloudBaseCosLocalWorkspaceStore: MockCloudBaseCosLocalWorkspaceStore,
  }
})

const { createAgent } = await import('../create-agent.js')

describe('createAgent — default sandbox runtime', () => {
  beforeEach(() => {
    mocks.agsStatefulSandbox.mockClear()
    mocks.localRuntimeSandbox.mockClear()
    mocks.cloudBaseCosLocalWorkspaceStore.mockClear()
    delete process.env.CLOUDBASE_APIKEY
    delete process.env.OAK_SANDBOX_API_KEY
  })

  it('creates default LocalRuntimeSandbox when sandbox is enabled', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
      },
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({ cwd: undefined, workspaceRoot: undefined })
    expect(mocks.agsStatefulSandbox).not.toHaveBeenCalled()
  })

  it('passes cwd and workspaceRoot to LocalRuntimeSandbox', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      cwd: '/tmp/oak-local',
      sandbox: {
        enabled: true,
        workspaceRoot: '/tmp/oak-local',
      },
    })

    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith({ cwd: '/tmp/oak-local', workspaceRoot: '/tmp/oak-local' })
  })

  it('creates AgsStatefulSandbox when provider is ags-stateful', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        provider: 'ags-stateful',
        apiKey: 'sandbox-api-key',
      },
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'sandbox-api-key' })
    expect(mocks.localRuntimeSandbox).not.toHaveBeenCalled()
  })

  it('reads CLOUDBASE_APIKEY for the ags-stateful provider', () => {
    process.env.CLOUDBASE_APIKEY = 'env-sandbox-api-key'

    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      sandbox: {
        enabled: true,
        provider: 'ags-stateful',
      },
    })

    expect(mocks.agsStatefulSandbox).toHaveBeenCalledWith({ apiKey: 'env-sandbox-api-key' })
  })

  it('requires an api key when ags-stateful provider is enabled', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
          provider: 'ags-stateful',
        },
      }),
    ).toThrow(/sandbox\.apiKey/)
  })

  it('allows local mode to explicitly enable cloudbaseTools', () => {
    expect(() =>
      createAgent({
        envId: 'env-test',
        model: 'glm-5.1',
        sandbox: {
          enabled: true,
          cloudbaseTools: true,
        },
      }),
    ).not.toThrow()
  })

  it('configures a CloudBase workspace sync store when local workspaceSnapshot is enabled', () => {
    createAgent({
      envId: 'env-test',
      model: 'glm-5.1',
      credentials: { envId: 'env-test', secretId: 'test-id', secretKey: 'test-key' },
      sandbox: {
        enabled: true,
        workspaceSnapshot: 'enabled',
      },
    })

    expect(mocks.cloudBaseCosLocalWorkspaceStore).toHaveBeenCalledWith({
      credentials: { envId: 'env-test', secretId: 'test-id', secretKey: 'test-key' },
    })
    expect(mocks.localRuntimeSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: undefined,
        workspaceRoot: undefined,
        workspaceSyncStore: expect.any(Object),
      }),
    )
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
