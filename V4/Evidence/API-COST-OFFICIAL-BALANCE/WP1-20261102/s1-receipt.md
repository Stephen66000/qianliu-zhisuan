# S1 回执：同源费用估算读取基础（WP1 task 2.1）

日期：2026-11-02。执行：glm-flash 子 Agent（WP1-S1）。合同：`openspec/changes/simplify-api-cost-and-official-balance/handoff/work-packages/WP1/contracts/S1.md`。

## 1. 基线 SHA 复核

- 开工执行 `git -C /Users/mac/Projects/仟流智算-api-decouple rev-parse HEAD` →
  `62f12de58dff44065399e9cf8ac99faf217809f3`＝合同基线，一致。
- 分支 `codex/simplify-api-cost-and-official-balance`，一致。
- 未执行 checkout/reset/commit/stash/push；收尾 `git status --porcelain` 仅含合同允许文件＋证据目录（见 §3）。

## 2. 调查结论（开工只读调查）

### 2.1 settled_at NULL 可行性（合同 §3.4 要求核实）

**结论：列可空、存在 NULL 场景（仅 seed/e2e 工具与未启用 strict writes 的直写路径）；全部生产结算写入路径保证非空（回退 usage.created_at）。** 已按合同要求"不改口径、上报说明"：聚合保持 `settled_at >= start AND settled_at < end`（与 `dashboard-home-costs.ts:49` loadWindowOperatingFinance 同口径），NULL 行不落入任何窗口——既有权威读取方同样如此。

file:line 证据全文见 `s1-settled-at-null-investigation.md`，要点：
- 列定义可空：`packages/database/migrations/0059_provider_finance_ledger.js:284`（无 notNull/DEFAULT，无回填）。
- 条件性非空触发器仅 strict 启用时生效：`0061_provider_finance_audit_hardening.js:189-192`、`0085_historical_usage_not_migrated.js:336/440`。
- 生产写入恒非空：`gateway-ledger-settlement.ts:197/:217`、`gateway-ledger-guarded-writes.ts:222/:240`（均 `?? usage.created_at`）、`apps/gateway/src/pipeline/attempt-usage-settlement.ts:109/:204`（`new Date()`）。
- NULL 场景：`apps/control-api/src/cli/seed-e2e.ts:250`（批量插入无 settled_at）、`seed-e2e-pool042.ts:75`、`seed-e2e-pool043.ts:93`（grep 计数 0）。

### 2.2 规则管理入口清单（路由文件/端点）

| 入口 | 文件 | 说明 |
|---|---|---|
| `GET /billing-rules` | `apps/control-api/src/read-models/routes.ts:33` | 列表（listAllBillingRules，selectAll 运行时自动含新列） |
| `POST /billing-rules` | `apps/control-api/src/read-models/routes.ts:42` | 创建（CreateBillingRuleSchema，显式透传 source_status；响应 `returningAll` 自动透出） |
| `PATCH /billing-rules/:id` | `apps/control-api/src/admin-writes/routes.ts:232` | 仅 effective_to/enabled（UpdateBillingRuleSchema 不含价格字段）——合同未要求动它，未改 |
| `POST /billing-rules/:id/:action` | `apps/control-api/src/admin-writes/archive-routes.ts:66` | 启停/归档动作，不涉及字段合同，未改 |
| `POST /pricing-configurations` | `apps/control-api/src/read-models/pricing-configuration-routes.ts:21` | 批量规则（rules 经 `{...rule}` spread 进 `savePricingConfiguration` → `repo.createBillingRule`，source_status 自动透传，`quota-pricing-configuration.ts:88`） |

### 2.3 `source` 字段现状

`billing_rule.source varchar(255)`（`migrations/0011_billing_rule.js:48`，自由文本"规则来源"描述，seed 中如 "M5_E2E_SEED"、批量入口写 "WEB_ADMIN"）——**未动**，与新增 `source_status`（核实状态）语义分离，符合 plan.md §4 决策 1。

### 2.4 其他核实

- 0085:193-205 shape 约束：`CONFIRMED_ZERO_NO_UPSTREAM` 行 api_cost=0 且币种 NULL；`PRICED_USAGE` 行 api_cost 与币种均非空 → 已计价行币种恒非空（CURRENCY_MISSING 为防御性缺口）。
- `ledger_line.usage_quality varchar(32) NOT NULL` 无 CHECK（`0009_ledger.js:36`；MIXED 注释仅针对 ledger_transaction）→ USAGE_UNKNOWN/PRICE_MISSING 按 =/≠'UNKNOWN' 判定与合同一致。
- 批量入口 `RuleInput = Omit<createBillingRule 参数, enterprise_id>`（`quota-pricing-configuration.ts:8`）→ persistence 新参自动进入批量合同。

## 3. 实际改动文件清单

### 新增（3）

