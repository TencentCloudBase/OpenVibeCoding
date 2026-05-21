# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **CodeBuddy 自定义模型支持**：`CODEBUDDY_USE_CUSTOM_MODELS=true` 时按 `.config/.codebuddy/models.json` 模板加载模型列表，前端 listModels / SDK modelId 校验都走自定义白名单；`false` 时保留 SYSTEM_MODELS 写死的官方列表
- **环境隔离粒度配置**（Issue #14）：admin 可在 `/admin/settings` 切换 `shared` / `isolated` / `task` 三种 provision mode，DB 优先级高于 env 默认，配 source badge 与重置按钮
- **环境池（Environment Pool）**：预创建 CloudBase 环境 + CAM + Policy，task/isolated 模式获取环境从分钟级降到毫秒级
  - 统一生命周期接口 `acquireEnv()` / `releaseEnv()`，屏蔽池化实现细节
  - 管理后台 `/admin/env-pool` 页面：池配置（开关 + 容量）、实时状态监控、手动补充、释放池
  - 配置存 DB（`env_pool_enabled` / `env_pool_size`），admin UI 可动态修改无需重启
  - 多 Pod 安全：认领用 CAS 原子操作，补充用分布式锁（settings 表 TTL 锁）
  - 池空自动回退实时创建，零停机降级
- **CloudBase MCP 通用 middleware 框架**：`lib/mcp-middleware/` 提供 koa 风格中间件，配置驱动的工具拦截/新增/过滤；policy 文件按工具名平铺在 `middleware/mcp/cloudbase/`（auth、cronTask、uploadFiles、publishMiniprogram、downloadTemplate、getDeployJobStatus 等 13 个）
- **CloudBase Dashboard 集成**：在 task 详情页内嵌可视化 dashboard（DB 集合 / Storage / SQL / Functions），envId/taskId 通过 Context 强制显式参数化，所有请求自动带 `?envId=` 与 `X-Task-Id`
- **数据库自定义安全规则**：CollectionPermissions 切到 `DescribeSafeRule` / `ModifySafeRule`，支持 CUSTOM 模式编辑 JSON 安全规则
- **CloudBase 上传后端签发**：新增 `POST /api/storage/upload-credential`，用永久密钥（优先用户级 / 兜底支撑账号）调 STS 签出临时凭证，避免子账号 GetFederationToken 触发 GrantOtherResource
- **运维脚本**：`scripts/reset-user-cam-secrets.ts` 清理用户失效的 user-level CAM 密钥
- **GitHub Action**：`.github/workflows/claude-code.yml`，issue/PR 中 `@claude` 触发 AI agent

### Changed

- **Provision mode 语义重构**：
  - `shared`：注册不写 user_resources；middleware 直接用 `TCB_SECRET_ID/KEY` + `TCB_ENV_ID`
  - `isolated`：注册同步预建 user-level env / CAM / AK / Policy；所有 task 共享该 env
  - `task`：注册不建；每个 task 创建时同步建独立 env + 独立 CAM 子账号 `vibe_t_{taskId}` + 独立 AK + Policy（解决之前所有 task 共用同一 CAM 用户互相轮换密钥的 bug）
- **`requireUserEnv` 中间件**按 mode 短路解析；新增 taskId hint / envId hint 三级解析路径，capi 路由透传 version、错误响应附 RequestId/Code
- **统一 SDK / HTTP 两条 MCP runtime 凭证注入**：调用方从传 `getCredentials` 闭包简化为 `userId+envId`，HTTP runtime 增加 `X-Env-Id` header 支持过期自动重注入
- **Dashboard envId 切换重置**：切环境时立即清空 `activeCollection` / `activeBucket` / `storagePrefix` 与 sidebar 集合列表，避免对新 env 发起旧集合查询
- **Preview iframe 协议接入**：`usePreviewBridge` hook 封装事件监听 + 指令发送 + RPC；BrowserControls 改用 postMessage 指令替代 contentWindow.history API；新增 HMR 状态指示灯、URL 同步、health check via bridge.ping

### Fixed

