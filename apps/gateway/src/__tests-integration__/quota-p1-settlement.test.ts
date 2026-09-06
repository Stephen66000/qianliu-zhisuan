import { afterAll, beforeAll, expect, it } from "vitest";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { StubUpstream } from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { p1Fixture, p1App, p1Facts } from "./quota-p1-fixture.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => { pg = await startPostgresContainer("quota_p1_test"); db = createKysely(pg.connectionString); await migrateToLatest(db); }, 120000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); });

it.each(["policy", "operating", "evidence"] as const)("F01 %s failure finalizes zero consumption and returns reservations", async (fault) => {
  const f = await p1Fixture(db);
  const { app, stub, send } = await p1App(db, f, { fault });
  try {
    const response = await send();
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("dispatch_check_failed_before_upstream");
    expect(stub.calls).toHaveLength(0);
    const facts = await p1Facts(db, f);
    expect(facts.request).toMatchObject({ status: "FAILED", error_classification: "INTERNAL", error_code: "dispatch_check_failed_before_upstream" });
    expect(facts.attempts[0]).toMatchObject({ http_status: 500, finished_at: expect.any(Date), error_classification: "INTERNAL" });
    expect(facts.lines).toHaveLength(1);
    expect(facts.lines[0]).toMatchObject({ raw_input_tokens: "0", raw_output_tokens: "0", deducted_quota: null });
    expect(facts.counter.used_value).toBe("0");
    expect(facts.leases).toHaveLength(1);
    expect(facts.leases[0]!.released_at).toBeInstanceOf(Date);
    expect(facts.transaction?.total_deducted_quota).toBe("0");
    await send();
    expect((await p1Facts(db, f)).lines).toHaveLength(1);
    expect((await p1Facts(db, f)).counter.used_value).toBe("0");
    expect(stub.calls).toHaveLength(0);
  } finally { await app.close(); }
});

it("F01 API rejects with confirmed zero cost and releases half-open probe", async () => {
  const f = await p1Fixture(db, { mode: "API", probe: true });
  const { app, stub, send } = await p1App(db, f, { fault: "policy" });
  try {
    expect((await send()).statusCode).toBe(500);
    const facts = await p1Facts(db, f);
    expect(facts.request.status).toBe("FAILED");
    expect(facts.lines[0]).toMatchObject({ api_cost: "0.00000000", api_cost_status: "CONFIRMED_ZERO_NO_UPSTREAM" });
    expect((await db.selectFrom("provider_resource").select("last_probe_at").where("id", "=", f.candidates[0]!.resourceId).executeTakeFirst())?.last_probe_at).toBeNull();
    expect(stub.calls).toHaveLength(0);
  } finally { await app.close(); }
});

it.each([false, true])("F02 provider-reported failure charges actual quota; committed=%s", async (committed) => {
  const f = await p1Fixture(db);
  const { app, send } = await p1App(db, f, { outcome: (outcome) => ({ ...outcome, committed, status: 502, error: "upstream_error" }) });
  try {
    expect((await send()).statusCode).toBe(502);
    const facts = await p1Facts(db, f);
    expect(facts.request.status).toBe("FAILED");
    expect(facts.lines[0]).toMatchObject({ deducted_quota: "42", usage_quality: "PROVIDER_REPORTED" });
    expect(facts.counter.used_value).toBe("42");
    expect(facts.transaction?.total_deducted_quota).toBe("42");
    expect(facts.leases[0]!.released_at).toBeInstanceOf(Date);
    await send();
    expect((await p1Facts(db, f)).counter.used_value).toBe("42");
  } finally { await app.close(); }
});

it("F02 estimated stream failure preserves measured deduction", async () => {
  const f = await p1Fixture(db);
  const stub = new StubUpstream({ providerCode: "zhipu", default: { kind: "STREAM", chunks: ["partial"], usage: { input: 10, output: 4, cache: 0 }, failAfterChunk: 1 } });
  const { app, send } = await p1App(db, f, { stub });
  try {
    expect((await send()).statusCode).toBe(502);
    const facts = await p1Facts(db, f);
    expect(facts.lines[0]).toMatchObject({ usage_quality: "ESTIMATED", deducted_quota: "36" });
    expect(facts.counter.used_value).toBe("36");
  } finally { await app.close(); }
});

