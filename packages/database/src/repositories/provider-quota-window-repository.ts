/** POOL-032：厂商 Coding Plan 额度窗口快照仓储。 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type {
  QuotaWindowSource,
  QuotaWindowSyncStatus,
  QuotaWindowType,
  QuotaWindowUnit,
} from "../provider-quota-window-types.js";

/** 写入侧输入：适配器解析出的单个窗口快照。 */
export interface QuotaWindowUpsertInput {
  enterprise_id: string;
  provider_resource_id: string;
  window_type: QuotaWindowType;
  limit_value: string | null;
  used_value: string | null;
  remaining_value: string | null;
  unit: QuotaWindowUnit | null;
  ratio: string | null;
  reset_at: Date | null;
  provider_data_at: Date | null;
  source: QuotaWindowSource;
  adapter_version: string;
  sync_status: QuotaWindowSyncStatus;
  sync_error_code: string | null;
}

/** 读侧投影：当前窗口（含保鲜元数据）。 */
export interface CurrentQuotaWindow {
  id: string;
  provider_resource_id: string;
  window_type: QuotaWindowType;
  limit_value: string | null;
  used_value: string | null;
  remaining_value: string | null;
  unit: QuotaWindowUnit | null;
  ratio: string | null;
  reset_at: Date | null;
  provider_data_at: Date | null;
  collected_at: Date;
  source: QuotaWindowSource;
  adapter_version: string;
  sync_status: QuotaWindowSyncStatus;
  sync_error_code: string | null;
  last_success_at: Date | null;
}

const COLUMNS = [
  "id", "provider_resource_id", "window_type", "limit_value", "used_value",
  "remaining_value", "unit", "ratio", "reset_at", "provider_data_at",
  "collected_at", "source", "adapter_version", "sync_status",
  "sync_error_code", "last_success_at",
] as const;

export class ProviderQuotaWindowRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * 幂等写入当前窗口快照。事务 + 行锁内：旧当前行归档（is_current=false），
   * 插入新当前行；失败时调用方应改用 markStale 保鲜，不调用本方法。
   * 同步成功时 last_success_at = collected_at；UNSUPPORTED 也走此路径（数值为 null）。
   */
  async upsertCurrentWindow(input: QuotaWindowUpsertInput, collectedAt: Date = new Date()): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      // 锁住该资源该窗口的当前行（若存在），避免并发双写。
      await trx.selectFrom("provider_quota_window")
        .select("id")
        .where("provider_resource_id", "=", input.provider_resource_id)
        .where("window_type", "=", input.window_type)
        .where("is_current", "=", true)
        .forUpdate()
        .execute();
      // 归档旧当前行。
      await trx.updateTable("provider_quota_window")
        .set({ is_current: false })
        .where("provider_resource_id", "=", input.provider_resource_id)
        .where("window_type", "=", input.window_type)
        .where("is_current", "=", true)
        .execute();
      // 读旧当前行的 last_success_at 用于延续保鲜时间戳。
      const previous = await trx.selectFrom("provider_quota_window")
        .select("last_success_at")
        .where("provider_resource_id", "=", input.provider_resource_id)
        .where("window_type", "=", input.window_type)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      const lastSuccessAt = input.sync_status === "SUCCESS" || input.sync_status === "UNSUPPORTED"
        ? collectedAt
        : previous?.last_success_at ?? null;
      await trx.insertInto("provider_quota_window").values({
        enterprise_id: input.enterprise_id,
        provider_resource_id: input.provider_resource_id,
        window_type: input.window_type,
        is_current: true,
        limit_value: input.limit_value,
        used_value: input.used_value,
        remaining_value: input.remaining_value,
        unit: input.unit,
        ratio: input.ratio,
        reset_at: input.reset_at,
        provider_data_at: input.provider_data_at,
        collected_at: collectedAt,
        source: input.source,
        adapter_version: input.adapter_version,
        sync_status: input.sync_status,
        sync_error_code: input.sync_error_code,
        last_success_at: lastSuccessAt,
      }).execute();
    });
  }

  /**
   * 同步失败保鲜：不动当前行的数值，只更新 sync_status=STALE/FAILED + 错误码 + collected_at。
   * 若该窗口从未有当前行（首次就失败），插入一条 FAILED 空快照（无数值）。
   */
  async markStale(
    enterpriseId: string,
    providerResourceId: string,
    windowType: QuotaWindowType,
    source: QuotaWindowSource,
    adapterVersion: string,
    errorCode: string,
    collectedAt: Date = new Date(),
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("provider_quota_window")
        .select(["id", "sync_status"])
        .where("provider_resource_id", "=", providerResourceId)
        .where("window_type", "=", windowType)
        .where("is_current", "=", true)
        .forUpdate()
        .executeTakeFirst();
      if (current) {
        // 有历史快照 → 标记 STALE（数据仍可展示，但提示过期）。
        await trx.updateTable("provider_quota_window").set({
          sync_status: "STALE", sync_error_code: errorCode, collected_at: collectedAt,
        }).where("id", "=", current.id).execute();
      } else {
        // 从未成功 → 插入 FAILED 空快照（无数值，前端显示「未同步/失败」）。
        await trx.insertInto("provider_quota_window").values({
          enterprise_id: enterpriseId,
          provider_resource_id: providerResourceId,
          window_type: windowType,
          is_current: true,
          limit_value: null, used_value: null, remaining_value: null,
          unit: null, ratio: null, reset_at: null, provider_data_at: null,
          collected_at: collectedAt, source, adapter_version: adapterVersion,
          sync_status: "FAILED", sync_error_code: errorCode, last_success_at: null,
        }).execute();
      }
    });
  }

  /** 列出企业下所有资源的当前窗口快照。 */
  async listCurrentWindows(enterpriseId: string): Promise<CurrentQuotaWindow[]> {
    return this.db.selectFrom("provider_quota_window")
      .select(COLUMNS)
      .where("enterprise_id", "=", enterpriseId)
      .where("is_current", "=", true)
      .orderBy("provider_resource_id")
      .orderBy("window_type")
      .execute() as Promise<CurrentQuotaWindow[]>;
  }

  /** 列出单个资源的当前窗口快照。 */
  async listCurrentWindowsByResource(providerResourceId: string): Promise<CurrentQuotaWindow[]> {
    return this.db.selectFrom("provider_quota_window")
      .select(COLUMNS)
      .where("provider_resource_id", "=", providerResourceId)
      .where("is_current", "=", true)
      .orderBy("window_type")
      .execute() as Promise<CurrentQuotaWindow[]>;
  }
}
