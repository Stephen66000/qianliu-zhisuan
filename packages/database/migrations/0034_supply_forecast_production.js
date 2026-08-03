/**
 * POOL-022：供给预测生产快照增加消费单位与幂等键。
 * 历史快照保持可读；新 Worker 快照通过 forecast_key 防止同一 Tick 重复写入。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.alterTable("supply_forecast")
    .addColumn("consumption_unit", "varchar(24)")
    .addColumn("forecast_key", "varchar(160)")
    .execute();
  await sql`ALTER TABLE supply_forecast ADD CONSTRAINT supply_forecast_consumption_unit_check CHECK (consumption_unit IS NULL OR consumption_unit IN ('CURRENCY_PER_HOUR','QUOTA_PER_HOUR'))`.execute(db);
  await db.schema.createIndex("supply_forecast_key_unique")
    .unique()
    .on("supply_forecast")
    .column("forecast_key")
    .where("forecast_key", "is not", null)
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("supply_forecast_key_unique").ifExists().execute();
  await db.schema.alterTable("supply_forecast")
    .dropColumn("forecast_key")
    .dropColumn("consumption_unit")
    .execute();
}