it("F02 unknown cancellation returns reservation but never invents known usage", async () => {
  const f = await p1Fixture(db);
  const stub = new StubUpstream({ providerCode: "zhipu", default: { kind: "CANCEL" } });
  const { app, send } = await p1App(db, f, { stub });
  try {
    expect((await send()).statusCode).toBe(502);
    const facts = await p1Facts(db, f);
    expect(facts.request.status).toBe("FAILED");
    expect(facts.lines[0]).toMatchObject({ usage_quality: "UNKNOWN", deducted_quota: null });
    expect(facts.counter.used_value).toBe("0");
    expect(facts.leases[0]!.released_at).toBeInstanceOf(Date);
  } finally { await app.close(); }
});

it("F02 measured failure exceeding quota records overage", async () => {
  const f = await p1Fixture(db, { quota: 300n });
  const { app, send } = await p1App(db, f, { outcome: (outcome) => ({ ...outcome, status: 502, error: "upstream_error",
    usage: { ...outcome.usage, input: 200, output: 0 } }) });
  try {
    expect((await send()).statusCode).toBe(502);
    const facts = await p1Facts(db, f);
    expect(facts.counter).toMatchObject({ used_value: "600", overage_value: "300" });
    expect(facts.transaction).toMatchObject({ total_deducted_quota: "600", overage: true });
  } finally { await app.close(); }
});

it("F01 on retry preserves the earlier attempt's measured consumption", async () => {
  const f = await p1Fixture(db, { resources: 2 });
  const { app, stub, send } = await p1App(db, f, { maxAttempts: 2, fault: "second-attempt",
    outcome: (outcome) => ({ ...outcome, committed: false, status: 502, error: "upstream_error" }) });
  try {
    expect((await send()).statusCode).toBe(500);
    const facts = await p1Facts(db, f);
    expect(facts.request.status).toBe("FAILED");
    expect(stub.calls).toHaveLength(1);
    expect(facts.attempts).toHaveLength(2);
    expect(facts.lines).toHaveLength(2);
    expect(facts.counter.used_value).toBe("42");
    expect(facts.transaction?.total_deducted_quota).toBe("42");
    expect(facts.leases.every((lease) => lease.released_at !== null)).toBe(true);
  } finally { await app.close(); }
});

it("F02 retry aggregates each measured attempt exactly once", async () => {
  const f = await p1Fixture(db, { resources: 2 });
  const { app, stub, send } = await p1App(db, f, { maxAttempts: 2,
    outcome: (outcome, n) => n === 1 ? { ...outcome, committed: false, status: 502, error: "upstream_error" } : outcome });
  try {
    expect((await send()).statusCode).toBe(200);
    const facts = await p1Facts(db, f);
    expect(stub.calls).toHaveLength(2);
    expect(facts.counter.used_value).toBe("84");
    expect(facts.transaction?.total_deducted_quota).toBe("84");
    expect(facts.transaction?.overage).toBe(false);
  } finally { await app.close(); }
});

it("F02 retry overage ignores the earlier attempt's refundable reservation", async () => {
  const f = await p1Fixture(db, { resources: 2, quota: 600n });
  const { app, send } = await p1App(db, f, { maxAttempts: 2,
    outcome: (outcome, n) => n === 1
      ? { ...outcome, committed: false, status: 502, error: "upstream_error" }
      : { ...outcome, usage: { ...outcome.usage, input: 160, output: 0 } } });
  try {
    expect((await send()).statusCode).toBe(200);
    const facts = await p1Facts(db, f);
    expect(facts.counter).toMatchObject({ used_value: "522", overage_value: "0" });
    expect(facts.transaction).toMatchObject({ total_deducted_quota: "522", overage: false });
  } finally { await app.close(); }
});

it("F04 retry check failure releases both earlier and current half-open probes", async () => {
  const f = await p1Fixture(db, { resources: 2, probe: true });
  const { app, send } = await p1App(db, f, { maxAttempts: 2, fault: "second-attempt",
    outcome: (outcome) => ({ ...outcome, committed: false, status: 502, error: "upstream_error" }) });
  try {
    expect((await send()).statusCode).toBe(500);
    const facts = await p1Facts(db, f);
    expect(facts.request.status).toBe("FAILED");
    expect(facts.counter.used_value).toBe("42");
    expect(facts.leases.every((lease) => lease.released_at !== null)).toBe(true);
    const resources = await db.selectFrom("provider_resource").select("last_probe_at")
      .where("id", "in", f.candidates.map((candidate) => candidate.resourceId)).execute();
    expect(resources).toHaveLength(2);
    expect(resources.every((resource) => resource.last_probe_at === null)).toBe(true);
  } finally { await app.close(); }
});
