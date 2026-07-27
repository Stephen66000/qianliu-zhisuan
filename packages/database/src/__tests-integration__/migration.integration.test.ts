/**
 * packages/database 集成测试：验证 Kysely 迁移框架 migrate→rollback→migrate 循环。
 *
 * 使用 @qianliu/testing 的 PostgreSQL Testcontainers 工厂（digest 锁定 PG17，与 Compose 一致）。
 * 这是 W01 的关键 Evidence：证明 db:migrate / db:rollback 真实可执行。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import { createKysely, migrateToLatest, migrateDown, listMigrations } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer();
}, 120_000);

afterAll(async () => {
  if (pg) await pg.stop();
}, 60_000);

describe("Kysely 迁移框架（PG17 Testcontainer）", () => {
  it("listMigrations 列出 0000_baseline_probe", async () => {
    const names = await listMigrations();
    expect(names).toContain("0000_baseline_probe.js");
  });

  it("migrateToLatest 建表（含 schema_migrations 与 _w01_baseline_probe）", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const executed = await migrateToLatest(db);
      expect(executed).toContain("0000_baseline_probe");

      // kysely_migration 表（Kysely 默认表名）存在且记录了迁移
      const migrationsRows = await db.selectFrom("kysely_migration").selectAll().execute();
      expect(migrationsRows.length).toBeGreaterThan(0);
      expect(migrationsRows.some((r) => r.name === "0000_baseline_probe")).toBe(true);

      // _w01_baseline_probe 表存在（to_regclass 返回非 null）
      const result = await sql`SELECT to_regclass('public._w01_baseline_probe') AS reg`.execute(db);
      const reg = (result.rows[0] as { reg: string | null }).reg;
      expect(reg).not.toBeNull();
    } finally {
      await db.destroy();
    }
  });

  it("migrateDown 回滚最近迁移，被回滚的表消失", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const rolled = await migrateDown(db);
      // 最后一条迁移是 0009_ledger
      expect(rolled).toBe("0009_ledger");

      // 回滚后 ledger_transaction 表应不存在
      const result = await sql`SELECT to_regclass('public.ledger_transaction') AS reg`.execute(db);
      const reg = (result.rows[0] as { reg: string | null }).reg;
      expect(reg).toBeNull();
    } finally {
      await db.destroy();
    }
  });

  it("再次 migrateToLatest 幂等重建", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const executed = await migrateToLatest(db);
      expect(executed).toContain("0009_ledger");

      const result = await sql`SELECT to_regclass('public.ledger_transaction') AS reg`.execute(db);
      const reg = (result.rows[0] as { reg: string | null }).reg;
      expect(reg).not.toBeNull();
    } finally {
      await db.destroy();
    }
  });
});
