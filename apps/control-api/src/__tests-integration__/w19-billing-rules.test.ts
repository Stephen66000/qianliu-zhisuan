import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app, db, adminCookie, ENT_ID, seedProviderResource, countAudit } from "./w19-admin-fixture.js";

describe("W19 计价规则", () => {
  it("POST/PATCH /billing-rules 配置不可原地改写，生命周期修改仍使用乐观锁", async () => {
    const { resource } = await seedProviderResource();
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `billing-model-${randomUUID().slice(0, 8)}`,
        display_name: "计价规则模型",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("model_route")
      .values({
        enterprise_id: ENT_ID,
        unified_model_id: model.id,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
        enabled: true,
      })
      .execute();
    const created = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: {
        rule_type: "API_PRICE",
        rule_version: "w19-web-v1",
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
        effective_from: new Date().toISOString(),
        cache_miss_price: "0.000001",
        output_price: "0.000002",
        priority: 10,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().rule.version).toBe(1);
    expect(await countAudit("billing_rule.create")).toBe(1);

    const rule = created.json().rule;
    const updated = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${rule.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: rule.version,
        enabled: false,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().rule.output_price).toBe("0.000002");
    expect(updated.json().rule.enabled).toBe(false);
    expect(updated.json().rule.version).toBe(2);
    expect(await countAudit("billing_rule.update")).toBe(1);

    const stale = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${rule.id}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: 1, enabled: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("conflict");

    const inPlacePriceChange = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${rule.id}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: 2, output_price: "0.000003" },
    });
    expect(inPlacePriceChange.statusCode).toBe(400);
    expect(inPlacePriceChange.json().error).toBe("invalid_request");
  });

  it("POST/GET /billing-rules 单条规则持久化两个时窗，并强制价格/倍率语义隔离", async () => {
    const { resource } = await seedProviderResource();
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `billing-window-${randomUUID().slice(0, 8)}`,
        display_name: "多时窗计价模型",
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: model.id,
      provider_resource_id: resource.id,
      upstream_model: "deepseek-chat",
      enabled: true,
    }).execute();
    const basePayload = {
      rule_type: "API_PRICE",
      rule_version: "deepseek-peak-v1",
      provider_resource_id: resource.id,
      upstream_model: "deepseek-chat",
      effective_from: "2026-07-01T00:00:00.000Z",
      windows: [
        {
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
          start_time: "09:00",
          end_time: "12:00",
        },
        {
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
          start_time: "14:00",
          end_time: "18:00",
        },
      ],
      cache_hit_price: "0.000001",
      cache_miss_price: "0.000002",
      output_price: "0.000004",
      priority: 10,
    };
    const created = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: basePayload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().rule).toMatchObject({
      timezone: "Asia/Shanghai",
      start_time: "09:00",
      end_time: "12:00",
      time_windows: basePayload.windows,
    });

    const listed = await app.inject({
      method: "GET",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().rules.find((rule: { id: string }) => rule.id === created.json().rule.id),
    ).toMatchObject({ time_windows: basePayload.windows });

    const editedWindows = [
      basePayload.windows[1],
      basePayload.windows[0],
    ];
    const newVersion = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: {
        ...basePayload,
        rule_version: "deepseek-peak-v2",
        effective_from: "2026-08-01T00:00:00.000Z",
        windows: editedWindows,
      },
    });
    expect(newVersion.statusCode).toBe(201);
    expect(newVersion.json().rule).toMatchObject({
      rule_version: "deepseek-peak-v2",
      time_windows: editedWindows,
      timezone: "Asia/Shanghai",
      start_time: "14:00",
      end_time: "18:00",
    });

    const immutableWindowPatch = await app.inject({
      method: "PATCH",
      url: `/billing-rules/${created.json().rule.id}`,
      headers: { cookie: adminCookie },
      payload: {
        expected_version: created.json().rule.version,
        windows: editedWindows,
      },
    });
    expect(immutableWindowPatch.statusCode).toBe(400);

    const mixedSemantics = await app.inject({
      method: "POST",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
      payload: { ...basePayload, multiplier: "2" },
    });
    expect(mixedSemantics.statusCode).toBe(400);
    expect(mixedSemantics.json().message).toContain("API 价格规则不能配置额度倍率");
  });
});
