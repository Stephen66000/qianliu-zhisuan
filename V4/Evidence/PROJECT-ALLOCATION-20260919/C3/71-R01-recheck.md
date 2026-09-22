> **撤回声明（2026-09-22）**：本报告的"新候选整体可判 PASS"结论**作废**。
> 第三方独立审核 + 实施者实证复现发现：§3 所谓"existing 幂等短路按 digest 匹配"确实按
> digest 匹配，但短路分支把 `input_digest` **写回当前批次**，必撞
> `project_allocation_run_published_idem_uq`，一次 `runDueAllocationRuns` 内烧完全部尝试额度
> 转终态 FAILED，`dirty.generation` 永不消费 → 该账期**永久无法结账**；同时失败退避符号
> 写反、人工指定/回填不在变更识别内、`HISTORICAL_UNKNOWN` 缺"无参与证据"前提。
> 本报告 §3 的"观察项：backfill 不改变 digest —— 语义正确"正是该盲区：digest 能否识别
> 与"是否有东西触发重算"是两件事。返修记录见 `72-R02-rework.md`，最终判定以 R02 为准。

# R01 复核轮报告 — 三项 P1 修复复核（候选 HEAD 1e2f96f）

日期：2026-09-21。复核上下文：独立代理（只读，未修改任何文件；复核后 git status 干净）。

## 1. 总结论

| 项 | 判定 |
| --- |---|
| P1-1 资源级套餐余量生产者 | FIXED |
| P1-2 date-only 结束核算边界 | FIXED |
| P1-3 input_digest 行数碰撞 | FIXED |
| 新候选整体 | **可判 PASS**（无 P0/P1 级新问题；改动边界干净） |

## 2. 逐项证据（file:line）

**P1-1 FIXED**：余量在发布事务内、行插入后写入（project-allocation-run-repository.ts:468/:479-485/:489-527/:528-538）；只写正差（:526-527）；authority 与行级 package_line_cost 同源——finance=当月 plan cash（:490-499，operatingBillMonthRange 同窗）、非 finance=latest snapshot（:500-508，DISTINCT ON 与行级 CTE operating-bill-account-month-lines.ts:61-68 同构）；无源行资源 LEFT JOIN+COALESCE 0 全额入余量（:525）；0077:211-232 PK+INSERT-only 触发器防重防改；仅非幂等分支写入。测试：compute.integration.test.ts:297-384 断言 plan-cash 100.00000000/PLAN_CASH_RESIDUAL、read 模型透出、snapshot 40.00000000/SNAPSHOT_RESIDUAL、份额行数为 0。

**P1-2 FIXED**：date-only +24h 仅发生一次（lifecycle-repository.ts:91-94），profile 写入与 clip 调用传同一 endedAt（:111、:124-130，同事务同 Date 对象）；STARTED 不调用 clip（:123-131，affectedEmployees=0）；排他语义 :156/:180-182。测试：close.integration.test.ts:207-267——profile 与 max(valid_until) 同为 2026-09-20T16:00:00.000Z，结束日当天请求 MEMBERSHIP_RULE、NO_EFFECTIVE_RULE 计 0。

**P1-3 FIXED**：contentXor（run-repository.ts:383-400）按 ledger_line_id 排序、逐行 sha256，覆盖 AllocationSourceLine 全部 19 字段（对照 allocation.ts:23-43，digest 覆盖面=归集输入面）；:439-442 纳入 inputDigest；existing 幂等短路按 digest 匹配，内容变则不命中、重算照常发布；dirty 清除仍以 run.input_dirty_generation 为准（:590-606，与发布同事务，失败路径 :609-637 不清）。测试：compute.integration.test.ts:386-436——原地 UPDATE 后 secondRun≠firstRun、新 current 明细 share_api_cost=NULL。

**独立重跑**：compute 6 + close 5 = 11 全绿；domain 归集两文件 23 全绿。

**回归边界**：git diff 1fd65f7..1e2f96f --stat = 2 repo 文件 + 2 集成测试 + 2 receipts（313 insertions, 6 deletions），无其他模块被触碰。

## 3. 新发现

- P3（低，展示口径）：residual note 由企业级 financeEnabled 决定（run-repository.ts:535），而 authority 按资源 COALESCE(plan_cash, snapshot)（:509-514）；角落场景标签可能与实际来源不符，不影响金额/正差/守恒/幂等。建议后续按资源打标。
- 观察项（非问题）：仅改 settled_at/api_cost_status/subscription_period_id 的 backfill 不改变 digest——这些列不在 AllocationSourceLine、不影响归集结果，语义正确；触及 api_cost/币种/主体/token 的回填 digest 必变。
- 指令口径笔误说明："domain 应 33" 实为 23（两文件合计），与 R01 自身 receipt 一致，非回归。

## 4. 状态声明

核心功能工程候选最终 **PASS**；**百万行生产规模性能未验收**（performance WIP 分支专项，非本候选前置）；本候选链**未 push、未合并、未部署**。复核全程只读。
