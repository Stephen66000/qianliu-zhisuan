import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";

it("0073 backfills only correlated historical Chat failures and preserves probe facts on rollback", async () => {
  const pg = await startPostgresContainer("credential_probe_migration");
  const db = createKysely(pg.connectionString);
  try {
    const migrator = createMigrator(db);
    expect((await migrator.migrateTo("0072_admin_roles_security")).error).toBeUndefined();
    const ent = (await db.insertInto("enterprise").values({ name: "migration" }).returning("id").executeTakeFirstOrThrow()).id;
    const principal = (await db.insertInto("principal").values({ enterprise_id: ent, type: "EMPLOYEE", name: "migration" }).returning("id").executeTakeFirstOrThrow()).id;
    const key = (await db.insertInto("principal_key").values({ enterprise_id: ent, principal_id: principal,
      key_prefix: "probe-test", key_digest: randomUUID(), allowed_model_ids: [] }).returning("id").executeTakeFirstOrThrow()).id;
    const provider = (await db.insertInto("provider").values({ enterprise_id: ent, code: "kimi", name: "Kimi", adapter_type: "kimi" }).returning("id").executeTakeFirstOrThrow()).id;
    const resource = (await db.insertInto("provider_resource").values({ enterprise_id: ent, provider_id: provider,
      name: "legacy", mode: "CODING_PLAN", credential_type: "API_KEY", status: "CREDENTIAL_INVALID" })
      .returning("id").executeTakeFirstOrThrow()).id;
    const request = randomUUID();
    await db.insertInto("ai_request").values({ id: request, enterprise_id: ent, principal_id: principal,
      principal_key_id: key, protocol: "chat", unified_model: "ql-k3" }).execute();
    const attempt = (await db.insertInto("upstream_attempt").values({ enterprise_id: ent, ai_request_id: request,
      provider_resource_id: resource, upstream_model: "k3-256k", attempt_no: 1, http_status: 401,
      error_classification: "UPSTREAM_CREDENTIAL_INVALID", finished_at: new Date() }).returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("resource_status_event").values({ enterprise_id: ent, provider_resource_id: resource,
      to_status: "CREDENTIAL_INVALID", reason: "CREDENTIAL_REJECTED" }).execute();
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(await db.selectFrom("provider_resource").select(["auth_failure_id", "auth_failure_model"])
      .where("id", "=", resource).executeTakeFirstOrThrow()).toEqual({ auth_failure_id: attempt, auth_failure_model: "k3-256k" });
    const admin = (await db.insertInto("admin_user").values({ enterprise_id: ent, username: "probe", password_hash: "test" })
      .returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("credential_chat_probe").values({ enterprise_id: ent, provider_resource_id: resource,
      actor_admin_id: admin, idempotency_key: randomUUID(), failure_id: attempt, upstream_model: "k3-256k",
      credential_version: 1, credential_digest: "a".repeat(64), config_hash: "b".repeat(64), status: "FAILED",
      http_status: 401, error_code: "HTTP_401", evidence: null, usage: null, finished_at: new Date(),
      expires_at: new Date(), retry_at: new Date() }).execute();
    // 0074-0078 为其后新增且可回滚（本用例无探针 run 行），逐层回滚后触发 0073 门禁。
    await expect(migrateDown(db)).resolves.toBe("0078_provider_model_probe_enum_checks");
    await expect(migrateDown(db)).resolves.toBe("0077_provider_model_probe_run_identity");
    await expect(migrateDown(db)).resolves.toBe("0076_provider_model_probe");
    await expect(migrateDown(db)).resolves.toBe("0075_provider_resource_archive");
    await expect(migrateDown(db)).resolves.toBe("0074_runtime_notification_recipients");
    await expect(migrateDown(db)).rejects.toThrow("0073 contains probe evidence");
  } finally { await db.destroy(); await pg.stop(); }
}, 120_000);
