# API 费用估算读取合同（WP1 / C1 落地口径）

版本：v1.1（WP1 S3b 收口＋S3c 年度对齐）；日期：2026-11-03；分支 `codex/simplify-api-cost-and-official-balance`。
供 WP2（资金退役）、WP3（官方余额 C2）、WP4（Web/导出文案）、WP5（总验收）消费。
权威实现：`packages/database/src/repositories/api-cost-estimation.ts`（S1/S2 产物，本包未改其语义）。

## 1. `loadApiCostEstimation` 签名与返回语义

```ts
loadApiCostEstimation(
  db: Kysely<Database>,
  enterpriseId: string,
  query: { start: Date; end: Date; resourceIds?: string[] },
): Promise<ApiCostEstimation>
```

- 期间：半开窗口 `settled_at >= start AND settled_at < end`（消费结算时间口径，与
  `dashboard-home-costs.loadWindowOperatingFinance` 一致）；`settled_at IS NULL` 的行不落入任何窗口
  （生产结算链必写 settled_at，见 `V4/Evidence/.../s1-settled-at-null-investigation.md`）。
- 范围：`resourceIds` 缺省/null＝全企业；空数组＝空结果（不展开为全量）。
- 只读 `ledger_line`（`resource_mode='API'`）＋LEFT JOIN `billing_rule`（仅为现值 `source_status`）；
  禁止依赖资金账户、期初、充值、官方余额、企业资金激活状态（ACE-03）。
- 行分类（互斥，见实现头注）：明确零（`CONFIRMED_ZERO_NO_UPSTREAM`）、处置排除
  （`effectiveUsageCostDispositionSql`，计 `excludedNoRecordedCost`）、已计价（金额取
  `effectiveReportedApiCostSql` 处置投影）、缺口（NOT_MIGRATED → USAGE_UNKNOWN → PRICE_MISSING）。

返回形状（八位小数字符串，decimal.js，禁止 float）：

| 字段 | 语义 |
|---|---|
| `amounts: {currency, amount}[]` | 按币种分桶的已知金额合计；币种为 NULL 的已计价行不入桶、计 `CURRENCY_MISSING`。消费方一律不得跨币种相加（ACE-07）。 |
| `completeness` | `KNOWN_PARTIAL`（任一缺口行）／`KNOWN_COMPLETE`（无缺口且有计价行，含期间无行）／`ZERO_CONFIRMED`（无缺口且无计价行，只剩明确零与处置排除）。只反映金额可知性。 |
| `gaps: {reason, count}[]` | `NOT_MIGRATED`、`USAGE_UNKNOWN`、`PRICE_MISSING`、`CURRENCY_MISSING` 为缺口；`PRICE_BASIS_UNVERIFIED` 为信息项（不影响 completeness）。 |
| `priceBasis: {ruleId, ruleVersion, sourceStatus}[]` | 期间内计价行涉及的规则版本及该规则现值（非冻结值）的核实状态。 |
| `excludedNoRecordedCost: number` | 被合法历史处置排除的行数（非缺口，处置可追溯，ACE-05 场景2）。 |

既有纯函数（复用入口，勿复制语义）：
- `applyApiCostEstimationToSpend(spend, estimation)`（`dashboard-monthly-spend.ts`）：首页 API 分量覆盖＋总额按币种重合；apiCost 为 null（混币/未知）时 totalSpend/totalSpends 不产出。
- `apiEstimationGapText(gaps)`：缺口 → 展示文案（剔除 `PRICE_BASIS_UNVERIFIED`）。
- `estimatedApiCostFields(estimation)`（`operating-bill-monthly-cost.ts`，S3b）：估算 → 账单 apiCost/apiSpends（单币种取金额；空且非 KNOWN_PARTIAL 取精确 0；多币种或未知部分为 null）。

## 2. `billing_rule.source_status`（迁移 0093）与规则入口

- 列：`billing_rule.source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'`，CHECK ∈ (`VERIFIED`,`UNVERIFIED`)；
  存量规则默认 UNVERIFIED（不得宣称为已核实官方价）。`source`（0011 自由文本）保留，语义＝来源描述≠核实状态。
