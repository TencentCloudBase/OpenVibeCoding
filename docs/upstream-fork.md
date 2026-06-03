# Upstream baseline（硬分叉）

记录本仓库相对 **TencentCloudBase/OpenVibeCoding** 的分叉与同步历史。本线以 **硬分叉** 为前提：沙箱 infra 等改动与上游 **不保证长期可 merge**，合并后仍需人工回归。

## 血缘

| 层级 | 仓库 |
| --- | --- |
| 最初模板 | [vercel-labs/coding-agent-template](https://github.com/vercel-labs/coding-agent-template) |
| **直接上游（功能同步来源）** | [TencentCloudBase/OpenVibeCoding](https://github.com/TencentCloudBase/OpenVibeCoding) |
| **本线** | 当前仓库 `feature/stateful-infra` 及后续分支（沙箱 infra / Stateful + 沙箱业务镜像） |

## 硬分叉基线（不变）

首次从上游拉出本线时的截止点，**不随后续 merge 改写**：

| 项 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/TencentCloudBase/OpenVibeCoding` |
| 上游默认分支 | `main` |
| **硬分叉基线 commit** | `43c3e6038d833481c2fd0d4d206f4a801de7a750` |
| 说明 | `Merge branch 'feautre/env-pool'` |
| 日期 | 2026-05-21 |
| 本线记录分支 | `feature/stateful-infra` |

在此 commit 之前与上游同源；**之后**本线增加沙箱 infra 等不可直接兼容的改动。

### 本线相对上游的持久差异（示例）

- 沙箱 infra：Stateful Tool / 实例生命周期、gateway 数据面、沙箱业务镜像 vibecoding 镜像（**无** SCF `scf-sandbox-manager`）
- preview / terminal：`/preview/5173`、`/preview/7681` 经 OVC 代理；WebSocket 升级**不转发**浏览器 `Origin`（防 gateway 403）
- ttyd：TRW 真监听 `:7681`，已删除 `ttyd-gateway-port.ts` 虚拟端口探测 shim
- 环境：`TCB_API_KEY`、`.env.local` / `.env.cloud` 双文件 init（main 仍偏 `packages/server/.env` + SCF 镜像变量）
- `WORKSPACE_ISOLATION` 默认与进度文案（本线偏 shared + Stateful TTL）
- 公开 TCR 默认镜像、`stateful-vibecoding-image` 解析链

## 上游同步记录

| 日期 | 方式 | 上游 `main` 顶 | 本线 merge commit | 备注 |
| --- | --- | --- | --- | --- |
| 2026-05-21 | `git merge origin/main` | `a878ddbbee2f6320395dc7f84a7e6a068c524e75` | `20dedbdbb00997d8f23c289317836de14df44d60` | 无冲突；含下方 5 个上游 commit |
| 2026-05-25 | `git merge origin/main` | `4592517`（fix readme 等） | （merge commit） | 约 10 文件冲突；保留 AGS/沙箱业务镜像 路径 |
| 2026-05-27 | `git merge origin/main` → `feature/stateful-infra` | `dc70b08d8e3019884b51a9b4ae219b7a1af8d439` | `0d4e65b` → `81dcf89` | 试跑分支 fast-forward 合入；冲突见 5/27 行；`type-check` / `lint` / `build` 通过 |
| 2026-06-03 | `git merge origin/main` → `feature/stateful-infra` | `b783b227964054dcd4ee3ead17ea628d0a7839b1` | `f9de960`（本线顶 `53d902d`） | MCP 对话 + 自定义 MCP；删 `scf-sandbox-manager`；合并后 `1438db3` 去 ttyd shim、`53d902d` web 类型修复 |

**历史：2026-05-21 并入**（`43c3e60..a878ddb`）：

| SHA | 说明 |
| --- | --- |
| `a5543ba` | feat: 优化 opencode 安装描述 |
| `a774c74` | feat: codebuddy 支持 tokenhub |
| `03745a9` | feat: 初始化添加配置自定义模型功能 |
| `4669043` | Merge pull request #23（CodeBuddy TokenHub） |
| `a878ddb` | feat: 更新 agent 选项 |

**历史：2026-05-27 并入**（`4592517..dc70b08`）：

| SHA | 说明 |
| --- | --- |
| `6dc789f` | docs: add community qrcode to readmes |
| `8fcb9f8` | docs: add community |
| `90fe835` | docs: update readme community |
| `f5be7cb` | feat: Coding 模式自动放行写工具 |
| `a392f46` | fix(opencode): OpenCode runtime 云托管可用 |
| `1236a37` | feat: podman fallback for docker |
| `e042616` | fix: TCR login + podman |
| `f801dd3` | feat: enterprise TCR in init.mjs |
| `645b1f2` | docs: enterprise TCR setup guide |
| `24f9bba` | Merge PR #27 podman-fallback |
| `dc70b08` | feat(init): TCR enterprise registry |

**本次并入的上游 commit**（`dc70b08..b783b22`，2026-06-03 合并）：

| SHA | 说明 |
| --- | --- |
| `34956ef` | fix(sandbox): DefaultDomain 动态拉取（DescribeCloudBaseGWService） |
| `e81d5cc` | fix: 修正安全域名添加规则 |
| `1ac741f` | fix: 预览域名 + shared 环境 ensure 域名 |
| `866659f` | fix: AskUserQuestion 答完后新一轮消息不出现 |
| `6f0cf02` | feat: 支持对话时添加 MCP 服务（PR #29） |
| `454dd7e` | feat: 支持 SSE / stdio 自定义 MCP（PR #30） |

**合并后本线追加**（不在 upstream `main`）：

| SHA | 说明 |
| --- | --- |
| `1438db3` | refactor(sandbox): TRW 真 `:7681`，删除 `ttyd-gateway-port` shim |
| `53d902d` | fix(web): MCP 合并余波（`mcpServerList` 类型、`refreshTasks` 重复声明） |

**当前对齐状态**（2026-06-03，分支 `feature/stateful-infra`）：

- `git merge-base HEAD origin/main` → `b783b22`（与上游 `main` 最新对齐）
- 功能分支顶：`53d902d`（merge `f9de960` + 上表两行本线 fix）
- 本线保留：Stateful 沙箱、`TCB_API_KEY`、双 env 文件、preview WS 不转发 `Origin`、无 SCF sandbox 路径
- 从上游并入：MCP 对话 / 自定义 MCP、预览与安全域名修复、AskUser 续聊修复；以及 5/27 段的 OpenCode / TCR / podman 等
- 回归：本地 `pnpm dev`；云端 `pnpm deploy:cloud`（服务 `vibecoding-platform`）
- 中文与 stateful 说明：[README-zh.md](../README-zh.md)、[setup.md](./setup.md)

下次看上游新提交：

```bash
git fetch origin
git log b783b22..origin/main --oneline
```

## 偶尔从上游同步（推荐流程）

```bash
git fetch origin

# 自上次对齐的顶往下看
git log b783b227964054dcd4ee3ead17ea628d0a7839b1..origin/main --oneline

# 整分支合并（可能冲突，需人工解）
git merge origin/main

# 或单 commit
git cherry-pick <upstream-sha>
```

大范围对齐后：在 **上游同步记录** 表追加一行，并视情况把「自上次对齐的顶」更新为新 `origin/main` HEAD。仅当 intentionally 重置分叉叙事时才改 **硬分叉基线** 表。

## 校验（可选）

```bash
# 硬分叉点仍在历史中
git merge-base HEAD 43c3e6038d833481c2fd0d4d206f4a801de7a750

# 是否与上游 main 对齐到记录中的顶
git merge-base HEAD origin/main
```

## 远程

| remote | 用途 |
| --- | --- |
| `origin` | 指向 `TencentCloudBase/OpenVibeCoding`（本仓库 push 需组织 Write 或 fork） |

可选单独 `upstream` 同名仓库仅 fetch，与 `origin` 二选一即可。
