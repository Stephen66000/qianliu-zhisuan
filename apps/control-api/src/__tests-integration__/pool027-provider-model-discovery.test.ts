import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let cookie: string;
const enterpriseId = randomUUID();
const otherEnterpriseId = randomUUID();
const providerId = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "pool027" },
    { id: otherEnterpriseId, name: "pool027-other" },
  ]).execute();
  await db.insertInto("admin_user").values({
    enterprise_id: enterpriseId, username: "pool027", display_name: "POOL-027",
    password_hash: await hashPassword("POOL-027-Password!"), status: "ACTIVE",
  }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "zhipu", name: "智谱",
    adapter_type: "zhipu", status: "ACTIVE",
  }).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/auth/login",
    payload: { username: "pool027", password: "POOL-027-Password!" },
  });
  const header = login.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  await app?.close(); await db?.destroy(); await pg?.stop();
}, 60_000);

afterEach(() => vi.restoreAllMocks());

function onboard(idempotencyKey: string, name: string) {
  return app.inject({
    method: "POST", url: "/provider-resources/onboard", headers: { cookie },
    payload: {
      idempotency_key: idempotencyKey,
      provider_id: providerId,
      name,
      mode: "CODING_PLAN",
      credential_type: "API_KEY",
      credential_plaintext: "sensitive-upstream-key",
      selected_model_ids: ["glm-5.2"],
      operating_snapshot: {
        source: "ADMIN", collected_at: "2026-08-03T00:00:00.000Z",
        total_quota: "100000", quota_unit: "TOKEN",
        effective_from: "2026-08-01T00:00:00.000Z", reset_cycle: "NONE",
      },
    },
  });
}

