import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";
import { computeForecast, type WindowUsage } from "@qianliu/domain";

import type { Database } from "../kysely.js";
import { ProviderRepository } from "./provider-repository.js";
import { calculateQuotaPeriod } from "./provider-operating.js";

const HOUR_MS = 3_600_000;
const WINDOWS = [1, 24, 168] as const;

export interface SupplyForecastTickResult {
  resourcesScanned: number;
  snapshotsCreated: number;
  snapshotsSkipped: number;
}

interface UsageAggregate {
  amount: string;
  data_points: string;
  first_usage_at: Date | null;
}

/** POOL-022：从真实账本追加生成每资源供给预测，不覆盖历史。 */
export class SupplyForecastRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async runTick(now: Date = new Date(), bucketMs: number = 60_000): Promise<SupplyForecastTickResult> {
    const resources = await this.db
      .selectFrom("provider_resource")
      .select([
        "id",
        "enterprise_id",
        "mode",
        "credential_expires_at",
      ])
      .where("status", "<>", "DELETED")
      .execute();
    const grouped = new Map<string, typeof resources>();
    for (const resource of resources) {
      const rows = grouped.get(resource.enterprise_id) ?? [];
      rows.push(resource);
      grouped.set(resource.enterprise_id, rows);
    }

    let snapshotsCreated = 0;
    let snapshotsSkipped = 0;
    for (const [enterpriseId, enterpriseResources] of grouped) {
      const providerRepo = new ProviderRepository(this.db);
      const snapshots = await providerRepo.listCurrentOperatingSnapshots(enterpriseId, now);
      const byResource = new Map(snapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]));
      for (const resource of enterpriseResources) {
        const operating = byResource.get(resource.id);
        if (!operating) {
          snapshotsSkipped += 1;
          continue;
        }
        const remainingText = resource.mode === "API"
          ? operating.current_balance
          : operating.remaining_quota;
        const aggregates = await Promise.all(WINDOWS.map((hours) =>
          this.aggregateUsage({
            enterpriseId,
            resourceId: resource.id,
            mode: resource.mode,
            from: new Date(Math.max(
              now.getTime() - hours * HOUR_MS,
              resource.mode === "CODING_PLAN"
                ? operating.quota_period_start?.getTime() ?? 0
                : 0,
            )),
            to: now,
            windowHours: hours,
          })
        ));
        const [rate1h, rate24h, rate7d] = aggregates as [WindowUsage, WindowUsage, WindowUsage];
        const resourceExpiresAt = [resource.credential_expires_at, operating.effective_until]
          .filter((value): value is Date => value !== null)
          .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
        const configuredNextReset = operating.next_reset_at ?? calculateQuotaPeriod({
          resetCycle: operating.reset_cycle,
          resetAnchorAt: operating.reset_anchor_at,
          effectiveFrom: operating.effective_from,
          collectedAt: operating.collected_at,
          now,
        }).end;
        const result = computeForecast({
          rate1h,
          rate24h,
          rate7d,
          remainingQuota: remainingText === null ? null : new Decimal(remainingText).toNumber(),
          resourceExpiresAt: resourceExpiresAt?.getTime() ?? null,
          nextResetAt: configuredNextReset?.getTime() ?? null,
          now: now.getTime(),
        });
        const algorithmVersion = resource.mode === "API"
          ? "pool-022-v1-api-cost"
          : "pool-022-v1-quota";
        const bucket = Math.floor(now.getTime() / bucketMs);
        const forecastKey = `${resource.id}:${operating.id}:${bucket}:${algorithmVersion}`;
        const inserted = await this.db
          .insertInto("supply_forecast")
          .values({
            enterprise_id: enterpriseId,
            provider_resource_id: resource.id,
            rate_1h: decimalOrNull(result.rate1h),
            rate_24h: decimalOrNull(result.rate24h),
            rate_7d: decimalOrNull(result.rate7d),
            forecast_exhaust_at: result.forecastExhaustAt === null
              ? null
              : new Date(result.forecastExhaustAt),
            next_recover_at: result.nextRecoverAt === null
              ? null
              : new Date(result.nextRecoverAt),
            coverage_hours: decimalOrNull(result.coverageHours),
            remaining_quota: remainingText,
            confidence: result.confidence,
            data_points: result.dataPoints,
            not_calculable_reason: result.notCalculableReason,
            algorithm_version: algorithmVersion,
            consumption_unit: resource.mode === "API"
              ? "CURRENCY_PER_HOUR"
              : "QUOTA_PER_HOUR",
            forecast_key: forecastKey,
            snapshot_at: now,
          })
          .onConflict((conflict) => conflict.doNothing())
          .returning("id")
          .executeTakeFirst();
        if (inserted) snapshotsCreated += 1;
        else snapshotsSkipped += 1;
      }
    }
    return { resourcesScanned: resources.length, snapshotsCreated, snapshotsSkipped };
  }

  private async aggregateUsage(input: {
    enterpriseId: string;
    resourceId: string;
    mode: "API" | "CODING_PLAN";
    from: Date;
    to: Date;
    windowHours: number;
  }): Promise<WindowUsage> {
    const result = input.mode === "API"
      ? await sql<UsageAggregate>`
          SELECT COALESCE(SUM(api_cost::numeric), 0)::text AS amount,
                 COUNT(*)::text AS data_points,
                 MIN(created_at) AS first_usage_at
            FROM ledger_line
           WHERE enterprise_id = ${input.enterpriseId}
             AND provider_resource_id = ${input.resourceId}
             AND resource_mode = 'API'
             AND api_cost IS NOT NULL
             AND created_at >= ${input.from}
             AND created_at < ${input.to}
        `.execute(this.db)
      : await sql<UsageAggregate>`
          SELECT COALESCE(SUM(deducted_quota::numeric), 0)::text AS amount,
                 COUNT(*)::text AS data_points,
                 MIN(created_at) AS first_usage_at
            FROM ledger_line
           WHERE enterprise_id = ${input.enterpriseId}
             AND provider_resource_id = ${input.resourceId}
             AND resource_mode = 'CODING_PLAN'
             AND deducted_quota IS NOT NULL
             AND created_at >= ${input.from}
             AND created_at < ${input.to}
        `.execute(this.db);
    const row = result.rows[0]!;
    const coveredHours = row.first_usage_at === null
      ? 0
      : Math.min(
          input.windowHours,
          Math.max(0, (input.to.getTime() - row.first_usage_at.getTime()) / HOUR_MS),
        );
    return {
      tokens: new Decimal(row.amount).toNumber(),
      dataPoints: Number(row.data_points),
      coveredHours,
    };
  }
}

function decimalOrNull(value: number | null): string | null {
  return value === null ? null : new Decimal(value).toDecimalPlaces(8).toFixed(8);
}
