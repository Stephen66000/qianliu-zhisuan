import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let cookie: string;
const enterpriseId = randomUUID();
const adminId = randomUUID();
const providerId = randomUUID();
const resourceId = randomUUID();
const manualModelId = randomUUID();
const targetModelId = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  const options = encodeURIComponent("-c deadlock_timeout=100ms -c lock_timeout=5s");
  db = createKysely(`${pg.connectionString}?options=${options}`);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL-039 concurrency" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "pool039", display_name: "POOL-039",
    password_hash: await hashPassword("POOL-039-Password!"), status: "ACTIVE",
  }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "kimi", name: "Kimi",
    adapter_type: "kimi", status: "ACTIVE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId, name: "POOL-039 Plan",
    mode: "CODING_PLAN", credential_type: "API_KEY", status: "ACTIVE",
  }).execute();
  await db.insertInto("unified_model").values([
    { id: manualModelId, enterprise_id: enterpriseId, alias: "pool039-manual", display_name: "Manual", status: "ACTIVE" },
    { id: targetModelId, enterprise_id: enterpriseId, alias: "pool039-target", display_name: "Target", status: "ACTIVE" },
  ]).execute();
  await db.insertInto("model_route").values({
    enterprise_id: enterpriseId, unified_model_id: targetModelId, provider_resource_id: resourceId,
    upstream_model: "pool039-target", enabled: true,
  }).execute();
  await db.insertInto("billing_rule").values({
    enterprise_id: enterpriseId, provider_resource_id: resourceId, upstream_model: "pool039-target",
    rule_type: "MODEL_TIER", rule_version: "pool039-v1", effective_from: new Date("2026-01-01T00:00:00Z"),
    multiplier: "1", enabled: true,
  }).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/auth/login",
    payload: { username: "pool039", password: "POOL-039-Password!" },
  });
  const header = login.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

async function createConcurrentFixture(round: number) {
  const principalId = randomUUID();
  const grantId = randomUUID();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE",
    name: `POOL-039 并发员工 ${round}`, status: "ACTIVE",
  }).execute();
  await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId, principal_id: principalId, key_prefix: `pool039-${round}`,
    key_digest: randomUUID(), allowed_model_ids: JSON.stringify([manualModelId]) as unknown as string[], status: "ACTIVE",
  }).execute();
  // 明确构造已有手工 baseline：并发发布不能通过“baseline 已存在”绕开 Key 锁序。
  await db.insertInto("principal_model_manual_authorization").values({
    enterprise_id: enterpriseId, principal_id: principalId, unified_model_id: manualModelId,
  }).execute();
  const grant = await db.insertInto("principal_grant").values({
    id: grantId, enterprise_id: enterpriseId, principal_id: principalId, provider: "kimi",
    model_alias: "*", pool_model_alias: "*", quota_unit: "TOKEN", quota_value: 5000n,
    allow_overage: false, valid_from: new Date("2026-01-01T00:00:00Z"), valid_until: null,
    status: "ACTIVE", authorization_rule_version_id: null,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id, used_value: 123n }).execute();
  await db.insertInto("principal_access_config_state").values({
    enterprise_id: enterpriseId, principal_id: principalId, config_version: 1,
  }).execute();

  const created = await app.inject({
    method: "POST", url: "/employee-model-rules", headers: { cookie },
    payload: {
      name: `POOL-039 批量规则 ${round}`, employee_scope: "SELECTED", principal_ids: [principalId],
      model_scope: "SELECTED", model_targets: [{ unified_model_id: targetModelId, provider_resource_id: resourceId }],
      quota_value: "7000", allow_overage: false, valid_from: "2026-08-01T00:00:00.000Z", valid_until: null,
    },
  });
  expect(created.statusCode).toBe(201);
  const versionId = created.json().version.id as string;
  const validated = await app.inject({
    method: "POST", url: `/employee-model-rules/versions/${versionId}/validate`, headers: { cookie },
  });
  expect(validated.statusCode).toBe(200);
  const listed = await app.inject({ method: "GET", url: "/employee-model-rules", headers: { cookie } });
  const version = listed.json().rules.find((item: { id: string }) => item.id === versionId) as { lock_version: number };
  return { principalId, versionId, lockVersion: version.lock_version, grantId };
}

