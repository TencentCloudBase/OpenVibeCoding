# Open Agent Kernel：原始 SDK 消息流与 Adapter 架构方案

> 文档目的：统一研发与产品对 **方案 A** 的结论——`@cloudbase/open-agent-kernel` 默认暴露 Claude Agent SDK 原始 `SDKMessage` 流，UI 协议转换由 **独立官方 Adapter 包** 完成；kernel 不再维护自研的 `SessionEvent` 中间协议。
>
> 推荐 API 形态：
>
> ```typescript
> import { createAgent } from '@cloudbase/open-agent-kernel'
> import { AguiAdapter } from '@cloudbase/open-agent-kernel-adapter-agui'
>
> const agent = createAgent({
>   envId,
>   model: 'glm-5.1',
>   adapter: new AguiAdapter(),
> })
>
> for await (const event of session.send('你好')) {
>   // AG-UI BaseEvent
> }
>
> // 调试 / 高级：始终可访问原始 SDK 流
> for await (const msg of session.sendSdk('你好')) {
>   // SDKMessage
> }
> ```

---

## 1. 仅暴露 Claude Agent SDK 原始消息时的问题

Claude Agent SDK 的 `SDKMessage` 是 **runtime 内部协议**，设计目标是驱动 agent 子进程与 SessionStore 持久化，而不是直接驱动聊天 UI。若 `@cloudbase/open-agent-kernel` 只把 `SDKMessage` 原样交给业务方、且 **不提供官方 Adapter**，每个接入方都要重复实现 OpenVibeCoding / Copilot 已在 server 或 `@ag-kit/adapter-claude-agent-sdk` 中做过的翻译逻辑。

以下按场景说明：**原始消息长什么样 → 直接消费会出什么问题 → 接入方必须做的额外工作**。

---

### 1.1 文本流式：双通道与 dedupe

#### 背景

是否开启 token 级流式由 SDK 选项 `includePartialMessages` 控制（kernel 侧应默认 `true`）。开启后，**同一段 assistant 文本会走两条路径**：

1. 流式：`stream_event` + `content_block_delta.text_delta`（逐 token）
2. 完整：`assistant` 消息里 `content[].type === 'text'`（turn 结束时整段）

#### 原始消息示例

**路径 1 — 流式增量（会出现多次）：**

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "你" }
  }
}
```

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "好" }
  }
}
```

**路径 2 — turn 结束时的完整 assistant（整段重复）：**

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "你好，我是助手。" }
    ]
  }
}
```

#### 直接使用的问题

- 若只处理 `assistant`：UI **无 token 流式**，整段话 turn 末才出现。
- 若两条路径都 append：UI **重复渲染全文**（先流式拼一遍，turn 末又整段来一遍）。
- 若只处理 `stream_event` 而忽略 block 生命周期：可能缺 `message_end`、loading 状态无法正确关闭。

#### 接入方额外工作

| 工作项 | 说明 |
|--------|------|
| 配置 `includePartialMessages: true` | 在 `buildClaudeQueryOptions` / `query()` options 中开启 |
| 流式模式 flag | 开流式时 **跳过** `assistant` 中的 text，仅处理 tool_use 补全（GLM 等模型） |
| `content_block_start/stop` | 维护文本段起止，对应 UI 的 message start/end |
| dedupe 策略 | 文档化并测试，避免双通道重复 |

**参考实现：** Copilot `@ag-kit/adapter-claude-agent-sdk` 的 `EventTransformer`（`streamingEnabled` 为 true 时不处理 `assistant` 文本）；OpenVibeCoding `cloudbase-agent.service.ts` 的 `handleStreamEvent`。

---

### 1.2 一条 SDK 消息 ≠ 一个 UI 更新（1→N 拆分）

#### 原始消息示例

模型在一轮里「先说一句话，再调工具」时，SDK 往往合成 **一条** `assistant`：

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "我先读取配置文件。" },
      {
        "type": "tool_use",
        "id": "toolu_01ABC",
        "name": "mcp__sandbox__read",
        "input": { "path": "config.json" }
      }
    ]
  }
}
```

#### 直接使用的问题

- 若「一条 SDK 消息 = 更新一次 UI」：只出现一个气泡，**工具卡片丢失**。
- 若只渲染第一个 block：用户看不到 tool call。
- 若把整包 JSON 展示：暴露 runtime 结构，不可用。

