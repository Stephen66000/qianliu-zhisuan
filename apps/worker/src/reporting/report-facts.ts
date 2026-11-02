import { sql, type Kysely } from "kysely";
import { UsageOverviewRepository, readQuotaPeriodsInTransaction, type Database, type UsageOverviewPeriod } from "@qianliu/database";
import { employeeQuotaBalance, employeeQuotaMonth } from "@qianliu/domain";
import { formatTokenVolume } from "./format-utils.js";
import { queryModelUsageForRange } from "./model-facts.js";

export interface ReportQuotaRow { provider: string; basis: string; detail: string }
export interface ReportQuotaView {
  scopeLabel: string; statusLabel: string; policyLabel: string; asOfLabel: string; periodKey: string;
  rows: ReportQuotaRow[];
}

/** The quota month is the month containing the final instant of the report, never its first day. */
export function reportQuotaCutoff(endExclusive: Date, timezone: string) {
  const instant = new Date(endExclusive.getTime() - 1);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const value = (key: string) => parts.find(part => part.type === key)!.value;
  return { periodKey: `${value("year")}-${value("month")}`, asOfLabel: `截至${Number(value("month"))}月${Number(value("day"))}日` };
}

export type EmployeeReportFacts = Awaited<ReturnType<typeof readEmployeeReportFacts>>;