describe("POOL-039 真实 PostgreSQL 锁序并发", () => {
  it("已有 manual baseline 下单人 PUT × 批量发布无 40P01/500，最终事实一致", async () => {
    for (const round of [1, 2, 3]) {
      const fixture = await createConcurrentFixture(round);
      await sql`CREATE FUNCTION pool039_pause_single_put() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(0.35); RETURN NEW; END $$`.execute(db);
      await sql`CREATE TRIGGER pool039_pause_single_put
        BEFORE UPDATE ON principal_access_config_state
        FOR EACH ROW EXECUTE FUNCTION pool039_pause_single_put()`.execute(db);
      try {
        const singlePut = app.inject({
          method: "PUT", url: `/principals/${fixture.principalId}/access-configuration`, headers: { cookie },
          payload: {
            expected_version: 1, idempotency_key: `pool039-single-${round}`,
            providers: [{ provider_code: "kimi", quota_value: "9000", allow_overage: true,
              valid_until: null, enabled_model_ids: [targetModelId] }],
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        const batchPublish = app.inject({
          method: "POST", url: `/employee-model-rules/versions/${fixture.versionId}/publish`, headers: { cookie },
          payload: { expected_lock_version: fixture.lockVersion, idempotency_key: `pool039-batch-${round}` },
        });
        const [singleResponse, batchResponse] = await Promise.all([singlePut, batchPublish]);
        expect(singleResponse.statusCode).toBe(200);
        expect(batchResponse.statusCode).toBe(200);
        expect(`${singleResponse.body}${batchResponse.body}`).not.toMatch(/40P01|deadlock/i);
      } finally {
        await sql`DROP TRIGGER pool039_pause_single_put ON principal_access_config_state`.execute(db);
        await sql`DROP FUNCTION pool039_pause_single_put()`.execute(db);
      }

      const key = await db.selectFrom("principal_key").select(["allowed_model_ids", "status"])
        .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId)
        .where("status", "=", "ACTIVE").executeTakeFirstOrThrow();
      expect(key.allowed_model_ids).toEqual([targetModelId]);
      const batchVersion = await db.selectFrom("employee_model_rule_version").select(["id", "status", "rule_id", "version"])
        .where("id", "=", fixture.versionId).executeTakeFirstOrThrow();
      expect(batchVersion.status).toBe("PUBLISHED");
      const grant = await db.selectFrom("principal_grant").selectAll().where("id", "=", fixture.grantId).executeTakeFirstOrThrow();
      expect(grant).toMatchObject({
        status: "ACTIVE", quota_value: "7000", allow_overage: false,
        authorization_rule_version_id: fixture.versionId,
      });
      const counter = await db.selectFrom("quota_counter").select(["used_value", "grant_id"])
        .where("grant_id", "=", fixture.grantId).executeTakeFirstOrThrow();
      expect(counter).toMatchObject({ grant_id: fixture.grantId, used_value: "123" });
      const assignments = await db.selectFrom("employee_model_rule_assignment").selectAll()
        .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId)
        .where("status", "=", "ACTIVE").execute();
      expect(assignments).toHaveLength(2);
      expect(new Set(assignments.map((row) => row.unified_model_id))).toEqual(new Set([targetModelId]));
      expect(new Set(assignments.map((row) => row.rule_version_id))).toEqual(new Set([
        fixture.versionId,
        (await db.selectFrom("employee_model_rule_version").select("id")
          .where("enterprise_id", "=", enterpriseId).where("owner_principal_id", "=", fixture.principalId)
          .where("status", "=", "PUBLISHED").executeTakeFirstOrThrow()).id,
      ]));
      expect(await db.selectFrom("principal_model_manual_authorization").select("unified_model_id")
        .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId).execute()).toHaveLength(0);
      expect((await db.selectFrom("principal_access_config_state").select("config_version")
        .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId)
        .executeTakeFirstOrThrow()).config_version).toBe(2);
      const published = await db.selectFrom("employee_model_rule_version").select(["id", "status", "owner_principal_id"])
        .where("enterprise_id", "=", enterpriseId).where("owner_principal_id", "=", fixture.principalId)
        .where("status", "=", "PUBLISHED").execute();
      expect(published).toHaveLength(1);
      expect(await db.selectFrom("operation_log").select("id")
        .where("enterprise_id", "=", enterpriseId)
        .where("target_id", "=", fixture.principalId)
        .where("action", "=", "principal_access_config.save").execute()).toHaveLength(1);
      expect(await db.selectFrom("operation_log").select("id")
        .where("enterprise_id", "=", enterpriseId)
        .where("target_type", "=", "employee_model_rule")
        .where("action", "=", "employee_model_rule.publish").execute()).toHaveLength(round);
      const savedAudit = await db.selectFrom("operation_log").select("change_summary")
        .where("enterprise_id", "=", enterpriseId).where("target_id", "=", fixture.principalId)
        .where("action", "=", "principal_access_config.save").executeTakeFirstOrThrow();
      expect(savedAudit.change_summary).toMatchObject({ config_version: 2, enabled_models: 1 });
      const publishAudit = await db.selectFrom("operation_log").select("change_summary")
        .where("enterprise_id", "=", enterpriseId).where("target_id", "=", batchVersion.rule_id)
        .where("action", "=", "employee_model_rule.publish").executeTakeFirstOrThrow();
      expect(publishAudit.change_summary).toMatchObject({ quota_mode: "SET", principal_count: 1, model_count: 1 });
    }
  }, 120_000);

  it("已有 manual baseline 下单人 PUT × 批量停用无 40P01/500，最终事实一致", async () => {
    const fixture = await createConcurrentFixture(40);
    const published = await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${fixture.versionId}/publish`, headers: { cookie },
      payload: { expected_lock_version: fixture.lockVersion, idempotency_key: "pool039-disable-setup" },
    });
    expect(published.statusCode).toBe(200);
    await sql`CREATE FUNCTION pool039_pause_single_put_disable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.35); RETURN NEW; END $$`.execute(db);
    await sql`CREATE TRIGGER pool039_pause_single_put_disable
      BEFORE UPDATE ON principal_access_config_state
      FOR EACH ROW EXECUTE FUNCTION pool039_pause_single_put_disable()`.execute(db);
    try {
      const singlePut = app.inject({
        method: "PUT", url: `/principals/${fixture.principalId}/access-configuration`, headers: { cookie },
        payload: {
          expected_version: 1, idempotency_key: "pool039-disable-single",
          providers: [{ provider_code: "kimi", quota_value: "9000", allow_overage: true,
            valid_until: null, enabled_model_ids: [targetModelId] }],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const batchDisable = app.inject({
        method: "POST", url: `/employee-model-rules/versions/${fixture.versionId}/disable`, headers: { cookie },
      });
      const [singleResponse, disableResponse] = await Promise.all([singlePut, batchDisable]);
      expect(singleResponse.statusCode).toBe(200);
      expect(disableResponse.statusCode).toBe(200);
      expect(`${singleResponse.body}${disableResponse.body}`).not.toMatch(/40P01|deadlock/i);
    } finally {
      await sql`DROP TRIGGER pool039_pause_single_put_disable ON principal_access_config_state`.execute(db);
      await sql`DROP FUNCTION pool039_pause_single_put_disable()`.execute(db);
    }
    const singleVersion = await db.selectFrom("employee_model_rule_version").select(["id", "status"])
      .where("enterprise_id", "=", enterpriseId).where("owner_principal_id", "=", fixture.principalId)
      .where("status", "=", "PUBLISHED").executeTakeFirstOrThrow();
    expect((await db.selectFrom("employee_model_rule_version").select("status").where("id", "=", fixture.versionId)
      .executeTakeFirstOrThrow()).status).toBe("DISABLED");
    expect(await db.selectFrom("principal_model_manual_authorization").select("unified_model_id")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId).execute()).toHaveLength(0);
    expect(await db.selectFrom("employee_model_rule_assignment").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId)
      .where("status", "=", "ACTIVE").execute()).toHaveLength(1);
    expect(await db.selectFrom("principal_grant").select(["quota_value", "allow_overage", "authorization_rule_version_id"])
      .where("id", "=", fixture.grantId).executeTakeFirstOrThrow()).toMatchObject({
      quota_value: "9000", allow_overage: true, authorization_rule_version_id: singleVersion.id,
    });
    expect((await db.selectFrom("principal_access_config_state").select("config_version")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId)
      .executeTakeFirstOrThrow()).config_version).toBe(2);
    expect((await db.selectFrom("quota_counter").select("used_value").where("grant_id", "=", fixture.grantId)
      .executeTakeFirstOrThrow()).used_value).toBe("123");
    expect(await db.selectFrom("operation_log").select("id").where("enterprise_id", "=", enterpriseId)
      .where("target_id", "=", fixture.principalId).where("action", "=", "principal_access_config.save").execute()).toHaveLength(1);
    expect(await db.selectFrom("operation_log").select("id").where("enterprise_id", "=", enterpriseId)
      .where("target_type", "=", "employee_model_rule").where("action", "=", "employee_model_rule.disable").execute()).toHaveLength(1);
  }, 120_000);

  it("连续单人 PUT 递增同一 rule_id/version，不覆盖已发布历史", async () => {
    const fixture = await createConcurrentFixture(41);
    const first = await app.inject({
      method: "PUT", url: `/principals/${fixture.principalId}/access-configuration`, headers: { cookie },
      payload: {
        expected_version: 1, idempotency_key: "pool039-history-1",
        providers: [{ provider_code: "kimi", quota_value: "9000", allow_overage: true,
          valid_until: null, enabled_model_ids: [targetModelId] }],
      },
    });
    expect(first.statusCode).toBe(200);
    const changedDateReplay = await app.inject({
      method: "PUT", url: `/principals/${fixture.principalId}/access-configuration`, headers: { cookie },
      payload: {
        expected_version: 1, idempotency_key: "pool039-history-1",
        providers: [{ provider_code: "kimi", quota_value: "9000", allow_overage: true,
          valid_until: "2026-12-31T00:00:00.000Z", enabled_model_ids: [targetModelId] }],
      },
    });
    expect(changedDateReplay.statusCode).toBe(409);
    const second = await app.inject({
      method: "PUT", url: `/principals/${fixture.principalId}/access-configuration`, headers: { cookie },
      payload: {
        expected_version: 2, idempotency_key: "pool039-history-2",
        providers: [{ provider_code: "kimi", quota_value: "9100", allow_overage: false,
          valid_until: null, enabled_model_ids: [targetModelId] }],
      },
    });
    expect(second.statusCode).toBe(200);
    const versions = await db.selectFrom("employee_model_rule_version").select(["rule_id", "version", "status"])
      .where("enterprise_id", "=", enterpriseId).where("owner_principal_id", "=", fixture.principalId)
      .orderBy("version", "asc").execute();
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions.map((version) => version.status)).toEqual(["DISABLED", "PUBLISHED"]);
    expect(new Set(versions.map((version) => version.rule_id)).size).toBe(1);
  }, 120_000);

  it("单人 PUT 中途失败时整体回滚 Key、池额度、版本和审计", async () => {
    const fixture = await createConcurrentFixture(99);
    const before = await db.selectFrom("principal_grant").select(["quota_value", "allow_overage", "authorization_rule_version_id", "version"])
      .where("id", "=", fixture.grantId).executeTakeFirstOrThrow();
    const beforeKey = await db.selectFrom("principal_key").select(["allowed_model_ids", "status"])
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId)
      .where("status", "=", "ACTIVE").executeTakeFirstOrThrow();
    const beforeBatchVersion = await db.selectFrom("employee_model_rule_version").select(["status", "lock_version"])
      .where("id", "=", fixture.versionId).executeTakeFirstOrThrow();
    await sql`CREATE FUNCTION pool039_fail_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'pool039 injected assignment failure'; END $$`.execute(db);
    await sql`CREATE TRIGGER pool039_fail_assignment
      BEFORE INSERT ON employee_model_rule_assignment
      FOR EACH ROW EXECUTE FUNCTION pool039_fail_assignment()`.execute(db);
    try {
      const response = await app.inject({
        method: "PUT", url: `/principals/${fixture.principalId}/access-configuration`, headers: { cookie },
        payload: {
          expected_version: 1, idempotency_key: "pool039-rollback",
          providers: [{ provider_code: "kimi", quota_value: "9999", allow_overage: true,
            valid_until: null, enabled_model_ids: [targetModelId] }],
        },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await sql`DROP TRIGGER pool039_fail_assignment ON employee_model_rule_assignment`.execute(db);
      await sql`DROP FUNCTION pool039_fail_assignment()`.execute(db);
    }
    expect(await db.selectFrom("principal_grant").select(["quota_value", "allow_overage", "authorization_rule_version_id", "version"])
      .where("id", "=", fixture.grantId).executeTakeFirstOrThrow()).toEqual(before);
    expect(await db.selectFrom("principal_key").select(["allowed_model_ids", "status"])
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId)
      .where("status", "=", "ACTIVE").executeTakeFirstOrThrow()).toEqual(beforeKey);
    expect(await db.selectFrom("principal_model_manual_authorization").select("unified_model_id")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId).execute())
      .toEqual([{ unified_model_id: manualModelId }]);
    expect(await db.selectFrom("employee_model_rule_version").select(["status", "lock_version"])
      .where("id", "=", fixture.versionId).executeTakeFirstOrThrow()).toEqual(beforeBatchVersion);
    expect(await db.selectFrom("employee_model_rule_version").select("id")
      .where("enterprise_id", "=", enterpriseId).where("owner_principal_id", "=", fixture.principalId).execute())
      .toHaveLength(0);
    expect(await db.selectFrom("employee_model_rule_assignment").select("id")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId).execute())
      .toHaveLength(0);
    expect((await db.selectFrom("principal_access_config_state").select("config_version")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId)
      .executeTakeFirstOrThrow()).config_version).toBe(1);
    expect((await db.selectFrom("quota_counter").select("used_value")
      .where("grant_id", "=", fixture.grantId).executeTakeFirstOrThrow()).used_value).toBe("123");
    expect(await db.selectFrom("principal_access_idempotency").select("idempotency_key")
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", fixture.principalId).execute()).toHaveLength(0);
    expect(await db.selectFrom("operation_log").select("id")
      .where("enterprise_id", "=", enterpriseId).where("target_id", "=", fixture.principalId)
      .where("action", "=", "principal_access_config.save").execute()).toHaveLength(0);
  }, 120_000);
});
