import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { WP4_IDS } from "./seed-e2e-wp4-ids.js";

/**
 * §1b S3a-2 官方余额状态扩展夹具（过期／从未成功／同账户两 Key）＋供给预测"不可计算"快照。
 * 由 seed-e2e-wp4.ts 在三态（OK/FAILED 保鲜值）夹具之后、F01 估算夹具之前原序调用。
 *
 * syncDay 为调用方按上海自然日口径（shanghaiSyncDay）算出的同步日，与本文件各行原值一致。
 */
export async function seedWp4OfficialBalanceStates(
  db: Kysely<Database>,
  enterpriseId: string,
  syncDay: Date,
  now: Date,
): Promise<void> {
  const minuteAgo = (ms: number) => new Date(now.getTime() - ms);
  // G14（AT-OAB-04）：过期资源——成功快照 40，collected_at 早于 P2（30 分钟过期阈值）
  //   2 小时 → C2 状态 EXPIRED，页面显示"数据过期"标记＋保鲜值 40。
  // G15（AT-OAB-08）：从未成功资源——无任何快照，仅一条 FAILED attempt（上游 401）→
  //   余额 null 显示"暂无官方数据"，绝不冒充 0 元。
  // G16（AT-OAB-09）：同一 provider（states 集成夹具 :173 的"已确认同账户"数据层表达
  //   ＝同 provider_id 下两个资源）各查得 100 → 两行独立展示，无任何合计字段。
  await db.insertInto("provider_resource").values([
    {
      id: WP4_IDS.expiredResource, enterprise_id: enterpriseId, provider_id: WP4_IDS.provider,
      name: "DeepSeek 官方余额 E2E（数据过期）", mode: "API", credential_type: "API_KEY",
      status: "ACTIVE", created_at: minuteAgo(30 * 86_400_000),
    },
    {
      id: WP4_IDS.neverResource, enterprise_id: enterpriseId, provider_id: WP4_IDS.provider,
      name: "DeepSeek 官方余额 E2E（从未成功）", mode: "API", credential_type: "API_KEY",
      status: "ACTIVE", created_at: minuteAgo(30 * 86_400_000),
    },
    {
      id: WP4_IDS.pairAResource, enterprise_id: enterpriseId, provider_id: WP4_IDS.provider,
      name: "DeepSeek 官方余额 E2E（同账户 A）", mode: "API", credential_type: "API_KEY",
      status: "ACTIVE", created_at: minuteAgo(30 * 86_400_000),
    },
    {
      id: WP4_IDS.pairBResource, enterprise_id: enterpriseId, provider_id: WP4_IDS.provider,
      name: "DeepSeek 官方余额 E2E（同账户 B）", mode: "API", credential_type: "API_KEY",
      status: "ACTIVE", created_at: minuteAgo(30 * 86_400_000),
    },
  ]).execute();
  await db.insertInto("provider_resource_operating_snapshot").values([
    {
      id: WP4_IDS.expiredSnapshot, enterprise_id: enterpriseId,
      provider_resource_id: WP4_IDS.expiredResource,
      version: 1, source: "PROVIDER_SYNC", balance_source: "PROVIDER_API",
      collected_at: minuteAgo(2 * 3_600_000), currency: "CNY",
      current_balance: "40", granted_balance: "0", topped_up_balance: "40",
      provider_balance_available: true, balance_updated_at: minuteAgo(2 * 3_600_000),
    },
    {
      id: WP4_IDS.pairASnapshot, enterprise_id: enterpriseId,
      provider_resource_id: WP4_IDS.pairAResource,
      version: 1, source: "PROVIDER_SYNC", balance_source: "PROVIDER_API",
      collected_at: minuteAgo(45_000), currency: "CNY",
      current_balance: "100", granted_balance: "0", topped_up_balance: "100",
      provider_balance_available: true, balance_updated_at: minuteAgo(45_000),
    },
    {
      id: WP4_IDS.pairBSnapshot, enterprise_id: enterpriseId,
      provider_resource_id: WP4_IDS.pairBResource,
      version: 1, source: "PROVIDER_SYNC", balance_source: "PROVIDER_API",
      collected_at: minuteAgo(90_000), currency: "CNY",
      current_balance: "100", granted_balance: "0", topped_up_balance: "100",
      provider_balance_available: true, balance_updated_at: minuteAgo(90_000),
    },
  ]).execute();
  await db.insertInto("provider_resource_operating_sync_attempt").values([
    {
      id: WP4_IDS.expiredAttempt, enterprise_id: enterpriseId,
      provider_resource_id: WP4_IDS.expiredResource,
      sync_day: syncDay, balance_status: "SUCCESS", cost_status: "NOT_SUPPORTED",
      snapshot_id: WP4_IDS.expiredSnapshot, provider_data_at: minuteAgo(2 * 3_600_000),
      started_at: minuteAgo(2 * 3_600_000 + 5_000), completed_at: minuteAgo(2 * 3_600_000),
      next_sync_at: new Date(now.getTime() + 15 * 60_000),
      error_code: null, failure_reason: null, adapter_version: "wp4-e2e-v1",
    },
    {
      // G15：从未成功——只有 FAILED attempt、没有任何快照（区别于 failedResource 的保鲜场景）。
      id: WP4_IDS.neverAttempt, enterprise_id: enterpriseId,
      provider_resource_id: WP4_IDS.neverResource,
      sync_day: syncDay, balance_status: "FAILED", cost_status: "NOT_SUPPORTED",
      snapshot_id: null, provider_data_at: null,
      started_at: minuteAgo(20_000), completed_at: minuteAgo(19_000),
      next_sync_at: new Date(now.getTime() + 15 * 60_000),
      error_code: "UPSTREAM_AUTH_FAILED",
      failure_reason: "E2E 合成失败场景：上游 401 鉴权失败（从未成功，无保鲜值可显示）",
      adapter_version: "wp4-e2e-v1",
    },
    {
      id: WP4_IDS.pairAAttempt, enterprise_id: enterpriseId,
      provider_resource_id: WP4_IDS.pairAResource,
      sync_day: syncDay, balance_status: "SUCCESS", cost_status: "NOT_SUPPORTED",
      snapshot_id: WP4_IDS.pairASnapshot, provider_data_at: minuteAgo(45_000),
      started_at: minuteAgo(50_000), completed_at: minuteAgo(45_000),
      next_sync_at: new Date(now.getTime() + 15 * 60_000),
      error_code: null, failure_reason: null, adapter_version: "wp4-e2e-v1",
    },
    {
      id: WP4_IDS.pairBAttempt, enterprise_id: enterpriseId,
      provider_resource_id: WP4_IDS.pairBResource,
      sync_day: syncDay, balance_status: "SUCCESS", cost_status: "NOT_SUPPORTED",
      snapshot_id: WP4_IDS.pairBSnapshot, provider_data_at: minuteAgo(90_000),
      started_at: minuteAgo(95_000), completed_at: minuteAgo(90_000),
      next_sync_at: new Date(now.getTime() + 15 * 60_000),
      error_code: null, failure_reason: null, adapter_version: "wp4-e2e-v1",
    },
  ]).execute();
  // G19/G20（AT-OAB-13/14）：过期资源的供给预测"不可计算"快照——forecast_exhaust_at 为空
  // ＋not_calculable_reason（worker 对 official_balance_expired 的合成输出）。
  // /supply-forecasts 门禁：快照 remaining（API=current_balance 40）须与 forecast
  // remaining_quota 相等且 snapshot_at 不早于快照 calculated_at（+2s 余量）。
  await db.insertInto("supply_forecast").values({
    id: WP4_IDS.expiredForecast, enterprise_id: enterpriseId,
    provider_resource_id: WP4_IDS.expiredResource,
    rate_1h: null, rate_24h: null, rate_7d: null,
    forecast_exhaust_at: null, next_recover_at: null, coverage_hours: null,
    remaining_quota: "40", confidence: "LOW", data_points: 24,
    not_calculable_reason: "官方余额数据过期，暂不可计算（OAB-14 合成夹具）",
    algorithm_version: "wp4-e2e-v1", snapshot_at: new Date(now.getTime() + 2_000),
  }).execute();
}
