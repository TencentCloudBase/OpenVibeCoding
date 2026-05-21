# SCF 沙箱 Session 共享改造方案

> **已废弃**：`feature/stateful-infra` 已迁移至 **CloudBase AGS Stateful Sandbox + TRW**（`StatefulSandboxProvider`、`ensureStatefulTool`）。下文描述的是旧 SCF 架构，仅供历史对照；新部署见 [setup.md](./setup.md) 与 [architecture.md](./architecture.md) 的 Sandbox 章节。

## 背景

原有架构中，每个 `conversationId` 对应一个独立的 SCF 容器实例（通过 `X-Cloudbase-Session-Id` 标识）。这导致资源消耗大，同一环境下多个会话无法共享状态。

本改造实现：
- **同一 `envId` 下的所有会话共享一个 SCF 容器实例**
- **容器内通过目录级别软隔离不同会话的工作区**
- **同环境下不同会话可以互相访问文件系统**

## 架构对比

### 改造前

```
conversationId → X-Cloudbase-Session-Id → 独立容器实例
                                           ├── /tmp/workspace/{conversationId}/
                                           └── 独立凭证、独立进程
```

每个会话完全隔离，资源消耗 O(n)。

### 改造后

```
envId → X-Cloudbase-Session-Id → 共享容器实例
                                   ├── /tmp/workspace/{envId}/{conversationId_1}/
                                   ├── /tmp/workspace/{envId}/{conversationId_2}/
                                   └── 共享凭证、共享进程空间
```

同一环境下所有会话共享容器，资源消耗 O(1)。

## 核心改动

### 1. Session ID 映射

| Header | 改造前 | 改造后 |
|--------|--------|--------|
| `X-Cloudbase-Session-Id` | `conversationId` | `envId` |
| `X-Conversation-Id` | 无 | `conversationId`（新增） |

### 2. 工作目录结构

```
/tmp/workspace/
├── {envId}/                          # 按环境分组
│   ├── {conversationId_1}/           # 会话 A 的默认工作目录
│   │   ├── src/
│   │   └── package.json
│   └── {conversationId_2}/           # 会话 B 的默认工作目录（可互相访问）
│       └── src/
└── {otherEnvId}/                     # 另一个环境（完全隔离）
    └── {conversationId_3}/
```

### 3. 文件修改清单

#### 3.1 `packages/server/src/sandbox/scf-sandbox-manager.ts`

**改动点**：

```typescript
// getAuthHeaders() - 使用 envId 作为 sessionId，添加 X-Conversation-Id
async getAuthHeaders(): Promise<Record<string, string>> {
  const accessToken = await this.getAccessToken()
  return {
    ...SandboxInstance.buildAuthHeaders(accessToken, this.envId),  // envId 而非 conversationId
    'X-Conversation-Id': this.conversationId,  // 新增
  }
}

// buildSandboxMcpConfig() - 参数调整，传递 envId 作为 scfSessionId
private async buildSandboxMcpConfig(
  functionName: string,
  scfSessionId: string,  // = envId
  conversationId: string,
  sandboxEnvId: string,
): Promise<SandboxInstance['mcpConfig']> {
  const accessToken = await this.getAdminAccessToken()
  const url = `https://${sandboxEnvId}.api.tcloudbasegateway.com/v1/functions/${functionName}/mcp`
  return {
    type: 'http' as const,
    url,
    headers: {
      ...SandboxInstance.buildAuthHeaders(accessToken, scfSessionId),
      'X-Conversation-Id': conversationId,
    },
  }
}

// SCF 并发配置 - 提高并发数
MaximumConcurrencySessionPerInstance: 10,  // 从 1 提高到 10
```

**调用处改动**：
```typescript
// getOrCreate() 和 createNewFunction() 中
const mcpConfig = await this.buildSandboxMcpConfig(functionName, envId, conversationId, instanceDeps.sandboxEnvId)
```

#### 3.2 `packages/server/src/sandbox/sandbox-mcp-proxy.ts`

**改动点**：

```typescript
// SandboxMcpDeps 接口
export interface SandboxMcpDeps {
  baseUrl: string
  scfSessionId: string     // 改名：sessionId → scfSessionId（= envId）
  conversationId: string   // 新增
  // ... 其他字段不变
}

// buildHeaders() - 使用新字段，添加 X-Conversation-Id
async function buildHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return {
    'Content-Type': 'application/json',
    ...SandboxInstance.buildAuthHeaders(token, scfSessionId),
    'X-Conversation-Id': conversationId,
  }
}

// injectCredentials() - body 添加 conversationId
body: JSON.stringify({
  conversationId,  // 新增
  CLOUDBASE_ENV_ID: creds.cloudbaseEnvId,
  // ...
})
```

#### 3.3 `packages/server/src/agent/cloudbase-agent.service.ts`

**改动点**：

```typescript
// actualCwd - 包含 envId
const actualCwd = cwd || `/tmp/workspace/${userContext.envId}/${conversationId}`

