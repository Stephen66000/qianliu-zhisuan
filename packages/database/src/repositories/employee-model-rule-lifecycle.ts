import type { Transaction } from "kysely";
import { matchApplicableBillingRule, type BillingResourceMode } from "@qianliu/domain";
import type { Database } from "../kysely.js";
import { mergeDeclaredModelIds } from "./employee-model-authorization-policy.js";
import { listEnabledBillingRulesAt } from "./billing-rule-applicability.js";

function jsonValue<T>(value: T): T {
  return JSON.stringify(value) as unknown as T;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** 按手工基线、受管 assignment、厂商池与禁用清单重算 ACTIVE Key 白名单。 */
export async function refreshEmployeeKeyModels(
  trx: Transaction<Database>,
  enterpriseId: string,
  principalId: string,
): Promise<void> {
  const key = await trx.selectFrom("principal_key").select("id")
    .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
    .where("status", "=", "ACTIVE").forUpdate().executeTakeFirst();
  if (!key) return;
  const readyAt = new Date();
  const [manual, managed, disabled, billingRules] = await Promise.all([
    trx.selectFrom("principal_model_manual_authorization")
      .innerJoin("model_route", (join) => join
        .onRef("model_route.enterprise_id", "=", "principal_model_manual_authorization.enterprise_id")
        .onRef("model_route.unified_model_id", "=", "principal_model_manual_authorization.unified_model_id"))
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "principal_model_manual_authorization.unified_model_id",
        "model_route.provider_resource_id",
        "model_route.upstream_model",
        "provider_resource.mode",
      ])
      .where("principal_model_manual_authorization.enterprise_id", "=", enterpriseId)
      .where("principal_model_manual_authorization.principal_id", "=", principalId)
      .where("unified_model.status", "=", "ACTIVE")
      .where("model_route.enabled", "=", true)
      .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED"])
      .where("provider.status", "=", "ACTIVE")
      .execute(),
    trx.selectFrom("employee_model_rule_assignment")
      .innerJoin("principal_grant", "principal_grant.id", "employee_model_rule_assignment.grant_id")
      .innerJoin("model_route", (join) => join
        .onRef("model_route.enterprise_id", "=", "employee_model_rule_assignment.enterprise_id")
        .onRef("model_route.unified_model_id", "=", "employee_model_rule_assignment.unified_model_id")
        .onRef("model_route.provider_resource_id", "=", "employee_model_rule_assignment.provider_resource_id"))
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "employee_model_rule_assignment.unified_model_id",
        "model_route.provider_resource_id",
        "model_route.upstream_model",
        "provider_resource.mode",
      ])
      .where("employee_model_rule_assignment.enterprise_id", "=", enterpriseId)
      .where("employee_model_rule_assignment.principal_id", "=", principalId)
      .where("employee_model_rule_assignment.status", "=", "ACTIVE")
      .where("principal_grant.status", "=", "ACTIVE")
      .where("principal_grant.valid_from", "<=", readyAt)
      .where((eb) => eb.or([
        eb("principal_grant.valid_until", "is", null),
        eb("principal_grant.valid_until", ">", readyAt),
      ]))
      .where("unified_model.status", "=", "ACTIVE")
      .where("model_route.enabled", "=", true)
      .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED"])
      .where("provider.status", "=", "ACTIVE")
      .execute(),
    trx.selectFrom("principal_provider_disabled_model").select("unified_model_id")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId).execute(),
    listEnabledBillingRulesAt(trx, enterpriseId, readyAt),
  ]);
  const poolModels = await trx.selectFrom("principal_grant")
    .innerJoin("model_route", (join) => join
      .onRef("model_route.enterprise_id", "=", "principal_grant.enterprise_id"))
    .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
    .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select([
      "model_route.unified_model_id",
      "model_route.provider_resource_id",
      "model_route.upstream_model",
      "provider_resource.mode",
    ])
    .distinct()
    .where("principal_grant.enterprise_id", "=", enterpriseId)
    .where("principal_grant.principal_id", "=", principalId)
    .where("principal_grant.pool_model_alias", "=", "*")
    .where("principal_grant.status", "=", "ACTIVE")
    .where("principal_grant.valid_from", "<=", readyAt)
    .where((eb) => eb.or([
      eb("principal_grant.valid_until", "is", null),
      eb("principal_grant.valid_until", ">", readyAt),
    ]))
    .whereRef("provider.code", "=", "principal_grant.provider")
    // 厂商池只自动接纳当前就绪型号；发现但尚未配置的模型不得提前进入 Key 白名单。
    .where("unified_model.status", "=", "ACTIVE")
    .where("model_route.enabled", "=", true)
    .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED"])
    .where("provider.status", "=", "ACTIVE")
    .execute();
  const isBillable = (row: {
    provider_resource_id: string;
    upstream_model: string;
    mode: string;
  }) => matchApplicableBillingRule(
    billingRules,
    row.provider_resource_id,
    row.upstream_model,
    row.mode as BillingResourceMode,
    readyAt.getTime(),
  ) !== null;
  const disabledSet = new Set(disabled.map((row) => row.unified_model_id));
  const manualAllowed = manual.filter(isBillable).map((row) => row.unified_model_id);
  const managedAllowed = managed.filter(isBillable).map((row) => row.unified_model_id);
  const poolAllowed = poolModels.filter(isBillable).map((row) => row.unified_model_id)
    .filter((id) => !disabledSet.has(id));
  const ids = mergeDeclaredModelIds(
    mergeDeclaredModelIds(manualAllowed, managedAllowed),
    poolAllowed,
  );
  await trx.updateTable("principal_key").set({ allowed_model_ids: jsonValue(ids) })
    .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId)
    .where("status", "=", "ACTIVE").execute();
}

