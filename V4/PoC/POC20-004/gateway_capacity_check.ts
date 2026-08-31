import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AddressInfo } from "node:net";
import {
  createKysely,
  GatewayLedgerRepository,
  migrateToLatest,
  QuotaGateRepository,
  ResourcePoolRepository,
} from "../../../packages/database/src/index.ts";
import { startPostgresContainer } from "../../../packages/testing/src/index.ts";
import {
  apiKeyPrefix,
  createOpenAiCompatibleCaller,
  digestApiKey,
  generateApiKey,
  SecretValue,
} from "../../../packages/provider-adapters/src/index.ts";
import { createRealPipeline } from "../../../apps/gateway/src/pipeline/real-pipeline.ts";
import { buildGateway } from "../../../apps/gateway/src/server.ts";
import { seedMissingBillingRules } from "../../../apps/gateway/src/__tests-integration__/billing-rule-fixture.ts";

const ENTERPRISE_ID = "64000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "64000000-0000-4000-8000-000000000002";
const PEPPER = "poc20-004-gateway-pepper-32bytes";
const normalConcurrency = positiveInt(process.env.POC20_GATEWAY_CONCURRENCY, 500);
const streamConcurrency = positiveInt(process.env.POC20_STREAM_CONCURRENCY, 200);
const streamHoldMs = positiveInt(process.env.POC20_STREAM_HOLD_MS, 120);

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid positive integer: ${value}`);
  return parsed;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

function summarize(values: number[]): Record<string, number> {
  return {
    min_ms: Number(Math.min(...values).toFixed(3)),
    p50_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    p99_ms: percentile(values, 99),
    max_ms: Number(Math.max(...values).toFixed(3)),
  };
}

async function runBatch(
  count: number,
  operation: (index: number) => Promise<{ status: number; firstByteMs: number; totalMs: number }>,
) {
  const results = await Promise.all(Array.from({ length: count }, (_, index) => operation(index)));
  return {
    count,
    success: results.filter((result) => result.status === 200).length,
    first_byte: summarize(results.map((result) => result.firstByteMs)),
    total: summarize(results.map((result) => result.totalMs)),
  };
}

async function timedRequest(url: string, headers: Record<string, string>, payload: unknown) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const firstByteMs = performance.now() - started;
  await response.arrayBuffer();
  return { status: response.status, firstByteMs, totalMs: performance.now() - started };
}

async function timedStream(url: string, headers: Record<string, string>, payload: unknown) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream response body is missing");
  await reader.read();
  const firstByteMs = performance.now() - started;
  while (!(await reader.read()).done) {
    // Drain the stream so Gateway settlement completes before invariant checks.
  }
  return { status: response.status, firstByteMs, totalMs: performance.now() - started };
}

async function tableCount(db: ReturnType<typeof createKysely>, table: "ai_request" | "upstream_attempt" | "usage_event" | "ledger_line" | "ledger_transaction") {
  const row = await db.selectFrom(table).select(db.fn.countAll().as("count")).executeTakeFirstOrThrow();
  return Number(row.count);
}

async function main(): Promise<void> {
  process.env.LOG_LEVEL = "silent";
  const upstream = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as { stream?: boolean };
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write("data: {\"choices\":[{\"delta\":{\"content\":\"首字\"}}]}\n\n");
        setTimeout(() => response.end([
          "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
          "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n",
          "data: [DONE]\n\n",
        ].join("")), streamHoldMs);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address() as AddressInfo;
  const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}/v1/chat/completions`;

  const pg = await startPostgresContainer("poc20_004_gateway");
  const db = createKysely(pg.connectionString);
  let gateway: ReturnType<typeof buildGateway> | undefined;
  try {
    await migrateToLatest(db);
    await db.insertInto("enterprise").values({ id: ENTERPRISE_ID, name: "POC20-004 standard enterprise" }).execute();
    const principals = Array.from({ length: 1000 }, (_, index) => ({
      id: index === 0 ? PRINCIPAL_ID : randomUUID(),
      enterprise_id: ENTERPRISE_ID,
      type: index % 5 === 0 ? "PROJECT" as const : "EMPLOYEE" as const,
      name: `capacity-principal-${index + 1}`,
      department_label: `department-${(index % 10) + 1}`,
      person_id: null,
      owner_person_id: null,
    }));
    await db.insertInto("principal").values(principals).execute();
    const model = await db.insertInto("unified_model").values({
      enterprise_id: ENTERPRISE_ID,
      alias: "qianliu-capacity",
      display_name: "Capacity Model",
      status: "ACTIVE",
    }).returningAll().executeTakeFirstOrThrow();
    const key = generateApiKey();
    await db.insertInto("principal_key").values({
      enterprise_id: ENTERPRISE_ID,
      principal_id: PRINCIPAL_ID,
      key_prefix: apiKeyPrefix(key),
      key_digest: digestApiKey(key, PEPPER),
      allowed_model_ids: JSON.stringify([model.id]) as unknown as string[],
      quota_limit: 100_000_000n,
      concurrency_limit: normalConcurrency + streamConcurrency + 100,
      status: "ACTIVE",
      ip_allowlist: null,
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
    }).execute();
    const provider = await db.insertInto("provider").values({
      enterprise_id: ENTERPRISE_ID,
      code: "deepseek",
      name: "Capacity Stub",
      adapter_type: "deepseek",
    }).returningAll().executeTakeFirstOrThrow();
    const resource = await db.insertInto("provider_resource").values({
      enterprise_id: ENTERPRISE_ID,
      provider_id: provider.id,
      name: "capacity-resource",
      mode: "API",
      credential_type: "API_KEY",
      concurrency_limit: normalConcurrency + streamConcurrency + 100,
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENTERPRISE_ID,
      unified_model_id: model.id,
      provider_resource_id: resource.id,
      upstream_model: "capacity-model",
    }).execute();
    await seedMissingBillingRules(db, ENTERPRISE_ID);
    await db.insertInto("principal_grant").values({
      enterprise_id: ENTERPRISE_ID,
      principal_id: PRINCIPAL_ID,
      provider: "deepseek",
      model_alias: "qianliu-capacity",
      quota_value: 100_000_000n,
    }).execute();

    const pipeline = createRealPipeline({
      db,
      ledgerRepo: new GatewayLedgerRepository(db),
      poolRepo: new ResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      caller: createOpenAiCompatibleCaller({ env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamAddress.port}/v1` } }),
      listCandidates: async () => [{
        resourceId: resource.id,
        providerCode: "deepseek",
        upstreamModel: "capacity-model",
        priority: 100,
        weight: 100,
        mode: "API",
        status: "ACTIVE",
        probe: false,
        principalId: PRINCIPAL_ID,
        secret: new SecretValue("capacity-stub-secret"),
        concurrencyLimit: normalConcurrency + streamConcurrency + 100,
      }],
    });
    gateway = buildGateway(db, PEPPER, pipeline);
    await gateway.listen({ port: 0, host: "127.0.0.1" });
    const gatewayAddress = gateway.server.address() as AddressInfo;
    const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}/v1/chat/completions`;
    const headers = { authorization: `Bearer ${key}` };
    const normalPayload = { model: "qianliu-capacity", messages: [{ role: "user", content: "capacity" }] };
    const streamPayload = { ...normalPayload, stream: true };

    for (let index = 0; index < 10; index += 1) {
      const warmup = await timedRequest(gatewayUrl, { ...headers, "x-request-id": `warmup-${index}` }, normalPayload);
      if (warmup.status !== 200) throw new Error(`warmup failed: ${warmup.status}`);
    }

    const before = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const directStream = await runBatch(streamConcurrency, (index) => timedStream(
      upstreamUrl,
      { authorization: "Bearer direct", "x-request-id": `direct-stream-${index}` },
      streamPayload,
    ));
    const gatewayNormal = await runBatch(normalConcurrency, (index) => timedRequest(
      gatewayUrl,
      { ...headers, "x-request-id": `gateway-normal-${index}` },
      normalPayload,
    ));
    const gatewayStream = await runBatch(streamConcurrency, (index) => timedStream(
      gatewayUrl,
      { ...headers, "x-request-id": `gateway-stream-${index}` },
      streamPayload,
    ));
    const cpu = process.cpuUsage(cpuBefore);
    const after = process.memoryUsage();
    const expectedRows = 10 + normalConcurrency + streamConcurrency;
    const counts = {
      principals: Number((await db.selectFrom("principal").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow()).count),
      requests: await tableCount(db, "ai_request"),
      attempts: await tableCount(db, "upstream_attempt"),
      usage_events: await tableCount(db, "usage_event"),
      ledger_lines: await tableCount(db, "ledger_line"),
      ledger_transactions: await tableCount(db, "ledger_transaction"),
    };
    const gatewayTtftIncrement = Number((gatewayStream.first_byte.p95_ms - directStream.first_byte.p95_ms).toFixed(3));
    const invariantCountsMatch = [
      counts.requests,
      counts.attempts,
      counts.usage_events,
      counts.ledger_lines,
      counts.ledger_transactions,
    ].every((count) => count === expectedRows);

    process.stdout.write(`${JSON.stringify({
      result: gatewayNormal.success === normalConcurrency
        && gatewayStream.success === streamConcurrency
        && invariantCountsMatch
        ? "PASS_WITH_LIMITATIONS"
        : "FAILED",
      scope: "real 1.0 Gateway pipeline against local HTTP stub; not the 2.0 final candidate",
      load: {
        principals_seeded: counts.principals,
        normal_concurrency: normalConcurrency,
        stream_concurrency: streamConcurrency,
        stream_hold_ms: streamHoldMs,
      },
      direct_stream_baseline: directStream,
      gateway_normal: gatewayNormal,
      gateway_stream: gatewayStream,
      gateway_incremental_ttft_p95_ms: gatewayTtftIncrement,
      candidate_ttft_increment_le_150ms: gatewayTtftIncrement <= 150,
      database_facts: { expected_each: expectedRows, ...counts, invariant_counts_match: invariantCountsMatch },
      process_delta: {
        cpu_user_ms: Number((cpu.user / 1000).toFixed(3)),
        cpu_system_ms: Number((cpu.system / 1000).toFixed(3)),
        heap_bytes: after.heapUsed - before.heapUsed,
        rss_bytes: after.rss - before.rss,
      },
      runtime: process.version,
    }, null, 2)}\n`);
  } finally {
    if (gateway) await gateway.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
