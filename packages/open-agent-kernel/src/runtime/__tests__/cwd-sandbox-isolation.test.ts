/**
 * cwd 与 sandbox 文件操作隔离性测试。
 *
 * 设计结论（OAK 架构）：
 *   - AgentConfig.cwd 只影响 Claude Agent SDK 子进程的 host 工作目录：
 *     skills 发现、项目级 CLAUDE.md、SDK projects/<cwd-hash>/ 路径派生。
 *   - 内置 Read/Write/Bash 等 host 文件工具默认禁用；sandbox 文件操作走
 *     mcp__sandbox__* MCP，路径相对于沙箱 workspace root（镜像约定 /home/user/…），
 *     与 host cwd 无关。
 */

import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SandboxInstance } from '../../sandbox/types.js'
import { buildClaudeQueryOptions } from '../agent-builder.js'

const baseConfig = {
  envId: 'test-env',
  model: { id: 'glm-5.1', apiKey: 'test-api-key' },
}

function createMockSandboxInstance(): SandboxInstance {
  return {
    id: 'mock-sandbox',
    request: async () => new Response('ok'),
    release: async () => {},
  }
}

describe('cwd vs sandbox file isolation', () => {
  it('disables built-in host file tools when sandbox is wired (tools=[])', () => {
    const userCwd = path.join(os.tmpdir(), 'oak-cwd-isolation-test')
    const { options } = buildClaudeQueryOptions(
      { ...baseConfig, cwd: userCwd, sandbox: { enabled: true } },
      { sandboxInstance: createMockSandboxInstance() },
    )

    expect(options.cwd).toBe(userCwd)
    expect(options.tools).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
  })

  it('sandbox MCP is injected separately from host cwd', () => {
    const userCwd = path.join(os.tmpdir(), 'oak-cwd-isolation-test-2')
    const { options } = buildClaudeQueryOptions(
      { ...baseConfig, cwd: userCwd, sandbox: { enabled: true } },
      { sandboxInstance: createMockSandboxInstance() },
    )

    expect(options.mcpServers?.sandbox).toBeDefined()
    expect(options.cwd).toBe(userCwd)
  })

  it('skills + sandbox: only Skill tool enabled, not host Read/Write/Bash', () => {
    const userCwd = os.tmpdir()
    const { options } = buildClaudeQueryOptions(
      { ...baseConfig, cwd: userCwd, skills: { enabled: 'all' }, sandbox: { enabled: true } },
      { sandboxInstance: createMockSandboxInstance() },
    )

    expect(options.tools).toEqual(['Skill'])
    expect(options.tools).not.toContain('Read')
    expect(options.tools).not.toContain('Write')
    expect(options.tools).not.toContain('Bash')
  })

  it('without sandbox, built-in file tools remain disabled (empty tools list)', () => {
    const userCwd = os.tmpdir()
    const { options } = buildClaudeQueryOptions({ ...baseConfig, cwd: userCwd })

    expect(options.cwd).toBe(userCwd)
    expect(options.tools).toEqual([])
  })
})