#### 接入方额外工作

- 遍历 `message.content[]`，按 `text` / `tool_use` / `thinking` 等分别更新 UI。
- 决定 text 与 tool 的 **展示顺序**（先文本块，再工具块）。

---

### 1.3 工具参数流式（`input_json_delta`）

#### 原始消息示例

工具名在 block 开始时出现，参数 JSON **分段**到达：

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 1,
    "content_block": {
      "type": "tool_use",
      "id": "toolu_01ABC",
      "name": "mcp__sandbox__write",
      "input": {}
    }
  }
}
```

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 1,
    "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" }
  }
}
```

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 1,
    "delta": { "type": "input_json_delta", "partial_json": "\"app.json\",\"content\":\"..." }
  }
}
```

```json
{
  "type": "stream_event",
  "event": { "type": "content_block_stop", "index": 1 }
}
```

#### 直接使用的问题

- 只在最终 `assistant` 里读 `tool_use.input`：参数 **turn 末才一次性出现**，无法做「参数逐字拼装」UX。
- `input_json_delta` 不带 `toolUseId`（需用 `event.index` 关联 block_start）：**必须维护轮内状态** `blockIndex → toolUseId`。

#### 接入方额外工作

| 工作项 | 说明 |
|--------|------|
| `content_block_start` (tool_use) | emit 工具开始（名称、id） |
| 累积 `partial_json` | 多次 delta 拼接 |
| `content_block_stop` | 解析完整 JSON，标记参数就绪 |
| 模型差异 | GLM 等可能不走 delta，完整 input 仅在最终 `assistant` → 需补发逻辑（OpenVibeCoding `handleAssistantToolUseInputs`） |

---

### 1.4 工具结果藏在 `user` 消息里

#### 原始消息示例

工具执行完成后，SDK **不是**发 `type: 'tool_result'`，而是把结果塞进 **`user` 消息**：

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01ABC",
        "content": "{ \"content\": \"file contents here...\" }",
        "is_error": false
      }
    ]
  }
}
```

`content` 也可能是数组：

```json
"content": [{ "type": "text", "text": "..." }]
```

#### 直接使用的问题

- 误把 `type: 'user'` 当真实用户输入 → UI 多一条用户气泡。
- 未按 `tool_use_id` 关联前面的 `tool_use` → 工具结果 orphan。
- 未统一 string / array 两种 `content` 形态 → 解析失败。

#### 接入方额外工作

- 只处理 `user.message.content[]` 中 `type === 'tool_result'` 的 block。
- 用 `tool_use_id` 回填对应工具卡片状态（done / failed）。
- 实现 `extractReasonText()` 类 helper 统一 content 形态。

---

### 1.5 HITL / 客户端工具 / 提问：语义藏在「假 tool_result」里

OAK kernel 的 PreToolUse hook 会用 **sentinel 假 deny** 终止 turn（分布式友好、不阻塞进程）。在 raw 流里 **没有** `tool_confirm` / `ask_user` 这类 SDK 原生 type。

#### 原始消息示例（审批中断）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01ABC",
        "is_error": true,
        "content": "{\"__OAK_INTERRUPT__\":true,\"conversationId\":\"conv-1\",\"toolUseId\":\"toolu_01ABC\",\"toolName\":\"mcp__sandbox__bash\",\"toolInput\":{\"command\":\"rm -rf /\"},\"schema\":\"oak/v1/interrupt\"}"
      }
    ]
  }
}
```

随后通常还有：

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false
}
```

#### 直接使用的问题

- UI 显示为 **工具执行失败**（`is_error: true`），而非「等待用户批准」。
- 看到 `result.success` 误以为对话正常结束，关闭 loading / 允许下一轮输入。
- 未解析 sentinel JSON → 无法调 `respondApproval()` 续跑。

#### 接入方额外工作

- 维护 OAK sentinel 契约文档（`__OAK_INTERRUPT__`、client-tool、askUser 等）。
- 识别 sentinel 后 **不要** 当普通 `tool_result` 展示；映射为 UI 的 confirm / interrupt 态。
- 结合轮内状态：本轮若触发过 interrupt，`result.success` → `requires_action` 而非 `completed`。

**说明：** 即使用户只消费 raw SDK，**hook 行为仍由 kernel 注入**；Adapter 必须理解 kernel 的 sentinel 约定。这也是官方提供 `@cloudbase/open-agent-kernel-adapter-*` 的原因。

