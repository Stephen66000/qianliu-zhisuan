/**
 * Provider/Resource/Model/Route 仓储（W04）。
 *
 * 依据：TRD §5.4。
 * 凭证安全：上游 Secret 用 AES-256-GCM 加密后存密文 + 指纹；
 * 明文绝不入库（TRD §5.4 L252）；列表只返回指纹。
 */
import type { Selectable } from "kysely";
import { sql } from "kysely";
import type {
  ProviderTable,
  ProviderResourceTable,
  UnifiedModelTable,
  ModelRouteTable,
} from "../kysely.js";
import type { DiscoveredProviderModel } from "@qianliu/provider-adapters";
import { ProviderModelDiscoveryRepository } from "./provider-model-discovery-repository.js";
import { mergeDiscoveredCapabilities, stableModelAlias } from "./provider-model-utils.js";
import {
  deleteProviderResourceSafely,
  deleteProviderSafely,
} from "./provider-deletion.js";
import {
  EnterpriseReferenceError,
  IdempotencyConflictError,
  type CreateProviderInput,
  type CreateProviderResourceInput,
  type OnboardResourceModelsInput,
  type ProviderModelOnboardingResult,
  type DeleteProviderResult,
  type UpdateProviderInput,
  type DeleteResourceSafelyResult,
} from "./provider-types.js";

export {
  EnterpriseReferenceError,
  IdempotencyConflictError,
  ModelRouteNotReadyError,
  ModelValidationInProgressError,
  type CreateProviderInput,
  type CreateProviderResourceInput,
  type OperatingSnapshotInput,
  type ProviderModelOnboardingResult,
  type ModelValidationResult,
  type DeleteProviderResult,
  type UpdateProviderInput,
  type DeleteResourceSafelyResult,
} from "./provider-types.js";
export type { ProviderOperatingSyncState, ProviderResourceOperatingSnapshot } from "./provider-operating-repository.js";

export type Provider = Selectable<ProviderTable>;
export type ProviderResource = Selectable<ProviderResourceTable>;
export type UnifiedModel = Selectable<UnifiedModelTable>;
export type ModelRoute = Selectable<ModelRouteTable>;
export type ArchiveFilter = "exclude" | "only" | "all";

export class ProviderRepository extends ProviderModelDiscoveryRepository {

