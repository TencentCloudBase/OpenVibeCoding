# 定时任务演进规划：CloudBase 云函数定时触发模式

## 背景

当前定时任务（CronTask）使用 `node-cron` 在服务进程内调度，配合数据库乐观锁防止多 Pod 重复执行。这种方案简单可靠，但有以下局限：

- 依赖服务进程常驻，重启期间可能错过触发
- 多 Pod 部署时所有 Pod 都加载全部任务，浪费内存
- 锁竞争在高并发场景下有性能开销

## 目标

新增 `cloudfunction` 执行模式，利用 CloudBase 云函数的原生定时触发器能力，实现平台级的定时调度。

## 架构设计

### 模式切换

```
cron_tasks.mode: 'local' | 'cloudfunction'
```

- `DB_PROVIDER=cloudbase` 时，默认使用 `cloudfunction` 模式
- `DB_PROVIDER=drizzle` 时，只支持 `local` 模式
- 用户可在前端创建时选择模式

### 云函数触发流程

```
CloudBase 定时触发器
    ↓
云函数（模板代码）执行
    ↓
读取环境变量（prompt、userId、selectedModel、serverApiUrl 等）
    ↓
HTTP 调用服务端 API: POST /api/crontask/trigger
    ↓
服务端创建 task 记录（status: pending）
    ↓
正常任务处理流程
```

### 云函数模板

每个定时任务创建一个云函数，命名规则：`crontask-{cronTaskId}`

```javascript
// 云函数模板代码
exports.main = async (event, context) => {
  const {
    CRONTASK_ID,
    CRONTASK_PROMPT,
    CRONTASK_USER_ID,
    CRONTASK_MODEL,
    CRONTASK_AGENT,
    SERVER_API_URL,
    SERVER_API_SECRET,
  } = process.env

  const response = await fetch(`${SERVER_API_URL}/api/crontask/trigger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cron-Secret': SERVER_API_SECRET,
    },
    body: JSON.stringify({
      cronTaskId: CRONTASK_ID,
      prompt: CRONTASK_PROMPT,
      userId: CRONTASK_USER_ID,
      selectedModel: CRONTASK_MODEL,
      selectedAgent: CRONTASK_AGENT,
    }),
  })

  return { status: response.status }
}
```

### CRUD 联动

| 操作 | local 模式 | cloudfunction 模式 |
|------|-----------|-------------------|
| 创建 | `node-cron` 注册 | 创建云函数 + 配置定时触发器 |
| 更新 | 重新注册 cron | 更新云函数环境变量 + 更新触发器 |
| 删除 | 取消注册 | 删除云函数 |
| 启用/禁用 | start/stop job | 启用/禁用触发器 |

### 涉及的 CloudBase API

| 操作 | API |
|------|-----|
| 创建云函数 | `createFunction` / `updateFunctionCode` |
| 配置触发器 | `manageFunctionTriggers` |
| 更新环境变量 | `updateFunctionConfig` |
| 删除云函数 | 通过 SDK 删除 |

这些 API 在 `stateful-mcp-client` / CloudBase MCP 中间件中封装，可复用。

### 服务端新增接口

```
POST /api/crontask/trigger
```

- 接收云函数发来的触发请求
- 使用 `X-Cron-Secret` header 鉴权（避免外部伪造）
- 创建 task 记录，走正常处理流程

## 数据模型变更

```typescript
// cron_tasks 表新增字段
mode: text('mode').default('local'),           // 'local' | 'cloudfunction'
cloudFunctionName: text('cloud_function_name'), // 云函数名称（cloudfunction 模式）
```

## 前端变更

- 创建定时任务弹窗新增"执行模式"选项
- cloudfunction 模式下展示云函数状态
- 管理页显示模式标签（Badge）

## 实施步骤

1. **数据模型**：`cron_tasks` 表加 `mode`、`cloudFunctionName` 字段
2. **云函数模板**：编写标准模板代码，存为常量
3. **云函数生命周期服务**：封装创建/更新/删除云函数 + 触发器的逻辑
4. **API 路由**：新增 `/api/crontask/trigger` 接口
5. **CRUD 联动**：创建/更新/删除时根据 mode 走不同分支
6. **前端**：模式选择 UI
7. **测试**：端到端验证

## 风险与注意事项

- 云函数有冷启动延迟（约 100-500ms），对定时精度有影响
- 每个用户的云函数数量有上限，需考虑配额
- 云函数模板代码更新时，已创建的函数不会自动更新
- 需要一个 `SERVER_API_SECRET` 用于云函数回调鉴权
- CloudBase 免费额度内的云函数调用次数需评估
