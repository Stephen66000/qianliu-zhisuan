import { matchApplicableBillingRule } from "@qianliu/domain";
import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { listEnabledBillingRulesAt } from "./billing-rule-applicability.js";
import type {
  ResourceBreakdownItem,
  ResourceModelTokenBreakdown,
} from "./dashboard-types.js";

type UsageQuality = ResourceBreakdownItem["monthlyUsageQuality"];
export type Mode = ResourceBreakdownItem["mode"];

export interface UsageRow {
  provider_code: string;
  provider_name: string;
  mode: Mode;
  resource_id: string;
  resource_name: string;
  resource_status: string;
  upstream_model: string;
  unified_model_id: string | null;
  model_alias: string;
  input_tokens: string;
  output_tokens: string;
  cache_tokens: string;
  reasoning_tokens: string;
  api_cost: string;
  deducted_quota: string;
  line_count: string;
  known_cost_count: string;
  known_quota_count: string;
  unknown_count: string;
  qualities: string[];
}

export interface DashboardResourceUsage {
  monthlyInputTokens: string | null;
  monthlyOutputTokens: string | null;
  monthlyCacheTokens: string | null;
  monthlyReasoningTokens: string | null;
  monthlyTotalTokens: string | null;
  monthlyUsageQuality: UsageQuality;
  monthlyUnknownCount: number;
  modelTokenBreakdown: ResourceModelTokenBreakdown[];
  tokenRate24h: string | null;
  costRate24h: string | null;
  estimatedBalanceTokens: string | null;
  balanceTokenEstimateConfidence: "HIGH" | "MEDIUM" | "LOW" | null;
  balanceTokenEstimateReason: string | null;
  balanceTokenEstimateBasis: string | null;
}

export interface DashboardResourceBalance {
  resourceId: string;
  currentBalance: string | null;
  currency: string | null;
}

type KnownDashboardResourceBalance = DashboardResourceBalance & {
  currentBalance: string;
  currency: string;
};

function hasKnownBalance(item: DashboardResourceBalance): item is KnownDashboardResourceBalance {
  return item.currentBalance !== null && item.currency !== null;
}

interface UsageAccumulator {
  input: Decimal;
  output: Decimal;
  cache: Decimal;
  reasoning: Decimal;
  cost: Decimal;
  quota: Decimal;
  lineCount: number;
  costKnown: boolean;
  quotaKnown: boolean;
  unknownCount: number;
  qualities: Set<string>;
}

const PreciseDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
export const RECENT_HOURS = 24;

export function emptyAccumulator(): UsageAccumulator {
  return {
    input: new PreciseDecimal(0), output: new PreciseDecimal(0),
    cache: new PreciseDecimal(0), reasoning: new PreciseDecimal(0),
    cost: new PreciseDecimal(0), quota: new PreciseDecimal(0),
    lineCount: 0, costKnown: true, quotaKnown: true, unknownCount: 0, qualities: new Set(),
  };
}

export function addRow(target: UsageAccumulator, row: UsageRow): void {
  target.input = target.input.plus(row.input_tokens);
  target.output = target.output.plus(row.output_tokens);
  target.cache = target.cache.plus(row.cache_tokens);
  target.reasoning = target.reasoning.plus(row.reasoning_tokens);
  target.cost = target.cost.plus(row.api_cost);
  target.quota = target.quota.plus(row.deducted_quota);
  target.lineCount += Number(row.line_count);
  target.costKnown = target.costKnown && row.known_cost_count === row.line_count;
  target.quotaKnown = target.quotaKnown && row.known_quota_count === row.line_count;
  target.unknownCount += Number(row.unknown_count);
  row.qualities.forEach((quality) => target.qualities.add(quality));
}

export function usageQuality(qualities: Iterable<string>): UsageQuality {
  const values = [...qualities].map((quality) => quality.toUpperCase());
  if (values.some((quality) => quality === "UNKNOWN" || quality.includes("+UNKNOWN"))) {
    return "UNKNOWN";
  }
  if (values.some((quality) => quality !== "PROVIDER_REPORTED" && quality !== "UPSTREAM_REPORTED")) {
    return "ESTIMATED";
  }
  return "EXACT";
}

export function integer(value: Decimal): string {
  return value.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0);
}

function groupKey(providerCode: string, mode: Mode): string {
  return `${providerCode}:${mode}`;
}

