import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createKysely,
  GatewayLedgerRepository,
  GatewayLedgerSettlementConflictError,
  migrateToLatest,
  OperatingBillAccountRepository,
  OperatingBillConcurrentModificationError,
  OperatingBillRepository,
  QuotaGateRepository,
  ResourcePoolRepository,
  type CreateUsageLedgerLineInput,
  type CreateAttemptInput,
  type Database,
  type UpstreamAttempt,
  type UsageLedgerLineResult,
} from "@qianliu/database";
import {
  apiKeyPrefix,
  digestApiKey,
  generateApiKey,
  type UpstreamCaller,
} from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { buildGateway } from "../server.js";
import { createRealPipeline } from "../pipeline/real-pipeline.js";

class PausingLedgerRepository extends GatewayLedgerRepository {
  private settlementCount = 0;
  private markFirstSettled!: () => void;
  private releaseFirst!: () => void;
  readonly firstSettled = new Promise<void>((resolve) => { this.markFirstSettled = resolve; });
  private readonly firstRelease = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  override async createUsageAndLedgerLineIfAbsent(
    input: CreateUsageLedgerLineInput,
  ): Promise<UsageLedgerLineResult> {
    const result = await super.createUsageAndLedgerLineIfAbsent(input);
    this.settlementCount += 1;
    if (this.settlementCount === 1) {
      this.markFirstSettled();
      await this.firstRelease;
    }
    return result;
  }

  continue(): void {
    this.releaseFirst();
  }
}

class FailingSuccessResourcePoolRepository extends ResourcePoolRepository {
  override async recordSuccess(_resourceId: string): Promise<never> {
    throw new Error("pool043_record_success_failure");
  }
}

class MutatingAttemptLedgerRepository extends GatewayLedgerRepository {
  constructor(
    database: Kysely<Database>,
    private readonly beforeAuthorization: (attempt: UpstreamAttempt) => Promise<void>,
  ) {
    super(database);
  }

  override async createAttempt(input: CreateAttemptInput): Promise<UpstreamAttempt> {
    const attempt = await super.createAttempt(input);
    await this.beforeAuthorization(attempt);
    return attempt;
  }
}

let pg: PostgresTestInstance;
let db: Kysely<Database>;
let app: FastifyInstance;
let ledgerRepo: PausingLedgerRepository;
let validKey: string;
let enterpriseId: string;
let adminId: string;
let employeeId: string;

const pepper = "pool043-settlement-pepper-32bytes!!";
const alias = "ql-pool043-settlement";

function currentShanghaiMonth(): string {
  const shanghai = new Date(Date.now() + 8 * 60 * 60 * 1_000);
  return `${shanghai.getUTCFullYear()}-${String(shanghai.getUTCMonth() + 1).padStart(2, "0")}`;
}

function expectUnknownApiCostBill(
  bill: Awaited<ReturnType<OperatingBillRepository["getBill"]>>,
  providerResourceId: string,
  principalId: string,
  status: "DRAFT" | "CLOSED",
): void {
  expect(bill).toMatchObject({
    status,
    summary: { apiCost: null, totalCost: null },
  });
  expect(bill.providers.find((provider) => provider.providerResourceId === providerResourceId))
    .toMatchObject({ apiCost: null, totalCost: null });
  expect(bill.subjects.find((subject) => subject.principalId === principalId))
    .toMatchObject({ apiCost: null, totalAllocatedCost: null });
  expect(bill.gaps).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "API_COST_UNKNOWN", providerResourceId }),
  ]));
}

