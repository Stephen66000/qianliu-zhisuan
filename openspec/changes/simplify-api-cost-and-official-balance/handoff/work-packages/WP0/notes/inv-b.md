# Inv-B 调查笔记：费用读取路径、计价入口、价格规则来源（只读）

日期：2026-11-02；基线：origin/main `ae506fed47d21865420afa91137e8b244072933e`。

## 1. Gateway 按请求计价（复用基础，ACE-02）

- `apps/gateway/src/pipeline/billing.ts`：`computeBilling`（:26）、`computeBillingFromRule`（:81）；`BillingOutcome.apiCost: string | null`（:16-17，无规则时 null——即"价格缺失"状态的自然来源）。dispatch 反事实计价 :148-201。
- 规则匹配与分项计算：`packages/domain/src/billing-rule.ts`：`BillingRule`（:32-38，企业级默认 providerResourceId=null vs 资源级）、`computeApiCostFromRule`（:216）、`matchPriceRule`（:248）、`matchMultiplierRule`（:173）、多时间窗 :100-146、`computeDeductedQuota`（:206，Token 扣减与金额分离）。
- **价格落库**：`billing_rule` 表（DB:migrations/0011_billing_rule.js，:43 output_price 等；0064 补 cache_hit/cache_miss/output 完整性约束），版本化 0018_billing_rule_version、多窗 0021。
- **缺口（WP1 契约新增项）**：billing_rule 及 billing-rule.ts **无官方来源/核实状态字段**——ACE-02 场景 3"价格依据待核实"需要新增价格依据状态（如 source/verified 概念），不能宣称为已核实官方价。涉及迁移＋规则入口＋读取投影。

## 2. 月度费用＝余额桥接（被替换口径，D1）

- `DB:src/repositories/monthly-operating-cost.ts`：返回结构以 openingBalance/rechargeAmount(s)/opening_snapshot_* 为主（:30-45、:61-91）——期初＋充值－期末算法及 ledger 证据。
- 财务模式覆盖：`operating-bill-finance-projection.ts`（design 表）、`operating-bill-repository.ts:65`（finance mode ACTIVE + strict writes 时启用资金读模型）。
- 首页/账单入口：`dashboard-home-costs.ts`、`operating-bill-monthly-cost.ts`（WP1 追全部调用方）。

## 3. 用量总览余额覆盖（WP1/WP4 目标）

- `apps/control-api/src/providers/finance-usage-overview.ts:21-26`：API 模型 `remainingQuota` 被内部账户余额覆盖（`balanceState === "NORMAL" ? balance : null`）；:66-77 聚合 `balanceComplete`、`currentBalance`。OAB 独立字段后此处不再借用额度字段。
- `apps/control-api/src/provider-finance/dashboard-projection.ts:59` `financeReadModelEnabled`——finance 读模型启用门槛；`providers/routes.ts:245-252` 资源列表在启用时叠加 financeViews（:311）。

## 4. 消费事实与历史处置（保留基础）

- Attempt 结算写账：`apps/gateway/src/pipeline/attempt-usage-settlement.ts`（api_cost/币种/规则快照落库；WP1 核实列名与精度）。
- 历史处置投影：`DB:src/repositories/usage-cost-disposition-projection.ts`＋迁移 0086_provider_finance_usage_cost_disposition、0091_recorded_cost_accounting_policy——ACE-05 场景 2 与 AFR-06 的"合法历史处置保留"对象；**不按 finance 前缀删除**。

## 5. 同源聚合目标面（ACE-06/07）

受影响读取方（WP1 建统一聚合入口后逐个接）：资源列表/详情（providers/routes.ts:245-311）、首页 dashboard-home-costs、经营账单 operating-bill-*、部门/项目 operating-department-accounts / operating-bill-project-attribution、年度统计、CSV/报表（apps/web + worker reporting）、Control API providers/finance-usage-overview.ts、provider-finance/dashboard-projection.ts。

## 6. 移交 WP1 的核实项

- api_cost 精度/币种列的实际 schema（attempt/ledger 行级）与 8 位金额格式。
- 失败 Attempt、重试、跨月结算时间的现有归集口径（F03/F11 夹具对齐）。
- "已明确没有访问上游"（ACE-04 场景 2）在 dispatch 拒绝路径上的现有标记。
