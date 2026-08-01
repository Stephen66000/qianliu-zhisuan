import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer();
}, 120_000);

afterAll(async () => {
  if (pg) await pg.stop();
}, 60_000);

describe("0022 Principal Key 最小模型权限迁移", () => {
  it("历史 NULL 冻结迁移时 ACTIVE 模型，新 Key 默认空数组，回滚不恢复隐式语义", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      const migrated = await migrator.migrateTo("0021_billing_rule_multi_windows");
      expect(migrated.error).toBeUndefined();

      await sql`
        INSERT INTO enterprise (id, name)
        VALUES ('21111111-1111-4111-8111-111111111111', 'key-migration-test')
      `.execute(db);
      await sql`
        INSERT INTO principal (
          id, enterprise_id, type, name
        )
        VALUES (
          '22222222-2222-4222-8222-222222222222',
          '21111111-1111-4111-8111-111111111111',
          'EMPLOYEE',
          '历史 Key 主体'
        )
      `.execute(db);
      await sql`
        INSERT INTO unified_model (
          id, enterprise_id, alias, display_name, status
        )
        VALUES
          (
            '24444444-4444-4444-8444-444444444444',
            '21111111-1111-4111-8111-111111111111',
            'active-model',
            '迁移时有效模型',
            'ACTIVE'
          ),
          (
            '25555555-5555-4555-8555-555555555555',
            '21111111-1111-4111-8111-111111111111',
            'inactive-model',
            '迁移时停用模型',
            'DISABLED'
          )
      `.execute(db);
      await sql`
        INSERT INTO principal_key (
          id, enterprise_id, principal_id, key_prefix, key_digest
        )
        VALUES (
          '23333333-3333-4333-8333-333333333333',
          '21111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'sk-legacy',
          'legacy-key-digest'
        )
      `.execute(db);

      const executed = await migrator.migrateTo(
        "0022_principal_key_minimum_model_permissions",
      );
      expect(executed.error).toBeUndefined();
      expect(executed.results?.some(
        (result) =>
          result.migrationName === "0022_principal_key_minimum_model_permissions"
          && result.status === "Success",
      )).toBe(true);
      const legacy = await sql`
        SELECT allowed_model_ids
          FROM principal_key
         WHERE id = '23333333-3333-4333-8333-333333333333'
      `.execute(db);
      expect(legacy.rows[0]).toEqual({
        allowed_model_ids: ["24444444-4444-4444-8444-444444444444"],
      });
      await sql`
        INSERT INTO unified_model (
          enterprise_id, alias, display_name, status
        )
        VALUES (
          '21111111-1111-4111-8111-111111111111',
          'future-model',
          '迁移后新增模型',
          'ACTIVE'
        )
      `.execute(db);
      const frozen = await sql`
        SELECT allowed_model_ids
          FROM principal_key
         WHERE id = '23333333-3333-4333-8333-333333333333'
      `.execute(db);
      expect(frozen.rows[0]).toEqual({
        allowed_model_ids: ["24444444-4444-4444-8444-444444444444"],
      });

      await sql`
        INSERT INTO principal_key (
          enterprise_id, principal_id, key_prefix, key_digest
        )
        VALUES (
          '21111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'sk-new',
          'new-key-digest'
        )
      `.execute(db);
      const created = await sql`
        SELECT allowed_model_ids
          FROM principal_key
         WHERE key_digest = 'new-key-digest'
      `.execute(db);
      expect(created.rows[0]).toEqual({ allowed_model_ids: [] });

      const column = await sql`
        SELECT is_nullable, column_default
          FROM information_schema.columns
         WHERE table_name = 'principal_key'
           AND column_name = 'allowed_model_ids'
      `.execute(db);
      expect(column.rows[0]).toMatchObject({ is_nullable: "NO" });
      expect(String((column.rows[0] as { column_default: string }).column_default)).toContain(
        "'[]'::jsonb",
      );

      expect(await migrateDown(db)).toBe(
        "0022_principal_key_minimum_model_permissions",
      );
      const rolledBackColumn = await sql`
        SELECT is_nullable, column_default
          FROM information_schema.columns
         WHERE table_name = 'principal_key'
           AND column_name = 'allowed_model_ids'
      `.execute(db);
      expect(rolledBackColumn.rows[0]).toEqual({
        is_nullable: "YES",
        column_default: null,
      });
      const preserved = await sql`
        SELECT allowed_model_ids
          FROM principal_key
         WHERE id = '23333333-3333-4333-8333-333333333333'
      `.execute(db);
      expect(preserved.rows[0]).toEqual({
        allowed_model_ids: ["24444444-4444-4444-8444-444444444444"],
      });
    } finally {
      await db.destroy();
    }
  });
});
