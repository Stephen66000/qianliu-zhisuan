import { sql, type Kysely, type Transaction } from "kysely";
import {
  balanceAmount,
  conservationMonths,
  computeCollectionDigest,
  computeFactWatermarkHash,
  PROVIDER_FINANCE_CUTOVER_ISO,
  type AccountComponentsFactRow,
  type ActivationCurrency,
  type ActivationScopeAccountInput,
  type ActivationScopeResourceInput,
  type ConservationMonth,
  type FactWatermark,
  type FactWatermarkSection,
  type FinanceFactRow,
  type LedgerLineFactRow,
  type LegacyPurchaseFactRow,
  type MonthlyGapFactRow,
  type PeriodFactRow,
  type RequiredCurrencySource,
  type UsageEventFactRow,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import { operatingConsumptionFilter } from "./operating-consumption-filter.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";
import {
  loadBalanceFactTotals,
  toBalanceComponents,
  type BalanceFactWindow,
} from "./provider-finance-balance-facts.js";
import { countFinanceGaps } from "./provider-finance-gaps.js";

type Executor = Kysely<Database> | Transaction<Database>;

/**
 * 资金账本初始化的只读事实装载（WP02 任务 2.1、2.2）。
 *
 * 对应 OpenSpec PFA-01、PFA-03；计划 v1.2 §3.1、§3.2、§5.2。
 *
 * 约束：
 * - 本模块只执行 SELECT。它必须能在 `SET TRANSACTION READ ONLY` 事务内运行。
 * - 事实窗口固定为 `[切换时点, snapshot_at]`；不读取窗口之外的本变更事实。
 * - 事实水位对 §5.2 列出的每一类表各生成一个稳定分段摘要，再合成总哈希；
 *   绝不依赖 `MAX(updated_at)` 之类的单点比较。
 * - 完整事实水位（本模块 buildFactWatermark）与「历史修复固定行集」
 *   （domain 的 usageRepairFieldDigests）是两个不同合同，不得混为一谈。
 */

// ===== 2.1 激活范围 =====

export interface ActivationScope {
  snapshotAt: string;
  window: ConservationMonth[];
  resources: ActivationScopeResourceInput[];
  accounts: ActivationScopeAccountInput[];
}

export async function loadActivationScope(
  db: Executor, input: { enterpriseId: string; snapshotAt: string },
): Promise<ActivationScope> {
  const cutover = PROVIDER_FINANCE_CUTOVER;
  const snapshotAt = new Date(input.snapshotAt);
  const resourceRows = await sql<{
    resource_id: string; resource_name: string; mode: "API" | "CODING_PLAN"; status: string;
    provider_id: string; provider_code: string; provider_name: string;
    has_post_cutover_ledger_line: boolean; has_crossing_snapshot: boolean;
    has_post_cutover_purchase: boolean;
  }>`
    SELECT resource.id AS resource_id, resource.name AS resource_name, resource.mode, resource.status,
           provider.id AS provider_id, provider.code AS provider_code, provider.name AS provider_name,
           EXISTS (SELECT 1 FROM ledger_line line
             WHERE line.enterprise_id=resource.enterprise_id
               AND line.provider_resource_id=resource.id
               AND COALESCE(line.settled_at,line.created_at)>=${cutover}
               AND COALESCE(line.settled_at,line.created_at)<=${snapshotAt}) AS has_post_cutover_ledger_line,
           EXISTS (SELECT 1 FROM provider_resource_operating_snapshot snapshot
             WHERE snapshot.enterprise_id=resource.enterprise_id
               AND snapshot.provider_resource_id=resource.id
               AND snapshot.effective_from<=${cutover} AND snapshot.effective_until>${cutover})
             AS has_crossing_snapshot,
           EXISTS (SELECT 1 FROM resource_purchase_record purchase
             WHERE purchase.enterprise_id=resource.enterprise_id
               AND purchase.provider_resource_id=resource.id
               AND purchase.purchased_at>=${cutover} AND purchase.purchased_at<=${snapshotAt})
             AS has_post_cutover_purchase
      FROM provider_resource resource
      JOIN provider ON provider.id=resource.provider_id
       AND provider.enterprise_id=resource.enterprise_id
     WHERE resource.enterprise_id=${input.enterpriseId}::uuid
       AND resource.status<>'DELETED'
     ORDER BY provider.code, resource.name, resource.id`.execute(db);

  const accountRows = await sql<{
    resource_id: string; currency: string; source: RequiredCurrencySource;
  }>`
    SELECT DISTINCT account.resource_id, account.currency, account.source FROM (
      SELECT snapshot.provider_resource_id AS resource_id, snapshot.currency, 'CUTOVER_SNAPSHOT' AS source
        FROM provider_resource_operating_snapshot snapshot
       WHERE snapshot.enterprise_id=${input.enterpriseId}::uuid
         AND snapshot.currency IN ('CNY','USD') AND snapshot.collected_at<=${cutover}
      UNION ALL
      SELECT event.provider_resource_id, event.account_currency, 'FINANCE_EVENT'
        FROM provider_finance_event event WHERE event.enterprise_id=${input.enterpriseId}::uuid
      UNION ALL
      SELECT line.provider_resource_id, line.api_cost_currency, 'PRICED_USAGE'
        FROM ledger_line line WHERE line.enterprise_id=${input.enterpriseId}::uuid
         AND line.resource_mode='API' AND line.api_cost_status='PRICED_USAGE'
         AND line.api_cost_currency IS NOT NULL
         AND COALESCE(line.settled_at,line.created_at)>=${cutover}
         AND COALESCE(line.settled_at,line.created_at)<=${snapshotAt}
      UNION ALL
      SELECT purchase.provider_resource_id, purchase.currency, 'HISTORICAL_RECHARGE'
        FROM resource_purchase_record purchase
       WHERE purchase.enterprise_id=${input.enterpriseId}::uuid
         AND purchase.purchase_type='API_RECHARGE' AND purchase.currency IN ('CNY','USD')
         AND purchase.purchased_at>=${cutover} AND purchase.purchased_at<=${snapshotAt}
    ) account
    ORDER BY account.resource_id, account.currency, account.source`.execute(db);

  const accountsByKey = new Map<string, ActivationScopeAccountInput>();
  for (const row of accountRows.rows) {
    if (row.currency !== "CNY" && row.currency !== "USD") continue;
    const key = `${row.resource_id}:${row.currency}`;
    const existing = accountsByKey.get(key);
    if (existing) {
      if (!existing.sources.includes(row.source)) existing.sources.push(row.source);
      continue;
    }
    accountsByKey.set(key, {
      resourceId: row.resource_id,
      currency: row.currency as ActivationCurrency,
      sources: [row.source],
    });
  }
  for (const account of accountsByKey.values()) {
    account.sources.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }

  return {
    snapshotAt: snapshotAt.toISOString(),
    window: conservationMonths(PROVIDER_FINANCE_CUTOVER_ISO, snapshotAt.toISOString()),
    resources: resourceRows.rows.map((row) => ({
      resourceId: row.resource_id,
      mode: row.mode,
      providerId: row.provider_id,
      providerCode: row.provider_code,
      providerName: row.provider_name,
      resourceName: row.resource_name,
      status: row.status,
      hasPostCutoverLedgerLine: row.has_post_cutover_ledger_line,
      hasCrossingSnapshot: row.has_crossing_snapshot,
      hasPostCutoverPurchase: row.has_post_cutover_purchase,
    })),
    accounts: [...accountsByKey.values()].sort((left, right) =>
      left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1
        : left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0),
  };
}

// ===== 事实装载 =====

export interface ProjectionFacts {
  financeEvents: FinanceFactRow[];
  periods: PeriodFactRow[];
  legacyPurchases: LegacyPurchaseFactRow[];
  ledgerLines: LedgerLineFactRow[];
  usageEvents: UsageEventFactRow[];
  accountComponents: AccountComponentsFactRow[];
  monthlyGaps: MonthlyGapFactRow[];
  strictWritesEnabled: boolean;
}

export async function loadProjectionFacts(
  db: Executor, input: { enterpriseId: string; scope: ActivationScope },
): Promise<ProjectionFacts> {
  const cutover = PROVIDER_FINANCE_CUTOVER;
  const snapshotAt = new Date(input.scope.snapshotAt);
  const [events, periods, purchases, lines, runtime, usageEvents] = await Promise.all([
    sql<{
      id: string; resource_id: string; event_type: string; currency: string;
      amount: string; cash: string | null; occurred_at: Date;
    }>`
      SELECT id, provider_resource_id AS resource_id, event_type, account_currency AS currency,
             account_amount::text AS amount, cash_paid_cny::text AS cash, occurred_at
        FROM provider_finance_event WHERE enterprise_id=${input.enterpriseId}::uuid
       ORDER BY occurred_at, created_at, id`.execute(db),
    sql<{
      id: string; resource_id: string; product_name: string; period_start: Date;
      period_end_exclusive: Date; reversed_by_event_id: string | null;
    }>`
      SELECT id, provider_resource_id AS resource_id, product_name, period_start,
             period_end_exclusive, reversed_by_event_id
        FROM provider_subscription_period WHERE enterprise_id=${input.enterpriseId}::uuid
       ORDER BY period_start, created_at, id`.execute(db),
    sql<{
      id: string; resource_id: string; purchase_type: "API_RECHARGE" | "PACKAGE_PURCHASE";
      amount: string; currency: string; purchased_at: Date; migrated_event_id: string | null;
    }>`
      SELECT purchase.id, purchase.provider_resource_id AS resource_id, purchase.purchase_type,
             purchase.amount::text AS amount, purchase.currency, purchase.purchased_at,
             migrated.id AS migrated_event_id
        FROM resource_purchase_record purchase
        LEFT JOIN provider_finance_event migrated
          ON migrated.enterprise_id=purchase.enterprise_id
         AND migrated.provider_resource_id=purchase.provider_resource_id
         AND migrated.external_reference=('legacy-purchase:' || purchase.id::text)
       WHERE purchase.enterprise_id=${input.enterpriseId}::uuid
         AND purchase.purchased_at>=${cutover} AND purchase.purchased_at<=${snapshotAt}
       ORDER BY purchase.purchased_at, purchase.id`.execute(db),
    loadLedgerLines(db, { enterpriseId: input.enterpriseId, snapshotAt }),
    sql<{ strict_writes_enabled: boolean }>`
      SELECT strict_writes_enabled FROM provider_finance_runtime_state
       WHERE enterprise_id=${input.enterpriseId}::uuid`.execute(db),
    sql<{
      id: string; input_tokens: string; output_tokens: string; cache_tokens: string; reasoning_tokens: string;
    }>`
      SELECT usage.id, usage.input_tokens::text AS input_tokens,
             usage.output_tokens::text AS output_tokens, usage.cache_tokens::text AS cache_tokens,
             usage.reasoning_tokens::text AS reasoning_tokens
        FROM usage_event usage
       WHERE usage.enterprise_id=${input.enterpriseId}::uuid
         AND usage.id IN (
           SELECT line.usage_event_id FROM ledger_line line
            WHERE line.enterprise_id=${input.enterpriseId}::uuid
              AND COALESCE(line.settled_at,line.created_at)>=${cutover}
              AND COALESCE(line.settled_at,line.created_at)<=${snapshotAt}
         )
       ORDER BY usage.id`.execute(db),
  ]);

  const accountComponents = await loadAccountComponents(db, input);
  const monthlyGaps = await loadMonthlyGaps(db, input.enterpriseId, input.scope.window);

  return {
    financeEvents: events.rows.map((row) => ({
      id: row.id, resourceId: row.resource_id, eventType: row.event_type,
      currency: row.currency as ActivationCurrency, accountAmount: row.amount,
      cashPaidCny: row.cash, occurredAt: row.occurred_at.toISOString(),
    })),
    periods: periods.rows.map((row) => ({
      id: row.id, resourceId: row.resource_id, productName: row.product_name,
      periodStart: row.period_start.toISOString(),
      periodEndExclusive: row.period_end_exclusive.toISOString(),
      reversedByEventId: row.reversed_by_event_id,
    })),
    legacyPurchases: purchases.rows.map((row) => ({
      id: row.id, resourceId: row.resource_id, purchaseType: row.purchase_type,
      amount: row.amount, currency: row.currency, purchasedAt: row.purchased_at.toISOString(),
      alreadyMigratedEventId: row.migrated_event_id,
    })),
    ledgerLines: lines,
    usageEvents: usageEvents.rows.map((row) => ({
      id: row.id, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cacheTokens: row.cache_tokens, reasoningTokens: row.reasoning_tokens,
    })),
    accountComponents,
    monthlyGaps,
    strictWritesEnabled: runtime.rows[0]?.strict_writes_enabled === true,
  };
}

/**
 * 用量行装载。WP03 的激活复验必须用同一函数并传入候选固定行主键，
 * 以保证「预检确定的行集」与「激活锁定的行集」是同一口径。
 *
 * - 传入 `ledgerLineIds` 时按 `line.id` 稳定排序，使激活侧的 `FOR UPDATE`
 *   按主键顺序加锁，避免双管理员并发时的行锁死锁。
 * - `forUpdate` 只能在读写事务内使用（`FOR UPDATE OF line`）；
 *   只读预检事务不得开启它（PostgreSQL 会以 25006 拒绝）。
 */
export async function loadLedgerLines(
  db: Executor,
  input: {
    enterpriseId: string; snapshotAt: Date;
    ledgerLineIds?: readonly string[];
    forUpdate?: boolean;
  },
): Promise<LedgerLineFactRow[]> {
  const idFilter = input.ledgerLineIds === undefined
    ? sql`true`
    : input.ledgerLineIds.length === 0
      ? sql`false`
      : sql`line.id IN (${sql.join(input.ledgerLineIds.map((id) => sql`${id}::uuid`))})`;
  const order = input.ledgerLineIds === undefined
    ? sql`ORDER BY COALESCE(line.settled_at,line.created_at), line.id`
    : sql`ORDER BY line.id`;
  const lock = input.forUpdate ? sql`FOR UPDATE OF line` : sql``;
  const result = await sql<{
    id: string; resource_id: string; resource_mode: "API" | "CODING_PLAN";
    raw_input_tokens: string; raw_output_tokens: string; raw_cache_tokens: string;
    raw_reasoning_tokens: string; api_cost: string | null; api_cost_currency: string | null;
    api_cost_status: string | null; legacy_cost_resolved: boolean; subscription_period_id: string | null;
    settled_at: Date | null; created_at: Date; snapshot_currency: string | null;
    billing_rule_id: string | null; operating_consumption: boolean;
    zero_confirmed_eligible: boolean; usage_event_id: string;
  }>`
    SELECT line.id, line.provider_resource_id AS resource_id, line.resource_mode,
           line.raw_input_tokens::text, line.raw_output_tokens::text, line.raw_cache_tokens::text,
           line.raw_reasoning_tokens::text,
           line.api_cost::text, line.api_cost_currency, line.api_cost_status,
           (resolution.id IS NOT NULL AND resolution.status='RESOLVED') AS legacy_cost_resolved,
           line.subscription_period_id, line.settled_at, line.created_at,
           line.billing_rule_snapshot->>'currency' AS snapshot_currency,
           line.billing_rule_id,
           ${operatingConsumptionFilter("line")} AS operating_consumption,
           (attempt.first_byte_at IS NULL AND COALESCE(attempt.response_committed,false)=false
             AND attempt.error_classification='DOWNSTREAM_AUTH_OR_QUOTA') AS zero_confirmed_eligible,
           line.usage_event_id
      FROM ledger_line line
      LEFT JOIN provider_finance_legacy_cost_resolution resolution
        ON resolution.enterprise_id=line.enterprise_id AND resolution.id=line.legacy_cost_resolution_id
      LEFT JOIN upstream_attempt attempt
        ON attempt.enterprise_id=line.enterprise_id AND attempt.id=line.upstream_attempt_id
     WHERE line.enterprise_id=${input.enterpriseId}::uuid
       AND COALESCE(line.settled_at,line.created_at)>=${PROVIDER_FINANCE_CUTOVER}
       AND COALESCE(line.settled_at,line.created_at)<=${input.snapshotAt}
       AND ${idFilter}
     ${order}
     ${lock}`.execute(db);
  return result.rows.map((row) => ({
    id: row.id, resourceId: row.resource_id, resourceMode: row.resource_mode,
    rawInputTokens: row.raw_input_tokens, rawOutputTokens: row.raw_output_tokens,
    rawCacheTokens: row.raw_cache_tokens, rawReasoningTokens: row.raw_reasoning_tokens,
    apiCost: row.api_cost, apiCostCurrency: row.api_cost_currency as ActivationCurrency | null,
    apiCostStatus: row.api_cost_status, legacyCostResolved: row.legacy_cost_resolved,
    subscriptionPeriodId: row.subscription_period_id, settledAt: row.settled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    billingRuleSnapshotCurrency: row.snapshot_currency,
    billingRuleId: row.billing_rule_id,
    operatingConsumption: row.operating_consumption,
    zeroConfirmedEligible: row.zero_confirmed_eligible,
    usageEventId: row.usage_event_id,
  }));
}

async function loadAccountComponents(
  db: Executor, input: { enterpriseId: string; scope: ActivationScope },
): Promise<AccountComponentsFactRow[]> {
  const cutover = PROVIDER_FINANCE_CUTOVER;
  const snapshotAt = new Date(input.scope.snapshotAt);
  const apiResourceIds = new Set(input.scope.resources
    .filter((resource) => resource.mode === "API").map((resource) => resource.resourceId));
  const rows: AccountComponentsFactRow[] = [];
  for (const account of input.scope.accounts) {
    if (!apiResourceIds.has(account.resourceId)) continue;
    const windowed: BalanceFactWindow = {
      enterpriseId: input.enterpriseId, resourceId: account.resourceId, currency: account.currency,
      eventsFrom: cutover, eventsTo: snapshotAt, ledgerFrom: cutover, ledgerTo: snapshotAt,
    };
    // 生产余额查询用 eventsFrom=null；窗口化投影用 eventsFrom=cutover。
    // 两者结果必须一致（期初/更正固定落在切换时点，充值不得早于切换时点），
    // 因此后者是一个非平凡的独立复算对照。
    const production: BalanceFactWindow = { ...windowed, eventsFrom: null };
    const [facts, reference] = await Promise.all([
      loadBalanceFactTotals(db, windowed),
      loadBalanceFactTotals(db, production),
    ]);
    rows.push({
      resourceId: account.resourceId,
      currency: account.currency,
      components: toBalanceComponents(facts),
      // 生产口径（eventsFrom=null）独立复算出的余额；投影侧用它校验窗口化分量没有漂移。
      reportedBalance: balanceAmount(toBalanceComponents(reference)),
    });
  }
  return rows;
}

async function loadMonthlyGaps(
  db: Executor, enterpriseId: string, window: readonly ConservationMonth[],
): Promise<MonthlyGapFactRow[]> {
  const rows: MonthlyGapFactRow[] = [];
  for (const entry of window) {
    const gaps = await countFinanceGaps(db as Kysely<Database>, enterpriseId,
      new Date(entry.start), new Date(entry.endExclusive));
    rows.push({
      month: entry.month,
      gaps: gaps.map((row) => ({ code: row.code, count: Number(row.count) })),
    });
  }
  return rows;
}

// ===== 2.2 完整事实水位 =====

/**
 * §5.2 要求的十个分段。分段名与表名一一对应，便于审计比对。
 */
export const FACT_WATERMARK_SECTIONS = [
  "provider_resource",
  "provider_resource_operating_snapshot",
  "resource_purchase_record",
  "provider_finance_event",
  "provider_subscription_period",
  "provider_finance_legacy_cost_resolution",
  "ledger_line",
  "usage_event",
  "billing_rule",
  "provider_finance_runtime_state",
] as const;

export type FactWatermarkSectionName = (typeof FACT_WATERMARK_SECTIONS)[number];

export async function buildFactWatermark(
  db: Executor, input: { enterpriseId: string; snapshotAt: string },
): Promise<FactWatermark> {
  const cutover = PROVIDER_FINANCE_CUTOVER;
  const snapshotAt = new Date(input.snapshotAt);
  const section = (name: FactWatermarkSectionName, rows: readonly unknown[]): FactWatermarkSection =>
    ({ section: name, count: rows.length, digest: computeCollectionDigest(rows) });

  const [resources, snapshots, purchases, events, periods, resolutions, lines, usageEvents, rules, runtime] =
    await Promise.all([
      sql`SELECT id, provider_id, name, mode, status, credential_type, concurrency_limit,
                 monthly_budget_amount::text AS monthly_budget_amount, monthly_budget_currency,
                 subscription_auto_renew_enabled, version, archived_at
            FROM provider_resource WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, version, source, collected_at, currency,
                 recharge_amount::text, current_balance::text, granted_balance::text,
                 topped_up_balance::text, provider_balance_available, balance_source, cost_source,
                 cumulative_cost::text, current_period_cost::text, cost_period_start, cost_period_end,
                 balance_updated_at, package_name, package_cost::text, total_quota::text, quota_unit,
                 used_quota::text, remaining_quota::text, effective_from, effective_until,
                 reset_cycle, reset_anchor_at, reset_timezone, usage_calculation, next_reset_at,
                 subscription_period_id
            FROM provider_resource_operating_snapshot WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, purchase_type, description, amount::text, currency,
                 purchased_at, service_period_start, service_period_end, source, evidence_ref, created_by
            FROM resource_purchase_record WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, event_type, account_amount::text, account_currency,
                 cash_paid_cny::text, occurred_at, external_reference, reversal_of_event_id,
                 correction_of_event_id, reconciliation_case_id, legacy_cost_resolution_id,
                 description, evidence_ref, source, idempotency_key, created_by_admin_user_id
            FROM provider_finance_event WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, finance_event_id, product_name, period_start,
                 period_end_exclusive, source, migration_source_record_id, reversed_by_event_id,
                 created_by_admin_user_id
            FROM provider_subscription_period WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, account_currency, window_start, window_end_inclusive,
                 provider_balance_snapshot_id, provider_confirmed_balance::text,
                 local_balance_before_adjustment::text, known_api_cost::text, missing_api_cost::text,
                 unknown_line_count::text, status, adjustment_event_id, evidence_ref,
                 created_by_admin_user_id, resolved_at
            FROM provider_finance_legacy_cost_resolution WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, ai_request_id, usage_event_id, upstream_attempt_id, provider_resource_id,
                 principal_id, resource_mode, raw_input_tokens::text, raw_output_tokens::text,
                 raw_cache_tokens::text, raw_reasoning_tokens::text, deducted_quota::text,
                 api_cost::text, api_cost_currency, api_cost_status, legacy_cost_resolution_id,
                 subscription_period_id, settled_at, usage_quality, billing_rule_id, rule_version,
                 multiplier::text, billing_rule_snapshot
            FROM ledger_line WHERE enterprise_id=${input.enterpriseId}::uuid
             AND COALESCE(settled_at,created_at)>=${cutover}
             AND COALESCE(settled_at,created_at)<=${snapshotAt}
           ORDER BY id`.execute(db),
      sql`SELECT id, ai_request_id, upstream_attempt_id, provider_resource_id,
                 input_tokens::text, output_tokens::text, cache_tokens::text, reasoning_tokens::text,
                 usage_quality, upstream_usage_id, dedup_key
            FROM usage_event WHERE enterprise_id=${input.enterpriseId}::uuid
             AND id IN (
               SELECT line.usage_event_id FROM ledger_line line
                WHERE line.enterprise_id=${input.enterpriseId}::uuid
                  AND COALESCE(line.settled_at,line.created_at)>=${cutover}
                  AND COALESCE(line.settled_at,line.created_at)<=${snapshotAt}
             )
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, upstream_model, rule_type, rule_version, effective_from,
                 effective_to, timezone, days_of_week, start_time, end_time, time_windows,
                 multiplier::text, cache_hit_price::text, cache_miss_price::text, output_price::text,
                 currency, priority, enabled, pricing_mode, source, version, archived_at
            FROM billing_rule WHERE enterprise_id=${input.enterpriseId}::uuid
             AND archived_at IS NULL
           ORDER BY id`.execute(db),
      sql`SELECT enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at
            FROM provider_finance_runtime_state WHERE enterprise_id=${input.enterpriseId}::uuid`.execute(db),
    ]);

  const sections: FactWatermarkSection[] = [
    section("provider_resource", resources.rows),
    section("provider_resource_operating_snapshot", snapshots.rows),
    section("resource_purchase_record", purchases.rows),
    section("provider_finance_event", events.rows),
    section("provider_subscription_period", periods.rows),
    section("provider_finance_legacy_cost_resolution", resolutions.rows),
    section("ledger_line", lines.rows),
    section("usage_event", usageEvents.rows),
    section("billing_rule", rules.rows),
    section("provider_finance_runtime_state", runtime.rows),
  ];
  return { sections, hash: computeFactWatermarkHash(sections) };
}