- 入口链：`packages/domain/src/billing-rule.ts`（类型/快照）→ `apps/gateway/src/pipeline/billing.ts`
  （结算映射＋账本快照）→ `billing-rule-persistence.ts` / `kysely-ledger-tables.ts`（落库）→
  `apps/control-api/src/read-models/billing-rule-contract.ts` + `read-models/routes.ts`（读写路由，W19）。
- 展示要求（ACE-02 场景3）：UNVERIFIED 规则计价的金额必须呈现“价格依据待核实”，不得宣称官方实际扣款；
  页面文案归 WP4。

## 3. 读取方对齐清单（文件 → 口径 → 测试锚点）

| 读取方 | 文件 | 口径 | 测试锚点 |
|---|---|---|---|
| C1 统一入口 | `api-cost-estimation.ts` | settled_at 半开窗＋处置投影＋币种分列 | `api-cost-estimation.integration.test.ts`(10)、`api-cost-estimation-attempts.integration.test.ts`(5) |
| 首页汇总（finance 关） | `dashboard-repository.ts getSummary` | 全企业当月估算 → `applyApiCostEstimationToSpend` | `api-cost-readers-alignment.integration.test.ts`(4)、`dashboard-finance-estimation.test.ts`（S3b 新增，2） |
| 首页汇总（finance 开） | `apps/control-api/src/provider-finance/dashboard-projection.ts` | API 分量透传估算（不再用资金读模型覆盖）；套餐/充值保留资金读模型；总额=套餐+估算按币种 | `dashboard-projection.test.ts`（3 迁移+2 新增）、`dashboard-finance-estimation.test.ts` |
| 首页同期窗口 | `dashboard-home-costs.ts loadWindowOperatingFinance` | 金额段切估算；遗留费用事件并入（AFR-06）；incompleteReason 保留资金域权威缺口码（裁定 1） | `home-cost-comparison.integration.test.ts`(15)、readers-alignment 第4条 |
| 用量总览 API 汇总行 | `dashboard-breakdown.ts` | 按 providerCode+mode 资源集合估算（`apiCostFromEstimation`） | readers-alignment、`pool042-dashboard-resource-usage.integration.test.ts`(6) |
| 用量总览模型行 | `dashboard-resource-usage.ts queryUsageRows`（S3b §1.2） | settled_at 半开窗＋`effectiveReportedApiCostSql`（`api_cost`/`known_cost_count` 均走投影）；经 `resource-model-usage.ts`/`dashboard-home-metrics.tokenTotalsForRange` 消费 | `api-cost-draft-model-alignment.integration.test.ts`（S3b 新增，5） |
| 经营账单当前期 draft | `operating-bill-draft.ts`（S3b §1.3） | 资源级/汇总 apiCost、apiSpends、totalCost/totalSpends＝估算（按资源逐个调用＋全企业一次）；桥接字段/完整性机制不动 | `api-cost-draft-model-alignment.integration.test.ts`、`pool025-operating-bill.test.ts`(8，断言迁移见注释) |
| 经营账单 finance 开投影 | `operating-bill-finance-projection.ts` | 未改（资金读模型覆盖仍在）→ WP2/WP4 处置 | `finance-period-cost-integration...`(原样通过) |
| 部门账（live） | `operating-bill-account-month-lines.ts liveLineFactCtes` | 已是 `effectiveReportedApiCostSql`（:100）；期间 finance.enabled ? settled_at : created_at（:16-20）——未改，已同源 | `pool043-operating-bill-accounts.*` |
| 部门账（CLOSED） | `department-cost-evidence.ts loadDepartmentBill` | 已关账历史口径，AFR-06 保留 | `pool043-operating-bill-accounts.*` |
| 部门成本读模型 | `department-cost-read-model-query.ts` | costCtes/apiOnlyCostCtes 已用处置投影（:112/:253）；financeCostCtes 为资金口径（settled_at＋遗留调整事件，AFR-06）——未改 | `w20-department-costs.test.ts` |
| 项目归属 | `operating-bill-project-attribution.ts` | 只做归属快照，无 API 费用读取——无需改 | `project-allocation-*` |
| 年度统计 | `operating-analysis-repository.ts` | S3c（commit `75a82fe`）已对齐：月度 `apiSpend`/`apiSpendComplete` 改由 `loadApiCostEstimation` 按（厂商×月）供给（单币种金额/多币种 null＋false/无行精确 0/KNOWN_PARTIAL 金额照出＋false）；资金轨迹字段（opening/recharge/paidCny/ending）与 `loadResourceFinanceViews` 调用保留（WP2/WP4 处置）；行键仍来自资金视图 accounts（仅有缺口行的厂商不出行——预存模型边界） | `operating-analysis.integration.test.ts`(9，含 4 条新增) |

