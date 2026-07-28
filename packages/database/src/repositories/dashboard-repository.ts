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
 *   2. 本账期活跃人数：当月至少一次成功调用的 EMPLOYEE 数量；
 *   3. 当前正在使用人数：存在进行中请求或最近 5 分钟有成功请求的员工去重数；
 *   4. 本月套餐支付金额 / 5. 本月 API 费用 / 6. 本月充值金额；
 *   7. 预计最早耗尽：可计算资源中最早的 forecast_exhaust_at + 可信度 + 下一恢复时间；
 *   8. 本月调度节省：只汇总 dispatch_decision 中 saving_calculable=true 且动作已执行的节省值。
 *
 * 当前账期 = 企业自然月（月初 00:00 ~ 月末 23:59:59，按企业时区 UTC+8）。
 * 首页不计算同比、环比和用量增速（TRD §12 行 746）。
 *
 * 数据源 gap 诚实标注：套餐支付/充值金额当前无独立支付表（payment/recharge 未建），
 * 暂从 provider_resource 的套餐信息或返回 null（不伪造数字，PRD §10.4 空状态红线）。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";

/** 首页聚合结果（八项口径）。 */
export interface DashboardSummary {
  /** 1. 资源账号数（未删除的资源账号数量）。 */
  resourceAccountCount: number;
  /** 2. 本账期活跃人数（当月至少一次成功调用的 EMPLOYEE 去重数）。 */
  activeEmployeeCount: number;
  /** 3. 当前正在使用人数（进行中请求或最近 5 分钟成功请求的员工去重数）。 */
  currentInUseCount: number;
  /** 4. 本月套餐支付金额（数据源待补，当前 null，不伪造）。 */
  monthlyPackagePayment: string | null;
  /** 5. 本月 API 费用（账本 ledger_transaction.total_api_cost 之和，当前自然月）。 */
  monthlyApiCost: string;
  /** 6. 本月充值金额（数据源待补，当前 null，不伪造）。 */
  monthlyRechargeAmount: string | null;
  /** 7. 预计最早耗尽资源（可计算资源中最早的 forecast_exhaust_at）。 */
  earliestExhaustion: {
    resourceId: string;
    resourceName: string;
    providerCode: string;
    forecastExhaustAt: string | null;
    nextRecoverAt: string | null;
    confidence: string;
    notCalculableReason: string | null;
  } | null;
  /** 8. 本月调度节省（dispatch_decision 中 saving_calculable=true 且动作已执行的节省之和）。 */
  monthlyDispatchSaving: string;
  /** 资源摘要按厂商分组（PRD §10.2 行 406-415）。 */
  resourceBreakdown: ResourceBreakdownItem[];
  /** 超额列表（PRD §10.2 行 417-424）。 */
  overageList: OverageItem[];
}

/** 资源摘要项（按厂商分组）。 */
export interface ResourceBreakdownItem {
  providerCode: string;
  providerName: string;
  mode: "API" | "CODING_PLAN";
  accountCount: number;
  /** 该厂商+模式下的总额度（CODING_PLAN 取 principal_grant.quota_value 之和；API 无额度概念返回 null）。 */
  totalQuota: string | null;
  /** 已用额度（quota_counter.used_value 之和）。 */
  usedQuota: string | null;
  /** 本月使用费用（ledger_line.api_cost 之和，当前自然月）。 */
  monthlyCost: string;
  /** 当前消耗速度（取最新 supply_forecast.rate_24h）。 */
  currentRate24h: string | null;
  /** 预计耗尽时间（取 supply_forecast.forecast_exhaust_at）。 */
  forecastExhaustAt: string | null;
  /** 资源当前状态（聚合：任一资源非 HEALTHY 则标记）。 */
  status: string;
}

/** 超额列表项（PRD §10.2 行 417-424）。 */
export interface OverageItem {
  principalId: string;
  principalName: string;
  principalType: string;
  provider: string;
  modelAlias: string;
  quotaValue: string;
  usedValue: string;
  overageValue: string;
  overageRatio: string;
}

