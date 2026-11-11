# S3a 收据：用量总览与首页费用读取对齐同源估算（task 2.3 前半）

日期：2026-11-03；执行：glm-flash 子 Agent（WP1 S3a 合同）；分支 `codex/simplify-api-cost-and-official-balance`。
基线：HEAD `62f12de` ＋ S1/S2 未提交工作树（开工核对：`git rev-parse HEAD`＝62f12de58dff44065399e9cf8ac99faf217809f3；`git status --porcelain` 含 S1 全部文件（api-cost-estimation.ts、迁移 0093、kysely-ledger-tables、billing-rule-persistence、domain/billing-rule、exports/delivery-ledger、gateway billing.ts、read-models billing-rule-contract/routes、w19 测试）＋ S2 测试两件；快照见 `s3a-worktree-status.txt`）。未执行任何 git checkout/reset/commit/stash/push。

## 1. 调查结论（实施落点依据）

1. **基础 overview 口径**：`getResourceUsageOverview` 的 API 汇总行 `monthlyCost` 原取 `buildResourceBreakdown` 内 `monthlyOperatingCosts` 的**余额桥接 apiSpend**（期初+充值−期末，dashboard-breakdown.ts 原 :293）；`projectFinanceUsageOverview` 在 finance 开路径再用资金账户 `monthlyApiCost` 覆盖。两条路径都不同源且依赖资金事实。
2. **估算注入落点＝基础聚合层（dashboard-breakdown.ts）**：在 `buildResourceBreakdown` 对 API 分组直接调用 `loadApiCostEstimation`（providerCode+mode 资源集合为 resourceIds、企业时区当月期间），基础 overview 即携带同源值；finance 投影不再触碰 API 行 → finance 开/关两条路径天然同源同值。理由：落点唯一消费点、避免 route 层二次注入、与首页/同期窗口共享同一聚合入口（ACE-06）。`usage-overview-routes.ts` 因此**无需改动**。
3. **rechargeAmount/currentBalance 处置（API 汇总行）**：移除资金账户覆盖后保留基础层取值＝`provider_resource_operating_snapshot` 的 recharge_amount/current_balance 求和（官方余额快照域，C2/WP3 范围），非资金账户（provider_finance_account）值；未置 null。
4. **getSummary**：`loadApiCostEstimation(全企业, 当月)` 经纯函数 `applyApiCostEstimationToSpend` 覆盖 apiCost(s)/apiCostReason 并重算 totalSpend(s)；packagePayment 系列与 monthlyRechargeAmount(s) 原值保留。注意：/dashboard 路由 finance 开路径仍会经 `projectDashboardFinance`（dashboard-projection.ts，**合同外文件**）用资金读模型覆盖首页 api 字段——本包未动，见"剩余问题"。
5. **loadWindowOperatingFinance**：apiCosts 金额段切至 `loadApiCostEstimation`（settled_at 半开窗口、处置投影口径）；`API_LEGACY_COST_ADJUSTMENT`/`API_HISTORICAL_USAGE_COST` 事件金额原样并入（AFR-06）；套餐现金段不动。**incompleteReason 保留 countOperatingExpenseGaps 权威口径（合同冲突，见 §4）**。
6. **resource-insights/query.ts 调查结论**：`knownLedgerCosts`（原 CTE 的 COALESCE(settled_at,created_at) 聚合）→ `MonthlyOperatingCostResource.ledgerApiCost`，该字段在 listResourceUtilization 输出链路（mapRow/applyApiBudgetFacts/token-utilization/routes）**无任何消费点**，仅起跳过默认 ledger SQL 的作用。按合同改为复用 `loadApiCostEstimation`（每 API 资源一次、与 loadMonthlyOperatingCosts 同期间 operatingBillMonthRange）供给，行为等价。

## 2. 改动文件清单（全部在合同允许清单内）

