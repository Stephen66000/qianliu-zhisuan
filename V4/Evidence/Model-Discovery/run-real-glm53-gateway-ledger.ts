import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  createKysely,
  GatewayLedgerRepository,
  migrateToLatest,
  QuotaGateRepository,
  ResourcePoolRepository,
  type Database,
} from "../../../packages/database/src/index.js";
import { startPostgresContainer, type PostgresTestInstance } from "../../../packages/testing/src/index.js";
import {
  apiKeyPrefix,
  createOpenAiCompatibleCaller,
  digestApiKey,
  generateApiKey,
  SecretValue,
} from "../../../packages/provider-adapters/src/index.js";
import { buildGateway } from "../../../apps/gateway/src/server.js";
import { createRealPipeline } from "../../../apps/gateway/src/pipeline/real-pipeline.js";

const token = process.env.QIANLIU_TEST_ZHIPU_TOKEN;
if (!token) throw new Error("QIANLIU_TEST_ZHIPU_TOKEN is required");
process.env.LOG_LEVEL = "silent";

const pepper = "glm53-local-real-gateway-pepper-32bytes";
const enterpriseId = randomUUID();
const principalId = randomUUID();
const promptCanary = `GLM53_REAL_GATEWAY_CANARY_${randomUUID()}`;
let pg: PostgresTestInstance | undefined;
let db: Database | undefined;
let gateway: FastifyInstance | undefined;

