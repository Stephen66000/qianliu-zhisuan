import { expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateToLatest } from "../migrator.js";

it("UAT Kimi 0078 已应用且有探针证据时，归集 0079/0080 顺序升级并保留证据", async () => {
  const pg = await startPostgresContainer("kimi_allocation_upgrade");
  const db = createKysely(pg.connectionString);
  try {
    const migrator = createMigrator(db);
    expect((await migrator.migrateTo("0078_provider_model_probe_enum_checks")).error).toBeUndefined();
    const enterprise = await db.insertInto("enterprise")
      .values({ name: "Kimi to Allocation upgrade" }).returning("id").executeTakeFirstOrThrow();
    const run = await db.insertInto("provider_model_probe_run").values({
      enterprise_id: enterprise.id,
      provider_id: null,
      provider_resource_id: null,
      provider_code: "kimi",
      resource_mode: "CODING_PLAN",
      credential_fingerprint: "a".repeat(64),
      endpoint_scope: "MODE_DEFAULT",
      endpoint_host: "api.kimi.com",
      status: "COMPLETED",
      idempotency_key: "uat-probe-evidence",
      request_hash: "b".repeat(64),
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("provider_model_probe_item").values({
      probe_run_id: run.id,
      upstream_model: "k3",
      validation_status: "READY",
      http_status: 200,
      error_code: null,
      error_category: "READY",
      retryable: false,
      diagnostic_hash: "probe-evidence",
      checked_at: new Date(),
    }).execute();

    expect(await migrateToLatest(db)).toEqual([
      "0079_project_allocation_relations", "0080_project_allocation_compute",
    ]);
    expect(await db.selectFrom("provider_model_probe_run").select("id")
      .where("id", "=", run.id).executeTakeFirst()).toEqual({ id: run.id });
    expect(await db.selectFrom("provider_model_probe_item").select("validation_status")
      .where("probe_run_id", "=", run.id).executeTakeFirst()).toEqual({ validation_status: "READY" });
    const tables = await sql<{ membership: string | null; allocation: string | null }>`
      SELECT to_regclass('public.project_membership')::text AS membership,
             to_regclass('public.project_allocation_run')::text AS allocation`.execute(db);
    expect(tables.rows[0]).toEqual({
      membership: "project_membership", allocation: "project_allocation_run",
    });
  } finally {
    await db.destroy();
    await pg.stop();
  }
}, 120_000);
