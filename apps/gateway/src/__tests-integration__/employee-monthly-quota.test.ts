import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createKysely, EmployeeQuotaRepository, GatewayLedgerRepository, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { p1App, p1Facts, p1Fixture } from "./quota-p1-fixture.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const NOV = new Date("2026-11-15T04:00:00Z").getTime();
beforeAll(async () => { pg = await startPostgresContainer("employee_monthly_gateway"); db = createKysely(pg.connectionString); await migrateToLatest(db); }, 120000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); });
async function fixture(mode: "API" | "CODING_PLAN", quota = 1000000n, allowOverage = true, resources = 1) {
  const f = await p1Fixture(db, { mode, quota, resources });
  await db.updateTable("enterprise").set({ employee_quota_monthly_from: new Date("2026-10-31T16:00:00Z"), timezone: "Asia/Shanghai" }).where("id", "=", f.enterpriseId).execute();
  await db.updateTable("principal_grant").set({ pool_model_alias: "*", model_alias: "*", quota_basis: mode === "API" ? "RAW_TOKEN" : "PLAN_QUOTA", allow_overage: allowOverage, valid_from: new Date(0) }).where("id", "=", f.grantId).execute();
  await db.updateTable("billing_rule").set({ multiplier: mode === "API" ? null : "0.5" }).where("enterprise_id", "=", f.enterpriseId).execute();
  return f;
}
async function quotaFacts(f: Awaited<ReturnType<typeof fixture>>) {
  const periods = await db.selectFrom("principal_quota_period").selectAll().where("enterprise_id", "=", f.enterpriseId).orderBy("period_key").execute();
  const usages = await db.selectFrom("principal_quota_usage").selectAll().where("enterprise_id", "=", f.enterpriseId).orderBy("attempt_no").execute();
  return { periods, usages };
}
it.each(["API", "CODING_PLAN"] as const)("%s 1200 raw: monthly basis, financial facts, key and legacy remain independent", async mode => {
  const f = await fixture(mode);
  const { app, send, stub } = await p1App(db, f, { now: () => NOV, outcome: o => ({ ...o, usage: { ...o.usage, input: 1000, output: 200, cache: 100, reasoning: 7 } }) });
  try {
    const response = await send(); expect(response.statusCode, response.body).toBe(200);
    expect(stub.calls).toHaveLength(1);
    const q = await quotaFacts(f), facts = await p1Facts(db, f);
    expect(q.periods).toHaveLength(1); expect(q.periods[0]).toMatchObject({ period_key: "2026-11", used_value: mode === "API" ? "1200" : "600", reserved_value: "0" });
    expect(q.usages[0]).toMatchObject({ status: "SETTLED", upstream_attempt_id: facts.attempts[0]!.id, actual: mode === "API" ? "1200" : "600" });
    expect(facts.lines[0]).toMatchObject({ raw_input_tokens: "1000", raw_output_tokens: "200", deducted_quota: mode === "API" ? null : "600" });
    expect(facts.transaction!.total_reasoning_tokens).toBe("7");
    expect(facts.counter.used_value).toBe("0"); expect(facts.leases).toHaveLength(mode === "API" ? 0 : 1);
    if (mode === "CODING_PLAN") {
      const resource = await db.selectFrom("provider_resource").select("quota_state_revision").where("id", "=", f.candidates[0]!.resourceId).executeTakeFirstOrThrow();
      expect(Number(resource.quota_state_revision)).toBe(1);
    }
    // Replay terminal publication must neither add usage nor release a second reservation.
    expect((await send()).statusCode).toBe(409); expect(stub.calls).toHaveLength(1);
    expect((await quotaFacts(f)).periods[0]!.used_value).toBe(mode === "API" ? "1200" : "600");
  } finally { await app.close(); }
});
it.each(["API", "CODING_PLAN"] as const)("%s allow_overage false rejects before upstream, true accounts real overage", async mode => {
  for (const allow of [false, true]) {
    const f = await fixture(mode, 0n, allow);
    const { app, send, stub } = await p1App(db, f, { now: () => NOV });
    try {
      const response = await send(); expect(response.statusCode).toBe(allow ? 200 : 429); expect(stub.calls).toHaveLength(allow ? 1 : 0);
      const q = await quotaFacts(f); expect(q.periods[0]!.used_value).toBe(allow ? mode === "API" ? "14" : "7" : "0");
      expect(q.periods[0]!.reserved_value).toBe("0");
    } finally { await app.close(); }
  }
});
it.each(["API", "CODING_PLAN"] as const)("%s failed nonzero consumption counts, unknown conservatively retains reservation", async mode => {
  for (const unknown of [false, true]) {
    const f = await fixture(mode);
    const originalAccounting = GatewayLedgerRepository.prototype.persistAttemptUsageAccountingIfAbsent;
    const accountingSpy = vi.spyOn(GatewayLedgerRepository.prototype, "persistAttemptUsageAccountingIfAbsent").mockImplementation(async function (this: GatewayLedgerRepository, input) {
      const result = await originalAccounting.call(this, input);
      // Observe the atomic commit before the later diagnostic update can overwrite attempt metadata.
      const frozenAttempt = await db.selectFrom("upstream_attempt").select(["error_classification", "error_code"])
        .where("id", "=", input.usage.upstream_attempt_id).executeTakeFirstOrThrow();
      expect(frozenAttempt).toEqual({ error_classification: "UPSTREAM_TEMPORARY", error_code: "upstream_error" });
      return result;
    });
    const { app, send } = await p1App(db, f, { now: () => NOV, outcome: o => ({ ...o, status: 502, error: "upstream_error", committed: false, failureLayer: "UPSTREAM_HTTP",
      usage: unknown ? { input: 0, output: 0, cache: 0, quality: "UNKNOWN" } : o.usage }) });
    try {
      expect((await send()).statusCode).toBe(502); const q = await quotaFacts(f);
      const persisted = await p1Facts(db, f);
      expect(persisted.request).toMatchObject({ error_classification: "UPSTREAM_TEMPORARY", error_code: "upstream_error" });
      expect(persisted.attempts[0]).toMatchObject({ failure_layer: "UPSTREAM_HTTP", error_code: "upstream_error", error_classification: "UPSTREAM_TEMPORARY" });
      expect(q.usages[0]!.status).toBe(unknown ? "UNKNOWN" : "SETTLED");
      expect(q.periods[0]!.used_value).toBe(unknown ? "0" : mode === "API" ? "14" : "7");
      expect(BigInt(q.periods[0]!.reserved_value) > 0n).toBe(unknown);
    } finally { accountingSpy.mockRestore(); await app.close(); }
  }
});
it("new-month failover settles each attempt into its original reservation month", async () => {
  const f = await fixture("API", 1000000n, true, 2);
  const originalReserve = EmployeeQuotaRepository.prototype.reserveEmployeeQuota;
  let reservations = 0;
  const reserveSpy = vi.spyOn(EmployeeQuotaRepository.prototype, "reserveEmployeeQuota").mockImplementation(async function (this: EmployeeQuotaRepository, input) {
    if (++reservations === 2) {
      const previous = (await quotaFacts(f)).periods[0]!;
      expect(previous).toMatchObject({ period_key: "2026-11", used_value: "14", reserved_value: "0" });
    }
    return originalReserve.call(this, input);
  });
  let now = new Date("2026-11-30T15:59:59Z").getTime();
  const { app, send } = await p1App(db, f, { maxAttempts: 2, now: () => now, outcome: (o, n) => {
    now = new Date("2026-11-30T16:02:00Z").getTime();
    return n === 1 ? { ...o, status: 502, error: "upstream_error", committed: false } : o;
  } });
  try {
    expect((await send()).statusCode).toBe(200);
    const q = await quotaFacts(f); expect(q.periods.map(p => [p.period_key, p.used_value, p.reserved_value])).toEqual([["2026-11", "14", "0"], ["2026-12", "14", "0"]]);
    expect(q.usages.map(u => u.period_id)).toEqual(q.periods.map(p => p.id));
  } finally { reserveSpy.mockRestore(); await app.close(); }
});
it("pre-upstream dispatch failure releases monthly reservation with zero consumption", async () => {
  const f = await fixture("API");
  const { app, send, stub } = await p1App(db, f, { now: () => NOV, fault: "policy" });
  try { expect((await send()).statusCode).toBe(500); expect(stub.calls).toHaveLength(0); const q = await quotaFacts(f);
    expect(q.periods[0]).toMatchObject({ used_value: "0", reserved_value: "0" }); expect(q.usages[0]!.actual).toBe("0");
  } finally { await app.close(); }
});
it("atomic monthly accounting failure leaves no usage or partial quota settlement", async () => {
  const f = await fixture("API");
  await sql`CREATE FUNCTION gateway_monthly_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'monthly accounting unavailable'; END $$`.execute(db);
  await sql.raw(`CREATE TRIGGER gateway_monthly_fault BEFORE UPDATE ON principal_quota_usage FOR EACH ROW WHEN (NEW.enterprise_id = '${f.enterpriseId}'::uuid) EXECUTE FUNCTION gateway_monthly_fault()`).execute(db);
  const { app, send } = await p1App(db, f, { now: () => NOV });
  try {
    expect((await send()).statusCode).toBe(500);
    const q = await quotaFacts(f);
    expect(q.periods[0]!.used_value).toBe("0"); expect(BigInt(q.periods[0]!.reserved_value)).toBeGreaterThan(0n);
    expect(q.usages[0]!.status).toBe("RESERVED");
    expect(await db.selectFrom("ledger_line").select("id").where("enterprise_id", "=", f.enterpriseId).execute()).toHaveLength(0);
    expect(await db.selectFrom("usage_event").select("id").where("enterprise_id", "=", f.enterpriseId).execute()).toHaveLength(0);
  } finally {
    await sql`DROP TRIGGER gateway_monthly_fault ON principal_quota_usage`.execute(db);
    await sql`DROP FUNCTION gateway_monthly_fault()`.execute(db);
    await app.close();
  }
});
it("monthly employee accounting preserves independent Key raw-token quota", async () => {
  const f = await fixture("CODING_PLAN");
  await db.updateTable("principal_key").set({ quota_limit: 100000n }).where("principal_id", "=", f.principalId).execute();
  const { app, send } = await p1App(db, f, { now: () => NOV, outcome: o => ({ ...o, usage: { ...o.usage, input: 1000, output: 200 } }) });
  try { expect((await send()).statusCode).toBe(200);
    expect((await db.selectFrom("principal_key").select("used_tokens").where("principal_id", "=", f.principalId).executeTakeFirstOrThrow()).used_tokens).toBe("1200");
    expect((await quotaFacts(f)).periods[0]!.used_value).toBe("600");
  } finally { await app.close(); }
});
it("PROJECT remains legacy even when enterprise monthly policy is effective", async () => {
  const f = await fixture("CODING_PLAN");
  await db.updateTable("principal").set({ type: "PROJECT" }).where("id", "=", f.principalId).execute();
  const { app, send } = await p1App(db, f, { now: () => NOV });
  try { expect((await send()).statusCode).toBe(200); expect((await quotaFacts(f)).periods).toHaveLength(0); const facts = await p1Facts(db, f);
    expect(facts.counter.used_value).toBe("7");
    expect(facts.leases).toHaveLength(1);
    expect(facts.leases[0]!.released_at).toBeInstanceOf(Date); }
  finally { await app.close(); }
});
it("API monthly does not acquire CP concurrency leases", async () => {
  const f = await fixture("API");
  const { app, send, stub } = await p1App(db, f, { now: () => NOV });
  try { expect((await send()).statusCode).toBe(200); expect(stub.calls).toHaveLength(1); expect((await p1Facts(db, f)).leases).toHaveLength(0); }
  finally { await app.close(); }
});

