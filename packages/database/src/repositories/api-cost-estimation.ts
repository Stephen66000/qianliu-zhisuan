/**
 * API 费用估算统一聚合入口（WP1 C1 / task 2.1）。
 *
 * 依据：OpenSpec change simplify-api-cost-and-official-balance
 *   - specs/api-cost-estimation ACE-02/03/04/07（同源估算、不依赖余额与资金初始化、
 *     保留未知与已知部分、币种分列）；
 *   - WP0 contracts.md §1 C1（scope/period/amounts/completeness/gap/price_basis）；
 *   - WP1 plan.md §4 决策 2/3（聚合语义、缺口原因、处置排除、PRICE_BASIS_UNVERIFIED）。
 *
 * 语义合同（S1 §3.3，照做不另行发明）：
 *   - 只查 ledger_line 且 resource_mode='API'；禁止 JOIN 资金表/快照表/候选表；
 *     不 JOIN billing_rule：价格依据读请求时冻结的 ledger_line.billing_rule_snapshot
 *     ->>'sourceStatus'（F3/ACE-02：事后修改规则不得改变历史请求的价格依据；
 *     快照缺失该键的旧行回退 UNVERIFIED——缺证据即待核实，不把现值冒充当时值）。
 *   - 行分类（互斥）：
 *     1) 明确零：api_cost_status='CONFIRMED_ZERO_NO_UPSTREAM'（0 贡献、不算缺口；
 *        0085 shape 约束保证该状态行 api_cost=0 非空，天然不落入缺口判定）；
 *     2) 处置排除：api_cost IS NULL 且 effectiveUsageCostDispositionSql 为真
 *        （0 贡献、不算缺口、计入 excludedNoRecordedCost）；
 *     3) 已计价金额行：api_cost IS NOT NULL（金额取 effectiveReportedApiCostSql，
 *        处置投影权威口径；按 api_cost_currency 分桶求和；币种 NULL 的已计价行
 *        不入桶、计 CURRENCY_MISSING 缺口）；
 *     4) 缺口行：api_cost IS NULL 且未处置排除（非 CONFIRMED_ZERO 由 shape 约束保证）：
 *        api_cost_status='NOT_MIGRATED' → NOT_MIGRATED；否则 usage_quality='UNKNOWN' →
 *        USAGE_UNKNOWN；否则 → PRICE_MISSING（用量已知缺价格）。
 *   - completeness：存在任一缺口行 → KNOWN_PARTIAL；期间无任何 API 行 → KNOWN_COMPLETE +
 *     空 amounts；无缺口且无已计价金额行（只剩明确零/处置排除）→ ZERO_CONFIRMED；
 *     否则 KNOWN_COMPLETE。
 *   - gaps 另含信息项 PRICE_BASIS_UNVERIFIED（按快照冻结 sourceStatus='UNVERIFIED'
 *     计价的行数；旧行快照无键按 UNVERIFIED 计；不影响 completeness；
 *     CONFIRMED_ZERO_NO_UPSTREAM 行不计——零确认行无价格依据语义，恒快照 NULL，
 *     不排除会误报依据待核实，与 priced_rows 口径对齐，R4 总指挥裁定项）。
 *   - priceBasis：期间内计价行（api_cost IS NOT NULL）涉及的 billing_rule_id/rule_version
 *     及请求时冻结的快照 sourceStatus（同一规则不同行可能冻结不同状态，各自成行）。
 *   - 期间过滤：settled_at >= start AND settled_at < end（与 dashboard-home-costs.ts
 *     loadWindowOperatingFinance 同口径）。
 *   - 金额一律 decimal.js（Money/money，八位小数字符串），禁止 float。
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { money } from "./provider-finance-core.js";
import { effectiveUsageCostDispositionSql } from "./provider-finance-usage-dispositions.js";
import { effectiveReportedApiCostSql } from "./usage-cost-disposition-projection.js";

export type ApiCostEstimationCompleteness =
  | "KNOWN_COMPLETE"
  | "KNOWN_PARTIAL"
  | "ZERO_CONFIRMED";

export type ApiCostEstimationGapReason =
  | "NOT_MIGRATED"
  | "USAGE_UNKNOWN"
  | "PRICE_MISSING"
  | "CURRENCY_MISSING"
  | "PRICE_BASIS_UNVERIFIED";

export type BillingRuleSourceStatus = "VERIFIED" | "UNVERIFIED";

export interface ApiCostEstimationAmount {
  currency: string;
  /** 八位小数字符串（decimal.js，禁止 float）。 */
  amount: string;
}

