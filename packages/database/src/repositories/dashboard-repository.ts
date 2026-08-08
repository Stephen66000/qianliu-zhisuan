/**
 * 首页看板聚合仓储（W18）—— 只读聚合，不在前端重算。
 *
 * 依据：PRD §10.2（首页看板核心指标）、TRD §12（首页口径，行 733-746）。
 *
 * 分层：
 *   - 本仓储：SQL 聚合查询（计数/求和/最早耗尽），口径在后端，前端只展示；
 *   - 前端：只读消费，不重算（M5 集成点约束，详细计划行 146）。
 *
 * 口径（TRD §12）：
 *   1. 资源账号数：当前企业未删除的资源账号数量；
 *   2. 本账期活跃人数：当月至少一次成功调用的、启用中（status=ACTIVE 且未归档）的 EMPLOYEE 数量；
 *   3. 当前正在使用人数：存在进行中请求或最近 5 分钟有成功请求的、启用中（status=ACTIVE 且未归档）的员工去重数；
 *   4. 本月套餐支付金额 / 5. 本月 API 费用 / 6. 本月充值金额；
 *   7. 预计最早耗尽：可计算资源中最早的 forecast_exhaust_at + 可信度 + 下一恢复时间；
 *   8. 本月调度节省：只汇总 dispatch_decision 中 saving_calculable=true 且动作已执行的节省值。
 *
 * 当前账期 = 企业自然月（月初 00:00 ~ 月末 23:59:59，按企业时区 UTC+8）。
 * 首页不计算同比、环比和用量增速（TRD §12 行 746）。
 *
 * POOL-010：厂商侧经营指标只取最新 provider_resource_operating_snapshot；
 * 主体 Grant/Counter 仅用于“已分配额度”，禁止冒充厂商购买额度。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import { ProviderRepository } from "./provider-repository.js";
import type { CurrentProviderOperatingSnapshot } from "./provider-operating.js";
import { worstResourceStatus, type ResourceStatus } from "@qianliu/domain";
import {
  decimalTextsEqual,
  getMonthlyTokenUsage,
  shanghaiNaturalMonth,
  sumDecimalTexts,
} from "./dashboard-helpers.js";
import type { DashboardSummary, OverageItem, ResourceBreakdownItem } from "./dashboard-types.js";

export type * from "./dashboard-types.js";

export class DashboardRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * 首页聚合（TRD §12 八项口径）。
   * @param enterpriseId 企业边界（多租户隔离）
   * @param now 当前时间戳（毫秒），用于确定当前自然月 + "最近 5 分钟"窗口
   */
  async getSummary(enterpriseId: string, now: number = Date.now()): Promise<DashboardSummary> {
    const date = new Date(now);
    const { start: monthStart, end: monthEnd } = shanghaiNaturalMonth(date);
    // 最近 5 分钟窗口
    const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);
    const currentOperatingSnapshots = await new ProviderRepository(this.db)
      .listCurrentOperatingSnapshots(enterpriseId, date);

    // 并行执行独立聚合查询
    const [
      resourceAccountCount,
      activeEmployeeCount,
      currentInUseCount,
      monthlyApiCost,
      earliestExhaustion,
      monthlyDispatchSaving,
      resourceBreakdown,
      overageList,
      monthlyTokenUsage,
    ] = await Promise.all([
      this.countResources(enterpriseId),
      this.countActiveEmployees(enterpriseId, monthStart, monthEnd),
      this.countInUseEmployees(enterpriseId, now, fiveMinutesAgo),
      this.sumMonthlyApiCost(enterpriseId, monthStart, monthEnd),
      this.findEarliestExhaustion(enterpriseId, currentOperatingSnapshots),
      this.sumMonthlyDispatchSaving(enterpriseId, monthStart, monthEnd),
      this.buildResourceBreakdown(
        enterpriseId,
        monthStart,
        monthEnd,
        currentOperatingSnapshots,
      ),
      this.listOverages(enterpriseId),
      getMonthlyTokenUsage(this.db, enterpriseId, monthStart, monthEnd),
    ]);

    return {
      resourceAccountCount,
      activeEmployeeCount,
      currentInUseCount,
      monthlyPackagePayment: await this.sumLatestSnapshotAmount(
        enterpriseId,
        "CODING_PLAN",
        "package_cost",
      ),
      monthlyApiCost,
      monthlyRechargeAmount: await this.sumLatestSnapshotAmount(
        enterpriseId,
        "API",
        "recharge_amount",
      ),
      earliestExhaustion,
      monthlyDispatchSaving,
      resourceBreakdown,
      overageList,
      monthlyTokenUsage,
    };
  }

  /** 1. 资源账号数（未删除的资源账号数量）。 */
  private async countResources(enterpriseId: string): Promise<number> {
    const row = await this.db
      .selectFrom("provider_resource")
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "<>", "DELETED")
      .select((eb) => eb.fn.countAll().as("cnt"))
      .executeTakeFirstOrThrow();
    return Number((row as { cnt: bigint | number }).cnt);
  }

  /** 2. 本账期活跃人数（当月至少一次成功调用的、启用中且未归档的 EMPLOYEE 去重数）。 */
  private async countActiveEmployees(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<number> {
    // 仅统计启用中（status=ACTIVE）且未归档的员工，与超额列表口径一致；
    // 归档/停用主体（如 POOL-008/009 验收遗留）不计入，避免首页人数虚高。
    const row = await sql<{ cnt: bigint }>`
      SELECT COUNT(DISTINCT r.principal_id) AS cnt
      FROM ai_request r
      INNER JOIN principal p ON p.id = r.principal_id
      WHERE r.enterprise_id = ${enterpriseId}
        AND p.type = 'EMPLOYEE'
        AND p.status = 'ACTIVE'
        AND p.archived_at IS NULL
        AND r.status = 'SUCCEEDED'
        AND r.started_at >= ${monthStart}
        AND r.started_at < ${monthEnd}
    `.execute(this.db);
    return Number(row.rows[0]?.cnt ?? 0n);
  }

  /** 3. 当前正在使用人数（进行中请求或最近 5 分钟成功请求的、启用中且未归档的员工去重数）。 */
  private async countInUseEmployees(
    enterpriseId: string,
    _now: number,
    fiveMinutesAgo: Date,
  ): Promise<number> {
    // 进行中（finished_at IS NULL）或最近 5 分钟成功（finished_at >= now-5min）；
    // 仅统计启用中（status=ACTIVE）且未归档的员工，与活跃人数口径一致。
    const row = await sql<{ cnt: bigint }>`
      SELECT COUNT(DISTINCT r.principal_id) AS cnt
      FROM ai_request r
      INNER JOIN principal p ON p.id = r.principal_id
      WHERE r.enterprise_id = ${enterpriseId}
        AND p.type = 'EMPLOYEE'
        AND p.status = 'ACTIVE'
        AND p.archived_at IS NULL
        AND (r.finished_at IS NULL
             OR (r.status = 'SUCCEEDED' AND r.finished_at >= ${fiveMinutesAgo}))
    `.execute(this.db);
    return Number(row.rows[0]?.cnt ?? 0n);
  }

  /** 5. 本月 API 调用费用：仅 API 资源的实际账本明细，套餐异常金额也不计入。 */
  private async sumMonthlyApiCost(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<string> {
    const row = await sql<{ total: string | null }>`
      SELECT COALESCE(SUM(ll.api_cost::numeric), 0)::text AS total
        FROM ledger_line ll
        JOIN provider_resource pr
          ON pr.id = ll.provider_resource_id AND pr.enterprise_id = ${enterpriseId}
       WHERE ll.enterprise_id = ${enterpriseId}
         AND ll.resource_mode = 'API'
         AND pr.mode = 'API'
         AND ll.api_cost IS NOT NULL
         AND ll.created_at >= ${monthStart}
         AND ll.created_at < ${monthEnd}
    `.execute(this.db);
    return row.rows[0]?.total ?? "0";
  }

  /** 7. 预计最早耗尽（可计算资源中最早的 forecast_exhaust_at）。 */
  private async findEarliestExhaustion(
    enterpriseId: string,
    currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
  ): Promise<DashboardSummary["earliestExhaustion"]> {
    const result = await sql<{
      resource_id: string;
      resource_name: string;
      provider_code: string;
      forecast_exhaust_at: Date | null;
      next_recover_at: Date | null;
      confidence: string;
      not_calculable_reason: string | null;
      mode: string;
      remaining_quota: string;
      snapshot_at: Date;
    }>`
      WITH latest_forecast AS (
        SELECT DISTINCT ON (provider_resource_id) *
          FROM supply_forecast
         WHERE enterprise_id = ${enterpriseId}
         ORDER BY provider_resource_id, snapshot_at DESC
      )
      SELECT pr.id AS resource_id, pr.name AS resource_name, p.code AS provider_code,
             f.forecast_exhaust_at, f.next_recover_at, f.confidence,
             f.not_calculable_reason, pr.mode, f.remaining_quota, f.snapshot_at
        FROM latest_forecast f
        JOIN provider_resource pr ON pr.id = f.provider_resource_id
        JOIN provider p ON p.id = pr.provider_id
       WHERE f.forecast_exhaust_at IS NOT NULL
         AND f.not_calculable_reason IS NULL
         AND pr.status <> 'DELETED'
    `.execute(this.db);
    const current = new Map(
      currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
    );
    const row = result.rows
      .filter((forecast) => {
        const snapshot = current.get(forecast.resource_id);
        const remaining = forecast.mode === "API"
          ? snapshot?.current_balance ?? null
          : snapshot?.remaining_quota ?? null;
        return snapshot !== undefined &&
          forecast.snapshot_at >= snapshot.calculated_at &&
          decimalTextsEqual(forecast.remaining_quota, remaining);
      })
      .sort((left, right) =>
        left.forecast_exhaust_at!.getTime() - right.forecast_exhaust_at!.getTime(),
      )[0];
    if (!row) return null;
    return {
      resourceId: row.resource_id,
      resourceName: row.resource_name,
      providerCode: row.provider_code,
      forecastExhaustAt: row.forecast_exhaust_at ? row.forecast_exhaust_at.toISOString() : null,
      nextRecoverAt: row.next_recover_at ? row.next_recover_at.toISOString() : null,
      confidence: row.confidence,
      notCalculableReason: row.not_calculable_reason,
    };
  }

  /** 8. 本月调度节省（saving_calculable=true 且动作已执行的 dispatch_saving 之和）。 */
  private async sumMonthlyDispatchSaving(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<string> {
    const row = await sql<{ total: string | null }>`
      SELECT COALESCE(SUM(dispatch_saving::numeric), 0)::text AS total
      FROM dispatch_decision
      WHERE enterprise_id = ${enterpriseId}
        AND final_action = 'SWITCH'
        AND saving_calculable = true
        AND dispatch_saving IS NOT NULL
        AND decided_at >= ${monthStart}
        AND decided_at < ${monthEnd}
    `.execute(this.db);
    return row.rows[0]?.total ?? "0";
  }

  /** 资源摘要按厂商+模式分组（PRD §10.2 行 406-415）。 */
  private async buildResourceBreakdown(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
    currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
  ): Promise<ResourceBreakdownItem[]> {
    // 厂商+模式维度的账号数 + 本月费用 + 最新预测
    const rows = await this.db
      .selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider_resource.status", "<>", "DELETED")
      .groupBy([
        "provider.code",
        "provider.name",
        "provider_resource.mode",
      ])
      .select([
        "provider.code as provider_code",
        "provider.name as provider_name",
        "provider_resource.mode",
        (eb) => eb.fn.countAll().as("account_count"),
      ])
      .execute();
    const statusRows = await this.db
      .selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "provider_resource.id as resource_id",
        "provider_resource.name as resource_name",
        "provider_resource.mode",
        "provider_resource.status",
        "provider.code as provider_code",
      ])
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider.enterprise_id", "=", enterpriseId)
      .where("provider_resource.status", "<>", "DELETED")
      .execute();

    // 批量取每个厂商+模式的额度聚合 + 本月费用 + 最新预测（避免 N+1）
    const breakdown: ResourceBreakdownItem[] = [];
    for (const r of rows) {
      const providerCode = r.provider_code;
      const mode = r.mode as "API" | "CODING_PLAN";
      const groupStatuses = statusRows.filter((row) =>
        row.provider_code === providerCode && row.mode === mode
      );
      const worstStatus = worstResourceStatus(
        groupStatuses.map((row) => row.status as ResourceStatus),
      );
      const statusCounts = groupStatuses.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        return counts;
      }, {});
      const [operating, allocatedQuota, monthlyCost, forecast] = await Promise.all([
        this.sumProviderOperatingSnapshot(
          enterpriseId,
          providerCode,
          mode,
          currentOperatingSnapshots,
        ),
        this.sumAllocatedQuota(enterpriseId, providerCode, mode),
        this.sumProviderMonthlyCost(enterpriseId, providerCode, mode, monthStart, monthEnd),
        this.latestProviderForecast(
          enterpriseId,
          providerCode,
          mode,
          currentOperatingSnapshots,
        ),
      ]);
      breakdown.push({
        providerCode,
        providerName: r.provider_name,
        mode,
        accountCount: Number((r as { account_count: bigint | number }).account_count),
        totalQuota: operating.total,
        usedQuota: operating.used,
        remainingQuota: operating.remaining,
        quotaUnit: operating.quotaUnit,
        allocatedQuota,
        currency: operating.currency,
        rechargeAmount: operating.recharge,
        currentBalance: operating.balance,
        currentPeriodCost: operating.periodCost,
        snapshotAt: operating.snapshotAt,
        monthlyCost,
        currentRate24h: forecast?.rate24h ?? null,
        currentRateUnit: forecast?.unit ?? null,
        forecastConfidence: forecast?.confidence ?? null,
        forecastNotCalculableReason: forecast?.reason ?? null,
        forecastDataPoints: forecast?.dataPoints ?? null,
        forecastExhaustAt: forecast?.exhaustAt ?? null,
        status: worstStatus === "ACTIVE" ? "HEALTHY" : worstStatus,
        statusCounts,
        abnormalResources: groupStatuses
          .filter((row) => row.status !== "ACTIVE")
          .map((row) => ({
            resourceId: row.resource_id,
            resourceName: row.resource_name,
            status: row.status,
          })),
      });
    }
    return breakdown;
  }

  /** 主体已分配额度：仅作为独立列，不参与厂商总额/余量/预测。 */
  private async sumAllocatedQuota(
    enterpriseId: string,
    providerCode: string,
    mode: "API" | "CODING_PLAN",
  ): Promise<string | null> {
    // Grant 当前只绑定厂商/统一模型，无法可靠拆到具体资源；额度门禁仅用于套餐模式。
    if (mode !== "CODING_PLAN") return null;
    const row = await sql<{ total: string | null }>`
      SELECT SUM(g.quota_value::numeric)::text AS total
      FROM principal_grant g
      WHERE g.enterprise_id = ${enterpriseId}
        AND g.provider = ${providerCode}
        AND g.status = 'ACTIVE'
    `.execute(this.db);
    return row.rows[0]?.total ?? null;
  }

  /** 最新厂商资源快照聚合；缺值或单位不一致时相应指标返回 null。 */
  private async sumProviderOperatingSnapshot(
    enterpriseId: string,
    providerCode: string,
    mode: "API" | "CODING_PLAN",
    currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
  ): Promise<{
    total: string | null;
    used: string | null;
    remaining: string | null;
    quotaUnit: string | null;
    currency: string | null;
    recharge: string | null;
    balance: string | null;
    periodCost: string | null;
    snapshotAt: string | null;
  }> {
    const resources = await this.db
      .selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select("provider_resource.id")
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider.code", "=", providerCode)
      .where("provider_resource.mode", "=", mode)
      .where("provider_resource.status", "<>", "DELETED")
      .execute();
    const resourceIds = new Set(resources.map((resource) => resource.id));
    const snapshots = currentOperatingSnapshots
      .filter((snapshot) => resourceIds.has(snapshot.provider_resource_id));
    const complete = resourceIds.size > 0 && snapshots.length === resourceIds.size;
    const values = (key: "total_quota" | "used_quota" | "remaining_quota" |
      "recharge_amount" | "current_balance" | "current_period_cost") =>
      snapshots.map((snapshot) => snapshot[key]).filter((value): value is string => value !== null);
    const quotaUnits = new Set(snapshots.map((snapshot) => snapshot.quota_unit).filter(Boolean));
    const currencies = new Set(snapshots.map((snapshot) => snapshot.currency).filter(Boolean));
    const allHave = (key: Parameters<typeof values>[0]) =>
      complete && values(key).length === resourceIds.size;
    const sameQuotaUnit = complete && quotaUnits.size === 1;
    const sameCurrency = complete && currencies.size === 1 &&
      snapshots.every((snapshot) => snapshot.currency !== null);
    const quotaMode = mode === "CODING_PLAN";
    const amountMode = mode === "API";
    const latestCalculatedAt = snapshots.reduce<Date | null>(
      (latest, snapshot) => !latest || snapshot.calculated_at > latest
        ? snapshot.calculated_at
        : latest,
      null,
    );
    return {
      total: quotaMode && sameQuotaUnit && allHave("total_quota")
        ? sumDecimalTexts(values("total_quota")) : null,
      used: quotaMode && sameQuotaUnit && allHave("used_quota")
        ? sumDecimalTexts(values("used_quota")) : null,
      remaining: quotaMode && sameQuotaUnit && allHave("remaining_quota")
        ? sumDecimalTexts(values("remaining_quota")) : null,
      quotaUnit: quotaMode && sameQuotaUnit ? [...quotaUnits][0] ?? null : null,
      currency: amountMode && sameCurrency ? [...currencies][0] ?? null : null,
      recharge: amountMode && sameCurrency && allHave("recharge_amount")
        ? sumDecimalTexts(values("recharge_amount")) : null,
      balance: amountMode && sameCurrency && allHave("current_balance")
        ? sumDecimalTexts(values("current_balance")) : null,
      periodCost:
        amountMode && sameCurrency && allHave("current_period_cost")
          ? sumDecimalTexts(values("current_period_cost")) : null,
      snapshotAt: latestCalculatedAt?.toISOString() ?? null,
    };
  }

  private async sumLatestSnapshotAmount(
    enterpriseId: string,
    mode: "API" | "CODING_PLAN",
    field: "recharge_amount" | "package_cost",
  ): Promise<string | null> {
    const column = field === "recharge_amount"
      ? sql.ref("latest.recharge_amount")
      : sql.ref("latest.package_cost");
    const result = await sql<{
      resource_count: string;
      snapshot_count: string;
      value_count: string;
      total: string | null;
      currencies: string;
      currency_count: string;
    }>`
      WITH resources AS (
        SELECT id
          FROM provider_resource
         WHERE enterprise_id = ${enterpriseId}
           AND mode = ${mode}
           AND status <> 'DELETED'
      ), latest AS (
        SELECT DISTINCT ON (s.provider_resource_id) s.*
          FROM provider_resource_operating_snapshot s
          JOIN resources r ON r.id = s.provider_resource_id
         WHERE s.enterprise_id = ${enterpriseId}
         ORDER BY s.provider_resource_id, s.version DESC
      )
      SELECT (SELECT COUNT(*) FROM resources)::text AS resource_count,
             COUNT(*)::text AS snapshot_count,
             COUNT(${column})::text AS value_count,
             SUM(${column})::text AS total,
             COUNT(DISTINCT currency)::text AS currencies,
             COUNT(currency)::text AS currency_count
        FROM latest
    `.execute(this.db);
    const row = result.rows[0];
    const complete =
      row &&
      row.resource_count !== "0" &&
      row.snapshot_count === row.resource_count &&
      row.value_count === row.resource_count &&
      row.currency_count === row.resource_count &&
      row.currencies === "1";
    return complete ? row.total : null;
  }

  /** 某厂商本月 API 调用费用；套餐行固定为 0，套餐费用由经营快照单列。 */
  private async sumProviderMonthlyCost(
    enterpriseId: string,
    providerCode: string,
    mode: "API" | "CODING_PLAN",
    monthStart: Date,
    monthEnd: Date,
  ): Promise<string> {
    if (mode !== "API") return "0";
    const row = await sql<{ total: string | null }>`
      SELECT COALESCE(SUM(ll.api_cost::numeric), 0)::text AS total
      FROM ledger_line ll
      INNER JOIN provider_resource pr ON pr.id = ll.provider_resource_id
      INNER JOIN provider p ON p.id = pr.provider_id
      WHERE ll.enterprise_id = ${enterpriseId}
        AND pr.enterprise_id = ${enterpriseId}
        AND p.enterprise_id = ${enterpriseId}
        AND p.code = ${providerCode}
        AND ll.resource_mode = 'API'
        AND pr.mode = 'API'
        AND ll.created_at >= ${monthStart}
        AND ll.created_at < ${monthEnd}
    `.execute(this.db);
    return row.rows[0]?.total ?? "0";
  }

  /** 某厂商最新预测快照（rate_24h + forecast_exhaust_at）。 */
  private async latestProviderForecast(
    enterpriseId: string,
    providerCode: string,
    mode: "API" | "CODING_PLAN",
    currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
  ): Promise<{
    rate24h: string | null;
    exhaustAt: string | null;
    unit: "CURRENCY_PER_HOUR" | "QUOTA_PER_HOUR" | null;
    confidence: string;
    reason: string | null;
    dataPoints: number;
  } | null> {
    const result = await sql<{
      resource_id: string;
      rate_24h: string | null;
      forecast_exhaust_at: Date | null;
      remaining_quota: string;
      snapshot_at: Date;
      consumption_unit: "CURRENCY_PER_HOUR" | "QUOTA_PER_HOUR" | null;
      confidence: string;
      not_calculable_reason: string | null;
      data_points: number;
    }>`
      WITH latest_forecast AS (
        SELECT DISTINCT ON (provider_resource_id) *
          FROM supply_forecast
         WHERE enterprise_id = ${enterpriseId}
         ORDER BY provider_resource_id, snapshot_at DESC
      )
      SELECT f.provider_resource_id AS resource_id, f.rate_24h,
             f.forecast_exhaust_at, f.remaining_quota, f.snapshot_at,
             f.consumption_unit, f.confidence, f.not_calculable_reason, f.data_points
        FROM latest_forecast f
        JOIN provider_resource pr ON pr.id = f.provider_resource_id
        JOIN provider p ON p.id = pr.provider_id
       WHERE p.code = ${providerCode}
         AND pr.enterprise_id = ${enterpriseId}
         AND p.enterprise_id = ${enterpriseId}
         AND pr.mode = ${mode} AND pr.status <> 'DELETED'
    `.execute(this.db);
    const current = new Map(
      currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
    );
    const row = result.rows
      .filter((forecast) => {
        const snapshot = current.get(forecast.resource_id);
        const remaining = mode === "API"
          ? snapshot?.current_balance ?? null
          : snapshot?.remaining_quota ?? null;
        return snapshot !== undefined &&
          forecast.snapshot_at >= snapshot.calculated_at &&
          decimalTextsEqual(forecast.remaining_quota, remaining);
      })
      .sort((left, right) => {
        if (!left.forecast_exhaust_at) return 1;
        if (!right.forecast_exhaust_at) return -1;
        return left.forecast_exhaust_at.getTime() - right.forecast_exhaust_at.getTime();
      })[0];
    if (!row) return null;
    return {
      rate24h: row.rate_24h,
      exhaustAt: row.forecast_exhaust_at ? row.forecast_exhaust_at.toISOString() : null,
      unit: row.consumption_unit,
      confidence: row.confidence,
      reason: row.not_calculable_reason,
      dataPoints: row.data_points,
    };
  }

  /** 超额列表（quota_counter.overage_value > 0）。 */
  private async listOverages(enterpriseId: string): Promise<OverageItem[]> {
    const rows = await this.db
      .selectFrom("quota_counter")
      .innerJoin("principal_grant", "principal_grant.id", "quota_counter.grant_id")
      .innerJoin("principal", "principal.id", "principal_grant.principal_id")
      .where("principal_grant.enterprise_id", "=", enterpriseId)
      .where("principal_grant.status", "=", "ACTIVE")
      .where("principal.status", "=", "ACTIVE")
      .where("principal.archived_at", "is", null)
      .where("quota_counter.overage_value", ">", 0n)
      .orderBy("quota_counter.overage_value", "desc")
      .select([
        "principal.id as principal_id",
        "principal.name as principal_name",
        "principal.type as principal_type",
        "principal_grant.provider",
        "principal_grant.model_alias",
        "principal_grant.quota_value",
        "quota_counter.used_value",
        "quota_counter.overage_value",
      ])
      .execute();
    return rows.map((r) => {
      const quota = BigInt(r.quota_value);
      const used = BigInt(r.used_value);
      const overage = BigInt(r.overage_value);
      return {
        principalId: r.principal_id,
        principalName: r.principal_name,
        principalType: r.principal_type,
        provider: r.provider,
        modelAlias: r.model_alias,
        quotaValue: quota.toString(),
        usedValue: used.toString(),
        overageValue: overage.toString(),
        // 超额比例 = overage / quota，保留 4 位小数（decimal.js 在前端展示层格式化）
        overageRatio: quota > 0n ? (Number(overage * 10000n / quota) / 10000).toString() : "0",
      };
    });
  }
}
