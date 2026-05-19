# Stateful Infra 交接：来自 `feat/multi-infra` 的经验

> **读者**：`feature/stateful-infra` 分支上的实现者。  
> **归档分支**：`feat/multi-infra` @ `5ff49a9`（tag：`archive/feat-multi-infra`）  
> **新分支基线**：`main` @ `68e6871` 及之后 —— **不含** SCF/AGS 双开关代码。  
> **日期**：2026-05-19

---

## 1. 我们为什么换路线

| 旧路线 (`feat/multi-infra`) | 新路线 (`feature/stateful-infra`) |
|-----------------------------|----------------------------------|
| `SANDBOX_BACKEND=scf\|ags` 同树维护 | 从 `main` 切出，**只服务有状态沙箱** |
| 每合一次 `main` 都要解 agent/tasks 冲突 | SCF 留在 `main`，本分支不背零回归 |
| 路由里大量 `if (backend === 'ags')` | 产品层叫 **stateful sandbox**，不必暴露 AGS/Talos 品牌名 |
| 追 61 commits 体感「永远合不完」 | 按周/按 tag 从 `main` cherry-pick 共享层（鉴权、Task、DB） |

**结论**：双 infra **开关**适合「同一 release 里两种后端」；你们下一步是 **TRW 最新有状态玩法 + manager-node 控制面 + e2b 数据面** → **单独分支更对**。

---

## 2. 在 `feat/multi-infra` 上做过什么（可当考古索引）

### 2.1 交付物

- `SandboxProvider` 抽象：`acquire` → `prepare` → `release`，外加 `createMcpClient` / `getPreviewBaseUrl` / `deleteConversation`
- `scf-provider`：薄包装 `scf-sandbox-manager`（**新分支不要 port SCF**）
- `ags-provider` + `sandbox/ags/*`：manager-node 启停实例 + gateway `request()` + `e2b-native-client` 读写跑命令
- `scripts/verify-ags-e2e.ts` + `pnpm verify:ags`：13 步探针（可改名为 stateful 探针）
- 合入 `origin/main` 后的冲突决议：以 **main 业务为准**，AGS 逻辑只留在 provider/ags 块内

### 2.2 刻意没收口的（留给 stateful 分支重做）

- `tasks.ts` 里残留的 backend 分支（计划 Phase E：收到 Provider 方法）
- Talos（仅占 env 枚举）
- MCP / tool-override **按 backend 拆文件**（P2/P2b 已取消，见下）

---

## 3. 架构思考（新分支应继承）

### 3.1 两层控制面（不必在 API 里写 AGS/Talos）

| 层 | 职责 | 频率 | 典型 API |
|----|------|------|----------|
| **模板 / 规格** | Tool（SDT）、镜像、资源规格 | 部署期 | manager-node `CreateTool` / 部署脚本 |
| **运行态实例** | 某次对话/任务用的沙箱进程 | 按需 | manager-node Start/Describe/Stop + gateway |

上层统一叫 **stateful sandbox** 即可；实现仍是 CloudBase AGS（及未来 Talos），**控制面走 manager-node**，不要在每个路由名里绑 `ags`。

### 3.2 数据面：e2b SDK

- **控制面**：创建/复用/停止实例、查状态 → **manager-node**（`@cloudbase/manager-node`，AGS 服务 `ags` API 版本 `2025-09-20`）。
- **数据面**：读文件、写文件、exec/bash → **e2b SDK**（归档分支里 `ags/e2b-native-client.ts` 已验证可行）。
- **TRW 网关**：`instance.request('/api/workspace/*')` 做凭证注入、workspace init；与 SCF 的 `/api/session/*` **不是一套协议**，新分支只跟 **master TRW `/api/workspace/*`**。

### 3.3 生命周期（上层只认三阶段）

```
acquire(ctx)     // 拿到/复用实例（shared vs isolated 由 WORKSPACE_ISOLATION 等决定）
    ↓
prepare(inst)    // 注凭证、workspace init、定 cwd / coding scope（预览前是否需要单独再 init 要想清楚）
    ↓
[agent: MCP + request + e2b]
    ↓
release(inst)    // 归档/快照/推 git（跟 TRW 约定一致）
    ↓
destroy / deleteConversation  // 删 task、TTL、停实例
```

**Tool（SDT）**：环境级，**部署脚本创建一次**；Provider **只读** `STATEFUL_TOOL_ID`（或你们最终 env 名），不要在每个 task `acquire` 里建 Tool。

**关键教训（来自 SCF 零回归）**：

- **预览 health / preview-url（SSE）** 不要和 **workspace 冷启动** 绑在同一条 `prepare` 链上，否则和 Vite 抢 `session/init` 类竞态。
- **Agent 对话** 可以 `prepare`（health + init）；**纯预览轮询** 应尽量少动实例状态。
- **save-file**：写盘成功后异步持久化，**不阻塞** HTTP 响应。

### 3.4 Provider 接口仍值得用（但单 backend）

