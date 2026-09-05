/**
 * 当前订阅额度配置必须显式归属订阅周期。
 *
 * 历史 migration_source_record_id 只能锁定切换时的原始记录，
 * 无法表达后续管理员保存的新额度配置。新关联保持旧记录
 * 不变，同时让后续配置成为可审计的当前周期事实。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely<any>} db */
export async function up(db) {
  await db.schema.alterTable("provider_resource_operating_snapshot")
    .addColumn("subscription_period_id", "uuid").execute();
  await db.schema.alterTable("provider_resource_operating_snapshot")
    .addForeignKeyConstraint(
      "operating_snapshot_subscription_period_tenant_fk",
      ["enterprise_id", "provider_resource_id", "subscription_period_id"],
      "provider_subscription_period",
      ["enterprise_id", "provider_resource_id", "id"],
    ).execute();
  await db.schema.createIndex("operating_snapshot_subscription_period_idx")
    .on("provider_resource_operating_snapshot")
    .columns(["enterprise_id", "provider_resource_id", "subscription_period_id", "version"])
    .where("subscription_period_id", "is not", null)
    .execute();
}

/** @param {import('kysely').Kysely<any>} db */
export async function down(db) {
  await sql`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM provider_resource_operating_snapshot
       WHERE subscription_period_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION '0063 rollback blocked: subscription-bound operating facts exist';
    END IF;
  END $$`.execute(db);
  await db.schema.dropIndex("operating_snapshot_subscription_period_idx").execute();
  await db.schema.alterTable("provider_resource_operating_snapshot")
    .dropConstraint("operating_snapshot_subscription_period_tenant_fk").execute();
  await db.schema.alterTable("provider_resource_operating_snapshot")
    .dropColumn("subscription_period_id").execute();
}
