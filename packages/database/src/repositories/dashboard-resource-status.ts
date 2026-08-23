import { worstResourceStatus, type ResourceStatus } from "@qianliu/domain";
import type { Kysely } from "kysely";

import type { Database } from "../kysely.js";
import type { ResourceStatusSummary } from "./dashboard-types.js";

/** 首页仅保留资源状态摘要，不加载厂商经营、模型 Token 或速度聚合。 */
export async function loadDashboardResourceStatus(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<ResourceStatusSummary> {
  const rows = await db
    .selectFrom("provider_resource")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select([
      "provider_resource.id as resource_id",
      "provider_resource.name as resource_name",
      "provider_resource.mode",
      "provider_resource.status",
      "provider.name as provider_name",
    ])
    .where("provider_resource.enterprise_id", "=", enterpriseId)
    .where("provider.enterprise_id", "=", enterpriseId)
    .where("provider_resource.status", "<>", "DELETED")
    .orderBy("provider.name", "asc")
    .orderBy("provider_resource.name", "asc")
    .execute();
  const statusCounts = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, {});
  const status = rows.length === 0
    ? "EMPTY"
    : worstResourceStatus(rows.map((row) => row.status as ResourceStatus));
  return {
    total: rows.length,
    status: status === "ACTIVE" ? "HEALTHY" : status,
    statusCounts,
    abnormalResources: rows
      .filter((row) => row.status !== "ACTIVE")
      .map((row) => ({
        resourceId: row.resource_id,
        resourceName: row.resource_name,
        providerName: row.provider_name,
        mode: row.mode as "API" | "CODING_PLAN",
        status: row.status,
      })),
  };
}