| 文件 | 一句话说明 |
|---|---|
| `packages/database/src/repositories/dashboard-monthly-spend.ts` | 新增纯函数 `applyApiCostEstimationToSpend`＋`apiEstimationGapText`（首页 API 分量由估算供给、按币种分列、8 位字面值；原 `summarizeDashboardMonthlySpend` 未动） |
| `packages/database/src/repositories/dashboard-repository.ts` | `getSummary` 并行加载全企业当月估算并经上述函数覆盖 api/total 分量；套餐与充值字段原值保留 |
| `packages/database/src/repositories/dashboard-breakdown.ts` | API 汇总行费用/币种/reason 由 `loadApiCostEstimation`（该 providerCode+mode 资源集合、当月期间）供给；CODING_PLAN 分支与快照类字段不动 |
| `packages/database/src/repositories/dashboard-home-costs.ts` | 同期窗口 API 金额段切至估算；遗留费用事件并入保留；incompleteReason 保留权威缺口口径并记录冲突（头注） |
| `apps/control-api/src/providers/finance-usage-overview.ts` | 移除 API 模型行 remainingQuota/currency 与 API 汇总行 monthlyCost/rechargeAmount/currentBalance/currency 的资金账户覆盖（C1 约束＋ACE-06）；CODING_PLAN 分支逐行保留 |
| `apps/control-api/src/resource-insights/query.ts` | `knownLedgerCosts` 改由 `loadApiCostEstimation` 按资源范围＋同期间供给（同源证据对齐） |
| `apps/control-api/src/provider-finance/consumer-projection.test.ts` | 2 条 API 断言迁移（逐处注明 C1/ACE-03/06 依据）＋新增 finance 双路同源、remainingQuota 不覆盖断言；套餐用例原样 |
| `packages/database/src/__tests-integration__/api-cost-readers-alignment.integration.test.ts` | 新增：四读取方同源核对、无资金数据 ACE-03、混币分列、同期窗口 AFR-06（覆盖/未覆盖） |
| `apps/control-api/src/__tests-integration__/resource-insights-api-cost-evidence.test.ts` | 新增：资源洞察证据与按资源范围估算一致、行语义不回归 |
| `apps/control-api/src/__tests-integration__/w18-dashboard-usage.test.ts` | 仅夹具修正：API 已计价行补 settled_at/api_cost_status/api_cost_currency（生产结算链必写事实，attempt-usage-settlement.ts/0085 shape）；断言值未改 |
| `packages/database/src/__tests-integration__/pool042-dashboard-resource-usage.integration.test.ts` | 同上夹具修正＋1 条 reason 断言迁移（`monthlyCostReason` 改为估算口径"币种不一致：CNY、USD"，注明 §1.2＋ACE-07 依据；monthlyCost:null 语义未变） |

未触碰：`usage-overview-routes.ts`（无需改动）、`resource-model-usage.ts`、monthly-operating-cost/operating-bill-*/monthly-operating-summary（S3b）、provider-finance/routes.ts、resource-pool-repository.ts、worker/web/迁移/员工月度额度、S1/S2 产物零改动。

## 3. 命令与用例数（全部实跑，退出码 0）

| 命令（包目录下） | 用例数 | 日志 |
|---|---|---|
| `tsc -p tsconfig.json --noEmit` ＋ `eslint src --max-warnings=0`（database / control-api，双包） | — | s3a-db-typecheck-lint.log / s3a-control-api-typecheck-lint.log |
| vitest run api-cost-readers-alignment.integration（新增） | 4 通过 | s3a-db-readers-alignment-output.log |
| vitest run api-cost-estimation（10）＋ api-cost-estimation-attempts（5）＋ home-cost-comparison（15）（复跑，3 文件 30 条） | 30 通过 | s3a-db-estimation-homecost-rerun.log |
| vitest run standard-home / finance-period-cost-integrity / pool042 / pool010 / pf0085+project-allocation / 三个单测文件 | 73 通过（9 文件） | s3a-db-consumers-rerun.log |
| vitest run consumer-projection + resource-insights-api-cost-evidence（新） + w18 + provider-review + w20-resource-insights | 52 通过（5 文件：5+2+19+17+9） | s3a-control-api-suites.log |
| vitest run gateway w08-e2e（复跑） | 13 通过 | s3a-gateway-w08-e2e-rerun.log |

