import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";
import { buildControlApi } from "../server.js";

let pg: PostgresTestInstance, db: ReturnType<typeof createKysely>, app: FastifyInstance, cookie: string;
const ent = randomUUID(); let providerId: string;
beforeAll(async () => {
  pg = await startPostgresContainer("pricing_http_test"); db = createKysely(pg.connectionString); await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: ent, name: "pricing HTTP tests" }).execute();
  await db.insertInto("admin_user").values({ enterprise_id: ent, username: "pricing-http", password_hash: await hashPassword("isolated-http-test-password") }).execute();
  providerId = (await db.insertInto("provider").values({ enterprise_id: ent, code: "deepseek", name: "test", adapter_type: "deepseek" }).returning("id").executeTakeFirstOrThrow()).id;
  app = buildControlApi(db); await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "pricing-http", password: "isolated-http-test-password" } });
  expect(login.statusCode).toBe(200);
  const value = login.headers["set-cookie"]; cookie = (Array.isArray(value) ? value[0]! : value!).split(";")[0]!;
}, 120000);
afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); });

async function fixture() {
  const resource = await db.insertInto("provider_resource").values({ enterprise_id: ent, provider_id: providerId,
    name: randomUUID(), mode: "API", credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow();
  const model = await db.insertInto("unified_model").values({ enterprise_id: ent, alias: randomUUID(), display_name: "HTTP test", status: "PENDING_CONFIG" }).returning("id").executeTakeFirstOrThrow();
  const route = await db.insertInto("model_route").values({ enterprise_id: ent, unified_model_id: model.id,
    provider_resource_id: resource.id, upstream_model: "http-model", enabled: false }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("provider_model_validation").values({ enterprise_id: ent, provider_resource_id: resource.id, unified_model_id: model.id,
    upstream_model: "http-model", idempotency_key: randomUUID(), request_fingerprint: randomUUID(), status: "SUCCEEDED",
    result: {}, started_at: new Date(), finished_at: new Date() }).execute();
  return { resource: resource.id, model: model.id, route: route.id, payload: {
    submission_id: randomUUID(), route_id: route.id, expected_route_version: 1, expected_model_version: 1,
    priority: 80, weight: 2, rules: [{ rule_type: "API_PRICE", rule_version: "http-v1", provider_resource_id: resource.id,
      upstream_model: "http-model", effective_from: "2026-01-01T00:00:00Z", cache_hit_price: "0.000001",
      cache_miss_price: "0.000002", output_price: "0.000004" }],
  } };
}
function save(payload: unknown) { return app.inject({ method: "POST", url: "/pricing-configurations", headers: { cookie }, payload }); }

it("authenticates writes/reads and rejects invalid or missing route references", async () => {
  expect((await app.inject({ method: "POST", url: "/pricing-configurations", payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/pricing-ready-routes" })).statusCode).toBe(401);
  expect((await save({})).statusCode).toBe(400);
  const f = await fixture();
  const invalidWindow = await save({ ...f.payload, rules: [{ ...f.payload.rules[0],
    windows: [{ timezone: "Asia/Shanghai", start_time: "09:00", end_time: "09:00" }] }] });
  expect(invalidWindow.statusCode).toBe(400);
  expect(invalidWindow.json().message).toContain("起止时间不能相同");
  const response = await save({ ...f.payload, route_id: randomUUID() });
  expect(response.statusCode).toBe(409); expect(response.json().error).toBe("configuration_conflict");
  expect((await db.selectFrom("model_route").select("enabled").where("id", "=", f.route).executeTakeFirst())?.enabled).toBe(false);
});

it("creates and replays an atomic rule set with default null end/windows", async () => {
  const f = await fixture();
  const response = await save(f.payload); expect(response.statusCode).toBe(201);
  expect(response.json().replayed).toBe(false);
  const replay = await save(f.payload); expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual({ ...response.json(), replayed: true });
  const row = await db.selectFrom("billing_rule").selectAll().where("provider_resource_id", "=", f.resource).executeTakeFirstOrThrow();
  expect(row.effective_to).toBeNull(); expect(row.time_windows).toBeNull();
  const ready = await app.inject({ method: "GET", url: "/pricing-ready-routes", headers: { cookie } });
  expect(ready.statusCode).toBe(200); expect(ready.json().routes.some((r: { id: string }) => r.id === f.route)).toBe(true);
});

it("serializes explicit end dates, multiple windows and nullable weekdays without losing prices", async () => {
  const f = await fixture();
  const windows = [
    { timezone: "Asia/Shanghai", start_time: "09:00", end_time: "12:00", days_of_week: [1, 2] },
    { timezone: "Asia/Shanghai", start_time: "14:00", end_time: "18:00" },
  ];
  const response = await save({ ...f.payload, rules: [{ ...f.payload.rules[0], pricing_mode: "MULTIPLIER", multiplier: "3", windows,
    effective_to: "2099-01-01T00:00:00Z" }] });
  expect(response.statusCode).toBe(201);
  const row = await db.selectFrom("billing_rule").selectAll().where("provider_resource_id", "=", f.resource).executeTakeFirstOrThrow();
  expect(row.pricing_mode).toBe("MULTIPLIER"); expect(row.multiplier).toBe("3");
  expect(row.time_windows).toEqual([windows[0], { ...windows[1], days_of_week: null }]);
  expect(row.effective_to?.toISOString()).toBe("2099-01-01T00:00:00.000Z");
});

it("unexpected audit-write failure rolls back and is not reported as successful configuration", async () => {
  const f = await fixture();
  await sql`CREATE FUNCTION fail_pricing_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'pricing_configuration.save' THEN RAISE EXCEPTION 'TEST_AUDIT_WRITE_FAILED'; END IF; RETURN NEW; END $$`.execute(db);
  await sql`CREATE TRIGGER fail_pricing_audit BEFORE INSERT ON operation_log FOR EACH ROW EXECUTE FUNCTION fail_pricing_audit()`.execute(db);
  try {
    expect((await save(f.payload)).statusCode).toBe(500);
    expect(await db.selectFrom("billing_rule").select("id").where("provider_resource_id", "=", f.resource).execute()).toEqual([]);
    expect((await db.selectFrom("model_route").select("enabled").where("id", "=", f.route).executeTakeFirst())?.enabled).toBe(false);
  } finally {
    await sql`DROP TRIGGER fail_pricing_audit ON operation_log`.execute(db);
    await sql`DROP FUNCTION fail_pricing_audit()`.execute(db);
  }
  expect((await save(f.payload)).statusCode).toBe(201);
});

it("maps global pricing-mode conflicts to 409 and preserves the pending route", async () => {
  const f = await fixture();
  const global = await db.insertInto("billing_rule").values({ enterprise_id: ent, rule_type: "API_PRICE", rule_version: "global-v1",
    effective_from: new Date(0), cache_hit_price: "0", cache_miss_price: "0.000002", output_price: "0.000004" }).returning("id").executeTakeFirstOrThrow();
  try {
    const response = await save({ ...f.payload, rules: [{ ...f.payload.rules[0], pricing_mode: "MULTIPLIER", multiplier: "3" }] });
    expect(response.statusCode).toBe(409); expect(response.json().error).toBe("configuration_conflict");
    expect((await db.selectFrom("model_route").select("enabled").where("id", "=", f.route).executeTakeFirst())?.enabled).toBe(false);
  } finally { await db.updateTable("billing_rule").set({ enabled: false }).where("id", "=", global.id).execute(); }
});