  // ===== Provider =====
  async createProvider(input: CreateProviderInput): Promise<Provider> {
    return this.db
      .insertInto("provider")
      .values({
        enterprise_id: input.enterprise_id,
        code: input.code,
        name: input.name,
        adapter_type: input.adapter_type,
        // jsonb 列：JS 数组/对象需显式 JSON.stringify
        supported_protocols: input.supported_protocols
          ? (JSON.stringify(input.supported_protocols) as unknown as string[])
          : null,
        capability_set: input.capability_set
          ? (JSON.stringify(input.capability_set) as unknown as Record<string, unknown>)
          : null,
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listProviders(enterpriseId: string, archived: ArchiveFilter = "exclude"): Promise<Provider[]> {
    return this.db
      .selectFrom("provider")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .$if(archived === "exclude", (qb) => qb.where("archived_at", "is", null))
      .$if(archived === "only", (qb) => qb.where("archived_at", "is not", null))
      .orderBy("created_at", "desc")
      .execute();
  }

  async archiveProvider(
    enterpriseId: string,
    providerId: string,
  ): Promise<{ found: boolean; archived: boolean; reason?: string; provider?: Provider }> {
    const provider = await this.db
      .selectFrom("provider")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", providerId)
      .executeTakeFirst();
    if (!provider || provider.archived_at !== null) {
      return { found: provider !== undefined, archived: false };
    }
    const activeResources = await this.db
      .selectFrom("provider_resource")
      .select((eb) => eb.fn.count<string>("id").as("count"))
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_id", "=", providerId)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    const activeCount = Number(activeResources?.count ?? 0);
    if (activeCount > 0) {
      return {
        found: true,
        archived: false,
        reason: `该厂商名下仍有 ${activeCount} 个未归档的厂商资源，请先归档相关资源后再归档厂商`,
      };
    }
    const updated = await this.db
      .updateTable("provider")
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", providerId)
      .returningAll()
      .executeTakeFirst();
    return { found: true, archived: true, provider: updated };
  }

  async unarchiveProvider(
    enterpriseId: string,
    providerId: string,
  ): Promise<Provider | undefined> {
    return this.db
      .updateTable("provider")
      .set({ archived_at: null, updated_at: new Date() })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", providerId)
      .where("archived_at", "is not", null)
      .returningAll()
      .executeTakeFirst();
  }

  async updateProvider(
    enterpriseId: string,
    providerId: string,
    input: UpdateProviderInput,
  ): Promise<Provider | undefined> {
    return this.db
      .updateTable("provider")
      .set({
        name: input.name,
        updated_at: new Date(),
      })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", providerId)
      .returningAll()
      .executeTakeFirst();
  }

  async deleteProvider(
    enterpriseId: string,
    providerId: string,
  ): Promise<DeleteProviderResult> {
    return deleteProviderSafely(this.db, enterpriseId, providerId);
  }

  async deleteResourceSafely(
    enterpriseId: string,
    resourceId: string,
  ): Promise<DeleteResourceSafelyResult> {
    return deleteProviderResourceSafely(this.db, enterpriseId, resourceId);
  }


  // ===== Provider Resource =====
  async createResource(input: CreateProviderResourceInput): Promise<ProviderResource> {
    return this.db.transaction().execute(async (trx) => {
      const provider = await trx
        .selectFrom("provider")
        .select("id")
        .where("id", "=", input.provider_id)
        .where("enterprise_id", "=", input.enterprise_id)
        .where("status", "=", "ACTIVE")
        .forKeyShare()
        .executeTakeFirst();
      if (!provider) throw new EnterpriseReferenceError("provider is not active in enterprise");

      const resource = await trx
        .insertInto("provider_resource")
        .values({
          enterprise_id: input.enterprise_id,
          provider_id: input.provider_id,
          name: input.name,
          mode: input.mode,
          credential_type: input.credential_type,
          credential_ciphertext: input.credential_encrypted
            ? JSON.stringify(input.credential_encrypted)
            : null,
          credential_fingerprint: input.credential_fingerprint ?? null,
          credential_version: input.credential_encrypted ? 1 : null,
          // jsonb 列：JS 数组需显式 JSON.stringify（否则 PG 当原生数组类型解析失败）
          upstream_models: input.upstream_models
            ? (JSON.stringify(input.upstream_models) as unknown as string[])
            : null,
          concurrency_limit: input.concurrency_limit ?? null,
          status: "ACTIVE",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (input.operating_snapshot) {
        await this.insertOperatingSnapshot(
          trx,
          input.enterprise_id,
          resource.id,
          1,
          input.operating_snapshot,
        );
      }
      return resource;
    });
  }

  async listResources(enterpriseId: string, archived: ArchiveFilter = "exclude"): Promise<ProviderResource[]> {
    return this.db
      .selectFrom("provider_resource")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .$if(archived === "exclude", (qb) => qb.where("archived_at", "is", null))
      .$if(archived === "only", (qb) => qb.where("archived_at", "is not", null))
      .orderBy("created_at", "desc")
      .execute();
  }

  async archiveResource(
    enterpriseId: string,
    resourceId: string,
  ): Promise<ProviderResource | undefined> {
    return this.db
      .updateTable("provider_resource")
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", resourceId)
      .where("archived_at", "is", null)
      .returningAll()
      .executeTakeFirst();
  }

  async unarchiveResource(
    enterpriseId: string,
    resourceId: string,
  ): Promise<ProviderResource | undefined> {
    return this.db
      .updateTable("provider_resource")
      .set({ archived_at: null, updated_at: new Date() })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", resourceId)
      .where("archived_at", "is not", null)
      .returningAll()
      .executeTakeFirst();
  }

  async onboardResourceModels(
    input: OnboardResourceModelsInput,
  ): Promise<ProviderModelOnboardingResult> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`${input.enterpriseId}:${input.idempotencyKey}`}))`
        .execute(trx);
      const prior = await trx.selectFrom("provider_model_onboarding")
        .select(["result", "request_fingerprint"])
        .where("enterprise_id", "=", input.enterpriseId)
        .where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
      if (prior) {
        if (prior.request_fingerprint !== input.requestFingerprint) {
          throw new IdempotencyConflictError();
        }
        return prior.result as unknown as ProviderModelOnboardingResult;
      }
      const provider = await trx.selectFrom("provider").select("id")
        .where("id", "=", input.resource.provider_id)
        .where("enterprise_id", "=", input.enterpriseId).where("status", "=", "ACTIVE")
        .forKeyShare().executeTakeFirst();
      if (!provider) throw new EnterpriseReferenceError("provider is not active in enterprise");
      const resource = await trx.insertInto("provider_resource").values({
        enterprise_id: input.enterpriseId,
        provider_id: input.resource.provider_id,
        name: input.resource.name,
        mode: input.resource.mode,
        credential_type: input.resource.credential_type,
        credential_ciphertext: input.resource.credential_encrypted
          ? JSON.stringify(input.resource.credential_encrypted) : null,
        credential_fingerprint: input.resource.credential_fingerprint ?? null,
        credential_version: input.resource.credential_encrypted ? 1 : null,
        upstream_models: JSON.stringify(input.selectedModels.map((model) => model.id)) as unknown as string[],
        concurrency_limit: input.resource.concurrency_limit ?? null,
        status: "ACTIVE",
      }).returningAll().executeTakeFirstOrThrow();
      if (input.resource.operating_snapshot) {
        await this.insertOperatingSnapshot(trx, input.enterpriseId, resource.id, 1, input.resource.operating_snapshot);
      }
      const discoveryRow = await trx.insertInto("provider_model_discovery").values({
        enterprise_id: input.enterpriseId, provider_resource_id: resource.id,
        source: input.discovery.source, source_version: input.discovery.sourceVersion,
        parser_version: input.discovery.parserVersion,
        source_url: input.discovery.sourceUrl,
        source_etag: input.discovery.sourceEtag,
        source_last_modified: input.discovery.sourceLastModified,
        source_content_hash: input.discovery.sourceContentHash,
        source_checked_at: input.discovery.sourceCheckedAt,
        stale: input.discovery.stale,
        status: "SUCCEEDED", discovered_at: input.discovery.discoveredAt, failure_code: null,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("provider_model_discovery_item").values(input.discovery.models.map((model) => ({
        enterprise_id: input.enterpriseId, discovery_id: discoveryRow.id,
        provider_resource_id: resource.id, upstream_model: model.id,
        display_name: model.displayName, model_type: model.modelType,
        capabilities: JSON.stringify(model.capabilities) as unknown as string[], source: model.source,
        compatible: model.compatible, unavailable_reason: model.unavailableReason,
        facts: model.facts as unknown as Record<string, unknown>,
        availability_status: "AVAILABLE" as const, first_discovered_at: input.discovery.discoveredAt,
        last_discovered_at: input.discovery.discoveredAt,
        last_validated_at: input.discovery.source === "PROVIDER_API" ? input.discovery.discoveredAt : null,
      }))).execute();
      const models: ProviderModelOnboardingResult["models"] = [];
      for (const discovered of input.selectedModels) {
        const alias = stableModelAlias(input.providerCode, discovered.id, discovered.displayName);
        let unified = await trx.selectFrom("unified_model").selectAll()
          .where("enterprise_id", "=", input.enterpriseId).where("alias", "=", alias)
          .executeTakeFirst();
        if (unified?.archived_at) {
          throw new EnterpriseReferenceError("archived model cannot be referenced by onboarding");
        }
        const reused = Boolean(unified);
        if (!unified) {
          unified = await trx.insertInto("unified_model").values({
            enterprise_id: input.enterpriseId, alias, display_name: discovered.displayName,
            required_capabilities: JSON.stringify(discovered.capabilities) as unknown as string[],
            status: "PENDING_CONFIG",
          }).returningAll().executeTakeFirstOrThrow();
        } else {
          unified = await mergeDiscoveredCapabilities(
            trx, input.enterpriseId, unified, discovered.capabilities,
          );
        }
        const route = await trx.insertInto("model_route").values({
          enterprise_id: input.enterpriseId, unified_model_id: unified.id,
          provider_resource_id: resource.id, upstream_model: discovered.id,
          priority: 100, weight: 1, enabled: false,
        }).returningAll().executeTakeFirstOrThrow();
        models.push({
          upstreamModel: discovered.id, unifiedModelId: unified.id, alias,
          routeId: route.id, reused, status: unified.status === "ACTIVE" ? "ACTIVE" : "PENDING_CONFIG",
        });
      }
      const result: ProviderModelOnboardingResult = {
        resourceId: resource.id, discoveryId: discoveryRow.id, models,
      };
      await trx.insertInto("provider_model_onboarding").values({
        enterprise_id: input.enterpriseId, idempotency_key: input.idempotencyKey,
        request_fingerprint: input.requestFingerprint,
        provider_resource_id: resource.id, result: result as unknown as Record<string, unknown>,
      }).execute();
      return result;
    });
  }

  async attachDiscoveredModels(input: {
    enterpriseId: string;
    providerCode: string;
    resourceId: string;
    models: DiscoveredProviderModel[];
  }): Promise<ProviderModelOnboardingResult["models"]> {
    return this.db.transaction().execute(async (trx) => {
      const resource = await trx.selectFrom("provider_resource").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.resourceId)
        .where("status", "in", ["ACTIVE", "DEGRADED"]).forUpdate().executeTakeFirst();
      if (!resource) throw new EnterpriseReferenceError("resource is not serviceable in enterprise");
      const result: ProviderModelOnboardingResult["models"] = [];
      for (const discovered of input.models) {
        const alias = stableModelAlias(input.providerCode, discovered.id, discovered.displayName);
        let unified = await trx.selectFrom("unified_model").selectAll()
          .where("enterprise_id", "=", input.enterpriseId).where("alias", "=", alias)
          .executeTakeFirst();
        if (unified?.archived_at) {
          throw new EnterpriseReferenceError("archived model cannot be referenced by discovery");
        }
        const reused = Boolean(unified);
        if (!unified) {
          unified = await trx.insertInto("unified_model").values({
            enterprise_id: input.enterpriseId, alias, display_name: discovered.displayName,
            required_capabilities: JSON.stringify(discovered.capabilities) as unknown as string[],
            status: "PENDING_CONFIG",
          }).returningAll().executeTakeFirstOrThrow();
        } else {
          unified = await mergeDiscoveredCapabilities(
            trx, input.enterpriseId, unified, discovered.capabilities,
          );
        }
        let route = await trx.selectFrom("model_route").selectAll()
          .where("enterprise_id", "=", input.enterpriseId)
          .where("unified_model_id", "=", unified.id)
          .where("provider_resource_id", "=", resource.id)
          .where("upstream_model", "=", discovered.id).executeTakeFirst();
        if (!route) {
          route = await trx.insertInto("model_route").values({
            enterprise_id: input.enterpriseId, unified_model_id: unified.id,
            provider_resource_id: resource.id, upstream_model: discovered.id,
            priority: 100, weight: 1, enabled: false,
          }).returningAll().executeTakeFirstOrThrow();
        }
        result.push({
          upstreamModel: discovered.id, unifiedModelId: unified.id, alias,
          routeId: route.id, reused, status: unified.status === "ACTIVE" ? "ACTIVE" : "PENDING_CONFIG",
        });
      }
      const upstreamModels = [...new Set([...(resource.upstream_models ?? []), ...input.models.map((model) => model.id)])].sort();
      await trx.updateTable("provider_resource").set({
        upstream_models: JSON.stringify(upstreamModels) as unknown as string[],
        version: sql`version + 1`, updated_at: new Date(),
      }).where("id", "=", resource.id).execute();
      return result;
    });
  }

  // ===== Unified Model =====
  async createUnifiedModel(
    enterpriseId: string,
    alias: string,
    displayName: string,
    requiredCapabilities?: string[] | null,
  ): Promise<UnifiedModel> {
    return this.db
      .insertInto("unified_model")
      .values({
        enterprise_id: enterpriseId,
        alias,
        display_name: displayName,
        required_capabilities: requiredCapabilities
          ? (JSON.stringify(requiredCapabilities) as unknown as string[])
          : null,
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listUnifiedModels(
    enterpriseId: string,
    archived: ArchiveFilter = "exclude",
  ): Promise<UnifiedModel[]> {
    let query = this.db
      .selectFrom("unified_model")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("alias");
    if (archived === "only") query = query.where("archived_at", "is not", null);
    if (archived === "exclude") query = query.where("archived_at", "is", null);
    return query.execute();
  }

  // ===== Model Route =====
  async createRoute(
    enterpriseId: string,
    unifiedModelId: string,
    providerResourceId: string,
    upstreamModel: string,
    opts?: { priority?: number; weight?: number; enabled?: boolean },
  ): Promise<ModelRoute> {
    return this.db.transaction().execute(async (trx) => {
      const [model, resource] = await Promise.all([
        trx
          .selectFrom("unified_model")
          .select("id")
          .where("id", "=", unifiedModelId)
          .where("enterprise_id", "=", enterpriseId)
          .where("status", "=", "ACTIVE")
          .where("archived_at", "is", null)
          .forKeyShare()
          .executeTakeFirst(),
        trx
          .selectFrom("provider_resource")
          .select("id")
          .where("id", "=", providerResourceId)
          .where("enterprise_id", "=", enterpriseId)
          .where("status", "=", "ACTIVE")
          .forKeyShare()
          .executeTakeFirst(),
      ]);
      if (!model || !resource) {
        throw new EnterpriseReferenceError("model or resource is not active in enterprise");
      }
      return trx
        .insertInto("model_route")
        .values({
          enterprise_id: enterpriseId,
          unified_model_id: unifiedModelId,
          provider_resource_id: providerResourceId,
          upstream_model: upstreamModel,
          priority: opts?.priority ?? 100,
          weight: opts?.weight ?? 1,
          enabled: opts?.enabled ?? true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async listRoutesByModel(
    enterpriseId: string,
    unifiedModelId: string,
    archived: ArchiveFilter = "exclude",
  ): Promise<
    Array<ModelRoute & { resource_name: string; resource_status: string }>
  > {
    let query = this.db
      .selectFrom("model_route")
      .innerJoin(
        "provider_resource",
        "provider_resource.id",
        "model_route.provider_resource_id",
      )
      .selectAll("model_route")
      .select([
        "provider_resource.name as resource_name",
        "provider_resource.status as resource_status",
      ])
      .where("model_route.enterprise_id", "=", enterpriseId)
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("model_route.unified_model_id", "=", unifiedModelId)
      .orderBy("model_route.priority", "asc")
      .orderBy("model_route.weight", "desc");
    if (archived === "only") query = query.where("model_route.archived_at", "is not", null);
    if (archived === "exclude") query = query.where("model_route.archived_at", "is", null);
    return query.execute() as Promise<
      Array<ModelRoute & { resource_name: string; resource_status: string }>
    >;
  }

  /** 查询指定厂商资源下挂载的全部模型路由及其统一模型信息。 */
  async listRoutesByResource(
    enterpriseId: string,
    providerResourceId: string,
    archived: ArchiveFilter = "all",
  ): Promise<ResourceRouteItem[]> {
    let query = this.db
      .selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .select([
        "model_route.id",
        "model_route.enterprise_id",
        "model_route.unified_model_id",
        "model_route.provider_resource_id",
        "model_route.upstream_model",
        "model_route.priority",
        "model_route.weight",
        "model_route.enabled",
        "model_route.version",
        "model_route.archived_at",
        "unified_model.alias as unified_model_alias",
        "unified_model.display_name as unified_model_display_name",
        "unified_model.status as unified_model_status",
        "unified_model.archived_at as unified_model_archived_at",
      ])
      .where("model_route.enterprise_id", "=", enterpriseId)
      .where("model_route.provider_resource_id", "=", providerResourceId)
      .orderBy("model_route.archived_at", "asc")
      .orderBy("model_route.enabled", "desc")
      .orderBy("model_route.upstream_model", "asc");

    if (archived === "only") query = query.where("model_route.archived_at", "is not", null);
    if (archived === "exclude") query = query.where("model_route.archived_at", "is", null);

    const routes = await query.execute();
    const now = new Date();
    const billingRules = await this.db.selectFrom("billing_rule")
      .select(["provider_resource_id", "upstream_model"])
      .where("enterprise_id", "=", enterpriseId)
      .where((eb) => eb.or([
        eb("provider_resource_id", "=", providerResourceId),
        eb("provider_resource_id", "is", null),
      ]))
      .where("enabled", "=", true)
      .where("archived_at", "is", null)
      .where("effective_from", "<=", now)
      .where((eb) => eb.or([
        eb("effective_to", "is", null),
        eb("effective_to", ">", now),
      ]))
      .execute();

    return routes.map((r) => {
      const isArchived = r.archived_at !== null || r.unified_model_archived_at !== null;
      let status: "ACTIVE" | "DISABLED" | "ARCHIVED" = "ACTIVE";
      if (isArchived) {
        status = "ARCHIVED";
      } else if (!r.enabled) {
        status = "DISABLED";
      } else {
        status = "ACTIVE";
      }

      const hasBilling = billingRules.some(
        (b) =>
          (!b.provider_resource_id || b.provider_resource_id === providerResourceId) &&
          (!b.upstream_model || b.upstream_model === r.upstream_model),
      );

      return {
        ...r,
        model_alias: r.unified_model_alias || r.upstream_model,
        status,
        has_active_billing_rule: hasBilling,
      };
    });
  }

  /** 一键下架指定厂商资源下的模型：
   * 单事务完成：停用并归档路由 + 停用并归档关联计价规则 +（若无其他路由）停用并归档统一模型 + 撤销员工规则分配。
   */
  async retireResourceModelRoute(
    enterpriseId: string,
    providerResourceId: string,
    routeId: string,
    actorAdminId: string,
  ): Promise<{
    routeId: string;
    upstreamModel: string;
    unifiedModelId: string;
    unifiedModelArchived: boolean;
    billingRulesArchivedCount: number;
  }> {
    return this.db.transaction().execute(async (trx) => {
      const route = await trx.selectFrom("model_route")
        .selectAll()
        .where("enterprise_id", "=", enterpriseId)
        .where("provider_resource_id", "=", providerResourceId)
        .where("id", "=", routeId)
        .executeTakeFirst();
      if (!route) throw new Error("路由不存在或不属于当前厂商资源");

      const now = new Date();

      // 1. 停用并归档 model_route
      await trx.updateTable("model_route")
        .set({
          enabled: false,
          archived_at: now,
          archived_by_admin_id: actorAdminId,
          version: sql`version + 1`,
          updated_at: now,
        })
        .where("id", "=", route.id)
        .where("enterprise_id", "=", enterpriseId)
        .execute();

      // 2. 停用并归档该资源和上游模型关联的所有计价规则
      const billingUpdateResult = await trx.updateTable("billing_rule")
        .set({
          enabled: false,
          archived_at: now,
          archived_by_admin_id: actorAdminId,
          version: sql`version + 1`,
          updated_at: now,
        })
        .where("enterprise_id", "=", enterpriseId)
        .where("provider_resource_id", "=", providerResourceId)
        .where("upstream_model", "=", route.upstream_model)
        .where("archived_at", "is", null)
        .executeTakeFirst();

      const billingRulesArchivedCount = Number(billingUpdateResult.numUpdatedRows ?? 0n);

      // 从 provider_resource.upstream_models 中移除已下架模型
      const currentResource = await trx.selectFrom("provider_resource")
        .select(["id", "upstream_models"])
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", providerResourceId)
        .executeTakeFirst();
      if (currentResource && Array.isArray(currentResource.upstream_models)) {
        const remaining = (currentResource.upstream_models as string[]).filter((m) => m !== route.upstream_model);
        await trx.updateTable("provider_resource")
          .set({
            upstream_models: JSON.stringify(remaining) as unknown as string[],
            version: sql`version + 1`,
            updated_at: now,
          })
          .where("id", "=", providerResourceId)
          .where("enterprise_id", "=", enterpriseId)
          .execute();
      }

      // 3. 检查该统一模型是否还有其他生效且未归档的路由
      const otherRoutes = await trx.selectFrom("model_route")
        .select("id")
        .where("enterprise_id", "=", enterpriseId)
        .where("unified_model_id", "=", route.unified_model_id)
        .where("archived_at", "is", null)
        .execute();

      let unifiedModelArchived = false;
      if (otherRoutes.length === 0) {
        // 无其他活跃路由，自动将统一模型停用并归档
        await trx.updateTable("unified_model")
          .set({
            status: "DISABLED",
            archived_at: now,
            archived_by_admin_id: actorAdminId,
            version: sql`version + 1`,
            updated_at: now,
          })
          .where("id", "=", route.unified_model_id)
          .where("enterprise_id", "=", enterpriseId)
          .execute();
        unifiedModelArchived = true;

        // 撤销对该统一模型的员工规则分配
        await trx.updateTable("employee_model_rule_assignment")
          .set({ status: "DISABLED", disabled_at: now })
          .where("enterprise_id", "=", enterpriseId)
          .where("unified_model_id", "=", route.unified_model_id)
          .where("status", "=", "ACTIVE")
          .execute();
      }

      return {
        routeId: route.id,
        upstreamModel: route.upstream_model,
        unifiedModelId: route.unified_model_id,
        unifiedModelArchived,
        billingRulesArchivedCount,
      };
    });
  }
}

export interface ResourceRouteItem {
  id: string;
  enterprise_id: string;
  unified_model_id: string;
  provider_resource_id: string;
  upstream_model: string;
  priority: number;
  weight: number;
  enabled: boolean;
  version: number;
  archived_at: Date | null;
  model_alias: string;
  status: "ACTIVE" | "DISABLED" | "ARCHIVED";
  unified_model_alias: string;
  unified_model_display_name: string;
  unified_model_status: string;
  unified_model_archived_at: Date | null;
  has_active_billing_rule: boolean;
}
