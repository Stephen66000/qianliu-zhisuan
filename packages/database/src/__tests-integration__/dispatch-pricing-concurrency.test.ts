import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, GatewayLedgerRepository, DispatchPolicyRepository, AdminWriteRepository } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const gateKey = 19384;
beforeAll(async () => { pg = await startPostgresContainer("dispatch_price_race"); db = createKysely(pg.connectionString); await migrateToLatest(db); }, 120000);
afterEach(async () => {
  await sql`DROP TRIGGER IF EXISTS p2_pause ON billing_rule`.execute(db);
  await sql`DROP TRIGGER IF EXISTS p2_pause ON dispatch_policy`.execute(db);
  await sql`DROP FUNCTION IF EXISTS p2_pause_write()`.execute(db);
});
afterAll(async () => { await db?.destroy(); await pg?.stop(); });

async function fixture(action: "publish" | "restore") {
  const enterpriseId = randomUUID(), adminId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "P2 isolated" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId, username: "admin", password_hash: "test-only" }).execute();
  const provider = await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: "zhipu", name: "test", adapter_type: "zhipu" }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: provider.id,
    name: "test", mode: "CODING_PLAN", credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow();
  const model = await db.insertInto("unified_model").values({ enterprise_id: enterpriseId, alias: "race-model", display_name: "test" }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({ enterprise_id: enterpriseId, unified_model_id: model.id,
    provider_resource_id: resource.id, upstream_model: "glm-test", enabled: true }).execute();
  const price = await new GatewayLedgerRepository(db).createBillingRule({ enterprise_id: enterpriseId, provider_resource_id: resource.id,
    upstream_model: "glm-test", rule_type: "MODEL_TIER", rule_version: "v1", effective_from: new Date(0), multiplier: "3" });
  const repo = new DispatchPolicyRepository(db);
  const id = await repo.createPolicy({ enterpriseId, status: action === "restore" ? "RETIRED" : "VALIDATED",
    matchUnifiedModel: "race-model", matchProviderResourceId: resource.id, matchResourceMode: "CODING_PLAN",
    matchTimezone: null, matchDaysOfWeek: null, matchStartTime: null, matchEndTime: null,
    matchPriceMultiplierMin: null, matchRemainingQuotaRatioMax: null, matchForecastExhaustRisk: null,
    matchPrincipalScope: null, action: "ALLOW", switchEquivalentGroup: [], rateLimitPerMinute: null, policyVersion: "v1" });
  return {
    enterpriseId, price, id, repo,
    publish: async () => action === "publish"
      ? repo.transitionStatus(enterpriseId, id, "VALIDATED", "PUBLISHED", adminId, 1)
      : (await repo.restorePolicyAsPublished(enterpriseId, id, adminId)).kind === "created",
    disable: () => new AdminWriteRepository(db).updateBillingRule(enterpriseId, price.id, price.version, { enabled: false }),
  };
}

async function pauseWrite(table: "billing_rule" | "dispatch_policy") {
  // Only the scheduling point is injected. Production SELECT/UPDATE and locking remain real.
  const condition = table === "billing_rule" ? "NOT NEW.enabled" : "NEW.status = 'PUBLISHED'";
  await sql.raw(`CREATE FUNCTION p2_pause_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(${gateKey}); END IF; RETURN NEW; END $$`).execute(db);
  await sql.raw(`CREATE TRIGGER p2_pause BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION p2_pause_write()`).execute(db);
}

async function waitUntil(condition: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
async function gateHasWaiter() {
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype='advisory' AND objid=${gateKey} AND NOT granted`.execute(db);
  return result.rows[0]!.n > 0;
}
async function priceHasWaiter() {
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype='advisory' AND objid=(hashtext('billing-rule-writes')::bigint & 4294967295)::oid
    AND NOT granted`.execute(db);
  return result.rows[0]!.n > 0;
}

it.each(["publish", "restore"] as const)("F03 %s holds the pricing lock until publication commits", async (action) => {
  const f = await fixture(action);
  await pauseWrite("dispatch_policy");
  let publishing: Promise<boolean> | undefined;
  let disabling: ReturnType<typeof f.disable> | undefined;
  let waiting = false;
  try {
    await db.transaction().execute(async (gate) => {
      await sql`SELECT pg_advisory_xact_lock(${gateKey})`.execute(gate);
      publishing = f.publish();
      expect(await waitUntil(gateHasWaiter)).toBe(true);
      disabling = f.disable();
      waiting = await waitUntil(priceHasWaiter);
      // Releasing this transaction lets publication commit, then the price writer may run.
    });
    expect(await publishing).toBe(true);
    expect((await disabling)?.enabled).toBe(false);
    expect(waiting).toBe(true);
  } finally { await Promise.allSettled([publishing, disabling]); }
});

it.each(["publish", "restore"] as const)("F03 %s rechecks after an earlier price disable commits", async (action) => {
  const f = await fixture(action);
  await pauseWrite("billing_rule");
  let publishing: Promise<boolean> | undefined;
  let disabling: ReturnType<typeof f.disable> | undefined;
  let waiting = false;
  try {
    await db.transaction().execute(async (gate) => {
      await sql`SELECT pg_advisory_xact_lock(${gateKey})`.execute(gate);
      disabling = f.disable();
      expect(await waitUntil(gateHasWaiter)).toBe(true);
      publishing = f.publish();
      waiting = await waitUntil(priceHasWaiter);
    });
    expect((await disabling)?.enabled).toBe(false);
    expect(await publishing).toBe(false);
    expect(waiting).toBe(true);
    const published = await f.repo.listPublishedPolicies(f.enterpriseId);
    expect(published).toEqual([]);
  } finally { await Promise.allSettled([publishing, disabling]); }
});
