import { sql, type Selectable } from "kysely";
import type { ModelDiscoveryResult, DiscoveredProviderModel } from "@qianliu/provider-adapters";
import type { ProviderModelValidationTable } from "../kysely-operations-tables.js";
import { ProviderOperatingRepository } from "./provider-operating-repository.js";
import {
  EnterpriseReferenceError,
  IdempotencyConflictError,
  ModelValidationInProgressError,
  type ModelValidationResult,
} from "./provider-types.js";

type ProviderModelValidation = Selectable<ProviderModelValidationTable>;

/** WP04：一次权限探针运行的持久化输入（全部为脱敏证据，不含 Key/正文）。 */
export interface ModelProbeRunInput {
  enterpriseId: string;
  providerId?: string | null;
  providerResourceId?: string | null;
  providerCode: string;
  resourceMode: "API" | "CODING_PLAN";
  credentialFingerprint: string;
  endpointScope: string;
  endpointHost: string;
  discoverySource?: string | null;
  discoverySourceHash?: string | null;
  parserVersion?: string | null;
  idempotencyKey: string;
  requestHash: string;
  items: Array<{
    upstreamModel: string;
    validationStatus: string;
    httpStatus: number | null;
    errorCode: string | null;
    errorCategory: string | null;
    retryable: boolean;
    diagnosticHash: string | null;
    checkedAt: Date | null;
  }>;
}

/** 模型发现快照、字段 Evidence、双层状态与验证互斥。 */
export abstract class ProviderModelDiscoveryRepository extends ProviderOperatingRepository {
  async getResourceForModelDiscovery(enterpriseId: string, resourceId: string) {
    return this.db.selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .selectAll("provider_resource")
      .select([
        "provider.code as provider_code",
        "provider.name as provider_name",
        "provider.capability_set as provider_capability_set",
      ])
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider.enterprise_id", "=", enterpriseId)
      .where("provider_resource.id", "=", resourceId)
      .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED"])
      .where("provider.status", "=", "ACTIVE")
      .executeTakeFirst();
  }

