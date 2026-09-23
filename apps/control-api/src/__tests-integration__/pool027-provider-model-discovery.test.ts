import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { credentialFingerprint } from "@qianliu/provider-adapters";
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
    // 登录路由取 created_at 最小的企业；显式时间戳消除同语句插入的排序不确定性。
    { id: enterpriseId, name: "pool027", created_at: new Date("2026-09-21T00:00:00.000Z") },
    { id: otherEnterpriseId, name: "pool027-other", created_at: new Date("2026-09-21T00:00:01.000Z") },
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
  const previousFinanceMode = process.env.PROVIDER_FINANCE_MODE;
  process.env.PROVIDER_FINANCE_MODE = "OFF";
  try {
    app = buildControlApi(db);
  } finally {
    if (previousFinanceMode === undefined) delete process.env.PROVIDER_FINANCE_MODE;
    else process.env.PROVIDER_FINANCE_MODE = previousFinanceMode;
  }
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

function mockOfficialDocs() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    // WP04：权限探针为 POST chat/completions，返回最小 2xx 完成响应；
    // 其余（GET 官方文档）返回文档正文。
    if ((init?.method ?? "GET") === "POST") {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          id: "probe-1", object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    }
    const body = url.includes("kimi")
      ? "Model ID | `k3` | `k3-256k` | `kimi-for-coding` | `kimi-for-coding-highspeed`"
      : "| 模型 ID | `glm-5.2` | `glm-5.3` |\n| 上下文 | 256K | 1M | 最大输出 | 128K | 128K |";
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: (name: string) => name === "etag" ? "test-docs" : null },
      text: async () => body,
    } as unknown as Response;
  });
}

function mockValidationUpstream(delayMs = 0) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const body = JSON.parse(String(init.body)) as { stream?: boolean; tools?: unknown[] };
    if (body.stream) {
      async function* stream() {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        yield new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n');
        yield new TextEncoder().encode("data: [DONE]\n\n");
      }
      return { ok: true, status: 200, headers: { get: () => null }, body: stream() } as unknown as Response;
    }
    const message = body.tools ? {
      role: "assistant", content: null,
      tool_calls: [{ id: "validation-call", type: "function", function: { name: "qianliu_validation_echo", arguments: '{"value":"ok"}' } }],
    } : { role: "assistant", content: "ok" };
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ model: "glm-5.3", choices: [{ message }], usage: { prompt_tokens: 2, completion_tokens: 1 } }),
      body: null,
    } as unknown as Response;
  });
}

