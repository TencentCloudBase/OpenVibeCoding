# CloudRun 部署（云托管）

一体容器（`Dockerfile`）在进程内监听 **`PORT`（云端为 80）**。密钥**不打进镜像**（`.dockerignore` 排除 `.env*`）。

## 和本地开发的关系

| | 本地 | 云托管 |
| --- | --- | --- |
| 环境文件 | `.env.local` | `.env.cloud` |
| 启动 | `pnpm dev` | `pnpm deploy:cloud` |
| 对外端口 | 3001 + Vite 5174 | **80** |
| 沙箱 TRW | 经 gateway，容器内 **9000** | 同上（与云托管 80 **无关**） |

不要在云托管控制台把服务端口改成 9000。

## 环境文件

| 文件 | 用途 |
| --- | --- |
| `.env.example` | 文档模板（可提交） |
| `.env.local` | 仅本地 `pnpm dev` |
| `.env.cloud` | `pnpm deploy:cloud`：CLI 凭证 + 运行时变量（尝试 API 同步） |

`./init.sh` 每次只生成其一；两份都要则 init 跑两次。云端常见差异：`PORT=80`、`NODE_ENV=production`、`ASK_USER_BASE_URL` 为公网根 URL。

## 一键部署

```bash
pnpm deploy:cloud
```

执行顺序（`scripts/deploy.mjs`）：

1. **立即**输出控制台链接（`envId` + 服务 `vibecoding-platform` → 部署记录 Tab）
2. `cloudbase cloudrun deploy` 上传仓库 + `Dockerfile`（上传阶段 CLI **无百分比**，脚本约每 15s 打印心跳）
3. 提交成功后**轮询** API：服务 `Status`、部署记录（若有）；Docker 构建明细以控制台为准
4. **`ASK_USER_BASE_URL` 写回**：若仍为占位 / `YOUR-SERVICE` / 仅 localhost，且能读到默认域名，则写入 `.env.cloud`  
   - 示例：`https://vibecoding-platform-198076-5-1253192607.sh.run.tcloudbase.com`  
   - 无 scheme 的 hostname 会自动补上 `https://`
5. 尝试 `UpdateCloudRunServer` 同步 `.env.cloud` → 云托管环境变量；失败时在控制台 → 服务配置 **手贴**

### 可选参数

```bash
pnpm deploy:cloud --no-wait        # 只提交，不轮询（CI / 自己盯控制台）
pnpm deploy:cloud --skip-env-sync    # 不同步环境变量
```

### 建议

- 在**本机终端**跑完整部署，避免 IDE 内置终端 2–3 分钟超时打断上传
- 构建失败：控制台 → 部署记录 → 查看 Docker 构建日志（与本地 `pnpm build` 同源）

## 部署后检查

- 默认域名可访问：`GET /health`
- `.env.cloud` 中 `ASK_USER_BASE_URL` 与浏览器打开的公网根 URL 一致（勿为 `127.0.0.1`）
- 登录、创建任务，确认沙箱与预览
- **勿**配置 `STATEFUL_TOOL_ID`（多副本用 DB + `openvibecoding-{TCB_ENV_ID}`）

沙箱问题见 [setup.md](./setup.md) 排障章节。