归档分支的 `packages/server/src/sandbox/provider/types.ts` 可直接当 **stateful 版类型草图**：

- 删掉 `scf` / `talos` 联合，只保留一个 `backend: 'stateful'` 或不暴露 backend。
- `SandboxInstance`：`id`（instanceId）、`templateId`（toolId）、`baseUrl`、`request()`、`getAuthHeaders()`。
- **`meta` 黑盒**：上层禁止读 `functionName` / 旧 SCF 字段。

### 3.5 设计决策：不先拆 shared MCP（P2/P2b 取消）

> 「任何环节都能分叉替换」> 「共用实现 + 到处 if」。

- SCF 的 `sandbox-mcp-proxy.ts` / `tool-override.ts` **不要**为了 stateful 先大 refactor。
- Stateful 写 **独立的** `stateful-mcp-client.ts`（可参考 `ags-mcp-client.ts`），稳定后再抽 `shared/`。
- 避免在合 `main` 时动 SCF 热路径。

---

## 4. 合主干与协作教训

1. **热点文件**：`cloudbase-agent.service.ts`、`tasks.ts` —— 与 `main` 同改必冲突；stateful 分支应 **少改 tasks**，逻辑进 Provider。
2. **合 main 顺序**：先 commit WIP → merge `origin/main` → 冲突时 **SCF/main 业务优先**（对 stateful 分支则是 **main 共享层优先**）。
3. **落后 61 commits 时**：干净树 merge 可能无冲突，**有 WIP 才爆** —— 控制 WIP 粒度。
4. **配置**：敏感与泳道只写 `packages/server/.env`（注释说明），`.env.example` 只放非 secret 模板；**测试 Tool 与生产 Tool 分开**（曾用 `sdt-bjqg7iaw` vibecoding vs 主线 `sdt-987gpzk2`）。
5. **验收分离**：stateful 探针（原 `verify:ags`）与 SCF 回归矩阵 **分开跑**，不要混 CI 默认路径。

---

## 5. 从归档分支「抄作业」清单

| 优先 | 路径 | 用途 |
|------|------|------|
| 高 | `sandbox/provider/types.ts` | 接口与 Context 分型 |
| 高 | `sandbox/ags/ags-provider.ts` | manager-node 生命周期（改名 stateful-provider） |
| 高 | `sandbox/ags/ags-mcp-client.ts` | workspace env + MCP in-process |
| 高 | `sandbox/ags/e2b-native-client.ts` | e2b 数据面 |
| 中 | `scripts/verify-ags-e2e.ts` | E2E 探针模板 |
| 中 | `sandbox/trw-deploy-adapter.ts` | TRW 部署相关（若仍适用） |
| 低 | `scf-provider.ts` | **仅对照，不 port** |
| 低 | `routes/tasks.ts` 里 AGS 块 | **仅作行为对照**，实现应重写进 Provider |

```bash
# 查看归档实现
git show archive/feat-multi-infra:packages/server/src/sandbox/provider/ags-provider.ts
git diff main..archive/feat-multi-infra -- packages/server/src/sandbox/
```

---

## 6. `feature/stateful-infra` 建议的第一批任务

1. **定 env 名**：如 `STATEFUL_TOOL_ID`、`TCB_API_KEY`、`STATEFUL_GATEWAY_URL`（避免继续用 `AGS_*` 若产品不想暴露）。
2. **实现 `StatefulSandboxProvider`**：`acquire` / `prepare` / `release` + `getExisting`。
3. **agent 只调 Provider**：从 `cloudbase-agent.service.ts` 接入，**不**恢复 `scfSandboxManager` 直连。
4. **tasks 最小改动**：preview、files、terminal 逐步迁到 Provider 方法；preview 遵守 §3.3 竞态教训。
5. **引入/锁定 e2b SDK 版本**，与 TRW 镜像内 runtime 对齐。
6. **文档**：本文件 + `.plans/stateful-infra-roadmap.md`（迭代计划放 `.plans/`，已 gitignore）。

---

## 7. 仍有效的验收思路（改成 stateful 语义）

| # | 场景 | 通过标准 |
|---|------|----------|
| S1 | 新建 coding task + 对话 | instance 复用/创建日志清晰；workspace init 一次 |
| S2 | preview-url SSE | 无多余 init 竞态；Vite 就绪 |
| S3 | preview-health | 探活路径与 TRW master 一致（非 SCF scope/info） |
| S4 | 读写信 | e2b 或 gateway 文件 API 通畅 |
| S5 | 删 task | 停实例 + 清理策略符合产品 |
| S6 | `pnpm verify:stateful`（待改名） | 无人工点 UI 的自动化探针 |

---

## 8. 一句话带走

**控制面 manager-node、数据面 e2b、协议 TRW workspace、生命周期 acquire/prepare/release；Tool 部署期、Instance 运行期；不要和 main 上的 SCF 共分支维护。**

归档分支是 **付钱买的教训**；新分支 **重写路由、复用思路、复用 ags 目录里经过验证的那几份实现**。
