import { expect, it } from "vitest";
import { app, db, adminCookie, ENT_ID, seedProviderResource } from "./w19-admin-fixture.js";

it("资源展示跟随模型存档/恢复，原始型号不变，停用及未接入型号不误隐藏", async () => {
  const { resource } = await seedProviderResource();
  const declared = ["pro", "flash", "not-yet-attached"];
  await db.updateTable("provider_resource").set({ upstream_models: JSON.stringify(declared) as unknown as string[] })
    .where("id", "=", resource.id).execute();
  const model = await db.insertInto("unified_model").values({ enterprise_id: ENT_ID,
    alias: "test-pro", display_name: "Pro", status: "DISABLED" }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({ enterprise_id: ENT_ID, provider_resource_id: resource.id,
    unified_model_id: model.id, upstream_model: "pro", enabled: true }).execute();
  const read = async () => {
    const response = await app.inject({ method: "GET", url: "/provider-resources", headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    return (response.json().resources as Array<{ id: string; upstream_models: string[]; display_upstream_models: string[] }>)
      .find((item) => item.id === resource.id)!;
  };
  expect((await read()).display_upstream_models).toEqual(declared);
  const archived = await app.inject({ method: "POST", url: `/unified-models/${model.id}/archive`,
    headers: { cookie: adminCookie }, payload: { expected_version: model.version } });
  expect(archived.statusCode).toBe(200);
  expect(await read()).toMatchObject({ upstream_models: declared, display_upstream_models: ["flash", "not-yet-attached"] });
  expect((await db.selectFrom("provider_resource").select("upstream_models").where("id", "=", resource.id)
    .executeTakeFirstOrThrow()).upstream_models).toEqual(declared);
  const restored = await app.inject({ method: "POST", url: `/unified-models/${model.id}/unarchive`,
    headers: { cookie: adminCookie }, payload: { expected_version: archived.json().model.version } });
  expect(restored.statusCode).toBe(200);
  expect(restored.json().model.status).toBe("DISABLED");
  expect((await read()).display_upstream_models).toEqual(declared);
});

it("相同上游型号跨资源、跨模型关联隔离，仍有未存档关联时保留显示", async () => {
  const { resource: first } = await seedProviderResource();
  const { resource: second } = await seedProviderResource();
  for (const resource of [first, second]) await db.updateTable("provider_resource")
    .set({ upstream_models: JSON.stringify(["shared-pro"]) as unknown as string[] }).where("id", "=", resource.id).execute();
  const archived = await db.insertInto("unified_model").values({ enterprise_id: ENT_ID, alias: "archived-pro",
    display_name: "Archived", status: "DISABLED", archived_at: new Date() }).returningAll().executeTakeFirstOrThrow();
  const visible = await db.insertInto("unified_model").values({ enterprise_id: ENT_ID, alias: "visible-pro",
    display_name: "Visible", status: "ACTIVE" }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values([
    { enterprise_id: ENT_ID, provider_resource_id: first.id, unified_model_id: archived.id, upstream_model: "shared-pro" },
    { enterprise_id: ENT_ID, provider_resource_id: second.id, unified_model_id: visible.id, upstream_model: "shared-pro" },
  ]).execute();
  const read = async () => {
    const response = await app.inject({ method: "GET", url: "/provider-resources", headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    return response.json().resources as Array<{ id: string; display_upstream_models: string[] }>;
  };
  expect((await read()).find((item) => item.id === first.id)!.display_upstream_models).toEqual([]);
  expect((await read()).find((item) => item.id === second.id)!.display_upstream_models).toEqual(["shared-pro"]);
  await db.insertInto("model_route").values({ enterprise_id: ENT_ID, provider_resource_id: first.id,
    unified_model_id: visible.id, upstream_model: "shared-pro" }).execute();
  expect((await read()).find((item) => item.id === first.id)!.display_upstream_models).toEqual(["shared-pro"]);
});
