import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown, migrateToLatest } from "../migrator.js";
import { rollbackTo } from "./migration-rollback.js";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer("resource_fact_0062"); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("0062 resource status event timestamp repair", () => {
  it("uses an insert-time SQL clock and keeps the safe default after rollback", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      const baseline = await migrator.migrateTo("0061_provider_finance_audit_hardening");
      expect(baseline.error).toBeUndefined();
      await sql`INSERT INTO enterprise (name) VALUES ('0062-time')`.execute(db);
      const enterprise = await db.selectFrom("enterprise").select("id")
        .where("name", "=", "0062-time").executeTakeFirstOrThrow();
      await db.insertInto("provider").values({ enterprise_id: enterprise.id, code: "time-provider",
        name: "time-provider", adapter_type: "OPENAI_COMPATIBLE" }).execute();
      const provider = await db.selectFrom("provider").select("id")
        .where("enterprise_id", "=", enterprise.id).executeTakeFirstOrThrow();
      await db.insertInto("provider_resource").values({ enterprise_id: enterprise.id,
        provider_id: provider.id, name: "time-resource", mode: "API", credential_type: "API_KEY" })
        .execute();
      const resource = await db.selectFrom("provider_resource").select("id")
        .where("enterprise_id", "=", enterprise.id).executeTakeFirstOrThrow();
      await db.insertInto("resource_status_event").values({ enterprise_id: enterprise.id,
        provider_resource_id: resource.id, from_status: null, to_status: "ACTIVE",
        reason: "PASSIVE_SUCCESS", actor: "system" }).execute();

      expect(await migrateToLatest(db)).toContain("0062_resource_fact_reconciliation");
      const defaultResult = await sql<{ expression: string }>`
        SELECT pg_get_expr(def.adbin, def.adrelid) AS expression
          FROM pg_attrdef def
          JOIN pg_attribute attr ON attr.attrelid=def.adrelid AND attr.attnum=def.adnum
         WHERE def.adrelid='resource_status_event'::regclass AND attr.attname='created_at'
      `.execute(db);
      expect(defaultResult.rows[0]?.expression.toLowerCase()).toContain("current_timestamp");
      expect((await sql<{ exists: boolean }>`SELECT to_regclass(
        'ledger_line_resource_settled_idx'
      ) IS NOT NULL AS exists`.execute(db)).rows[0]?.exists).toBe(true);
      expect(await db.selectFrom("resource_status_event").select("time_reliable")
        .where("provider_resource_id", "=", resource.id).executeTakeFirstOrThrow())
        .toEqual({ time_reliable: false });

      await db.insertInto("resource_status_event").values({ enterprise_id: enterprise.id,
        provider_resource_id: resource.id, from_status: "ACTIVE", to_status: "DEGRADED",
        reason: "PASSIVE_FAILURE", actor: "system" }).execute();
      await sql`SELECT pg_sleep(0.01)`.execute(db);
      await db.insertInto("resource_status_event").values({ enterprise_id: enterprise.id,
        provider_resource_id: resource.id, from_status: "DEGRADED", to_status: "ACTIVE",
        reason: "PASSIVE_SUCCESS", actor: "system" }).execute();
      const events = await db.selectFrom("resource_status_event")
        .select(["created_at", "time_reliable"])
        .where("provider_resource_id", "=", resource.id).orderBy("created_at").execute();
      expect(events[2]!.created_at.getTime()).toBeGreaterThan(events[1]!.created_at.getTime());
      expect(events.slice(1).map((event) => event.time_reliable)).toEqual([true, true]);

      // 回滚链锚定「目标迁移」而非「当时的迁移头」（惯例见 migration-rollback.ts docstring）。
      const rolledBack = await rollbackTo(db, "0072_admin_roles_security");
      expect(rolledBack.at(-1)).toBe("0072_admin_roles_security");
      expect(await migrateDown(db)).toBe("0071_enterprise_contact_details");
      expect(await migrateDown(db)).toBe("0070_alert_recovery_evidence");
      expect(await migrateDown(db)).toBe("0069_auth_error_evidence");
      expect(await migrateDown(db)).toBe("0068_alert_resource_context");
      expect(await migrateDown(db)).toBe("0067_admin_cleanup");
      expect(await migrateDown(db)).toBe("0066_subscription_auto_renewal");
      expect(await migrateDown(db)).toBe("0065_principal_accounting_assignment");
      expect(await migrateDown(db)).toBe("0064_quota_pricing_and_policy_archive");
      expect(await migrateDown(db)).toBe("0063_operating_snapshot_subscription_period");
      expect(await migrateDown(db)).toBe("0062_resource_fact_reconciliation");
      const safeDefault = await sql<{ expression: string }>`
        SELECT pg_get_expr(def.adbin, def.adrelid) AS expression
          FROM pg_attrdef def
          JOIN pg_attribute attr ON attr.attrelid=def.adrelid AND attr.attnum=def.adnum
         WHERE def.adrelid='resource_status_event'::regclass AND attr.attname='created_at'
      `.execute(db);
      expect(safeDefault.rows[0]?.expression.toLowerCase()).toContain("current_timestamp");
      expect((await sql<{ exists: boolean }>`SELECT to_regclass(
        'ledger_line_resource_settled_idx'
      ) IS NOT NULL AS exists`.execute(db)).rows[0]?.exists).toBe(false);
    } finally { await db.destroy(); }
  });
});