try {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: enterpriseId, name: "GLM-5.3 real gateway ledger" }).execute();
  await db.insertInto("principal").values({
    id: principalId,
    enterprise_id: enterpriseId,
    type: "EMPLOYEE",
    name: "GLM-5.3 ephemeral local principal",
  }).execute();
  const model = await db.insertInto("unified_model").values({
    enterprise_id: enterpriseId,
    alias: "ql-glm-5.3",
    display_name: "GLM-5.3",
    required_capabilities: JSON.stringify(["chat", "stream"]) as unknown as string[],
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId,
    code: "zhipu",
    name: "智谱本机真实 Gateway",
    adapter_type: "zhipu",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId,
    provider_id: provider.id,
    name: "GLM-5.3 ephemeral real Gateway resource",
    mode: "CODING_PLAN",
    credential_type: "API_KEY",
    concurrency_limit: 1,
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const route = await db.insertInto("model_route").values({
    enterprise_id: enterpriseId,
    unified_model_id: model.id,
    provider_resource_id: resource.id,
    upstream_model: "glm-5.3",
    enabled: true,
  }).returningAll().executeTakeFirstOrThrow();

  const localKey = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId,
    principal_id: principalId,
    key_prefix: apiKeyPrefix(localKey),
    key_digest: digestApiKey(localKey, pepper),
    allowed_model_ids: JSON.stringify([model.id]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId,
    principal_id: principalId,
    provider: "zhipu",
    model_alias: "ql-glm-5.3",
    quota_value: 1_000_000n,
    allow_overage: false,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
  await db.insertInto("billing_rule").values({
    enterprise_id: enterpriseId,
    provider_resource_id: resource.id,
    upstream_model: "glm-5.3",
    rule_type: "MODEL_TIER",
    rule_version: "TEST_ONLY_NOT_VENDOR_FACT",
    effective_from: new Date(0),
    multiplier: "1",
    priority: 1_000,
  }).execute();

  const ledgerRepo = new GatewayLedgerRepository(db);
  const caller = createOpenAiCompatibleCaller({
    env: {},
    requestTimeoutMs: 60_000,
    firstByteTimeoutMs: 15_000,
    streamIdleTimeoutMs: 30_000,
  });
  const pipeline = createRealPipeline({
    db,
    ledgerRepo,
    caller,
    poolRepo: new ResourcePoolRepository(db),
    quotaRepo: new QuotaGateRepository(db),
    listCandidates: async (requestedEnterpriseId, alias) => {
      if (requestedEnterpriseId !== enterpriseId || alias !== "ql-glm-5.3") return [];
      return [{
        routeId: route.id,
        resourceId: resource.id,
        providerId: provider.id,
        unifiedModelId: model.id,
        providerCode: "zhipu",
        upstreamModel: "glm-5.3",
        priority: route.priority,
        weight: route.weight,
        mode: "CODING_PLAN" as const,
        status: "ACTIVE",
        probe: false,
        principalId,
        secret: new SecretValue(token),
        concurrencyLimit: 1,
      }];
    },
  });
  gateway = buildGateway(db, pepper, pipeline);
  await gateway.ready();

  const response = await gateway.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      authorization: `Bearer ${localKey}`,
      "content-type": "application/json",
    },
    payload: {
      model: "ql-glm-5.3",
      messages: [{ role: "user", content: `${promptCanary} Reply with the single word ok.` }],
      reasoning_effort: "max",
      stream: false,
    },
  });
  const requestId = String(response.headers["x-request-id"] ?? "");
  if (!requestId) throw new Error("gateway request id missing");

  const [requestRow, attempts, usageEvents, lines, transaction] = await Promise.all([
    ledgerRepo.getRequest(requestId),
    ledgerRepo.listAttempts(requestId),
    ledgerRepo.listUsageEvents(requestId),
    ledgerRepo.listLedgerLines(requestId),
    ledgerRepo.getLedgerTransaction(requestId),
  ]);
  const contentRows = await Promise.all([
    db.selectFrom("ai_request").selectAll().where("id", "=", requestId).execute(),
    db.selectFrom("route_candidate").selectAll().where("ai_request_id", "=", requestId).execute(),
    db.selectFrom("upstream_attempt").selectAll().where("ai_request_id", "=", requestId).execute(),
    db.selectFrom("usage_event").selectAll().where("ai_request_id", "=", requestId).execute(),
    db.selectFrom("ledger_line").selectAll().where("ai_request_id", "=", requestId).execute(),
    db.selectFrom("ledger_transaction").selectAll().where("ai_request_id", "=", requestId).execute(),
  ]);
  const persistedJson = JSON.stringify(contentRows, (_key, value) => typeof value === "bigint" ? value.toString() : value);

  const responseBody = response.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; error?: { code?: string } };
  const result = {
    environment: {
      database: "ephemeral-pg17-testcontainer",
      billingRule: "TEST_ONLY_NOT_VENDOR_FACT",
      macMiniTouched: false,
      productionTouched: false,
    },
    gateway: {
      statusCode: response.statusCode,
      requestId,
      errorCode: responseBody.error?.code ?? null,
      usage: responseBody.usage ?? null,
    },
    ledger: {
      requestStatus: requestRow?.status ?? null,
      attempts: attempts.length,
      usageEvents: usageEvents.map((usage) => ({
        input: Number(usage.input_tokens),
        output: Number(usage.output_tokens),
        cache: Number(usage.cache_tokens),
        reasoning: Number(usage.reasoning_tokens),
        quality: usage.usage_quality,
      })),
      lines: lines.map((line) => ({
        resourceMode: line.resource_mode,
        apiCost: line.api_cost,
        deductedQuota: line.deducted_quota?.toString() ?? null,
        ruleVersion: line.rule_version,
        usageQuality: line.usage_quality,
      })),
      transaction: transaction ? {
        attemptCount: transaction.attempt_count,
        input: Number(transaction.total_input_tokens),
        output: Number(transaction.total_output_tokens),
        cache: Number(transaction.total_cache_tokens),
        reasoning: Number(transaction.total_reasoning_tokens),
        apiCost: transaction.total_api_cost,
      } : null,
      promptCanaryHits: persistedJson.includes(promptCanary) ? 1 : 0,
    },
  };
  console.log(JSON.stringify(result, null, 2));

  if (response.statusCode !== 200) process.exitCode = 1;
  if (requestRow?.status !== "SUCCEEDED") process.exitCode = 1;
  if (attempts.length !== 1 || usageEvents.length !== 1 || lines.length !== 1 || !transaction) process.exitCode = 1;
  if (result.ledger.promptCanaryHits !== 0) process.exitCode = 1;
} finally {
  await gateway?.close().catch(() => undefined);
  await db?.destroy().catch(() => undefined);
  await pg?.stop().catch(() => undefined);
}
