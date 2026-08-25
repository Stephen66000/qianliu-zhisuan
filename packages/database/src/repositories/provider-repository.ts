/**
 * Provider/Resource/Model/Route 仓储（W04）。
 *
 * 依据：TRD §5.4。
 * 凭证安全：上游 Secret 用 AES-256-GCM 加密后存密文 + 指纹；
 * 明文绝不入库（TRD §5.4 L252）；列表只返回指纹。
 */
import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type {
  ProviderTable,
  ProviderResourceTable,
  UnifiedModelTable,
  ModelRouteTable,
  Database,
} from "../kysely.js";
import type { DiscoveredProviderModel } from "@qianliu/provider-adapters";
import { ProviderModelDiscoveryRepository } from "./provider-model-discovery-repository.js";
import {
  EnterpriseReferenceError,
  IdempotencyConflictError,
  type CreateProviderInput,
  type CreateProviderResourceInput,
  type OnboardResourceModelsInput,
  type ProviderModelOnboardingResult,
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

  async listProviders(enterpriseId: string): Promise<Provider[]> {
    return this.db
      .selectFrom("provider")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("created_at", "desc")
      .execute();
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

  async listResources(enterpriseId: string): Promise<ProviderResource[]> {
    return this.db
      .selectFrom("provider_resource")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("created_at", "desc")
      .execute();
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
}

/**
 * POOL-038：alias 格式从 `qianliu-{provider}-{model}` 改为 `ql-{display_name}`。
 * 优先用 display_name（客户端可见名），回退 upstreamModel；保留 providerCode 做 fallback
 * 防止跨厂商同名 display_name 撞唯一约束（display_name 无唯一约束）。
 */
function stableModelAlias(providerCode: string, upstreamModel: string, displayName?: string): string {
  const base = displayName ?? upstreamModel;
  const slug = base.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
  return `ql-${slug}`.slice(0, 64);
}

async function mergeDiscoveredCapabilities(
  trx: Kysely<Database>,
  enterpriseId: string,
  unified: UnifiedModel,
  discovered: string[],
): Promise<UnifiedModel> {
  const merged = [...new Set([...(unified.required_capabilities ?? []), ...discovered])].sort();
  const current = [...(unified.required_capabilities ?? [])].sort();
  if (merged.length === current.length && merged.every((value, index) => value === current[index])) {
    return unified;
  }
  return trx.updateTable("unified_model").set({
    required_capabilities: JSON.stringify(merged) as unknown as string[],
    version: sql`version + 1`,
    updated_at: new Date(),
  }).where("enterprise_id", "=", enterpriseId).where("id", "=", unified.id)
    .returningAll().executeTakeFirstOrThrow();
}