| 文件 | 说明 |
|---|---|
| `packages/database/migrations/0093_billing_rule_source_status.js` | billing_rule 加 `source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'` + CHECK ∈('VERIFIED','UNVERIFIED')；down drop column（先约束后列）。 |
| `packages/database/src/repositories/api-cost-estimation.ts` | C1 统一聚合入口 `loadApiCostEstimation`：三段共享 CTE（仅 ledger_line + LEFT JOIN billing_rule 取现值 source_status），行分类/缺口/完整性/priceBasis/处置排除全按 S1 §3.3；金额 Money/money 8 位。 |
| `packages/database/src/__tests-integration__/api-cost-estimation.integration.test.ts` | S1 §5 全覆盖：a-g 十用例（含 resourceIds 过滤、空期语义、NOT_MIGRATED/USAGE_UNKNOWN 分桶、0093 迁移/回滚/重放）。 |

### 修改（9）

| 文件 | 说明 |
|---|---|
| `packages/database/src/kysely-ledger-tables.ts` | BillingRuleTable 加 `source_status: Generated<"VERIFIED"\|"UNVERIFIED">` 行类型。 |
| `packages/database/src/repositories/billing-rule-persistence.ts` | listActive/listAll 返回类型加 source_status；createBillingRule 入参加可选 source_status，仅在显式传入时写列（缺省走 0093 列 DEFAULT 'UNVERIFIED'，kysely 忽略 undefined），保证回滚链旧 schema 头兼容。 |
| `packages/database/src/exports/delivery-ledger.ts` | 按域导出 loadApiCostEstimation 及其全部类型（既有导出惯例文件）。 |
| `packages/domain/src/billing-rule.ts` | BillingRule 加可选 `sourceStatus?: "VERIFIED"\|"UNVERIFIED"`（合同 §3.5，不破坏既有构造）。 |
| `apps/gateway/src/pipeline/billing.ts` | computeBilling 映射加 `sourceStatus: rule.source_status`；billingRuleSnapshot 输出 `sourceStatus: rule.sourceStatus ?? "UNVERIFIED"`（最小改动，其余未动）。 |
| `apps/control-api/src/read-models/billing-rule-contract.ts` | BillingRuleSchema 加 `source_status: z.enum(["VERIFIED","UNVERIFIED"]).optional()`。 |
| `apps/control-api/src/read-models/routes.ts` | POST /billing-rules 透传 `source_status: input.source_status`（一行）。 |
| `apps/gateway/src/pipeline/billing-evidence.test.ts` | 既有测试按新合同调整【依据：S1 §3.5 迁移 0093 后 listActiveBillingRules 返回类型新增必填列，夹具补 `source_status: "UNVERIFIED"`（存量行默认值）并注明】＋新增 1 用例（快照 VERIFIED 透传/undefined→UNVERIFIED）；未删除/放宽任何断言。 |
| `apps/control-api/src/__tests-integration__/w19-billing-rules.test.ts` | 追加 1 用例（新字段接受/缺省 UNVERIFIED/响应透出/非法值 400），既有用例未动。 |

范围外文件零改动（`git status` 对照 §2 允许清单，仅多出证据目录）。

## 4. 实际执行的命令、退出码、用例数

| # | 命令（均 `corepack pnpm@11.11.0 --dir <worktree> ...`） | 退出码 | 用例数 pass/fail |
|---|---|---|---|
| 1 | `--filter @qianliu/database run typecheck` | 0 | 非测试 |
| 2 | `--filter @qianliu/domain run typecheck` | 0 | 非测试 |
| 3 | `--filter @qianliu/gateway run typecheck`（夹具调整后复跑） | 0 | 非测试 |
| 4 | `--filter @qianliu/control-api run typecheck` | 0 | 非测试 |
| 5 | `--filter @qianliu/domain run test` | 0 | 407/0（22 文件） |
| 6 | `gateway exec vitest run billing-evidence.test.ts billing.pool043.test.ts attempt-usage-settlement.test.ts` | 0 | 23/0（3 文件，改前） |
| 7 | `gateway exec vitest run billing-evidence.test.ts`（加新断言后） | 0 | 8/0（7 旧＋1 新） |
| 8 | `control-api exec vitest run w19-billing-rules.test.ts` | 0 | 3/0（2 旧＋1 新） |
| 9 | `control-api exec vitest run pricing-evidence-boundaries.test.ts pricing-configurations-http.test.ts` | 0 | 22/0 |
| 10 | `control-api exec vitest run w19 + pricing 两者`（persistence 调整后复跑） | 0 | 25/0（3 文件） |
| 11 | `database exec vitest run api-cost-estimation.integration.test.ts`（首轮） | 1 | 8 pass/2 fail（d 夹具违反 shape 约束、f returning 用法），修复后见 #12 |
| 12 | 同 #11（修复后） | 0 | 10/0（含 0093 迁移/回滚/重放用例） |
| 13 | `database exec vitest run gateway-compat-cost-status + gateway-zero-priced-cost-status + home-cost-comparison` | 0 | 25/0（3 文件，合同要求回归） |
| 14 | `database exec vitest run billing-rule-multi-window-migration + provider-finance-usage-disposition + quota-pricing-configuration + dispatch-pricing-readiness + migration.integration`（首轮） | 1 | 56/1（multi-window 在 0072 头被新必写列破坏）→ persistence 改条件写入后 #15 复跑 |
| 15 | `database exec vitest run billing-rule-multi-window-migration.integration.test.ts`（修复后） | 0 | 1/0 |
| 16 | `database exec vitest run api-cost-estimation + quota-pricing-configuration`（修复后复跑） | 0 | 33/0 |
| 17 | 四包 `run lint`（database/domain/gateway/control-api） | 0×4 | 非测试 |
| 18 | `--filter @qianliu/database run test:integration`（全量，后台） | 1 | 540/1（唯一失败＝w20-standard-capacity P95 计时断言 1239.4ms>1000ms） |
| 19 | `database exec vitest run w20-standard-capacity.integration.test.ts`（隔离复跑） | 0 | 2/0（33s，P95 达标）→ 全量失败为负载抖动 |