---

### 1.6 内部 / 噪音消息需过滤

#### 原始消息示例

```json
{ "type": "system", "subtype": "init", "session_id": "sess_xyz" }
```

```json
{ "type": "stream_event", "event": { "type": "message_start", "...": "..." } }
```

还有 SDK 可能发出的：`hook_started`、`status`、`tool_progress`、`auth_status` 等（随 SDK 版本增减）。

#### 直接使用的问题

- 误展示给终端用户 → 噪音、泄露实现细节。
- 未处理的新 type → 抛错或 UI 异常。
- `system.init` 的 `session_id` 实际需要 capture 用于 SessionStore 映射，但不应进聊天气泡。

#### 接入方额外工作

- 维护 allowlist / denylist（哪些 type 进 UI、哪些只写日志）。
- 未知 type **静默忽略** 或降级，不阻断主流程（SDK 升级兼容策略）。

---

### 1.7 `result` 消息的结束语义依赖上下文

#### 原始消息示例

正常结束：

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "num_turns": 1,
  "duration_ms": 3200
}
```

出错：

```json
{
  "type": "result",
  "subtype": "error_during_execution",
  "is_error": true,
  "errors": ["..."]
}
```

#### 直接使用的问题

- 有 HITL interrupt 时仍可能是 `subtype: success` → UI 若只看 result 会 **错误结束会话**。
- `permission_denials`（若存在）需映射为权限错误 UI。

#### 接入方额外工作

- 轮内 flag（如 `interruptTriggered`）与 `result` 联合判断最终 idle 原因。
- 映射为 UI 的 completed / requires_action / error / aborted。

---

### 1.8 Subagent 嵌套（`parent_tool_use_id`）

#### 原始消息示例

```json
{
  "type": "stream_event",
  "parent_tool_use_id": "toolu_PARENT",
  "event": {
    "type": "content_block_start",
    "content_block": {
      "type": "tool_use",
      "id": "toolu_CHILD",
      "name": "mcp__sandbox__grep",
      "input": {}
    }
  }
}
```

#### 直接使用的问题

- 扁平列表展示工具 → 无法区分主 agent / 子 agent 工具。
- 未透传 `parent_tool_use_id` → 前端 Subagent 嵌套卡片无法实现。

#### 接入方额外工作

- 从 SDK 消息 **顶层** 提取 `parent_tool_use_id`，挂到每个 UI 工具事件上。

---

### 1.9 持久化 vs 实时流是两条管道

| 管道 | 内容 | 用途 |
|------|------|------|
| `session.send()` / `sendSdk()` 流 | 实时 `SDKMessage` | SSE / 流式 UI |
| SessionStore / jsonl | 完整 transcript | `resumeSession`、跨节点恢复 |
| `getHistory()` → `MessageRecord` | 聚合后的历史 | 聊天记录页 |

#### 直接使用的问题

- 把流式消息当唯一真相 → 断线后无法恢复 UI（除非另做 replay）。
- 每条 raw chunk 写 DB → 性能与存储爆炸（OpenVibeCoding 用里程碑 flush，而非 per-chunk）。

#### 接入方额外 work

- 区分「实时流消费」与「历史查询」API。
- 若自建持久化：在 tool_result 等里程碑落库，而非每个 `text_delta` 一条记录。

---

### 1.10 小结：裸消费 SDK 的「最低实现清单」

若业务方 **不用官方 Adapter**、直接消费 `@cloudbase/open-agent-kernel` 的 raw 流，至少需要：

1. 配置并理解 `includePartialMessages` 与双通道 dedupe  
2. 实现 `stream_event` 全路径（start / delta / stop）  
3. 拆分 `assistant.content[]`（1→N）  
4. 工具参数流式（`input_json_delta` + index 状态机）  
5. 解析 `user` 中的 `tool_result`（非真实用户消息）  
6. 识别 OAK sentinel（HITL / client-tool / askUser）  
7. 过滤 system / hook / progress 等噪音  
8. `result` + 轮内状态 → 正确的会话结束语义  
9. 可选：`parent_tool_use_id` 嵌套  
10. 模型/provider 差异分支（如 GLM tool input 补全）  

OpenVibeCoding 在 `cloudbase-agent.service.ts` 与 Copilot 在 `@ag-kit/adapter-claude-agent-sdk` 中各用 **约 200–350 行** 专门处理上述逻辑。方案 A 的目标是将该逻辑 **集中维护在官方 Adapter 包**，而不是推给每个客户。

---

## 2. 方案对比：Kernel 内置 UI 协议 vs Kernel + Adapter

讨论收敛为 **二选一**（不采用 kernel 自研 `SessionEvent` 中间层）：

| 方案 | 描述 |
|------|------|
| **方案 B** | `@cloudbase/open-agent-kernel` 内置转换，直接输出某一种 UI 协议（AG-UI 或 ACP） |
| **方案 A（推荐）** | `@cloudbase/open-agent-kernel` 暴露 `SDKMessage`；`@cloudbase/open-agent-kernel-adapter-agui` / `-adapter-acp` 负责 UI 协议 |

---

### 2.1 方案 A：`open-agent-kernel` + 独立 Adapter 包

#### 架构

```
┌──────────────────────────────────────────────┐
│ @cloudbase/open-agent-kernel               │
│  createAgent({ adapter?: AgentStreamAdapter })│
│  session.send()     → SDKMessage 或 TOut     │
│  session.sendSdk()  → 始终 SDKMessage        │
│  SessionStore / sandbox / HITL hooks         │
│  不依赖 @ag-ui/client / ACP 类型            │
└────────────────────┬─────────────────────────┘
                     │ AsyncIterable<SDKMessage>
         ┌───────────┴───────────┐
         ▼                       ▼
 adapter-agui              adapter-acp
 SDKMessage → BaseEvent    SDKMessage → SessionUpdate
