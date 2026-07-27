/**
 * Kysely 迁移框架 —— FileMigrationProvider 从 migrations 目录加载版本化迁移。
 *
 * 工程规则 §2 行 35：迁移文件为 Schema 唯一变更入口。
 * 每个迁移文件 default 导出 { up(db), down(db) } 两个方法。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Migrator, FileMigrationProvider } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./kysely.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_PATH = path.resolve(__dirname, "..", "migrations");

/** 列出 migrations 目录下的迁移文件名（用于 Evidence 与诊断）。 */
export async function listMigrations(): Promise<string[]> {
  const files = await fs.readdir(MIGRATIONS_PATH);
  // 迁移文件用纯 JS（ESM），Node 原生 import 直接加载，不依赖 tsx loader。
  return files.filter((f) => f.endsWith(".js")).sort();
}

/** 构造 Migrator（FileMigrationProvider 默认用 dynamic import；tsx 运行时支持 .ts）。 */
export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATIONS_PATH,
    }),
  });
}

/**
 * 执行迁移到最新。
 * @returns 已执行的迁移名数组。
 */
export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const migrator = createMigrator(db);
  const { results, error } = await migrator.migrateToLatest();
  if (error) {
    throw error;
  }
  const executed: string[] = [];
  for (const r of results ?? []) {
    if (r.status === "Success") executed.push(r.migrationName);
    else if (r.status === "Error") {
      throw new Error(`migration ${r.migrationName} failed`);
    }
  }
  return executed;
}

/**
 * 回滚最近一次迁移。
 * @returns 被回滚的迁移名；无迁移时返回 null。
 */
export async function migrateDown(db: Kysely<Database>): Promise<string | null> {
  const migrator = createMigrator(db);
  const { results, error } = await migrator.migrateDown();
  if (error) {
    throw error;
  }
  const result = results?.[0];
  if (!result) return null;
  if (result.status === "Error") {
    throw new Error(`rollback ${result.migrationName} failed`);
  }
  return result.migrationName;
}
