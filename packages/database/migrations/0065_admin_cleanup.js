/**
 * 管理员清理：采用归档而非物理删除，保留操作日志及经营事实的外键链路。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("admin_user")
    .addColumn("archived_at", "timestamptz")
    .execute();

  await db.schema
    .createIndex("admin_user_enterprise_archived_idx")
    .on("admin_user")
    .columns(["enterprise_id", "archived_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const result =
    await sql`SELECT COUNT(*)::text AS count FROM admin_user WHERE archived_at IS NOT NULL`.execute(
      db,
    );
  if (BigInt(result.rows[0]?.count ?? "0") > 0n) {
    throw new Error(
      "admin cleanup migration cannot roll back while archived administrators exist",
    );
  }
  await db.schema
    .dropIndex("admin_user_enterprise_archived_idx")
    .ifExists()
    .execute();
  await db.schema.alterTable("admin_user").dropColumn("archived_at").execute();
}
