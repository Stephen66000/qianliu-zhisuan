import type { ModelDiscoveryResult } from "@qianliu/provider-adapters";
import { ProviderOperatingRepository } from "./provider-operating-repository.js";
import { EnterpriseReferenceError } from "./provider-types.js";

/** 模型发现快照：保存成功版本、下线差异与企业隔离。 */
export abstract class ProviderModelDiscoveryRepository extends ProviderOperatingRepository {
  async getResourceForModelDiscovery(enterpriseId: string, resourceId: string) {
    return this.db.selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .selectAll("provider_resource")
      .select("provider.code as provider_code")
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider.enterprise_id", "=", enterpriseId)
      .where("provider_resource.id", "=", resourceId)
      .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED"])
      .where("provider.status", "=", "ACTIVE")
      .executeTakeFirst();
  }

  async recordModelDiscoveryFailure(
    enterpriseId: string,
    resourceId: string,
    input: Pick<ModelDiscoveryResult, "source" | "sourceVersion" | "discoveredAt"> & {
      failureCode: string;
    },
  ) {
    const resource = await this.db.selectFrom("provider_resource").select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", resourceId)
      .where("status", "in", ["ACTIVE", "DEGRADED"])
      .executeTakeFirst();
    if (!resource) throw new EnterpriseReferenceError("resource is not serviceable in enterprise");
    return this.db.insertInto("provider_model_discovery").values({
      enterprise_id: enterpriseId,
      provider_resource_id: resourceId,
      source: input.source,
      source_version: input.sourceVersion,
      status: "FAILED",
      discovered_at: input.discoveredAt,
      failure_code: input.failureCode,
    }).returningAll().executeTakeFirstOrThrow();
  }

  async recordModelDiscovery(
    enterpriseId: string,
    resourceId: string,
    discovery: ModelDiscoveryResult,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const resource = await trx.selectFrom("provider_resource").select("id")
        .where("enterprise_id", "=", enterpriseId).where("id", "=", resourceId)
        .forKeyShare().executeTakeFirst();
      if (!resource) throw new EnterpriseReferenceError("resource is not in enterprise");
      const previous = await trx.selectFrom("provider_model_discovery")
        .select("id").where("enterprise_id", "=", enterpriseId)
        .where("provider_resource_id", "=", resourceId)
        .where("status", "=", "SUCCEEDED")
        .orderBy("discovered_at", "desc").executeTakeFirst();
      const previousItems = previous
        ? await trx.selectFrom("provider_model_discovery_item").selectAll()
            .where("discovery_id", "=", previous.id).execute()
        : [];
      const row = await trx.insertInto("provider_model_discovery").values({
        enterprise_id: enterpriseId,
        provider_resource_id: resourceId,
        source: discovery.source,
        source_version: discovery.sourceVersion,
        status: "SUCCEEDED",
        discovered_at: discovery.discoveredAt,
        failure_code: null,
      }).returningAll().executeTakeFirstOrThrow();
      const currentIds = new Set(discovery.models.map((model) => model.id));
      const historicalFirst = new Map(previousItems.map((item) => [item.upstream_model, item.first_discovered_at]));
      const removed = previousItems.filter((item) =>
        item.availability_status === "AVAILABLE" && !currentIds.has(item.upstream_model));
      const items = [
        ...discovery.models.map((model) => ({
          enterprise_id: enterpriseId,
          discovery_id: row.id,
          provider_resource_id: resourceId,
          upstream_model: model.id,
          display_name: model.displayName,
          model_type: model.modelType,
          capabilities: JSON.stringify(model.capabilities) as unknown as string[],
          source: model.source,
          compatible: model.compatible,
          unavailable_reason: model.unavailableReason,
          availability_status: "AVAILABLE" as const,
          first_discovered_at: historicalFirst.get(model.id) ?? discovery.discoveredAt,
          last_discovered_at: discovery.discoveredAt,
          last_validated_at: discovery.source === "PROVIDER_API" ? discovery.discoveredAt : null,
        })),
        ...removed.map((item) => ({
          enterprise_id: enterpriseId,
          discovery_id: row.id,
          provider_resource_id: resourceId,
          upstream_model: item.upstream_model,
          display_name: item.display_name,
          model_type: item.model_type,
          capabilities: JSON.stringify(item.capabilities) as unknown as string[],
          source: item.source,
          compatible: false,
          unavailable_reason: "厂商本次同步未再返回该模型",
          availability_status: "REMOVED" as const,
          first_discovered_at: item.first_discovered_at,
          last_discovered_at: item.last_discovered_at,
          last_validated_at: item.last_validated_at,
        })),
      ];
      if (items.length > 0) await trx.insertInto("provider_model_discovery_item").values(items).execute();
      if (removed.length > 0) {
        await trx.updateTable("model_route").set({ enabled: false, updated_at: new Date() })
          .where("enterprise_id", "=", enterpriseId)
          .where("provider_resource_id", "=", resourceId)
          .where("upstream_model", "in", removed.map((item) => item.upstream_model)).execute();
      }
      return { discovery: row, items };
    });
  }

  async latestModelDiscovery(enterpriseId: string, resourceId: string) {
    const discovery = await this.db.selectFrom("provider_model_discovery").selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .orderBy("discovered_at", "desc").executeTakeFirst();
    if (!discovery) return null;
    const itemDiscovery = discovery.status === "SUCCEEDED"
      ? discovery
      : await this.db.selectFrom("provider_model_discovery").selectAll()
          .where("enterprise_id", "=", enterpriseId)
          .where("provider_resource_id", "=", resourceId)
          .where("status", "=", "SUCCEEDED")
          .orderBy("discovered_at", "desc").executeTakeFirst();
    const items = await this.db.selectFrom("provider_model_discovery_item").selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("discovery_id", "=", itemDiscovery?.id ?? discovery.id)
      .orderBy("upstream_model").execute();
    return {
      discovery,
      items,
      items_stale: discovery.status === "FAILED",
      items_discovery_id: itemDiscovery?.id ?? null,
    };
  }
}