it.each(["API", "CODING_PLAN"] as const)("%s grant revoked after reservation releases the same monthly period before upstream", async mode => {
  const f = await fixture(mode);
  const original = EmployeeQuotaRepository.prototype.bindEmployeeQuotaAttempt;
  const spy = vi.spyOn(EmployeeQuotaRepository.prototype, "bindEmployeeQuotaAttempt").mockImplementation(async function (this: EmployeeQuotaRepository, input) {
    await original.call(this, input);
    await db.updateTable("principal_grant").set({ status: "DISABLED" }).where("id", "=", f.grantId).execute();
  });
  const { app, send, stub } = await p1App(db, f, { now: () => NOV });
  try {
    expect((await send()).statusCode).toBe(403); expect(stub.calls).toHaveLength(0);
    const q = await quotaFacts(f); expect(q.periods[0]).toMatchObject({ used_value: "0", reserved_value: "0" });
    expect(q.usages[0]).toMatchObject({ actual: "0", status: "SETTLED" });
  } finally { spy.mockRestore(); await app.close(); }
});
it("Coding Plan reserves and settles with the same frozen multiplier even if configuration changes before invoke", async () => {
  const f = await fixture("CODING_PLAN");
  const original = EmployeeQuotaRepository.prototype.bindEmployeeQuotaAttempt;
  const spy = vi.spyOn(EmployeeQuotaRepository.prototype, "bindEmployeeQuotaAttempt").mockImplementation(async function (this: EmployeeQuotaRepository, input) {
    await original.call(this, input);
    await db.updateTable("billing_rule").set({ multiplier: "3" }).where("enterprise_id", "=", f.enterpriseId).execute();
  });
  const { app, send } = await p1App(db, f, { now: () => NOV, outcome: o => ({ ...o, usage: { ...o.usage, input: 1000, output: 200 } }) });
  try { expect((await send()).statusCode).toBe(200);
    expect((await quotaFacts(f)).periods[0]!.used_value).toBe("600");
    expect((await p1Facts(db, f)).lines[0]).toMatchObject({ deducted_quota: "600", multiplier: "0.5" });
  } finally { spy.mockRestore(); await app.close(); }
});
it.each(["API", "CODING_PLAN"] as const)("%s underestimated actual usage records overage and blocks the next request when overage is disabled", async mode => {
  const f = await fixture(mode, 300n, false);
  const { app, send, stub } = await p1App(db, f, { now: () => NOV, outcome: o => ({ ...o, usage: { ...o.usage, input: 1000, output: 200 } }) });
  try {
    expect((await send()).statusCode).toBe(200);
    expect((await quotaFacts(f)).periods[0]!.used_value).toBe(mode === "API" ? "1200" : "600");
    expect((await p1Facts(db, f)).transaction!.overage).toBe(true);
    const second = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${f.key}`, "idempotency-key": "second-call" }, payload: { model: "p1-model", messages: [{ role: "user", content: "isolated test" }] } });
    expect(second.statusCode).toBe(429); expect(stub.calls).toHaveLength(1);
    expect((await quotaFacts(f)).periods[0]!.reserved_value).toBe("0");
  } finally { await app.close(); }
});
it("mixed-currency API failover keeps internal raw quota while refusing a fabricated combined cash amount", async () => {
  const f = await fixture("API", 1000000n, true, 2);
  await db.updateTable("billing_rule").set({ currency: "CNY" }).where("enterprise_id", "=", f.enterpriseId).execute();
  await db.updateTable("billing_rule").set({ currency: "USD" }).where("enterprise_id", "=", f.enterpriseId)
    .where("provider_resource_id", "=", f.candidates[1]!.resourceId).execute();
  const { app, send, stub } = await p1App(db, f, { maxAttempts: 2, now: () => NOV,
    outcome: (o, n) => n === 1 ? { ...o, status: 502, committed: false, error: "upstream_error" } : o });
  try {
    expect((await send()).statusCode).toBe(200); expect(stub.calls).toHaveLength(2);
    const facts = await p1Facts(db, f);
    expect(facts.transaction).toMatchObject({ api_cost_status: "UNKNOWN_COST", total_api_cost: null });
    expect(facts.lines.map(l => l.api_cost_currency).sort()).toEqual(["CNY", "USD"]);
    expect(facts.lines.every(l => l.deducted_quota === null)).toBe(true);
    expect((await quotaFacts(f)).periods[0]).toMatchObject({ used_value: "28", reserved_value: "0" });
  } finally { await app.close(); }
});
it("monthly API keeps final-authorization cash pricing while raw quota ignores an interleaved price update", async () => {
  const f = await fixture("API");
  const originalBind = EmployeeQuotaRepository.prototype.bindEmployeeQuotaAttempt;
  const bindSpy = vi.spyOn(EmployeeQuotaRepository.prototype, "bindEmployeeQuotaAttempt").mockImplementation(async function (this: EmployeeQuotaRepository, input) {
    await originalBind.call(this, input);
    await db.updateTable("billing_rule").set({ cache_miss_price: "0.00002000", output_price: "0.00004000" })
      .where("enterprise_id", "=", f.enterpriseId).execute();
  });
  const { app, send } = await p1App(db, f, { now: () => NOV,
    outcome: o => ({ ...o, usage: { ...o.usage, input: 1000, output: 200, cache: 0 } }) });
  try {
    expect((await send()).statusCode).toBe(200);
    const facts = await p1Facts(db, f);
    expect(facts.lines[0]).toMatchObject({ api_cost: "0.02800000", api_cost_status: "PRICED_USAGE", deducted_quota: null });
    expect(facts.transaction).toMatchObject({ total_api_cost: "0.02800000", api_cost_status: "PRICED_USAGE" });
    expect((await quotaFacts(f)).periods[0]).toMatchObject({ used_value: "1200", reserved_value: "0" });
  } finally { bindSpy.mockRestore(); await app.close(); }
});


it("monthly CP window failure freezes its mode-specific billing classification", async () => {
  const f = await fixture("CODING_PLAN");
  const { app, send } = await p1App(db, f, { now: () => NOV, outcome: o => ({ ...o,
    status: 429, committed: false, error: "upstream_http_429", upstreamErrorKind: "WINDOW_EXHAUSTED",
    recoverAt: new Date(NOV + 3600000).toISOString(),
    usage: { input: 4, output: 2, cache: 0, quality: "PROVIDER_REPORTED" },
  }) });
  try {
    expect((await send()).statusCode).toBe(429);
    const facts = await p1Facts(db, f);
    expect(facts.request).toMatchObject({ status: "FAILED", error_classification: "UPSTREAM_BILLING_BLOCKED", error_code: "upstream_http_429" });
    expect(facts.attempts[0]).toMatchObject({ error_classification: "UPSTREAM_BILLING_BLOCKED" });
    expect(facts.lines[0]).toMatchObject({ raw_input_tokens: "4", raw_output_tokens: "2", deducted_quota: "3" });
  } finally { await app.close(); }
});
