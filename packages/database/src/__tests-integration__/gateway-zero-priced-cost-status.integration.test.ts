import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest } from "../index.js";
import { GatewayLedgerRepository } from "../repositories/gateway-ledger-repository.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => {
  pg = await startPostgresContainer("zero_priced_api_cost_status");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60000);

async function frozenZeroPriceUsage() {
  const enterprise = await db.insertInto("enterprise").values({ name: "zero priced API contract" }).returning("id").executeTakeFirstOrThrow();
  const principal = await db.insertInto("principal").values({ enterprise_id: enterprise.id, type: "EMPLOYEE", name: "zero price employee" }).returning("id").executeTakeFirstOrThrow();
  const key = await db.insertInto("principal_key").values({ enterprise_id: enterprise.id, principal_id: principal.id,
    key_prefix: "zero-price", key_digest: randomUUID() }).returning("id").executeTakeFirstOrThrow();
  const repo = new GatewayLedgerRepository(db);
  const request = await repo.createRequest({ id: randomUUID(), enterprise_id: enterprise.id, principal_id: principal.id, principal_key_id: key.id,
    protocol: "chat", unified_model: "zero-price-model" });
  const provider = await db.insertInto("provider").values({ enterprise_id: enterprise.id, code: "zero-priced", name: "zero price", adapter_type: "OPENAI_COMPATIBLE" }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({ enterprise_id: enterprise.id, provider_id: provider.id,
    name: "zero price API", mode: "API", credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow();
  const attempt = await repo.createAttempt({ enterprise_id: enterprise.id, ai_request_id: request.id, attempt_no: 1,
    provider_resource_id: resource.id, upstream_model: "zero-price-model" });
  await repo.updateAttemptResult(attempt.id, { http_status: 200, response_committed: true, finished_at: new Date() });
  const evidence = {
    usage: { enterprise_id: enterprise.id, ai_request_id: request.id, upstream_attempt_id: attempt.id,
      provider_resource_id: resource.id, input_tokens: 100n, output_tokens: 20n, cache_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: randomUUID() },
    ledger_line: { enterprise_id: enterprise.id, ai_request_id: request.id, principal_id: principal.id,
      upstream_attempt_id: attempt.id, provider_resource_id: resource.id, resource_mode: "API",
      raw_input_tokens: 100n, raw_output_tokens: 20n, raw_cache_tokens: 0n, deducted_quota: null,
      api_cost: "0.00000000", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE" as const, usage_quality: "PROVIDER_REPORTED" },
  };
  const persisted = await repo.createUsageAndLedgerLineIfAbsent(evidence);
  return { enterprise, principal, request, resource, repo, evidence, persisted };
}

it("measured API usage at a configured zero price remains PRICED_USAGE when transaction status is omitted", async () => {
  const f = await frozenZeroPriceUsage();
  const transaction = await f.repo.createLedgerTransactionIfAbsent({
    enterprise_id: f.enterprise.id, ai_request_id: f.request.id, principal_id: f.principal.id,
    total_input_tokens: 100n, total_output_tokens: 20n, total_cache_tokens: 0n,
    total_deducted_quota: 0n, total_api_cost: "0.00000000", usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
  });
  expect(transaction).toMatchObject({ api_cost_status: "PRICED_USAGE", total_api_cost: "0.00000000",
    total_input_tokens: "100", total_output_tokens: "20" });
  expect((await f.repo.listLedgerLines(f.request.id))[0]).toMatchObject({ api_cost_status: "PRICED_USAGE", raw_input_tokens: "100",
    api_cost: "0.00000000", deducted_quota: null });
});

it("existing usage/line replay returns before an unrelated resource metadata lock is released", async () => {
  const f = await frozenZeroPriceUsage();
  const lockerDb = createKysely(pg.connectionString);
  const replayDb = createKysely(pg.connectionString);
  let releaseResource!: () => void;
  const release = new Promise<void>(resolve => { releaseResource = resolve; });
  let markLocked!: (pid: number) => void;
  const locked = new Promise<number>(resolve => { markLocked = resolve; });
  const holder = lockerDb.transaction().execute(async trx => {
    const pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
    await trx.selectFrom("provider_resource").select("id").where("id", "=", f.resource.id).forUpdate().executeTakeFirstOrThrow();
    markLocked(pid);
    await release;
  });
  let replay: ReturnType<GatewayLedgerRepository["createUsageAndLedgerLineIfAbsent"]> | undefined;
  try {
    const holderPid = await locked;
    let completed = false;
    replay = new GatewayLedgerRepository(replayDb).createUsageAndLedgerLineIfAbsent(f.evidence);
    void replay.then(() => { completed = true; }, () => { completed = true; });
    let blockedByResource = false;
    for (let poll = 0; poll < 500 && !completed && !blockedByResource; poll++) {
      const result = await sql<{ blocked: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity a WHERE ${holderPid} = ANY(pg_blocking_pids(a.pid))
      ) AS blocked`.execute(db);
      blockedByResource = result.rows[0]!.blocked;
      if (!completed && !blockedByResource) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blockedByResource, "idempotent replay must not join-lock the independently updated resource").toBe(false);
    expect(completed, "existing evidence should return without releasing the resource lock").toBe(true);
    expect(await replay).toMatchObject({ created: false, line: { id: f.persisted.line.id } });
    expect(await db.selectFrom("ledger_line").select("id").where("ai_request_id", "=", f.request.id).execute()).toHaveLength(1);
  } finally {
    releaseResource();
    await Promise.allSettled([holder, ...(replay ? [replay] : [])]);
    await lockerDb.destroy();
    await replayDb.destroy();
  }
});
