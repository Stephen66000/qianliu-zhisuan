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
  Database,
  ProviderTable,
  ProviderResourceTable,
  ProviderResourceOperatingSnapshotTable,
  UnifiedModelTable,
  ModelRouteTable,
} from "../kysely.js";
import type { EncryptedCredential } from "@qianliu/provider-adapters";
import {
  projectCurrentOperatingSnapshots,
  type CurrentProviderOperatingSnapshot,
} from "./provider-operating.js";

export type Provider = Selectable<ProviderTable>;
export type ProviderResource = Selectable<ProviderResourceTable>;
export type ProviderResourceOperatingSnapshot =
  Selectable<ProviderResourceOperatingSnapshotTable>;
export type UnifiedModel = Selectable<UnifiedModelTable>;
export type ModelRoute = Selectable<ModelRouteTable>;

export class EnterpriseReferenceError extends Error {
  constructor(message: string = "referenced object does not belong to enterprise") {
    super(message);
    this.name = "EnterpriseReferenceError";
  }
}

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
  operating_snapshot?: OperatingSnapshotInput;
}

/** 所有金额/额度均为十进制文本，避免 JS number 精度损失。 */
export interface OperatingSnapshotInput {
  source: "ADMIN" | "PROVIDER_SYNC" | "BILL_RECONCILIATION";
  collected_at: Date;
  currency?: string | null;
  recharge_amount?: string | null;
  current_balance?: string | null;
  cumulative_cost?: string | null;
  current_period_cost?: string | null;
  cost_period_start?: Date | null;
  cost_period_end?: Date | null;
  balance_updated_at?: Date | null;
  package_name?: string | null;
  package_cost?: string | null;
  total_quota?: string | null;
  quota_unit?: string | null;
  used_quota?: string | null;
  remaining_quota?: string | null;
  effective_from?: Date | null;
  effective_until?: Date | null;
  reset_cycle?: string | null;
  reset_anchor_at?: Date | null;
  reset_timezone?: string | null;
  usage_calculation?: "MANUAL_SNAPSHOT" | "SYSTEM_LEDGER";
  next_reset_at?: Date | null;
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

  /** 每个资源当前快照；历史行仍保留且从不随当前值修改而重算。 */
  async listLatestOperatingSnapshots(
    enterpriseId: string,
  ): Promise<ProviderResourceOperatingSnapshot[]> {
    const result = await sql<ProviderResourceOperatingSnapshot>`
      SELECT DISTINCT ON (provider_resource_id) *
        FROM provider_resource_operating_snapshot
       WHERE enterprise_id = ${enterpriseId}
       ORDER BY provider_resource_id, version DESC
    `.execute(this.db);
    return result.rows;
  }

  /**
   * 当前经营视图：旧快照原样返回；SYSTEM_LEDGER 快照按当前重置周期汇总账本。
   * 历史快照行保持不可变，自动值只存在于当前读取投影。
   */
  async listCurrentOperatingSnapshots(
    enterpriseId: string,
    now: Date = new Date(),
  ): Promise<CurrentProviderOperatingSnapshot[]> {
    const [snapshots, resources] = await Promise.all([
      this.listLatestOperatingSnapshots(enterpriseId),
      this.listResources(enterpriseId),
    ]);
    return projectCurrentOperatingSnapshots(
      this.db,
      enterpriseId,
      snapshots,
      new Map(resources.map((resource) => [resource.id, resource.mode])),
      now,
    );
  }

  async listOperatingSnapshotHistory(
    enterpriseId: string,
    providerResourceId: string,
    limit: number = 20,
  ): Promise<ProviderResourceOperatingSnapshot[]> {
    return this.db
      .selectFrom("provider_resource_operating_snapshot")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", providerResourceId)
      .orderBy("version", "desc")
      .limit(limit)
      .execute();
  }

  async appendOperatingSnapshot(
    enterpriseId: string,
    providerResourceId: string,
    input: OperatingSnapshotInput,
  ): Promise<ProviderResourceOperatingSnapshot | null> {
    return this.db.transaction().execute(async (trx) => {
      const resource = await trx
        .selectFrom("provider_resource")
        .select("id")
        .where("id", "=", providerResourceId)
        .where("enterprise_id", "=", enterpriseId)
        .forUpdate()
        .executeTakeFirst();
      if (!resource) return null;
      const latest = await trx
        .selectFrom("provider_resource_operating_snapshot")
        .select("version")
        .where("provider_resource_id", "=", providerResourceId)
        .orderBy("version", "desc")
        .executeTakeFirst();
      return this.insertOperatingSnapshot(
        trx,
        enterpriseId,
        providerResourceId,
        (latest?.version ?? 0) + 1,
        input,
      );
    });
  }

  private async insertOperatingSnapshot(
    db: Kysely<Database>,
    enterpriseId: string,
    providerResourceId: string,
    version: number,
    input: OperatingSnapshotInput,
  ): Promise<ProviderResourceOperatingSnapshot> {
    return db
      .insertInto("provider_resource_operating_snapshot")
      .values({
        enterprise_id: enterpriseId,
        provider_resource_id: providerResourceId,
        version,
        source: input.source,
        collected_at: input.collected_at,
        currency: input.currency ?? null,
        recharge_amount: input.recharge_amount ?? null,
        current_balance: input.current_balance ?? null,
        cumulative_cost: input.cumulative_cost ?? null,
        current_period_cost: input.current_period_cost ?? null,
        cost_period_start: input.cost_period_start ?? null,
        cost_period_end: input.cost_period_end ?? null,
        balance_updated_at: input.balance_updated_at ?? null,
        package_name: input.package_name ?? null,
        package_cost: input.package_cost ?? null,
        total_quota: input.total_quota ?? null,
        quota_unit: input.quota_unit ?? null,
        used_quota: input.used_quota ?? null,
        remaining_quota: input.remaining_quota ?? null,
        effective_from: input.effective_from ?? null,
        effective_until: input.effective_until ?? null,
        reset_cycle: input.reset_cycle ?? null,
        reset_anchor_at: input.reset_anchor_at ?? null,
        reset_timezone: input.reset_timezone ?? null,
        usage_calculation: input.usage_calculation ?? "MANUAL_SNAPSHOT",
        next_reset_at: input.next_reset_at ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
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
    return this.db.transaction().execute(async (trx) => {
      const [model, resource] = await Promise.all([
        trx
          .selectFrom("unified_model")
          .select("id")
          .where("id", "=", unifiedModelId)
          .where("enterprise_id", "=", enterpriseId)
          .where("status", "=", "ACTIVE")
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
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("model_route.unified_model_id", "=", unifiedModelId)
      .orderBy("model_route.priority", "asc")
      .orderBy("model_route.weight", "desc")
      .execute() as Promise<Array<ModelRoute & { resource_name: string; resource_status: string }>>;
  }
}
