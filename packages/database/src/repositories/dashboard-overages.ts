import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { OverageItem } from "./dashboard-types.js";

/** Current monthly employee facts, with legacy/project counters retained independently. */
export async function listDashboardOverages(
  db: Kysely<Database>,
  enterpriseId: string,
  now: Date = new Date(),
): Promise<OverageItem[]> {
  const enterprise = await db
    .selectFrom("enterprise")
    .select("employee_quota_monthly_from")
    .where("id", "=", enterpriseId)
    .executeTakeFirstOrThrow();
  const monthlyActive =
    enterprise.employee_quota_monthly_from !== null &&
    enterprise.employee_quota_monthly_from <= now;
  let legacy = db
    .selectFrom("quota_counter")
    .innerJoin(
      "principal_grant",
      "principal_grant.id",
      "quota_counter.grant_id",
    )
    .innerJoin("principal", "principal.id", "principal_grant.principal_id")
    .where("principal_grant.enterprise_id", "=", enterpriseId)
    .where("principal.enterprise_id", "=", enterpriseId)
    .where("principal_grant.status", "=", "ACTIVE")
    .where("principal.status", "=", "ACTIVE")
    .where("principal.archived_at", "is", null)
    .where("quota_counter.overage_value", ">", 0n);
  if (monthlyActive) legacy = legacy.where("principal.type", "=", "PROJECT");
  const rows = await legacy
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
  const monthly = monthlyActive
    ? await db
        .selectFrom("principal_quota_period")
        .innerJoin(
          "principal",
          "principal.id",
          "principal_quota_period.principal_id",
        )
        .innerJoin("principal_grant", (join) =>
          join
            .onRef(
              "principal_grant.enterprise_id",
              "=",
              "principal_quota_period.enterprise_id",
            )
            .onRef(
              "principal_grant.principal_id",
              "=",
              "principal_quota_period.principal_id",
            )
            .onRef(
              "principal_grant.provider",
              "=",
              "principal_quota_period.provider",
            )
            .on("principal_grant.pool_model_alias", "=", "*")
            .on("principal_grant.status", "=", "ACTIVE"),
        )
        .where("principal_quota_period.enterprise_id", "=", enterpriseId)
        .where("principal.enterprise_id", "=", enterpriseId)
        .where("principal.type", "=", "EMPLOYEE")
        .where("principal.status", "=", "ACTIVE")
        .where("principal.archived_at", "is", null)
        .where("period_start", "<=", now)
        .where("period_end", ">", now)
        .whereRef("used_value", ">", "limit_value")
        .select([
          "principal.id as principal_id",
          "principal.name as principal_name",
          "principal.type as principal_type",
          "principal_quota_period.provider",
          "principal_grant.model_alias",
          "limit_value as quota_value",
          "used_value",
          sql<bigint>`principal_quota_period.used_value - principal_quota_period.limit_value`.as(
            "overage_value",
          ),
        ])
        .execute()
    : [];
  return [...rows, ...monthly]
    .sort((a, b) =>
      BigInt(a.overage_value) > BigInt(b.overage_value)
        ? -1
        : BigInt(a.overage_value) < BigInt(b.overage_value)
          ? 1
          : a.principal_id.localeCompare(b.principal_id),
    )
    .map((row) => {
      const quota = BigInt(row.quota_value),
        used = BigInt(row.used_value),
        overage = BigInt(row.overage_value);
      return {
        principalId: row.principal_id,
        principalName: row.principal_name,
        principalType: row.principal_type,
        provider: row.provider,
        modelAlias: row.model_alias,
        quotaValue: String(quota),
        usedValue: String(used),
        overageValue: String(overage),
        overageRatio:
          quota > 0n
            ? (Number((overage * 10000n) / quota) / 10000).toString()
            : "0",
      };
    });
}
