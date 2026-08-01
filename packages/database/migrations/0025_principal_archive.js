/**
 * POOL-009 —— 使用主体归档标记。
 *
 * 既有数据保持 archived_at=NULL（未归档）；历史请求、Usage 与账本仍通过 principal_id
 * 引用原主体，不做回填或重算。
 */

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("principal")
    .addColumn("archived_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("principal_enterprise_archived_idx")
    .on("principal")
    .columns(["enterprise_id", "archived_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("principal_enterprise_archived_idx").ifExists().execute();
  await db.schema.alterTable("principal").dropColumn("archived_at").execute();
}
