# CloudBase VibeCoding Platform

基于 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) 重构的 AI 编程助手平台，以腾讯云 CloudBase 为底座，支持多 Agent 运行时、多租户环境隔离与完整的 VibeCoding 工作流。

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![pnpm](https://img.shields.io/badge/maintained%20with-pnpm-cc00ff.svg)](https://pnpm.io/)
[![Node](https://img.shields.io/badge/node-22.x-brightgreen.svg)](https://nodejs.org/)

## 延伸阅读

- [Setup 指南](docs/setup.md) — 初始化流程、环境变量、验证清单与排障
- [系统架构](docs/architecture.md) — 系统分层、模块设计与关键数据流

---

## At a Glance

| 能力                    | 说明                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **多 Agent 运行时**     | CodeBuddy / OpenCode / MiMo 三个 runtime 并行可选；per-agent 独立模型列表；切换时自动校验 selectedModel                              |
| **三级环境隔离**        | `shared`（共用）/ `isolated`（用户独立）/ `task`（任务独立 + 独立 CAM 子账号）三种模式，admin 后台动态切换，无需重启                 |
| **环境池**              | 预创建 CloudBase 环境 + CAM + Policy，获取延迟从分钟级降至毫秒级；池空自动回退实时创建；多 Pod CAS 安全                              |
| **编码模式沙箱**        | AGS Stateful Sandbox + TRW；按 envId 单实例复用；`ensureStatefulTool` + 镜像预热；工作区 `/home/user`；预览经 gateway → TRW `/preview/5173/` |
| **Preview Bridge**      | 内嵌 Browser 工具栏（地址栏 / 刷新 / 前进后退 / 设备切换）；OVC 反向代理至 TRW；HMR；预览错误自动修复                                 |
| **Web 终端**            | ttyd 经 TRW `/preview/7681/`，OVC 代理为 `/api/tasks/:id/preview/7681/`                                                              |
| **CloudBase MCP**       | 内置 50+ CloudBase 工具（DB / Storage / Functions / 域名 / 安全规则）；koa 风格 middleware 框架；stdio + HTTP 双模式                 |
| **Human-in-Loop**       | ToolConfirm（四值权限：allow / allow_always / deny / reject_and_exit_plan）；AskUserQuestion 内联表单；消息流内渲染，不打断上下文    |
| **Plan 模式**           | 写操作拦截；PlanModeCard 三按钮（允许执行 / 继续完善 / 拒绝退出）；`planModeAtomFamily` 跨组件状态共享                               |
| **工具渲染注册表**      | 10 个专属渲染器（Bash / Read / Write / Edit / Grep / Glob 等）；Edit 集成 git-diff-view；Subagent 嵌套紫色边框卡片                   |
| **部署能力**            | Web 静态托管 → CDN 链接；微信小程序（异步轮询 jobId）；所有产出统一 `artifact` 事件，Deployments 标签页聚合展示                      |
| **图片生成**            | Default 模式 ImageGen；生成图片自动上传 CloudBase 静态托管，返回 CDN 链接；聊天内 Markdown 内联展示                                  |
| **Git 归档**            | 任务结束（含 error / cancel）自动 git push 到远端，按 `envId` 分支 + `conversationId` 目录存储；内存 credential helper，不泄露 token |
| **CloudBase Dashboard** | task 详情页内嵌 DB / Storage / SQL / Functions 可视化管理；envId 切换自动重置状态，防止旧集合查询污染                                |
| **Admin 后台**          | 用户管理（创建 / 禁用 / API Key 重置）；环境池监控；provision mode 配置；审计日志；资源代理                                          |
| **认证**                | 本地账密 / GitHub OAuth / CloudBase 身份 / API Key（`sak_xxx`）；JWE Cookie 加密会话                                                 |
| **定时任务**            | cron 表达式调度，服务端 `cron-scheduler.ts` 加载执行；分布式锁防重入                                                                 |
| **凭证安全**            | AES-256-CBC 加密存储敏感字段；STS 临时凭证作用域隔离；系统集合 ADMINONLY 规则；日志只允许静态字符串                                  |

---

## Screenshots

**创建任务，选择 Agent 和模型**

![home](docs/assets/home.png)

**编码模式：左侧对话 + 右侧实时预览**

![preview](docs/assets/preview.png)

**Chat 界面：工具调用卡片、Phase 状态指示**

![chat](docs/assets/chat.png)

**Human-in-Loop：工具确认 & 向用户提问**

| ToolConfirm                                       | AskUserQuestion                           |
| ------------------------------------------------- | ----------------------------------------- |
| ![confirm](docs/assets/human-in-loop-confirm.png) | ![ask](docs/assets/human-in-loop-ask.png) |

**内嵌 CloudBase Dashboard**

![cloud-dashboard](docs/assets/cloud-dashboard.png)

**部署完成，查看 artifact**

| Chat 内 artifact                      | Deployments 标签页                |
| ------------------------------------- | --------------------------------- |
| ![deploy-0](docs/assets/deploy-0.png) | ![deploy](docs/assets/deploy.png) |

**Admin：环境池管理**

![admin-env-pool](docs/assets/admin-env-pool.png)

---

## 项目结构

```
├── docs/
│   ├── setup.md                  # setup 详解与排障
│   ├── architecture.md           # 系统架构文档
│   └── scf-session-sharing.md    # （历史）SCF Session 共享，stateful 分支已废弃
├── packages/
│   ├── web/                      # React 19 + Vite 前端
│   ├── server/                   # Hono 后端：Auth、Agent 编排、Sandbox 管理
│   ├── dashboard/                # CloudBase 资源管理 UI（DB / Storage / Functions）
│   └── shared/                   # ACP 协议类型、任务 / 消息 schema
├── scripts/
│   ├── init.mjs                  # 交互式初始化脚本
│   └── setup-tcr.mjs             # TCR 镜像仓库配置
└── init.sh                       # 快速入口
```

---

## 快速开始

**前置条件**

开始前请确认：
- **Node.js 22.x**（必需；`better-sqlite3` 原生模块与 server build target 对齐 **node22**，勿用 Node 23+ 或 brew 默认 Node 26）。推荐：`mise use node@22` 或 `nvm use`（根目录 `.nvmrc` 为 `22`）
- pnpm 10+
- Docker 已安装并启动（stateful 分支本地 dev **不**需要本机 TRW；沙箱在云端）
- 已准备 CloudBase 环境和腾讯云 API 密钥
- 已准备 CodeBuddy API Key 或 OAuth 配置

**一键初始化**

```bash
git clone <repository-url>
cd coding-agent-template
./init.sh
```

初始化脚本依次完成：Node.js 检查 → pnpm 安装 → `.env.local` 生成 → Docker 检查 → CloudBase 配置 → 依赖安装 → CodeBuddy 认证 → TCR 配置 → 数据库初始化。

详细步骤与排障见 [docs/setup.md](docs/setup.md)。

---

## 开发

```bash
pnpm dev          # 同时启动 web (localhost:5174) 和 server (localhost:3001)
pnpm dev:web      # 仅启动前端
pnpm dev:server   # 仅启动后端
```

## 生产

```bash
pnpm build        # 构建所有包
pnpm start        # 启动生产服务（端口 3001，同时服务 API 和静态文件）
```


## 常用命令

```bash
# 代码质量
pnpm type-check   # TypeScript 类型检查
pnpm lint         # ESLint
pnpm format       # Prettier 格式化

# 数据库
pnpm db:generate  # 生成迁移
pnpm db:push      # 推送 schema
pnpm db:studio    # 打开 Drizzle Studio

# TCR 镜像仓库
pnpm setup:tcr
pnpm setup:tcr --namespace my-app --local-image node:20

# OpenCode
pnpm opencode:setup   # 配置 OpenCode provider 和模型
```

---

## 环境变量

完整变量说明见 [docs/setup.md](docs/setup.md)。核心变量：

```env
# 加密密钥（init 脚本自动生成）
JWE_SECRET=
ENCRYPTION_KEY=

# 认证
NEXT_PUBLIC_AUTH_PROVIDERS=local   # local | github | cloudbase

# CloudBase
TCB_SECRET_ID=
TCB_SECRET_KEY=
TENCENTCLOUD_ACCOUNT_ID=
TCB_ENV_ID=
TCB_PROVISION_MODE=shared          # shared | isolated | task

# TCR
TCR_NAMESPACE=
TCR_PASSWORD=
TCR_IMAGE=

# 可选
MAX_MESSAGES_PER_DAY=50
MAX_SANDBOX_DURATION=300
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
GIT_PERSONAL_AUTH=
```

---

## OpenCode 模型配置

项目内置 OpenCode ACP runtime。如果前端需要使用 OpenCode agent，需要先配置至少一个
provider（model 提供商）。

### 前置：安装 opencode CLI

```bash
npm i -g opencode-ai
# 验证
opencode --version
```

### 一键配置

```bash
pnpm opencode:setup
```

该命令会：

1. 调用 腾讯云开发 AI+ 接口 [DescribeAIModels](https://cloud.tencent.com/document/product/876/131318) 拉取模型
2. 引导并配置腾讯云开发 API Key
3. 从 catalog 取完整配置写入 `.opencode/opencode.json`（含 npm/baseURL/models 等）
4. 把 API Key 写入 `packages/server/.env`

### 生成结果示例

```jsonc
// .opencode/opencode.json（自动生成，字段从 models.dev 获取）
{
  "$schema": "https://opencode.ai/config.json",
  "model": "cloudbase/deepseek-v4-flash",
  "provider": {
    "cloudbase": {
      "options": {
        "baseURL": "https://envId-xxxxxxx.api.tcloudbasegateway.com/v1/ai/cloudbase",
        "apiKey": "{env:CLOUDBASE_API_KEY}"
      },
      "models": {
        "glm-5": {
          "name": "glm-5"
        },
        // 其他模型
      }
    }
  }
}
```

```bash
# packages/server/.env 会追加 API Key
CLOUDBASE_API_KEY=eyJhbGciOiJS.xxxxxxxx
```

> **为什么写完整字段而不是空对象？** opencode 子进程启动时也需要这些配置。如果只写 `{}`，
> 子进程要自己从 models.dev 拉 catalog 才知道 npm / baseURL / models 等信息，一旦拉取失败
> （网络/超时）就无法正常工作。写入完整字段让配置自包含，不依赖运行时网络请求。

### 高级：自定义 provider / 覆盖字段

如果需要：

- 非 catalog 内置的 provider（如内网 LLM 网关、本地 Ollama）
- 覆盖 catalog 默认的 `baseURL` / `headers`（如走国内镜像）
- 用 `whitelist` / `blacklist` 限制要展示的模型
- 配置 variants（如 Anthropic 的 thinking 预算）

请参考 `.opencode/opencode.example.json` 和 [OpenCode 官方 providers 文档](https://opencode.ai/docs/zh-cn/providers/)
直接手动编辑 `.opencode/opencode.json`。

> 提示：`opencode.json` 顶部的 `$schema` 字段让 VS Code / Cursor 等编辑器支持字段自动补全
> 和悬停文档，编辑时按 Ctrl+Space 可查看所有可选字段。

### 重新配置 / 新增 provider

`pnpm opencode:setup` 幂等，可多次运行：

- **已存在的 provider** 不会被覆盖（避免丢失手动调整）
- **已设置的 env key** 不会被重复询问
- **缺失 env 的 provider** 会在启动时提示补齐

## 技术栈

| 层      | 技术                                                    |
| ------- | ------------------------------------------------------- |
| 前端    | React 19, Vite, Tailwind CSS 4, shadcn/ui, Jotai        |
| 后端    | Hono, Node.js, Drizzle ORM                              |
| 数据库  | CloudBase DB（主），SQLite（本地回退）                  |
| AI      | `@tencent-ai/agent-sdk` (CodeBuddy), OpenCode ACP, MiMo |
| Sandbox | CloudBase AGS Stateful Sandbox, TRW, TCR 镜像           |
| 认证    | JWE session, bcrypt, Arctic (OAuth)                     |
| 持久化  | CloudBase DB, 本地 .jsonl, Git archive                  |
| 协议    | ACP (JSON-RPC 2.0 + SSE), MCP (Model Context Protocol)  |

完整的模块设计、数据流与 API 路由见 [docs/architecture.md](docs/architecture.md)。

---

## 与上游的关系

本项目 fork 自 Vercel 的 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template)。主要差异：

|          | 上游           | 本项目                                     |
| -------- | -------------- | ------------------------------------------ |
| 架构     | Next.js 全栈   | Monorepo 前后端分离（React + Vite / Hono） |
| 部署     | Vercel         | 腾讯云 CloudBase                           |
| Sandbox  | Vercel Sandbox | CloudBase AGS Stateful Sandbox (TRW)       |
| Agent    | 单一 runtime   | CodeBuddy / OpenCode / MiMo 多 runtime     |
| 环境隔离 | 无             | shared / isolated / task 三级              |

---

## Contributing

1. Fork 并创建功能分支 (`git checkout -b feature/xxx`)
2. 开发完成后确保通过：`pnpm type-check && pnpm lint && pnpm format`
3. 提交 Pull Request

**日志安全规则**：所有 `logger.*` / `console.*` 调用必须使用静态字符串，不得包含 `${动态值}`。详见 [AGENTS.md](./AGENTS.md)。

## Acknowledgments

- [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) by Vercel
- [CloudBase](https://cloudbase.net/) — 云开发基础设施
- [CodeBuddy](https://copilot.tencent.com/) — AI 编程助手
- [Hono](https://hono.dev/) — 轻量级 Web 框架

## License

基于 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) (Copyright 2025 Vercel, Inc.) 改造，沿用 Apache License 2.0。详见 [LICENSE](./LICENSE) 和 [NOTICE](./NOTICE)。
