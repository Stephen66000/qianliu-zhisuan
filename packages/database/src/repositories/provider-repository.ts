/**
 * Provider/Resource/Model/Route 仓储（W04）。
 *
 * 依据：TRD §5.4。
 * 凭证安全：上游 Secret 用 AES-256-GCM 加密后存密文 + 指纹；
 * 明文绝不入库（TRD §5.4 L252）；列表只返回指纹。
 */
import type { Kysely, Selectable } from "kysely";
import type {
  Database,
  ProviderTable,
  ProviderResourceTable,
  UnifiedModelTable,
  ModelRouteTable,
} from "../kysely.js";
import type { EncryptedCredential } from "@qianliu/provider-adapters";

export type Provider = Selectable<ProviderTable>;
export type ProviderResource = Selectable<ProviderResourceTable>;
export type UnifiedModel = Selectable<UnifiedModelTable>;
export type ModelRoute = Selectable<ModelRouteTable>;

export interface CreateProviderInput {
  enterprise_id: string;
  code: string;
  name: string;
  adapter_type: string;
  supported_protocols?: string[] | null;
  capability_set?: Record<string, unknown> | null;
}

export interface CreateProviderResourceInput {
  enterprise_id: string;
  provider_id: string;
  name: string;
  mode: "API" | "CODING_PLAN";
  credential_type: "API_KEY" | "OAUTH" | "SUBSCRIPTION_SESSION";
  /** 凭证密文（调用方先用 encryptCredential 加密）。 */
  credential_encrypted?: EncryptedCredential | null;
  /** 凭证指纹（展示用，不可还原）。 */
  credential_fingerprint?: string | null;
  upstream_models?: string[] | null;
  concurrency_limit?: number | null;
}

export class ProviderRepository {
  constructor(private db: Kysely<Database>) {}

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
    return this.db
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
        upstream_models: input.upstream_models ? JSON.stringify(input.upstream_models) as unknown as string[] : null,
        concurrency_limit: input.concurrency_limit ?? null,
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listResources(enterpriseId: string): Promise<ProviderResource[]> {
    return this.db
      .selectFrom("provider_resource")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("created_at", "desc")
      .execute();
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

  async listUnifiedModels(enterpriseId: string): Promise<UnifiedModel[]> {
    return this.db
      .selectFrom("unified_model")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("alias")
      .execute();
  }

  // ===== Model Route =====
  async createRoute(
    enterpriseId: string,
    unifiedModelId: string,
    providerResourceId: string,
    upstreamModel: string,
    opts?: { priority?: number; weight?: number; enabled?: boolean },
  ): Promise<ModelRoute> {
    return this.db
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
  }

  async listRoutesByModel(enterpriseId: string, unifiedModelId: string): Promise<
    Array<ModelRoute & { resource_name: string; resource_status: string }>
  > {
    return this.db
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
      .where("model_route.unified_model_id", "=", unifiedModelId)
      .orderBy("model_route.priority", "asc")
      .orderBy("model_route.weight", "desc")
      .execute() as Promise<Array<ModelRoute & { resource_name: string; resource_status: string }>>;
  }
}
