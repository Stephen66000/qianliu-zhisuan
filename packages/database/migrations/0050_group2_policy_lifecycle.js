/**
 * POOL20-027～029：配置归档生命周期与调度策略时间线。
 *
 * 归档只隐藏当前管理视图，不删除或改写历史引用；取消归档也不会自动启用对象。
 * 调度策略继续使用 DRAFT→VALIDATED→PUBLISHED→RETIRED，历史版本不原地复活。
 */
/** @param {import('kysely').Kysely} db */
export async function up(db) {
  for (const table of ["unified_model", "model_route", "billing_rule"]) {
    await db.schema
      .alterTable(table)
      .addColumn("archived_at", "timestamptz")
      .addColumn("archived_by_admin_id", "uuid", (c) => c.references("admin_user.id"))
      .execute();
  }

  await db.schema
    .alterTable("dispatch_policy")
    .addColumn("copied_from_policy_id", "uuid", (c) => c.references("dispatch_policy.id"))
    .addColumn("created_by_admin_id", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("validated_at", "timestamptz")
    .addColumn("validated_by_admin_id", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("published_at", "timestamptz")
    .addColumn("published_by_admin_id", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("effective_at", "timestamptz")
    .addColumn("retired_at", "timestamptz")
    .addColumn("retired_by_admin_id", "uuid", (c) => c.references("admin_user.id"))
    .execute();

  await db.schema.createIndex("unified_model_archive_idx")
    .on("unified_model").columns(["enterprise_id", "archived_at"]).execute();
  await db.schema.createIndex("model_route_archive_idx")
    .on("model_route").columns(["enterprise_id", "archived_at"]).execute();
  await db.schema.createIndex("billing_rule_archive_idx")
    .on("billing_rule").columns(["enterprise_id", "archived_at"]).execute();
  await db.schema.createIndex("dispatch_policy_timeline_idx")
    .on("dispatch_policy").columns(["enterprise_id", "created_at"]).execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("dispatch_policy_timeline_idx").ifExists().execute();
  await db.schema.dropIndex("billing_rule_archive_idx").ifExists().execute();
  await db.schema.dropIndex("model_route_archive_idx").ifExists().execute();
  await db.schema.dropIndex("unified_model_archive_idx").ifExists().execute();

  await db.schema.alterTable("dispatch_policy")
    .dropColumn("retired_by_admin_id")
    .dropColumn("retired_at")
    .dropColumn("effective_at")
    .dropColumn("published_by_admin_id")
    .dropColumn("published_at")
    .dropColumn("validated_by_admin_id")
    .dropColumn("validated_at")
    .dropColumn("created_by_admin_id")
    .dropColumn("copied_from_policy_id")
    .execute();

  for (const table of ["billing_rule", "model_route", "unified_model"]) {
    await db.schema.alterTable(table)
      .dropColumn("archived_by_admin_id")
      .dropColumn("archived_at")
      .execute();
  }
}