命令原始输出（.log）与代码 diff 全部归档于证据目录（见 §7）。注意 #18 全量中我的新文件所在套件均通过（api-cost-estimation 10 用例、multi-window、disposition、三个回归套件、migration.integration 等）；唯一失败用例不引用 billing_rule/source_status（`w20-standard-capacity.integration.test.ts` 全文无该引用），隔离复跑即绿。

## 5. 与合同的偏离

1. **既有测试调整 2 处（合同允许"新合同要求时调整且注明依据"）**：
   - `billing-evidence.test.ts` Row 夹具补必填 `source_status`（依据：0093 后 persistence 读类型新列）＋新增用例；
   - 无断言删除/放宽。
2. **无其他偏离**。聚合签名/语义/缺口/完整性/期间口径/settled_at 口径均按 §3 照做； settled_at NULL 场景已核实并上报（§2.1），未改口径。
3. `quota-pricing-configuration.ts`（批量入口落库）与 `admin-writes/routes.ts`（PATCH）**未改动**：前者经 spread+参数派生类型自动承接 source_status（核实于 quota-pricing-configuration.ts:8/:88），后者合同未要求（PATCH 仅 effective_to/enabled）。

## 6. 剩余问题 / 移交 S2、S3 注意项

1. **settled_at NULL（待总指挥裁定）**：seed CLI（seed-e2e*.ts）写入的行 settled_at 为 NULL，不落任何期间窗口；是否为这类行新增缺口类别（如 SETTLEMENT_TIME_MISSING）由总指挥决策；本实现未发明口径。
2. **CURRENCY_MISSING 为防御性**：0085 shape 约束使 PRICED_USAGE 行币种恒非空，除非未来约束放宽，该缺口在真实数据上应恒为 0。
3. **CONFIRMED_ZERO 行的规则计入 priceBasis**（api_cost=0 非空）：合同"计价行"按字面理解含明确零行；如总指挥希望排除明确零行，priceBasis/PRICE_BASIS_UNVERIFIED 需在 S2 加一行过滤。
4. **聚合不做显式事务**（三段查询 Promise.all）：与 loadWindowOperatingFinance 同惯例；并发写窗口下理论上存在跨语句不一致读，S3 接 HTTP 时如需强一致可在调用方包事务。
5. **S2 重复结算只计一次**：plan §4 要求"对同一 Attempt 重复结算只计一次由既有 dedup/IfAbsent 约束保证，测试须覆盖"——S1 未包含该用例（合同 §5 未列），请 S2 补。
6. `finance-usage-overview.ts` 余额覆盖移除、各读取方对齐＝S3 范围，未动。
7. GET /billing-rules 响应自动含 source_status（selectAll），web 端展示属 WP4，未动。

## 7. 证据路径（绝对路径）

目录：`/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP1-20261102/`

- `s1-receipt.md`（本回执）
- `s1-settled-at-null-investigation.md`（settled_at NULL 调查，file:line）
- `s1-code-diff.txt`（9 个修改文件完整 diff）
- `s1-integration-test-output.log`（新集成测试首轮+终轮 #12，10 用例）
- `s1-regression-3-suites-output.log`（#13 合同要求回归，25 用例）
- `s1-chain-disposition-pricing-migration-output.log`（#14 首轮，56/1）
- `s1-multi-window-rollback-after-fix-output.log`（#15 修复后）
- `s1-db-estimation-pricing-config-output.log`（#16）
- `s1-control-api-rules-output.log`（#8/#9/#10）
- `s1-gateway-billing-evidence-output.log`（#7）
- `s1-domain-test-output.log`（#5，407 用例）
- `s1-db-full-integration-output.log`（#18 全量，540/1）
- `s1-w20-capacity-isolated-rerun-output.log`（#19 隔离复跑 2/0）
