import { worstResourceStatus, type ResourceStatus } from "@qianliu/domain";
import type { Kysely } from "kysely";

import type { Database } from "../kysely.js";
import type { ResourceStatusSummary } from "./dashboard-types.js";
import {
  effectiveOperatingResourceStatus,
  type CurrentProviderOperatingSnapshot,
} from "./provider-operating.js";

/** 首页仅保留资源状态摘要，不加载厂商经营、模型 Token 或速度聚合。 */
export async function loadDashboardResourceStatus(
  db: Kysely<Database>,
  enterpriseId: string,
  currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
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
  const snapshotByResource = new Map(
    currentOperatingSnapshots.map((snapshot) => [snapshot.provider_resource_id, snapshot]),
  );
  const effectiveRows = rows.map((row) => ({
    ...row,
    status: effectiveOperatingResourceStatus({
      status: row.status,
      mode: row.mode as "API" | "CODING_PLAN",
      snapshot: snapshotByResource.get(row.resource_id) ?? null,
    }),
  }));
  const statusCounts = effectiveRows.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, {});
  const status = effectiveRows.length === 0
    ? "EMPTY"
    : worstResourceStatus(effectiveRows.map((row) => row.status as ResourceStatus));
  return {
    total: effectiveRows.length,
    status: status === "ACTIVE" ? "HEALTHY" : status,
    statusCounts,
    abnormalResources: effectiveRows
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
