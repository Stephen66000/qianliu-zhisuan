# WP0 基线报告（task 1.1 产物）

版本：v1.0；日期：2026-11-02；执行：GLM-5.3 总指挥（zcode 会话）。本文只记录 2026-11-02 实际核实的事实；未核实项明确标注。

## 1. 源码基线（已核实）

| 项 | 值 | 核实命令/证据 |
|---|---|---|
| 远端 main | `ae506fed47d21865420afa91137e8b244072933e`（PR #7 合并提交，含员工月度额度与 Worker 修正） | `git fetch origin` 后 `git rev-parse origin/main` |
| 本地 HEAD | `9a5fd5691338a9b86044ffc0bfbf7298e350eded`（PR #7 head） | `git rev-parse HEAD`；`git merge-base --is-ancestor HEAD origin/main` = YES |
| 本地分支 | `codex/employee-quota-monthly-reporting` | `git branch --show-current` |
| 本地 main 指针 | 与远端不同步（本地停在旧位），不作为基线 | baseline-update-20261102.md §3 |
| 开发基线要求 | 后续开发分支必须包含 `ae506fed…933e` | 指令§主线前提 |

**实施起点建议（供 WP1 执行，本包不执行任何 git 引用操作）**：
1. `git worktree add <新目录> -b <新分支> ae506fed47d21865420afa91137e8b244072933e`（非破坏性：不动现有工作区/分支/未提交内容）。
2. 将未跟踪的 `openspec/changes/simplify-api-cost-and-official-balance/` 目录与 `openspec/README.md` 的本 change 条目复制进新工作区并作为首个提交（该文档包目前不在任何提交中）。
3. 旧研究基线 `2a2fdbe` 与 `7a3204f` 仅为历史时点，不作起点。

## 2. 工作区差异（相对 origin/main，2026-11-02）

`git diff origin/main --name-status`＋`git status` 全量核对：

- **已修改（5）**：`V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/` 下 3 个证据文件（PNG/JSON）、`openspec/README.md`（本 change 条目）、`packages/domain/reports/mutation/mutation.html`（变异报告工件）。
- **已删除（1）**：`仟流智算 产品事实清单/仟流智算客户购买理由研究报告20260918.md`（本地删除，未提交）。
- **未跟踪（335）**：`V4/` 证据/评审工件为主；源码目录内仅本地测试基建——`apps/web/e2e/` 10 个本地 e2e 脚本/spec、`packages/database/` 11 个 stryker/vitest 变异测试配置与夹具；另有本 change 文档目录、`.zcodeignore`、`.workbuddy/`。
- **结论**：**无未合并的业务代码改动**（员工额度业务改动已全部经 PR #7 进入 main）。上述残留为证据工件/本地基建/文档，全部保留不动，不属于本 change 范围；WP1 在独立 worktree 工作可完全避开。

## 3. 生产与数据库水位（未核实 → BLOCKED 记录）

- 本会话无生产服务器/数据库只读权限。用户声明：PR #7 **未部署**、0092 **未在生产执行**。
- 所需核实（WP6 前完成）：各服务镜像 tag/容器版本、`knex_migrations` 水位、`PROVIDER_FINANCE_MODE` 与各企业 `strict_writes_enabled` 实际取值。无法核实则持续记录为未核实。
- 源码迁移水位：0000-0092 共 93 个；**0092 已占用**（员工月度额度）；本 change 新迁移自 **0093** 起。

## 4. 旧入口清单（逐项影响清单，详见 notes/inv-a.md）

- **HTTP 写入口 19 个**：provider-finance/routes.ts 11 个 POST（W1-W11，其中套餐 2 个保留、冲销/重复候选按资源模式拆分、其余 API 资金操作退役 410）；activation 4 个（preview/activate 改造、quiescence×2 保留）；operating-bill-snapshot-imports（历史手填）；provider-resources 创建（AFR-02 移除 API 期初快照要求）。读入口 10 个保留为历史只读。
- **数据库触发器**：0081 seed 触发器（AFTER INSERT ON provider_resource 种 PENDING）、0083 事件合同触发器、0061 strict writes 守卫。
- **PENDING 准入**：`resource-pool-repository.ts:450`（listServableResources）；同函数 `quota_block_state`（:443）与 `evaluateAdmission`（:451）必须保留。
- **价格来源盘点**：billing_rule 表（0011/0018/0021/0064）**无官方来源/核实状态字段**——ACE-02"价格依据待核实"为 WP1 新增字段需求。

## 5. 官方余额与费用链路现状（详见 notes/inv-b.md、inv-c.md）

- DeepSeek 适配器具备币种/组成/可用标记；仅 deepseek+API 返回数据（其他→null＝暂不支持）。
- 同步 runner 三处耦合待解除：充值记录触发（:58-74）、资金模式 skip（:118-125）、日一次行为约束（读取侧 distinctOn＋充值触发，非表硬约束）。
- 手动刷新 HTTP 入口**不存在**（OAB-03 新增）。
- 月度费用仍为期初＋充值桥接（monthly-operating-cost.ts）；用量总览 remainingQuota 被内部余额覆盖（finance-usage-overview.ts:21-26）。

## 6. 迁移与回退策略（WP1-WP6 输入）

1. 新增兼容迁移（0093 起）：不重写 0081/0082/0083/0061/0026，不改已关账快照；仅（a）解除 API 资金写前提与 seed 触发器的 API 部分、（b）官方余额尝试记录约束/标识、（c）价格依据状态字段。
2. 新库（全量迁移）与旧库升级（增量至 0093+）两条路径都要过同一组用例（AT-X05）。
3. 回退约束：切换后可能存在无资金账户的新消费——回退包必须兼容这些消费的读取/结算，不得恢复"资金 readiness 调用门槛"（指令§七、design Migration Plan §6）。
4. 员工月度额度（0092）与 Worker 修正不回退、不清零、不改计量。

## 7. 测试环境与命令

- 真实入口：各包 `test`/`test:integration`（database 需容器 PostgreSQL；web `test:e2e` 需专用 `_e2e` 库）；占位无效：control-api/worker `test:e2e`、web `test:integration`（echo 退出，见 notes/inv-d.md §2）。
- 根 vitest `passWithNoTests: true`——验收必须核对非零用例数。
- CI：main 的 ci.yml 跑 quality（含 coverage 棘轮）→ quality:mutation → test:e2e；GitHub 状态查询曾为空，不得写"CI 已通过"。
- 模拟上游/注入官方响应；禁止真实付费调用、生产写入、消息发送。

## 8. AGENTS.md

仓库根及 apps/packages 下无 AGENTS.md；执行以本指令＋openspec 文档为准。
