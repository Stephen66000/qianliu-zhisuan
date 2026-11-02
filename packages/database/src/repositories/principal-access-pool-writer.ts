import { sql, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import type { AccessConfigPutInput } from "./principal-access-config-repository.js";
import type { PrincipalAccessModelRow } from "./principal-access-read-model.js";
import type { LockedPrincipalGrant } from "./principal-access-locks.js";
import { recordEmployeeQuotaChange, assertCurrentQuotaBasis } from "./principal-access-quota-management.js";

export class PrincipalAccessPoolBasisError extends Error {}

/** Writer keeps the existing Key/provider lock order; no independent transaction. */
export async function writePrincipalProviderPools(
  trx: Transaction<Database>, input: AccessConfigPutInput,
  currentByProvider: Map<string, LockedPrincipalGrant>,
  modelById: Map<string, PrincipalAccessModelRow>,
  singleRuleVersionId: string, monthlyFrom: Date | null, isEmployee: boolean,
) {
const requestedProviders = new Set(input.pools.filter((p) => p.enabled_model_ids.length > 0).map((p) => p.provider_code));
const changes: { pools_added: string[]; pools_updated: string[]; pools_closed: string[] } = {
  pools_added: [], pools_updated: [], pools_closed: [],
};

// 5a. 关闭请求的 providers 之外的现有池。
for (const [provider, pool] of currentByProvider) {
  if (!requestedProviders.has(provider)) {
    await trx.updateTable("principal_grant")
      .set({ status: "DISABLED", version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", pool.id).execute();
    changes.pools_closed.push(provider);
    await recordEmployeeQuotaChange(trx, {
      enterpriseId: input.enterpriseId, principalId: input.principalId,
      provider, grantId: pool.id, adminUserId: input.adminUserId, action: "DISABLE", before: pool,
    });
  }
}

// 5b. upsert 请求的池。
const poolGrantByProvider = new Map<string, string>();
for (const pool of input.pools) {
  if (pool.enabled_model_ids.length === 0) continue;
  const existing = currentByProvider.get(pool.provider_code);
  const modes = new Set(pool.enabled_model_ids.map((id) => modelById.get(id)!.mode));
  const basis = modes.size === 1 ? (modes.has("API") ? "RAW_TOKEN" as const : "PLAN_QUOTA" as const) : null;
  if (monthlyFrom) await assertCurrentQuotaBasis(trx, {
    enterpriseId: input.enterpriseId, principalId: input.principalId, provider: pool.provider_code, basis,
    basisError: (message) => new PrincipalAccessPoolBasisError(message),
  });
  if (monthlyFrom && existing?.quota_basis && basis !== existing.quota_basis) {
    throw new PrincipalAccessPoolBasisError(`厂商 ${pool.provider_code} 的月度额度基础已确定，不能直接改为另一种计量方式`);
  }
  if (existing) {
    await trx.updateTable("principal_grant").set({
      quota_value: pool.quota_value, allow_overage: pool.allow_overage,
      valid_until: pool.valid_until,
      quota_basis: isEmployee ? basis : undefined,
      authorization_rule_version_id: singleRuleVersionId,
      version: sql`version + 1`, updated_at: new Date(),
    }).where("id", "=", existing.id).execute();
    poolGrantByProvider.set(pool.provider_code, existing.id);
    changes.pools_updated.push(pool.provider_code);
    await recordEmployeeQuotaChange(trx, {
      enterpriseId: input.enterpriseId, principalId: input.principalId,
      provider: pool.provider_code, grantId: existing.id, adminUserId: input.adminUserId, action: "SET", before: existing,
    });
  } else {
    const grant = await trx.insertInto("principal_grant").values({
      enterprise_id: input.enterpriseId, principal_id: input.principalId,
      provider: pool.provider_code, model_alias: "*", pool_model_alias: "*",
      quota_unit: "TOKEN", quota_value: pool.quota_value, allow_overage: pool.allow_overage,
      quota_basis: isEmployee ? basis : undefined,
      valid_until: pool.valid_until, status: "ACTIVE",
      authorization_rule_version_id: singleRuleVersionId,
    }).returning("id").executeTakeFirstOrThrow();
    await trx.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
    poolGrantByProvider.set(pool.provider_code, grant.id);
    changes.pools_added.push(pool.provider_code);
    await recordEmployeeQuotaChange(trx, {
      enterpriseId: input.enterpriseId, principalId: input.principalId,
      provider: pool.provider_code, grantId: grant.id, adminUserId: input.adminUserId, action: "SET", before: null,
    });
  }
}

return { changes, poolGrantByProvider };
}