export async function queryUsageRows(
  db: Kysely<Database>, enterpriseId: string, start: Date, end: Date,
): Promise<UsageRow[]> {
  const result = await sql<UsageRow>`
    SELECT p.code AS provider_code, p.name AS provider_name,
           pr.mode, pr.id AS resource_id, pr.name AS resource_name,
           pr.status AS resource_status,
           ua.upstream_model, ar.unified_model_id,
           COALESCE(um.alias, ar.unified_model) AS model_alias,
           SUM(ll.raw_input_tokens)::text AS input_tokens,
           SUM(ll.raw_output_tokens)::text AS output_tokens,
           SUM(ll.raw_cache_tokens)::text AS cache_tokens,
           SUM(ll.raw_reasoning_tokens)::text AS reasoning_tokens,
           COALESCE(SUM(ll.api_cost::numeric), 0)::text AS api_cost,
           COALESCE(SUM(ll.deducted_quota), 0)::text AS deducted_quota,
           COUNT(*)::text AS line_count,
           COUNT(ll.api_cost)::text AS known_cost_count,
           COUNT(ll.deducted_quota)::text AS known_quota_count,
           COUNT(*) FILTER (
             WHERE upper(ll.usage_quality) LIKE '%UNKNOWN%'
           )::text AS unknown_count,
           ARRAY_AGG(DISTINCT ll.usage_quality) AS qualities
      FROM ledger_line ll
      JOIN provider_resource pr
        ON pr.id = ll.provider_resource_id AND pr.enterprise_id = ${enterpriseId}
      JOIN provider p ON p.id = pr.provider_id AND p.enterprise_id = ${enterpriseId}
      JOIN upstream_attempt ua
        ON ua.id = ll.upstream_attempt_id AND ua.enterprise_id = ${enterpriseId}
      JOIN ai_request ar ON ar.id = ll.ai_request_id AND ar.enterprise_id = ${enterpriseId}
      LEFT JOIN unified_model um
        ON um.id = ar.unified_model_id AND um.enterprise_id = ${enterpriseId}
     WHERE ll.enterprise_id = ${enterpriseId}
       AND ll.created_at >= ${start} AND ll.created_at < ${end}
       AND NOT (
         ua.response_committed = false
         AND ua.error_code IN (
           'key_or_model_authorization_revoked',
           'principal_grant_required',
           'candidate_admission_revoked'
         )
         AND ll.raw_input_tokens = 0
         AND ll.raw_output_tokens = 0
         AND ll.raw_cache_tokens = 0
         AND ll.raw_reasoning_tokens = 0
         AND upper(ll.usage_quality) LIKE '%UNKNOWN%'
       )
     GROUP BY p.code, p.name, pr.mode, pr.id, pr.name, pr.status, ua.upstream_model,
              ar.unified_model_id, COALESCE(um.alias, ar.unified_model)
     ORDER BY p.code, pr.mode, COALESCE(um.alias, ar.unified_model)
  `.execute(db);
  return result.rows;
}

function monthlySummary(rows: UsageRow[]): Omit<DashboardResourceUsage,
  "tokenRate24h" | "costRate24h" | "estimatedBalanceTokens" |
  "balanceTokenEstimateConfidence" | "balanceTokenEstimateReason" |
  "balanceTokenEstimateBasis"> {
  const total = emptyAccumulator();
  const models = new Map<string, UsageAccumulator & { id: string | null; alias: string }>();
  rows.forEach((row) => {
    addRow(total, row);
    const key = row.unified_model_id ?? `alias:${row.model_alias}`;
    const model = models.get(key) ?? Object.assign(emptyAccumulator(), {
      id: row.unified_model_id, alias: row.model_alias,
    });
    addRow(model, row);
    models.set(key, model);
  });
  const quality = usageQuality(total.qualities);
  const modelTokenBreakdown = [...models.values()].map((model) => {
    const modelQuality = usageQuality(model.qualities);
    return {
      unifiedModelId: model.id,
      modelAlias: model.alias,
      inputTokens: integer(model.input),
      outputTokens: integer(model.output),
      cacheTokens: integer(model.cache),
      reasoningTokens: integer(model.reasoning),
      totalTokens: integer(model.input.plus(model.output)),
      usageQuality: modelQuality,
      unknownCount: model.unknownCount,
    };
  });
  return {
    monthlyInputTokens: integer(total.input),
    monthlyOutputTokens: integer(total.output),
    monthlyCacheTokens: integer(total.cache),
    monthlyReasoningTokens: integer(total.reasoning),
    monthlyTotalTokens: integer(total.input.plus(total.output)),
    monthlyUsageQuality: rows.length === 0 ? "EXACT" : quality,
    monthlyUnknownCount: total.unknownCount,
    modelTokenBreakdown,
  };
}

function notCalculable(
  base: ReturnType<typeof monthlySummary>,
  tokenRate24h: string | null, costRate24h: string | null, reason: string,
): DashboardResourceUsage {
  return {
    ...base, tokenRate24h, costRate24h, estimatedBalanceTokens: null,
    balanceTokenEstimateConfidence: null, balanceTokenEstimateReason: reason,
    balanceTokenEstimateBasis: null,
  };
}

function groupRows(rows: UsageRow[]): Map<string, UsageRow[]> {
  const grouped = new Map<string, UsageRow[]>();
  rows.forEach((row) => {
    const key = groupKey(row.provider_code, row.mode);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  });
  return grouped;
}

