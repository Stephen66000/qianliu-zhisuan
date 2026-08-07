import type { Generated } from "kysely";

/** POOL-032：厂商 Coding Plan 额度窗口类型。 */

/** 窗口类型：5 小时滚动 / 周。不同窗口独立保存，禁止互相覆盖。 */
export type QuotaWindowType = "FIVE_HOUR" | "WEEKLY";

/** 数值单位：PERCENT=智谱百分比，POINT=Kimi 100 点制；非 token。 */
export type QuotaWindowUnit = "PERCENT" | "POINT";

/** 同步来源：PROVIDER_SYNC=后台定时，MANUAL_SYNC=管理员手动。 */
export type QuotaWindowSource = "PROVIDER_SYNC" | "MANUAL_SYNC";

/**
 * 同步状态：
 * - SUCCESS：本次同步成功，数值为厂商最新返回。
 * - STALE：本次同步失败，保留上次成功快照（数据可能过期）。
 * - FAILED：从未成功或本次失败且无历史快照可保鲜。
 * - UNSUPPORTED：厂商未提供该窗口（如智谱周额度），不伪造数值。
 */
export type QuotaWindowSyncStatus = "SUCCESS" | "STALE" | "FAILED" | "UNSUPPORTED";

export interface ProviderQuotaWindowTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  window_type: QuotaWindowType;
  is_current: Generated<boolean>;
  /** numeric 字符串承载，TS 侧 string，兼容百分比小数与额度点。 */
  limit_value: string | null;
  used_value: string | null;
  remaining_value: string | null;
  unit: QuotaWindowUnit | null;
  /** used/limit 比率（0-1），便于进度条，可空。 */
  ratio: string | null;
  reset_at: Date | null;
  provider_data_at: Date | null;
  collected_at: Date;
  source: QuotaWindowSource;
  adapter_version: string;
  sync_status: QuotaWindowSyncStatus;
  sync_error_code: string | null;
  last_success_at: Date | null;
  created_at: Generated<Date>;
}
