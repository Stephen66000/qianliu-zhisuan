/**
 * 迁移 0006 —— 操作审计日志（W02）。
 *
 * 依据：TRD §5.7（operation_log：管理员操作的对象、变化摘要、结果和时间）。
 * PRD §5.1 L137 / §13 L537：所有管理操作记录操作人、时间、对象、前后变化摘要和结果。
 * 审计内容只存元数据与变化摘要，绝不存正文/Secret（TRD §5.7 L346、§14.3）。
 * 不可篡改：审计记录只追加，不更新/删除（应用层约束 + DB 不提供 update 路径）。
 */
/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("operation_log")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("admin_user_id", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("action", "varchar(64)", (c) => c.notNull()) // e.g. principal.create, key.reset
    .addColumn("target_type", "varchar(64)", (c) => c.notNull()) // e.g. principal, principal_key
    .addColumn("target_id", "uuid")
    .addColumn("change_summary", "jsonb") // 前后变化摘要（脱敏，无 Secret/正文）
    .addColumn("result", "varchar(16)", (c) => c.notNull()) // SUCCESS | FAILURE
    .addColumn("failure_reason", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  // 审计按时间与主体查询
  await db.schema
    .createIndex("operation_log_enterprise_created_idx")
    .ifNotExists()
    .on("operation_log")
    .columns(["enterprise_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("operation_log_target_idx")
    .ifNotExists()
    .on("operation_log")
    .columns(["target_type", "target_id"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("operation_log").ifExists().execute();
}
