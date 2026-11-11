import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";
import {
  computeForecast,
  FORECAST_CONFIDENCE,
  FORECAST_NOT_CALCULABLE_OFFICIAL_SOURCE_MISSING,
  FORECAST_NOT_CALCULABLE_OFFICIAL_BALANCE_EXPIRED,
  type WindowUsage,
} from "@qianliu/domain";

import type { Database } from "../kysely.js";
import { ProviderRepository } from "./provider-repository.js";
import { calculateQuotaPeriod, type CurrentProviderOperatingSnapshot } from "./provider-operating.js";

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

  /**
   * WP3/OAB-07（task 3.4）：
   * - API 模式余额预测仅消费官方来源（`source='PROVIDER_SYNC'`）且时效有效
   *   （collected_at 距 now ≤ expireMs）的快照；来源不合格（仅有 ADMIN/BILL
   *   手工快照）或时效过期 → 输出不可计算行（official_source_missing /
   *   official_balance_expired），`forecast_exhaust_at` 恒 null，不按旧值/手工值
   *   继续算确定耗尽时间。
   * - CODING_PLAN 套餐额度预测保持既有输入（套餐配置属 W5/W6 域，非官方余额）。
   * - expireMs 缺省镜像 P2 冻结默认值（30 分钟）；生产值由 worker 侧
   *   runSupplyForecastTick 按 readProviderOperatingBalanceExpireMs 注入。
   */
  async runTick(now: Date = new Date(), bucketMs: number = 60_000,
    expireMs: number = 1_800_000,
  ): Promise<SupplyForecastTickResult> {
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
      const [officialSnapshots, fullSnapshots, latestAnySnapshots, activePeriods] = await Promise.all([
        providerRepo.listCurrentOfficialOperatingSnapshots(enterpriseId, now),
        providerRepo.listCurrentOperatingSnapshots(enterpriseId, now),
        providerRepo.listLatestOperatingSnapshots(enterpriseId),
        this.db.selectFrom("provider_subscription_period")
          .distinctOn("provider_resource_id")
          .select(["provider_resource_id", "period_end_exclusive"])
          .where("enterprise_id", "=", enterpriseId)
          .where("reversed_by_event_id", "is", null)
          .where("period_start", "<=", now)
          .where("period_end_exclusive", ">", now)
          .orderBy("provider_resource_id").orderBy("period_start", "desc")
          .orderBy("created_at", "desc").orderBy("id", "desc").execute(),
      ]);
      // API 余额预测用官方来源 map；CP 套餐额度预测保持既有全来源 map（W5/W6 域）。
      const officialByResource = new Map(
        officialSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
      );
      const byResource = new Map(
        fullSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
      );
      // 来源不合格检测：存在任意来源快照但无官方来源（API 模式才判余额来源）。
      const anySnapshotByResource = new Map(
        latestAnySnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
      );
      const periodEndByResource = new Map(activePeriods.map((period) => [
        period.provider_resource_id, period.period_end_exclusive,
      ]));
      const insertNotCalculable = async (
        resourceId: string, mode: "API" | "CODING_PLAN", reason: string,
      ): Promise<void> => {
        const algorithmVersion = mode === "API"
          ? "pool-022-v1-api-cost"
          : "pool-022-v1-quota";
        const bucket = Math.floor(now.getTime() / bucketMs);
        const forecastKey = `${resourceId}:${bucket}:${algorithmVersion}`;
        const inserted = await this.db
          .insertInto("supply_forecast")
          .values({
            enterprise_id: enterpriseId,
            provider_resource_id: resourceId,
            rate_1h: null, rate_24h: null, rate_7d: null,
            forecast_exhaust_at: null, next_recover_at: null, coverage_hours: null,
            remaining_quota: null,
            confidence: FORECAST_CONFIDENCE.NOT_CALCULABLE,
            data_points: 0,
            not_calculable_reason: reason,
            algorithm_version: algorithmVersion,
            consumption_unit: mode === "API" ? "CURRENCY_PER_HOUR" : "QUOTA_PER_HOUR",
            forecast_key: forecastKey,
            snapshot_at: now,
          })
          .onConflict((conflict) => conflict.doNothing())
          .returning("id")
          .executeTakeFirst();
        if (inserted) snapshotsCreated += 1;
        else snapshotsSkipped += 1;
      };

      for (const resource of enterpriseResources) {
        // OAB-07 仅约束 API 模式余额预测（来源合格＋时效有效）；CODING_PLAN
        // 套餐额度预测保持既有输入与行为（套餐配置属 W5/W6 域）。
        let operating: CurrentProviderOperatingSnapshot | undefined;
        if (resource.mode === "API") {
          operating = officialByResource.get(resource.id);
          if (!operating) {
            // 来源不合格：存在任意来源快照但无官方来源 → 不再以 ADMIN 手工余额
            // 作为余额预测输入；无任何快照维持既有跳过行为。
            if (anySnapshotByResource.has(resource.id)) {
              await insertNotCalculable(resource.id, "API",
                FORECAST_NOT_CALCULABLE_OFFICIAL_SOURCE_MISSING);
            } else {
              snapshotsSkipped += 1;
            }
            continue;
          }
          // 时效有效：官方快照超过 P2 → 不可计算/待更新，无确定耗尽时间。
          if (now.getTime() - operating.collected_at.getTime() > expireMs) {
            await insertNotCalculable(resource.id, "API",
              FORECAST_NOT_CALCULABLE_OFFICIAL_BALANCE_EXPIRED);
            continue;
          }
        } else {
          operating = byResource.get(resource.id);
          if (!operating) {
            snapshotsSkipped += 1;
            continue;
          }
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
        const subscriptionEnd = resource.mode === "CODING_PLAN"
          ? periodEndByResource.get(resource.id) ?? operating.effective_until
          : null;
        const resourceExpiresAt = [resource.credential_expires_at, subscriptionEnd]
          .filter((value): value is Date => value !== null)
          .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
        const configuredNextReset = subscriptionEnd ?? operating.next_reset_at ?? calculateQuotaPeriod({
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
                 MIN(COALESCE(line.settled_at,line.created_at)) AS first_usage_at
            FROM ledger_line line
           WHERE line.enterprise_id = ${input.enterpriseId}
             AND line.provider_resource_id = ${input.resourceId}
             AND line.resource_mode = 'API'
             AND line.api_cost IS NOT NULL
             AND COALESCE(line.settled_at,line.created_at) >= ${input.from}
             AND COALESCE(line.settled_at,line.created_at) < ${input.to}
        `.execute(this.db)
      : await sql<UsageAggregate>`
          SELECT COALESCE(SUM(deducted_quota::numeric), 0)::text AS amount,
                 COUNT(*)::text AS data_points,
                 MIN(COALESCE(line.settled_at,line.created_at)) AS first_usage_at
            FROM ledger_line line
           WHERE line.enterprise_id = ${input.enterpriseId}
             AND line.provider_resource_id = ${input.resourceId}
             AND line.resource_mode = 'CODING_PLAN'
             AND line.deducted_quota IS NOT NULL
             AND COALESCE(line.settled_at,line.created_at) >= ${input.from}
             AND COALESCE(line.settled_at,line.created_at) < ${input.to}
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