  /**
   * WP04：持久化一次权限探针运行与模型级明细（加法写入，不影响历史快照）。
   * request_hash 已包含凭证 fingerprint、endpoint scope/host 与官方目录哈希，
   * Key/端点/目录任一变化都会生成新的 request_hash，旧探针结果随之失效。
   * 写入失败由调用方兜底：不回滚已成功的发现快照。
   */
  async recordModelProbeRun(input: ModelProbeRunInput): Promise<string | null> {
    return this.db.transaction().execute(async (trx) => {
      // 幂等：相同 idempotency_key 直接复用已有 run，不重复写入明细。
      const existing = await trx.selectFrom("provider_model_probe_run")
        .select("id")
        .where("enterprise_id", "=", input.enterpriseId)
        .where("idempotency_key", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (existing) return existing.id;
      const run = await trx.insertInto("provider_model_probe_run").values({
        enterprise_id: input.enterpriseId,
        provider_id: input.providerId ?? null,
        provider_resource_id: input.providerResourceId ?? null,
        provider_code: input.providerCode,
        resource_mode: input.resourceMode,
        credential_fingerprint: input.credentialFingerprint,
        endpoint_scope: input.endpointScope as "MODE_SCOPED_CONFIG" | "ENV" | "LEGACY_BASE_URL" | "MODE_DEFAULT",
        endpoint_host: input.endpointHost,
        discovery_source: input.discoverySource ?? null,
        discovery_source_hash: input.discoverySourceHash ?? null,
        parser_version: input.parserVersion ?? null,
        status: "COMPLETED",
        idempotency_key: input.idempotencyKey,
        request_hash: input.requestHash,
        finished_at: new Date(),
      }).returning("id").executeTakeFirstOrThrow();
      if (input.items.length > 0) {
        await trx.insertInto("provider_model_probe_item").values(input.items.map((item) => ({
          probe_run_id: run.id,
          upstream_model: item.upstreamModel,
          validation_status: item.validationStatus as
            "NOT_RUN" | "READY" | "AUTH_FAILED" | "PLAN_NOT_ENTITLED"
            | "REQUEST_REJECTED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "NETWORK_FAILED",
          http_status: item.httpStatus,
          error_code: item.errorCode,
          error_category: item.errorCategory,
          retryable: item.retryable,
          diagnostic_hash: item.diagnosticHash,
          checked_at: item.checkedAt,
        }))).execute();
      }
      return run.id;
    }).catch(() => null);
  }

  /** WP04：最近一次探针运行及其明细（按资源维度；接入前 run 无资源维度返回 null）。 */
  async latestModelProbeRun(enterpriseId: string, resourceId: string) {
    const run = await this.db.selectFrom("provider_model_probe_run")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .orderBy("started_at", "desc")
      .executeTakeFirst();
    if (!run) return null;
    const items = await this.db.selectFrom("provider_model_probe_item")
      .selectAll()
      .where("probe_run_id", "=", run.id)
      .execute();
    return { run, items };
  }

  async recordModelDiscoveryFailure(
    enterpriseId: string,
    resourceId: string,
    input: Pick<ModelDiscoveryResult, "source" | "sourceVersion" | "parserVersion" | "sourceUrl" | "sourceEtag" | "sourceLastModified" | "sourceContentHash" | "sourceCheckedAt" | "discoveredAt"> & {
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
      parser_version: input.parserVersion,
      source_url: input.sourceUrl,
      source_etag: input.sourceEtag,
      source_last_modified: input.sourceLastModified,
      source_content_hash: input.sourceContentHash,
      source_checked_at: input.sourceCheckedAt,
      stale: true,
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
      const previousIds = new Set(previousItems.filter((item) => item.availability_status === "AVAILABLE").map((item) => item.upstream_model));
      const currentIds = new Set(discovery.models.map((model) => model.id));
      const catalogDiff = discovery.stale
        ? null
        : previous
        ? {
            added: [...currentIds].filter((id) => !previousIds.has(id)).sort(),
            retained: [...currentIds].filter((id) => previousIds.has(id)).sort(),
            notAdvertised: [...previousIds].filter((id) => !currentIds.has(id)).sort(),
          }
        : { added: [...currentIds].sort(), retained: [], notAdvertised: [] };
      const historicalFirst = new Map(previousItems.map((item) => [item.upstream_model, item.first_discovered_at]));
      const row = await trx.insertInto("provider_model_discovery").values({
        enterprise_id: enterpriseId,
        provider_resource_id: resourceId,
        source: discovery.source,
        source_version: discovery.sourceVersion,
        parser_version: discovery.parserVersion,
        source_url: discovery.sourceUrl,
        source_etag: discovery.sourceEtag,
        source_last_modified: discovery.sourceLastModified,
        source_content_hash: discovery.sourceContentHash,
        source_checked_at: discovery.sourceCheckedAt,
        stale: discovery.stale,
        status: "SUCCEEDED",
        discovered_at: discovery.discoveredAt,
        failure_code: discovery.failureCode ?? null,
      }).returningAll().executeTakeFirstOrThrow();
      const removed = previousItems.filter((item) => item.availability_status === "AVAILABLE" && !currentIds.has(item.upstream_model));
      const items = [
        ...discovery.models.map((model) => modelItem(enterpriseId, resourceId, row.id, model, discovery, historicalFirst.get(model.id))),
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
          facts: item.facts,
          availability_status: "REMOVED" as const,
          first_discovered_at: item.first_discovered_at,
          last_discovered_at: item.last_discovered_at,
          last_validated_at: item.last_validated_at,
        })),
      ];
      if (items.length > 0) await trx.insertInto("provider_model_discovery_item").values(items).execute();
      // 模型消失只形成 NOT_ADVERTISED 事实，不自动停用既有路由、授权或历史账单。
      return { discovery: row, items, catalogDiff };
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
      successful_discovery: itemDiscovery,
      items,
      items_stale: discovery.status === "FAILED" || discovery.stale,
      items_discovery_id: itemDiscovery?.id ?? null,
    };
  }

  async modelIntegrationStates(enterpriseId: string, resourceId: string, upstreamModels: string[]) {
    if (upstreamModels.length === 0) return [];
    const routes = await this.db.selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .select([
        "model_route.upstream_model", "model_route.enabled", "unified_model.id as unified_model_id",
        "unified_model.status as unified_model_status",
      ])
      .where("model_route.enterprise_id", "=", enterpriseId)
      .where("model_route.provider_resource_id", "=", resourceId)
      .where("model_route.upstream_model", "in", upstreamModels)
      .where("model_route.archived_at", "is", null)
      .execute();
    const unifiedModels = await this.db.selectFrom("unified_model").select(["id", "alias"])
      .where("enterprise_id", "=", enterpriseId)
      .where("alias", "in", upstreamModels.map((model) => stableAlias(model)))
      .where("archived_at", "is", null)
      .execute();
    const validations = await this.db.selectFrom("provider_model_validation")
      .select("upstream_model")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .where("upstream_model", "in", upstreamModels)
      .where("status", "=", "SUCCEEDED")
      .execute();
    const validated = new Set(validations.map((row) => row.upstream_model));
    return upstreamModels.map((upstreamModel) => {
      const route = routes.find((row) => row.upstream_model === upstreamModel);
      if (!route) {
        const modelExists = unifiedModels.some((row) => row.alias === stableAlias(upstreamModel));
        return { upstreamModel, unifiedModelExists: modelExists, currentResourceRoute: "NONE" as const };
      }
      if (route.unified_model_status === "DISABLED") return { upstreamModel, unifiedModelExists: true, currentResourceRoute: "DISABLED" as const };
      if (route.enabled) return { upstreamModel, unifiedModelExists: true, currentResourceRoute: "ACTIVE" as const };
      if (validated.has(upstreamModel)) return { upstreamModel, unifiedModelExists: true, currentResourceRoute: "READY" as const };
      return { upstreamModel, unifiedModelExists: true, currentResourceRoute: "PENDING_CONFIG" as const };
    });
  }

  async validationTarget(enterpriseId: string, resourceId: string, upstreamModel: string) {
    return this.db.selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "model_route.id as route_id", "model_route.unified_model_id", "model_route.provider_resource_id",
        "model_route.upstream_model", "unified_model.status as unified_model_status", "provider.code as provider_code",
        "provider.capability_set as provider_capability_set",
        "provider_resource.mode", "provider_resource.credential_ciphertext",
      ])
      .where("model_route.enterprise_id", "=", enterpriseId)
      .where("model_route.provider_resource_id", "=", resourceId)
      .where("model_route.upstream_model", "=", upstreamModel)
      .where("model_route.archived_at", "is", null)
      .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED"])
      .executeTakeFirst();
  }

  async beginModelValidation(input: {
    enterpriseId: string;
    resourceId: string;
    unifiedModelId: string;
    upstreamModel: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<{ replay: boolean; validation: ProviderModelValidation }> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`${input.enterpriseId}:${input.resourceId}:${input.upstreamModel}`}))`.execute(trx);
      const prior = await trx.selectFrom("provider_model_validation").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("idempotency_key", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (prior) {
        if (prior.request_fingerprint !== input.requestFingerprint) throw new IdempotencyConflictError();
        return { replay: true, validation: prior };
      }
      const inProgress = await trx.selectFrom("provider_model_validation").select("id")
        .where("enterprise_id", "=", input.enterpriseId)
        .where("provider_resource_id", "=", input.resourceId)
        .where("upstream_model", "=", input.upstreamModel)
        .where("status", "=", "IN_PROGRESS")
        .executeTakeFirst();
      if (inProgress) throw new ModelValidationInProgressError();
      const target = await trx.selectFrom("model_route").select("id")
        .where("enterprise_id", "=", input.enterpriseId)
        .where("unified_model_id", "=", input.unifiedModelId)
        .where("provider_resource_id", "=", input.resourceId)
        .where("upstream_model", "=", input.upstreamModel)
        .where("archived_at", "is", null).executeTakeFirst();
      if (!target) throw new EnterpriseReferenceError("model route is not in enterprise");
      const validation = await trx.insertInto("provider_model_validation").values({
        enterprise_id: input.enterpriseId,
        provider_resource_id: input.resourceId,
        unified_model_id: input.unifiedModelId,
        upstream_model: input.upstreamModel,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: input.requestFingerprint,
        status: "IN_PROGRESS",
        result: {},
        started_at: new Date(),
        finished_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      return { replay: false, validation };
    });
  }

  async finishModelValidation(
    enterpriseId: string,
    validationId: string,
    status: "SUCCEEDED" | "FAILED",
    result: ModelValidationResult,
  ) {
    return this.db.updateTable("provider_model_validation")
      .set({ status, result: result as unknown as Record<string, unknown>, finished_at: new Date() })
      .where("enterprise_id", "=", enterpriseId).where("id", "=", validationId)
      .where("status", "=", "IN_PROGRESS")
      .returningAll().executeTakeFirstOrThrow();
  }

  async latestSuccessfulModelValidation(enterpriseId: string, resourceId: string, upstreamModel: string) {
    return this.db.selectFrom("provider_model_validation").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resourceId)
      .where("upstream_model", "=", upstreamModel).where("status", "=", "SUCCEEDED")
      .orderBy("created_at", "desc").executeTakeFirst();
  }
}

function stableAlias(upstreamModel: string): string {
  const slug = upstreamModel.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
  return `ql-${slug || "model"}`;
}

function modelItem(
  enterpriseId: string,
  resourceId: string,
  discoveryId: string,
  model: DiscoveredProviderModel,
  discovery: ModelDiscoveryResult,
  firstDiscoveredAt?: Date,
) {
  return {
    enterprise_id: enterpriseId,
    discovery_id: discoveryId,
    provider_resource_id: resourceId,
    upstream_model: model.id,
    display_name: model.displayName,
    model_type: model.modelType,
    capabilities: JSON.stringify(model.capabilities) as unknown as string[],
    source: model.source,
    compatible: model.compatible,
    unavailable_reason: model.unavailableReason,
    facts: model.facts as unknown as Record<string, unknown>,
    availability_status: "AVAILABLE" as const,
    first_discovered_at: firstDiscoveredAt ?? discovery.discoveredAt,
    last_discovered_at: discovery.discoveredAt,
    last_validated_at: model.source === "PROVIDER_API" ? discovery.discoveredAt : null,
  };
}
