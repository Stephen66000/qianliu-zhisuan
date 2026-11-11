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
 *
 * W20-10（R2 性能修复）：新增 loadApiCostEstimationByResource 批量分组入口——与
 * loadApiCostEstimation 完全同源（同 estimationLinesSql、同聚合计数/币种求和投影与
 * priceBasis DISTINCT 三元组片段、同 assembleApiCostEstimation 派生），仅追加
 * provider_resource_id 分组维度，供 resource-insights/query.ts 一次读取取代逐资源
 * N+1 调用；批量版三条聚合折入单条语句（ledger_line 基表只扫一遍，见其注释），
 * 单资源语义零改动。
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

export interface ApiCostEstimationBatchQuery {
  start: Date;
  /** 半开区间 [start, end)。 */
  end: Date;
  /** 资源清单；空数组＝空 Map（调用方无 API 资源时与逐资源循环空集同语义）。 */
  resourceIds: string[];
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

/**
 * 批量折单语句的 jsonb 载荷行（node-postgres 默认解析 jsonb → JS 对象数组，
 * 键名与 EstimateAmountRow / EstimatePriceBasisRow 字段一一对应，无需二次转换）。
 */
interface EstimateBatchAmountJson {
  currency: string;
  amount: string;
}

interface EstimateBatchPriceBasisJson {
  rule_id: string;
  rule_version: string | null;
  source_status: string;
}

/** 批量折单语句结果行：每请求资源恰好一行（聚合计数＋jsonb 金额分桶＋jsonb 价格依据）。 */
interface EstimateBatchResourceRow extends EstimateAggregateRow {
  provider_resource_id: string;
  amounts: EstimateBatchAmountJson[];
  basis: EstimateBatchPriceBasisJson[];
}

/**
 * 期间内本企业 API 账本行的分类投影（与两条聚合查询共用，保证口径一致）。
 * includeResourceId 仅供批量分组版（loadApiCostEstimationByResource）追加
 * provider_resource_id 分组维度；单资源版缺省 false，生成 SQL 与原版逐字一致。
 */
function estimationLinesSql(
  enterpriseId: string,
  start: Date,
  end: Date,
  resourceIds: string[] | null,
  includeResourceId = false,
) {
  const scopeFilter = resourceIds === null
    ? sql`TRUE`
    : sql`l.provider_resource_id = ANY(${resourceIds}::uuid[])`;
  const resourceColumn = includeResourceId
    ? sql`l.provider_resource_id,`
    : sql``;
  return sql`
    SELECT ${resourceColumn}
           l.api_cost, l.api_cost_currency, l.api_cost_status, l.usage_quality,
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

/** 聚合一共用：分类计数投影（单资源版与批量分组版同源，W20-10 提取，逐字未改）。 */
const ESTIMATE_COUNT_PROJECTION = sql`
  count(*)::int AS total_rows,
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
`;

/** 聚合二共用：已计价行按币种求和投影（单资源版与批量分组版同源，W20-10 提取，逐字未改）。 */
const ESTIMATE_PRICED_SUM = sql`
  coalesce(sum(lines.reported_cost) FILTER (WHERE lines.api_cost IS NOT NULL
      AND coalesce(lines.api_cost_status,'') <> 'CONFIRMED_ZERO_NO_UPSTREAM'), 0
  )::numeric(30,8)::text
`;

/**
 * 期间零行的资源条目（批量版）＝单资源版空期间聚合（count(*) 空集恒 0）。
 * 折单语句已由 unnest 驱动＋coalesce 直接为期间零行资源物化同值行；此处仅作
 * TS 侧缺行纯防御回退（与折单前 `?? EMPTY_ESTIMATE_AGGREGATE` 行为一致）。
 */
const EMPTY_ESTIMATE_AGGREGATE: EstimateAggregateRow = {
  total_rows: 0,
  priced_rows: 0,
  confirmed_zero_rows: 0,
  excluded_rows: 0,
  currency_missing_rows: 0,
  not_migrated_rows: 0,
  usage_unknown_rows: 0,
  price_missing_rows: 0,
  basis_unverified_rows: 0,
};

/**
 * 聚合行 → Estimation 的派生（单资源版与批量分组版共用；W20-10 提取，逻辑逐字未改）。
 * scope 由调用方给：单资源版透传查询 resourceIds（null＝全企业），批量版每资源 [id]。
 */
function assembleApiCostEstimation(
  enterpriseId: string,
  scopeResourceIds: string[] | null,
  start: Date,
  end: Date,
  aggregate: EstimateAggregateRow,
  amountRows: EstimateAmountRow[],
  basisRows: EstimatePriceBasisRow[],
): ApiCostEstimation {
  const gapTotal = aggregate.not_migrated_rows + aggregate.usage_unknown_rows
    + aggregate.price_missing_rows + aggregate.currency_missing_rows;
  // 语义（S1 §3.3）：缺口>0 → KNOWN_PARTIAL；期间无任何 API 行 → KNOWN_COMPLETE（空 amounts）；
  // 无缺口且无已计价金额行（只剩明确零/处置排除）→ ZERO_CONFIRMED；否则 KNOWN_COMPLETE。
  const completeness: ApiCostEstimationCompleteness = gapTotal > 0
    ? "KNOWN_PARTIAL"
    : aggregate.total_rows === 0 || aggregate.priced_rows > 0
      ? "KNOWN_COMPLETE"
      : "ZERO_CONFIRMED";

  const gaps: ApiCostEstimationGap[] = ([
    ["NOT_MIGRATED", aggregate.not_migrated_rows],
    ["USAGE_UNKNOWN", aggregate.usage_unknown_rows],
    ["PRICE_MISSING", aggregate.price_missing_rows],
    ["CURRENCY_MISSING", aggregate.currency_missing_rows],
    // 信息项：依据待核实行数，不影响 completeness。
    ["PRICE_BASIS_UNVERIFIED", aggregate.basis_unverified_rows],
  ] as const)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));

  return {
    scope: { enterpriseId, resourceIds: scopeResourceIds },
    period: { start, end },
    amounts: amountRows.map((row) => ({
      currency: row.currency,
      amount: money(row.amount),
    })),
    completeness,
    gaps,
    priceBasis: basisRows.map((row) => ({
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      sourceStatus: row.source_status as BillingRuleSourceStatus,
    })),
    excludedNoRecordedCost: aggregate.excluded_rows,
  };
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
      SELECT ${ESTIMATE_COUNT_PROJECTION}
      FROM lines
    `.execute(db),
    sql<EstimateAmountRow>`
      WITH lines AS (${estimationLinesSql(enterpriseId, start, end, resourceIds)})
      SELECT lines.api_cost_currency AS currency,
        ${ESTIMATE_PRICED_SUM} AS amount
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
  return assembleApiCostEstimation(
    enterpriseId, resourceIds, start, end, a, amountRows.rows, basisRows.rows,
  );
}

/**
 * 批量分组入口（W20-10）：一次调用取代逐资源 loadApiCostEstimation（N+1 已由 R2 消除，
 * 每资源 3 条 → 恒 3 条；残余瓶颈是三条独立语句各自 `WITH lines AS (estimationLinesSql)`
 * ——ledger_line 基表（百万行）与处置判定函数被完整扫描/执行三遍，W20-10
 * resourceUtilizationP95 稳定超标）。本版把三条折成**单条语句**：
 *
 * 单次基表扫描的实现：
 *   - `lines` CTE（同一 estimationLinesSql，含 provider_resource_id 分组列）被下方
 *     counts/amounts/basis 三个子聚合多处引用——PG 对多引用 CTE 物化一次（显式
 *     MATERIALIZED 锁定该语义），基表扫描与处置判定只执行一遍；
 *   - 主查询以 unnest(去重资源清单) WITH ORDINALITY 为驱动 LEFT JOIN 三子聚合，
 *     按 provider_resource_id 汇成单结果集，ORDER BY ids.ordinality 保持请求清单同序。
 *
 * 与三条语句版（及单资源版）的逐字段等价性依据：
 *   - counts：ESTIMATE_COUNT_PROJECTION 逐字嵌入，GROUP BY provider_resource_id
 *     （＝折单前聚合一）；
 *   - amounts：内层子查询与折单前聚合二逐字同源（GROUP BY 资源+币种、
 *     ESTIMATE_PRICED_SUM、WHERE api_cost_currency IS NOT NULL），外层
 *     jsonb_agg ORDER BY currency ASC 还原「资源内按币种 ASC」数组顺序，
 *     jsonb_build_object 键名与 EstimateAmountRow 字段一致（currency/amount 均非 NULL）；
 *   - basis：内层子查询与折单前聚合三逐字同源（DISTINCT 资源+rule_id+rule_version+
 *     source_status 四元组），外层 jsonb_agg ORDER BY rule_id ASC, rule_version ASC
 *     NULLS LAST 还原原排序（同一 rule_id+version 不同 source_status 的并列顺序
 *     两个版本同为未指定，天然一致）；
 *   - 期间零行资源：counts/amounts/basis 均无该资源行 → LEFT JOIN 置 NULL →
 *     coalesce 计数列 0（＝EMPTY_ESTIMATE_AGGREGATE）、amounts/basis '[]'::jsonb
 *     （＝折单前 TS 侧 `?? []`），与逐资源调用空期间语义逐字段一致；
 *   - jsonb 载荷由 node-postgres 默认解析为 JS 对象数组，键名即 TS 行字段，
 *     assembleApiCostEstimation 派生零改动。
 *
 * 输出合同不变：Map<resourceId, ApiCostEstimation>，每资源与逐资源调用
 * loadApiCostEstimation(db, ent, {start, end, resourceIds:[id]}) 返回值逐字段一致
 * （scope.resourceIds=[id]、period 同查询）。请求清单外的资源行不进入任何所请求资源
 * （scopeFilter 同前）。一致性回归：api-cost-estimation-by-resource.integration.test.ts
 * （多资源逐字段对照）。
 */
export async function loadApiCostEstimationByResource(
  db: Kysely<Database>,
  enterpriseId: string,
  query: ApiCostEstimationBatchQuery,
): Promise<Map<string, ApiCostEstimation>> {
  const { start, end } = query;
  // 清单去重（调用方来源为主键集合，正常无重复；防御性收敛，ANY/unnest 语义不变）。
  const resourceIds = [...new Set(query.resourceIds)];
  if (resourceIds.length === 0) return new Map();
  const batchRows = await sql<EstimateBatchResourceRow>`
    WITH lines AS MATERIALIZED (${estimationLinesSql(enterpriseId, start, end, resourceIds, true)}),
    counts AS (
      SELECT lines.provider_resource_id,
             ${ESTIMATE_COUNT_PROJECTION}
        FROM lines
       GROUP BY lines.provider_resource_id
    ),
    amounts AS (
      SELECT per_currency.provider_resource_id,
             jsonb_agg(jsonb_build_object(
               'currency', per_currency.currency, 'amount', per_currency.amount
             ) ORDER BY per_currency.currency ASC) AS amounts
        FROM (
          SELECT lines.provider_resource_id, lines.api_cost_currency AS currency,
                 ${ESTIMATE_PRICED_SUM} AS amount
            FROM lines
           WHERE lines.api_cost_currency IS NOT NULL
           GROUP BY lines.provider_resource_id, lines.api_cost_currency
        ) AS per_currency
       GROUP BY per_currency.provider_resource_id
    ),
    basis AS (
      SELECT distinct_basis.provider_resource_id,
             jsonb_agg(jsonb_build_object(
               'rule_id', distinct_basis.rule_id, 'rule_version', distinct_basis.rule_version,
               'source_status', distinct_basis.source_status
             ) ORDER BY distinct_basis.rule_id ASC,
               distinct_basis.rule_version ASC NULLS LAST) AS basis
        FROM (
          SELECT DISTINCT lines.provider_resource_id, lines.billing_rule_id AS rule_id,
                 lines.rule_version, lines.rule_source_status AS source_status
            FROM lines
           WHERE lines.api_cost IS NOT NULL AND lines.billing_rule_id IS NOT NULL
        ) AS distinct_basis
       GROUP BY distinct_basis.provider_resource_id
    )
    SELECT ids.provider_resource_id,
           coalesce(counts.total_rows, 0) AS total_rows,
           coalesce(counts.priced_rows, 0) AS priced_rows,
           coalesce(counts.confirmed_zero_rows, 0) AS confirmed_zero_rows,
           coalesce(counts.excluded_rows, 0) AS excluded_rows,
           coalesce(counts.currency_missing_rows, 0) AS currency_missing_rows,
           coalesce(counts.not_migrated_rows, 0) AS not_migrated_rows,
           coalesce(counts.usage_unknown_rows, 0) AS usage_unknown_rows,
           coalesce(counts.price_missing_rows, 0) AS price_missing_rows,
           coalesce(counts.basis_unverified_rows, 0) AS basis_unverified_rows,
           coalesce(amounts.amounts, '[]'::jsonb) AS amounts,
           coalesce(basis.basis, '[]'::jsonb) AS basis
    FROM unnest(${resourceIds}::uuid[]) WITH ORDINALITY AS ids(provider_resource_id, ordinality)
    LEFT JOIN counts ON counts.provider_resource_id = ids.provider_resource_id
    LEFT JOIN amounts ON amounts.provider_resource_id = ids.provider_resource_id
    LEFT JOIN basis ON basis.provider_resource_id = ids.provider_resource_id
    ORDER BY ids.ordinality ASC
  `.execute(db);
  const rowsByResource = new Map(
    batchRows.rows.map((row) => [row.provider_resource_id, row]),
  );
  const result = new Map<string, ApiCostEstimation>();
  for (const resourceId of resourceIds) {
    const row = rowsByResource.get(resourceId);
    result.set(resourceId, assembleApiCostEstimation(
      enterpriseId,
      [resourceId],
      start,
      end,
      // unnest 驱动保证每请求资源恰一行；缺行仅纯防御（与折单前回退一致）。
      row ?? EMPTY_ESTIMATE_AGGREGATE,
      row?.amounts ?? [],
      row?.basis ?? [],
    ));
  }
  return result;
}
