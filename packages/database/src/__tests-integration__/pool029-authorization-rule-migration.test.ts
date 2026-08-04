import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer(); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("0038 员工模型授权规则迁移", () => {
  it("把既有 Key 权限冻结为手工基线，回滚不改写 Key", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0037_client_identity")).error).toBeUndefined();
      await sql`INSERT INTO enterprise (id, name) VALUES ('29111111-1111-4111-8111-111111111111', 'pool029')`.execute(db);
      await sql`INSERT INTO principal (id, enterprise_id, type, name) VALUES ('29222222-2222-4222-8222-222222222222', '29111111-1111-4111-8111-111111111111', 'EMPLOYEE', '历史员工')`.execute(db);
      await sql`INSERT INTO unified_model (id, enterprise_id, alias, display_name, status) VALUES
        ('29333333-3333-4333-8333-333333333333', '29111111-1111-4111-8111-111111111111', 'legacy-model', '历史模型', 'ACTIVE'),
        ('29444444-4444-4444-8444-444444444444', '29111111-1111-4111-8111-111111111111', 'revoked-model', '旧 Key 模型', 'ACTIVE')`.execute(db);
      await sql`INSERT INTO principal_key (enterprise_id, principal_id, key_prefix, key_digest, allowed_model_ids, status) VALUES
        ('29111111-1111-4111-8111-111111111111', '29222222-2222-4222-8222-222222222222', 'sk-legacy', 'legacy', '["29333333-3333-4333-8333-333333333333", "invalid-history-id"]'::jsonb, 'ACTIVE'),
        ('29111111-1111-4111-8111-111111111111', '29222222-2222-4222-8222-222222222222', 'sk-revoked', 'revoked', '["29444444-4444-4444-8444-444444444444"]'::jsonb, 'REVOKED')`.execute(db);

      const migrated = await migrator.migrateTo("0038_employee_model_authorization_rule");
      expect(migrated.error).toBeUndefined();
      const baseline = await sql`SELECT principal_id, unified_model_id FROM principal_model_manual_authorization`.execute(db);
      expect(baseline.rows).toEqual([{
        principal_id: "29222222-2222-4222-8222-222222222222",
        unified_model_id: "29333333-3333-4333-8333-333333333333",
      }]);
      expect(await migrateDown(db)).toBe("0038_employee_model_authorization_rule");
      const key = await sql`SELECT allowed_model_ids FROM principal_key WHERE key_digest = 'legacy'`.execute(db);
      expect(key.rows[0]).toEqual({ allowed_model_ids: [
        "29333333-3333-4333-8333-333333333333", "invalid-history-id",
      ] });
    } finally {
      await db.destroy();
    }
  });

  it("存在规则数据时拒绝 down，保留授权来源与审计链", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0038_employee_model_authorization_rule")).error).toBeUndefined();
      await sql`INSERT INTO enterprise (id, name) VALUES ('29511111-1111-4111-8111-111111111111', 'pool029-rollback')`.execute(db);
      await sql`INSERT INTO admin_user (id, enterprise_id, username, display_name, password_hash, status)
        VALUES ('29522222-2222-4222-8222-222222222222', '29511111-1111-4111-8111-111111111111', 'pool029', 'pool029', 'hash', 'ACTIVE')`.execute(db);
      await sql`INSERT INTO employee_model_rule_version
        (enterprise_id, rule_id, version, name, employee_scope, principal_ids, model_scope, model_targets,
         quota_value, valid_from, created_by_admin_user_id)
        VALUES
        ('29511111-1111-4111-8111-111111111111', '29533333-3333-4333-8333-333333333333', 1,
         '不可破坏回滚', 'SELECTED', '[]'::jsonb, 'SELECTED', '[]'::jsonb, 0, now(),
         '29522222-2222-4222-8222-222222222222')`.execute(db);

      await expect(migrateDown(db)).rejects.toThrow("0038 rollback blocked");
      const retained = await sql`SELECT rule_id FROM employee_model_rule_version`.execute(db);
      expect(retained.rows).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });
});
