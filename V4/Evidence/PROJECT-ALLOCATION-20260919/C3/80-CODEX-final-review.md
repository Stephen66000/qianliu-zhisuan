# 80 · Codex 终审代码审核

- 日期：2026-09-22
- 审核对象：`/Users/mac/Projects/仟流智算-project-allocation-feature-20260921`
- 分支：`project-allocation/v12-feature-candidate-20260921`
- 候选 HEAD：`a1a004b57288ef8cb53089529b04ebee8d78f0bc`
- 基线：`2b33719d0a89c1d634e850abb8af3bfeb886793c`
- 审核差异：`git diff 2b33719..a1a004b`

## 0. 结论

**FAIL：无 P0，发现 3 项 P1、1 项 P2。当前候选不应合并或用于生产升级。**

R01–R04 所列修复在对应既有用例内成立；R05 的“严格资金口径切换对全部已启用账期推脏”并未在真实“起始账期继承启用”语义下闭合。另有两条独立的账务正确性路径可实证破坏计划冻结的不变量：指定批次读取可跨账期混用，以及项目权重修改会删除当前项目未被修改的历史规则段。

现有定向回归仍为绿色：

- database foundation + provider-finance-cutover：22/22；
- control-api project-allocation-routes：13/13。

这说明以下问题是**测试反例缺口**，不是既有测试已覆盖而本次环境偶发失败。终审另在 `/tmp/qianliu-codex-final-a1a004b` 副本加入 3 个最小反例，三者均稳定失败；未修改候选生产/测试代码，未跑百万容量测试、Playwright e2e、mutation 或覆盖率专项。

## 1. P1：R05 推脏只枚举“起始登记行”，漏掉起始月之后已发布的账期

### 证据

启用模型是“从某个起始账期起生效”：

- `project-allocation-run-repository.ts:202-210` 只向 `project_allocation_period` 插入 `startMonth` 一行；
- `project-allocation-read-repository.ts:35-39` 与 `project-allocation-freeze.ts:35-38` 都用 `period_month <= 目标月` 判断后续月份已启用。

但 R05 钩子在 `provider-finance-cutover-repository.ts:296-302` 只查询 `project_allocation_period` 的实际行。若企业仅登记 2026-08，2026-09 已经由扫描/手工批次发布，则切换严格资金口径时只会推脏 8 月，不会推脏 9 月。

影响链成立：

1. 严格口径切换改变 `account_at` 与输入集合，且 `financeEnabled` 确实进入摘要（`project-allocation-run-repository.ts:438-484`）；
2. 9 月未推进 dirty generation，`enqueueAllocationRun` 会在 `:269-283` 把旧 current 当作已消费而拒绝创建新批次；
3. 结账闸门只在 dirty 且代次前进时拒结（`project-allocation-freeze.ts:65-73`），因此可把切换前的旧结果冻结进新账单。

### 实证

在 `/tmp` 副本只改既有 R05 用例场景：8 月启用并完成初始化，9 月单独推脏、发布并清脏，10 月执行 `activateStrictWrites`。原断言立即失败：

```text
FAIL provider-finance-cutover.integration.test.ts
expected false to be true
dirtyAfterSwitch.rows[0]?.dirty === false
```

这不是移除钩子实验，而是在未改生产代码的情况下使用真实起始语义触发遗漏。

### 必修建议

切换事务内应按“已启用范围”而不是登记行枚举账期。至少覆盖从最早 `startMonth` 到当前月的已发布/已脏账期（可由 `project_allocation_run`、`project_allocation_dirty` 与起始范围联合得到），并新增“8 月一条启用登记、9 月已有 current run”的区分力回归。

## 2. P1：显式 `run_id` 未绑定企业账期，未分配接口可在一个响应中混合两个批次

### 证据

- `listAllocationLines` 在 `project-allocation-read-repository.ts:257-265`、`listUnallocatedLines` 在 `:321-329` 对外部传入的 `runId` 直接信任；只有未传入时才按企业、月份、SUCCEEDED/current 解析。
- 后续查询只按 `l.run_id` 与 `l.enterprise_id` 过滤（`:289-297`、`:355-364`），没有验证该 run 的 `period_month` 与路径月份相同，也没有验证 run 状态。
- 未分配路由先用路径月份的 current run 读取汇总，再把 query `run_id` 交给明细读取（`project-allocation-routes.ts:141-150`）。
- Web 分页也没有固定首屏 run：`apps/web/src/api/project-allocation.ts:164-169` 每页都不带 `run_id`，重算发生在翻页间时可跨批次跳行或重复，违反计划 §7.2 的固定批次分页合同。

