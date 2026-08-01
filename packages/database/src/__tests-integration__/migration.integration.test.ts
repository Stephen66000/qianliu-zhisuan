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

  it("POOL-007 迁移分离追踪 ID、请求指纹与认证 Key 范围幂等唯一索引", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const columns = await sql`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'ai_request'
           AND column_name IN ('client_request_id', 'request_fingerprint')
         ORDER BY column_name
      `.execute(db);
      expect(columns.rows.map((row) => (row as { column_name: string }).column_name)).toEqual([
        "client_request_id",
        "request_fingerprint",
      ]);

      const index = await sql`
        SELECT indexdef
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'ai_request_principal_key_idempotency_uq'
      `.execute(db);
      expect((index.rows[0] as { indexdef: string }).indexdef).toContain(
        "(principal_key_id, idempotency_key)",
      );
      expect((index.rows[0] as { indexdef: string }).indexdef).toContain(
        "WHERE (idempotency_key IS NOT NULL)",
      );
    } finally {
      await db.destroy();
    }
  });

  it("migrateDown 回滚最近迁移", async () => {
    const db = createKysely(pg.connectionString);
    try {
      // 最后一条迁移（动态取，随新增迁移自动跟进）
      const names = await listMigrations();
      const last = names[names.length - 1]!.replace(/\.js$/, "");
      const rolled = await migrateDown(db);
      // 验证回滚真实执行且回滚的就是最后一条
      expect(rolled).toBe(last);
    } finally {
      await db.destroy();
    }
  });

  it("再次 migrateToLatest 幂等重建", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const names = await listMigrations();
      const last = names[names.length - 1]!.replace(/\.js$/, "");
      const executed = await migrateToLatest(db);
      expect(executed).toContain(last);

      // reconciliation_run 在 0015 建立；回滚+重建最后一条（0016 只改约束，不动表）后应仍在
      const result = await sql`SELECT to_regclass('public.reconciliation_run') AS reg`.execute(db);
      const reg = (result.rows[0] as { reg: string | null }).reg;
      expect(reg).not.toBeNull();
    } finally {
      await db.destroy();
    }
  });
});
