# OVC ↔ TRW API 对齐

对照仓库：`tcb-remote-workspace`（`ENABLE_VIBECODING` + `ENABLE_GIT_ARCHIVE` preset）。  
上游路由台账：`tcb-remote-workspace/docs/vibecoding-branch-sync.md`。

## TRW 路由（OVC 会调用的）

| 方法 | 路径 | TRW 开关 | OVC 调用处 |
| --- | --- | --- | --- |
| GET | `/health` | 始终 | `base-runtime` 探活 |
| PUT | `/api/workspace/env` | 始终 | `stateful-provider`、`cloudbase-mcp` 注入凭证 |
| POST | `/api/workspace/init` | 始终 | `stateful-provider` 初始化工作区 |
| POST | `/api/workspace/snapshot` | 始终 | `stateful-provider` 可选快照 |
| POST | `/api/tools/:tool` | 始终 | mcporter / bash / read 等 |
| GET | `/preview/ports` | vibecoding | `tasks.ts`、`wait-vite-ready` |
| GET | `/preview/:port` | vibecoding | 预览代理 |
| POST | `/api/extend/git_push` | `ENABLE_GIT_ARCHIVE` | `git-archive.ts` |
| POST | `/api/jobs/miniprogram-deploy` | `ENABLE_VIBECODING` | `trw-miniprogram-client.ts` |
| GET | `/api/jobs/:jobId` | `ENABLE_VIBECODING` | 同上（轮询） |

## 已废弃（OVC 不再调用）

| 旧路径 | 替代 |
| --- | --- |
| `POST /api/session/init` | `POST /api/workspace/init` |
| `PUT /api/session/env` | `PUT /api/workspace/env` |
| `GET /api/scope/info` | 无（单工作区 `/home/user`） |
| `POST /api/miniprogram/deploy` | `POST /api/jobs/miniprogram-deploy` |
| `GET /api/miniprogram/deploy/status` | `GET /api/jobs/:jobId` |
| `POST /api/tools/git_push` | `POST /api/extend/git_push` |
| `POST /api/tools/miniprogram_deploy` | 仅 jobs HTTP |

## OVC 实现要点

- **共享客户端**：`packages/server/src/sandbox/trw-miniprogram-client.ts`
- **响应适配**：`packages/server/src/sandbox/trw-deploy-adapter.ts`（TRW Job → 旧 MCP envelope）
- **CodeBuddy / Stateful MCP**：`stateful-mcp-client.ts`
- **OpenCode CloudBase MCP**：`publishMiniprogram.ts`、`getDeployJobStatus.ts`
- **小程序开关**：`STATEFUL_MINIPROGRAM_FEATURE=true`（TRW 镜像需 `ENABLE_VIBECODING`）
- **Git 归档**：OVC 配 `GIT_ARCHIVE_*`；TRW 容器配同名变量 + `ENABLE_GIT_ARCHIVE`