### 实证

临时路由用例创建同企业 8 月、9 月两个 SUCCEEDED/current run，各写一条未分配行；请求：

```text
GET /operating-bills/2026-09/project-unallocated?run_id=<august-run>
```

实际 HTTP 200，响应顶层 `runId/tokens` 来自 9 月（900），`detail.runId/lines` 来自 8 月（800）。反例断言 `detail.runId === septemberRun` 稳定失败。

### 必修建议

建立一个统一的 run 解析器：指定 `run_id` 时必须校验同企业、同路径账期、`SUCCEEDED`；允许读取同月历史 run，但跨月/跨企业/非成功 run 返回结构化 400/404。汇总和明细必须复用同一个已解析 run。前端在第一页取得 `runId` 后，后续页必须携带该值；run 变化时显式重置分页。

## 3. P1：项目权重意图会删除该项目未被修改的历史规则段

### 证据

项目页合同是“只提交当前项目目标时间段/权重，由服务端合并完整规则”。当前实现却在：

- `employee-allocation-policy-repository.ts:251-276` 只保留**其他项目**规则，把当前项目全部旧段删除；
- `:279-306` 只加入本次提交段后发布新 current policy；
- “新增 stint 同时带权重”路径也在 `project-membership-repository.ts:260-294` 用相同的 `project_principal_id <> 当前项目` 过滤，因而会删除同项目其他 stint 的历史段；
- 重算只加载 current policy（`project-allocation-run-repository.ts:110-116`），不会回看历史 policy 版本补回被删除的段。

因此，员工 8 月起 40%，9 月起改为 60% 后，当前完整规则只剩 9 月 60%；随后因迟到事实或更正重算 8 月时，原 40% 规则不再存在，历史用量会变成 `NO_EFFECTIVE_RULE`/未分配。

### 实证

临时集成用例：8 月 1 日创建开放成员关系并发布 4000bps，再通过项目意图仅提交 9 月 1 日起 6000bps。`getEmployeePolicyOverview` 实际只返回一段 6000bps；“保留 8 月 4000bps 并在 9 月边界截断”的断言稳定失败。

### 必修建议

按提交意图区间对当前项目旧段做区间差集/切片：保留所有不相交部分，裁剪相交部分，再加入新段；其他项目仍原样保留。新增至少三组回归：开放旧段中途改权重、有限区间局部覆盖、同项目退出再加入的新 stint 带权重，并验证历史月份重算结果不漂移。

## 4. P2：状态接口实际上永远看不到 QUEUED/RUNNING/FAILED

`getAllocationRunStatus` 只查询 `is_current=true`（`project-allocation-read-repository.ts:42-47`），而数据库约束明确 `is_current` 只能属于 SUCCEEDED（`0077_project_allocation_compute.js:40-41`）。因此接口类型虽声明四种状态，实际 `currentRun.status` 只能是 SUCCEEDED；初始化/重算期间返回“待计算”，终态失败的 `lastError` 也不会被读取。与计划 §7.4 的“计算中/失败”展示不一致。

建议保持 current 成功结果用于展示，同时单独查询该账期最新 active/failed run，返回 `latestRun`/`refreshStatus` 与错误，避免用失败任务覆盖仍可用的旧 current。

## 5. 既有修复与边界核查

- R01 资源余量、date-only 排他边界、逐行内容摘要：未发现本轮新反例。
- R02 核算窗口/finance/enablement 摘要：字段已进入 digest；本轮问题是对应切换未覆盖全部后续账期的推脏集合。
- R03 current-only 幂等、历史状态重发布、未消费脏代次闸门：实现方向成立；P1-1 正是因为没有推进代次而绕过该闭环。
- R04 bigint generation 比较：调用点均经 `allocationGeneration`/`BigInt`，未发现裸字符串序比较回归。
- R05：同事务成立，但“全部已启用账期”覆盖范围不成立，见 P1-1。
- 未重复报告交接文档 §6 的已决策蓄水池项；性能、百万容量与 e2e 仍按原声明保持未验收/未执行。

## 6. 放行条件

修复以上 3 项 P1 后，至少补入对应三个反例并重跑：domain、foundation/compute/close/invariance/cutover、control-api routes、Web 分页相关测试，以及一次正常的 workspace test/typecheck/lint/build。无需借机扩展百万容量、mutation、覆盖率或历史治理。

在 P1 修复并通过独立复核前，结论保持 **FAIL / 不可升级**。
