/**
 * Kysely 实例工厂与强类型 Database Schema 根。
 *
 * W01 只定义 schema_migrations 表；M1/M2 在后续工作包追加业务表到 Database 接口。
 * 金额字段统一用 string + numeric（decimal.js 处理），避免 JS number 精度问题。
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

/**
 * Kysely migrator 内部表行类型。
 * 默认表名 kysely_migration（记录已执行迁移）+ kysely_migration_lock（并发锁）。
 */
export interface KyselyMigrationTable {
  name: string;
}

export interface KyselyMigrationLockTable {
  id: number;
}

/**
 * Database Schema 根类型。
 * W01 阶段只有 Kysely migrator 的两张内部表 + 基线探针表；
 * 业务表由后续工作包迁移文件创建并在此接口追加。
 */
export interface Database {
  kysely_migration: KyselyMigrationTable;
  kysely_migration_lock: KyselyMigrationLockTable;
  _w01_baseline_probe: { id: number; note: string | null; created_at: Date };
}

/**
 * 从 DATABASE_URL 构造 Kysely 实例。
 * @param databaseUrl PostgreSQL 连接串；默认读 process.env.DATABASE_URL。
 */
export function createKysely(databaseUrl?: string): Kysely<Database> {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required (set in .env or process.env)");
  }
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url }),
    }),
  });
}
