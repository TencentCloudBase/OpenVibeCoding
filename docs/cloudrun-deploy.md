# CloudRun 部署（云托管）

OVC 以根目录 `Dockerfile` 构建**前后端一体**容器，监听 **80**。环境变量在控制台配置，**不要**把 `packages/server/.env` 打进镜像（`.dockerignore` 已排除）。

## 前置

- 已完成 `./init.sh`（或手动具备 `TCB_ENV_ID`、`TCB_SECRET_ID`、`TCB_SECRET_KEY`）
- `packages/server/.env` 中沙箱与 Agent 相关变量与本地一致（部署后在控制台再填一份）
- 已安装 CloudBase CLI：`npm i -g @cloudbase/cli` 且 `cloudbase login`

## 一键部署

```bash
pnpm deploy:cloud
```

- 服务名默认：`vibecoding-platform`
- 云端从源码 + `Dockerfile` 构建，无需本机 Docker
- 构建进度：控制台 → 云托管 → 服务详情 → 部署记录

## 控制台必改项（相对本地）

| 变量 | 值 |
| --- | --- |
| `PORT` | `80` |
| `NODE_ENV` | `production` |
| `ASK_USER_BASE_URL` | 云托管公网根 URL（如 `https://xxx.run.tcloudbase.com`），**不能**用 `127.0.0.1` |

其余与本地 `packages/server/.env` 同名：`TCB_*`、`TCB_API_KEY`、`CODEBUDDY_*`、可选 `GIT_ARCHIVE_*` 等。勿配置 `STATEFUL_TOOL_ID`（多副本应走 DB + `ovc-{TCB_ENV_ID}` Tool 名）。

## 部署后验证

1. 打开控制台给出的默认域名，`GET /health` 为 ok
2. 登录并创建任务，确认沙箱进度与预览
3. 若沙箱失败，对照 [docs/setup.md](./setup.md) 沙箱排障；本地可用 `pnpm --filter @coder/server stop:stateful-instances`

## 与上游 main

`scripts/deploy.mjs` 与上游 `TencentCloudBase/OpenVibeCoding` `main` 对齐；合并上游后优先保留本分支 stateful 相关 env 说明。