/** All business reads share one read-only MVCC snapshot; delivery consumes only the returned values. */
export async function readEmployeeReportFacts(db: Kysely<Database>, input: {
  enterpriseId: string; period: UsageOverviewPeriod; timezone: string; anchor: Date; now?: Date;
}) {
  return db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const generatedAt = input.now ?? new Date();
    const overview = await new UsageOverviewRepository(trx, () => generatedAt).getOverviewSnapshot({ ...input, subjectType: "EMPLOYEE" });
    const start = new Date(overview.range.from);
    const end = new Date(overview.range.to);
    const models = await queryModelUsageForRange(trx, input.enterpriseId, start, end, undefined, 3, true);
    const cutoff = reportQuotaCutoff(end, input.timezone);
    // A legacy cumulative counter cannot prove a month-end balance or its historical unit.
    const grants = await trx.selectFrom("principal_grant as g")
      .innerJoin("principal as p", join => join.onRef("p.id", "=", "g.principal_id").onRef("p.enterprise_id", "=", "g.enterprise_id"))
      .select(["g.principal_id", "g.provider", "g.quota_value", "g.updated_at", "g.status", "g.valid_until"])
      .where("g.enterprise_id", "=", input.enterpriseId).where("p.type", "=", "EMPLOYEE")
      .where("g.created_at", "<", end).where("g.valid_from", "<", end).execute();
    // Reuse the established month-end allocation cutoff; include employees without activity.
    const companyMonthlyAllocation = input.period !== "MONTH" || grants.some(grant => grant.updated_at >= end)
      ? null : grants.filter(grant => grant.status === "ACTIVE" && (grant.valid_until === null || grant.valid_until >= end))
        .reduce((sum, grant) => sum + BigInt(grant.quota_value), 0n).toString();
    const monthlySchema = await sql<{ present: boolean }>`SELECT to_regclass('principal_quota_period') IS NOT NULL AS present`.execute(trx);
    const periods = monthlySchema.rows[0]?.present
      ? await readQuotaPeriodsInTransaction(trx, { enterpriseId: input.enterpriseId, periodKey: cutoff.periodKey, asOf: end }) : [];
    const quotaMonth = employeeQuotaMonth(new Date(end.getTime() - 1), input.timezone);
    const legacyUsage = await trx.selectFrom("ledger_line as l")
      .innerJoin("principal as p", join => join.onRef("p.id", "=", "l.principal_id").onRef("p.enterprise_id", "=", "l.enterprise_id"))
      .innerJoin("provider_resource as r", join => join.onRef("r.id", "=", "l.provider_resource_id").onRef("r.enterprise_id", "=", "l.enterprise_id"))
      .innerJoin("provider as v", join => join.onRef("v.id", "=", "r.provider_id").onRef("v.enterprise_id", "=", "l.enterprise_id"))
      .select(["l.principal_id", "v.code as provider", "l.resource_mode", sql<string>`sum(l.raw_input_tokens + l.raw_output_tokens)::text`.as("raw_tokens"),
        sql<string | null>`CASE WHEN count(*) FILTER (WHERE l.deducted_quota IS NULL) > 0 THEN NULL ELSE sum(l.deducted_quota)::text END`.as("plan_quota")])
      .where("l.enterprise_id", "=", input.enterpriseId).where("p.type", "=", "EMPLOYEE")
      .where("l.settled_at", ">=", quotaMonth.periodStart).where("l.settled_at", "<", end)
      .groupBy(["l.principal_id", "v.code", "l.resource_mode"]).execute();
    const quotaForPrincipal = (principalId?: string): ReportQuotaView => {
      const scoped = grants.filter(grant => (!principalId || grant.principal_id === principalId)
        && (grant.updated_at >= end || (grant.status === "ACTIVE" && (grant.valid_until === null || grant.valid_until >= end))));
      const monthly = periods.filter(period => !principalId || period.principal_id === principalId);
      const historical = legacyUsage.filter(usage => !principalId || usage.principal_id === principalId);
      const providers = [...new Set([...scoped.map(grant => grant.provider), ...monthly.map(period => period.provider), ...historical.map(usage => usage.provider)])];
      const policyKnown = monthly.length > 0 && monthly.every(period => period.quality === "COMPLETE")
        && scoped.every(grant => monthly.some(period => period.principal_id === grant.principal_id && period.provider === grant.provider));
      const allowed = monthly.filter(period => period.allow_overage).length;
      const policyLabel = !policyKnown ? monthly.length ? "策略待核" : "历史策略待核" : allowed === monthly.length ? "全部允许" : allowed === 0 ? "全部禁止" : "部分允许";
      let unknown = 0;
      let overageCount = 0;
      const rows = providers.flatMap(provider => {
        const providerPeriods = monthly.filter(period => period.provider === provider);
        if (!providerPeriods.length) {
          unknown++;
          const proven = historical.filter(usage => usage.provider === provider);
          if (!proven.length) return [{ provider, basis: "历史单位待核", detail: "历史额度未留存 / 余额待核账" }];
          return [...new Set(proven.map(usage => usage.resource_mode))].map(mode => {
            const entries = proven.filter(usage => usage.resource_mode === mode);
            const values = entries.map(usage => mode === "API" ? usage.raw_tokens : usage.plan_quota);
            const used = values.some(value => value === null) ? null : values.reduce<bigint>((sum, value) => sum + BigInt(value!), 0n);
            return { provider, basis: mode === "API" ? "实际 Token" : "套餐折算额度",
              detail: `结算期间已证使用 ${used === null ? "待核" : formatTokenVolume(Number(used))} · 历史余额待核账` };
          });
        }
        return [...new Set(providerPeriods.map(period => period.quota_basis))].map(basis => {
          const entries = providerPeriods.filter(period => period.quota_basis === basis);
          const limit = entries.reduce((sum, period) => sum + BigInt(period.limit_value), 0n);
          const used = entries.reduce((sum, period) => sum + BigInt(period.used_value), 0n);
          const reserved = entries.reduce((sum, period) => sum + BigInt(period.reserved_value), 0n);
          // Sum confirmed per-employee overage, never offset one employee's overage against another's available quota.
          const balances = entries.map(period => employeeQuotaBalance(BigInt(period.limit_value), BigInt(period.used_value), BigInt(period.reserved_value)));
          const overage = balances.reduce((sum, balance) => sum + balance.overage, 0n);
          const available = balances.reduce((sum, balance) => sum + balance.available, 0n);
          const incomplete = entries.some(period => period.quality !== "COMPLETE") || reserved > 0n
            || scoped.some(grant => grant.provider === provider && !entries.some(period => period.principal_id === grant.principal_id));
          if (incomplete) unknown++;
          if (!incomplete && overage > 0n) overageCount++;
          const volume = (value: bigint) => formatTokenVolume(Number(value));
          return { provider, basis: basis === "RAW_TOKEN" ? "实际 Token" : "套餐折算额度",
            detail: incomplete ? `已证使用 ${volume(used)} · 预占 ${volume(reserved)} · 余额待核 / 暂定`
              : `分配 ${volume(limit)} · 已用 ${volume(used)} · ${overage > 0n ? `超额 ${volume(overage)}` : `可用 ${volume(available)}`}` };
        });
      });
      return { ...cutoff, scopeLabel: `${providers.length}个厂商池`,
        statusLabel: monthly.length ? `${overageCount}项超额，${unknown}项待核` : "历史余额待核账", policyLabel, rows };
    };
    const personal = new Map<string, { model?: string; latest: Date | null }>();
    for (const person of input.period === "TODAY" ? [] : overview.ranking) {
      const usage = await queryModelUsageForRange(trx, input.enterpriseId, start, end, person.subjectId, 1, true);
      const latest = await trx.selectFrom("ledger_transaction as lt")
        .innerJoin("ai_request as ar", join => join.onRef("ar.id", "=", "lt.ai_request_id").onRef("ar.enterprise_id", "=", "lt.enterprise_id"))
        .select("ar.started_at").where("lt.enterprise_id", "=", input.enterpriseId)
        .where("lt.principal_id", "=", person.subjectId).where("lt.status", "=", "SETTLED").where("ar.status", "=", "SUCCEEDED")
        .where("lt.created_at", ">=", start).where("lt.created_at", "<", end).orderBy("ar.started_at", "desc").limit(1).executeTakeFirst();
      personal.set(person.subjectId, { model: usage.models[0]?.model, latest: latest?.started_at ?? null });
    }
    return { factVersion: "employee-report-v2", generatedAt: generatedAt.toISOString(), scope: { type: "EMPLOYEE" as const, enterpriseId: input.enterpriseId },
      snapshotMetadata: { factVersion: "employee-report-v2", generatedAt: generatedAt.toISOString(), scope: "EMPLOYEE" as const,
        timezone: input.timezone, quotaPeriodKey: cutoff.periodKey, quotaAsOf: end.toISOString(), provenance: "repeatable-read;activity=settled-successful-employee;quota=attempt-reservation-month" },
      overview, models, companyMonthlyAllocation, quota: quotaForPrincipal(), quotaForPrincipal, personal, provenance: "repeatable-read;activity=settled-successful-employee;quota=attempt-reservation-month" };
  });
}
