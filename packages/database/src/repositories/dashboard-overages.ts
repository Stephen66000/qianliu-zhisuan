import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { OverageItem } from "./dashboard-types.js";

/** 当前企业的启用主体超额列表。 */
export async function listDashboardOverages(
  db: Kysely<Database>, enterpriseId: string,
): Promise<OverageItem[]> {
  const rows = await db
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
  return rows.map((row) => {
    const quota = BigInt(row.quota_value);
    const used = BigInt(row.used_value);
    const overage = BigInt(row.overage_value);
    return {
      principalId: row.principal_id,
      principalName: row.principal_name,
      principalType: row.principal_type,
      provider: row.provider,
      modelAlias: row.model_alias,
      quotaValue: quota.toString(),
      usedValue: used.toString(),
      overageValue: overage.toString(),
      overageRatio: quota > 0n ? (Number(overage * 10000n / quota) / 10000).toString() : "0",
    };
  });
}