export async function loadDashboardResourceUsage(
  db: Kysely<Database>, enterpriseId: string, monthStart: Date, monthEnd: Date,
  now: Date,
): Promise<(
  providerCode: string, mode: Mode, resourceBalances: DashboardResourceBalance[],
) => DashboardResourceUsage> {
  const recentStart = new Date(now.getTime() - RECENT_HOURS * 60 * 60 * 1000);
  const [monthlyRows, recentRows, rules] = await Promise.all([
    queryUsageRows(db, enterpriseId, monthStart, monthEnd),
    queryUsageRows(db, enterpriseId, recentStart, now),
    listEnabledBillingRulesAt(db, enterpriseId, now),
  ]);
  const byMonthly = groupRows(monthlyRows);
  const byRecent = groupRows(recentRows);

  return (providerCode, mode, resourceBalances) => {
    const base = monthlySummary(byMonthly.get(groupKey(providerCode, mode)) ?? []);
    const rows = byRecent.get(groupKey(providerCode, mode)) ?? [];
    const recent = emptyAccumulator();
    rows.forEach((row) => addRow(recent, row));
    const recentQuality = usageQuality(recent.qualities);
    const recentTokens = recent.input.plus(recent.output);
    const tokenRate24h = rows.length === 0 ? null : recentTokens.div(RECENT_HOURS).toDecimalPlaces(2).toFixed(2);
    const costRate24h = mode !== "API" || rows.length === 0 || !recent.costKnown
      ? null : recent.cost.div(RECENT_HOURS).toDecimalPlaces(8).toFixed(8);

    if (mode !== "API") return notCalculable(base, tokenRate24h, costRate24h, "NOT_API_RESOURCE");
    if (resourceBalances.length === 0 || !resourceBalances.every(hasKnownBalance)) {
      return notCalculable(base, tokenRate24h, costRate24h, "BALANCE_MISSING");
    }
    if (new Set(resourceBalances.map((item) => item.currency)).size !== 1) {
      return notCalculable(base, tokenRate24h, costRate24h, "PRICE_CURRENCY_MISMATCH");
    }
    if (recentQuality === "UNKNOWN") {
      return notCalculable(base, null, costRate24h, "USAGE_UNKNOWN");
    }
    if (recentTokens.isZero()) {
      return notCalculable(base, tokenRate24h, costRate24h, "RECENT_USAGE_MISSING");
    }

    let estimatedBalanceTokens = new PreciseDecimal(0);
    let minimumResourceLineCount = Number.POSITIVE_INFINITY;
    for (const resource of resourceBalances) {
      const resourceRows = rows.filter((row) => row.resource_id === resource.resourceId);
      const resourceRecent = emptyAccumulator();
      resourceRows.forEach((row) => addRow(resourceRecent, row));
      minimumResourceLineCount = Math.min(minimumResourceLineCount, resourceRecent.lineCount);
      const resourceTokens = resourceRecent.input.plus(resourceRecent.output);
      if (resourceRows.length === 0 || resourceTokens.isZero()) {
        return notCalculable(base, tokenRate24h, costRate24h, "RECENT_USAGE_MISSING");
      }
      let resourceCurrentCost = new PreciseDecimal(0);
      for (const row of resourceRows) {
        const rule = matchApplicableBillingRule(
          rules, row.resource_id, row.upstream_model, "API", now.getTime(),
        );
        if (!rule) {
          return notCalculable(base, tokenRate24h, costRate24h, "CURRENT_PRICE_RULE_MISSING");
        }
        if (rule.currency !== resource.currency) {
          return notCalculable(base, tokenRate24h, costRate24h, "PRICE_CURRENCY_MISMATCH");
        }
        const cache = new PreciseDecimal(row.cache_tokens);
        const input = new PreciseDecimal(row.input_tokens);
        resourceCurrentCost = resourceCurrentCost
          .plus(cache.times(rule.cacheHitPrice ?? "0"))
          .plus(input.minus(cache).times(rule.cacheMissPrice ?? "0"))
          .plus(new PreciseDecimal(row.output_tokens).times(rule.outputPrice ?? "0"));
      }
      if (resourceCurrentCost.isZero()) {
        return notCalculable(base, tokenRate24h, costRate24h, "CURRENT_PRICE_ZERO");
      }
      estimatedBalanceTokens = estimatedBalanceTokens.plus(
        new PreciseDecimal(resource.currentBalance).div(resourceCurrentCost.div(resourceTokens)),
      );
    }
    const roundedBalanceTokens = estimatedBalanceTokens
      .toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0);
    const confidence = recentQuality === "EXACT" && minimumResourceLineCount >= 20
      ? "HIGH" : minimumResourceLineCount >= 5 ? "MEDIUM" : "LOW";
    return {
      ...base, tokenRate24h, costRate24h, estimatedBalanceTokens: roundedBalanceTokens,
      balanceTokenEstimateConfidence: confidence,
      balanceTokenEstimateReason: null,
      balanceTokenEstimateBasis:
        `最近24小时 ${recent.lineCount} 条账本、${resourceBalances.length} 个账号、${rows.length} 个模型计价组合；按账号当前有效价格和输入/输出/缓存比例分别估算后汇总`,
    };
  };
}
