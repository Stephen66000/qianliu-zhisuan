/**
 * 迁移 0000 —— W01 基线探针。
 *
 * 目的：证明 Kysely 迁移框架 up/down 真实可执行。
 * 创建一张占位表 _w01_baseline_probe，后续工作包不会使用它；
 * W02 起的业务表迁移文件由对应工作包创建（同样用纯 JS，Node 原生 import 直接加载）。
 *
 * 迁移文件刻意用纯 JS（ESM）：Kysely FileMigrationProvider 用原生 import() 加载，
 * 纯 JS 不依赖 tsx loader，在 vitest 与 node 环境下行为一致。
 * Kysely Migrator 会自动创建 schema_migrations 表（无需在此建）。
 */
/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("_w01_baseline_probe")
    .ifNotExists()
    .addColumn("id", "serial", (col) => col.primaryKey())
    .addColumn("note", "varchar(255)")
    .addColumn("created_at", "timestamptz", (col) => col.defaultTo("now()").notNull())
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("_w01_baseline_probe").ifExists().execute();
}