```

#### 核心接口（kernel 内，无 UI 依赖）

```typescript
interface AgentStreamAdapter<TOut = unknown> {
  adapt(
    messages: AsyncIterable<SDKMessage>,
    context: { conversationId: string; sessionId: string; turnId?: string },
  ): AsyncIterable<TOut>
}

// 用法
createAgent({ adapter: new AguiAdapter() })
```

#### 优点

| 点 | 说明 |
|----|------|
| **边界清晰** | kernel = Claude SDK runtime + CloudBase 能力；presentation 在 adapter |
| **无自研 wire 协议** | 对外叙事为「标准 SDK 事件 + 标准 AG-UI/ACP」，无 SessionEvent |
| **多 UI 协议** | 增协议只加 adapter 包，kernel 不膨胀 |
| **与 Copilot 对齐** | 同构 `@ag-kit/adapter-claude-agent-sdk` + `@ag-ui/client` 拆分 |
| **与 OpenVibeCoding 对齐** | `adapter-acp` 可复用 `convertToSessionUpdate` 映射表 |
| **可测试性** | kernel 单测 raw 流；adapter 单测映射；职责分离 |
| **可选 raw** | `sendSdk()` 调试；生产 `createAgent({ adapter })` |

#### 缺点

| 点 | 说明 |
|----|------|
| **安装两个包** | 生产路径 `kernel + adapter-*`，文档需写清 |
| **版本矩阵** | adapter 需与 kernel sentinel 行为、SDK 版本同步发版 |
| **裸消费风险** | 不用 adapter 的客户仍须自行实现第 1 节清单（需文档与 checklist 约束） |
| **首期工作量** | 需新建 adapter 包并迁移原 `event-translator` 逻辑 |

#### kernel 内部拆分要点

| 保留在 kernel | 迁到 adapter 包 |
|---------------|----------------|
| `runSdkQuery()` → `AsyncIterable<SDKMessage>` | `event-translator` 全部逻辑 |
| `buildClaudeQueryOptions`（含 `includePartialMessages`） | SDK → AG-UI / ACP 状态机 |
| HITL / sentinel hooks | sentinel → UI interrupt / tool_confirm |
| SessionStore、`getHistory` | `message_start/delta/end`、`tool_call_*` 生命周期 |
| `session.sendSdk()` | — |
| `AgentStreamAdapter` 接口定义 | `AguiAdapter` / `AcpAdapter` 实现 |

---

### 2.2 方案 B：Kernel 内置 UI 协议

#### 架构

```
┌──────────────────────────────────────────────┐
│ @cloudbase/open-agent-kernel               │
│  session.send() → AG-UI BaseEvent          │
│    或 → ACP SessionUpdate（二选一）         │
│  依赖 @ag-ui/client 或 @coder/shared ACP   │
└──────────────────────────────────────────────┘
```

#### 优点

| 点 | 说明 |
|----|------|
| **开箱即用** | `npm i @cloudbase/open-agent-kernel` 即可对接一种官方前端 |
| **单一版本线** | 无 kernel ↔ adapter 兼容矩阵 |
| **Demo 最短** | 产品 POC 链路短 |

#### 缺点

| 点 | 说明 |
|----|------|
| **绑死一种协议** | 选 AG-UI 则 OpenVibeCoding ACP 前端需 fork 或 kernel 再开 `sendAcp` |
| **kernel 依赖 UI 库** | 违背「runtime SDK」定位；安全/体积/semver 受 wire 协议牵制 |
| **多协议 = 内核膨胀** | 两种协议要么两个 export，要么 if/else，实质仍是 adapter 但塞在 core 里 |
| **转换逻辑仍在 kernel** | 第 1 节全部问题仍要解决，只是输出类型从 SessionEvent 换成 BaseEvent/SessionUpdate |
| **第三方扩展差** | 自建 SSE 协议的客户被迫依赖不需要的 AG-UI/ACP 类型 |

---

### 2.3 对照总表

| 维度 | 方案 A：kernel + adapter | 方案 B：kernel 内置 UI 协议 |
|------|--------------------------|----------------------------|
| 是否自研中间协议 | 否（SDK + 标准 AG-UI/ACP） | 否（若直接输出 AG-UI/ACP） |
| kernel 是否依赖 UI 库 | **否** | **是** |
| 支持多种前端协议 | **是**（多 adapter） | 难（需选边或内核膨胀） |
| 默认接入成本 | 中（2 个包） | 低（1 个包） |
| 转换逻辑维护位置 | adapter 包 | kernel 内 |
| 与 Copilot 架构一致性 | **高** | 中 |
| 与 OpenVibeCoding 架构一致性 | **高**（adapter-acp） | 高（若内置 ACP） |
| raw SDK 调试 | `sendSdk()` 一等公民 | 需额外 API 或日志 |
| 适合定位 | **通用 CloudBase Agent runtime SDK** | 单一官方前端捆绑 |

---

## 3. 决策结论（推荐）

1. **采用方案 A**：`@cloudbase/open-agent-kernel` 以 Claude Agent SDK **`SDKMessage` 为 canonical 流**；废弃 kernel 内 `SessionEvent` / `event-translator` 作为主路径输出。  
2. **推荐 API**：`createAgent({ adapter: new AguiAdapter() })`；`session.send()` 经 adapter 输出 UI 事件；`session.sendSdk()` 始终 raw。  
3. **官方维护** `@cloudbase/open-agent-kernel-adapter-agui`（首期）、`-adapter-acp`（二期），文档明确：**生产环境勿裸消费 SDKMessage，除非已实现第 1.10 节清单**。  
4. **kernel 仍负责**：`includePartialMessages`、SessionStore、HITL sentinel、sandbox——这些是 runtime 行为，不是 UI 翻译。

---

## 4. 参考实现（组织内）

| 项目 | 模式 | 说明 |
|------|------|------|
| OpenVibeCoding | `SDKMessage` → `AgentCallbackMessage` → ACP | 中间层 + wire 分离；OpenCode 甚至 ACP→中间层→ACP |
| Copilot (tcb-headless-service) | `SDKMessage` → `EventTransformer` → AG-UI | `@ag-kit/adapter-claude-agent-sdk` |
| OAK（目标） | `SDKMessage` → `AguiAdapter` → AG-UI | adapter 独立包，kernel 不 import AG-UI |

---

## 5. 后续 RFC 项（implementation checklist）

- [ ] 定义 `AgentStreamAdapter` 接口（`src/public/adapter.ts`）  
- [ ] 抽出 `runSdkQuery()`，`sendSdk()` 始终返回 `AsyncIterable<SDKMessage>`  
- [ ] `send()` / `respondApproval()` / `respondToolUse()` / `respondAskUser()` 统一 `pipeStream(raw, adapter)`  
- [ ] 新建 `@cloudbase/open-agent-kernel-adapter-agui`，迁移并扩展 translator  
- [ ] Breaking：移除或 deprecate `SessionEvent` 公开 API  
- [ ] README：推荐安装 `kernel + adapter-agui`；附「裸消费 checklist」链接（即本文第 1 节）  

---

*文档版本：2026-06-15 · 与研发/产品对方案 A 讨论结论一致*