describe("POOL-027 厂商模型自动发现与接入", () => {
  it("检测只返回 Coding Plan 目录，创建资源/模型/禁用路由且不扩大 Key 权限", async () => {
    mockOfficialDocs();
    const discovery = await app.inject({
      method: "POST", url: "/provider-resources/model-discovery", headers: { cookie },
      payload: { provider_id: providerId, mode: "CODING_PLAN", credential_plaintext: "secret" },
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().source).toBe("OFFICIAL_DOCUMENTATION");
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
    const catalog = await app.inject({
      method: "GET", url: "/employee-model-rules/catalog", headers: { cookie },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().models).toEqual([
      expect.objectContaining({
        unified_model_id: model.id,
        route_id: route.id,
        ready: false,
        unavailable_reasons: expect.arrayContaining([
          "统一模型未启用",
          "Model Route 未启用",
          "缺少当前生效的计价或扣减规则",
        ]),
      }),
    ]);
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
    const fetchMock = mockOfficialDocs();
    const discovery = await app.inject({
      method: "POST", url: "/provider-resources/model-discovery", headers: { cookie },
      payload: { provider_id: kimiProviderId, mode: "CODING_PLAN", credential_plaintext: "coding-plan-secret" },
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      source: "OFFICIAL_DOCUMENTATION",
      source_version: "kimi-code-models-v1",
    });
    expect(discovery.json().models.map((model: { id: string }) => model.id)).toEqual([
      "k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed",
    ]);
    // 1 次官方文档 + 4 次模型权限探针；探针与文档都不得指向 Moonshot 开放平台。
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.filter((url) => url.includes("www.kimi.com"))).toHaveLength(1);
    expect(calledUrls.some((url) => url.includes("api.moonshot.cn"))).toBe(false);
    expect(calledUrls.some((url) => url.endsWith("/models"))).toBe(false);
  });

  it("P2 ad-hoc 检测同键 singleflight 复用、探针 run 以 provider_resource_id=null 幂等落库且脱敏", async () => {
    mockOfficialDocs();
    const payload = { provider_id: providerId, mode: "CODING_PLAN", credential_plaintext: "probe-flight-key" };
    const first = await app.inject({ method: "POST", url: "/provider-resources/model-discovery", headers: { cookie }, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().reused).toBe(false);
    const second = await app.inject({ method: "POST", url: "/provider-resources/model-discovery", headers: { cookie }, payload });
    expect(second.statusCode).toBe(200);
    // 同 enterprise+provider+mode+凭证指纹+端点 scope/host → 60s 内复用同一飞行结果。
    expect(second.json().reused).toBe(true);
    // 仅落一条探针 run：未绑定资源 → provider_resource_id=null；复用结果幂等去重。
    const runs = await db.selectFrom("provider_model_probe_run").selectAll()
      .where("credential_fingerprint", "=", credentialFingerprint("probe-flight-key")).execute();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.provider_resource_id).toBeNull();
    expect(runs[0]!.provider_id).toBe(providerId);
    // 脱敏：run 行不包含 Key 明文。
    expect(JSON.stringify(runs[0])).not.toContain("probe-flight-key");
    const items = await db.selectFrom("provider_model_probe_item").selectAll()
      .where("probe_run_id", "=", runs[0]!.id).execute();
    expect(items.length).toBeGreaterThan(0);
  });

  it("相同幂等键不重复创建；第二资源复用统一模型只增加路由", async () => {
    mockOfficialDocs();
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
    mockOfficialDocs();
    const resource = await db.selectFrom("provider_resource").select("id")
      .where("name", "=", "智谱 Plan A").executeTakeFirstOrThrow();
    await db.updateTable("provider_resource").set({ status: "DEGRADED" })
      .where("id", "=", resource.id).execute();
    const sync = await app.inject({
      method: "POST", url: `/provider-resources/${resource.id}/models/sync`, headers: { cookie }, payload: {},
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({
      source: "OFFICIAL_DOCUMENTATION",
      source_version: "zhipu-docs-v1",
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
    mockOfficialDocs();
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

  it("真实验证持久化 Evidence，验证前不能启用，成功后允许启用且不新增授权", async () => {
    const resource = await db.selectFrom("provider_resource").selectAll()
      .where("name", "=", "智谱 Plan A").executeTakeFirstOrThrow();
    const confirm = await app.inject({
      method: "POST", url: `/provider-resources/${resource.id}/models/confirm`, headers: { cookie },
      payload: { selected_model_ids: ["glm-5.3"] },
    });
    expect(confirm.statusCode).toBe(200);
    const route = await db.selectFrom("model_route").selectAll()
      .where("provider_resource_id", "=", resource.id).where("upstream_model", "=", "glm-5.3")
      .executeTakeFirstOrThrow();
    const beforeValidation = await app.inject({
      method: "PATCH", url: `/model-routes/${route.id}`, headers: { cookie },
      payload: { expected_version: route.version, enabled: true },
    });
    expect(beforeValidation.statusCode).toBe(409);
    expect(beforeValidation.json().error).toBe("model_route_validation_required");

    const upstream = mockValidationUpstream();
    const validation = await app.inject({
      method: "POST", url: `/provider-resources/${resource.id}/models/glm-5.3/validate`, headers: { cookie },
      payload: { idempotency_key: "glm53-validation-001", confirm_quota_consumption: true },
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().validation).toMatchObject({ status: "SUCCEEDED", upstreamModel: "glm-5.3" });
    expect(upstream).toHaveBeenCalledTimes(3);
    const replay = await app.inject({
      method: "POST", url: `/provider-resources/${resource.id}/models/glm-5.3/validate`, headers: { cookie },
      payload: { idempotency_key: "glm53-validation-001", confirm_quota_consumption: true },
    });
    expect(replay.statusCode).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
    upstream.mockRestore();

    const enabled = await app.inject({
      method: "PATCH", url: `/model-routes/${route.id}`, headers: { cookie },
      payload: { expected_version: route.version, enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().route.enabled).toBe(true);
    expect(await db.selectFrom("principal_key").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("principal_grant").selectAll().execute()).toHaveLength(0);
  });

  it("验证互斥是持久化门禁，不同幂等键并发只允许一个真实调用", async () => {
    const resource = await db.selectFrom("provider_resource").selectAll()
      .where("name", "=", "智谱 Plan A").executeTakeFirstOrThrow();
    const upstream = mockValidationUpstream(80);
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/provider-resources/${resource.id}/models/glm-5.2/validate`, headers: { cookie }, payload: { idempotency_key: "glm52-validation-a", confirm_quota_consumption: true } }),
      app.inject({ method: "POST", url: `/provider-resources/${resource.id}/models/glm-5.2/validate`, headers: { cookie }, payload: { idempotency_key: "glm52-validation-b", confirm_quota_consumption: true } }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(upstream).toHaveBeenCalledTimes(2);
    upstream.mockRestore();
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
    const existingVisionModel = await db.insertInto("unified_model").values({
      enterprise_id: enterpriseId,
      alias: "ql-deepseek-v4-flash-vision-exp",
      display_name: "deepseek-v4-flash-vision-exp",
      required_capabilities: JSON.stringify(["chat"]) as unknown as string[],
      status: "PENDING_CONFIG",
    }).returningAll().executeTakeFirstOrThrow();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementation(async (input, init) => {
      // 第一跳：List Models；其后：权限探针 POST（WP04 合同：2xx = READY）。
      if ((init?.method ?? "GET") === "POST") {
        return {
          ok: true, status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({
            id: "probe-1", object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ data: [{ id: "deepseek-v4-flash-vision-exp" }] }),
      } as unknown as Response;
    });
    const firstSync = await app.inject({
      method: "POST",
      url: `/provider-resources/${resourceId}/models/sync`,
      headers: { cookie },
      payload: {},
    });
    expect(firstSync.statusCode).toBe(200);
    expect(firstSync.json().models[0]).toMatchObject({
      id: "deepseek-v4-flash-vision-exp",
      capabilities: ["chat", "stream", "vision"],
      compatible: true,
    });
    const confirmed = await app.inject({
      method: "POST",
      url: `/provider-resources/${resourceId}/models/confirm`,
      headers: { cookie },
      payload: { selected_model_ids: ["deepseek-v4-flash-vision-exp"] },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().models[0]).toMatchObject({
      unifiedModelId: existingVisionModel.id,
      reused: true,
    });
    expect(await db.selectFrom("unified_model").select(["required_capabilities", "version"])
      .where("id", "=", existingVisionModel.id).executeTakeFirstOrThrow()).toMatchObject({
      required_capabilities: ["chat", "stream", "vision"],
      version: existingVisionModel.version + 1,
    });

    await db.updateTable("provider_model_discovery").set({
      source_checked_at: new Date(Date.now() - 61_000),
      discovered_at: new Date(Date.now() - 61_000),
    }).where("provider_resource_id", "=", resourceId).execute();
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
      .toEqual(["deepseek-v4-flash-vision-exp"]);

    const confirm = await app.inject({
      method: "POST",
      url: `/provider-resources/${resourceId}/models/confirm`,
      headers: { cookie },
      payload: { selected_model_ids: ["deepseek-v4-flash-vision-exp"] },
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().error).toBe("model_discovery_stale");
  });

  it("终审整改一：READY 证据身份不匹配或过期时 GET/confirm 拒绝并返回 MODEL_VALIDATION_STALE", async () => {
    mockOfficialDocs();
    // 复用既有 zhipu provider（本用例为文件末位，改动状态不影响前面的用例），
    // 新建专属资源承载证据身份矩阵。
    const created = await app.inject({
      method: "POST", url: "/provider-resources", headers: { cookie },
      payload: { provider_id: providerId, name: "智谱 Stale A", mode: "CODING_PLAN",
        credential_type: "API_KEY", credential_plaintext: "stale-evidence-key" },
    });
    expect(created.statusCode).toBe(201);
    const resourceId = created.json().resource.id as string;
    const sync = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/sync`, headers: { cookie }, payload: {},
    });
    expect(sync.statusCode).toBe(200);

    const getPayload = async () => (await app.inject({
      method: "GET", url: `/provider-resources/${resourceId}/models`, headers: { cookie },
    })).json();
    // 基线：证据身份一致 → CURRENT，READY 模型可选。
    expect((await getPayload()).probe_evidence).toEqual({ status: "CURRENT" });
    const readyModel = (await getPayload()).models
      .find((model: { credential_validation?: { status?: string } }) => model.credential_validation?.status === "READY");
    expect(readyModel).toBeTruthy();
    expect(readyModel.selectable).toBe(true);

    const expectGetStale = async (reason: string) => {
      const payload = await getPayload();
      expect(payload.probe_evidence).toEqual({
        status: "MODEL_VALIDATION_STALE", reason, requires: "SYNC_OR_PROBE",
      });
      for (const model of payload.models) {
        expect(model.credential_validation?.status ?? null).not.toBe("READY");
        expect(model.selectable).toBe(false);
      }
    };
    const expectConfirmStale = async () => {
      const response = await app.inject({
        method: "POST", url: `/provider-resources/${resourceId}/models/confirm`, headers: { cookie },
        payload: { selected_model_ids: ["glm-5.2"] },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("MODEL_VALIDATION_STALE");
    };

    // 1) Key 轮换：凭证指纹变化 → 新探针 run 之前证据即失效。
    await db.updateTable("provider_resource")
      .set({ credential_fingerprint: "0".repeat(64) })
      .where("id", "=", resourceId).execute();
    await expectGetStale("CREDENTIAL_FINGERPRINT_MISMATCH");
    await expectConfirmStale();
    await db.updateTable("provider_resource")
      .set({ credential_fingerprint: credentialFingerprint("stale-evidence-key") })
      .where("id", "=", resourceId).execute();

    // 2) 解析端点变更：capability_set.endpoints[mode] 改变 scope。
    await db.updateTable("provider")
      .set({ capability_set: { endpoints: { CODING_PLAN: "https://open.bigmodel.cn/api/coding/paas/v4" } } })
      .where("id", "=", providerId).execute();
    await expectGetStale("ENDPOINT_MISMATCH");
    await expectConfirmStale();
    await db.updateTable("provider").set({ capability_set: null })
      .where("id", "=", providerId).execute();

    // 3) 官方目录哈希变更。
    const originalHash = (await db.selectFrom("provider_model_discovery")
      .select("source_content_hash")
      .where("provider_resource_id", "=", resourceId).where("status", "=", "SUCCEEDED")
      .orderBy("discovered_at", "desc").executeTakeFirstOrThrow()).source_content_hash;
    await db.updateTable("provider_model_discovery")
      .set({ source_content_hash: "sha256:rotated-catalog" })
      .where("provider_resource_id", "=", resourceId).execute();
    await expectGetStale("DISCOVERY_SOURCE_HASH_MISMATCH");
    await expectConfirmStale();
    await db.updateTable("provider_model_discovery")
      .set({ source_content_hash: originalHash })
      .where("provider_resource_id", "=", resourceId).execute();

    // 4) 模型集变化：从当前成功快照删除一个模型。
    const successfulId = (await db.selectFrom("provider_model_discovery").select("id")
      .where("provider_resource_id", "=", resourceId).where("status", "=", "SUCCEEDED")
      .orderBy("discovered_at", "desc").executeTakeFirstOrThrow()).id;
    await db.deleteFrom("provider_model_discovery_item")
      .where("discovery_id", "=", successfulId).where("upstream_model", "=", "glm-5.3").execute();
    await expectGetStale("MODEL_SET_MISMATCH");
    await expectConfirmStale();

    // 5) 过期证据（期间没有任何新探针 run）：把 run 开始时间拨回 25 小时前。
    await db.updateTable("provider_model_probe_run")
      .set({ started_at: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where("provider_resource_id", "=", resourceId).execute();
    await expectGetStale("EVIDENCE_EXPIRED");
    await expectConfirmStale();

    // 恢复：重新同步生成新快照与新探针 run → 证据回到 CURRENT，可确认。
    await db.updateTable("provider_model_discovery")
      .set({ source_checked_at: new Date(Date.now() - 61_000), discovered_at: new Date(Date.now() - 61_000) })
      .where("provider_resource_id", "=", resourceId).execute();
    const resync = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/sync`, headers: { cookie }, payload: {},
    });
    expect(resync.statusCode).toBe(200);
    expect((await getPayload()).probe_evidence).toEqual({ status: "CURRENT" });
    const confirmAgain = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/confirm`, headers: { cookie },
      payload: { selected_model_ids: ["glm-5.2"] },
    });
    expect(confirmAgain.statusCode).toBe(200);
  });

  it("审核修复（P1）：官方下架模型（REMOVED 行）不使当次同步的新鲜证据被判 STALE", async () => {
    mockOfficialDocs();
    const created = await app.inject({
      method: "POST", url: "/provider-resources", headers: { cookie },
      payload: { provider_id: providerId, name: "智谱 Removed Row", mode: "CODING_PLAN",
        credential_type: "API_KEY", credential_plaintext: "removed-row-key" },
    });
    expect(created.statusCode).toBe(201);
    const resourceId = created.json().resource.id as string;
    const sync = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/sync`, headers: { cookie }, payload: {},
    });
    expect(sync.statusCode).toBe(200);

    // 官方目录下架 glm-5.3（文档正文与 etag 均变化）→ 重新同步：
    // 新发现只含 glm-5.2，新探针 run 针对新目录；glm-5.3 保留为 REMOVED 行。
    // 先回拨检查时间越过 60s 同步缓存（与上一用例恢复步骤同法）。
    await db.updateTable("provider_model_discovery")
      .set({ source_checked_at: new Date(Date.now() - 61_000), discovered_at: new Date(Date.now() - 61_000) })
      .where("provider_resource_id", "=", resourceId).execute();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return {
          ok: true, status: 200, headers: { get: () => "application/json" },
          json: async () => ({
            id: "probe-2", object: "chat.completion",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        } as unknown as Response;
      }
      const body = String(input).includes("kimi")
        ? "Model ID | `k3` | `k3-256k` | `kimi-for-coding` | `kimi-for-coding-highspeed`"
        : "| 模型 ID | `glm-5.2` |\n| 上下文 | 256K |";
      return {
        ok: true, status: 200, url: String(input),
        headers: { get: (name: string) => name === "etag" ? "test-docs-v2" : null },
        text: async () => body,
      } as unknown as Response;
    });
    const resync = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/sync`, headers: { cookie }, payload: {},
    });
    expect(resync.statusCode).toBe(200);

    // 前提成立：glm-5.3 确实以 REMOVED 行保留在快照中。
    const removedRows = await db.selectFrom("provider_model_discovery_item")
      .select(["upstream_model", "availability_status"])
      .where("availability_status", "=", "REMOVED")
      .where("enterprise_id", "=", enterpriseId)
      .where("upstream_model", "=", "glm-5.3").execute();
    expect(removedRows.length).toBeGreaterThan(0);

    // 修复点：证据身份只看在列模型——REMOVED 行不参与，证据保持 CURRENT。
    const payload = await (await app.inject({
      method: "GET", url: `/provider-resources/${resourceId}/models`, headers: { cookie },
    })).json();
    expect(payload.probe_evidence).toEqual({ status: "CURRENT" });
    const readyModel = payload.models
      .find((model: { credential_validation?: { status?: string } }) => model.credential_validation?.status === "READY");
    expect(readyModel).toBeTruthy();
    expect(readyModel.selectable).toBe(true);

    const confirm = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/confirm`, headers: { cookie },
      payload: { selected_model_ids: ["glm-5.2"] },
    });
    expect(confirm.statusCode).toBe(200);
  });

  it("审核修复（P1）：大写厂商 code（Zhipu）不丢失 glm-5.3 专属真实验证", async () => {
    mockOfficialDocs();
    // 生产历史形态：provider.code = "Zhipu"（大写）。
    const upperProviderId = randomUUID();
    await db.insertInto("provider").values({
      id: upperProviderId, enterprise_id: enterpriseId, code: "Zhipu", name: "智谱大写",
      adapter_type: "OPENAI_COMPATIBLE", status: "ACTIVE",
    }).execute();
    const created = await app.inject({
      method: "POST", url: "/provider-resources", headers: { cookie },
      payload: { provider_id: upperProviderId, name: "智谱大写 A", mode: "CODING_PLAN",
        credential_type: "API_KEY", credential_plaintext: "upper-zhipu-key" },
    });
    expect(created.statusCode).toBe(201);
    const resourceId = created.json().resource.id as string;
    const sync = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/sync`, headers: { cookie }, payload: {},
    });
    expect(sync.statusCode).toBe(200);
    const confirm = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/confirm`, headers: { cookie },
      payload: { selected_model_ids: ["glm-5.3"] },
    });
    expect(confirm.statusCode).toBe(200);

    const upstream = mockValidationUpstream();
    const validation = await app.inject({
      method: "POST", url: `/provider-resources/${resourceId}/models/glm-5.3/validate`, headers: { cookie },
      payload: { idempotency_key: "glm53-upper-validation-001", confirm_quota_consumption: true },
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json().validation).toMatchObject({ status: "SUCCEEDED", upstreamModel: "glm-5.3" });
    // canonicalProviderCode 后 glm-5.3 专属分支生效：reasoning_effort=max + 工具验证。
    const bodies = upstream.mock.calls
      .map(([, init]) => { try { return JSON.parse(String(init?.body)); } catch { return null; } })
      .filter(Boolean) as Array<Record<string, unknown>>;
    expect(bodies.some((body) => body.reasoning_effort === "max")).toBe(true);
    expect(bodies.some((body) => Array.isArray(body.tools) && body.tools.length > 0)).toBe(true);
  });
});
