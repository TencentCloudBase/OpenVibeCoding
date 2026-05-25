# Upstream baseline（硬分叉）

记录本仓库相对 **TencentCloudBase/OpenVibeCoding** 的分叉与同步历史。本线以 **硬分叉** 为前提：沙箱 infra 等改动与上游 **不保证长期可 merge**，合并后仍需人工回归。

## 血缘

| 层级 | 仓库 |
| --- | --- |
| 最初模板 | [vercel-labs/coding-agent-template](https://github.com/vercel-labs/coding-agent-template) |
| **直接上游（功能同步来源）** | [TencentCloudBase/OpenVibeCoding](https://github.com/TencentCloudBase/OpenVibeCoding) |
| **本线** | 当前仓库 `feature/stateful-infra` 及后续分支（沙箱 infra / Stateful + TRW） |

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

- 沙箱 infra：Stateful Tool / 实例生命周期、gateway 数据面、TRW vibecoding 镜像
- `SANDBOX_INSTANCE_MODE`（shared / isolated）与进度文案
- 公开 TCR 默认镜像、`stateful-vibecoding-image` 解析链
- 与 SCF 时代假设脱钩的文档与默认配置

## 上游同步记录

| 日期 | 方式 | 上游 `main` 顶 | 本线 merge commit | 备注 |
| --- | --- | --- | --- | --- |
| 2026-05-21 | `git merge origin/main` | `a878ddbbee2f6320395dc7f84a7e6a068c524e75` | `20dedbdbb00997d8f23c289317836de14df44d60` | 无冲突；含下方 5 个上游 commit |
| 2026-05-25 | `git merge origin/main` | `4592517`（fix readme 等） | （merge commit） | 约 10 文件冲突；保留 AGS/TRW 路径 |

**本次并入的上游 commit**（`43c3e60..a878ddb`）：

| SHA | 说明 |
| --- | --- |
| `a5543ba` | feat: 优化 opencode 安装描述 |
| `a774c74` | feat: codebuddy 支持 tokenhub |
| `03745a9` | feat: 初始化添加配置自定义模型功能 |
| `4669043` | Merge pull request #23（CodeBuddy TokenHub） |
| `a878ddb` | feat: 更新 agent 选项 |

**当前对齐状态**（2026-05-25）：

- `git merge-base HEAD origin/main` → `4592517`（已与上游 `main` 最新对齐）
- 本线仍在 merge-base 之上保留 stateful 提交（AGS/TRW、文档、`0699323` 等）
- 中文与 stateful 说明：[README-zh.md](../README-zh.md)、[trw-api-alignment.md](./trw-api-alignment.md)

下次看上游新提交：

```bash
git fetch origin
git log 4592517..origin/main --oneline
```

## 偶尔从上游同步（推荐流程）

```bash
git fetch origin

# 自上次对齐的顶往下看
git log a878ddbbee2f6320395dc7f84a7e6a068c524e75..origin/main --oneline

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
