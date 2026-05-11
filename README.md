# CloudBase VibeCoding Platform

基于 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) 重构改造的 AI 编程助手平台，结合腾讯云 CloudBase 打造的 VibeCoding 体验。

## 文档导航

- [Setup 指南](docs/setup.md) — 详细初始化流程、关键环境变量、验证清单与排障
- [系统架构](docs/architecture.md) — 系统分层、用户环境绑定、任务与 Sandbox 链路

## 项目特点

- **Monorepo 架构**: 使用 pnpm workspace 管理多包项目
- **前后端分离**:
  - **Web**: React 19 + Vite + Tailwind CSS
  - **Server**: Hono + Node.js
- **CloudBase 集成**: 腾讯云开发后端服务
- **多 AI Agent 支持**: 支持 Claude Code、OpenAI Codex、GitHub Copilot、Gemini 等
- **容器化部署**: 支持 TCR（腾讯云容器镜像服务）部署

## 项目结构

```
├── docs/
│   ├── setup.md                  # setup 详解与排障
│   ├── architecture.md           # 系统架构文档
│   ├── scf-session-sharing.md    # SCF Session 共享设计
│   └── crontask-cloudfunction-plan.md
├── packages/
│   ├── web/          # React + Vite 前端
│   ├── server/       # Hono 后端服务
│   ├── dashboard/    # CloudBase 管理面板
│   └── shared/       # 共享类型和协议
├── scripts/
│   ├── init.mjs      # 主初始化脚本
│   └── setup-tcr.mjs # TCR 镜像仓库配置
├── init.sh           # 快速启动入口
└── package.json      # Monorepo 配置
```

## 系统架构概览

- `packages/web` 提供面向用户的主交互界面，包括任务、对话、日志和仓库相关能力
- `packages/server` 负责认证、API 路由、Agent 编排、消息持久化与 SCF Sandbox 管理
- `packages/dashboard` 提供 CloudBase 资源管理相关界面
- `packages/shared` 提供前后端共享类型和协议定义
- CloudBase 负责数据库、云函数、存储和镜像基础设施，CodeBuddy / 模型层负责智能体能力

更完整的分层图、用户环境绑定机制和任务执行链路见 [系统架构文档](docs/architecture.md)。

## 快速开始

### 前置条件

开始前请确认：
- Node.js >= 18
- Docker 已安装并启动
- 已准备 CloudBase 环境和腾讯云 API 密钥
- 已准备 CodeBuddy API Key 或 OAuth 配置

详细要求与排障请先看 [Setup 指南](docs/setup.md)。

### 一键初始化

```bash
# 克隆项目
git clone <repository-url>
cd coding-agent-template

# 运行初始化入口
./init.sh
```

`./init.sh` 负责基础检查，并委托 `scripts/init.mjs` 完成交互式初始化。

当前初始化流程会依次处理：
1. 检查 Node.js
2. 检查或安装 pnpm
3. 创建 `.env.local`
4. 检查 Docker
5. 配置 CloudBase 与 `TCB_ENV_ID`
6. 生成 `packages/server/.env`
7. 安装依赖
8. 配置 CodeBuddy 认证
9. 配置 TCR
10. 初始化数据库

### 手动初始化

如果你已经准备好环境，也可以直接执行主脚本：

```bash
node scripts/init.mjs
```

### 初始化后建议检查

- `packages/server/.env` 是否已生成
- CloudBase / CodeBuddy / TCR 配置是否完整
- `pnpm build` 是否成功
- 启动后 `GET /health` 是否返回 `{"status":"ok"}`

更完整的步骤说明、变量职责与排障方式见 [docs/setup.md](docs/setup.md)。

## 开发模式

### 启动开发服务器

```bash
# 同时启动 web 和 server
pnpm dev
```

- **Web**: http://localhost:5174
- **Server API**: http://localhost:3001

### 单独启动

```bash
# 仅启动 web
pnpm dev:web

# 仅启动 server
pnpm dev:server
```

## 生产部署

### 构建

```bash
pnpm build
```

### 启动生产服务

```bash
pnpm start
```

生产模式下，Server 会同时提供 API 和静态文件服务（端口 3001）。

## 环境变量配置

创建 `.env.local` 文件配置以下变量：

### 必需配置

```env
# Session 加密密钥（自动生成）
JWE_SECRET=<base64-encoded-secret>
ENCRYPTION_KEY=<32-byte-hex-string>

# 认证方式
NEXT_PUBLIC_AUTH_PROVIDERS=local
```

### CloudBase 配置

```env
# CloudBase 凭证
TCB_SECRET_ID=<secret-id>
TCB_SECRET_KEY=<secret-key>
TENCENTCLOUD_ACCOUNT_ID=<account-id>

# TCR 容器镜像配置
TCR_NAMESPACE=<namespace>
TCR_PASSWORD=<password>
TCR_IMAGE=<image-url>
```

### 可选配置

```env
# 每日消息限制
MAX_MESSAGES_PER_DAY=50

# Sandbox 最大持续时间（分钟）
MAX_SANDBOX_DURATION=300

# API Keys（可由用户在界面配置）
ANTHROPIC_API_KEY=<key>
OPENAI_API_KEY=<key>
GEMINI_API_KEY=<key>
```

## TCR 容器镜像配置

项目支持一键配置腾讯云 TCR 个人版镜像仓库：

```bash
pnpm setup:tcr
```

该命令会：
1. 自动安装 cloudbase CLI（如未安装）
2. 引导完成 cloudbase login 登录
3. 初始化 TCR 个人版实例
4. 创建命名空间（自动添加随机后缀避免冲突）
5. 推送默认镜像到仓库