- **资源销毁失败保留 DB row**：`destroyProvisionedResources` 返回 `{ steps, failed }`，NotFound 类视为幂等成功；删 task / 删用户时云资源未清完返回 409，DB row 保留可重试（如 env "云存储域名尚在初始化中" 场景）
- **task 级 CAM 用户独立**：之前所有 task 共用 `vibe_{userId}`，新 task provision 时轮换密钥导致旧 task DB 里存的 AK 全部失效；改用 `vibe_t_{taskId}` 后每个 task 独立子账号
- **userResources cache key 包含 envId**：原本只按 userId 缓存临时凭证，跨 envId 请求会拿到错 envId 的 token；改成 `userId:envId`
- **集合权限设置真实接口对接**：之前是 mock，现已切到 `DescribeSafeRule` / `ModifySafeRule`
- **删用户清理范围扩大**：从 `findByUserId`（仅 user-level）改为 `findAllByUserId`，遍历销毁所有 scope（user + 每个 task）
- **dashboard 切环境后旧 collection 残留**：DatabasePage / DatabaseMenu / StorageMenu 监听 envId 变化重置内部 state，并加 cancelled 防 fetch 竞态
- **Provision policy 拆分**：保留 `buildUserEnvPolicyStatements`（CAM 大策略，81 action）；新增 `buildStsInlinePolicyStatements`（STS GetFederationToken 用，规避腾讯云子账号 grant 限制 + 33 action 上限）
- **Auth.ts ReturnType 嵌套缺层**：`Awaited<ReturnType<...findByUserId>>` 应再套一层 `ReturnType` 解函数返回值，IDE 误报 `camSecretKey` 不存在

## [3.0.0] — 2026-05-13

### Added

- **ACP Runtime 抽象层**：IAgentRuntime 接口 + 沙箱隔离 + 多轮记忆 + 持久化，支持多 runtime 并行
- **Agent 统一选择器**：合并静态 CodeBuddy 标签和 runtime 选择器为统一 Agent `<Select>`，支持 CodeBuddy / OpenCode / MiMo 三个 agent 切换
- **Per-Agent 模型选择**：每个 agent 独立模型列表，切换 agent 时自动校验 selectedModel，不存在则选列表第一个
- **MiMo 模型集成**：新增 MiMo（小米）provider 配置，支持 mimo-v2.5-pro（含图片理解）、mimo-v2.5、TTS 系列模型
- **项目级配置隔离**：OpenCode tool 安装目录改为项目级 `.opencode/tools/`，spawn 时注入 `OPENCODE_CONFIG_DIR`
- **ACP runtime 返回模型列表**：`GET /api/agent/runtimes` 每个 runtime 新增 `models` 数组
- **图片输入支持**：全栈支持多模态图片输入
- **CloudBase MCP 集成**：全局 CloudBase MCP HTTP server，复用 Express 端口，零额外 TCP 开销；支持 stdio 和 HTTP 两种模式
- **预览错误自动修复**：preview 错误时自动触发修复流程
- **stopReason 友好提示**：refusal/max_tokens 时注入用户可读的友好提示
- **SSE stopReason 透传**：透传真实 stopReason 到 SSE 终结报文
- **暂停图标**：SSE stream 中止但仍有 pending loading 状态时显示 paused 图标
- **human-in-loop 支持**：ToolConfirm + AskUserQuestion
- **前端 Runtime 选择器 UI**
- **vitest 单元测试**（27 个）

### Fixed

- **ACP 完成后发送按钮卡住**：SSE `[DONE]` 后未更新 `task.status`，现已在流结束时更新为 `done` 或 `error`
- **SSE 寿命跟随 agent 寿命**：去掉 10/30 分钟硬超时，避免长任务被强制中断
- **SDK 空响应无限循环**（patch）：GLM 模型在 tool_result 后返回空 end_turn 导致 SDK agent loop 无限空转；新增 `_emptyResponseCount` 熔断器，连续 3 次空响应后强制完成
- **Server auto-resume 空轮检测**：连续 2 次 dry resume（无内容产出）后立即停止，避免浪费模型调用
- **ExecutionError 不再被吞**：按 stopReason='error' 正确收尾
- **askAnswers/toolConfirmation 路由修复**：必须路由到 runtime.chatStream resume 分支
- **MCP CloudBase 认证修复**：改用当前登录用户 apiKey，sessionJwe 鉴权复用
- **ERR_HTTP_HEADERS_SENT**：用 x-hono-already-sent 防止重复发送
- **archiveToGit 修复**：移到 finally 块，error/cancel 场景也归档
- **生产镜像修复**：移除已迁移目录的 cp 步骤 + 拷贝 .opencode/
- **文件浏览器 Cmd+C 冲突**：全局快捷键不再拦截用户已选中文本的复制操作

