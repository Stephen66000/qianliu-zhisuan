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
const employeeId = randomUUID();
const employeeWithoutKeyId = randomUUID();
const disabledEmployeeId = randomUUID();
const archivedEmployeeId = randomUUID();
const providerId = randomUUID();
const resourceId = randomUUID();
const modelId = randomUUID();
const secondModelId = randomUUID();
const manualModelId = randomUUID();
const disabledRouteModelId = randomUUID();
const legacyProviderId = randomUUID();
const legacyResourceId = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL-029" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "pool029", display_name: "POOL-029",
    password_hash: await hashPassword("POOL-029-Password!"), status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values([
    { id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工 A", status: "ACTIVE" },
    { id: employeeWithoutKeyId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工 B", status: "ACTIVE" },
    { id: disabledEmployeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工 C", status: "DISABLED" },
    // 归档主体（模拟 POOL-008/009 验收遗留）：catalog 应过滤掉，不展示。
    { id: archivedEmployeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "归档员工 D", status: "DISABLED", archived_at: new Date("2026-08-01T00:00:00Z") },
  ]).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "kimi", name: "Kimi", adapter_type: "kimi", status: "ACTIVE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId, name: "Kimi Plan",
    mode: "CODING_PLAN", credential_type: "API_KEY", status: "ACTIVE",
  }).execute();
  await db.insertInto("unified_model").values([
    { id: modelId, enterprise_id: enterpriseId, alias: "kimi-high", display_name: "Kimi High", status: "ACTIVE" },
    { id: secondModelId, enterprise_id: enterpriseId, alias: "kimi-second", display_name: "Kimi Second", status: "ACTIVE" },
    { id: manualModelId, enterprise_id: enterpriseId, alias: "manual-only", display_name: "手工模型", status: "ACTIVE" },
    // 旧笼统别名（模拟 pool033 切型号时停用的 route）：catalog 应过滤掉，不展示。
    { id: disabledRouteModelId, enterprise_id: enterpriseId, alias: "legacy-alias", display_name: "停用别名", status: "DISABLED" },
  ]).execute();
  // 停用别名挂到独立厂商/资源上，避免污染 Kimi 厂商池的白名单计算（refreshKeyModels 按 provider 关联）。
  await db.insertInto("provider").values({
    id: legacyProviderId, enterprise_id: enterpriseId, code: "legacy", name: "Legacy", adapter_type: "kimi", status: "ACTIVE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: legacyResourceId, enterprise_id: enterpriseId, provider_id: legacyProviderId, name: "Legacy Plan",
    mode: "CODING_PLAN", credential_type: "API_KEY", status: "ACTIVE",
  }).execute();
  await db.insertInto("model_route").values([
    { enterprise_id: enterpriseId, unified_model_id: modelId, provider_resource_id: resourceId,
      upstream_model: "kimi-for-coding-highspeed", enabled: true },
    { enterprise_id: enterpriseId, unified_model_id: secondModelId, provider_resource_id: resourceId,
      upstream_model: "kimi-second", enabled: true },
    { enterprise_id: enterpriseId, unified_model_id: disabledRouteModelId, provider_resource_id: legacyResourceId,
      upstream_model: "legacy-model", enabled: false },
  ]).execute();
  await db.insertInto("billing_rule").values([
    { enterprise_id: enterpriseId, provider_resource_id: resourceId, upstream_model: "kimi-for-coding-highspeed",
      rule_type: "MODEL_TIER", rule_version: "pool029-v1", effective_from: new Date("2026-01-01T00:00:00Z"),
      multiplier: "1", enabled: true },
    { enterprise_id: enterpriseId, provider_resource_id: resourceId, upstream_model: null,
      rule_type: "MODEL_TIER", rule_version: "pool029-second-v1", effective_from: new Date("2026-01-01T00:00:00Z"),
      multiplier: "1", enabled: true },
  ]).execute();
  await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId, principal_id: employeeId, key_prefix: "sk-qianliu-pool029",
    key_digest: "pool029-digest", allowed_model_ids: JSON.stringify([manualModelId]) as unknown as string[], status: "ACTIVE",
  }).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "pool029", password: "POOL-029-Password!" } });
  const header = login.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  await app?.close(); await db?.destroy(); await pg?.stop();
}, 60_000);

