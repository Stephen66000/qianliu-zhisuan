import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer(); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("POOL-039 0043 单人规则历史迁移", () => {
  it("兼容既有版本，限制编辑/发布槽位，历史存在时拒绝破坏性 down，并支持回滚重放", async () => {
    const db = createKysely(pg.connectionString);
    const enterpriseId = "43991111-1111-4111-8111-111111111111";
    const adminId = "43992222-2222-4222-8222-222222222222";
    const principalId = "43993333-3333-4333-8333-333333333333";
    const ruleId = "43994444-4444-4444-8444-444444444444";
    const modelId = "43995555-5555-4555-8555-555555555555";
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0042_alias_ql_format")).error).toBeUndefined();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL-039 migration" }).execute();
      await db.insertInto("admin_user").values({
        id: adminId, enterprise_id: enterpriseId, username: "pool039-migration",
        display_name: "POOL-039", password_hash: "not-used", status: "ACTIVE",
      }).execute();
      await db.insertInto("principal").values({
        id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE",
        name: "POOL-039 employee", status: "ACTIVE",
      }).execute();
      await db.insertInto("unified_model").values({
        id: modelId, enterprise_id: enterpriseId, alias: "pool039-model",
        display_name: "POOL-039 model", status: "ACTIVE",
      }).execute();
      await db.insertInto("employee_model_rule_version").values({
        id: "43996666-6666-4666-8666-666666666666", enterprise_id: enterpriseId,
        rule_id: ruleId, version: 1, name: "历史单人规则", employee_scope: "SELECTED",
        principal_ids: JSON.stringify([principalId]) as unknown as string[], model_scope: "SELECTED",
        model_targets: JSON.stringify([{ unified_model_id: modelId, provider_resource_id: "43997777-7777-4777-8777-777777777777" }]) as unknown as never,
        quota_value: null, allow_overage: false, valid_from: new Date("2026-01-01T00:00:00Z"),
        valid_until: null, owner_principal_id: principalId, created_by_admin_user_id: adminId,
        status: "DISABLED",
      }).execute();

      expect((await migrator.migrateTo("0043_single_owner_rule_history")).error).toBeUndefined();
      const indexes = await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'employee_model_rule_single_owner_uq',
            'employee_model_rule_single_owner_editable_uq',
            'employee_model_rule_single_owner_published_uq'
          )
        ORDER BY indexname
      `.execute(db);
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "employee_model_rule_single_owner_editable_uq",
        "employee_model_rule_single_owner_published_uq",
      ]);
      const requestHashColumn = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'employee_model_rule_version'
          AND column_name = 'publish_request_hash'
      `.execute(db);
      expect(requestHashColumn.rows).toHaveLength(1);
      expect((await db.selectFrom("employee_model_rule_version").select("publish_request_hash")
        .where("id", "=", "43996666-6666-4666-8666-666666666666").executeTakeFirstOrThrow()).publish_request_hash)
        .toBeNull();

      await db.insertInto("employee_model_rule_version").values([
        {
          id: "43998888-8888-4888-8888-888888888888", enterprise_id: enterpriseId,
          rule_id: ruleId, version: 2, name: "当前发布规则", employee_scope: "SELECTED",
          principal_ids: JSON.stringify([principalId]) as unknown as string[], model_scope: "SELECTED",
          model_targets: JSON.stringify([]) as unknown as never, quota_value: null, allow_overage: false,
          valid_from: new Date("2026-02-01T00:00:00Z"), valid_until: null,
          owner_principal_id: principalId, created_by_admin_user_id: adminId, status: "PUBLISHED",
        },
        {
          id: "43999999-9999-4999-8999-999999999999", enterprise_id: enterpriseId,
          rule_id: ruleId, version: 3, name: "下一编辑规则", employee_scope: "SELECTED",
          principal_ids: JSON.stringify([principalId]) as unknown as string[], model_scope: "SELECTED",
          model_targets: JSON.stringify([]) as unknown as never, quota_value: null, allow_overage: false,
          valid_from: new Date("2026-03-01T00:00:00Z"), valid_until: null,
          owner_principal_id: principalId, created_by_admin_user_id: adminId, status: "DRAFT",
        },
      ]).execute();
      await expect(db.insertInto("employee_model_rule_version").values({
        id: "4399aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", enterprise_id: enterpriseId,
        rule_id: ruleId, version: 4, name: "重复编辑规则", employee_scope: "SELECTED",
        principal_ids: JSON.stringify([principalId]) as unknown as string[], model_scope: "SELECTED",
        model_targets: JSON.stringify([]) as unknown as never, quota_value: null, allow_overage: false,
        valid_from: new Date("2026-04-01T00:00:00Z"), valid_until: null,
        owner_principal_id: principalId, created_by_admin_user_id: adminId, status: "DRAFT",
      }).execute()).rejects.toMatchObject({ code: "23505" });
      await expect(db.insertInto("employee_model_rule_version").values({
        id: "4399bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", enterprise_id: enterpriseId,
        rule_id: ruleId, version: 5, name: "重复发布规则", employee_scope: "SELECTED",
        principal_ids: JSON.stringify([principalId]) as unknown as string[], model_scope: "SELECTED",
        model_targets: JSON.stringify([]) as unknown as never, quota_value: null, allow_overage: false,
        valid_from: new Date("2026-05-01T00:00:00Z"), valid_until: null,
        owner_principal_id: principalId, created_by_admin_user_id: adminId, status: "PUBLISHED",
      }).execute()).rejects.toMatchObject({ code: "23505" });

      await expect(migrateDown(db)).rejects.toThrow("0043 rollback blocked");
      expect((await db.selectFrom("employee_model_rule_version").select("id")
        .where("id", "=", "43996666-6666-4666-8666-666666666666").execute())).toHaveLength(1);

      await db.deleteFrom("employee_model_rule_version").where("enterprise_id", "=", enterpriseId).execute();
      expect(await migrateDown(db)).toBe("0043_single_owner_rule_history");
      const legacyIndex = await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes WHERE indexname = 'employee_model_rule_single_owner_uq'
      `.execute(db);
      expect(legacyIndex.rows).toHaveLength(1);
      const rolledBackColumn = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'employee_model_rule_version'
          AND column_name = 'publish_request_hash'
      `.execute(db);
      expect(rolledBackColumn.rows).toHaveLength(0);
      expect((await migrator.migrateTo("0043_single_owner_rule_history")).error).toBeUndefined();
      const replayed = await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes WHERE indexname = 'employee_model_rule_single_owner_published_uq'
      `.execute(db);
      expect(replayed.rows).toHaveLength(1);
      const reappliedColumn = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'employee_model_rule_version'
          AND column_name = 'publish_request_hash'
      `.execute(db);
      expect(reappliedColumn.rows).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });
});