新增/调整用例合计 11（跨读取方 4、finance 关路径/ACE-03 1、双路同源＋remainingQuota 不覆盖（consumer-projection 内）1、套餐不变 2（既有保留）、同期窗口 AFR-06 1、资源洞察 2——详见两新文件与迁移注释）。根 vitest `passWithNoTests:true` 已规避：每条命令均报告了实际用例数。

## 4. 偏离与合同冲突（需总指挥裁定）

1. **incompleteReason 未换用估算 gaps（合同 §1.3 部分偏离）**：证据——standard-home V14-C2（toContain "API_USAGE_COST_UNKNOWN"/"CASH_PAID_CNY_MISSING"）与 V14-C3（`toContain("OPENING_BALANCE_MISSING:2")`、反控制"已解决不计数"依赖 legacy_cost_resolution 排除）、finance-period-cost-integrity（`API_USAGE_COST_NOT_MIGRATED:1`／覆盖后 null）、home-cost-comparison（`toEqual` 精确串）钉死 countOperatingExpenseGaps 权径；而 loadApiCostEstimation.gaps 无 OPENING_BALANCE_MISSING/API_COST_CURRENCY_CONFLICT/套餐缺口表达、无窗口内历史聚合覆盖（loadApiCostGaps :61-77）与 resolution 已解决排除语义，直接换用会回归 3 个既有套件并违反 AFR-06/反控制语义。已实施：金额段切估算（本条前半履行），缺口段保留权威口径，dashboard-home-costs.ts 头注记录冲突。新集成测试第 4 条同时钉住"覆盖→null／未覆盖→API_USAGE_COST_NOT_MIGRATED"两个方向。
2. **w18/pool042 夹具修正**：为已计价夹具行补 settled_at/status/currency（生产结算链必写、0085 shape 要求），属夹具事实修正而非断言放宽；pool042 一条 `monthlyCostReason` 正则断言迁移至估算口径文案（注明依据）。请总指挥复核认可。
3. **合同外观察**：/dashboard 路由 finance 开路径经 `projectDashboardFinance`（dashboard-projection.ts）仍用资金读模型覆盖首页 api 字段——finance 开路径首页 API 金额当前≠估算；该文件不在 S3a 允许清单，未动。

## 5. 剩余问题 / 移交 S3b 注意项

- 上述 §4.1 缺口口径裁定：若总指挥决定换用估算 gaps，需同步迁移 standard-home V14-C2/V14-C3、finance-period-cost-integrity、home-cost-comparison 的钉死断言（超出本包授权）。
- 首页 finance 开路径（projectDashboardFinance）与用量总览模型行（`loadResourceModelUsageDetails`/queryUsageRows 仍为 created_at＋raw api_cost 口径，dashboard-resource-usage.ts :142/:161）尚未同源——建议 S3b 一并评估。
- query.ts 的 knownLedgerCosts 在输出链路无消费点（本包已对齐口径但保留现状）；如需性能优化可移除透传或改为批量估算。
- w20-standard-capacity 不消费本包改动函数，未跑；如总指挥全量复跑遇其抖动，按合同隔离复跑判定。

## 6. 证据路径（worktree `/Users/mac/Projects/仟流智算-api-decouple`）

- `V4/Evidence/API-COST-OFFICIAL-BALANCE/WP1-20261102/s3a-receipt.md`（本文件）
- `s3a-code-diff.txt`（S3a 九个修改文件 diff）、`s3a-worktree-status.txt`
- `s3a-db-typecheck-lint.log`、`s3a-control-api-typecheck-lint.log`
- `s3a-db-readers-alignment-output.log`、`s3a-db-estimation-homecost-rerun.log`、`s3a-db-consumers-rerun.log`、`s3a-control-api-suites.log`、`s3a-gateway-w08-e2e-rerun.log`