/** 停用规则版本并撤销不再由其他规则维护的型号；共享厂商池保持 ACTIVE。 */
export async function disableEmployeeRuleVersion(
  trx: Transaction<Database>,
  enterpriseId: string,
  versionId: string,
): Promise<string[]> {
  const assignments = await trx.selectFrom("employee_model_rule_assignment")
    .select(["principal_id", "grant_id", "unified_model_id", "provider_resource_id"])
    .where("enterprise_id", "=", enterpriseId)
    .where("rule_version_id", "=", versionId).where("status", "=", "ACTIVE").forUpdate().execute();
  if (assignments.length > 0) {
    const now = new Date();
    await trx.updateTable("employee_model_rule_assignment").set({ status: "DISABLED", disabled_at: now })
      .where("rule_version_id", "=", versionId).where("status", "=", "ACTIVE").execute();
    const affectedPairs = new Map<string, {
      principal_id: string;
      unified_model_id: string;
      provider_resource_id: string;
    }>();
    for (const assignment of assignments) {
      affectedPairs.set(`${assignment.principal_id}:${assignment.unified_model_id}`, assignment);
    }
    for (const assignment of affectedPairs.values()) {
      const stillMaintained = await trx.selectFrom("employee_model_rule_assignment")
        .select("id").where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", assignment.principal_id)
        .where("unified_model_id", "=", assignment.unified_model_id)
        .where("status", "=", "ACTIVE").executeTakeFirst();
      if (!stillMaintained) {
        const route = await trx.selectFrom("model_route")
          .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
          .innerJoin("provider", "provider.id", "provider_resource.provider_id")
          .select("provider.code")
          .where("model_route.enterprise_id", "=", enterpriseId)
          .where("model_route.unified_model_id", "=", assignment.unified_model_id)
          .where("model_route.provider_resource_id", "=", assignment.provider_resource_id)
          .executeTakeFirst();
        if (route) {
          await trx.insertInto("principal_provider_disabled_model").values({
            enterprise_id: enterpriseId,
            principal_id: assignment.principal_id,
            provider: route.code,
            unified_model_id: assignment.unified_model_id,
            disabled_at: now,
            disable_rule_version_id: versionId,
          }).onConflict((oc) => oc.doNothing()).execute();
        }
      }
    }
    for (const principalId of unique(assignments.map((row) => row.principal_id)).sort()) {
      await refreshEmployeeKeyModels(trx, enterpriseId, principalId);
    }
  }
  await trx.updateTable("employee_model_rule_version")
    .set({ status: "DISABLED", disabled_at: new Date(), updated_at: new Date() })
    .where("id", "=", versionId).execute();
  return unique(assignments.map((row) => row.principal_id));
}
