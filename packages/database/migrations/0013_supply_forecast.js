/**
 * 迁移 0013 —— 供给预测快照（W15）。
 *
 * 依据：TRD §9.2 行 634-640（多窗口消耗速度、forecast_exhaust_at、next_recover_at、
 * 覆盖时长、可信度、每日快照）、§5.4 行 261（resource_runtime_snapshot 口径）。
 *
 * supply_forecast：每资源每日（或余额/周期/速度明显变化时）一条预测快照。
 *   - 消耗速度：1h/24h/7d 窗口（token/小时）；
 *   - forecast_exhaust_at 不晚于资源失效时间；余额未知时为空（不伪精确）；
 *   - next_recover_at 来自厂商周期配置，不从历史规律无标记猜测；
 *   - confidence：HIGH/MEDIUM/LOW/NOT_CALCULABLE（数据点不足不伪精确）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("supply_forecast")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    // 多窗口消耗速度（token/小时）
    .addColumn("rate_1h", "numeric")
    .addColumn("rate_24h", "numeric")
    .addColumn("rate_7d", "numeric")
    // 预测结果
    .addColumn("forecast_exhaust_at", "timestamptz") // 预计耗尽（不晚于失效时间；余额未知为空）
    .addColumn("next_recover_at", "timestamptz") // 下一恢复/重置（厂商周期配置）
    .addColumn("coverage_hours", "numeric") // 覆盖时长（余额/速度，小时）
    .addColumn("remaining_quota", "numeric") // 预测时余额（未知为空）
    // 可信度与数据基础
    .addColumn("confidence", "varchar(16)", (c) => c.notNull())
    .addColumn("data_points", "integer", (c) => c.notNull().defaultTo(0)) // 窗口内 usage_event 数
    .addColumn("not_calculable_reason", "varchar(64)") // 数据不足/余额未知等原因
    .addColumn("algorithm_version", "varchar(32)", (c) => c.notNull()) // 算法版本（自然月偏差校准）
    .addColumn("snapshot_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();

  await sql`ALTER TABLE supply_forecast ADD CONSTRAINT supply_forecast_confidence_check CHECK (confidence IN ('HIGH','MEDIUM','LOW','NOT_CALCULABLE'))`.execute(db);
  await db.schema
    .createIndex("supply_forecast_resource_idx")
    .ifNotExists()
    .on("supply_forecast")
    .columns(["provider_resource_id", "snapshot_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("supply_forecast").ifExists().execute();
}