async function seedIndependentPipelineEnterprise(
  label: string,
  options: { mode?: "API" | "CODING_PLAN"; halfOpenProbe?: boolean } = {},
): Promise<{
  enterpriseId: string;
  adminId: string;
  employeeId: string;
  modelId: string;
  providerId: string;
  resourceId: string;
  grantId: string;
  alias: string;
  upstreamModel: string;
  validKey: string;
  mode: "API" | "CODING_PLAN";
}> {
  const fixtureEnterpriseId = randomUUID();
  const fixtureAdminId = randomUUID();
  const fixtureEmployeeId = randomUUID();
  const fixtureAlias = `ql-pool043-${label}`;
  const upstreamModel = `deepseek-pool043-${label}`;
  const mode = options.mode ?? "API";
  await db.insertInto("enterprise").values({
    id: fixtureEnterpriseId,
    name: `POOL-043 独立企业 ${label}`,
  }).execute();
  await db.insertInto("admin_user").values({
    id: fixtureAdminId,
    enterprise_id: fixtureEnterpriseId,
    username: `pool043-${label}-${fixtureAdminId.slice(0, 8)}`,
    display_name: `POOL-043 ${label} 管理员`,
    password_hash: "not-used",
    status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: fixtureEmployeeId,
    enterprise_id: fixtureEnterpriseId,
    type: "EMPLOYEE",
    name: `POOL-043 ${label} 员工`,
  }).execute();
  const model = await db.insertInto("unified_model").values({
    enterprise_id: fixtureEnterpriseId,
    alias: fixtureAlias,
    display_name: `POOL-043 ${label} 模型`,
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const fixtureKey = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: fixtureEnterpriseId,
    principal_id: fixtureEmployeeId,
    key_prefix: apiKeyPrefix(fixtureKey),
    key_digest: digestApiKey(fixtureKey, pepper),
    allowed_model_ids: JSON.stringify([model.id]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: fixtureEnterpriseId,
    code: "deepseek",
    name: `DeepSeek ${label}`,
    adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: fixtureEnterpriseId,
    provider_id: provider.id,
    name: `POOL-043 ${label} 资源`,
    mode,
    credential_type: "API_KEY",
    concurrency_limit: 1,
    ...(options.halfOpenProbe
      ? {
          status: "UNAVAILABLE",
          consecutive_failures: 3,
          cooldown_until: new Date(Date.now() - 60_000),
        }
      : {}),
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: fixtureEnterpriseId,
    unified_model_id: model.id,
    provider_resource_id: resource.id,
    upstream_model: upstreamModel,
    priority: 1,
    weight: 100,
  }).execute();
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: fixtureEnterpriseId,
    principal_id: fixtureEmployeeId,
    provider: "deepseek",
    model_alias: "*",
    pool_model_alias: "*",
    quota_value: 1_000_000n,
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
  await db.insertInto("billing_rule").values({
    enterprise_id: fixtureEnterpriseId,
    provider_resource_id: resource.id,
    upstream_model: upstreamModel,
    rule_type: mode === "API" ? "API_PRICE" : "MODEL_TIER",
    rule_version: `pool043-${label.slice(0, 16)}-price`,
    effective_from: new Date(0),
    cache_hit_price: mode === "API" ? "0.000001" : null,
    cache_miss_price: mode === "API" ? "0.000002" : null,
    output_price: mode === "API" ? "0.000004" : null,
    multiplier: mode === "CODING_PLAN" ? "1" : null,
    priority: 10,
  }).execute();
  return {
    enterpriseId: fixtureEnterpriseId,
    adminId: fixtureAdminId,
    employeeId: fixtureEmployeeId,
    modelId: model.id,
    providerId: provider.id,
    resourceId: resource.id,
    grantId: grant.id,
    alias: fixtureAlias,
    upstreamModel,
    validKey: fixtureKey,
    mode,
  };
}

beforeAll(async () => {
  pg = process.env.POOL043_GATEWAY_SETTLEMENT_DATABASE_URL
    ? {
        connectionString: process.env.POOL043_GATEWAY_SETTLEMENT_DATABASE_URL,
        stop: async () => undefined,
      }
    : await startPostgresContainer("pool043_pipeline_settlement");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  enterpriseId = randomUUID();
  adminId = randomUUID();
  employeeId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL-043 Pipeline 企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "pool043-pipeline-admin",
    display_name: "POOL-043 管理员", password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "于滔",
  }).execute();
  const model = await db.insertInto("unified_model").values({
    enterprise_id: enterpriseId, alias, display_name: "POOL-043 Settlement", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  validKey = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId, principal_id: employeeId,
    key_prefix: apiKeyPrefix(validKey), key_digest: digestApiKey(validKey, pepper),
    allowed_model_ids: JSON.stringify([model.id]) as unknown as string[], status: "ACTIVE",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const resources = await db.insertInto("provider_resource").values([
    { enterprise_id: enterpriseId, provider_id: provider.id, name: "POOL-043 API-A", mode: "API", credential_type: "API_KEY" },
    { enterprise_id: enterpriseId, provider_id: provider.id, name: "POOL-043 API-B", mode: "API", credential_type: "API_KEY" },
  ]).returningAll().execute();
  await db.insertInto("model_route").values(resources.map((resource, index) => ({
    enterprise_id: enterpriseId, unified_model_id: model.id,
    provider_resource_id: resource.id, upstream_model: `deepseek-pool043-${index + 1}`,
    priority: index + 1, weight: 100,
  }))).execute();
  await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId, principal_id: employeeId, provider: "deepseek",
    model_alias: "*", pool_model_alias: "*", quota_value: 1_000_000n,
  }).execute();
  await db.insertInto("billing_rule").values(resources.map((resource, index) => ({
    enterprise_id: enterpriseId, provider_resource_id: resource.id,
    upstream_model: `deepseek-pool043-${index + 1}`, rule_type: "API_PRICE",
    rule_version: `pool043-price-${index + 1}`, effective_from: new Date(0),
    cache_hit_price: "0.000001", cache_miss_price: "0.000002",
    output_price: "0.000004", priority: 10,
  }))).execute();

  const caller: UpstreamCaller = async (_resource, _request, attemptNo) => attemptNo === 1
    ? {
        status: 0, committed: false,
        usage: { input: 10, output: 2, cache: 1, quality: "ESTIMATED" },
        error: "transport_error",
      }
    : {
        status: 200, committed: true,
        usage: { input: 30, output: 5, cache: 3, quality: "PROVIDER_REPORTED" },
      };
  ledgerRepo = new PausingLedgerRepository(db);
  const pipeline = createRealPipeline({
    db,
    ledgerRepo,
    caller,
    poolRepo: new ResourcePoolRepository(db),
    quotaRepo: new QuotaGateRepository(db),
    maxAttempts: 2,
    listCandidates: async () => resources.map((resource, index) => ({
      resourceId: resource.id,
      providerCode: "deepseek",
      upstreamModel: `deepseek-pool043-${index + 1}`,
      priority: index + 1,
      weight: 100,
      mode: "API" as const,
      status: "ACTIVE",
      probe: false,
      principalId: employeeId,
      providerId: provider.id,
      unifiedModelId: model.id,
    })),
  });
  app = buildGateway(db, pepper, pipeline);
  await app.ready();
}, 120_000);

