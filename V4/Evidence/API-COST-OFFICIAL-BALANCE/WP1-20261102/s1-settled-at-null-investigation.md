# S1 调查证据：ledger_line.settled_at NULL 可行性核查（S1 合同 §3.4 要求）

日期：2026-11-02；基线 HEAD `62f12de58dff44065399e9cf8ac99faf217809f3`；工作区 `仟流智算-api-decouple`。

## 结论

**列定义可空、存在 NULL 场景（仅限 seed/e2e 工具与未启用 strict writes 的直写路径）；全部生产结算写入路径都保证 settled_at 非空（回退到 usage.created_at）。** 按 S1 合同要求，聚合期间过滤保持 `settled_at >= start AND settled_at < end` 不改口径；NULL 场景与影响已上报总指挥（见 s1-receipt.md）。

## file:line 证据

### 1. 列定义（可空，无回填）

- `packages/database/migrations/0059_provider_finance_ledger.js:284`
  `addColumn("settled_at", "timestamptz")` —— 无 `.notNull()`、无 DEFAULT。
- 同迁移 :561 down `dropColumn("settled_at")`；0059 内 grep 无 `UPDATE ledger_line` 回填语句 → 加列前已存在的 ledger_line 行该列为 NULL（如生产存在早于 0059 的历史行）。
- 0085:186-205 重加的 `ledger_line_api_cost_fact_shape_check`：各状态与 api_cost/api_cost_currency 的形状约束，均未要求 settled_at 非空。

### 2. 条件性非空约束（仅 strict writes 启用的企业）

- `packages/database/migrations/0061_provider_finance_audit_hardening.js:189-192`
  `IF NEW.settled_at IS NULL OR NEW.api_cost_status IS NULL THEN RAISE EXCEPTION 'active provider finance ledger requires settlement and cost status'`——仅当 `provider_finance_runtime_state.strict_writes_enabled=true`（:186-188 读取）。
- `packages/database/migrations/0085_historical_usage_not_migrated.js:336/440` 同一触发器重建，同样仅 strict 启用时生效。

### 3. 生产写入路径（均保证非空）

- `packages/database/src/repositories/gateway-ledger-settlement.ts:197`：`const settledAt = input.ledger_line.settled_at ?? usage.created_at;`；:217 `settled_at: settledAt`。
- `packages/database/src/repositories/gateway-ledger-guarded-writes.ts:222`：`const settledAt = input.settled_at ?? usage.created_at;`；:240 `settled_at: settledAt`。
- `apps/gateway/src/pipeline/attempt-usage-settlement.ts:109` 与 `:204`：`settled_at: new Date()`。
- `apps/web/e2e/provider-review.spec.ts:88`：`settled_at: at`（e2e fixture 亦写）。

### 4. NULL 场景（非生产结算路径）

- `apps/control-api/src/cli/seed-e2e.ts:250` 起 ledger_line 批量插入，不含 settled_at（亦不含 api_cost_status）→ 插入行 settled_at 为 NULL。
- `apps/control-api/src/cli/seed-e2e-pool042.ts:75`、`seed-e2e-pool043.ts:93`：grep "settled_at" 计数为 0，同样不写。
- 理论上：未启用 strict writes 的企业，任何绕过结算服务的直写也可产生 NULL（数据库层面允许）。

### 5. 对 S1 聚合的影响

`loadApiCostEstimation`（`packages/database/src/repositories/api-cost-estimation.ts`）期间过滤采用与 `dashboard-home-costs.ts:49`（loadWindowOperatingFinance：`settled_at >= ${start} AND settled_at < ${end}`）完全一致的口径；settled_at 为 NULL 的行不会落入任何期间窗口——该既有权威读取方同样如此，本实现未改变口径。是否需要为 NULL 行新增缺口类别，由总指挥裁定（S2/S3 注意项）。
