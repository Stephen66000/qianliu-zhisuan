import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app, db, adminCookie, ENT_ID, seedProviderResource } from "./w19-admin-fixture.js";

describe("W19 配置归档", () => {
  it("POOL20-028：停用与归档分离，默认隐藏、可取消归档且不能被新配置引用", async () => {
    const { resource } = await seedProviderResource();
    const model = await db.insertInto("unified_model").values({
      enterprise_id: ENT_ID,
      alias: `archive-model-${randomUUID().slice(0, 8)}`,
      display_name: "归档测试模型",
      status: "ACTIVE",
    }).returningAll().executeTakeFirstOrThrow();
    const activeArchive = await app.inject({
      method: "POST",
      url: `/unified-models/${model.id}/archive`,
      headers: { cookie: adminCookie },
      payload: { expected_version: model.version },
    });
    expect(activeArchive.statusCode).toBe(409);
    const disabled = await app.inject({
      method: "PATCH",
      url: `/unified-models/${model.id}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: model.version, status: "DISABLED" },
    });
    const archivedModel = await app.inject({
      method: "POST",
      url: `/unified-models/${model.id}/archive`,
      headers: { cookie: adminCookie },
      payload: { expected_version: disabled.json().model.version },
    });
    expect(archivedModel.statusCode).toBe(200);
    expect(archivedModel.json().model.archived_at).toBeTruthy();
    const currentModels = await app.inject({ method: "GET", url: "/unified-models", headers: { cookie: adminCookie } });
    expect(currentModels.json().models.some((item: { id: string }) => item.id === model.id)).toBe(false);
    const archivedModels = await app.inject({ method: "GET", url: "/unified-models?archived=only", headers: { cookie: adminCookie } });
    expect(archivedModels.json().models.some((item: { id: string }) => item.id === model.id)).toBe(true);
    const grantPrincipal = await db.insertInto("principal").values({
      enterprise_id: ENT_ID, type: "EMPLOYEE", name: "归档引用测试员工", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    const forbiddenGrant = await app.inject({
      method: "POST",
      url: `/principals/${grantPrincipal.id}/grants`,
      headers: { cookie: adminCookie },
      payload: { provider: "zhipu", model_alias: model.alias, quota_value: "100" },
    });
    expect(forbiddenGrant.statusCode).toBe(409);
    expect(forbiddenGrant.json().error).toBe("archived_reference");
    const forbiddenRoute = await app.inject({
      method: "POST",
      url: "/model-routes",
      headers: { cookie: adminCookie },
      payload: {
        unified_model_id: model.id,
        provider_resource_id: resource.id,
        upstream_model: "glm-archive",
        priority: 100,
        weight: 1,
        enabled: true,
      },
    });
    expect(forbiddenRoute.statusCode).toBe(409);
    const unarchivedModel = await app.inject({
      method: "POST",
      url: `/unified-models/${model.id}/unarchive`,
      headers: { cookie: adminCookie },
      payload: { expected_version: archivedModel.json().model.version },
    });
    expect(unarchivedModel.statusCode).toBe(200);
    expect(unarchivedModel.json().model).toMatchObject({ archived_at: null, status: "DISABLED" });

    const activeModel = await db.insertInto("unified_model").values({
      enterprise_id: ENT_ID,
      alias: `archive-route-${randomUUID().slice(0, 8)}`,
      display_name: "路由归档模型",
      status: "ACTIVE",
    }).returningAll().executeTakeFirstOrThrow();
    const route = await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: activeModel.id,
      provider_resource_id: resource.id,
      upstream_model: "glm-route-archive",
      enabled: false,
    }).returningAll().executeTakeFirstOrThrow();
    const archivedRoute = await app.inject({
      method: "POST",
      url: `/model-routes/${route.id}/archive`,
      headers: { cookie: adminCookie },
      payload: { expected_version: route.version },
    });
    expect(archivedRoute.statusCode).toBe(200);
    const unarchivedRoute = await app.inject({
      method: "POST",
      url: `/model-routes/${route.id}/unarchive`,
      headers: { cookie: adminCookie },
      payload: { expected_version: archivedRoute.json().route.version },
    });
    expect(unarchivedRoute.json().route).toMatchObject({ archived_at: null, enabled: false });

    const rule = await db.insertInto("billing_rule").values({
      enterprise_id: ENT_ID,
      provider_resource_id: resource.id,
      upstream_model: "glm-route-archive",
      rule_type: "API_PRICE",
      rule_version: `archive-rule-${randomUUID().slice(0, 8)}`,
      effective_from: new Date(),
      enabled: false,
      cache_miss_price: "0.000001",
    }).returningAll().executeTakeFirstOrThrow();
    const archivedRule = await app.inject({
      method: "POST",
      url: `/billing-rules/${rule.id}/archive`,
      headers: { cookie: adminCookie },
      payload: { expected_version: rule.version },
    });
    expect(archivedRule.statusCode).toBe(200);
    const hiddenRules = await app.inject({ method: "GET", url: "/billing-rules", headers: { cookie: adminCookie } });
    expect(hiddenRules.json().rules.some((item: { id: string }) => item.id === rule.id)).toBe(false);
    const unarchivedRule = await app.inject({
      method: "POST",
      url: `/billing-rules/${rule.id}/unarchive`,
      headers: { cookie: adminCookie },
      payload: { expected_version: archivedRule.json().rule.version },
    });
    expect(unarchivedRule.json().rule).toMatchObject({ archived_at: null, enabled: false });
  });
});