### Changed

- **`CODING_AGENTS` 静态列表**：前端静态 agent 列表 + 后端 availability check 驱动 disabled 状态
- **多 agent 共享 runtime**：`opencode` 和 `mimo` 均映射 `opencode-acp` runtime
- **tool overrides 迁移**：移至 `.opencode/tools/`，简化 installer

---

## [2.1.0] — 2025-05-03

### Added

- **沙箱创建进度可见**: Coding 任务启动时，前端状态指示器现在会细分显示沙箱各阶段进度（镜像拉取 → 容器就绪 → 工作区初始化），不再全程显示"准备中..."。（`emitPhase('preparing', 'sandbox:xxx')` → `AgentStatusIndicator` 按阶段动态出文案）

- **Dev server 启动失败快速报错**: Coding 模式下，vite 或 npm install 失败时错误原因会立即透传给前端（`viteFailureReason`），不再等待 120s 超时才报错。预览 URL 也改为等待 `viteReady === true` 再返回，避免拿到 URL 后立即 502。

- **Default 模式任务分类**: Default Agent 现在会先判断任务类型再行动——对话/创作类需求直接输出文本，编程/工程类才调用工具。（`buildAppendPrompt` 为 default 模式注入 `task-classification` guideline，coding 模式不受影响）

- **子工作区隔离 (Scope API)**: 同一 session 内支持多个相互隔离的子工作区，通过 `X-Scope-Id` / `X-Scope-Template` 头控制；每个 scope 独立运行 vite dev server（端口 5173-5199 动态分配）；`GET /api/scope/info` 返回工作区路径和 vite 状态。

- **小程序部署进度轮询**: 小程序部署超过 60s 时接口异步返回 `{ async: true, jobId }`，客户端轮询 `GET /api/miniprogram/deploy/:jobId` 获取实时构建日志，不再因超时直接报错。

- **凭证安全加固**:
  - session 云凭证（SecretId/SecretKey/SessionToken）从明文 `.session-env.json` 改为 AES-256-GCM 加密存储（`src/session-env.ts`）
  - Git remote URL 不再嵌入 token，改用内存 credential helper 在 push/fetch 时动态注入，`git remote -v` 不再泄露凭证

- **ImageGen 图片生成**（Default 模式可用）: 生成的图片自动上传到 CloudBase 静态托管并返回 CDN 公开链接，Agent 在聊天中直接展示图片。前端 `ImageGen` / `ImageEdit` 工具卡片支持 Markdown 渲染，CDN 图片内联显示。（`GET /api/storage/presign?bucketType=static&key=xxx` 生成 COS 预签名 PUT URL，tool-override 直接 PUT 到 COS，不经过 server）

- **文件浏览器下载**: 右键菜单新增文件下载（直接流式返回）和文件夹下载（沙箱内 `zip -r` 打包后流式返回）。临时 zip 存放在 `.tmp/`（已 gitignore），传输完成后删除。

- **管理员用户管理 — API Key 列**: 用户列表新增 API Key 一列，支持复制和重置；管理员可为任意用户生成新 key（`POST /api/admin/users/:id/api-key/reset`）。新注册用户自动生成 API key。

- **CloudBase 数据库集合权限加固**: 所有系统集合（users/tasks/keys 等）在首次访问时自动通过 `ModifySafeRule(AclTag=ADMINONLY)` 设为管理员专用，阻止前端 Web SDK 直接读写。

### Fixed

- **Agent 响应消失** (`routes/acp.ts`): `removeAgent` 的 30s 延迟定时器可能误删新一轮同 conversationId 的注册条目，导致 SSE 轮询立即退出。改为携带 `turnId` 比对，stale 定时器跳过删除；poll loop 增加 3×500ms grace tick 让 eventBuffer 排空。

- **发送失败留下空消息** (`use-chat-stream.ts`): 消息发送失败时 UI 残留用户消息 + Agent 占位气泡。现在 `runPromptStream` 失败时同时移除两者并恢复输入框草稿；`acp-client.ts` 对非 `text/event-stream` 响应解析 JSON-RPC 错误抛 `AcpStreamError`，服务端同步拒绝（如"A prompt turn is already in progress"）可被前端正确识别。

