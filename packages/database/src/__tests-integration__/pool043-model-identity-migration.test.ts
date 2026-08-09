import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import { GatewayLedgerRepository } from "../repositories/gateway-ledger-repository.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

const enterpriseA = "43000000-0000-4000-8000-000000000001";
const enterpriseB = "43000000-0000-4000-8000-000000000002";
const employeeA = "43000000-0000-4000-8000-000000000011";
const employeeB = "43000000-0000-4000-8000-000000000012";
const keyA = "43000000-0000-4000-8000-000000000021";
const keyB = "43000000-0000-4000-8000-000000000022";
const modelA = "43000000-0000-4000-8000-000000000031";
const modelB = "43000000-0000-4000-8000-000000000032";

beforeAll(async () => {
  pg = process.env.POOL043_MIGRATION_DATABASE_URL
    ? { connectionString: process.env.POOL043_MIGRATION_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer("pool043_model_identity");
}, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("POOL-043 稳定模型身份迁移", () => {
  it("只按可证明 alias 回填，保留历史 alias、未知 NULL 和企业组合外键，并可回滚", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0042_alias_ql_format")).error).toBeUndefined();
      await db.insertInto("enterprise").values([
        { id: enterpriseA, name: "POOL-043 A" },
        { id: enterpriseB, name: "POOL-043 B" },
      ]).execute();
      await db.insertInto("principal").values([
        { id: employeeA, enterprise_id: enterpriseA, type: "EMPLOYEE", name: "于滔" },
        { id: employeeB, enterprise_id: enterpriseB, type: "EMPLOYEE", name: "隔离员工" },
      ]).execute();
      await db.insertInto("unified_model").values([
        { id: modelA, enterprise_id: enterpriseA, alias: "ql-deepseek-v4-flash", display_name: "DeepSeek V4 Flash" },
        { id: modelB, enterprise_id: enterpriseB, alias: "ql-deepseek-v4-flash", display_name: "隔离模型" },
      ]).execute();
      await db.insertInto("principal_key").values([
        { id: keyA, enterprise_id: enterpriseA, principal_id: employeeA, key_prefix: "ql_a", key_digest: "digest-a", allowed_model_ids: JSON.stringify([modelA]) as unknown as string[] },
        { id: keyB, enterprise_id: enterpriseB, principal_id: employeeB, key_prefix: "ql_b", key_digest: "digest-b", allowed_model_ids: JSON.stringify([modelB]) as unknown as string[] },
      ]).execute();
      await db.insertInto("ai_request").values([
        { id: "43000000-0000-4000-8000-000000000041", enterprise_id: enterpriseA, principal_id: employeeA, principal_key_id: keyA, protocol: "chat", unified_model: "qianliu-deepseek-deepseek-v4-flash" },
        { id: "43000000-0000-4000-8000-000000000042", enterprise_id: enterpriseA, principal_id: employeeA, principal_key_id: keyA, protocol: "chat", unified_model: "ql-deepseek-v4-flash" },
        { id: "43000000-0000-4000-8000-000000000043", enterprise_id: enterpriseA, principal_id: employeeA, principal_key_id: keyA, protocol: "chat", unified_model: "legacy-unresolved" },
      ]).execute();

      const migrated = await migrator.migrateToLatest();
      expect(migrated.error).toBeUndefined();
      expect(migrated.results?.map((result) => [result.migrationName, result.status])).toEqual([
        ["0043_single_owner_rule_history", "Success"],
        ["0044_operating_bill_model_identity", "Success"],
      ]);
      const rows = await db.selectFrom("ai_request")
        .select(["id", "unified_model", "unified_model_id"]).orderBy("id").execute();
      expect(rows).toEqual([
        expect.objectContaining({ unified_model: "qianliu-deepseek-deepseek-v4-flash", unified_model_id: modelA }),
        expect.objectContaining({ unified_model: "ql-deepseek-v4-flash", unified_model_id: modelA }),
        expect.objectContaining({ unified_model: "legacy-unresolved", unified_model_id: null }),
      ]);
      await expect(db.updateTable("ai_request").set({ unified_model_id: modelB })
        .where("id", "=", rows[2]!.id).execute()).rejects.toMatchObject({ code: "23503" });
      const indexes = await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname IN (
             'ai_request_enterprise_principal_model_started_idx',
             'ledger_line_enterprise_created_request_idx',
             'ledger_line_unique_usage_event_idx',
             'upstream_attempt_unique_request_no_idx'
           )
         ORDER BY indexname
      `.execute(db);
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "ai_request_enterprise_principal_model_started_idx",
        "ledger_line_enterprise_created_request_idx",
        "ledger_line_unique_usage_event_idx",
        "upstream_attempt_unique_request_no_idx",
      ]);

      const gatewayRequest = await new GatewayLedgerRepository(db).createRequest({
        id: "43000000-0000-4000-8000-000000000044",
        enterprise_id: enterpriseA, principal_id: employeeA, principal_key_id: keyA,
        protocol: "chat", unified_model: "ql-deepseek-v4-flash", unified_model_id: modelA,
      });
      expect(gatewayRequest).toMatchObject({
        unified_model: "ql-deepseek-v4-flash", unified_model_id: modelA,
      });

      expect(await migrateDown(db)).toBe("0044_operating_bill_model_identity");
      const columns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'ai_request' AND column_name = 'unified_model_id'
      `.execute(db);
      expect(columns.rows).toHaveLength(0);
      expect((await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes
         WHERE indexname IN (
           'ledger_line_enterprise_created_request_idx',
           'ledger_line_unique_usage_event_idx',
           'upstream_attempt_unique_request_no_idx'
         )
      `.execute(db)).rows).toHaveLength(0);
      const aliases = await sql<{ unified_model: string }>`
        SELECT unified_model FROM ai_request ORDER BY id
      `.execute(db);
      expect(aliases.rows.map((row) => row.unified_model)).toContain(
        "qianliu-deepseek-deepseek-v4-flash",
      );

      expect(await migrateDown(db)).toBe("0043_single_owner_rule_history");
      const reapplied = await migrator.migrateToLatest();
      expect(reapplied.error).toBeUndefined();
      expect(reapplied.results?.map((result) => [result.migrationName, result.status])).toEqual([
        ["0043_single_owner_rule_history", "Success"],
        ["0044_operating_bill_model_identity", "Success"],
      ]);
      const rebound = await db.selectFrom("ai_request")
        .select(["unified_model", "unified_model_id"])
        .where("id", "=", rows[0]!.id)
        .executeTakeFirstOrThrow();
      expect(rebound).toEqual({
        unified_model: "qianliu-deepseek-deepseek-v4-flash",
        unified_model_id: modelA,
      });
    } finally {
      await db.destroy();
    }
  }, 120_000);
});
