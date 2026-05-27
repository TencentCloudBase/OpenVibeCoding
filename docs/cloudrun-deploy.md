# CloudRun 部署（云托管）

一体容器（`Dockerfile`）监听 **80**。密钥**不打进镜像**（`.dockerignore` 排除 `.env*`）。

## 环境文件

| 文件 | 用途 |
| --- | --- |
| `.env.example` | 文档模板（可提交） |
| `.env.local` | 仅本地 `pnpm dev` |
| `.env.cloud` | `pnpm deploy:cloud` 读此文件（CLI 凭证 + 部署后同步到服务的运行时变量） |

`./init.sh` 每次只生成其一：选 1 → `.env.local`，选 2 → `.env.cloud`；两份都要则跑两次 init。云端差异主要是 `PORT`、`NODE_ENV`、`ASK_USER_BASE_URL`。

## 一键部署

```bash
pnpm deploy:cloud
```

1. 使用 `.env.cloud` 中的 `TCB_*` 调用 CloudBase CLI 上传源码并云端构建  
2. 部署完成后将 `.env.cloud` 同步到服务 `EnvParams`（无需手抄控制台）  
3. 若 API 同步失败，脚本会提示到控制台粘贴 `.env.cloud`

跳过环境变量同步（仅上传代码）：

```bash
pnpm deploy:cloud --skip-env-sync
```

## 部署后

- 构建进度：控制台 → 云托管 → 服务 `vibecoding-platform` → 部署记录  
- 确认 `ASK_USER_BASE_URL` 为公网根 URL（勿用 `127.0.0.1`）  
- 勿配置 `STATEFUL_TOOL_ID`（多副本用 DB + `openvibecoding-{TCB_ENV_ID}`）

## 验证

1. `GET /health`  
2. 登录并创建任务，检查沙箱与预览  
3. 沙箱失败见 [setup.md](./setup.md) 排障
