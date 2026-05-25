# AI Agent Guidelines

本文档是 AI Agent（Claude Code / Cursor / Copilot 等）在本仓库工作时的规则和参考。

---

## 项目概况

CloudBase VibeCoding Platform — 基于腾讯云 CloudBase 的 AI 编程助手平台。

```
packages/
├── web/        # React 19 + Vite 前端
├── server/     # Hono 后端（Agent 编排、沙箱管理、ACP 协议）
├── dashboard/  # CloudBase 资源管理 UI
└── shared/     # 共享类型定义
scripts/
├── init.mjs        # 交互式初始化
└── setup-tcr.mjs   # TCR 镜像仓库配置
```

---

## 安全规则

### 日志中禁止动态值

所有 log 语句**只允许静态字符串**，绝不包含动态值。

```typescript
// ✗ 禁止
console.log(`Task created: ${taskId}`)
console.error(`Failed for user ${userId}`)

// ✓ 正确
console.log('[Agent] Task created')
console.error('[Agent] Operation failed:', error)
```

**原因**：日志会通过 SSE 推送到前端 UI，动态值可能泄露凭证、路径等敏感信息。

### 敏感环境变量（禁止出现在日志/响应中）

- `TCB_SECRET_ID` / `TCB_SECRET_KEY` / `TCB_TOKEN`
- `CODEBUDDY_API_KEY` / `CODEBUDDY_CLIENT_SECRET`
- `JWE_SECRET` / `ENCRYPTION_KEY`
- `GIT_ARCHIVE_TOKEN` / `GIT_PERSONAL_AUTH`
- `TCR_PASSWORD`
- 任何 `*_KEY` / `*_SECRET` / `*_TOKEN` 模式的变量

---

## 代码质量

### 提交前必须执行

```bash
pnpm format       # Prettier 格式化
pnpm type-check   # TypeScript 类型检查
pnpm lint         # ESLint
```

如有错误，修复后再提交。不要跳过或 ignore。

### UI 组件

使用 shadcn/ui CLI 添加组件，不手写：

```bash
pnpm dlx shadcn@latest add button
```

已有组件在 `packages/web/src/components/ui/`。

### 禁止启动 Dev Server

不要在终端中执行 `pnpm dev` / `npm start` 等长期运行命令。改用：
- `pnpm build` — 验证构建
- `pnpm type-check` — 验证类型
- `pnpm lint` — 验证代码质量

---

## 架构要点

### Agent 运行时

- **CodeBuddy Runtime**（`cloudbase-agent.service.ts`）— 基于 @tencent-ai/agent-sdk，主力 runtime
- **OpenCode ACP Runtime**（`opencode-acp-runtime.ts`）— 基于 opencode CLI 的 ACP 协议实现
- **Agent Registry**（`agent-registry.ts`）— 内存中追踪运行中的 agent 状态

### SSE 生命周期

```
registerAgent() → status='running'
    ↓
for-await message loop（处理 SDK 消息）
    ↓
finally → completeAgent() → status='completed'
    ↓
SSE poll 检测 isDone → 发 [DONE] → removeAgent()
```

关键约束：
- `completeAgent()` 必须在 `eventBuffer.close()` 之后立即调用（不阻塞后续 cleanup）
- `removeAgent()` 由 SSE 消费者在发完 `[DONE]` 后调用（不用定时器）
- `removeAgent()` 拒绝删除 `status='running'` 的 entry

### 沙箱

- 沙箱 = SCF 容器（基于自定义 Docker 镜像）
- 工具重定向：CLI 的文件/命令工具通过 HTTP API 路由到沙箱
- MCP Proxy：CloudBase 工具通过 sandbox 内的 mcporter 发现和执行
- 隔离模式：`WORKSPACE_ISOLATION=isolated`（每 task 独立）/ `shared`（共享 session）

### 数据库

双 Provider 模式：`DB_PROVIDER=cloudbase`（云开发数据库）或 `drizzle`（SQLite）。
Repository 接口在 `db/types.ts`，两种实现在 `db/cloudbase/` 和 `db/drizzle/`。

### 环境生命周期

```
acquireEnv() → 根据 provision mode 决定：
  shared   → 直接返回主环境
  isolated → 创建独立环境（或从池中认领）
  task     → 同 isolated

releaseEnv() → 销毁 CAM + 环境资源
```

---

## 调试

- `AGENT_DEBUG_JSONL=1` — 开启完整消息日志（写入 `debug-jsonl/` 目录）
- `packages/server/.env` 中的 `NODE_ENV=development` — 开发模式详细错误
- Agent Registry 日志前缀：`[Registry]`
- SSE Poll 日志前缀：`[SSE poll]`
- 沙箱日志前缀：`[sandbox]`

---

## 提交规范

```
type(scope): description

feat/fix/docs/refactor/chore(agent|web|init|db): 简短描述
```

Co-Author 格式（如果由 AI 辅助）：
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

---

## 提交前检查清单

- [ ] `pnpm format` 通过
- [ ] `pnpm type-check` 无错误
- [ ] `pnpm lint` 无错误
- [ ] 日志中无动态值（无 `${...}` 模板字符串）
- [ ] 敏感变量未暴露
- [ ] 新增环境变量已加入 `.env.example`