## 4. 裁定记录

1. **缺口码权威口径保留**（S3a 冲突收口）：同期窗口/标准首页的 `incompleteReason` 仍由
   `countOperatingExpenseGaps`（资金域缺口码 OPENING_BALANCE_MISSING、API_USAGE_COST_*、
   CASH_PAID_CNY_MISSING 等）产出；估算 `gaps` 不替换它——估算缺口码缺 OPENING_BALANCE_MISSING 等
   资金事实表达与窗口内历史聚合覆盖语义（`loadApiCostGaps` :61-77），直接换用会违反 AFR-06 反控制语义
   并回归 standard-home V14-C2/C3、finance-period-cost-integrity、home-cost-comparison。
   金额段与缺口段自此分属两个权威：金额=估算（C1），缺口文案=资金域权威规则（WP2 处置时统一）。
2. **桥接字段保留待 WP2/WP4**：经营账单 draft 的 openingBalance/endingBalance/rechargeAmount(s)、
   `balanceBridgeFacts`（含 previous_closing 上月关账→本月期初链）、`apiSpendStatus/apiSpendReason`
   （桥接可算性）与 `ledgerApiCost`（created_at 核对证据）照常产出；`apiCost` 主值已切估算。
   `operating-bill-finance-projection.ts`（finance 开路径用资金账户 monthlyApiCost 覆盖）未改。
   首页 finance 开路径的 monthlyRechargeAmount(s) 同样保留资金读模型值。

## 5. WP3 / WP4 / WP5 消费指引

- **WP3（官方余额 C2）**：费用估算已不依赖官方余额；C2 只服务余额展示域。首页 finance 开路径的
  `monthlyRechargeAmount(s)` 仍是资金读模型值，若 C2 接管充值/余额展示，走
  `finance.apiRecharges`/`currentApiBalances`，勿把余额差回填进估算。
- **WP4（页面/导出文案）**：① 名称统一“API费用估算”（ACE-01），不得写实际扣款/实际支付；
  ② UNVERIFIED 规则计价需“价格依据待核实”角标（数据源 `gaps` 的 `PRICE_BASIS_UNVERIFIED` /
  `priceBasis[].sourceStatus`）；③ 混币必须分列展示（`amounts` 多币种时对应 scalar 为 null，
  `apiCostReason`/`monthlyApiSpendReason` 为“币种不一致：XX、YY”）；④ 桥接字段（期初/充值/期末）
  与估算金额并存属过渡态，展示可分栏，但不得把 `apiSpendStatus` 的桥接缺口文案挂在估算金额上。
- **WP5（50 条总验收）**：金额核对以 `loadApiCostEstimation` 为唯一基准；跨页面核对允许的差异仅限
  （a）筛选范围/期间不同、（b）缺口与完整性说明不同（裁定 1 的双权威）、（c）桥接字段保留的历史值
  （AFR-06）。已关账版本与历史快照零改动，任何“旧月份金额变化”即 FAIL。

## 6. 已知边界（非本包职责）

- 年度统计已在 S3c 对齐（§3 末行）；多币种月份所有 (provider,currency) 行的 `apiSpend` 保守置 null＋false（不按行拆币种金额），WP4 如需分币种展示再扩展行模型。
- `settled_at IS NULL` 行不进任何结算窗口读取（含估算）；生产链路不产生，仅 seed 工具/未启用 strict
  writes 的直写会产生（S1 调查 §4）。
- `projectDashboardFinance` 的前置条件是 summary 来自 `DashboardRepository.getSummary`（唯一生产调用方）。
