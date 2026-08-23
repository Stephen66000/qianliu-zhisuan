import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { decimalTextsEqual } from "./dashboard-helpers.js";
import {
  RECENT_HOURS,
  addRow,
  emptyAccumulator,
  integer,
  queryUsageRows,
  usageQuality,
  type Mode,
  type UsageRow,
} from "./dashboard-resource-usage.js";
import type { ResourceModelUsageDetail } from "./dashboard-types.js";
import type { CurrentProviderOperatingSnapshot } from "./provider-operating.js";

interface RegisteredModelRow {
  resource_id: string;
  resource_name: string;
  provider_code: string;
  provider_name: string;
  mode: Mode;
  resource_status: string;
  unified_model_id: string;
  model_alias: string;
}

interface ResourceForecastRow {
  resource_id: string;
  forecast_exhaust_at: Date | null;
  remaining_quota: string;
  confidence: string;
  not_calculable_reason: string | null;
  snapshot_at: Date;
}

function matchesModel(row: UsageRow, model: RegisteredModelRow): boolean {
  return row.resource_id === model.resource_id && (
    row.unified_model_id === model.unified_model_id ||
    (row.unified_model_id === null && row.model_alias === model.model_alias)
  );
}

/** “用量总览”模型明细：按已登记的模型 + 具体资源固定成行。 */
export async function loadResourceModelUsageDetails(
  db: Kysely<Database>,
  enterpriseId: string,
  monthStart: Date,
  monthEnd: Date,
  now: Date,
  currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
): Promise<ResourceModelUsageDetail[]> {
  const recentStart = new Date(now.getTime() - RECENT_HOURS * 60 * 60 * 1_000);
  const [registered, monthlyRows, recentRows, forecastResult] = await Promise.all([
    sql<RegisteredModelRow>`
      SELECT DISTINCT pr.id AS resource_id, pr.name AS resource_name,
             p.code AS provider_code, p.name AS provider_name, pr.mode,
             pr.status AS resource_status, mr.unified_model_id,
             um.alias AS model_alias
        FROM model_route mr
        JOIN unified_model um
          ON um.id = mr.unified_model_id AND um.enterprise_id = ${enterpriseId}
        JOIN provider_resource pr
          ON pr.id = mr.provider_resource_id AND pr.enterprise_id = ${enterpriseId}
        JOIN provider p
          ON p.id = pr.provider_id AND p.enterprise_id = ${enterpriseId}
       WHERE mr.enterprise_id = ${enterpriseId}
         AND mr.archived_at IS NULL
         AND um.archived_at IS NULL
         AND pr.status <> 'DELETED'
       ORDER BY p.name, pr.name, um.alias
    `.execute(db),
    queryUsageRows(db, enterpriseId, monthStart, monthEnd),
    queryUsageRows(db, enterpriseId, recentStart, now),
    sql<ResourceForecastRow>`
      SELECT DISTINCT ON (f.provider_resource_id)
             f.provider_resource_id AS resource_id, f.forecast_exhaust_at,
             f.remaining_quota, f.confidence, f.not_calculable_reason, f.snapshot_at
        FROM supply_forecast f
        JOIN provider_resource pr
          ON pr.id = f.provider_resource_id AND pr.enterprise_id = ${enterpriseId}
       WHERE f.enterprise_id = ${enterpriseId}
         AND pr.status <> 'DELETED'
       ORDER BY f.provider_resource_id, f.snapshot_at DESC
    `.execute(db),
  ]);
  const snapshotByResource = new Map(
    currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
  );
  const forecastByResource = new Map(
    forecastResult.rows.map((forecast) => [forecast.resource_id, forecast]),
  );

  // eslint-disable-next-line complexity -- API/Plan、未知事实、预测新鲜度均为互斥 fail-closed 分支。
  return registered.rows.map((model) => {
    const monthlyModelRows = monthlyRows.filter((row) => matchesModel(row, model));
    const recentModelRows = recentRows.filter((row) => matchesModel(row, model));
    const monthly = emptyAccumulator();
    const recent = emptyAccumulator();
    monthlyModelRows.forEach((row) => addRow(monthly, row));
    recentModelRows.forEach((row) => addRow(recent, row));
    const monthlyQuality = monthlyModelRows.length === 0 ? "EXACT" : usageQuality(monthly.qualities);
    const recentQuality = recentModelRows.length === 0 ? "EXACT" : usageQuality(recent.qualities);
    const snapshot = snapshotByResource.get(model.resource_id);
    const rawForecast = forecastByResource.get(model.resource_id);
    const currentRemaining = model.mode === "API"
      ? snapshot?.current_balance ?? null
      : snapshot?.remaining_quota ?? null;
    const forecast = rawForecast && snapshot
      && rawForecast.snapshot_at >= snapshot.calculated_at
      && decimalTextsEqual(rawForecast.remaining_quota, currentRemaining)
      ? rawForecast
      : null;
    const recentTokens = recent.input.plus(recent.output);
    const rate = model.mode === "CODING_PLAN"
      ? recentModelRows.length > 0 && recent.quotaKnown
        ? recent.quota.div(RECENT_HOURS).toDecimalPlaces(2).toFixed(2)
        : null
      : recentModelRows.length > 0 && recentQuality !== "UNKNOWN"
        ? recentTokens.div(RECENT_HOURS).toDecimalPlaces(2).toFixed(2)
        : null;
    const rateReason = recentModelRows.length === 0
      ? "最近24小时无调用"
      : model.mode === "CODING_PLAN" && !recent.quotaKnown
        ? "额度扣减不可计算"
        : model.mode === "API" && recentQuality === "UNKNOWN"
          ? "Token 计量未知"
          : null;
    return {
      resourceId: model.resource_id,
      resourceName: model.resource_name,
      providerCode: model.provider_code,
      providerName: model.provider_name,
      mode: model.mode,
      unifiedModelId: model.unified_model_id,
      modelAlias: model.model_alias,
      usedQuota: model.mode === "CODING_PLAN"
        ? monthly.quotaKnown ? integer(monthly.quota) : null
        : null,
      remainingQuota: model.mode === "CODING_PLAN" ? snapshot?.remaining_quota ?? null : null,
      quotaUnit: model.mode === "CODING_PLAN" ? snapshot?.quota_unit ?? null : null,
      currency: snapshot?.currency ?? null,
      monthlyCost: model.mode === "API"
        ? monthly.costKnown ? monthly.cost.toDecimalPlaces(8).toFixed(8) : null
        : null,
      monthlyCostReason: model.mode === "CODING_PLAN"
        ? "套餐固定费，不按模型拆分"
        : monthly.costKnown ? null : "模型费用不可计算",
      monthlyTotalTokens: monthlyQuality === "UNKNOWN"
        ? null
        : integer(monthly.input.plus(monthly.output)),
      usageQuality: monthlyQuality,
      consumptionRate24h: rate,
      consumptionRateUnit: rate === null
        ? null
        : model.mode === "API" ? "TOKEN_PER_HOUR" : "QUOTA_PER_HOUR",
      consumptionRateReason: rateReason,
      forecastExhaustAt: forecast?.forecast_exhaust_at?.toISOString() ?? null,
      forecastNotCalculableReason: forecast?.not_calculable_reason
        ?? (rawForecast ? "预测快照与当前余额不一致" : "暂无预测快照"),
      forecastConfidence: forecast?.confidence ?? null,
      status: model.resource_status,
    };
  });
}