export interface ApiCostEstimationGap {
  reason: ApiCostEstimationGapReason;
  count: number;
}

export interface ApiCostEstimationPriceBasis {
  ruleId: string;
  /** ledger_line 冻结的版本；历史行可能为 null。 */
  ruleVersion: string | null;
  /** ledger_line.billing_rule_snapshot 冻结的请求时值；旧行快照无该键为 UNVERIFIED（F3）。 */
  sourceStatus: BillingRuleSourceStatus;
}

export interface ApiCostEstimation {
  scope: { enterpriseId: string; resourceIds: string[] | null };
  period: { start: Date; end: Date };
  amounts: ApiCostEstimationAmount[];
  completeness: ApiCostEstimationCompleteness;
  gaps: ApiCostEstimationGap[];
  priceBasis: ApiCostEstimationPriceBasis[];
  excludedNoRecordedCost: number;
}

export interface ApiCostEstimationQuery {
  start: Date;
  /** 半开区间 [start, end)。 */
  end: Date;
  /** 可选资源过滤；缺省/null＝全企业。空数组＝空结果（原样透传，不展开为全量）。 */
  resourceIds?: string[];
}

interface EstimateAggregateRow {
  total_rows: number;
  priced_rows: number;
  confirmed_zero_rows: number;
  excluded_rows: number;
  currency_missing_rows: number;
  not_migrated_rows: number;
  usage_unknown_rows: number;
  price_missing_rows: number;
  basis_unverified_rows: number;
}

interface EstimateAmountRow {
  currency: string;
  amount: string;
}

interface EstimatePriceBasisRow {
  rule_id: string;
  rule_version: string | null;
  source_status: string;
}

/** 期间内本企业 API 账本行的分类投影（与两条聚合查询共用，保证口径一致）。 */
function estimationLinesSql(
  enterpriseId: string,
  start: Date,
  end: Date,
  resourceIds: string[] | null,
) {
  const scopeFilter = resourceIds === null
    ? sql`TRUE`
    : sql`l.provider_resource_id = ANY(${resourceIds}::uuid[])`;
  return sql`
    SELECT l.api_cost, l.api_cost_currency, l.api_cost_status, l.usage_quality,
           l.billing_rule_id, l.rule_version,
           coalesce(l.billing_rule_snapshot->>'sourceStatus', 'UNVERIFIED')
             AS rule_source_status,
           ${effectiveUsageCostDispositionSql("l")} AS excluded,
           ${effectiveReportedApiCostSql("l")} AS reported_cost
      FROM ledger_line l
     WHERE l.enterprise_id = ${enterpriseId}::uuid
       AND l.resource_mode = 'API'
       AND l.settled_at >= ${start} AND l.settled_at < ${end}
       AND ${scopeFilter}
  `;
}

/**
 * 统一聚合入口：同源 API 费用估算（不依赖资金账户/期初/余额差）。
 * 三条聚合查询读同一批账本行；与 loadWindowOperatingFinance 一致不做显式事务。
 */