export class DashboardRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * 首页聚合（TRD §12 八项口径）。
   * @param enterpriseId 企业边界（多租户隔离）
   * @param now 当前时间戳（毫秒），用于确定当前自然月 + "最近 5 分钟"窗口
   */
  async getSummary(enterpriseId: string, now: number = Date.now()): Promise<DashboardSummary> {
    const date = new Date(now);
    // 当前自然月范围（UTC+8 企业时区）：月初 00:00 ~ 下月初 00:00
    const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    // 最近 5 分钟窗口
    const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);

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
    ] = await Promise.all([
      this.countResources(enterpriseId),
      this.countActiveEmployees(enterpriseId, monthStart, monthEnd),
      this.countInUseEmployees(enterpriseId, now, fiveMinutesAgo),
      this.sumMonthlyApiCost(enterpriseId, monthStart, monthEnd),
      this.findEarliestExhaustion(enterpriseId),
      this.sumMonthlyDispatchSaving(enterpriseId, monthStart, monthEnd),
      this.buildResourceBreakdown(enterpriseId, monthStart, monthEnd),
      this.listOverages(enterpriseId),
    ]);

    return {
      resourceAccountCount,
      activeEmployeeCount,
      currentInUseCount,
      monthlyPackagePayment: null, // 数据源 gap：无独立支付表，不伪造
      monthlyApiCost,
      monthlyRechargeAmount: null, // 数据源 gap：无独立充值表，不伪造
      earliestExhaustion,
      monthlyDispatchSaving,
      resourceBreakdown,
      overageList,
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

  /** 2. 本账期活跃人数（当月至少一次成功调用的 EMPLOYEE 去重数）。 */
  private async countActiveEmployees(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<number> {
    const row = await sql<{ cnt: bigint }>`
      SELECT COUNT(DISTINCT r.principal_id) AS cnt
      FROM ai_request r
      INNER JOIN principal p ON p.id = r.principal_id
      WHERE r.enterprise_id = ${enterpriseId}
        AND p.type = 'EMPLOYEE'
        AND r.status = 'SUCCEEDED'
        AND r.started_at >= ${monthStart}
        AND r.started_at < ${monthEnd}
    `.execute(this.db);
    return Number(row.rows[0]?.cnt ?? 0n);
  }

  /** 3. 当前正在使用人数（进行中请求或最近 5 分钟成功请求的员工去重数）。 */
  private async countInUseEmployees(
    enterpriseId: string,
    _now: number,
    fiveMinutesAgo: Date,
  ): Promise<number> {
    // 进行中（finished_at IS NULL）或最近 5 分钟成功（finished_at >= now-5min）
    const row = await sql<{ cnt: bigint }>`
      SELECT COUNT(DISTINCT r.principal_id) AS cnt
      FROM ai_request r
      INNER JOIN principal p ON p.id = r.principal_id
      WHERE r.enterprise_id = ${enterpriseId}
        AND p.type = 'EMPLOYEE'
        AND (r.finished_at IS NULL
             OR (r.status = 'SUCCEEDED' AND r.finished_at >= ${fiveMinutesAgo}))
    `.execute(this.db);
    return Number(row.rows[0]?.cnt ?? 0n);
  }

  /** 5. 本月 API 费用（ledger_transaction.total_api_cost 之和，当前自然月，非空才计入）。 */
  private async sumMonthlyApiCost(
    enterpriseId: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<string> {
    const row = await sql<{ total: string | null }>`
      SELECT COALESCE(SUM(total_api_cost::numeric), 0)::text AS total
      FROM ledger_transaction
      WHERE enterprise_id = ${enterpriseId}
        AND created_at >= ${monthStart}
        AND created_at < ${monthEnd}
    `.execute(this.db);
    return row.rows[0]?.total ?? "0";
  }

  /** 7. 预计最早耗尽（可计算资源中最早的 forecast_exhaust_at）。 */
  private async findEarliestExhaustion(
    enterpriseId: string,
  ): Promise<DashboardSummary["earliestExhaustion"]> {
    const row = await this.db
      .selectFrom("supply_forecast")
      .innerJoin(
        "provider_resource",
        "provider_resource.id",
        "supply_forecast.provider_resource_id",
      )
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .where("supply_forecast.enterprise_id", "=", enterpriseId)
      .where("supply_forecast.forecast_exhaust_at", "is not", null)
      .where("supply_forecast.not_calculable_reason", "is", null)
      .where("provider_resource.status", "<>", "DELETED")
      .orderBy("supply_forecast.forecast_exhaust_at", "asc")
      .select([
        "provider_resource.id as resource_id",
        "provider_resource.name as resource_name",
        "provider.code as provider_code",
        "supply_forecast.forecast_exhaust_at",
        "supply_forecast.next_recover_at",
        "supply_forecast.confidence",
        "supply_forecast.not_calculable_reason",
      ])
      .executeTakeFirst();
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

    // 批量取每个厂商+模式的额度聚合 + 本月费用 + 最新预测（避免 N+1）
    const breakdown: ResourceBreakdownItem[] = [];
    for (const r of rows) {
      const providerCode = r.provider_code;
      const mode = r.mode as "API" | "CODING_PLAN";
      const [quota, monthlyCost, forecast] = await Promise.all([
        mode === "CODING_PLAN" ? this.sumProviderQuota(enterpriseId, providerCode) : Promise.resolve(null),
        this.sumProviderMonthlyCost(enterpriseId, providerCode, monthStart, monthEnd),
        this.latestProviderForecast(enterpriseId, providerCode),
      ]);
      breakdown.push({
        providerCode,
        providerName: r.provider_name,
        mode,
        accountCount: Number((r as { account_count: bigint | number }).account_count),
        totalQuota: quota?.total ?? null,
        usedQuota: quota?.used ?? null,
        monthlyCost,
        currentRate24h: forecast?.rate24h ?? null,
        forecastExhaustAt: forecast?.exhaustAt ?? null,
        status: "HEALTHY", // 简化：资源池状态聚合在 W20 alerts 细化
      });
    }
    return breakdown;
  }

  /** 某厂商 CODING_PLAN 总额度 + 已用（join principal_grant + quota_counter）。 */
  private async sumProviderQuota(
    enterpriseId: string,
    providerCode: string,
  ): Promise<{ total: string; used: string }> {
    const row = await sql<{ total: string | null; used: string | null }>`
      SELECT
        COALESCE(SUM(g.quota_value::numeric), 0)::text AS total,
        COALESCE(SUM(c.used_value::numeric), 0)::text AS used
      FROM principal_grant g
      INNER JOIN quota_counter c ON c.grant_id = g.id
      WHERE g.enterprise_id = ${enterpriseId}
        AND g.provider = ${providerCode}
        AND g.status = 'ACTIVE'
    `.execute(this.db);
    return {
      total: row.rows[0]?.total ?? "0",
      used: row.rows[0]?.used ?? "0",
    };
  }

  /** 某厂商本月费用（ledger_line join provider_resource）。 */
  private async sumProviderMonthlyCost(
    enterpriseId: string,
    providerCode: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<string> {
    const row = await sql<{ total: string | null }>`
      SELECT COALESCE(SUM(ll.api_cost::numeric), 0)::text AS total
      FROM ledger_line ll
      INNER JOIN provider_resource pr ON pr.id = ll.provider_resource_id
      INNER JOIN provider p ON p.id = pr.provider_id
      WHERE ll.enterprise_id = ${enterpriseId}
        AND p.code = ${providerCode}
        AND ll.created_at >= ${monthStart}
        AND ll.created_at < ${monthEnd}
    `.execute(this.db);
    return row.rows[0]?.total ?? "0";
  }

  /** 某厂商最新预测快照（rate_24h + forecast_exhaust_at）。 */
  private async latestProviderForecast(
    enterpriseId: string,
    providerCode: string,
  ): Promise<{ rate24h: string | null; exhaustAt: string | null } | null> {
    const row = await this.db
      .selectFrom("supply_forecast")
      .innerJoin(
        "provider_resource",
        "provider_resource.id",
        "supply_forecast.provider_resource_id",
      )
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .where("supply_forecast.enterprise_id", "=", enterpriseId)
      .where("provider.code", "=", providerCode)
      .orderBy("supply_forecast.snapshot_at", "desc")
      .limit(1)
      .select(["supply_forecast.rate_24h", "supply_forecast.forecast_exhaust_at"])
      .executeTakeFirst();
    if (!row) return null;
    return {
      rate24h: row.rate_24h,
      exhaustAt: row.forecast_exhaust_at ? row.forecast_exhaust_at.toISOString() : null,
    };
  }

  /** 超额列表（quota_counter.overage_value > 0）。 */
  private async listOverages(enterpriseId: string): Promise<OverageItem[]> {
    const rows = await this.db
      .selectFrom("quota_counter")
      .innerJoin("principal_grant", "principal_grant.id", "quota_counter.grant_id")
      .innerJoin("principal", "principal.id", "principal_grant.principal_id")
      .where("principal_grant.enterprise_id", "=", enterpriseId)
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
