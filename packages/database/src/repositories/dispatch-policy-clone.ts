import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { Database, DispatchPolicyTable } from "../kysely.js";

type PolicyRow = Selectable<DispatchPolicyTable>;

export type RestorePolicyResult =
  | { kind: "created" | "replayed"; policy: PolicyRow }
  | { kind: "conflict" }
  | { kind: "invalid_reference"; message: string };

export function nextPolicyVersion(current: string, existing: ReadonlySet<string>): string {
  const numbered = /^(.*?)(\d+)$/.exec(current);
  const prefix = numbered?.[1] ?? `${current}-v`;
  let number = numbered ? Number(numbered[2]) + 1 : 2;
  let candidate = `${prefix}${number}`;
  while (existing.has(candidate)) candidate = `${prefix}${++number}`;
  return candidate;
}

async function lockAndAllocateVersion(
  trx: Transaction<Database>,
  enterpriseId: string,
  currentVersion: string,
): Promise<string> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`${enterpriseId}:dispatch-policy-version`}))`.execute(trx);
  const versions = new Set((await trx.selectFrom("dispatch_policy")
    .select("policy_version")
    .where("enterprise_id", "=", enterpriseId)
    .execute()).map((row) => row.policy_version));
  return nextPolicyVersion(currentVersion, versions);
}

function cloneValues(
  source: PolicyRow,
  enterpriseId: string,
  actorAdminId: string,
  version: string,
) {
  return {
    enterprise_id: enterpriseId,
    match_unified_model: source.match_unified_model,
    match_resource_mode: source.match_resource_mode,
    match_provider_resource_id: source.match_provider_resource_id,
    match_timezone: source.match_timezone,
    match_days_of_week: source.match_days_of_week
      ? (JSON.stringify(source.match_days_of_week) as unknown as number[])
      : null,
    match_start_time: source.match_start_time,
    match_end_time: source.match_end_time,
    match_price_multiplier_min: source.match_price_multiplier_min,
    match_remaining_quota_ratio_max: source.match_remaining_quota_ratio_max,
    match_forecast_exhaust_risk: source.match_forecast_exhaust_risk,
    match_principal_scope: source.match_principal_scope
      ? (JSON.stringify(source.match_principal_scope) as unknown as string[])
      : null,
    action: source.action,
    switch_equivalent_group: source.switch_equivalent_group
      ? (JSON.stringify(source.switch_equivalent_group) as unknown as string[])
      : null,
    rate_limit_per_minute: source.rate_limit_per_minute,
    policy_version: version,
    priority: source.priority,
    description: source.description,
    source: source.source,
    copied_from_policy_id: source.id,
    created_by_admin_id: actorAdminId,
  };
}

async function validateReferences(
  trx: Transaction<Database>,
  source: PolicyRow,
  enterpriseId: string,
): Promise<string | null> {
  if (source.match_unified_model) {
    const model = await trx.selectFrom("unified_model").select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("alias", "=", source.match_unified_model)
      .where("status", "=", "ACTIVE")
      .where("archived_at", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!model) return "统一模型不存在、未启用或已归档";
  }
  const resourceIds = [...new Set([
    source.match_provider_resource_id,
    ...(source.switch_equivalent_group ?? []),
  ].filter((id): id is string => id !== null))];
  if (resourceIds.length > 0) {
    const existing = new Set((await trx.selectFrom("provider_resource").select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "in", resourceIds)
      .where("status", "!=", "DELETED")
      .forShare()
      .execute()).map((row) => row.id));
    if (source.match_provider_resource_id && !existing.has(source.match_provider_resource_id)) {
      return "匹配资源不存在";
    }
    if ((source.switch_equivalent_group ?? []).some((id) => !existing.has(id))) {
      return "等价资源组包含不存在的资源";
    }
  }
  const principalIds = source.match_principal_scope ?? [];
  if (principalIds.length > 0) {
    const active = new Set((await trx.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "in", principalIds)
      .where("status", "=", "ACTIVE")
      .where("archived_at", "is", null)
      .forShare()
      .execute()).map((row) => row.id));
    if (principalIds.some((id) => !active.has(id))) return "主体范围包含停用、归档或不存在的主体";
  }
  return null;
}

async function retiredSource(
  trx: Transaction<Database>, enterpriseId: string, policyId: string,
): Promise<PolicyRow | undefined> {
  return trx.selectFrom("dispatch_policy").selectAll()
    .where("enterprise_id", "=", enterpriseId)
    .where("id", "=", policyId)
    .where("status", "=", "RETIRED")
    .forUpdate()
    .executeTakeFirst();
}

export async function copyRetiredPolicyAsDraft(
  db: Kysely<Database>, enterpriseId: string, policyId: string, actorAdminId: string,
): Promise<PolicyRow | undefined> {
  return db.transaction().execute(async (trx) => {
    const source = await retiredSource(trx, enterpriseId, policyId);
    if (!source) return undefined;
    const version = await lockAndAllocateVersion(trx, enterpriseId, source.policy_version);
    const created = await trx.insertInto("dispatch_policy").values({
      ...cloneValues(source, enterpriseId, actorAdminId, version), status: "DRAFT",
    }).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto("operation_log").values({
      enterprise_id: enterpriseId, admin_user_id: actorAdminId,
      action: "dispatch_policy.copy", target_type: "dispatch_policy", target_id: created.id,
      change_summary: { copied_from_policy_id: source.id, before_version: source.policy_version, new_version: version, status: "DRAFT" },
      result: "SUCCESS", failure_reason: null,
    }).execute();
    return created;
  });
}

export async function restoreRetiredPolicyAsPublished(
  db: Kysely<Database>, enterpriseId: string, policyId: string, actorAdminId: string,
): Promise<RestorePolicyResult> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${enterpriseId}:dispatch-policy-version`}))`.execute(trx);
    const replay = await trx.selectFrom("dispatch_policy").selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("restore_source_policy_id", "=", policyId)
      .where("status", "=", "PUBLISHED")
      .executeTakeFirst();
    if (replay) return { kind: "replayed", policy: replay };
    const source = await retiredSource(trx, enterpriseId, policyId);
    if (!source) return { kind: "conflict" };
    const invalidReference = await validateReferences(trx, source, enterpriseId);
    if (invalidReference) return { kind: "invalid_reference", message: invalidReference };
    const versions = new Set((await trx.selectFrom("dispatch_policy").select("policy_version")
      .where("enterprise_id", "=", enterpriseId).execute()).map((row) => row.policy_version));
    const version = nextPolicyVersion(source.policy_version, versions);
    const now = new Date();
    const created = await trx.insertInto("dispatch_policy").values({
      ...cloneValues(source, enterpriseId, actorAdminId, version),
      restore_source_policy_id: source.id,
      status: "PUBLISHED", validated_at: now, validated_by_admin_id: actorAdminId,
      published_at: now, published_by_admin_id: actorAdminId, effective_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto("operation_log").values({
      enterprise_id: enterpriseId, admin_user_id: actorAdminId,
      action: "dispatch_policy.restore", target_type: "dispatch_policy", target_id: created.id,
      change_summary: { restored_from_policy_id: source.id, before_version: source.policy_version, new_version: version, status: "PUBLISHED" },
      result: "SUCCESS", failure_reason: null,
    }).execute();
    return { kind: "created", policy: created };
  });
}