export async function loadApiCostEstimation(
  db: Kysely<Database>,
  enterpriseId: string,
  query: ApiCostEstimationQuery,
): Promise<ApiCostEstimation> {
  const { start, end } = query;
  const resourceIds = query.resourceIds ?? null;
  const [aggregates, amountRows, basisRows] = await Promise.all([
    sql<EstimateAggregateRow>`
      WITH lines AS (${estimationLinesSql(enterpriseId, start, end, resourceIds)})
      SELECT count(*)::int AS total_rows,
        count(*) FILTER (WHERE lines.api_cost IS NOT NULL
          AND coalesce(lines.api_cost_status,'') <> 'CONFIRMED_ZERO_NO_UPSTREAM')::int AS priced_rows,
        count(*) FILTER (WHERE lines.api_cost_status = 'CONFIRMED_ZERO_NO_UPSTREAM')::int AS confirmed_zero_rows,
        count(*) FILTER (WHERE lines.api_cost IS NULL AND lines.excluded)::int AS excluded_rows,
        count(*) FILTER (WHERE lines.api_cost IS NOT NULL
          AND coalesce(lines.api_cost_status,'') <> 'CONFIRMED_ZERO_NO_UPSTREAM'
          AND lines.api_cost_currency IS NULL)::int AS currency_missing_rows,
        count(*) FILTER (WHERE lines.api_cost IS NULL AND NOT lines.excluded
          AND lines.api_cost_status = 'NOT_MIGRATED')::int AS not_migrated_rows,
        count(*) FILTER (WHERE lines.api_cost IS NULL AND NOT lines.excluded
          AND coalesce(lines.api_cost_status,'') <> 'NOT_MIGRATED'
          AND lines.usage_quality = 'UNKNOWN')::int AS usage_unknown_rows,
        count(*) FILTER (WHERE lines.api_cost IS NULL AND NOT lines.excluded
          AND coalesce(lines.api_cost_status,'') <> 'NOT_MIGRATED'
          AND lines.usage_quality <> 'UNKNOWN')::int AS price_missing_rows,
        count(*) FILTER (WHERE lines.api_cost IS NOT NULL
          AND coalesce(lines.api_cost_status,'') <> 'CONFIRMED_ZERO_NO_UPSTREAM'
          AND lines.rule_source_status = 'UNVERIFIED')::int AS basis_unverified_rows
      FROM lines
    `.execute(db),
    sql<EstimateAmountRow>`
      WITH lines AS (${estimationLinesSql(enterpriseId, start, end, resourceIds)})
      SELECT lines.api_cost_currency AS currency,
        coalesce(sum(lines.reported_cost) FILTER (WHERE lines.api_cost IS NOT NULL
            AND coalesce(lines.api_cost_status,'') <> 'CONFIRMED_ZERO_NO_UPSTREAM'), 0
        )::numeric(30,8)::text AS amount
      FROM lines
      WHERE lines.api_cost_currency IS NOT NULL
      GROUP BY lines.api_cost_currency
      ORDER BY lines.api_cost_currency ASC
    `.execute(db),
    sql<EstimatePriceBasisRow>`
      WITH lines AS (${estimationLinesSql(enterpriseId, start, end, resourceIds)})
      SELECT DISTINCT lines.billing_rule_id AS rule_id, lines.rule_version,
             lines.rule_source_status AS source_status
      FROM lines
      WHERE lines.api_cost IS NOT NULL AND lines.billing_rule_id IS NOT NULL
      ORDER BY lines.billing_rule_id ASC, lines.rule_version ASC NULLS LAST
    `.execute(db),
  ]);

  // count(*) 聚合恒返回一行（空集为 0），缺行只能是驱动层异常。
  const a = aggregates.rows[0]
    ?? (() => { throw new Error("api_cost_estimation_aggregate_row_missing"); })();
  const gapTotal = a.not_migrated_rows + a.usage_unknown_rows
    + a.price_missing_rows + a.currency_missing_rows;
  // 语义（S1 §3.3）：缺口>0 → KNOWN_PARTIAL；期间无任何 API 行 → KNOWN_COMPLETE（空 amounts）；
  // 无缺口且无已计价金额行（只剩明确零/处置排除）→ ZERO_CONFIRMED；否则 KNOWN_COMPLETE。
  const completeness: ApiCostEstimationCompleteness = gapTotal > 0
    ? "KNOWN_PARTIAL"
    : a.total_rows === 0 || a.priced_rows > 0
      ? "KNOWN_COMPLETE"
      : "ZERO_CONFIRMED";

  const gaps: ApiCostEstimationGap[] = ([
    ["NOT_MIGRATED", a.not_migrated_rows],
    ["USAGE_UNKNOWN", a.usage_unknown_rows],
    ["PRICE_MISSING", a.price_missing_rows],
    ["CURRENCY_MISSING", a.currency_missing_rows],
    // 信息项：依据待核实行数，不影响 completeness。
    ["PRICE_BASIS_UNVERIFIED", a.basis_unverified_rows],
  ] as const)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));

  return {
    scope: { enterpriseId, resourceIds },
    period: { start, end },
    amounts: amountRows.rows.map((row) => ({
      currency: row.currency,
      amount: money(row.amount),
    })),
    completeness,
    gaps,
    priceBasis: basisRows.rows.map((row) => ({
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      sourceStatus: row.source_status as BillingRuleSourceStatus,
    })),
    excludedNoRecordedCost: a.excluded_rows,
  };
}