afterAll(async () => {
  ledgerRepo?.continue();
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("POOL-043 真实 pipeline 结算与关账 completion barrier", () => {
  it("双 Attempt 第一笔已落账时拒绝冻结，transaction/status 完整后才可关账", async () => {
    const responsePromise = app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${validKey}`,
        "content-type": "application/json",
      },
      payload: { model: alias, messages: [{ role: "user", content: "POOL-043 multi attempt" }] },
    });
    try {
      await ledgerRepo.firstSettled;
      const request = await db.selectFrom("ai_request").selectAll()
        .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
      expect(request.status).toBe("IN_PROGRESS");
      expect(await ledgerRepo.listAttempts(request.id)).toHaveLength(1);
      expect(await ledgerRepo.listUsageEvents(request.id)).toHaveLength(1);
      expect(await ledgerRepo.listLedgerLines(request.id)).toHaveLength(1);
      expect(await ledgerRepo.getLedgerTransaction(request.id)).toBeUndefined();
      await expect(new OperatingBillRepository(db).closeMonth({
        enterpriseId, adminId, month: currentShanghaiMonth(), allowIncomplete: true,
        note: "POOL-043 multi-attempt 在途结算不可冻结",
      })).rejects.toBeInstanceOf(OperatingBillConcurrentModificationError);
      expect((await db.selectFrom("operating_bill_period").select("status")
        .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow()).status).toBe("DRAFT");
    } finally {
      ledgerRepo.continue();
    }

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    const requestId = response.headers["x-ai-request-id"] as string;
    expect(await ledgerRepo.listAttempts(requestId)).toHaveLength(2);
    expect(await ledgerRepo.listUsageEvents(requestId)).toHaveLength(2);
    expect(await ledgerRepo.listLedgerLines(requestId)).toHaveLength(2);
    expect(await ledgerRepo.getLedgerTransaction(requestId)).toMatchObject({
      attempt_count: 2,
      total_input_tokens: "40",
      total_output_tokens: "7",
      total_cache_tokens: "4",
      total_api_cost: "0.00010400",
    });
    expect((await ledgerRepo.getRequest(requestId))?.status).toBe("SUCCEEDED");
    await expect(new OperatingBillRepository(db).closeMonth({
      enterpriseId, adminId, month: currentShanghaiMonth(), allowIncomplete: true,
      note: "POOL-043 multi-attempt 结算完整后冻结",
    })).resolves.toMatchObject({ status: "CLOSED", version: 1 });
    const employees = await new OperatingBillAccountRepository(db)
      .listAccounts(enterpriseId, currentShanghaiMonth(), "EMPLOYEE");
    expect(employees.rows.find((row) => row.subjectId === employeeId)?.totals)
      .toMatchObject({ totalTokens: "47", requestCount: 1, apiCost: "0.00010400" });
  });

  it("Adapter 已返回 usage 后健康副作用失败，仍完成核心结算并允许关账", async () => {
    const fixture = await seedIndependentPipelineEnterprise("health-failure", {
      mode: "CODING_PLAN",
    });
    const scenarioLedgerRepo = new GatewayLedgerRepository(db);
    let upstreamCalls = 0;
    const pipeline = createRealPipeline({
      db,
      ledgerRepo: scenarioLedgerRepo,
      caller: async () => {
        upstreamCalls += 1;
        return {
          status: 200,
          committed: true,
          usage: { input: 36, output: 9, cache: 4, quality: "PROVIDER_REPORTED" },
        };
      },
      poolRepo: new FailingSuccessResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      maxAttempts: 1,
      listCandidates: async () => [{
        resourceId: fixture.resourceId,
        providerCode: "deepseek",
        upstreamModel: fixture.upstreamModel,
        priority: 1,
        weight: 100,
        mode: fixture.mode,
        status: "ACTIVE",
        probe: false,
        principalId: fixture.employeeId,
        providerId: fixture.providerId,
        unifiedModelId: fixture.modelId,
      }],
    });
    const scenarioApp = buildGateway(db, pepper, pipeline);
    await scenarioApp.ready();
    try {
      const response = await scenarioApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${fixture.validKey}`,
          "content-type": "application/json",
        },
        payload: {
          model: fixture.alias,
          messages: [{ role: "user", content: "POOL-043 health side effect" }],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(upstreamCalls).toBe(1);

      const request = await db.selectFrom("ai_request").selectAll()
        .where("enterprise_id", "=", fixture.enterpriseId)
        .orderBy("started_at", "desc").executeTakeFirstOrThrow();
      const attempts = await scenarioLedgerRepo.listAttempts(request.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        http_status: 200,
        response_committed: true,
        error_classification: null,
      });
      expect(attempts[0]?.finished_at).toBeInstanceOf(Date);
      expect(await scenarioLedgerRepo.listUsageEvents(request.id)).toHaveLength(1);
      expect(await scenarioLedgerRepo.listLedgerLines(request.id)).toHaveLength(1);
      expect(await scenarioLedgerRepo.getLedgerTransaction(request.id)).toMatchObject({
        attempt_count: 1,
        total_input_tokens: "36",
        total_output_tokens: "9",
        total_cache_tokens: "4",
      });
      expect((await scenarioLedgerRepo.getRequest(request.id))?.status).toBe("SUCCEEDED");
      expect((await db.selectFrom("quota_counter").select("used_value")
        .where("grant_id", "=", fixture.grantId).executeTakeFirstOrThrow()).used_value)
        .toBe("45");
      expect(await new QuotaGateRepository(db).activeConcurrency(fixture.resourceId)).toBe(0);

      await expect(new OperatingBillRepository(db).closeMonth({
        enterpriseId: fixture.enterpriseId,
        adminId: fixture.adminId,
        month: currentShanghaiMonth(),
        allowIncomplete: true,
        note: "POOL-043 健康副作用失败不阻断已完成结算",
      })).resolves.toMatchObject({ status: "CLOSED", version: 1 });
      expect((await db.selectFrom("operating_bill_period").select("status")
        .where("enterprise_id", "=", fixture.enterpriseId)
        .executeTakeFirstOrThrow()).status).toBe("CLOSED");
    } finally {
      await scenarioApp.close();
    }
  });

  it("首次 Attempt 已产生用量后，第二个同厂商资源在上游前撤权，立即终结且不以兄弟 route 放行", async () => {
    const fixture = await seedIndependentPipelineEnterprise("multi-attempt-revoked");
    const secondResource = await db.insertInto("provider_resource").values({
      enterprise_id: fixture.enterpriseId,
      provider_id: fixture.providerId,
      name: "POOL-043 撤权第二资源",
      mode: "API",
      credential_type: "API_KEY",
    }).returningAll().executeTakeFirstOrThrow();
    const secondUpstreamModel = `${fixture.upstreamModel}-second`;
    await db.insertInto("model_route").values({
      enterprise_id: fixture.enterpriseId,
      unified_model_id: fixture.modelId,
      provider_resource_id: secondResource.id,
      upstream_model: secondUpstreamModel,
      priority: 2,
      weight: 100,
    }).execute();
    await db.insertInto("billing_rule").values({
      enterprise_id: fixture.enterpriseId,
      provider_resource_id: secondResource.id,
      upstream_model: secondUpstreamModel,
      rule_type: "API_PRICE",
      rule_version: "pool043-revoked-second-price",
      effective_from: new Date(0),
      cache_miss_price: "0.000002",
      output_price: "0.000004",
    }).execute();
    let upstreamCalls = 0;
    const scenarioLedgerRepo = new MutatingAttemptLedgerRepository(db, async (attempt) => {
      if (attempt.attempt_no === 2) {
        await db.updateTable("provider_resource").set({ status: "UNAVAILABLE" })
          .where("id", "=", secondResource.id).execute();
      }
    });
    const scenarioApp = buildGateway(db, pepper, createRealPipeline({
      db,
      ledgerRepo: scenarioLedgerRepo,
      poolRepo: new ResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      maxAttempts: 2,
      listCandidates: async () => [
        {
          resourceId: fixture.resourceId,
          providerCode: "deepseek",
          upstreamModel: fixture.upstreamModel,
          priority: 1,
          weight: 100,
          mode: "API",
          status: "ACTIVE",
          probe: false,
          principalId: fixture.employeeId,
          providerId: fixture.providerId,
          unifiedModelId: fixture.modelId,
        },
        {
          resourceId: secondResource.id,
          providerCode: "deepseek",
          upstreamModel: secondUpstreamModel,
          priority: 2,
          weight: 100,
          mode: "API",
          status: "ACTIVE",
          probe: false,
          principalId: fixture.employeeId,
          providerId: fixture.providerId,
          unifiedModelId: fixture.modelId,
        },
      ],
      caller: async () => {
        upstreamCalls += 1;
        return {
          status: 0,
          committed: false,
          usage: { input: 21, output: 4, cache: 2, quality: "ESTIMATED" },
          error: "transport_error",
        };
      },
    }));
    await scenarioApp.ready();
    try {
      const response = await scenarioApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${fixture.validKey}`,
          "content-type": "application/json",
        },
        payload: {
          model: fixture.alias,
          messages: [{ role: "user", content: "POOL-043 multi attempt revoked" }],
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("key_or_model_authorization_revoked");
      expect(upstreamCalls).toBe(1);
      const request = await db.selectFrom("ai_request").selectAll()
        .where("enterprise_id", "=", fixture.enterpriseId).executeTakeFirstOrThrow();
      expect(await scenarioLedgerRepo.listAttempts(request.id)).toHaveLength(2);
      expect(await scenarioLedgerRepo.listLedgerLines(request.id)).toHaveLength(2);
      expect(await scenarioLedgerRepo.getLedgerTransaction(request.id)).toMatchObject({
        attempt_count: 2,
        total_input_tokens: "21",
        total_output_tokens: "4",
      });
      expect((await scenarioLedgerRepo.getRequest(request.id))?.status).toBe("FAILED");
    } finally {
      await scenarioApp.close();
    }
  });

  it("已完成 Attempt 缺少 usage/ledger 事实时，PostgreSQL 终态栅栏 fail-closed", async () => {
    const fixture = await seedIndependentPipelineEnterprise("missing-attempt-fact");
    const scenarioLedgerRepo = new GatewayLedgerRepository(db);
    const principalKey = await db.selectFrom("principal_key").select("id")
      .where("enterprise_id", "=", fixture.enterpriseId).executeTakeFirstOrThrow();
    const requestId = randomUUID();
    await scenarioLedgerRepo.claimRequest({
      id: requestId,
      enterprise_id: fixture.enterpriseId,
      principal_id: fixture.employeeId,
      principal_key_id: principalKey.id,
      protocol: "chat",
      unified_model: fixture.alias,
      unified_model_id: fixture.modelId,
    });
    const attempt = await scenarioLedgerRepo.createAttempt({
      ai_request_id: requestId,
      enterprise_id: fixture.enterpriseId,
      attempt_no: 1,
      provider_resource_id: fixture.resourceId,
      upstream_model: fixture.upstreamModel,
    });
    await scenarioLedgerRepo.updateAttemptResult(attempt.id, {
      http_status: 200,
      response_committed: true,
      finished_at: new Date(),
    });
    await expect(scenarioLedgerRepo.finalizeLedgerSettlementIfAbsent({
      ai_request_id: requestId,
      enterprise_id: fixture.enterpriseId,
      principal_id: fixture.employeeId,
      total_input_tokens: 0n,
      total_output_tokens: 0n,
      total_cache_tokens: 0n,
      total_reasoning_tokens: 0n,
      total_deducted_quota: 0n,
      total_api_cost: "0.00000000",
      usage_quality: "UNKNOWN",
      attempt_count: 1,
      request_status: "SUCCEEDED",
    })).rejects.toThrowError(new GatewayLedgerSettlementConflictError(
      "settlement_attempt_fact_missing",
    ));
    expect((await scenarioLedgerRepo.getRequest(requestId))?.status).toBe("IN_PROGRESS");
    expect(await scenarioLedgerRepo.getLedgerTransaction(requestId)).toBeUndefined();
  });

  it("CODING_PLAN 计费规则在精确边界过期，目录隐藏且 reserve 后、上游前撤销预占", async () => {
    const fixture = await seedIndependentPipelineEnterprise("coding-billing-expiry", {
      mode: "CODING_PLAN",
    });
    const boundary = new Date();
    await db.updateTable("billing_rule").set({ effective_to: boundary })
      .where("enterprise_id", "=", fixture.enterpriseId).execute();
    let upstreamCalls = 0;
    const scenarioLedgerRepo = new GatewayLedgerRepository(db);
    const scenarioApp = buildGateway(db, pepper, createRealPipeline({
      db,
      ledgerRepo: scenarioLedgerRepo,
      poolRepo: new ResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      maxAttempts: 1,
      listCandidates: async () => [{
        resourceId: fixture.resourceId,
        providerCode: "deepseek",
        upstreamModel: fixture.upstreamModel,
        priority: 1,
        weight: 100,
        mode: "CODING_PLAN",
        status: "ACTIVE",
        probe: false,
        principalId: fixture.employeeId,
        providerId: fixture.providerId,
        unifiedModelId: fixture.modelId,
      }],
      caller: async () => {
        upstreamCalls += 1;
        throw new Error("expired billing rule must block before upstream");
      },
    }));
    await scenarioApp.ready();
    try {
      const headers = { authorization: `Bearer ${fixture.validKey}` };
      expect((await scenarioApp.inject({ method: "GET", url: "/v1/models", headers }))
        .json()).toEqual({ object: "list", data: [] });
      const response = await scenarioApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...headers, "content-type": "application/json" },
        payload: {
          model: fixture.alias,
          messages: [{ role: "user", content: "expired coding billing" }],
        },
      });
      expect(response.statusCode).toBe(403);
      expect(upstreamCalls).toBe(0);
      expect((await db.selectFrom("quota_counter").select("used_value")
        .where("grant_id", "=", fixture.grantId).executeTakeFirstOrThrow()).used_value)
        .toBe("0");
      expect(await new QuotaGateRepository(db).activeConcurrency(fixture.resourceId)).toBe(0);
    } finally {
      await scenarioApp.close();
    }
  });

  it("上游在途停用计费规则时仍按 Adapter 前冻结版本结算", async () => {
    const fixture = await seedIndependentPipelineEnterprise("billing-snapshot");
    const frozenRule = await db.selectFrom("billing_rule").select(["id", "rule_version"])
      .where("enterprise_id", "=", fixture.enterpriseId).executeTakeFirstOrThrow();
    const scenarioLedgerRepo = new GatewayLedgerRepository(db);
    const scenarioApp = buildGateway(db, pepper, createRealPipeline({
      db,
      ledgerRepo: scenarioLedgerRepo,
      poolRepo: new ResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      maxAttempts: 1,
      listCandidates: async () => [{
        resourceId: fixture.resourceId,
        providerCode: "deepseek",
        upstreamModel: fixture.upstreamModel,
        priority: 1,
        weight: 100,
        mode: "API",
        status: "ACTIVE",
        probe: false,
        principalId: fixture.employeeId,
        providerId: fixture.providerId,
        unifiedModelId: fixture.modelId,
      }],
      caller: async () => {
        await db.updateTable("billing_rule").set({ enabled: false })
          .where("id", "=", frozenRule.id).execute();
        return {
          status: 200,
          committed: true,
          usage: { input: 100, output: 50, cache: 20, quality: "PROVIDER_REPORTED" },
          responseText: "ok",
          cancelled: false,
        };
      },
    }));
    await scenarioApp.ready();
    try {
      const response = await scenarioApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${fixture.validKey}`,
          "content-type": "application/json",
        },
        payload: { model: fixture.alias, messages: [{ role: "user", content: "snapshot" }] },
      });
      expect(response.statusCode).toBe(200);
      const requestId = String(response.headers["x-request-id"]);
      const line = (await scenarioLedgerRepo.listLedgerLines(requestId))[0];
      expect(line).toMatchObject({
        billing_rule_id: frozenRule.id,
        rule_version: frozenRule.rule_version,
        api_cost: "0.00038000",
      });
      expect((await scenarioLedgerRepo.getRequest(requestId))?.status).toBe("SUCCEEDED");
    } finally {
      await scenarioApp.close();
    }
  });

  it("流已提交后中断且最终 usage 为零，仍冻结 ESTIMATED 零用量证据并可下钻", async () => {
    const fixture = await seedIndependentPipelineEnterprise("stream-zero-usage");
    const scenarioLedgerRepo = new GatewayLedgerRepository(db);
    let upstreamCalls = 0;
    const pipeline = createRealPipeline({
      db,
      ledgerRepo: scenarioLedgerRepo,
      caller: async (_resource, adapterRequest) => {
        upstreamCalls += 1;
        await adapterRequest.onStreamChunk?.({
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "partial-output" },
            finish_reason: null,
          }],
        });
        return {
          status: 0,
          committed: true,
          usage: { input: 0, output: 0, cache: 0, quality: "ESTIMATED" },
          error: "stream_interrupted_after_commit",
          cancelled: false,
        };
      },
      poolRepo: new ResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      maxAttempts: 1,
      listCandidates: async () => [{
        resourceId: fixture.resourceId,
        providerCode: "deepseek",
        upstreamModel: fixture.upstreamModel,
        priority: 1,
        weight: 100,
        mode: fixture.mode,
        status: "ACTIVE",
        probe: false,
        principalId: fixture.employeeId,
        providerId: fixture.providerId,
        unifiedModelId: fixture.modelId,
      }],
    });
    const scenarioApp = buildGateway(db, pepper, pipeline);
    await scenarioApp.ready();
    try {
      const response = await scenarioApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${fixture.validKey}`,
          "content-type": "application/json",
        },
        payload: {
          model: fixture.alias,
          stream: true,
          messages: [{ role: "user", content: "POOL-043 interrupted zero usage stream" }],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("partial-output");
      expect(response.body).toContain("upstream_stream_interrupted");
      expect(upstreamCalls).toBe(1);

      const requestId = response.headers["x-ai-request-id"] as string;
      expect(requestId).toBeTruthy();
      const attempts = await scenarioLedgerRepo.listAttempts(requestId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        http_status: 0,
        response_committed: true,
        error_classification: "STREAM_INTERRUPTED_AFTER_COMMIT",
        error_code: "stream_interrupted_after_commit",
      });
      expect(attempts[0]?.finished_at).toBeInstanceOf(Date);

      const usageEvents = await scenarioLedgerRepo.listUsageEvents(requestId);
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({
        input_tokens: "0",
        output_tokens: "0",
        cache_tokens: "0",
        reasoning_tokens: "0",
        usage_quality: "ESTIMATED",
      });
      const lines = await scenarioLedgerRepo.listLedgerLines(requestId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        raw_input_tokens: "0",
        raw_output_tokens: "0",
        raw_cache_tokens: "0",
        raw_reasoning_tokens: "0",
        api_cost: null,
        billing_rule_id: null,
        rule_version: null,
        usage_quality: "ESTIMATED",
      });
      expect(await scenarioLedgerRepo.getLedgerTransaction(requestId)).toMatchObject({
        attempt_count: 1,
        total_input_tokens: "0",
        total_output_tokens: "0",
        total_cache_tokens: "0",
        total_reasoning_tokens: "0",
        total_deducted_quota: "0",
        total_api_cost: "0.00000000",
        usage_quality: "ESTIMATED",
      });
      expect(await scenarioLedgerRepo.getRequest(requestId)).toMatchObject({
        status: "FAILED",
        error_classification: "STREAM_INTERRUPTED_AFTER_COMMIT",
        error_code: "stream_interrupted_after_commit",
      });

      const billRepo = new OperatingBillRepository(db);
      expectUnknownApiCostBill(
        await billRepo.getBill(fixture.enterpriseId, currentShanghaiMonth()),
        fixture.resourceId,
        fixture.employeeId,
        "DRAFT",
      );
      await expect(billRepo.closeMonth({
        enterpriseId: fixture.enterpriseId,
        adminId: fixture.adminId,
        month: currentShanghaiMonth(),
        allowIncomplete: true,
        note: "POOL-043 已提交中断零用量证据冻结",
      })).resolves.toMatchObject({ status: "CLOSED" });
      expectUnknownApiCostBill(
        await billRepo.getBill(fixture.enterpriseId, currentShanghaiMonth()),
        fixture.resourceId,
        fixture.employeeId,
        "CLOSED",
      );

      const accountRepo = new OperatingBillAccountRepository(db);
      const accounts = await accountRepo.listAccounts(
        fixture.enterpriseId, currentShanghaiMonth(), "EMPLOYEE",
      );
      expect(accounts.rows.find((row) => row.subjectId === fixture.employeeId)?.totals)
        .toMatchObject({
          totalTokens: "0",
          apiCost: null,
          requestCount: 1,
          usageQuality: "ESTIMATED",
        });
      const detail = await accountRepo.getEmployeeDetail(
        fixture.enterpriseId, currentShanghaiMonth(), fixture.employeeId,
      );
      expect(detail.providers[0]?.models[0]).toMatchObject({
        unifiedModelId: fixture.modelId,
        currentAlias: fixture.alias,
        totals: { totalTokens: "0", requestCount: 1, usageQuality: "ESTIMATED" },
      });
      const requests = await accountRepo.listEmployeeModelRequests(
        fixture.enterpriseId,
        currentShanghaiMonth(),
        fixture.employeeId,
        fixture.modelId,
        { limit: 20, offset: 0 },
      );
      expect(requests).toMatchObject({ status: "CLOSED", total: 1 });
      expect(requests.items).toEqual([expect.objectContaining({
        requestId,
        modelAliasAtRequest: fixture.alias,
        currentAlias: fixture.alias,
        tokens: expect.objectContaining({ totalTokens: "0" }),
        costs: expect.objectContaining({ apiCost: null }),
        usageQuality: "ESTIMATED",
        status: "FAILED",
      })]);
    } finally {
      await scenarioApp.close();
    }
  });

  it("前置 UNKNOWN 零用量后 failover 精确成功，以未知费用占位结算且不冒充精确", async () => {
    const fixture = await seedIndependentPipelineEnterprise("unknown-failover");
    const secondUpstreamModel = "deepseek-pool043-unknown-failover-second";
    const secondResource = await db.insertInto("provider_resource").values({
      enterprise_id: fixture.enterpriseId,
      provider_id: fixture.providerId,
      name: "POOL-043 UNKNOWN failover 第二资源",
      mode: "API",
      credential_type: "API_KEY",
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: fixture.enterpriseId,
      unified_model_id: fixture.modelId,
      provider_resource_id: secondResource.id,
      upstream_model: secondUpstreamModel,
      priority: 2,
      weight: 100,
    }).execute();
    await db.insertInto("billing_rule").values({
      enterprise_id: fixture.enterpriseId,
      provider_resource_id: secondResource.id,
      upstream_model: secondUpstreamModel,
      rule_type: "API_PRICE",
      rule_version: "pool043-unknown-second",
      effective_from: new Date(0),
      cache_hit_price: "0.000001",
      cache_miss_price: "0.000002",
      output_price: "0.000004",
      priority: 10,
    }).execute();

    const scenarioLedgerRepo = new GatewayLedgerRepository(db);
    let upstreamCalls = 0;
    const pipeline = createRealPipeline({
      db,
      ledgerRepo: scenarioLedgerRepo,
      caller: async (_resource, _adapterRequest, attemptNo) => {
        upstreamCalls += 1;
        return attemptNo === 1
          ? {
              status: 0,
              committed: false,
              usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
              error: "transport_error",
            }
          : {
              status: 200,
              committed: true,
              usage: { input: 30, output: 5, cache: 3, quality: "PROVIDER_REPORTED" },
            };
      },
      poolRepo: new ResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      maxAttempts: 2,
      listCandidates: async () => [
        {
          resourceId: fixture.resourceId,
          providerCode: "deepseek",
          upstreamModel: fixture.upstreamModel,
          priority: 1,
          weight: 100,
          mode: fixture.mode,
          status: "ACTIVE",
          probe: false,
          principalId: fixture.employeeId,
          providerId: fixture.providerId,
          unifiedModelId: fixture.modelId,
        },
        {
          resourceId: secondResource.id,
          providerCode: "deepseek",
          upstreamModel: secondUpstreamModel,
          priority: 2,
          weight: 100,
          mode: "API",
          status: "ACTIVE",
          probe: false,
          principalId: fixture.employeeId,
          providerId: fixture.providerId,
          unifiedModelId: fixture.modelId,
        },
      ],
    });
    const scenarioApp = buildGateway(db, pepper, pipeline);
    await scenarioApp.ready();
    try {
      const response = await scenarioApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${fixture.validKey}`,
          "content-type": "application/json",
        },
        payload: {
          model: fixture.alias,
          messages: [{ role: "user", content: "POOL-043 unknown then exact failover" }],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(upstreamCalls).toBe(2);
      const requestId = response.headers["x-ai-request-id"] as string;
      expect(requestId).toBeTruthy();

      const attempts = await scenarioLedgerRepo.listAttempts(requestId);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        response_committed: false,
        error_classification: "TRANSPORT_ERROR",
        error_code: "transport_error",
        switch_reason: "TRANSPORT_ERROR",
      });
      expect(attempts[1]).toMatchObject({
        response_committed: true,
        http_status: 200,
        error_classification: null,
      });
      expect(await scenarioLedgerRepo.listUsageEvents(requestId)).toHaveLength(2);
      const lines = await scenarioLedgerRepo.listLedgerLines(requestId);
      expect(lines).toHaveLength(2);
      expect(lines.find((line) => line.usage_quality === "UNKNOWN")).toMatchObject({
        raw_input_tokens: "0",
        raw_output_tokens: "0",
        raw_cache_tokens: "0",
        api_cost: null,
        billing_rule_id: null,
        rule_version: null,
      });
      expect(lines.find((line) => line.usage_quality === "PROVIDER_REPORTED")).toMatchObject({
        provider_resource_id: secondResource.id,
        raw_input_tokens: "30",
        raw_output_tokens: "5",
        raw_cache_tokens: "3",
        api_cost: "0.00007700",
        rule_version: "pool043-unknown-second",
      });
      expect(await scenarioLedgerRepo.getLedgerTransaction(requestId)).toMatchObject({
        attempt_count: 2,
        total_input_tokens: "30",
        total_output_tokens: "5",
        total_cache_tokens: "3",
        total_reasoning_tokens: "0",
        total_api_cost: "0.00000000",
        usage_quality: "MIXED:PROVIDER_REPORTED+UNKNOWN",
      });
      expect(await scenarioLedgerRepo.getRequest(requestId)).toMatchObject({
        status: "SUCCEEDED",
        error_classification: null,
        error_code: null,
      });

      const accountRepo = new OperatingBillAccountRepository(db);
      const accounts = await accountRepo.listAccounts(
        fixture.enterpriseId, currentShanghaiMonth(), "EMPLOYEE",
      );
      expect(accounts.rows.find((row) => row.subjectId === fixture.employeeId)?.totals)
        .toMatchObject({
          totalTokens: "35",
          apiCost: null,
          requestCount: 1,
          usageQuality: "MIXED",
        });
      const requests = await accountRepo.listEmployeeModelRequests(
        fixture.enterpriseId,
        currentShanghaiMonth(),
        fixture.employeeId,
        fixture.modelId,
        { limit: 20, offset: 0 },
      );
      expect(requests.items).toEqual([expect.objectContaining({
        requestId,
        tokens: expect.objectContaining({ totalTokens: "35" }),
        costs: expect.objectContaining({ apiCost: null }),
        usageQuality: "MIXED",
        status: "SUCCEEDED",
      })]);

      const billRepo = new OperatingBillRepository(db);
      expectUnknownApiCostBill(
        await billRepo.getBill(fixture.enterpriseId, currentShanghaiMonth()),
        fixture.resourceId,
        fixture.employeeId,
        "DRAFT",
      );
      await expect(billRepo.closeMonth({
        enterpriseId: fixture.enterpriseId,
        adminId: fixture.adminId,
        month: currentShanghaiMonth(),
        allowIncomplete: true,
        note: "POOL-043 UNKNOWN 前置 Attempt 费用不完整证据冻结",
      })).resolves.toMatchObject({ status: "CLOSED" });
      expectUnknownApiCostBill(
        await billRepo.getBill(fixture.enterpriseId, currentShanghaiMonth()),
        fixture.resourceId,
        fixture.employeeId,
        "CLOSED",
      );
      const frozenAccounts = await accountRepo.listAccounts(
        fixture.enterpriseId, currentShanghaiMonth(), "EMPLOYEE",
      );
      expect(frozenAccounts.rows.find((row) => row.subjectId === fixture.employeeId)?.totals)
        .toMatchObject({ apiCost: null, requestCount: 1, usageQuality: "MIXED" });
      const frozen = await accountRepo.listEmployeeModelRequests(
        fixture.enterpriseId,
        currentShanghaiMonth(),
        fixture.employeeId,
        fixture.modelId,
        { limit: 20, offset: 0 },
      );
      expect(frozen).toMatchObject({ status: "CLOSED", total: 1 });
      expect(frozen.items[0]).toMatchObject({
        requestId,
        costs: { apiCost: null },
        usageQuality: "MIXED",
      });
    } finally {
      await scenarioApp.close();
    }
  });

  it("当前账期已 CLOSED 时 Attempt 在上游前失败并释放额度、租约与半开探针", async () => {
    const fixture = await seedIndependentPipelineEnterprise("closed-probe", {
      mode: "CODING_PLAN",
      halfOpenProbe: true,
    });
    await expect(new OperatingBillRepository(db).closeMonth({
      enterpriseId: fixture.enterpriseId,
      adminId: fixture.adminId,
      month: currentShanghaiMonth(),
      allowIncomplete: true,
      note: "POOL-043 先关账后请求",
    })).resolves.toMatchObject({ status: "CLOSED" });

    const scenarioLedgerRepo = new GatewayLedgerRepository(db);
    let upstreamCalls = 0;
    const pipeline = createRealPipeline({
      db,
      ledgerRepo: scenarioLedgerRepo,
      caller: async () => {
        upstreamCalls += 1;
        return {
          status: 200,
          committed: true,
          usage: { input: 10, output: 2, cache: 1, quality: "PROVIDER_REPORTED" },
        };
      },
      poolRepo: new ResourcePoolRepository(db),
      quotaRepo: new QuotaGateRepository(db),
      maxAttempts: 1,
      listCandidates: async () => [{
        resourceId: fixture.resourceId,
        providerCode: "deepseek",
        upstreamModel: fixture.upstreamModel,
        priority: 1,
        weight: 100,
        mode: fixture.mode,
        status: "UNAVAILABLE",
        probe: true,
        principalId: fixture.employeeId,
        providerId: fixture.providerId,
        unifiedModelId: fixture.modelId,
        concurrencyLimit: 1,
      }],
    });
    const scenarioApp = buildGateway(db, pepper, pipeline);
    await scenarioApp.ready();
    try {
      const response = await scenarioApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${fixture.validKey}`,
          "content-type": "application/json",
        },
        payload: {
          model: fixture.alias,
          messages: [{ role: "user", content: "POOL-043 closed period" }],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "operating_bill_closed", retryable: false },
      });
      expect(upstreamCalls).toBe(0);

      const request = await db.selectFrom("ai_request").selectAll()
        .where("enterprise_id", "=", fixture.enterpriseId)
        .orderBy("started_at", "desc").executeTakeFirstOrThrow();
      expect(request).toMatchObject({
        status: "FAILED",
        error_classification: "OPERATING_BILL_CLOSED",
        error_code: "operating_bill_closed",
      });
      expect(await scenarioLedgerRepo.listAttempts(request.id)).toHaveLength(0);
      expect(await scenarioLedgerRepo.listUsageEvents(request.id)).toHaveLength(0);
      expect(await scenarioLedgerRepo.listLedgerLines(request.id)).toHaveLength(0);
      expect(await scenarioLedgerRepo.getLedgerTransaction(request.id)).toBeUndefined();

      const counter = await db.selectFrom("quota_counter").selectAll()
        .where("grant_id", "=", fixture.grantId).executeTakeFirstOrThrow();
      expect(counter.used_value).toBe("0");
      const leases = await db.selectFrom("concurrency_lease").selectAll()
        .where("enterprise_id", "=", fixture.enterpriseId).execute();
      expect(leases).toHaveLength(1);
      expect(leases[0]?.released_at).toBeInstanceOf(Date);
      const resource = await db.selectFrom("provider_resource").selectAll()
        .where("id", "=", fixture.resourceId).executeTakeFirstOrThrow();
      expect(resource.last_probe_at).toBeNull();
    } finally {
      await scenarioApp.close();
    }
  });
});