### TCR 配置选项

```bash
pnpm setup:tcr --namespace my-app --local-image node:20
```

| 参数            | 说明         | 默认值                                            |
| --------------- | ------------ | ------------------------------------------------- |
| `--namespace`   | 命名空间前缀 | `cloudbase-vibecoding`                            |
| `--local-image` | 本地镜像     | `ghcr.io/yhsunshining/cloudbase-workspace:latest` |
| `--repo-name`   | 仓库名称     | `sandbox`                                         |
| `--tag`         | 镜像标签     | `latest`                                          |
| `--password`    | TCR 密码     | 交互式输入                                        |

也可通过 `.env.local` 配置：

```env
TCR_LOCAL_IMAGE=ghcr.io/yhsunshining/cloudbase-workspace:latest
TCR_REPO_NAME=sandbox
TCR_TAG=latest
```

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

1. 从 [models.dev](https://models.dev)（opencode 自身使用的 catalog）拉取 118+ provider 列表
2. 引导选择要启用的 provider（deepseek / moonshot / openai / anthropic / zhipuai / …）
3. 提示输入对应的 API Key（如 `DEEPSEEK_API_KEY`）
4. 选择默认模型
5. 把 provider 启用声明写入 `.opencode/opencode.json`（空对象风格，与 opencode 官方推荐一致）
6. 把 API Key 写入 `packages/server/.env`

### 生成结果示例

```jsonc
// .opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "deepseek/deepseek-chat",
  "provider": {
    "deepseek": {},
    "moonshot": {}
  }
}
```

```bash
# packages/server/.env 会追加 API Key
DEEPSEEK_API_KEY=sk-***
MOONSHOT_API_KEY=sk-***
```

`provider.<id>: {}` 表示启用该 provider，其 `npm`/`api`/`name`/`models` 等元数据由 opencode
运行时从 models.dev 自动获取。这样做的好处：

- 与 opencode 官方行为完全一致，不用冗余维护字段
- models.dev 上游新增模型时自动生效，无需改项目配置

### 高级：自定义 provider / 覆盖字段

如果需要：

- 非 catalog 内置的 provider（如内网 LLM 网关、本地 Ollama）
- 覆盖 catalog 默认的 `baseURL` / `headers`
- 用 `whitelist` / `blacklist` 限制要展示的模型
- 配置 variants（如 Anthropic 的 thinking 预算）

请参考 `.opencode/opencode.example.json` 和 [OpenCode 官方 providers 文档](https://opencode.ai/docs/zh-cn/providers/)
直接手动编辑 `.opencode/opencode.json`。setup 脚本只覆盖最常用的"启用 + 灌 key + 选默认
model"三件事。

### 重新配置 / 新增 provider

`pnpm opencode:setup` 幂等，可多次运行。已存在的 provider / env key 不会被重复询问。

## 常用命令

```bash
# 开发
pnpm dev              # 启动开发环境
pnpm dev:web          # 仅启动 web
pnpm dev:server       # 仅启动 server

# 构建
pnpm build            # 构建所有包
pnpm build:web        # 仅构建 web
pnpm build:server     # 仅构建 server

# 生产
pnpm start            # 启动生产服务

# 代码质量
pnpm lint             # ESLint 检查
pnpm type-check       # TypeScript 类型检查
pnpm format           # Prettier 格式化

# 数据库
pnpm db:generate      # 生成迁移
pnpm db:push          # 推送 schema
pnpm db:studio        # 打开 Drizzle Studio

# TCR
pnpm setup:tcr        # 配置容器镜像服务

# OpenCode
pnpm opencode:setup   # 配置 OpenCode provider 和模型
```

## 技术栈

### 前端 (packages/web)
- React 19
- Vite
- Tailwind CSS 4
- shadcn/ui
- Jotai (状态管理)

### 后端 (packages/server)
- Hono
- Node.js
- Drizzle ORM
- SQLite / PostgreSQL

### CloudBase 服务
- 云函数
- 云数据库
- 云存储
- 容器镜像服务 (TCR)

### AI Agent
- Claude Code
- OpenAI Codex
- GitHub Copilot
- Google Gemini
- @tencent-ai/agent-sdk

## 与上游项目的关系

本项目 fork 自 Vercel 的 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template)，主要变化：将 Next.js 全栈架构重构为 Monorepo 前后端分离（React + Vite / Hono），部署平台从 Vercel 迁移到腾讯云 CloudBase，Sandbox 从 Vercel Sandbox 替换为 CloudBase SCF。

## Contributing

欢迎参与贡献。

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/xxx`)
3. 提交修改，确保通过以下检查：
   ```bash
   pnpm type-check
   pnpm lint
   pnpm format
   ```
4. 提交 Pull Request

请遵循项目现有的代码风格。日志中不要包含动态值（详见 [AGENTS.md](./AGENTS.md) 中的安全规则）。

## Acknowledgments

- [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) by Vercel — 本项目的上游基础
- [CloudBase](https://cloudbase.net/) — 云开发基础设施
- [CodeBuddy](https://copilot.tencent.com/) — AI 编程助手能力
- [Hono](https://hono.dev/) — 轻量级 Web 框架

## License

本项目基于 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) (Copyright 2025 Vercel, Inc.) 重构改造，原项目采用 [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0) 许可。

本项目沿用 Apache License 2.0，详见 [LICENSE](./LICENSE) 和 [NOTICE](./NOTICE) 文件。
