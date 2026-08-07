import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer(); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("0040 员工模型授权规则厂商级额度迁移", () => {
  it("新增 pool_quotas jsonb 列（默认 []），支持读写厂商级额度并回滚", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      // 迁移到 0039，建出规则版本表（含 0039 放宽的 quota_value 可空）。
      expect((await migrator.migrateTo("0039_principal_provider_pool")).error).toBeUndefined();

      // 迁移前 pool_quotas 列不存在。
      const beforeCols = await sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'employee_model_rule_version' AND column_name = 'pool_quotas'`.execute(db);
      expect(beforeCols.rows).toHaveLength(0);

      // 迁移到 0040，pool_quotas 列出现。
      expect((await migrator.migrateTo("0040_employee_model_rule_pool_quotas")).error).toBeUndefined();
      const afterCols = await sql`SELECT column_name, data_type, column_default FROM information_schema.columns
        WHERE table_name = 'employee_model_rule_version' AND column_name = 'pool_quotas'`.execute(db);
      expect(afterCols.rows[0]).toMatchObject({ column_name: "pool_quotas", data_type: "jsonb" });

      // 准备最小数据：插入企业、管理员与一条规则版本，验证 pool_quotas 默认 [] 与厂商级额度可读写。
      await sql`INSERT INTO enterprise (id, name) VALUES ('40111111-1111-4111-8111-111111111111', 'pool035')`.execute(db);
      await sql`INSERT INTO admin_user (id, enterprise_id, username, display_name, password_hash, status)
        VALUES ('40222222-2222-4222-8222-222222222222', '40111111-1111-4111-8111-111111111111', 'pool035', 'pool035', 'hash', 'ACTIVE')`.execute(db);
      await sql`INSERT INTO employee_model_rule_version
        (enterprise_id, rule_id, version, name, employee_scope, principal_ids, model_scope, model_targets,
         quota_value, valid_from, created_by_admin_user_id)
        VALUES
        ('40111111-1111-4111-8111-111111111111', '40333333-3333-4333-8333-333333333333', 1,
         '厂商级额度', 'SELECTED', '[]'::jsonb, 'SELECTED', '[]'::jsonb, 0, now(),
         '40222222-2222-4222-8222-222222222222')`.execute(db);

      // 默认值应为空数组 []。
      const defaulted = await sql`SELECT pool_quotas FROM employee_model_rule_version WHERE rule_id = '40333333-3333-4333-8333-333333333333'`.execute(db);
      expect(defaulted.rows[0]).toEqual({ pool_quotas: [] });

      // 写入厂商级额度（DeepSeek 3 亿 / Kimi 5000 万），验证 jsonb 结构与 bigint 字符串承载。
      await db.updateTable("employee_model_rule_version").set({
        pool_quotas: JSON.stringify([
          { provider_code: "deepseek", quota_value: "300000000", allow_overage: false, valid_until: null },
          { provider_code: "kimi", quota_value: "50000000", allow_overage: true, valid_until: "2026-12-31T00:00:00.000Z" },
        ]) as unknown as never,
      }).where("rule_id", "=", "40333333-3333-4333-8333-333333333333").execute();
      const written = await sql`SELECT pool_quotas FROM employee_model_rule_version WHERE rule_id = '40333333-3333-4333-8333-333333333333'`.execute(db);
      expect(written.rows[0].pool_quotas).toEqual([
        { provider_code: "deepseek", quota_value: "300000000", allow_overage: false, valid_until: null },
        { provider_code: "kimi", quota_value: "50000000", allow_overage: true, valid_until: "2026-12-31T00:00:00.000Z" },
      ]);

      // 回滚到 0039，pool_quotas 列消失。
      expect(await migrateDown(db)).toBe("0040_employee_model_rule_pool_quotas");
      const rolledBack = await sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'employee_model_rule_version' AND column_name = 'pool_quotas'`.execute(db);
      expect(rolledBack.rows).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });
});