- **历史任务打开崩溃**: 早期任务 doc 缺少 `mode`/`sandboxMode` 等字段。`CloudBaseTaskRepository` 统一走 `withTaskDefaults()` 补全默认值；`sandboxMode` 默认值改为 `'isolated'`（与新任务一致）。

- **npm install 中断后 ENOTEMPTY 死循环** (`vite-dev-manager.ts`): 上次强制中断的 npm install 会留下 `.xxx-ABCDEF` staging 目录，导致下次安装 `rename` 失败死循环。启动前自动检测并清理；npm install 遇到 ENOTEMPTY 时整删 `node_modules` 后重试。

- **Preview 302 重定向循环**: 移除 vite 的 `--base=/preview/{port}/` 参数，proxy 直接 strip 前缀后转发；区分 vite-managed 端口（保留完整路径）和普通端口（strip 前缀）的不同 proxy 策略。

- **HMR 热更新不生效**: vite 模板增加 `hmr: { clientPort: 443, protocol: 'wss' }`，浏览器 WebSocket 通过 CloudBase gateway 正确连接。

- **系统文件写入 scope 子目录**: `.capabilities`/`.mcporter`/`.skills` 在 scope 模式下被错误写入子目录。`buildSafeEnv`、`capabilityStorePath` 等统一改为解析 session root（`sessionRootFromWorkspace()`）。

- **Server 进程因沙箱连接中断崩溃**: `uncaughtException` 增加对 `EPIPE`/`ECONNRESET`/`ECONNREFUSED` 的静默处理；`unhandledRejection` 对 "Session not found" 静默降级。

- **scope/info 首次响应阻塞 ~59s**: `spawnVite` 将 tar 解压 + npm install 包裹在 `setImmediate` 中异步执行，HTTP handler 立即返回 `viteState: "starting"`，不再阻塞。

- **API Key 认证失效** (`middleware/auth.ts`): AES-CBC 每次加密产生不同密文，`findByApiKey(encrypt(plain))` 永远查不到用户。改为 API key 存储明文（`sak_xxx`，可吊销，DB 层已有 ADMINONLY 权限保护），`findByApiKey(plain)` 直接精确匹配。

### Changed

- **Coding 模板冷启动加速**: 沙箱镜像内模板只保留 `node_modules.tar.gz`（~33MB），去掉 `node_modules/`（~211MB）；`seedCodingTemplate` 拷贝速度提升 ~24x（3.7s → 150ms）。`node_modules.tar.gz` 改由模板 `postinstall` npm 脚本生成，保证缓存在所有依赖写入完成后才打包，不会出现"装一半"的脏包。

- **Skill 加载优化**: 沙箱 skill 扫描从串行 bash 调用（`ls -1`/`test -d`）改为 `ListDir` API（返回 `entry.type` 直接判断目录）；SKILL.md 读取改为 30 并发批量 + 两目录 `Promise.all`；请求数从 `2N+4` 串行降为 `2 + ceil(N/30)` 批量。

- **Sandbox 磁盘配额**: SCF 函数 DiskSize `1024` → `2048` MB。

- **Preview 健康检查降频**: 后台轮询间隔 15s → 30s；`visibilitychange` 监听，页面不可见时暂停，切回后立即检查一次。

- **⚠️ Breaking — Coding template 部署**: 模板已内置到沙箱镜像，`.env` 中的 `CODING_TEMPLATE_URL` 配置项已移除，初始化脚本也去掉了对应步骤。升级时请同步更新沙箱镜像版本。

- **Provisioning API 重命名** (sandbox 内部): `ensureWorkspace` / `ensureScope` → `ensureSessionRoot(sessionId)` / `ensureWorkspaceFor(sessionId, scopeId?, template)`，语义更清晰；`session/init` 改调 `ensureSessionRoot` 避免误触发 vite 启动。

---

## [2.0.0]

### Added

