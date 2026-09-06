import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app, db, adminCookie, ENT_ID, seedProviderResource, countAudit } from "./w19-admin-fixture.js";

describe("W19 资源、模型、路由与主体额度", () => {
  it("PATCH /provider-resources/:id 改名成功并写 audit", async () => {
    const { resource } = await seedProviderResource();
    const res = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "智谱主账号（华北）",
        upstream_models: ["glm-4.6", "glm-z-plan"],
        concurrency_limit: 32,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resource.name).toBe("智谱主账号（华北）");
    expect(res.json().resource.upstream_models).toEqual(["glm-4.6", "glm-z-plan"]);
    expect(res.json().resource.concurrency_limit).toBe(32);
    expect(res.json().resource.id).toBe(resource.id);
    expect(res.json().resource.version).toBe(resource.version + 1);
    expect(res.json().resource.credential_ciphertext).toBeUndefined();
    expect(res.json().resource.credential_version).toBe(resource.credential_version);
    expect(await countAudit("provider_resource.update")).toBe(1);
  });

  it("PATCH /provider-resources/:id 并发修改 → 409 conflict", async () => {
    const { resource } = await seedProviderResource();
    // 第一次更新成功（updated_at 变化）
    const first = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "第一次改名",
      },
    });
    expect(first.statusCode).toBe(200);
    // 用旧 expected_updated_at 再改 → 409
    const stale = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        name: "过期快照改名",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("conflict");
  });

  it("POOL20-047：旧资源 PATCH 拒绝无账期预算字段", async () => {
    const { resource } = await seedProviderResource();
    const res = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${resource.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: resource.version,
        monthly_budget_amount: "100",
        monthly_budget_currency: "CNY",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    expect(await db.selectFrom("provider_resource").select("version")
      .where("id", "=", resource.id).executeTakeFirstOrThrow()).toEqual({
      version: resource.version,
    });
  });

  it("PATCH /unified-models/:id 停用并写 audit（W19 补齐 create audit）", async () => {
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `qianliu-glm-${randomUUID().slice(0, 8)}`,
        display_name: "仟流 GLM",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/unified-models/${model.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: model.version,
        status: "DISABLED",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().model.status).toBe("DISABLED");
    expect(await countAudit("unified_model.disable")).toBe(1);
  });

  it("PATCH /model-routes/:id 调整权重与停用", async () => {
    const { resource } = await seedProviderResource();
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `route-model-${randomUUID().slice(0, 8)}`,
        display_name: "路由模型",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const route = await db
      .insertInto("model_route")
      .values({
        enterprise_id: ENT_ID,
        unified_model_id: model.id,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/model-routes/${route.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: route.version,
        weight: 5,
        enabled: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().route.weight).toBe(5);
    expect(res.json().route.enabled).toBe(false);
    expect(await countAudit("model_route.update")).toBe(1);
  });

  it("PATCH /grants/:id 调额与停用", async () => {
    const principal = await db
      .insertInto("principal")
      .values({ enterprise_id: ENT_ID, type: "EMPLOYEE", name: "W19 员工" })
      .returningAll()
      .executeTakeFirstOrThrow();
    const grant = await db
      .insertInto("principal_grant")
      .values({
        enterprise_id: ENT_ID,
        principal_id: principal.id,
        provider: "zhipu",
        model_alias: "glm-4.6",
        quota_value: 100_000n,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const res = await app.inject({
      method: "PATCH",
      url: `/grants/${grant.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: grant.version,
        quota_value: "200000",
        status: "DISABLED",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().grant.status).toBe("DISABLED");
    expect(await countAudit("grant.disable")).toBe(1);
  });
});
