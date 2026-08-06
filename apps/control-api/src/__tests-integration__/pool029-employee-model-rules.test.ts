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
const providerId = randomUUID();
const resourceId = randomUUID();
const modelId = randomUUID();
const secondModelId = randomUUID();
const manualModelId = randomUUID();

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
  ]).execute();
  await db.insertInto("model_route").values([
    { enterprise_id: enterpriseId, unified_model_id: modelId, provider_resource_id: resourceId,
      upstream_model: "kimi-for-coding-highspeed", enabled: true },
    { enterprise_id: enterpriseId, unified_model_id: secondModelId, provider_resource_id: resourceId,
      upstream_model: "kimi-second", enabled: true },
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
  });

  it("校验后原子发布 Key＋Grant，重试幂等且保留手工权限", async () => {
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

    const key = await db.selectFrom("principal_key").select("allowed_model_ids")
      .where("principal_id", "=", employeeId).executeTakeFirstOrThrow();
    // POOL-033：池语义下，已开通厂商的所有就绪型号默认放行（新接入型号自动并入）。
    // 本测试厂商有 modelId 和 secondModelId 两个就绪型号，发布后白名单包含手工模型 + 两个就绪型号。
    expect(new Set(key.allowed_model_ids)).toEqual(new Set([manualModelId, modelId, secondModelId]));
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
    expect(keyAfterDisable).toContain(manualModelId);
    expect(keyAfterDisable).not.toContain(modelId);
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
    expect(new Set(key.allowed_model_ids)).toEqual(new Set([manualModelId, modelId, secondModelId]));
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