describe("POOL-027 厂商模型自动发现与接入", () => {
  it("检测只返回 Coding Plan 目录，创建资源/模型/禁用路由且不扩大 Key 权限", async () => {
    const discovery = await app.inject({
      method: "POST", url: "/provider-resources/model-discovery", headers: { cookie },
      payload: { provider_id: providerId, mode: "CODING_PLAN", credential_plaintext: "secret" },
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().source).toBe("VERSIONED_CATALOG");
    expect(discovery.json().models.map((model: { id: string }) => model.id)).toContain("glm-5.2");
    expect(discovery.json().models.some((model: { id: string }) => model.id.includes("embedding"))).toBe(false);

    const response = await onboard("pool027-onboard-001", "智谱 Plan A");
    expect(response.statusCode).toBe(201);
    expect(response.json().result.models[0]).toMatchObject({
      upstreamModel: "glm-5.2", alias: "ql-glm-5.2",
      reused: false, status: "PENDING_CONFIG",
    });
    const route = await db.selectFrom("model_route").selectAll().executeTakeFirstOrThrow();
    expect(route.enabled).toBe(false);
    const model = await db.selectFrom("unified_model").selectAll().executeTakeFirstOrThrow();
    expect(model.status).toBe("PENDING_CONFIG");
    expect(await db.selectFrom("principal_key").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("principal_grant").selectAll().execute()).toHaveLength(0);
    const resource = await db.selectFrom("provider_resource").selectAll().executeTakeFirstOrThrow();
    expect(resource.credential_ciphertext).not.toContain("sensitive-upstream-key");
  });

  it("Kimi Coding Plan 返回官方版本化目录且不调用开放平台 List Models", async () => {
    const kimiProviderId = randomUUID();
    await db.insertInto("provider").values({
      id: kimiProviderId, enterprise_id: enterpriseId, code: "kimi", name: "Kimi",
      adapter_type: "kimi", status: "ACTIVE",
    }).execute();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const discovery = await app.inject({
      method: "POST", url: "/provider-resources/model-discovery", headers: { cookie },
      payload: { provider_id: kimiProviderId, mode: "CODING_PLAN", credential_plaintext: "coding-plan-secret" },
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      source: "VERSIONED_CATALOG",
      source_version: "kimi-coding-plan-2026-08-03",
    });
    expect(discovery.json().models.map((model: { id: string }) => model.id)).toEqual([
      "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("相同幂等键不重复创建；第二资源复用统一模型只增加路由", async () => {
    const retry = await onboard("pool027-onboard-001", "智谱 Plan A");
    expect(retry.statusCode).toBe(201);
    expect(await db.selectFrom("provider_resource").selectAll().execute()).toHaveLength(1);

    const conflictingRetry = await onboard("pool027-onboard-001", "不会覆盖");
    expect(conflictingRetry.statusCode).toBe(409);
    expect(conflictingRetry.json().error).toBe("idempotency_conflict");
    expect(await db.selectFrom("provider_resource").selectAll().execute()).toHaveLength(1);

    const second = await onboard("pool027-onboard-002", "智谱 Plan B");
    expect(second.statusCode).toBe(201);
    expect(second.json().result.models[0].reused).toBe(true);
    expect(await db.selectFrom("unified_model").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("model_route").selectAll().execute()).toHaveLength(2);

    const concurrent = await Promise.all([
      onboard("pool027-onboard-003", "智谱 Plan C"),
      onboard("pool027-onboard-003", "智谱 Plan C"),
    ]);
    expect(concurrent.map((response) => response.statusCode)).toEqual([201, 201]);
    expect(concurrent[0].json().result.resourceId).toBe(concurrent[1].json().result.resourceId);
    expect(await db.selectFrom("provider_resource").selectAll().execute()).toHaveLength(3);
    expect(await db.selectFrom("model_route").selectAll().execute()).toHaveLength(3);
  });

  it("同步快照按企业隔离，确认已存在模型保持幂等", async () => {
    const resource = await db.selectFrom("provider_resource").select("id")
      .where("name", "=", "智谱 Plan A").executeTakeFirstOrThrow();
    await db.updateTable("provider_resource").set({ status: "DEGRADED" })
      .where("id", "=", resource.id).execute();
    const sync = await app.inject({
      method: "POST", url: `/provider-resources/${resource.id}/models/sync`, headers: { cookie }, payload: {},
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({
      source: "VERSIONED_CATALOG",
      source_version: "zhipu-coding_plan-2026-08-03",
    });
    const confirm = await app.inject({
      method: "POST", url: `/provider-resources/${resource.id}/models/confirm`, headers: { cookie },
      payload: { selected_model_ids: ["glm-5.2"] },
    });
    expect(confirm.statusCode).toBe(200);
    expect(await db.selectFrom("model_route").selectAll()
      .where("provider_resource_id", "=", resource.id).execute()).toHaveLength(1);
    expect(await db.selectFrom("provider_resource").select("status")
      .where("id", "=", resource.id).executeTakeFirstOrThrow()).toMatchObject({ status: "DEGRADED" });
    expect(await app.providerRepo.latestModelDiscovery(otherEnterpriseId, resource.id)).toBeNull();
  });

  it("不可服务资源不能同步或确认模型", async () => {
    const resource = await db.selectFrom("provider_resource").select("id")
      .where("name", "=", "智谱 Plan B").executeTakeFirstOrThrow();
    await db.updateTable("provider_resource").set({ status: "EXPIRED" })
      .where("id", "=", resource.id).execute();

    const sync = await app.inject({
      method: "POST", url: `/provider-resources/${resource.id}/models/sync`, headers: { cookie }, payload: {},
    });
    expect(sync.statusCode).toBe(404);

    const confirm = await app.inject({
      method: "POST", url: `/provider-resources/${resource.id}/models/confirm`, headers: { cookie },
      payload: { selected_model_ids: ["glm-5.2"] },
    });
    expect(confirm.statusCode).toBe(404);
  });

  it("同步失败记录失败尝试、保留上次成功快照并阻止从过期结果确认", async () => {
    const deepseekProviderId = randomUUID();
    await db.insertInto("provider").values({
      id: deepseekProviderId,
      enterprise_id: enterpriseId,
      code: "deepseek",
      name: "DeepSeek",
      adapter_type: "deepseek",
      status: "ACTIVE",
    }).execute();
    const created = await app.inject({
      method: "POST",
      url: "/provider-resources",
      headers: { cookie },
      payload: {
        provider_id: deepseekProviderId,
        name: "DeepSeek API",
        mode: "API",
        credential_type: "API_KEY",
        credential_plaintext: "deepseek-secret",
      },
    });
    expect(created.statusCode).toBe(201);
    const resourceId = created.json().resource.id as string;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "deepseek-chat" }] }),
    } as Response);
    const firstSync = await app.inject({
      method: "POST",
      url: `/provider-resources/${resourceId}/models/sync`,
      headers: { cookie },
      payload: {},
    });
    expect(firstSync.statusCode).toBe(200);

    await db.updateTable("provider_resource").set({ status: "DEGRADED" })
      .where("id", "=", resourceId).execute();

    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    const failedSync = await app.inject({
      method: "POST",
      url: `/provider-resources/${resourceId}/models/sync`,
      headers: { cookie },
      payload: {},
    });
    expect(failedSync.statusCode).toBe(401);
    fetchMock.mockRestore();

    const latest = await app.inject({
      method: "GET",
      url: `/provider-resources/${resourceId}/models`,
      headers: { cookie },
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      discovery: { status: "FAILED", failure_code: "UNAUTHORIZED" },
      items_stale: true,
    });
    expect(latest.json().items.map((item: { upstream_model: string }) => item.upstream_model))
      .toEqual(["deepseek-chat"]);

    const confirm = await app.inject({
      method: "POST",
      url: `/provider-resources/${resourceId}/models/confirm`,
      headers: { cookie },
      payload: { selected_model_ids: ["deepseek-chat"] },
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().error).toBe("model_discovery_stale");
  });
});
