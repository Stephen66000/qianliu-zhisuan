import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { readQuotaSwitchPreflight } from "../quota-preflight.js";
import { quotaPreflightScope } from "../quota-reconcile-cli.js";
let pg: PostgresTestInstance; let db: ReturnType<typeof createKysely>;
const now = new Date("2026-11-01T12:00:00Z");
beforeAll(async () => { pg = await startPostgresContainer("quota_preflight"); db = createKysely(pg.connectionString); await migrateToLatest(db); }, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);
async function fixture() {
  const enterpriseId = (await db.insertInto("enterprise").values({ name: "只读切换预检合成企业", timezone: "Asia/Shanghai" }).returning("id").executeTakeFirstOrThrow()).id;
  const employee = (await db.insertInto("principal").values({ enterprise_id: enterpriseId, type: "EMPLOYEE", name: "合成员工" }).returning("id").executeTakeFirstOrThrow()).id;
  const provider = (await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek" }).returning("id").executeTakeFirstOrThrow()).id;
  const grant = (await db.insertInto("principal_grant").values({ enterprise_id: enterpriseId, principal_id: employee, provider: "deepseek", model_alias: "*", pool_model_alias: "*",
    quota_basis: "RAW_TOKEN", quota_value: 100000000n, allow_overage: true, valid_from: new Date("2026-09-19T00:00:00+08:00") }).returning("id").executeTakeFirstOrThrow()).id;
  await db.insertInto("quota_counter").values({ grant_id: grant, used_value: 388884913n, period_anchor: new Date("2026-09-19T00:00:00+08:00"), next_reset_at: null }).execute();
  const key = (await db.insertInto("principal_key").values({ enterprise_id: enterpriseId, principal_id: employee, key_prefix: "preflight", key_digest: randomUUID() }).returning("id").executeTakeFirstOrThrow()).id;
  const modelIds: string[] = [];
  async function route(mode: "API" | "CODING_PLAN") {
    const alias = `synthetic-${mode}-${modelIds.length}`;
    const model = (await db.insertInto("unified_model").values({ enterprise_id: enterpriseId, alias, display_name: alias }).returning("id").executeTakeFirstOrThrow()).id;
    modelIds.push(model);
    const resource = (await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: provider, name: alias, mode, credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("model_route").values({ enterprise_id: enterpriseId, unified_model_id: model, provider_resource_id: resource, upstream_model: alias }).execute();
    await db.insertInto("billing_rule").values({ enterprise_id: enterpriseId, provider_resource_id: resource, upstream_model: alias, rule_type: mode === "API" ? "API_PRICE" : "MODEL_TIER", rule_version: "preflight-v1",
      effective_from: new Date("2020-01-01T00:00:00Z"), multiplier: "1", cache_miss_price: "1", cache_hit_price: "1", output_price: "1", enabled: true }).execute();
    await db.updateTable("principal_key").set({ allowed_model_ids: JSON.stringify(modelIds) as unknown as string[] }).where("id", "=", key).execute();
    return model;
  }
  await route("API");
  return { enterpriseId, employee, grant, key, route, modelIds };
}
async function read(enterpriseId: string, month = "2026-12") {
  return db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    return readQuotaSwitchPreflight(trx, { enterpriseId, month, now });
  });
}
describe("read-only employee quota switch preflight", () => {
  it("proposes a future full local month and preserves legacy counters and every write target", async () => {
    const f = await fixture();
    const evidence = await read(f.enterpriseId);
    expect(evidence.status).toBe("GO"); expect(evidence.activation.start).toBe("2026-11-30T16:00:00.000Z");
    expect(evidence.pools[0]).toMatchObject({ allowOverage: true, basis: "RAW_TOKEN", availableRouteModes: ["API"], legacy: { periodAnchor: "2026-09-18T16:00:00.000Z", nextResetAt: null, usedValue: "388884913" } });
    expect((await read(f.enterpriseId)).hash).toBe(evidence.hash);
    expect((await db.selectFrom("quota_counter").select("used_value").where("grant_id", "=", f.grant).executeTakeFirstOrThrow()).used_value.toString()).toBe("388884913");
    expect(await db.selectFrom("principal_quota_period").selectAll().where("enterprise_id", "=", f.enterpriseId).execute()).toHaveLength(0);
    expect((await db.selectFrom("enterprise").select("employee_quota_monthly_from").where("id", "=", f.enterpriseId).executeTakeFirstOrThrow()).employee_quota_monthly_from).toBeNull();
    const directory = fileURLToPath(new URL("../../../../../V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/", import.meta.url)); await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "synthetic-switch-preflight-go.json"), JSON.stringify(evidence, null, 2));
  });
  it("rejects a mixed API and Coding Plan employee pool and writes nothing", async () => {
    const f = await fixture(); await f.route("CODING_PLAN"); const evidence = await read(f.enterpriseId);
    expect(evidence.status).toBe("NO_GO"); expect(evidence.pools[0]!.issues).toContain("MIXED_API_AND_PLAN_POOL");
    const directory = fileURLToPath(new URL("../../../../../V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/", import.meta.url));
    await writeFile(resolve(directory, "synthetic-switch-preflight-no-go.json"), JSON.stringify(evidence, null, 2));
  });
  it.each([null, "PLAN_QUOTA"] as const)("rejects absent or incompatible basis %s", async basis => {
    const f = await fixture(); await db.updateTable("principal_grant").set({ quota_basis: basis }).where("id", "=", f.grant).execute();
    const evidence = await read(f.enterpriseId); expect(evidence.status).toBe("NO_GO");
    expect(evidence.pools[0]!.issues).toContain(basis === null ? "QUOTA_BASIS_NOT_CONFIGURED" : "QUOTA_BASIS_ROUTE_MISMATCH");
  });
  it("does not mistake an explicitly disabled model or an unlisted Key model for an authorized route", async () => {
    const f = await fixture(); const planModel = await f.route("CODING_PLAN");
    await db.insertInto("principal_provider_disabled_model").values({ enterprise_id: f.enterpriseId, principal_id: f.employee, provider: "deepseek", unified_model_id: planModel }).execute();
    expect((await read(f.enterpriseId)).status).toBe("GO");
    await db.updateTable("principal_key").set({ allowed_model_ids: JSON.stringify([]) as unknown as string[] }).where("id", "=", f.key).execute();
    expect((await read(f.enterpriseId)).pools[0]!.issues).toContain("NO_AUTHORIZED_READY_ROUTE");
  });
  it("rejects an already-started month and a conflicting activation; CLI cannot execute changes", async () => {
    const f = await fixture(); expect((await read(f.enterpriseId, "2026-11")).reasons).toContain("ACTIVATION_MUST_BE_FUTURE_COMPLETE_MONTH_START");
    await db.updateTable("enterprise").set({ employee_quota_monthly_from: new Date("2026-12-31T16:00:00Z") }).where("id", "=", f.enterpriseId).execute();
    expect((await read(f.enterpriseId)).reasons).toContain("EXISTING_ACTIVATION_DIFFERS");
    expect(() => quotaPreflightScope(["preflight", "--enterprise", f.enterpriseId, "--month", "2026-12", "--execute"])).toThrow(/read-only/);
  });
  it("accepts an exclusively authorized plan pool with a matching frozen basis and activation", async () => {
    const f = await fixture();
    await db.updateTable("model_route").set({ enabled: false }).where("enterprise_id", "=", f.enterpriseId).execute();
    await f.route("CODING_PLAN");
    await db.updateTable("principal_grant").set({ quota_basis: "PLAN_QUOTA", allow_overage: false, valid_until: new Date("2099-12-31T16:00:00Z") }).where("id", "=", f.grant).execute();
    await db.updateTable("enterprise").set({ employee_quota_monthly_from: new Date("2026-11-30T16:00:00Z") }).where("id", "=", f.enterpriseId).execute();
    const result = await read(f.enterpriseId);
    expect(result.status).toBe("GO"); expect(result.pools[0]).toMatchObject({ expectedBasis: "PLAN_QUOTA", allowOverage: false, availableRouteModes: ["CODING_PLAN"], validUntil: "2099-12-31T16:00:00.000Z" });
  });
  it("distinguishes unsupported legacy model grants and missing counters from a valid monthly pool", async () => {
    const f = await fixture();
    const model = await db.selectFrom("unified_model").select("alias").where("enterprise_id", "=", f.enterpriseId).executeTakeFirstOrThrow();
    await db.updateTable("principal_grant").set({ pool_model_alias: null, model_alias: model.alias }).where("id", "=", f.grant).execute();
    await db.insertInto("principal_grant").values({ enterprise_id: f.enterpriseId, principal_id: f.employee, provider: "legacy-no-counter", model_alias: "*", pool_model_alias: "*", quota_value: 100n, quota_basis: null, valid_from: new Date("2026-01-01T00:00:00Z") }).execute();
    const result = await read(f.enterpriseId);
    expect(result.pools.find(pool => pool.provider === "deepseek")!.issues).toContain("LEGACY_MODEL_GRANT_NOT_MONTHLY_POOL");
    expect(result.pools.find(pool => pool.provider === "legacy-no-counter")!.legacy.usedValue).toBeNull();
    expect(result.status).toBe("NO_GO");
    await db.updateTable("principal").set({ status: "DISABLED" }).where("id", "=", f.employee).execute();
    expect((await read(f.enterpriseId)).reasons).toContain("NO_ACTIVE_EMPLOYEE_POOLS");
  });

});
