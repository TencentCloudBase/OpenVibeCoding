# CloudBase MCP Policy 中间件

按 Hono / koa middleware 风格设计的 CloudBase MCP 工具拦截 / 新增 / 过滤层。

每个 `<工具名>.ts` = 一个 middleware：调 `next()` 透传，不调 `next()` 接管。

底层框架在 `lib/mcp-middleware/`，纯工具函数在 `lib/cloudbase-mcp.ts`，
这里只放 cloudbase 特有的 policy 实现。

对应 issue：
- [#11 云函数支持指定 VPC](https://github.com/TencentCloudBase/OpenVibeCoding/issues/11)
- [#12 应用发布后支持自定义流程](https://github.com/TencentCloudBase/OpenVibeCoding/issues/12)
- [#13 支持指定 AI 可见的资源范围](https://github.com/TencentCloudBase/OpenVibeCoding/issues/13)

## 一句话总结

```typescript
async use(ctx, next) {
  // next() 之前  ⇒ 改 ctx.input
  // next() 之后  ⇒ 拿结果加工
  // 不调 next() ⇒ 完全接管
  // 抛错        ⇒ 拒绝调用，错误返回 AI
}
```

## 4 种典型用法

### 1. 改入参（透传前修改）

```typescript
async use(ctx, next) {
  ctx.input = { ...ctx.input, vpcId: process.env.VPC_ID }
  return next()
}
```

### 2. 改输出（透传后加工）

```typescript
async use(ctx, next) {
  const output = await next()
  return output.replace(/secret/g, '[REDACTED]')
}
```

### 3. 副作用（fire-and-forget）

```typescript
async use(ctx, next) {
  const output = await next()
  void notifyWebhook(ctx, output)
  return output
}
```

### 4. 完全接管（不调 next）

```typescript
async use(ctx, next) {
  if (ctx.input.action !== 'list') return next()
  return JSON.stringify({ ... })
}
```

### bonus. 新增一个原 MCP 没有的工具

```typescript
export const policy: McpPolicy = {
  augment: {
    description: '...',
    inputSchema: { type: 'object', properties: {...}, required: [...] },
  },
  async use(ctx) {
    return JSON.stringify({ ... })
  },
}
```

## 当前文件清单

> ⚠️ 标 **[CORE]** 的是平台基础能力，删除/破坏会让产品功能失效。

| 文件 | 工具 | 类型 | 行为 |
| --- | --- | --- | --- |
| `auth.ts` | `auth`（原生） | **[CORE]** 拦截 | action=start_auth → 重新注入凭证 |
| `downloadTemplate.ts` | `downloadTemplate`（原生） | **[CORE]** 拦截 | 强制 ide=codebuddy |
| `uploadFiles.ts` | `uploadFiles`（原生） | **[CORE]** 拦截 | 部署成功后产出 artifact |
| `publishMiniprogram.ts` | `publishMiniprogram`（新增） | **[CORE]** augment | 沙箱业务镜像 `POST /api/jobs/miniprogram-deploy` |
| `getDeployJobStatus.ts` | `getDeployJobStatus`（新增） | **[CORE]** augment | 沙箱业务镜像 `GET /api/jobs/:jobId` |
| `getDeployJobStatus.ts` | `getDeployJobStatus`（新增） | **[CORE]** augment | 查询小程序部署状态 |
| `cronTask.ts` | `cronTask`（新增） | **[CORE]** augment | 本地 DB + cron-scheduler |

## 自定义 policy

`_example.ts` 是一份完整的 policy 模板，演示了所有支持的 hook（改入参 / 改输出 /
副作用 / 完全接管 / 抛错 / 调用其他工具 / 新增虚拟工具 / 动态隐藏）。

**默认不生效**（文件名以 `_` 开头，loader 会跳过）。

要写一个自己的 policy：

1. **复制**模板：`cp _example.ts <工具名>.ts`
   - 拦截既有原生工具：文件名 = 工具名（例如 `manageFunctions.ts`）
   - 新增虚拟工具：文件名 = 你想暴露给 AI 的新工具名
2. **删掉用不上的逻辑**，只留你真正需要的部分（绝大多数 policy 只用到一两个 hook）
3. **重启 server**

例：启用 #11 VPC 注入

```bash
cp _example.ts manageFunctions.ts
# 在 manageFunctions.ts 中只保留"改入参"逻辑，删掉其他演示
export CLOUDBASE_FORCE_VPC_ID=vpc-xxxxx
export CLOUDBASE_FORCE_VPC_SUBNET=subnet-xxxxx
```

## 关掉一个工具（不写 policy）

```bash
# 黑名单：这几个工具不暴露给 AI
CLOUDBASE_MCP_DISABLE_TOOLS=manageStorage,manageDataModel

# 白名单：只暴露这几个（更激进）
CLOUDBASE_MCP_ENABLE_TOOLS=envQuery,queryFunctions,manageFunctions
```

## 环境变量参考（仅当对应示例 policy 被启用时生效）

| 变量 | 启用时所属 policy | 用途 |
| --- | --- | --- |
| `CLOUDBASE_MCP_DISABLE_TOOLS` | 框架级（始终生效） | 工具黑名单 |
| `CLOUDBASE_MCP_ENABLE_TOOLS` | 框架级（始终生效） | 工具白名单 |
| `CLOUDBASE_FORCE_VPC_ID` | manageFunctions | 注入的 VPC ID |
| `CLOUDBASE_FORCE_VPC_SUBNET` | manageFunctions | 注入的子网 ID |
| `CLOUDBASE_AI_FUNCTION_PREFIX` | queryFunctions | 允许的函数名前缀（逗号分隔） |
| `CLOUDBASE_DEPLOY_WEBHOOK` | manageCloudRun | deploy 回调 URL |
| `CLOUDBASE_DEPLOY_WEBHOOK_AUTH` | manageCloudRun | webhook 的 Authorization |

## ctx 上有什么

```typescript
ctx.toolName             // 当前工具名
ctx.input                // 当前入参（可就地修改）
ctx.userId               // 用户 ID
ctx.sessionId            // 会话 ID
ctx.scratch              // 便签纸（一次调用内有效）
ctx.callOriginal(name, input)   // 调用任意原生 MCP 工具（绕开所有 policy）

// CloudBase 特有
ctx.extra.sandboxUrl     // 沙箱地址
ctx.extra.sandboxAuth    // 沙箱认证
ctx.extra.sandboxFetch   // 沙箱请求快捷方式
ctx.extra.injectCredentials       // 重新注入凭证
ctx.extra.onArtifact              // artifact 回调
ctx.extra.getMpDeployCredentials  // 小程序密钥
ctx.extra.currentModel            // 当前模型 ID
```

## 约定

- **文件名 = 工具名**（不含扩展名）
- **以 `_` 开头的文件不会被加载**（视为内部/共享代码）
- **不写文件 = 透传**，policy 完全可选
- **环境变量优先**：所有可配置项走 `process.env`
- **修改后需要重启**：policy 启动时加载，无热重载
- **新增工具不能与原生工具同名**（冲突时新增工具被跳过并打 warn）

## 文件结构

```
lib/
├── cloudbase-mcp.ts          # 纯工具函数（jsonSchema↔Zod / mcporter 序列化 / 工具发现）
└── mcp-middleware/                 # 通用 middleware 框架（与具体 MCP 后端无关）
    ├── index.ts                    # 公开 API
    ├── types.ts                    # McpContext / McpPolicy / McpMiddleware
    ├── loader.ts                   # createPolicyLoader 工厂（含 allow/deny list）
    └── apply.ts                    # runWithPolicy / runAugmentedTool / isToolHidden

middleware/mcp/cloudbase/           # CloudBase 专用，所有 policy 平铺在此
├── _index.ts                       # 注册本目录 + 类型别名 + 环境变量解析
├── README.md                       # 本文档
├── _example.ts                     # ★ policy 模板（默认不生效）
├── auth.ts                         # [CORE]
├── downloadTemplate.ts             # [CORE]
├── uploadFiles.ts                  # [CORE]
├── publishMiniprogram.ts           # [CORE]
├── getDeployJobStatus.ts           # [CORE]
└── cronTask.ts                     # [CORE]

routes/cloudbase-mcp.ts             # OpenCode HTTP runtime 入口
sandbox/stateful/stateful-mcp-client.ts  # CodeBuddy SDK runtime（经沙箱业务镜像数据面）
                                    # 两条路径都用 lib/cloudbase-mcp-utils + middleware/mcp/cloudbase
```

未来扩展其他 MCP（GitHub MCP、Linear MCP 等）：在 `middleware/mcp/<name>/`
下放同样结构，`lib/mcp-middleware` 框架代码零拷贝复用。