// initSandboxWorkspace() - 新增 conversationId 参数，主动创建目录
async function initSandboxWorkspace(
  sandbox: SandboxInstance,
  secret: { envId: string; secretId: string; secretKey: string; token?: string },
  conversationId: string,  // 新增参数
): Promise<string | undefined> {
  try {
    const res = await sandbox.request('/api/session/init', { ... })
    
    if (res.ok) {
      const workspace = `/tmp/workspace/${secret.envId}/${conversationId}`
      
      // 主动创建会话工作目录
      await sandbox.request('/api/tools/bash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: `mkdir -p "${workspace}"`,
          timeout: 5000,
        }),
      })
      
      return workspace
    }
  } catch (e) { ... }
}

// createSandboxMcpClient() 调用
sandboxMcpClient = await createSandboxMcpClient({
  baseUrl: sandboxInstance.baseUrl,
  scfSessionId: userContext.envId,  // 改名并使用 envId
  conversationId,                    // 新增
  // ...
})

// initSandboxWorkspace() 调用
const sandboxCwd = await initSandboxWorkspace(sandboxInstance, {
  envId: userContext.envId,
  secretId: userCredentials?.secretId || '',
  secretKey: userCredentials?.secretKey || '',
  token: userCredentials?.sessionToken,
}, conversationId)  // 新增参数
```

#### 3.4 `packages/server/src/sandbox/git-archive.ts`

**改动点**：

由于 session 共享后，Git 归档的分支名从 `conversationId` 变为 `envId`，删除归档的逻辑也需要调整：从删除分支改为删除分支上的目录。

```typescript
// 新增：删除分支上指定会话的目录
export async function deleteArchiveDirectory(
  envId: string,
  conversationId: string,
): Promise<void> {
  // DELETE {apiDomain}/{repo}/-/git/files/{envId}/{conversationId}
  // ...
}

// 新增：批量删除目录
export async function deleteArchiveDirectories(
  items: Array<{ envId: string; conversationId: string }>,
): Promise<void> {
  // ...
}

// 标记为 @deprecated
export async function deleteArchiveBranch(sessionId: string): Promise<void> {
  // 保留向后兼容，但标记为过时
}

export async function deleteArchiveBranches(sessionIds: string[]): Promise<void> {
  // 保留向后兼容，但标记为过时
}
```

**导出更新** (`packages/server/src/sandbox/index.ts`)：
```typescript
export {
  archiveToGit,
  deleteArchiveDirectory,      // 新增
  deleteArchiveDirectories,    // 新增
  deleteArchiveBranch,         // 保留，@deprecated
  deleteArchiveBranches,       // 保留，@deprecated
  isGitArchiveConfigured,
  type GitArchiveConfig,
} from './git-archive.js'
```

## 软隔离语义

| 操作 | 行为 |
|------|------|
| `Read("./file.txt")` | 读取 `/tmp/workspace/{envId}/{conversationId}/file.txt` |
| `Read("../other-conv/file.txt")` | 读取 `/tmp/workspace/{envId}/other-conv/file.txt` ✅ 可访问 |
| `Read("/tmp/workspace/other-env/...")` | 路径存在但凭证不同，实际隔离 |
| `Write("./new.js", content)` | 写入 `/tmp/workspace/{envId}/{conversationId}/new.js` |
| `Bash("ls ../../")` | 列出 `/tmp/workspace/{envId}/` 下所有会话 ✅ 可访问 |

## Git 归档结构变化

### 改造前

```
分支: {conversationId}
  └── / (会话的工作目录根)
```

删除归档 = 删除分支

### 改造后

```
分支: {envId}
  ├── {conversationId_1}/
  ├── {conversationId_2}/
  └── {conversationId_3}/
```

删除归档 = 删除分支上的 `{conversationId}` 目录

## 安全考虑

1. **环境级别隔离**：不同 `envId` 的会话使用不同的 SCF session，完全隔离
2. **环境内互信**：同一 `envId` 下的用户被视为互信，可以互相访问工作区
3. **如需用户级隔离**：可将 `X-Cloudbase-Session-Id` 改为 `envId:userId`

## 容器端改动

**无需改动**。服务端主动创建工作目录，容器端保持原有逻辑即可：

1. 容器根据 `X-Cloudbase-Session-Id`（= envId）管理 session
2. 容器通过 `X-Conversation-Id` 可识别具体会话（用于日志/调试）
3. 服务端在 `initSandboxWorkspace()` 中调用 `mkdir -p` 创建目录

## 测试验证

1. **验证 session 共享**：
   - 同一 envId 下启动两个会话
   - 在会话 A 创建文件，会话 B 应能读取

2. **验证环境隔离**：
   - 不同 envId 下启动会话
   - 会话之间应无法互相访问

3. **验证目录创建**：
   - 检查日志确认 `mkdir -p` 执行成功
   - 检查容器内 `/tmp/workspace/{envId}/{conversationId}/` 目录存在

4. **验证 Git 归档**：
   - 同一 envId 下多个会话的归档应在同一分支
   - 删除单个会话归档应只删除对应目录，不影响其他会话
