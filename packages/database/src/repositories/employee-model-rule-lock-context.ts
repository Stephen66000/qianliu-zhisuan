import type { Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { lockActivePrincipalKeys } from "./principal-access-locks.js";

export interface RuleLockReference {
  rule_id: string;
  employee_scope: "SELECTED" | "ALL";
  principal_ids: string[];
}

export async function lockVersion(
  trx: Transaction<Database>,
  enterpriseId: string,
  versionId: string,
) {
  return trx.selectFrom("employee_model_rule_version").selectAll()
    .where("enterprise_id", "=", enterpriseId).where("id", "=", versionId)
    .forUpdate().executeTakeFirst();
}

export async function readRuleReference(
  trx: Transaction<Database>,
  enterpriseId: string,
  versionId: string,
): Promise<RuleLockReference | undefined> {
  return trx.selectFrom("employee_model_rule_version")
    .select(["rule_id", "employee_scope", "principal_ids"])
    .where("enterprise_id", "=", enterpriseId).where("id", "=", versionId)
    .executeTakeFirst();
}

export async function principalIdsForRuleFamily(
  trx: Transaction<Database>,
  enterpriseId: string,
  reference: RuleLockReference,
): Promise<string[]> {
  const ids = reference.employee_scope === "SELECTED"
    ? reference.principal_ids
    : (await trx.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId).where("type", "=", "EMPLOYEE")
      .execute()).map((row) => row.id);
  const publishedVersionIds = (await trx.selectFrom("employee_model_rule_version").select("id")
    .where("enterprise_id", "=", enterpriseId).where("rule_id", "=", reference.rule_id)
    .where("status", "=", "PUBLISHED").execute()).map((row) => row.id);
  const assignments = publishedVersionIds.length === 0 ? [] : await trx.selectFrom("employee_model_rule_assignment")
    .select("principal_id").where("enterprise_id", "=", enterpriseId)
    .where("rule_version_id", "in", publishedVersionIds).execute();
  return [...new Set([...ids, ...assignments.map((row) => row.principal_id)])]
    .sort((left, right) => left.localeCompare(right, "en"));
}

export async function lockRuleFamily(
  trx: Transaction<Database>,
  enterpriseId: string,
  versionId: string,
  captureManualBaseline: (trx: Transaction<Database>, enterpriseId: string, principalId: string) => Promise<void>,
): Promise<{ reference: RuleLockReference | undefined; principals: string[] }> {
  const reference = await readRuleReference(trx, enterpriseId, versionId);
  if (!reference) return { reference: undefined, principals: [] };
  const principals = await principalIdsForRuleFamily(trx, enterpriseId, reference);
  await lockActivePrincipalKeys(trx, enterpriseId, principals);
  for (const principalId of principals) await captureManualBaseline(trx, enterpriseId, principalId);
  return { reference, principals };
}

export async function captureManualBaseline(
  trx: Transaction<Database>,
  enterpriseId: string,
  principalId: string,
): Promise<void> {
  const existing = await trx.selectFrom("principal_model_manual_authorization").select("unified_model_id")
    .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId).execute();
  const key = await trx.selectFrom("principal_key").select("allowed_model_ids")
    .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
    .where("status", "=", "ACTIVE").forUpdate().executeTakeFirst();
  if (!key) return;
  const managed = await trx.selectFrom("employee_model_rule_assignment").select("unified_model_id")
    .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
    .where("status", "=", "ACTIVE").execute();
  const managedIds = new Set(managed.map((row) => row.unified_model_id));
  const existingIds = new Set(existing.map((row) => row.unified_model_id));
  // 批量授权是增量合同：发布前把当前 Key 后来增加的未受管型号持续并入基线，
  // 不能因为曾经捕获过一条旧基线就跳过；受管型号仍由 assignment／厂商池维护。
  const manualIds = (key.allowed_model_ids ?? [])
    .filter((id) => !managedIds.has(id) && !existingIds.has(id));
  if (manualIds.length > 0) await trx.insertInto("principal_model_manual_authorization")
    .values(manualIds.map((unified_model_id) => ({ enterprise_id: enterpriseId, principal_id: principalId, unified_model_id })))
    .onConflict((oc) => oc.doNothing()).execute();
}

export async function providerCodesForRuleFamily(
  trx: Transaction<Database>,
  enterpriseId: string,
  ruleId: string,
  modelScope: "SELECTED" | "ALL",
  modelTargets: { unified_model_id: string; provider_resource_id: string }[],
): Promise<string[]> {
  const routes = await trx.selectFrom("model_route")
    .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select("provider.code").where("model_route.enterprise_id", "=", enterpriseId)
    .$if(modelScope === "SELECTED", (qb) => qb.where((eb) => eb.or(
      modelTargets.map((target) => eb.and([
        eb("model_route.unified_model_id", "=", target.unified_model_id),
        eb("model_route.provider_resource_id", "=", target.provider_resource_id),
      ])),
    ))).execute();
  const previousRoutes = await trx.selectFrom("employee_model_rule_assignment")
    .innerJoin("model_route", (join) => join
      .onRef("model_route.unified_model_id", "=", "employee_model_rule_assignment.unified_model_id")
      .onRef("model_route.provider_resource_id", "=", "employee_model_rule_assignment.provider_resource_id")
      .onRef("model_route.enterprise_id", "=", "employee_model_rule_assignment.enterprise_id"))
    .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .innerJoin("employee_model_rule_version", "employee_model_rule_version.id", "employee_model_rule_assignment.rule_version_id")
    .select("provider.code").where("employee_model_rule_assignment.enterprise_id", "=", enterpriseId)
    .where("employee_model_rule_assignment.status", "=", "ACTIVE")
    .where("employee_model_rule_version.rule_id", "=", ruleId).execute();
  return [...new Set([...routes, ...previousRoutes].map((row) => row.code))]
    .sort((left, right) => left.localeCompare(right, "en"));
}
