# WP0 工作包计划：基线与契约

版本：v1.0；日期：2026-11-02；状态：执行中。总指挥：GLM-5.3（zcode 会话）。

## 1. 本包目标与对应项

- 对应 tasks：1.1（基线盘点与逐项影响清单）、1.2（契约/参数/切换顺序固化）。
- 对应需求：三份 spec 全部（ACE-01~07、OAB-01~07、AFR-01~07）的**实施前提**，本包不实现任何业务行为。
- 对应验收 case：无直接 case；WP0 产物是 WP1～WP6 与 50 条用例的输入。
- 开发计划 §4 WP0 退出条件：来源与差异可查；新增字段含义和切换边界明确。

## 2. 输入基线（已核实，2026-11-02 本会话）

| 项 | 值 | 证据 |
|---|---|---|
| 远端 main | `ae506fed47d21865420afa91137e8b244072933e`（PR #7 合并提交） | `git fetch` 后 `git rev-parse origin/main` |
| 本地 HEAD | `9a5fd5691338a9b86044ffc0bfbf7298e350eded`（PR #7 head，origin/main 的祖先） | `git merge-base --is-ancestor` = YES |
| 本地分支 | `codex/employee-quota-monthly-reporting` | `git branch --show-current` |
| 工作树 vs origin/main | 仅 5 M＋1 D＋未跟踪文件（详见 baseline.md §工作区差异） | `git diff origin/main --name-status` |
| 迁移水位（源码） | 0000~0092 共 93 个；0092=员工月度额度（PR #7 已合并） | `git ls-tree origin/main packages/database/migrations/` |
| 生产 | **未核实**（本会话无服务器只读权限；用户声明 PR #7 未部署、0092 未在生产执行） | baseline-update-20261102.md §2 |

## 3. 本包交付物与允许修改范围

| 交付物 | 路径 | 说明 |
|---|---|---|
| 本计划 | `handoff/work-packages/WP0/plan.md` | 本文件 |
| 调查笔记 | `handoff/work-packages/WP0/notes/inv-{a,b,c,d}.md` | 逐项 file:line 证据 |
| 基线报告 | `handoff/work-packages/WP0/baseline.md` | task 1.1 产物：基线、差异、旧入口清单、触发器、PENDING 准入、价格来源、迁移策略 |
| 契约与参数 | `handoff/work-packages/WP0/contracts.md` | task 1.2 产物：接口字段/状态草案（填实际路由）、参数待决清单、切换顺序、WP1 委派合同基准 |
| 结包报告 | `handoff/work-packages/WP0/report.md` | 固定交接格式 |

允许新增/修改的文件：仅上述 `handoff/work-packages/WP0/` 目录内文档，以及 `.zcode/agents/glm-flash.md`（执行基建，已被 .gitignore 忽略）。**禁止**：任何 `apps/`、`packages/`、`deploy/`、迁移、测试、配置的业务改动；任何 git 引用操作（commit/reset/rebase/checkout 切换）。

## 4. 分工（本会话现实约束下的执行方式）

- 子 Agent 模型核实：`account:bigmodel-individual-coding-plan/GLM-5.3-Flash` 存在且可用（ListModels）。但本会话 Agent 类型列表启动时已固定，无法中途加载按模型绑定的自定义 agent；Agent 工具无按次指定模型参数。
- **处置**：WP0 为只读调查＋文档，总指挥指令 §一 明确允许总指挥直接读代码、核对差异、运行验证。本包四项调查由总指挥直接执行并留证；不使用模型不可核实的 general-purpose 顶替（"不能擅自换型号"）。
- `.zcode/agents/glm-flash.md` 已创建：WP1 起的新任务会话将加载 `glm-flash` agent 类型（模型绑定 GLM-5.3-Flash），届时全部业务实现交给该子 Agent。

调查分工（均只读，证据落 notes/）：

| 调查 | 范围 | 支撑 |
|---|---|---|
| Inv-A 资金写退出 | API 资金写入口全清单（方法/路径/行为）、0081/0082/0083 触发器与合同、`listServableResources` PENDING 准入、候选/初始化混合路径、strict_writes 落点 | task 1.1、WP2 |
| Inv-B 费用读取 | Gateway 计价入口与 api_cost 落库、月度费用余额桥接现状、finance 投影/用量总览 remainingQuota 覆盖、价格规则表与来源字段 | task 1.1、WP1 |
| Inv-C 官方余额 | DeepSeek 适配器现状、Worker 日同步/充值触发/资金模式跳过、(企业,资源,同步日) 唯一约束、耗尽恢复 `recordBalanceSyncRecovery`、供给预测余额读取 | task 1.1、WP3 |
| Inv-D 环境与迁移 | 迁移全清单与触发器迁移、各包测试脚本真实/占位、CI 工作流现状、隔离测试环境要求 | task 1.1/1.2 |

## 5. 验证方法与完成条件

- 每条清单项有 file:line（或迁移文件名＋行）证据；调查笔记可复核。
- 关键事实（分支包含关系、0092 归属、写入口清单完整性）以实际命令输出为证，不引用记忆或旧报告。
- 完成条件：baseline.md 与 contracts.md 覆盖开发计划 §4 WP0 必交产物（baseline、接口字段/状态、参数确认清单、旧入口清单、迁移策略）；参数区分"已核实事实/建议值待确认"；WP1 启动指令可直接复制执行。

## 6. 边界与已知的暂缓项

- 生产服务版本/迁移水位/运行开关：本环境无只读权限，记录为未核实并列出所需核实方式；不自动执行任何生产动作。
- 同步参数（15min/30min/30s）在 contracts.md 中列为待确认建议值，供用户/业务验收人拍板。
- 仓库无 AGENTS.md（根目录及 apps/packages 下均无；仅无关参考目录内有），按本指令与 openspec 文档执行。
