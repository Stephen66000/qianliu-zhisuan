# WP03 实施记录 — 候选 C3

日期：2026-09-21。范围：v1.2 计划 §10 WP03（退出条件：全来源及分摊池 Token/金额守恒，旧员工/总账对照不变）。

## 交付物

1. **domain**：`money.ts`（BigInt 定点、确定性最大余数、平局按目标键字典序/未分配哨兵最后、token×bps 4dp 恒精确）；`allocation.ts`（优先级分派、瞬时权重匹配、RULE_PENDING_REPAIR、0% 显式段、HISTORICAL_UNKNOWN、逐行覆盖+池+全来源+按币种金额守恒报告）。
2. **共享成本适配**：`liveLineFactCtes.line_facts` 增量列 `ledger_line_id/upstream_attempt_id/request_started_at/provider_resource_id/manual_project_id/accounted_at/api_cost_currency`（纯增量；三个现有调用方按列名选择，回归 48 用例含 pool043-operating-bill-accounts/operating-feedback/operating-analysis 全绿）。
3. **计算仓储** `project-allocation-run-repository.ts`：源行装载（复用 CTE）、规则/参与/核算上下文装载+digest、启用登记（同事务登记初始化批次并捕获脏代次）、enqueue（单活动任务/新鲜度幂等）、claim（FOR UPDATE SKIP LOCKED+租约）、execute（守恒失败不发布；先关旧 current 再 SUCCEEDED+is_current；同输入+算法幂等；脏代次消费）、`runDueAllocationRuns` worker 入口（≤10/轮）。

## 金标回执

- domain：GS-1（220/60/320 万）、GS-2（0.3333/0.3333/0.3334、10^15 稳定）、GS-3（630 万四路径互斥）、GS-4（三桶分离/尾差/未知）、GS-5b（0% 显式段全未分配 WEIGHT_REMAINDER）、GS-7（NO_EFFECTIVE_RULE/HISTORICAL_UNKNOWN）——receipts/wp03-domain.txt（203 域测试含 24 个归集用例）。
- 端到端：真实账本夹具（5 源行=100/200/300 万池+直接 10 万+人工 20 万）→ A 230 万/B 80 万/未 320 万、CNY 19/USD 2 分币种守恒、幂等 enqueue、规则变更→新批次→新口径、只读路径零任务——receipts/wp03-integration.txt。

## 实施要点（供 R01）

- `monthDate` 用 `${month}-01`（勿用 `toISOString().slice`——UTC 偏移会把 9 月变 8-31，测试抓出后修复）。
- kyseley `onConflict` 需显式列推断（复合主键表）。
- 整集替换语义：发布只含 A-5000 段时，s1 的 100% 段与 B 段同时失效（合同 §7.2 权重编辑唯一合同的直接后果，测试固定该行为）。
