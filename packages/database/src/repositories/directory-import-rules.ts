import type { Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { resolvePoolQuota } from "./employee-model-rule-quota.js";
import { ensureCurrentQuotaPeriod } from "./employee-quota-repository.js";
import { DirectoryRepositoryError } from "./directory-repository-types.js";

/**
 * 新导入员工继承当前生效的 ALL 员工批量规则。规则只生成可配置的厂商池和
 * assignment；Key 仍保持待首次领取，不在后台生成明文。
 * 两层解耦后仅在开通主体（activateEmployeePrincipal / 手工绑定自然人）时调用。
 */
export async function applyPublishedEmployeeRules(
  trx: Transaction<Database>,
  enterpriseId: string,
  principalId: string,
  now: Date,
): Promise<number> {
  const versions = await trx
    .selectFrom("employee_model_rule_version")
    .selectAll()
    .where("enterprise_id", "=", enterpriseId)
    .where("status", "=", "PUBLISHED")
    .where("employee_scope", "=", "ALL")
    .where("owner_principal_id", "is", null)
    .where("valid_from", "<=", now)
    .where((eb) =>
      eb.or([eb("valid_until", "is", null), eb("valid_until", ">", now)]),
    )
    // 同一厂商多条规则时，已有发布链路以最后发布者决定新池额度。
    .orderBy("published_at", "desc")
    .orderBy("id", "desc")
    .execute();
  const policy = await trx
    .selectFrom("enterprise")
    .select("employee_quota_monthly_from")
    .where("id", "=", enterpriseId)
    .executeTakeFirstOrThrow();
  let applied = 0;
  for (const version of versions) {
    // 从已发布且仍 ACTIVE 的 assignment 复用冻结型号集，不在导入时重新猜测路由。
    const targets = await trx
      .selectFrom("employee_model_rule_assignment")
      .innerJoin("provider_resource", (join) =>
        join
          .onRef(
            "provider_resource.enterprise_id",
            "=",
            "employee_model_rule_assignment.enterprise_id",
          )
          .onRef(
            "provider_resource.id",
            "=",
            "employee_model_rule_assignment.provider_resource_id",
          ),
      )
      .innerJoin("provider", (join) =>
        join
          .onRef(
            "provider.enterprise_id",
            "=",
            "provider_resource.enterprise_id",
          )
          .onRef("provider.id", "=", "provider_resource.provider_id"),
      )
      .select([
        "employee_model_rule_assignment.unified_model_id",
        "employee_model_rule_assignment.provider_resource_id",
        "provider.code as provider_code",
        "provider_resource.mode as resource_mode",
      ])
      .distinct()
      .where("employee_model_rule_assignment.enterprise_id", "=", enterpriseId)
      .where("employee_model_rule_assignment.rule_version_id", "=", version.id)
      .where("employee_model_rule_assignment.status", "=", "ACTIVE")
      .orderBy("provider.code")
      .orderBy("employee_model_rule_assignment.unified_model_id")
      .orderBy("employee_model_rule_assignment.provider_resource_id")
      .execute();
    const byProvider = new Map<string, typeof targets>();
    for (const target of targets) {
      const bucket = byProvider.get(target.provider_code) ?? [];
      bucket.push(target);
      byProvider.set(target.provider_code, bucket);
    }
    for (const [providerCode, providerTargets] of byProvider) {
      let pool = await trx
        .selectFrom("principal_grant")
        .select("id")
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", principalId)
        .where("provider", "=", providerCode)
        .where("pool_model_alias", "=", "*")
        .where("status", "=", "ACTIVE")
        .forUpdate()
        .executeTakeFirst();
      if (!pool) {
        const quota = resolvePoolQuota(version, providerCode);
        const modes = new Set(
          providerTargets.map((target) => target.resource_mode),
        );
        if (
          policy.employee_quota_monthly_from &&
          (modes.size !== 1 ||
            !["API", "CODING_PLAN"].includes([...modes][0] ?? ""))
        ) {
          throw new DirectoryRepositoryError(
            "CONFLICT",
            "QUOTA_BASIS_AMBIGUOUS",
          );
        }
        const quotaBasis = policy.employee_quota_monthly_from
          ? modes.has("API")
            ? ("RAW_TOKEN" as const)
            : ("PLAN_QUOTA" as const)
          : null;
        pool = await trx
          .insertInto("principal_grant")
          .values({
            enterprise_id: enterpriseId,
            principal_id: principalId,
            provider: providerCode,
            model_alias: "*",
            pool_model_alias: "*",
            quota_unit: "TOKEN",
            quota_value: quota.quota_value,
            allow_overage: quota.allow_overage,
            quota_basis: quotaBasis,
            valid_from: version.valid_from,
            valid_until: quota.valid_until,
            status: "ACTIVE",
            authorization_rule_version_id: version.id,
          })
          .onConflict((oc) => oc.doNothing())
          .returning("id")
          .executeTakeFirst();
        pool ??= await trx
          .selectFrom("principal_grant")
          .select("id")
          .where("enterprise_id", "=", enterpriseId)
          .where("principal_id", "=", principalId)
          .where("provider", "=", providerCode)
          .where("pool_model_alias", "=", "*")
          .where("status", "=", "ACTIVE")
          .forUpdate()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("quota_counter")
          .values({ grant_id: pool.id })
          .onConflict((oc) => oc.column("grant_id").doNothing())
          .execute();
      }
      for (const target of providerTargets) {
        const inserted = await trx
          .insertInto("employee_model_rule_assignment")
          .values({
            enterprise_id: enterpriseId,
            rule_version_id: version.id,
            principal_id: principalId,
            unified_model_id: target.unified_model_id,
            provider_resource_id: target.provider_resource_id,
            grant_id: pool.id,
            status: "ACTIVE",
          })
          .onConflict((oc) => oc.doNothing())
          .returning("id")
          .executeTakeFirst();
        if (inserted) applied += 1;
      }
      if (
        policy.employee_quota_monthly_from &&
        policy.employee_quota_monthly_from <= now
      ) {
        await ensureCurrentQuotaPeriod(trx, {
          enterpriseId,
          principalId,
          provider: providerCode,
          now,
        });
      }
    }
  }
  return applied;
}
