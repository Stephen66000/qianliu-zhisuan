/**
 * 迁移 0010 —— 资源池与凭证生命周期字段（W11）。
 *
 * 依据：TRD §5.4 行 237/243-249（resource_pool_id、凭证过期/刷新、健康/冷却）、
 *       §9 行 598（熔断/冷却/半开）、§14 行 853（凭证事件审计：隔离→恢复需留痕）。
 *
 * 变更：
 *   1. provider_resource 增加：
 *      - resource_pool_id（同池账号分组，WT-07 切换同池账号）
 *      - credential_expires_at / credential_refresh_status / last_refresh_at / refresh_error_classification（凭证刷新生命周期）
 *      - consecutive_failures / cooldown_until / last_probe_at（熔断/冷却/半开派生状态）
 *      - CHECK 约束：credential_refresh_status ∈ (OK, REFRESHING, FAILED)
 *   2. 新表 resource_status_event：资源状态迁移审计（每次迁移一行，不可覆盖）。
 *
 * 状态机推导规则在 @qianliu/domain resource-lifecycle.ts（确定性、可回放）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("provider_resource")
    .addColumn("resource_pool_id", "varchar(64)")
    .addColumn("credential_expires_at", "timestamptz")
    .addColumn("credential_refresh_status", "varchar(16)", (c) => c.notNull().defaultTo("OK"))
    .addColumn("last_refresh_at", "timestamptz")
    .addColumn("refresh_error_classification", "varchar(48)")
    .addColumn("consecutive_failures", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("cooldown_until", "timestamptz")
    .addColumn("last_probe_at", "timestamptz")
    .execute();

  await sql`ALTER TABLE provider_resource ADD CONSTRAINT provider_resource_refresh_status_check CHECK (credential_refresh_status IN ('OK', 'REFRESHING', 'FAILED'))`.execute(db);
  await sql`ALTER TABLE provider_resource ADD CONSTRAINT provider_resource_failures_nonneg CHECK (consecutive_failures >= 0)`.execute(db);

  await db.schema
    .createIndex("provider_resource_pool_idx")
    .ifNotExists()
    .on("provider_resource")
    .columns(["enterprise_id", "resource_pool_id", "status"])
    .execute();

  // resource_status_event：状态迁移审计（WT-19 隔离/恢复留痕；不可覆盖）
  await db.schema
    .createTable("resource_status_event")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("from_status", "varchar(32)")
    .addColumn("to_status", "varchar(32)", (c) => c.notNull())
    .addColumn("reason", "varchar(64)", (c) => c.notNull()) // 见 domain STATE_REASON
    .addColumn("error_classification", "varchar(48)")
    .addColumn("consecutive_failures", "integer")
    .addColumn("cooldown_until", "timestamptz")
    .addColumn("actor", "varchar(32)", (c) => c.notNull().defaultTo("system")) // system | admin
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();

  await db.schema
    .createIndex("resource_status_event_resource_idx")
    .ifNotExists()
    .on("resource_status_event")
    .columns(["provider_resource_id", "created_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("resource_status_event").ifExists().execute();
  await db.schema
    .alterTable("provider_resource")
    .dropColumn("resource_pool_id")
    .dropColumn("credential_expires_at")
    .dropColumn("credential_refresh_status")
    .dropColumn("last_refresh_at")
    .dropColumn("refresh_error_classification")
    .dropColumn("consecutive_failures")
    .dropColumn("cooldown_until")
    .dropColumn("last_probe_at")
    .execute();
}
