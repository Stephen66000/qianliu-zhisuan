/**
 * 发布审查：为跨表配置补企业一致性约束。
 *
 * 既有单列外键只能保证对象存在，不能保证 provider/resource/model/route 属于同一企业。
 * 迁移会校验既有数据；若已有跨企业脏数据则升级失败并要求先人工处置，禁止静默放行。
 */

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createIndex("provider_enterprise_id_id_uq")
    .unique()
    .on("provider")
    .columns(["enterprise_id", "id"])
    .execute();
  await db.schema
    .createIndex("provider_resource_enterprise_id_id_uq")
    .unique()
    .on("provider_resource")
    .columns(["enterprise_id", "id"])
    .execute();
  await db.schema
    .createIndex("unified_model_enterprise_id_id_uq")
    .unique()
    .on("unified_model")
    .columns(["enterprise_id", "id"])
    .execute();

  await db.schema
    .alterTable("provider_resource")
    .addForeignKeyConstraint(
      "provider_resource_enterprise_provider_fk",
      ["enterprise_id", "provider_id"],
      "provider",
      ["enterprise_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("model_route")
    .addForeignKeyConstraint(
      "model_route_enterprise_model_fk",
      ["enterprise_id", "unified_model_id"],
      "unified_model",
      ["enterprise_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("model_route")
    .addForeignKeyConstraint(
      "model_route_enterprise_resource_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("billing_rule")
    .addForeignKeyConstraint(
      "billing_rule_enterprise_resource_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .execute();
  await db.schema
    .alterTable("provider_resource_operating_snapshot")
    .addForeignKeyConstraint(
      "operating_snapshot_enterprise_resource_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema
    .alterTable("provider_resource_operating_snapshot")
    .dropConstraint("operating_snapshot_enterprise_resource_fk")
    .execute();
  await db.schema
    .alterTable("billing_rule")
    .dropConstraint("billing_rule_enterprise_resource_fk")
    .execute();
  await db.schema
    .alterTable("model_route")
    .dropConstraint("model_route_enterprise_resource_fk")
    .execute();
  await db.schema
    .alterTable("model_route")
    .dropConstraint("model_route_enterprise_model_fk")
    .execute();
  await db.schema
    .alterTable("provider_resource")
    .dropConstraint("provider_resource_enterprise_provider_fk")
    .execute();

  await db.schema.dropIndex("unified_model_enterprise_id_id_uq").ifExists().execute();
  await db.schema.dropIndex("provider_resource_enterprise_id_id_uq").ifExists().execute();
  await db.schema.dropIndex("provider_enterprise_id_id_uq").ifExists().execute();
}