- **预览沙箱 & Browser 工具栏**: 新建 coding 模式任务后自动冷启动沙箱；右侧预览面板支持浏览器地址栏、刷新/返回/前进、设备尺寸切换；首次加载有骨架屏。
- **Agent Mode 任务切换**: 任务表单支持选择 `default` / `coding` 模式（单一 `Coding / Default` 药丸按钮）。
- **CAM 环境策略脚本**: 新增 `packages/server/src/scripts/refresh-policy.ts`，通过 CAM `UpdatePolicy` 把本地 policy 定义刷新到已部署 policyId，免重新 provision（约 1 分钟生效）。
- **TaskListPanel**: 聊天输入框上方新增可折叠任务进度面板，从 TaskCreate/TaskUpdate 工具调用提取任务列表（状态图标 + subject/activeForm + 进度计数）；TaskCreate/TaskUpdate/TaskList/TaskGet 工具卡片从消息流中隐藏，改为面板展示。
- **预览新窗口打开**: 编码模式预览工具栏新增 ExternalLink 按钮，点击在新窗口打开预览 URL，方便分享。
- **Coding mode dev server 改进**: 使用 PTY 启动 dev server；自动 patch vite.config.ts 适配 CloudBase 沙箱预览（`--base=/preview/`, `host 0.0.0.0`, `allowedHosts`）；跳过已有 package.json 但缺 node_modules 的重复 clone。
- **CAM NoSQL 数据库权限**: `buildUserEnvPolicyStatements` 新增 `tcb:QueryRecords / PutItem / UpdateItem / DeleteItem / CreateTable`（resource `*`）。

### Fixed

- **死循环: confirm-resume 工具调用**（核心）: 用户点击"允许"后 SDK 重复生成新 `callId` 再次触发 canUseTool → deny 的无限循环。综合 3 处修复：
  1. `restoreAssistantRecord` 按 `record.parts` 原序遍历，不再强制把 text part 放最后。
  2. `updateToolResult` 新增 `extraMetadata` 参数，自动剥离 SDK deny 标记（`providerData.skipRun / error`）并合并调用方补齐的字段。
  3. 方案 2 真实 MCP 执行后回填 baseline 等价 metadata（`providerData.{messageId, model, agent, toolResult{content, renderer}}` + 顶层 `sessionId`）。
     离线仿真 JSONL 与 baseline canonical identical；真机验证 SDK resume 不再重发，进入下一步调用。
- **AskUserQuestion resume 同步修复**: `askAnswers` 分支的 `updateToolResult` 补全与 toolConfirmation 相同的 providerData/sessionId。
- **乐观 UI: 允许/拒绝工具后本地即时反馈**: `handleConfirmTool` 在网络 resume 前插入本地 `tool_result`（deny→终态红叉；allow→`status:'executing'` 过渡态保持 Loader2），`apply-session-update` 只对 `'executing'` 占位做替换保证最终一致性。
- **AgentStatusIndicator 仅在最新 group 渲染**: 补 `isLatestGroup` 约束，避免下一轮对话时"模型响应中..."挂在历史 assistant 消息末尾。
- **刷新后恢复 InterruptionCard**: 从 DB `tool_result.metadata.status === 'incomplete'` 重建 `toolConfirm`，支持 `input` 为 JSON 字符串或对象两种容错。
- **confirmTool 后 UI 无反应**: resume 时把本地 `stream-xxx` 消息 id remap 到服务端 `assistantMessageId`，避免后续 SSE 找不到目标 message 而丢帧。
- **切换 task 交互态残留**: `use-chat-stream` 用 `prevTaskIdRef` 跳过 initial mount 的 reset，防止踩踏 `sendInitialPrompt` 已进入的 `streaming` 状态。
- **Phase 指示器 & 工具确认卡就地渲染**: `AgentStatusIndicator` 和 `InterruptionCard` 不再固定在输入框上方，改挂到对应 agentMessage 末尾并随滚动。
- **CAM policy 修复**: `buildUserEnvPolicyStatements` 删除非法 `flexdb:*`，新增 `tcb:CreateFunction / UpdateFunctionCode / GetFunction / InvokeFunction / ListFunctions`（resource `*`），`tcb:CreateFunction` 权限不再缺失。
- **UI 识别错误清理**: 删除 `task-form.tsx` 中重复的 `isCodingMode / mode` 定义与对象字面量重复 key；`Code` 图标引用改为已导入的 `Code2`；删除 `task-chat.tsx` 中重复的 `isCodingMode`。
- **Stream event cleanup 竞态**: 先 flush eventBuffer 再 cleanup stream events；cleanup 延迟到 `completeAgent()` 之后 600ms，让 poll loop 先排空剩余事件。
- **TCR docker login 子账号**: `setup-tcr.mjs` 通过 `STS.GetCallerIdentity` 获取 `callerUin`，子账号 docker login 用 `callerUin` 而非主账号 AppID。

