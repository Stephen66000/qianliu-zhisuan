import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("w20_resource_procurement_migration");
}, 120_000);

afterAll(async () => {
  await pg?.stop();
}, 60_000);

describe("W20-08/09 资源利用与采购复盘迁移", () => {
  it("仅允许成对的正数 API 月预算，备注保持账期、长度、版本和幂等约束", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0048_department_cost_budget_and_purchase")).error).toBeUndefined();

      const before = await sql<{ reg: string | null }>`
        SELECT to_regclass('public.procurement_review_note') AS reg
      `.execute(db);
      expect(before.rows[0]!.reg).toBeNull();

      expect((await migrator.migrateTo("0049_resource_utilization_and_procurement_review")).error).toBeUndefined();
      const utilizationIndex = await sql<{ reg: string | null }>`
        SELECT to_regclass('public.ledger_line_enterprise_resource_created_idx') AS reg
      `.execute(db);
      expect(utilizationIndex.rows[0]!.reg).toBe("ledger_line_enterprise_resource_created_idx");

      const enterpriseId = randomUUID();
      const adminId = randomUUID();
      const providerId = randomUUID();
      const resourceId = randomUUID();
      await sql`
        INSERT INTO enterprise (id, name) VALUES (${enterpriseId}::uuid, 'W20 迁移企业')
      `.execute(db);
      await sql`
        INSERT INTO admin_user
          (id, enterprise_id, username, display_name, password_hash)
        VALUES
          (${adminId}::uuid, ${enterpriseId}::uuid, 'w20-migration-admin', '迁移管理员', 'unused')
      `.execute(db);
      await sql`
        INSERT INTO provider
          (id, enterprise_id, code, name, adapter_type)
        VALUES
          (${providerId}::uuid, ${enterpriseId}::uuid, 'deepseek', 'DeepSeek', 'openai')
      `.execute(db);
      await sql`
        INSERT INTO provider_resource
          (id, enterprise_id, provider_id, name, mode, credential_type)
        VALUES
          (${resourceId}::uuid, ${enterpriseId}::uuid, ${providerId}::uuid,
           'DeepSeek API', 'API', 'API_KEY')
      `.execute(db);

      await expect(sql`
        UPDATE provider_resource
           SET monthly_budget_amount = 100, monthly_budget_currency = NULL
         WHERE id = ${resourceId}::uuid
      `.execute(db)).rejects.toMatchObject({ code: "23514" });
      await expect(sql`
        UPDATE provider_resource
           SET monthly_budget_amount = 0, monthly_budget_currency = 'CNY'
         WHERE id = ${resourceId}::uuid
      `.execute(db)).rejects.toMatchObject({ code: "23514" });
      await expect(sql`
        UPDATE provider_resource
           SET monthly_budget_amount = 100, monthly_budget_currency = 'CNY'
         WHERE id = ${resourceId}::uuid
      `.execute(db)).resolves.toBeDefined();

      await expect(sql`
        INSERT INTO procurement_review_note
          (enterprise_id, month, note, version, updated_by)
        VALUES
          (${enterpriseId}::uuid, '2026-08-02'::date, '非月初', 1, ${adminId}::uuid)
      `.execute(db)).rejects.toMatchObject({ code: "23514" });
      await expect(sql`
        INSERT INTO procurement_review_note
          (enterprise_id, month, note, version, updated_by)
        VALUES
          (${enterpriseId}::uuid, '2026-08-01'::date, ${"x".repeat(4001)}, 1, ${adminId}::uuid)
      `.execute(db)).rejects.toMatchObject({ code: "23514" });

      await sql`
        INSERT INTO procurement_review_note
          (enterprise_id, month, note, version, updated_by)
        VALUES
          (${enterpriseId}::uuid, '2026-08-01'::date, '月度复盘', 1, ${adminId}::uuid)
      `.execute(db);
      await expect(sql`
        INSERT INTO procurement_review_note
          (enterprise_id, month, note, version, updated_by)
        VALUES
          (${enterpriseId}::uuid, '2026-08-01'::date, '重复账期', 1, ${adminId}::uuid)
      `.execute(db)).rejects.toMatchObject({ code: "23505" });

      await sql`
        INSERT INTO procurement_review_note_idempotency
          (enterprise_id, month, idempotency_key, request_hash, response_snapshot)
        VALUES
          (${enterpriseId}::uuid, '2026-08-01'::date, 'same-key', ${"a".repeat(64)}, '{}'::jsonb)
      `.execute(db);
      await expect(sql`
        INSERT INTO procurement_review_note_idempotency
          (enterprise_id, month, idempotency_key, request_hash, response_snapshot)
        VALUES
          (${enterpriseId}::uuid, '2026-08-01'::date, 'same-key', ${"b".repeat(64)}, '{}'::jsonb)
      `.execute(db)).rejects.toMatchObject({ code: "23505" });

      expect(await migrateDown(db)).toBe("0049_resource_utilization_and_procurement_review");
      const after = await sql<{ reg: string | null }>`
        SELECT to_regclass('public.procurement_review_note') AS reg
      `.execute(db);
      expect(after.rows[0]!.reg).toBeNull();
      const removedIndex = await sql<{ reg: string | null }>`
        SELECT to_regclass('public.ledger_line_enterprise_resource_created_idx') AS reg
      `.execute(db);
      expect(removedIndex.rows[0]!.reg).toBeNull();
      const budgetColumns = await sql`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_name = 'provider_resource'
           AND column_name LIKE 'monthly_budget_%'
      `.execute(db);
      expect(budgetColumns.rows).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });
});
