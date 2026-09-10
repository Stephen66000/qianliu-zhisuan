import { expect, it } from "vitest";
import { GatewayLedgerRepository } from "@qianliu/database";
import { discoverProviderModels } from "@qianliu/provider-adapters";
import { app, db, ENT_ID } from "./w19-admin-fixture.js";

it("版本更新只新增发现快照：原模型、路由、主体授权及价格完全不变", async () => {
  const provider = await db.insertInto("provider").values({ enterprise_id: ENT_ID,
    code: "deepseek", name: "DeepSeek", adapter_type: "deepseek" }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({ enterprise_id: ENT_ID,
    provider_id: provider.id, name: "版本同步测试", mode: "API", credential_type: "API_KEY" }).returningAll().executeTakeFirstOrThrow();
  const sync = (version: string, now: Date) => discoverProviderModels({ providerCode: "deepseek", mode: "API",
    credential: "test-only-key", now, fetch: async (url) => url === "https://api.deepseek.com/models"
      ? { ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-v4-flash" }] }) }
      : { ok: true, status: 200, url, headers: { "content-type": "text/html" }, text: async () =>
        `<table><tr><th>模型</th><th>deepseek-v4-flash</th></tr><tr><td>模型版本</td><td>${version}</td></tr></table>` } });
  const first = await sync("DeepSeek-V4-Flash-0731", new Date("2026-09-09T00:00:00Z"));
  const saved = await app.providerRepo.recordModelDiscovery(ENT_ID, resource.id, first);
  const attached = await app.providerRepo.attachDiscoveredModels({ enterpriseId: ENT_ID, providerCode: "deepseek",
    resourceId: resource.id, models: first.models });
  expect(attached).toHaveLength(1);
  const principal = await db.insertInto("principal").values({ enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试主体" })
    .returningAll().executeTakeFirstOrThrow();
  await db.insertInto("principal_grant").values({ enterprise_id: ENT_ID, principal_id: principal.id,
    provider: "deepseek", model_alias: attached[0]!.alias, quota_value: 1000000n }).execute();
  await new GatewayLedgerRepository(db).createBillingRule({ enterprise_id: ENT_ID, provider_resource_id: resource.id,
    upstream_model: "deepseek-v4-flash", rule_type: "API_PRICE", rule_version: "unchanged-price",
    effective_from: new Date(0), cache_hit_price: "0.00000005", cache_miss_price: "0.0000015", output_price: "0.0000045" });
  const businessRows = async () => Promise.all([
    db.selectFrom("unified_model").selectAll().where("enterprise_id", "=", ENT_ID).execute(),
    db.selectFrom("model_route").selectAll().where("enterprise_id", "=", ENT_ID).execute(),
    db.selectFrom("principal_grant").selectAll().where("enterprise_id", "=", ENT_ID).execute(),
    db.selectFrom("billing_rule").selectAll().where("enterprise_id", "=", ENT_ID).execute(),
  ]);
  const before = await businessRows();
  const second = await sync("DeepSeek-V4-Flash-0910", new Date("2026-09-10T00:00:00Z"));
  const updated = await app.providerRepo.recordModelDiscovery(ENT_ID, resource.id, second);
  expect(updated.catalogDiff).toEqual({ added: [], retained: ["deepseek-v4-flash"], notAdvertised: [] });
  expect(await businessRows()).toEqual(before);
  const latest = await app.providerRepo.latestModelDiscovery(ENT_ID, resource.id);
  expect(latest!.items).toHaveLength(1);
  expect(latest!.items[0]!.facts).toMatchObject({ officialVersion: "DeepSeek-V4-Flash-0910",
    fieldEvidence: { official_version: [{ checkedAt: "2026-09-10T00:00:00.000Z" }] } });
  const original = await db.selectFrom("provider_model_discovery_item").select("facts")
    .where("discovery_id", "=", saved.discovery.id).executeTakeFirstOrThrow();
  expect(original.facts).toMatchObject({ officialVersion: "DeepSeek-V4-Flash-0731" });
});