### Changed

- `toolConfirmation` 真实执行从 sandbox 启动**之前**推迟到 sandbox + sandboxMcpClient ready **之后**，避免 sandbox 未就绪时写入占位文本误触发 SDK 重试。

### Chat-Detail 重构（ACP + UI）

本次重大版本面向 `chat-detail` 交互做系统性升级，借鉴官方 CodeBuddy Code 实现。目标：权限模型 / Plan 模式 / 协议层 / Phase 可视化 / 工具渲染 / Subagent 嵌套。

#### P1 · 权限模型升级

- **`PermissionAction` 四值**: `allow` / `allow_always` / `deny` / `reject_and_exit_plan`。
- **`InterruptionCard`**: 新卡片 UI 替代旧 `ToolConfirmDialog` 弹窗，消息流内渲染，不打断上下文。
- **`sessionPermissions` 白名单**: 按 sessionId 维护"本会话总是允许"的工具名集合；`canUseTool` 命中白名单直接放行。
- **双入口协同**: `canUseTool` 与 `PreToolUse hook` 都过白名单，保持行为一致。

#### P2 · PlanMode + ExitPlanMode

- **Plan 模式**: 前端传 `permissionMode: 'plan'`，SDK 切入 Plan；除 Read/Glob/Grep/ExitPlanMode 等只读工具外，写操作会被挡住。
- **`PlanModeCard`**: Rocket 图标 + 三按钮（允许执行 / 继续完善 / 拒绝退出）。
- **`plan-content.ts`**: 宽松提取器，兼容 `plan` / `allowedPrompts` / `steps` 三种 SDK 输出。
- **Plan 状态原子**: `planModeAtomFamily`（active / planContent / toolCallId），跨组件共享。

#### P3 · 协议层独立（AcpClient）

- **`AcpClient` 类**: `initializeSession` / `request` / `notify` / `stream` (AsyncIterable) / `observe` (AsyncIterable) / `cancel`。
- **`fetch-with-retry`**: 5xx 与网络错误指数退避重试。
- **纯函数抽离**: `apply-session-update.ts` 从 223 行 switch 剥离；`use-chat-stream.ts` 由 785 行减到 446 行，SSE 解析全部迁到 `AcpClient.stream`。

#### P4 · Agent Phase 可视化

- **服务端 `emitPhase` helper**: 在 5 处边界发射 `agent_phase` 事件（preparing / model_responding / tool_executing / compacting / idle）。
- **`AgentStatusIndicator`**: 4 种 phase 配 Rocket / Sparkles / Hammer / Archive 图标；`aria-live="polite"` 支持屏幕阅读器。
- **Timestamp 乱序防护**: `apply-session-update` 中 `case 'agent_phase'` 比较 ts，后到但时间更早的事件不覆盖。

#### P6 · 工具渲染注册表

- **`TOOL_RENDERERS` 注册表**: 10 个专属渲染器（Bash / Read / Write / Edit / Grep / Glob / Web / Todo / Task + default），各自提供 Icon、getSummary、renderInput、renderOutput。
- **Edit 渲染器集成 git-diff-view**: 文件编辑显示 before/after unified diff。
- **`default.renderer`**: 剥 MCP 外壳（解开 `[{type:'text',text:...}]` 取纯文本），JSON 参数折叠展开。
- **`ToolCallCard` 接入注册表**: 外部 API 保持不变，调用方（task-chat）零改动。
- **DEV 预览页**: `/__preview/tool-renderers`，可视化检查所有渲染器效果。

#### P7 · Subagent 嵌套 UI

- **`SubagentCard`**: 紫色边框容器（`border-purple-500/40`）+ Bot 图标 + 子工具数量徽章，递归渲染支持多层嵌套。
- **`parent_tool_use_id` 透传**: SDK 顶层 → 5 个服务端 handler → `convertToSessionUpdate` 3 个 case → 前端 `MessagePart.parentToolCallId`。
- **自引用防御**: Task tool result.parent 指向自身时不再陷入无限嵌套。
