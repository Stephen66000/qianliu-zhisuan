/**
 * @qianliu/database — Kysely dialect、Schema 类型与迁移框架入口。
 *
 * 工程规则 §2 行 35：迁移文件为 Schema 唯一变更入口。
 * TRD §4：Kysely 0.28.7 + pg 8.16.3；金额字段使用 PostgreSQL numeric + decimal.js。
 *
 * W01 提供：
 *   1. createKysely —— 从 DATABASE_URL 构造 Kysely 实例。
 *   2. Database 类型 —— Kysely 的强类型 Schema 根；M1/M2 逐步添加业务表。
 *   3. migrations 目录 —— 版本化迁移文件（纯 JS，Node 原生 import 加载）；Kysely Migrator 自动管理 kysely_migration 表。
 *   4. migrate.ts CLI —— db:migrate / db:rollback 命令实现。
 */
export { createKysely, type Database } from "./kysely.js";
export {
  MIGRATIONS_PATH,
  listMigrations,
  migrateToLatest,
  migrateDown,
} from "./migrator.js";

export const DATABASE_VERSION = "0.3.0" as const;
