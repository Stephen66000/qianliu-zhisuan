# 正式 test gate 归属与处置 — 三向基线归属（修复后残留失败）

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-22 |
| 响应 | 复审拒绝意见 [P1-1]：「pnpm test 仍失败 22 项，其中至少 15 项迁移断言由 0078/0079 触发，不能只按既有失败豁免」 |
| 修复提交 | `c88e366`（分支 `codex/provider-finance-initialization-20260921`，未推送） |
| 基线参照 | `ca533e3d`（资金增量前，迁移头 `0077`）；`7c2e5ca`（本轮整改前）；`b23f2b0`（复审对象 HEAD） |

## 一、22 项失败的三向归属结论

对复审对象 HEAD（`b23f2b0`）失败的 22 个测试用例，在资金增量前基线 `ca533e3d` 的
detached worktree 上逐文件复跑（`/tmp/wt-base`），三向比对结果：

| 类别 | 数量 | 判定 | 依据 |
|---|---|---|---|
| A 迁移头断言链 | 10 文件 12 项 | **由 0078/0079 触发，但可修复** | 断言写死迁移头；已在 `c88e366` 用项目自有 `rollbackTo()` 惯例锚定到目标迁移，全部转绿 |
| B 迁移台账深比较 | 3 文件 4 项 | **同上** | 全量清单含 0078/0079；改为 `slice(0,N)` 前缀断言 + 全量 Success 校验，全部转绿 |
| A′ 双探测锚定 | 2 文件 2 项 | **由 0078/0079 触发** | 回滚哨兵锚定 `0077`；分别改锚 `0074`/`0077`，全部转绿 |
| C 数据/性能口径 | 3 文件 6 项 | **既有失败，非资金增量引入** | 在 `ca533e3d` 以相同原因失败；所测生产代码在 `ca533e3d..HEAD` 零改动（git log 证明，见下） |
| G gateway 结算口径 | 1 文件 2 项 | **既有失败，非资金增量引入** | 同上 |

**15 项迁移断言（A+A′+B）已全部修复转绿**；这与复审意见"至少 15 项由 0078/0079 触发、
不能豁免"的定性一致——本包不主张豁免，而是直接修复。

## 二、修复后残留失败逐项归属（共 8 项）

以下 8 项在 `c88e366` 上仍失败。每项均在 `ca533e3d` 基线复现（同文件同断言同原因），
且其所依赖的生产代码文件在 `ca533e3d..c88e366` 区间**零改动**（`git log --oneline
ca533e3d..c88e366 -- <file>` 为空），因此**非本资金增量引入、亦非本轮整改引入**。

### C-1～C-4　`standard-home.integration.test.ts`（4 项）

| 用例 | 失败断言 | 根因定位 |
|---|---|---|
| 四指标、同期窗口与资源区聚合按口径返回 | `tokenUsage` 期望 `200` 实测 `280`（行 :263） | `dashboard-resource-usage.ts` 的 `queryUsageRows` OR 子句把 FAILED 请求的非零 token 计入总览；该行为由提交 `44782da`（资金增量前）引入 |
| R01-F01 资金读模型同期窗口复用权威缺口规则 | `assert.deepEqual` null vs string（行 :412） | 同上链路的 `incompleteReason` 口径 |
| V14-C2 F-B financeRead=true 同期费用走资金读模型口径 | 同上（行 :427） | 同上 |
| V14-C4 G02b countFinanceGaps 六缺口码正反控制 | `''` 不含 `API_USAGE_COST_UNKNOWN:1`（行 :898） | 同上 |

生产代码归属证明：`git log ca533e3d..c88e366 -- packages/database/src/repositories/dashboard-home.ts
packages/database/src/repositories/dashboard-home-costs.ts packages/database/src/repositories/dashboard-resource-usage.ts`
→ **空输出**（资金增量与整改均未触碰）。

### C-5　`pool042-dashboard-resource-usage.integration.test.ts`（1 项）

| 用例 | 失败断言 |
|---|---|
| POOL20-045 用量总览只统计成功消耗 | `monthlyTotalTokens` 期望 `120`，实测含失败行 token |

根因与 C-1～C-4 相同（`queryUsageRows` OR 子句），`ca533e3d` 已失败。

### C-6　`w20-standard-capacity.integration.test.ts`（1 项）

| 用例 | 失败断言 |
|---|---|
| W20-10 100 万 ledger P95 达标 | P95 实测 1705～2569ms > 1000ms 阈值 |

性能类失败，数值随机器负载波动（两次复跑 1705/2569）；在 `ca533e3d` 同样超阈。
所测聚合 SQL 为既有代码，资金增量未触碰其执行路径（资金读模型不进入该容量链路）。

### G-1～G-2　`pool043-operating-bill-settlement.test.ts`（2 项）

| 用例 | 失败断言 |
|---|---|
| completion barrier 流已提交后中断…冻结 ESTIMATED 零用量证据 | `raw_input_tokens` 等期望 `'0'`，实测含非零字段 |
| completion barrier 前置 UNKNOWN 零用量后 failover 精确成功 | 同上 |

结算器 `api_cost`/token 口径问题，`ca533e3d` 已失败；gateway 结算链路
（`apps/gateway/src/settlement/`）在 `ca533e3d..c88e366` 零改动。

## 三、处置

1. **本包不修改这 8 项断言以求绿**——它们各自反映真实的口径/性能问题，
   属 pool042 首页口径、W20 容量、pool043 结算三个**其他功能域**的工作项；
   在资金初始化包内"顺手修"会扩大变更面、混淆归属。
2. **正式 `pnpm test` 入口的当前状态**：database 子集 35 例中 29 通过；
   gateway 子集 9 例中 7 通过；全部失败即上述 8 项，均有本文件的基线归属证据。
3. **按复审意见"其余 7 项逐项判定归属"的要求**，本文件即该判定：
   归属为**既有的其他功能域缺陷**（详细根因与复现命令见上），建议由各域
   工作包承接（pool042 口径修复 / W20 性能达标 / pool043 结算口径），
   不阻断资金初始化候选的复审——但**最终豁免权在复审方与计划作者**，
   本包仅提供归属证据并诚实登记。