function createRule(principalIds = [employeeId], targetModelId = modelId, name = "研发员工 Kimi 规则") {
  return app.inject({
    method: "POST", url: "/employee-model-rules", headers: { cookie },
    payload: {
      name, employee_scope: "SELECTED", principal_ids: principalIds,
      model_scope: "SELECTED", model_targets: [{ unified_model_id: targetModelId, provider_resource_id: resourceId }],
      quota_value: "500000", allow_overage: false, valid_from: "2026-08-01T00:00:00.000Z", valid_until: null,
    },
  });
}

describe("POOL-029 员工模型授权发布闭环", () => {
  it("目录按厂商展示模型就绪原因，且不暴露凭证", async () => {
    const response = await app.inject({ method: "GET", url: "/employee-model-rules/catalog", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().models[0]).toMatchObject({
      provider_name: "Kimi", display_name: "Kimi High", ready: true,
    });
    expect(response.json().models.find((item: { unified_model_id: string }) => item.unified_model_id === secondModelId))
      .toMatchObject({ ready: true });
    expect(response.body).not.toContain("pool029-digest");
    expect(response.json().principals.find((item: { id: string }) => item.id === employeeWithoutKeyId))
      .toMatchObject({ ready: false, unavailable_reason: "员工尚无有效 Key" });
    expect(response.json().principals.find((item: { id: string }) => item.id === disabledEmployeeId))
      .toMatchObject({ ready: false, unavailable_reason: "员工主体未启用" });
    // 已归档主体不应出现在批量授权目录中（POOL-008/009 验收遗留隐藏）。
    expect(response.json().principals.find((item: { id: string }) => item.id === archivedEmployeeId))
      .toBeUndefined();
    // 未启用 route（旧笼统别名）不应出现在批量授权目录中。
    expect(response.json().models.find((item: { unified_model_id: string }) => item.unified_model_id === disabledRouteModelId))
      .toBeUndefined();
  });

  it("校验后原子发布 Key＋Grant，重试幂等且保留手工权限事实", async () => {
    const created = await createRule();
    expect(created.statusCode).toBe(201);
    const versionId = created.json().version.id as string;
    const validated = await app.inject({ method: "POST", url: `/employee-model-rules/versions/${versionId}/validate`, headers: { cookie } });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().validation).toMatchObject({ ready: true, principal_count: 1, model_count: 1, assignment_count: 1 });
    expect(validated.json().validation.changes).toMatchObject({
      added: [expect.objectContaining({ principal_name: "员工 A", model_name: "Kimi High", resource_name: "Kimi Plan" })],
      retained: [], removed: [],
    });
    const listed = await app.inject({ method: "GET", url: "/employee-model-rules", headers: { cookie } });
    const version = listed.json().rules.find((item: { id: string }) => item.id === versionId);
    expect(version.status).toBe("VALIDATED");

    const publishBody = { expected_lock_version: version.lock_version, idempotency_key: "pool029-publish-001" };
    const [published, retry] = await Promise.all([
      app.inject({ method: "POST", url: `/employee-model-rules/versions/${versionId}/publish`, headers: { cookie }, payload: publishBody }),
      app.inject({ method: "POST", url: `/employee-model-rules/versions/${versionId}/publish`, headers: { cookie }, payload: publishBody }),
    ]);
    expect([published.statusCode, retry.statusCode]).toEqual([200, 200]);
    expect(published.json().assignment_count).toBe(1);
    expect(await db.selectFrom("employee_model_rule_assignment").selectAll().execute()).toHaveLength(1);
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${versionId}/publish`, headers: { cookie },
      payload: { ...publishBody, quota_mode: "ADD" },
    })).statusCode).toBe(409);

    const key = await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("principal_id", "=", employeeId).executeTakeFirstOrThrow();
    // POOL-033：池语义下，已开通厂商的所有就绪型号默认放行（新接入型号自动并入）。
    // 手工基线事实继续保留，但没有可用 Route／计费规则的 manualModelId 不得进入 ACTIVE Key 白名单。
    expect(new Set(key.allowed_model_ids)).toEqual(new Set([modelId, secondModelId]));
    expect(await db.selectFrom("principal_model_manual_authorization").select("unified_model_id")
      .where("principal_id", "=", employeeId).where("unified_model_id", "=", manualModelId)
      .executeTakeFirst()).toBeDefined();
    // POOL-033：池模型下发布产生的是"主体×厂商"池 Grant，不是型号级 Grant。
    const grant = await db.selectFrom("principal_grant").selectAll().where("principal_id", "=", employeeId).executeTakeFirstOrThrow();
    expect(grant).toMatchObject({ provider: "kimi", model_alias: "*", pool_model_alias: "*", quota_value: "500000", status: "ACTIVE", authorization_rule_version_id: versionId });
    expect(await db.selectFrom("operation_log").selectAll().where("action", "=", "employee_model_rule.publish").execute()).toHaveLength(1);

    const next = await app.inject({ method: "POST", url: `/employee-model-rules/${created.json().version.rule_id}/versions`, headers: { cookie } });
    expect(next.statusCode).toBe(201);
    const nextVersionId = next.json().version.id as string;
    const revalidated = await app.inject({ method: "POST", url: `/employee-model-rules/versions/${nextVersionId}/validate`, headers: { cookie } });
    expect(revalidated.json().validation.changes).toMatchObject({ added: [], retained: [expect.objectContaining({ principal_name: "员工 A", model_name: "Kimi High" })], removed: [] });
    const refreshed = await app.inject({ method: "GET", url: "/employee-model-rules", headers: { cookie } });
    const nextVersion = refreshed.json().rules.find((item: { id: string }) => item.id === nextVersionId);
    const republished = await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${nextVersionId}/publish`, headers: { cookie },
      payload: { expected_lock_version: nextVersion.lock_version, idempotency_key: "pool029-publish-002" },
    });
    expect(republished.statusCode).toBe(200);
    const history = await app.inject({ method: "GET", url: `/employee-model-rules/${created.json().version.rule_id}/history`, headers: { cookie } });
    expect(history.json().versions.map((item: { version: number; status: string }) => [item.version, item.status]))
      .toEqual([[2, "PUBLISHED"], [1, "DISABLED"]]);

    const disabled = await app.inject({ method: "POST", url: `/employee-model-rules/versions/${nextVersionId}/disable`, headers: { cookie } });
    expect(disabled.statusCode).toBe(200);
    // POOL-033 池化语义：停用规则后池 Grant 保持 ACTIVE（可能被其他规则共享），
    // 白名单仍含手工模型 + 该厂商未被显式禁用的就绪型号；被停用的 modelId 必须
    // (a) 不在白名单中，(b) 在显式禁用清单中——热路径凭禁用清单即时拒绝。
    const keyAfterDisable = (await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("principal_id", "=", employeeId).executeTakeFirstOrThrow()).allowed_model_ids;
    expect(keyAfterDisable).not.toContain(manualModelId);
    expect(keyAfterDisable).not.toContain(modelId);
    expect(await db.selectFrom("principal_model_manual_authorization").select("unified_model_id")
      .where("principal_id", "=", employeeId).where("unified_model_id", "=", manualModelId)
      .executeTakeFirst()).toBeDefined();
    const disabledModels = await db.selectFrom("principal_provider_disabled_model").selectAll()
      .where("principal_id", "=", employeeId).execute();
    expect(disabledModels.length).toBeGreaterThan(0);
    expect(disabledModels.map((row) => row.unified_model_id)).toContain(modelId);
  });

  it("任一员工无有效 Key 时阻断发布且不产生半授权", async () => {
    const created = await createRule([employeeId, employeeWithoutKeyId]);
    const versionId = created.json().version.id as string;
    const validated = await app.inject({ method: "POST", url: `/employee-model-rules/versions/${versionId}/validate`, headers: { cookie } });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().validation.ready).toBe(false);
    expect(validated.json().validation.issues).toContainEqual(expect.objectContaining({ code: "KEY_UNAVAILABLE", principal_id: employeeWithoutKeyId }));
    const before = await db.selectFrom("employee_model_rule_assignment").selectAll().execute();
    const listed = await app.inject({ method: "GET", url: "/employee-model-rules", headers: { cookie } });
    const version = listed.json().rules.find((item: { id: string }) => item.id === versionId);
    const publish = await app.inject({ method: "POST", url: `/employee-model-rules/versions/${versionId}/publish`, headers: { cookie }, payload: { expected_lock_version: version.lock_version, idempotency_key: "pool029-publish-invalid" } });
    expect(publish.statusCode).toBe(409);
    expect(await db.selectFrom("employee_model_rule_assignment").selectAll().execute()).toHaveLength(before.length);
  });

  it("发布中途写入失败时 Key、Grant 和任务全部回滚", async () => {
    const created = await createRule();
    const versionId = created.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${versionId}/validate`, headers: { cookie } });
    const listed = await app.inject({ method: "GET", url: "/employee-model-rules", headers: { cookie } });
    const version = listed.json().rules.find((item: { id: string }) => item.id === versionId);
    const beforeGrants = await db.selectFrom("principal_grant").selectAll().execute();
    const beforeKey = await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("principal_id", "=", employeeId).executeTakeFirstOrThrow();
    await sql`CREATE FUNCTION pool029_fail_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected assignment failure'; END $$`.execute(db);
    await sql`CREATE TRIGGER pool029_fail_assignment BEFORE INSERT ON employee_model_rule_assignment FOR EACH ROW EXECUTE FUNCTION pool029_fail_assignment()`.execute(db);
    try {
      const response = await app.inject({
        method: "POST", url: `/employee-model-rules/versions/${versionId}/publish`, headers: { cookie },
        payload: { expected_lock_version: version.lock_version, idempotency_key: "pool029-injected-failure" },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await sql`DROP TRIGGER pool029_fail_assignment ON employee_model_rule_assignment`.execute(db);
      await sql`DROP FUNCTION pool029_fail_assignment()`.execute(db);
    }
    expect(await db.selectFrom("principal_grant").selectAll().execute()).toHaveLength(beforeGrants.length);
    expect((await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("principal_id", "=", employeeId).executeTakeFirstOrThrow()).allowed_model_ids)
      .toEqual(beforeKey.allowed_model_ids);
    expect((await db.selectFrom("employee_model_rule_version").select("status").where("id", "=", versionId)
      .executeTakeFirstOrThrow()).status).toBe("VALIDATED");
  });

  it("不同规则并发发布到同一员工时不会丢失任一模型权限", async () => {
    const principalId = randomUUID();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "并发员工", status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "pool029-concurrent",
      key_digest: randomUUID(), allowed_model_ids: JSON.stringify([manualModelId]) as unknown as string[], status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_model_manual_authorization").values({
      enterprise_id: enterpriseId, principal_id: principalId, unified_model_id: manualModelId,
    }).execute();
    const [first, second] = await Promise.all([
      createRule([principalId], modelId, "并发规则 A"),
      createRule([principalId], secondModelId, "并发规则 B"),
    ]);
    const versionIds = [first.json().version.id, second.json().version.id] as string[];
    await Promise.all(versionIds.map((id) => app.inject({
      method: "POST", url: `/employee-model-rules/versions/${id}/validate`, headers: { cookie },
    })));
    const listed = await app.inject({ method: "GET", url: "/employee-model-rules", headers: { cookie } });
    const versions = versionIds.map((id) => listed.json().rules.find((item: { id: string }) => item.id === id));
    await sql`CREATE FUNCTION pool029_slow_key_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`.execute(db);
    await sql`CREATE TRIGGER pool029_slow_key_update BEFORE UPDATE ON principal_key FOR EACH ROW EXECUTE FUNCTION pool029_slow_key_update()`.execute(db);
    try {
      const responses = await Promise.all(versions.map((version, index) => app.inject({
        method: "POST", url: `/employee-model-rules/versions/${version.id}/publish`, headers: { cookie },
        payload: { expected_lock_version: version.lock_version, idempotency_key: `pool029-concurrent-${index}` },
      })));
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    } finally {
      await sql`DROP TRIGGER pool029_slow_key_update ON principal_key`.execute(db);
      await sql`DROP FUNCTION pool029_slow_key_update()`.execute(db);
    }
    const key = await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("principal_id", "=", principalId).executeTakeFirstOrThrow();
    expect(new Set(key.allowed_model_ids)).toEqual(new Set([modelId, secondModelId]));
    expect(await db.selectFrom("principal_model_manual_authorization").select("unified_model_id")
      .where("principal_id", "=", principalId).where("unified_model_id", "=", manualModelId)
      .executeTakeFirst()).toBeDefined();
  });

  it("手工授权与规则发布并发时按 Key 行锁串行化，不覆盖刚发布的模型", async () => {
    const principalId = randomUUID();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "手工并发员工", status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "pool029-manual-concurrent",
      key_digest: randomUUID(), allowed_model_ids: JSON.stringify([manualModelId]) as unknown as string[], status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_model_manual_authorization").values({
      enterprise_id: enterpriseId, principal_id: principalId, unified_model_id: manualModelId,
    }).execute();
    const created = await createRule([principalId], modelId, "手工并发规则");
    const versionId = created.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${versionId}/validate`, headers: { cookie } });
    const version = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", versionId)
      .executeTakeFirstOrThrow();
    await sql`CREATE FUNCTION pool029_hold_key_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`.execute(db);
    await sql`CREATE TRIGGER pool029_hold_key_update BEFORE UPDATE ON principal_key FOR EACH ROW EXECUTE FUNCTION pool029_hold_key_update()`.execute(db);
    try {
      const publish = app.inject({
        method: "POST", url: `/employee-model-rules/versions/${versionId}/publish`, headers: { cookie },
        payload: { expected_lock_version: version.lock_version, idempotency_key: "pool029-manual-concurrent" },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const manual = app.inject({
        method: "PATCH", url: `/principals/${principalId}/key`, headers: { cookie },
        payload: { allowed_model_ids: [secondModelId] },
      });
      const [published, updated] = await Promise.all([publish, manual]);
      expect([published.statusCode, updated.statusCode]).toEqual([200, 200]);
    } finally {
      await sql`DROP TRIGGER pool029_hold_key_update ON principal_key`.execute(db);
      await sql`DROP FUNCTION pool029_hold_key_update()`.execute(db);
    }
    const key = await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("principal_id", "=", principalId).where("status", "=", "ACTIVE").executeTakeFirstOrThrow();
    expect(new Set(key.allowed_model_ids)).toEqual(new Set([modelId, secondModelId]));
  });

  it("规则发布后撤销并重新创建 Key 时继承受管模型，手工重叠预览为保留", async () => {
    const principalId = randomUUID();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "重建员工", status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "pool029-recreate-old",
      key_digest: randomUUID(), allowed_model_ids: JSON.stringify([modelId]) as unknown as string[], status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_model_manual_authorization").values({
      enterprise_id: enterpriseId, principal_id: principalId, unified_model_id: modelId,
    }).execute();
    const created = await createRule([principalId], modelId, "重建规则");
    const versionId = created.json().version.id as string;
    const validated = await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${versionId}/validate`, headers: { cookie },
    });
    expect(validated.json().validation.changes).toMatchObject({
      added: [], retained: [expect.objectContaining({ unified_model_id: modelId })], removed: [],
    });
    const listed = await app.inject({ method: "GET", url: "/employee-model-rules", headers: { cookie } });
    const version = listed.json().rules.find((item: { id: string }) => item.id === versionId);
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${versionId}/publish`, headers: { cookie },
      payload: { expected_lock_version: version.lock_version, idempotency_key: "pool029-recreate-publish" },
    })).statusCode).toBe(200);
    await db.updateTable("principal_key").set({ status: "REVOKED", revoked_at: new Date() })
      .where("principal_id", "=", principalId).where("status", "=", "ACTIVE").execute();
    const recreated = await app.inject({
      method: "POST", url: `/principals/${principalId}/key`, headers: { cookie },
      payload: { allowed_model_ids: [manualModelId] },
    });
    expect(recreated.statusCode).toBe(201);
    expect(new Set(recreated.json().metadata.allowed_model_ids)).toEqual(new Set([manualModelId, modelId]));
  });

  it("编辑与错误状态稳定映射为 400/404/409", async () => {
    const invalidCreate = await app.inject({
      method: "POST", url: "/employee-model-rules", headers: { cookie },
      payload: {
        name: "", employee_scope: "SELECTED", principal_ids: [], model_scope: "SELECTED", model_targets: [],
        quota_value: "-1", allow_overage: false, valid_from: "2026-08-02T00:00:00Z",
        valid_until: "2026-08-01T00:00:00Z",
      },
    });
    expect(invalidCreate.statusCode).toBe(400);
    const invalidPoolQuotas = await app.inject({
      method: "POST", url: "/employee-model-rules", headers: { cookie },
      payload: {
        name: "非法厂商额度", employee_scope: "SELECTED", principal_ids: [employeeId],
        model_scope: "SELECTED", model_targets: [{ unified_model_id: modelId, provider_resource_id: resourceId }],
        quota_value: "100", allow_overage: false, valid_from: "2026-08-02T00:00:00Z", valid_until: null,
        pool_quotas: [
          { provider_code: "kimi", quota_value: "30", allow_overage: false, valid_until: "2026-08-01T00:00:00Z" },
          { provider_code: "kimi", quota_value: "70", allow_overage: true, valid_until: null },
        ],
      },
    });
    expect(invalidPoolQuotas.statusCode).toBe(400);
    const validPoolQuota = await app.inject({
      method: "POST", url: "/employee-model-rules", headers: { cookie },
      payload: {
        name: "合法厂商额度", employee_scope: "SELECTED", principal_ids: [employeeId],
        model_scope: "SELECTED", model_targets: [{ unified_model_id: modelId, provider_resource_id: resourceId }],
        quota_value: "100", allow_overage: false, valid_from: "2026-08-01T00:00:00Z", valid_until: null,
        pool_quotas: [{
          provider_code: "kimi", quota_value: "75", allow_overage: true,
          valid_until: "2026-09-01T00:00:00Z",
        }],
      },
    });
    expect(validPoolQuota.statusCode).toBe(201);
    expect(validPoolQuota.json().version.pool_quotas).toEqual([{
      provider_code: "kimi", quota_value: "75", allow_overage: true,
      valid_until: "2026-09-01T00:00:00.000Z",
    }]);
    const created = await createRule([employeeId], secondModelId, "编辑规则");
    const version = created.json().version;
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/${version.rule_id}/versions`, headers: { cookie },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "PATCH", url: `/employee-model-rules/versions/${version.id}`, headers: { cookie }, payload: {},
    })).statusCode).toBe(400);
    const updated = await app.inject({
      method: "PATCH", url: `/employee-model-rules/versions/${version.id}`, headers: { cookie },
      payload: {
        expected_lock_version: version.lock_version,
        rule: {
          name: "编辑后规则", employee_scope: "SELECTED", principal_ids: [employeeId, employeeId],
          model_scope: "SELECTED", model_targets: [
            { unified_model_id: secondModelId, provider_resource_id: resourceId },
            { unified_model_id: secondModelId, provider_resource_id: resourceId },
          ],
          quota_value: "100", allow_overage: true, valid_from: "2026-08-01T00:00:00Z", valid_until: null,
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH", url: `/employee-model-rules/versions/${version.id}`, headers: { cookie },
      payload: { expected_lock_version: version.lock_version, rule: {
        name: "过期编辑", employee_scope: "ALL", principal_ids: [], model_scope: "ALL", model_targets: [],
        quota_value: "0", allow_overage: false, valid_from: "2026-08-01T00:00:00Z", valid_until: null,
      } },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${randomUUID()}/validate`, headers: { cookie },
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${version.id}/publish`, headers: { cookie }, payload: {},
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${version.id}/publish`, headers: { cookie },
      payload: { expected_lock_version: updated.json().version.lock_version, idempotency_key: "pool029-edit-draft" },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${version.id}/disable`, headers: { cookie },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${randomUUID()}/disable`, headers: { cookie },
    })).statusCode).toBe(404);
  });

  it("发布状态机覆盖重复键、过期锁、重新校验和撤权后就绪变化", async () => {
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/${randomUUID()}/versions`, headers: { cookie },
    })).statusCode).toBe(404);

    // 先创建并发布一个规则，供后续停用测试使用。
    const setupRule = await createRule([employeeId], modelId, "状态机测试规则");
    const setupId = setupRule.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${setupId}/validate`, headers: { cookie } });
    const setupRow = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", setupId)
      .executeTakeFirstOrThrow();
    await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${setupId}/publish`, headers: { cookie },
      payload: { expected_lock_version: setupRow.lock_version, idempotency_key: "pool029-setup" },
    });

    const published = await db.selectFrom("employee_model_rule_version").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("status", "=", "PUBLISHED")
      .executeTakeFirst();
    expect(published).toBeDefined();
    if (!published) throw new Error("no published rule found");
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${published.id}/validate`, headers: { cookie },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${published.id}/publish`, headers: { cookie },
      payload: { expected_lock_version: published.lock_version, idempotency_key: "pool029-wrong-retry" },
    })).statusCode).toBe(409);

    const stale = await createRule([employeeId], secondModelId, "过期锁规则");
    const staleId = stale.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${staleId}/validate`, headers: { cookie } });
    const staleRow = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", staleId)
      .executeTakeFirstOrThrow();
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${staleId}/publish`, headers: { cookie },
      payload: { expected_lock_version: staleRow.lock_version - 1, idempotency_key: "pool029-stale-lock" },
    })).statusCode).toBe(409);

    const reuse = await createRule([employeeId], secondModelId, "重复幂等键规则");
    const reuseId = reuse.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${reuseId}/validate`, headers: { cookie } });
    const reuseRow = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", reuseId)
      .executeTakeFirstOrThrow();
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${reuseId}/publish`, headers: { cookie },
      payload: { expected_lock_version: reuseRow.lock_version, idempotency_key: published.publish_idempotency_key },
    })).statusCode).toBe(409);

    const principalId = randomUUID();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "撤权员工", status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "pool029-readiness",
      key_digest: randomUUID(), allowed_model_ids: JSON.stringify([]) as unknown as string[], status: "ACTIVE",
    }).execute();
    const readiness = await createRule([principalId], modelId, "就绪变化规则");
    const readinessId = readiness.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${readinessId}/validate`, headers: { cookie } });
    const readinessRow = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", readinessId)
      .executeTakeFirstOrThrow();
    await db.updateTable("principal_key").set({ status: "REVOKED", revoked_at: new Date() })
      .where("principal_id", "=", principalId).execute();
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${readinessId}/publish`, headers: { cookie },
      payload: { expected_lock_version: readinessRow.lock_version, idempotency_key: "pool029-readiness-changed" },
    })).statusCode).toBe(422);

    // 独立创建 DISABLED 行（依赖同一事务内先前的测试，先前失败会连锁挂掉）：
    // 发布 setup 规则的新版本 → 旧版本自动置 DISABLED → 幂等停用返回 200。
    const disableRule = await createRule([employeeId], modelId, "停用幂等规则");
    const disableRuleId = disableRule.json().version.rule_id as string;
    const disableV1 = disableRule.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${disableV1}/validate`, headers: { cookie } });
    const disableV1Row = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", disableV1)
      .executeTakeFirstOrThrow();
    const disablePublish = await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${disableV1}/publish`, headers: { cookie },
      payload: { expected_lock_version: disableV1Row.lock_version, idempotency_key: "pool029-disable-setup" },
    });
    expect(disablePublish.statusCode).toBe(200);
    const disableV2 = await app.inject({
      method: "POST", url: `/employee-model-rules/${disableRuleId}/versions`, headers: { cookie },
    });
    expect(disableV2.statusCode).toBe(201);
    const disableV2Id = disableV2.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${disableV2Id}/validate`, headers: { cookie } });
    const disableV2Row = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", disableV2Id)
      .executeTakeFirstOrThrow();
    const disableRepublish = await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${disableV2Id}/publish`, headers: { cookie },
      payload: { expected_lock_version: disableV2Row.lock_version, idempotency_key: "pool029-disable-republish" },
    });
    expect(disableRepublish.statusCode).toBe(200);

    const disabled = await db.selectFrom("employee_model_rule_version").selectAll()
      .where("id", "=", disableV1).executeTakeFirst();
    expect(disabled).toBeDefined();
    if (!disabled) throw new Error("no disabled rule found");
    expect(disabled.status).toBe("DISABLED");
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${disabled.id}/disable`, headers: { cookie },
    })).statusCode).toBe(200);
  });

  it("POOL-033 §6：批量发布 ADD 模式在池行锁内追加额度，SET 语义不变", async () => {
    const principalId = randomUUID();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "追加员工", status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "pool029-add",
      key_digest: randomUUID(), allowed_model_ids: JSON.stringify([]) as unknown as string[], status: "ACTIVE",
    }).execute();

    const poolOf = () => db.selectFrom("principal_grant").selectAll()
      .where("principal_id", "=", principalId).where("provider", "=", "kimi")
      .where("pool_model_alias", "=", "*").where("status", "=", "ACTIVE").executeTakeFirstOrThrow();

    // 第一次发布（默认 SET）：建池，额度 = 规则值 500000。
    const first = await createRule([principalId], modelId, "追加规则 v1");
    const firstId = first.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${firstId}/validate`, headers: { cookie } });
    const firstRow = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", firstId)
      .executeTakeFirstOrThrow();
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${firstId}/publish`, headers: { cookie },
      payload: { expected_lock_version: firstRow.lock_version, idempotency_key: "pool029-add-set" },
    })).statusCode).toBe(200);
    const firstPool = await poolOf();
    expect(firstPool.quota_value).toBe("500000");

    // 第二次发布（ADD）：同一厂商池已存在 → 锁内追加 500000 → 1000000。
    const second = await createRule([principalId], modelId, "追加规则 v2");
    const secondId = second.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${secondId}/validate`, headers: { cookie } });
    const secondRow = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", secondId)
      .executeTakeFirstOrThrow();
    const added = await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${secondId}/publish`, headers: { cookie },
      payload: { expected_lock_version: secondRow.lock_version, idempotency_key: "pool029-add-add", quota_mode: "ADD" },
    });
    expect(added.statusCode).toBe(200);
    expect(await poolOf()).toMatchObject({
      quota_value: "1000000", version: firstPool.version + 1, authorization_rule_version_id: secondId,
    });

    // 再次默认 SET：已有池也必须覆盖额度、超额开关与规则归属，而不是静默沿用旧值。
    const reset = await createRule([principalId], modelId, "追加规则 SET");
    const resetId = reset.json().version.id as string;
    await app.inject({ method: "POST", url: `/employee-model-rules/versions/${resetId}/validate`, headers: { cookie } });
    const resetRow = await db.selectFrom("employee_model_rule_version").selectAll().where("id", "=", resetId)
      .executeTakeFirstOrThrow();
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${resetId}/publish`, headers: { cookie },
      payload: { expected_lock_version: resetRow.lock_version, idempotency_key: "pool029-add-reset" },
    })).statusCode).toBe(200);
    expect(await poolOf()).toMatchObject({ quota_value: "500000", allow_overage: false, authorization_rule_version_id: resetId });

    // 非法 quota_mode 被 schema 拒绝。
    expect((await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${secondId}/publish`, headers: { cookie },
      payload: { expected_lock_version: secondRow.lock_version, idempotency_key: "pool029-add-bad", quota_mode: "MUL" },
    })).statusCode).toBe(400);
  });

  it("POOL-033：编排端点 PUT 全链路（池 upsert+开关+白名单）与 GET over_limit 标记", async () => {
    const principalId = randomUUID();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "编排员工", status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "pool029-orchestration",
      key_digest: randomUUID(), allowed_model_ids: JSON.stringify([]) as unknown as string[], status: "ACTIVE",
    }).execute();

    // GET 初始：无池，config_version=1。
    const initial = await app.inject({
      method: "GET", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().config_version).toBe(1);
    expect(initial.json().summary.provider_count).toBe(0);

    // PUT：开通 kimi 池（额度 500000），只启用 modelId（secondModelId 掐掉）。
    const put = await app.inject({
      method: "PUT", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
      payload: {
        expected_version: 1, idempotency_key: "pool029-orch-put-001",
        providers: [{ provider_code: "kimi", quota_value: "500000", allow_overage: false,
          valid_until: null, enabled_model_ids: [modelId] }],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().config_version).toBe(2);
    expect(put.json().changes.pools_added).toEqual(["kimi"]);

    // 池建成；白名单含 modelId，secondModelId 进显式禁用清单。
    const pool = await db.selectFrom("principal_grant").selectAll()
      .where("principal_id", "=", principalId).where("provider", "=", "kimi")
      .where("pool_model_alias", "=", "*").where("status", "=", "ACTIVE").executeTakeFirstOrThrow();
    expect(pool.quota_value).toBe("500000");
    const key = await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("principal_id", "=", principalId).executeTakeFirstOrThrow();
    expect(key.allowed_model_ids).toContain(modelId);
    expect(key.allowed_model_ids).not.toContain(secondModelId);
    const disabledRows = await db.selectFrom("principal_provider_disabled_model").selectAll()
      .where("principal_id", "=", principalId).execute();
    expect(disabledRows.map((row) => row.unified_model_id)).toContain(secondModelId);

    // 幂等重放：同键同请求返回原响应、config_version 不再自增。
    const replay = await app.inject({
      method: "PUT", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
      payload: {
        expected_version: 1, idempotency_key: "pool029-orch-put-001",
        providers: [{ provider_code: "kimi", quota_value: "500000", allow_overage: false,
          valid_until: null, enabled_model_ids: [modelId] }],
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().config_version).toBe(2);

    // 乐观锁：过期 expected_version 409。
    expect((await app.inject({
      method: "PUT", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
      payload: { expected_version: 1, idempotency_key: "pool029-orch-put-002", providers: [] },
    })).statusCode).toBe(409);

    // over_limit：已用量 > 额度时 GET 标 true（GLM 评审 P1-1）。
    await db.updateTable("quota_counter").set({ used_value: 600000n })
      .where("grant_id", "=", pool.id).execute();
    const over = await app.inject({
      method: "GET", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
    });
    const kimiBlock = over.json().providers.find((p: { provider_code: string }) => p.provider_code === "kimi");
    expect(kimiBlock.pool.over_limit).toBe(true);
    expect(kimiBlock.pool.quota_used).toBe("600000");
  });

  it("全部员工与全部就绪模型范围也执行完整校验", async () => {
    const created = await app.inject({
      method: "POST", url: "/employee-model-rules", headers: { cookie }, payload: {
        name: "全量范围规则", employee_scope: "ALL", principal_ids: [],
        model_scope: "ALL", model_targets: [], quota_value: "0", allow_overage: false,
        valid_from: "2026-08-01T00:00:00Z", valid_until: null,
      },
    });
    expect(created.statusCode).toBe(201);
    const validated = await app.inject({
      method: "POST", url: `/employee-model-rules/versions/${created.json().version.id}/validate`, headers: { cookie },
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().validation.model_count).toBeGreaterThanOrEqual(2);
    expect(validated.json().validation.ready).toBe(false);
  });
});
