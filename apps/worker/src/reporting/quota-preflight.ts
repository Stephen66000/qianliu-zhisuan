import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { EmployeeModelRuleRepository, type Database } from "@qianliu/database";
import { employeeQuotaMonth } from "@qianliu/domain";

/** Configuration-only switch preview. No initializer, live model request, credential read or write. */
export async function readQuotaSwitchPreflight(db: Kysely<Database>, input: { enterpriseId: string; month: string; now?: Date }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new Error("preflight month must be YYYY-MM");
  const now = input.now ?? new Date();
  const enterprise = await db.selectFrom("enterprise").select(["id", "timezone"]).where("id", "=", input.enterpriseId).executeTakeFirstOrThrow();
  const period = employeeQuotaMonth(new Date(`${input.month}-15T12:00:00Z`), enterprise.timezone);
  const earliest = employeeQuotaMonth(employeeQuotaMonth(now, enterprise.timezone).periodEnd, enterprise.timezone);
  const schema = await sql<{ present: boolean }>`SELECT to_regclass('principal_quota_period') IS NOT NULL AS present`.execute(db);
  const configured = schema.rows[0]?.present ? await db.selectFrom("enterprise").select("employee_quota_monthly_from").where("id", "=", input.enterpriseId).executeTakeFirst() : null;
  const basis = schema.rows[0]?.present ? sql<string | null>`g.quota_basis` : sql<string | null>`NULL::text`;
  const grants = await db.selectFrom("principal_grant as g")
    .innerJoin("principal as p", join => join.onRef("p.id", "=", "g.principal_id").onRef("p.enterprise_id", "=", "g.enterprise_id"))
    .leftJoin("quota_counter as c", "c.grant_id", "g.id")
    .select(["g.id", "g.principal_id", "g.provider", "g.pool_model_alias", "g.model_alias", "g.allow_overage", "g.quota_value", "g.valid_until",
      "c.period_anchor", "c.next_reset_at", "c.used_value", basis.as("quota_basis")])
    .where("g.enterprise_id", "=", input.enterpriseId).where("p.type", "=", "EMPLOYEE").where("p.status", "=", "ACTIVE").where("p.archived_at", "is", null)
    .where("g.status", "=", "ACTIVE").where("g.valid_from", "<=", now)
    .where(eb => eb.or([eb("g.valid_until", "is", null), eb("g.valid_until", ">", now)]))
    .orderBy("g.principal_id").orderBy("g.provider").orderBy("g.id").execute();
  const keys = await db.selectFrom("principal_key").select(["principal_id", "allowed_model_ids"])
    .where("enterprise_id", "=", input.enterpriseId).where("status", "=", "ACTIVE")
    .where(eb => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)])).execute();
  const disabled = await db.selectFrom("principal_provider_disabled_model").select(["principal_id", "provider", "unified_model_id"])
    .where("enterprise_id", "=", input.enterpriseId).execute();
  const catalog = await new EmployeeModelRuleRepository(db).catalog(input.enterpriseId);
  const reasons: string[] = [];
  if (!schema.rows[0]?.present) reasons.push("MONTHLY_SCHEMA_NOT_READY");
  if (!(period.periodStart > now)) reasons.push("ACTIVATION_MUST_BE_FUTURE_COMPLETE_MONTH_START");
  if (configured?.employee_quota_monthly_from && +configured.employee_quota_monthly_from !== +period.periodStart) reasons.push("EXISTING_ACTIVATION_DIFFERS");
  if (!grants.length) reasons.push("NO_ACTIVE_EMPLOYEE_POOLS");
  const pools = grants.map(grant => {
    const modelIds = new Set(keys.filter(key => key.principal_id === grant.principal_id).flatMap(key => key.allowed_model_ids ?? []));
    const authorized = catalog.models.filter(route => route.provider_code === grant.provider && route.ready && modelIds.has(route.unified_model_id)
      && (grant.pool_model_alias === "*" || grant.model_alias === route.alias)
      && !disabled.some(item => item.principal_id === grant.principal_id && item.provider === grant.provider && item.unified_model_id === route.unified_model_id));
    const modes = [...new Set(authorized.map(route => route.mode))].sort();
    const issues: string[] = [];
    if (grant.pool_model_alias !== "*") issues.push("LEGACY_MODEL_GRANT_NOT_MONTHLY_POOL");
    if (!grant.quota_basis) issues.push("QUOTA_BASIS_NOT_CONFIGURED");
    if (!modes.length) issues.push("NO_AUTHORIZED_READY_ROUTE");
    if (modes.length > 1) issues.push("MIXED_API_AND_PLAN_POOL");
    const expectedBasis = modes.length === 1 ? modes[0] === "API" ? "RAW_TOKEN" : "PLAN_QUOTA" : null;
    if (expectedBasis && grant.quota_basis && expectedBasis !== grant.quota_basis) issues.push("QUOTA_BASIS_ROUTE_MISMATCH");
    if (issues.length) reasons.push(`POOL_NO_GO:${grant.principal_id}:${grant.provider}`);
    return { principalId: grant.principal_id, provider: grant.provider, grantId: grant.id, basis: grant.quota_basis, expectedBasis,
      allowOverage: grant.allow_overage, configuredLimit: String(grant.quota_value), validUntil: grant.valid_until?.toISOString() ?? null,
      legacy: { periodAnchor: grant.period_anchor?.toISOString() ?? null, nextResetAt: grant.next_reset_at?.toISOString() ?? null,
        usedValue: grant.used_value === null ? null : String(grant.used_value), quality: "LEGACY_PENDING_RECONCILIATION" },
      availableRouteModes: modes, routes: authorized.map(route => ({ routeId: route.route_id, modelId: route.unified_model_id,
        model: route.alias, resourceId: route.provider_resource_id, mode: route.mode })).sort((a, b) => a.routeId.localeCompare(b.routeId)),
      status: issues.length ? "NO_GO" : "GO", issues };
  });
  const evidence = { schemaVersion: 1, mode: "READ_ONLY_PREFLIGHT", enterpriseId: input.enterpriseId, observedAt: now.toISOString(),
    activation: { earliestCompleteMonth: earliest.periodKey, earliestStart: earliest.periodStart.toISOString(), configuredStart: configured?.employee_quota_monthly_from?.toISOString() ?? null, month: input.month, timezone: enterprise.timezone, start: period.periodStart.toISOString(), end: period.periodEnd.toISOString(), carryOver: false },
    status: reasons.length ? "NO_GO" : "GO", reasons, pools,
    limits: "Configuration preview only; no runtime model call, activation, initialization, legacy reset, reconciliation apply or historical resend." };
  return { ...evidence, hash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}
