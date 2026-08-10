import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  createKysely,
  GatewayLedgerRepository,
  migrateToLatest,
  OperatingBillAccountRepository,
  OperatingBillClosedError,
  OperatingBillConcurrentModificationError,
  OperatingBillRepository,
  type CreateUsageLedgerLineInput,
  type LedgerLineInput,
} from "../index.js";
import {
  acquireOperatingBillMonthWriteBarrier,
  hasPendingOperatingBillSettlement,
} from "../repositories/operating-bill-write-barrier.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

const enterpriseId = randomUUID();
const adminId = randomUUID();
const employeeId = randomUUID();
const projectId = randomUUID();
const keyId = randomUUID();
const modelId = randomUUID();
const requestId = randomUUID();
const month = "2027-02";

async function waitForCloseRowLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await sql<{ waiting: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND state = 'active' AND wait_event_type = 'Lock'
           AND lower(query) LIKE '%operating_bill_period%'
           AND lower(query) LIKE '%for update%'
      ) AS waiting
    `.execute(db);
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("close_month_row_lock_not_observed");
}

async function waitForBlockedLedgerInsert(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await sql<{ waiting: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND state = 'active' AND wait_event_type = 'Lock'
           AND lower(query) LIKE '%insert into "ledger_line"%'
      ) AS waiting
    `.execute(db);
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("gateway_ledger_insert_lock_not_observed");
}

async function waitForCloseAdvisoryLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await sql<{ waiting: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND state = 'active' AND wait_event_type = 'Lock'
           AND lower(query) LIKE '%pg_advisory_xact_lock%'
      ) AS waiting
    `.execute(db);
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("close_month_advisory_lock_not_observed");
}

function currentShanghaiMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
}

async function seedSettlementFixture(
  label: string,
  options: { status?: "IN_PROGRESS" | "SUCCEEDED"; createUsage?: boolean } = {},
): Promise<{
  enterpriseId: string;
  adminId: string;
  employeeId: string;
  requestId: string;
  attemptId: string;
  resourceId: string;
  usageId: string;
  line: LedgerLineInput;
  atomic: CreateUsageLedgerLineInput;
}> {
  const fixtureEnterpriseId = randomUUID();
  const fixtureAdminId = randomUUID();
  const fixtureEmployeeId = randomUUID();
  const fixtureModelId = randomUUID();
  const fixtureKeyId = randomUUID();
  const fixtureRequestId = randomUUID();
  const usedAt = new Date();
  await db.insertInto("enterprise").values({
    id: fixtureEnterpriseId, name: `结算屏障企业-${label}`,
  }).execute();
  await db.insertInto("admin_user").values({
    id: fixtureAdminId, enterprise_id: fixtureEnterpriseId,
    username: `pool043-${label}-${fixtureAdminId.slice(0, 8)}`,
    display_name: `结算屏障管理员-${label}`, password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: fixtureEmployeeId, enterprise_id: fixtureEnterpriseId,
    type: "EMPLOYEE", name: `结算员工-${label}`,
  }).execute();
  await db.insertInto("unified_model").values({
    id: fixtureModelId, enterprise_id: fixtureEnterpriseId,
    alias: `ql-pool043-${label}`, display_name: `POOL-043 ${label}`,
  }).execute();
  await db.insertInto("principal_key").values({
    id: fixtureKeyId, enterprise_id: fixtureEnterpriseId, principal_id: fixtureEmployeeId,
    key_prefix: `ql_${label}`, key_digest: randomUUID(),
    allowed_model_ids: JSON.stringify([fixtureModelId]) as unknown as string[],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: fixtureEnterpriseId, code: `pool043-${label}`,
    name: `屏障厂商-${label}`, adapter_type: "openai",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: fixtureEnterpriseId, provider_id: provider.id,
    name: `屏障资源-${label}`, mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ai_request").values({
    id: fixtureRequestId, enterprise_id: fixtureEnterpriseId,
    principal_id: fixtureEmployeeId, principal_key_id: fixtureKeyId,
    protocol: "chat", unified_model: `ql-pool043-${label}`,
    unified_model_id: fixtureModelId, status: options.status ?? "SUCCEEDED",
    started_at: usedAt, finished_at: usedAt,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: fixtureRequestId, enterprise_id: fixtureEnterpriseId, attempt_no: 1,
    provider_resource_id: resource.id, upstream_model: `upstream-${label}`,
    finished_at: usedAt, http_status: 200, response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usageId = randomUUID();
  const usageInput = {
    ai_request_id: fixtureRequestId, enterprise_id: fixtureEnterpriseId,
    upstream_attempt_id: attempt.id, provider_resource_id: resource.id,
    input_tokens: 40n, output_tokens: 5n, cache_tokens: 3n, reasoning_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: `pool043-${label}-${fixtureRequestId}`,
  };
  if (options.createUsage !== false) {
    await db.insertInto("usage_event").values({
      id: usageId, ...usageInput, created_at: usedAt,
    }).execute();
  }
  const ledgerLine = {
    ai_request_id: fixtureRequestId, enterprise_id: fixtureEnterpriseId,
    upstream_attempt_id: attempt.id, provider_resource_id: resource.id,
    principal_id: fixtureEmployeeId, resource_mode: "API",
    raw_input_tokens: 40n, raw_output_tokens: 5n, raw_cache_tokens: 3n,
    raw_reasoning_tokens: 0n, deducted_quota: null, api_cost: "0.4",
    usage_quality: "PROVIDER_REPORTED",
  };
  return {
    enterpriseId: fixtureEnterpriseId,
    adminId: fixtureAdminId,
    employeeId: fixtureEmployeeId,
    requestId: fixtureRequestId,
    attemptId: attempt.id,
    resourceId: resource.id,
    usageId,
    line: { ...ledgerLine, usage_event_id: usageId },
    atomic: { usage: usageInput, ledger_line: ledgerLine },
  };
}

type SettlementFixture = Awaited<ReturnType<typeof seedSettlementFixture>>;
type FinalizeInput = Parameters<GatewayLedgerRepository["finalizeLedgerSettlementIfAbsent"]>[0];
type TerminalRejectedInput = Parameters<
  GatewayLedgerRepository["finalizeRejectedAttemptSettlementIfAbsent"]
>[0];

function finalizationFor(
  fixture: SettlementFixture,
  overrides: Partial<FinalizeInput> = {},
): FinalizeInput {
  return {
    ai_request_id: fixture.requestId,
    enterprise_id: fixture.enterpriseId,
    principal_id: fixture.employeeId,
    total_input_tokens: 40n,
    total_output_tokens: 5n,
    total_cache_tokens: 3n,
    total_reasoning_tokens: 0n,
    total_deducted_quota: 0n,
    total_api_cost: "0.4",
    usage_quality: "PROVIDER_REPORTED",
    attempt_count: 1,
    request_status: "SUCCEEDED",
    ...overrides,
  };
}

function atomicForAttempt(
  fixture: SettlementFixture,
  attemptId: string,
  dedupSuffix: string,
): CreateUsageLedgerLineInput {
  return {
    usage: {
      ...fixture.atomic.usage,
      upstream_attempt_id: attemptId,
      dedup_key: `${fixture.atomic.usage.dedup_key}-${dedupSuffix}`,
    },
    ledger_line: { ...fixture.atomic.ledger_line, upstream_attempt_id: attemptId },
  };
}

async function removeSeededAttempt(fixture: SettlementFixture): Promise<void> {
  await db.deleteFrom("upstream_attempt").where("id", "=", fixture.attemptId).execute();
}

async function seedNonterminalAccounting(
  label: string,
  options: { quota?: bigint; reserved?: bigint } = {},
) {
  const fixture = await seedSettlementFixture(
    label, { status: "IN_PROGRESS", createUsage: false },
  );
  await db.updateTable("upstream_attempt").set({
    finished_at: null,
    http_status: null,
    response_committed: false,
    error_classification: null,
    error_code: null,
    switch_reason: null,
  }).where("id", "=", fixture.attemptId).execute();
  const reserved = options.reserved ?? 37n;
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: fixture.enterpriseId,
    principal_id: fixture.employeeId,
    provider: `acct-${label}`,
    model_alias: `ql-pool043-${label}`,
    quota_value: options.quota ?? 1_000n,
    allow_overage: true,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({
    grant_id: grant.id,
    used_value: reserved,
  }).execute();
  const lease = await db.insertInto("concurrency_lease").values({
    enterprise_id: fixture.enterpriseId,
    provider_resource_id: fixture.resourceId,
    ai_request_id: fixture.requestId,
    expires_at: new Date(Date.now() + 60_000),
  }).returning("id").executeTakeFirstOrThrow();
  const input: Parameters<GatewayLedgerRepository["persistAttemptUsageAccountingIfAbsent"]>[0] = {
    usage: {
      ...fixture.atomic.usage,
      input_tokens: 0n,
      output_tokens: 0n,
      cache_tokens: 0n,
      reasoning_tokens: 0n,
      usage_quality: "UNKNOWN",
    },
    ledger_line: {
      ...fixture.atomic.ledger_line,
      raw_input_tokens: 0n,
      raw_output_tokens: 0n,
      raw_cache_tokens: 0n,
      raw_reasoning_tokens: 0n,
      deducted_quota: null,
      api_cost: "0.00000000",
      usage_quality: "UNKNOWN",
      billing_rule_id: null,
      rule_version: null,
      multiplier: null,
      billing_rule_snapshot: null,
    },
    attempt_result: {
      http_status: 503,
      response_committed: false,
      finished_at: new Date(),
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: "candidate_admission_revoked",
      switch_reason: null,
    },
    quota_settlements: [{
      grant_id: grant.id,
      reserved_estimate: reserved,
      actual_deducted: 0n,
    }],
    release_lease_ids: [lease.id],
  };
  return { fixture, grantId: grant.id, leaseId: lease.id, reserved, input };
}

async function seedTerminalRejectedAccounting(label: string) {
  const fixture = await seedSettlementFixture(
    label, { status: "IN_PROGRESS", createUsage: true },
  );
  await insertLegacyLineDirectly(fixture);
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: fixture.requestId,
    enterprise_id: fixture.enterpriseId,
    attempt_no: 2,
    provider_resource_id: fixture.resourceId,
    upstream_model: `rejected-${label}`,
    response_committed: false,
  }).returning("id").executeTakeFirstOrThrow();
  const reserved = 37n;
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: fixture.enterpriseId,
    principal_id: fixture.employeeId,
    provider: `terminal-${label}`,
    model_alias: `ql-pool043-${label}`,
    quota_value: 1_000n,
    allow_overage: true,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({
    grant_id: grant.id,
    used_value: reserved,
  }).execute();
  const lease = await db.insertInto("concurrency_lease").values({
    enterprise_id: fixture.enterpriseId,
    provider_resource_id: fixture.resourceId,
    ai_request_id: fixture.requestId,
    expires_at: new Date(Date.now() + 60_000),
  }).returning("id").executeTakeFirstOrThrow();
  const input: TerminalRejectedInput = {
    usage: {
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      upstream_attempt_id: attempt.id,
      provider_resource_id: fixture.resourceId,
      input_tokens: 0n,
      output_tokens: 0n,
      cache_tokens: 0n,
      reasoning_tokens: 0n,
      usage_quality: "UNKNOWN",
      dedup_key: `${fixture.requestId}:attempt2`,
    },
    ledger_line: {
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      upstream_attempt_id: attempt.id,
      provider_resource_id: fixture.resourceId,
      principal_id: fixture.employeeId,
      resource_mode: "API",
      raw_input_tokens: 0n,
      raw_output_tokens: 0n,
      raw_cache_tokens: 0n,
      raw_reasoning_tokens: 0n,
      deducted_quota: null,
      api_cost: "0.00000000",
      usage_quality: "UNKNOWN",
      billing_rule_id: null,
      rule_version: null,
      multiplier: null,
      billing_rule_snapshot: null,
    },
    attempt_result: {
      http_status: 503,
      response_committed: false,
      finished_at: new Date(),
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: "candidate_admission_revoked",
      switch_reason: null,
    },
    error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
    error_code: "candidate_admission_revoked",
    quota_settlements: [{
      grant_id: grant.id,
      reserved_estimate: reserved,
      actual_deducted: 0n,
    }],
    release_lease_ids: [lease.id],
    overage: false,
  };
  return {
    fixture,
    currentAttemptId: attempt.id,
    grantId: grant.id,
    leaseId: lease.id,
    reserved,
    input,
  };
}

type TerminalRejectedScenario = Awaited<ReturnType<typeof seedTerminalRejectedAccounting>>;

async function expectTerminalSettlementRolledBack(
  scenario: TerminalRejectedScenario,
): Promise<void> {
  const repository = new GatewayLedgerRepository(db);
  expect(await repository.getRequest(scenario.fixture.requestId)).toMatchObject({
    status: "IN_PROGRESS", error_classification: null, error_code: null,
  });
  expect(await repository.getLedgerTransaction(scenario.fixture.requestId)).toBeUndefined();
  expect(await repository.listUsageEvents(scenario.fixture.requestId)).toHaveLength(1);
  expect(await repository.listLedgerLines(scenario.fixture.requestId)).toHaveLength(1);
  expect(await db.selectFrom("upstream_attempt").select(["finished_at", "error_code"])
    .where("id", "=", scenario.currentAttemptId).executeTakeFirstOrThrow())
    .toMatchObject({ finished_at: null, error_code: null });
  expect(BigInt((await db.selectFrom("quota_counter").select("used_value")
    .where("grant_id", "=", scenario.grantId).executeTakeFirstOrThrow()).used_value))
    .toBe(scenario.reserved);
  expect((await db.selectFrom("concurrency_lease").select("released_at")
    .where("id", "=", scenario.leaseId).executeTakeFirstOrThrow()).released_at).toBeNull();
}

async function insertLegacyLineDirectly(fixture: SettlementFixture): Promise<void> {
  await db.insertInto("ledger_line").values(fixture.line).execute();
}

async function insertLegacyTransactionDirectly(
  fixture: SettlementFixture,
  overrides: Partial<FinalizeInput> = {},
): Promise<void> {
  const input = finalizationFor(fixture, overrides);
  await db.insertInto("ledger_transaction").values({
    ai_request_id: input.ai_request_id,
    enterprise_id: input.enterprise_id,
    principal_id: input.principal_id,
    total_input_tokens: input.total_input_tokens,
    total_output_tokens: input.total_output_tokens,
    total_cache_tokens: input.total_cache_tokens,
    total_reasoning_tokens: input.total_reasoning_tokens ?? 0n,
    total_deducted_quota: input.total_deducted_quota,
    total_api_cost: input.total_api_cost,
    overage: input.overage ?? false,
    usage_quality: input.usage_quality,
    attempt_count: input.attempt_count,
    status: "SETTLED",
  }).execute();
}

async function expectCloseRejected(
  fixture: SettlementFixture,
  note: string,
): Promise<void> {
  await expect(new OperatingBillRepository(db).closeMonth({
    enterpriseId: fixture.enterpriseId,
    adminId: fixture.adminId,
    month: currentShanghaiMonth(),
    allowIncomplete: true,
    note,
  })).rejects.toBeInstanceOf(OperatingBillConcurrentModificationError);
}

beforeAll(async () => {
  pg = process.env.POOL043_CONCURRENCY_DATABASE_URL
    ? { connectionString: process.env.POOL043_CONCURRENCY_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer("pool043_concurrency");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "并发结账企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "pool043-concurrency",
    display_name: "并发管理员", password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values([
    { id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "于滔" },
    { id: projectId, enterprise_id: enterpriseId, type: "PROJECT", name: "并发项目" },
  ]).execute();
  await db.insertInto("unified_model").values({
    id: modelId, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-flash",
    display_name: "DeepSeek V4 Flash",
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: employeeId,
    key_prefix: "ql_concurrency", key_digest: randomUUID(),
    allowed_model_ids: JSON.stringify([modelId]) as unknown as string[],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "openai",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "DeepSeek API",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  const usedAt = new Date("2027-02-10T04:00:00Z");
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterpriseId, principal_id: employeeId,
    principal_key_id: keyId, protocol: "chat", unified_model: "ql-deepseek-v4-flash",
    unified_model_id: modelId, status: "SUCCEEDED", started_at: usedAt, finished_at: usedAt,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
    provider_resource_id: resource.id, upstream_model: "deepseek-upstream",
    finished_at: usedAt, http_status: 200, response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
    provider_resource_id: resource.id, input_tokens: 30n, output_tokens: 3n,
    cache_tokens: 2n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: `pool043-concurrency-${requestId}`, created_at: usedAt,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
    upstream_attempt_id: attempt.id, provider_resource_id: resource.id,
    principal_id: employeeId, resource_mode: "API", raw_input_tokens: 30n,
    raw_output_tokens: 3n, raw_cache_tokens: 2n, raw_reasoning_tokens: 0n,
    deducted_quota: null, api_cost: "0.3", usage_quality: "PROVIDER_REPORTED",
    created_at: usedAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId, enterprise_id: enterpriseId, principal_id: employeeId,
    total_input_tokens: 30n, total_output_tokens: 3n, total_cache_tokens: 2n,
    total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0.3",
    usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED", created_at: usedAt,
  }).execute();
});

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
});

describe("POOL-043 结账与项目归属并发边界", () => {
  it("观察到真实行锁竞争后重试新快照，冻结结果不丢失已提交归属", async () => {
    const period = await db.insertInto("operating_bill_period").values({
      enterprise_id: enterpriseId, period_month: "2027-02-01", created_by: adminId,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("operating_bill_event").values({
      enterprise_id: enterpriseId, period_id: period.id, action: "CREATED", version: 0,
      reason: null, actor_admin_id: adminId, metadata: { month },
    }).execute();

    let markWriterReady!: () => void;
    let releaseWriter!: () => void;
    const writerReady = new Promise<void>((resolve) => { markWriterReady = resolve; });
    const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = db.transaction().execute(async (trx) => {
      await trx.selectFrom("operating_bill_period").select("id")
        .where("enterprise_id", "=", enterpriseId).where("id", "=", period.id)
        .forUpdate().executeTakeFirstOrThrow();
      await trx.insertInto("operating_bill_request_project_assignment").values({
        enterprise_id: enterpriseId, ai_request_id: requestId,
        project_principal_id: projectId, assigned_by: adminId, reason: "并发归属",
      }).execute();
      markWriterReady();
      await writerRelease;
      await trx.updateTable("operating_bill_period").set({ updated_at: new Date() })
        .where("id", "=", period.id).execute();
    });
    await writerReady;

    const closing = new OperatingBillRepository(db).closeMonth({
      enterpriseId, adminId, month, allowIncomplete: true,
      note: "POOL-043 并发归属冻结证据测试",
    });
    try {
      await waitForCloseRowLock();
      releaseWriter();
      await writer;
      expect(await closing).toMatchObject({ status: "CLOSED", version: 1 });
      const projects = await new OperatingBillAccountRepository(db)
        .listAccounts(enterpriseId, month, "PROJECT");
      expect(projects.rows.find((row) => row.subjectId === projectId)?.totals)
        .toMatchObject({ totalTokens: "33", requestCount: 1 });
      expect(projects.rows.find((row) => row.isUnassigned)).toBeUndefined();
    } finally {
      releaseWriter();
      await Promise.allSettled([writer, closing]);
    }
  });

  it("账期原先不存在时等待 gateway 写入，并拒绝冻结缺 transaction 的半成品", async () => {
    const fixture = await seedSettlementFixture("inflight", { status: "IN_PROGRESS" });
    const fixtureMonth = currentShanghaiMonth();
    expect(await db.selectFrom("operating_bill_period").select("id")
      .where("enterprise_id", "=", fixture.enterpriseId)
      .where("period_month", "=", `${fixtureMonth}-01`).executeTakeFirst()).toBeUndefined();

    let markBlockerReady!: () => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<void>((resolve) => { markBlockerReady = resolve; });
    const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom("usage_event").select("id")
        .where("id", "=", fixture.usageId).forUpdate().executeTakeFirstOrThrow();
      markBlockerReady();
      await blockerRelease;
    });
    await blockerReady;

    const settlement = new GatewayLedgerRepository(db).createLedgerLine(fixture.line);
    let closing: ReturnType<OperatingBillRepository["closeMonth"]> | undefined;
    try {
      await waitForBlockedLedgerInsert();
      closing = new OperatingBillRepository(db).closeMonth({
        enterpriseId: fixture.enterpriseId, adminId: fixture.adminId,
        month: fixtureMonth, allowIncomplete: true,
        note: "POOL-043 在途 gateway 结算冻结证据",
      });
      await waitForCloseAdvisoryLock();
      releaseBlocker();
      await blocker;
      await expect(settlement).resolves.toMatchObject({ raw_input_tokens: "40", api_cost: "0.4" });
      await expect(closing).rejects.toBeInstanceOf(OperatingBillConcurrentModificationError);
      await new GatewayLedgerRepository(db)
        .finalizeLedgerSettlementIfAbsent(finalizationFor(fixture));
      await expect(new OperatingBillRepository(db).closeMonth({
        enterpriseId: fixture.enterpriseId, adminId: fixture.adminId,
        month: fixtureMonth, allowIncomplete: true,
        note: "POOL-043 transaction 补齐后冻结",
      })).resolves.toMatchObject({ status: "CLOSED", version: 1 });
      const employees = await new OperatingBillAccountRepository(db)
        .listAccounts(fixture.enterpriseId, fixtureMonth, "EMPLOYEE");
      expect(employees.rows.find((row) => row.subjectId === fixture.employeeId)?.totals)
        .toMatchObject({ totalTokens: "45", cacheTokens: "3", apiCost: "0.40000000", requestCount: 1 });
    } finally {
      releaseBlocker();
      await Promise.allSettled([blocker, settlement, ...(closing ? [closing] : [])]);
    }
  });

  it("CLOSED 后拒绝同月 usage/ledger 原子写且零新增", async () => {
    const fixture = await seedSettlementFixture(
      "closed", { status: "IN_PROGRESS", createUsage: false },
    );
    const fixtureMonth = currentShanghaiMonth();
    await db.insertInto("operating_bill_period").values({
      enterprise_id: fixture.enterpriseId,
      period_month: `${fixtureMonth}-01`,
      status: "CLOSED",
      current_version: 1,
      created_by: fixture.adminId,
    }).execute();
    const before = await db.selectFrom("ledger_line").select(({ fn }) => fn.countAll().as("count"))
      .where("enterprise_id", "=", fixture.enterpriseId).executeTakeFirstOrThrow();
    await expect(new GatewayLedgerRepository(db).createUsageAndLedgerLineIfAbsent(fixture.atomic))
      .rejects.toBeInstanceOf(OperatingBillClosedError);
    const after = await db.selectFrom("ledger_line").select(({ fn }) => fn.countAll().as("count"))
      .where("enterprise_id", "=", fixture.enterpriseId).executeTakeFirstOrThrow();
    expect(after.count).toBe(before.count);
  });

  it("DRAFT 账期接受结算并触碰行版本", async () => {
    const fixture = await seedSettlementFixture("draft", { status: "IN_PROGRESS" });
    const fixtureMonth = currentShanghaiMonth();
    const period = await db.insertInto("operating_bill_period").values({
      enterprise_id: fixture.enterpriseId,
      period_month: `${fixtureMonth}-01`,
      created_by: fixture.adminId,
    }).returning("id").executeTakeFirstOrThrow();
    const previousUpdatedAt = new Date("2000-01-01T00:00:00.000Z");
    await db.updateTable("operating_bill_period").set({ updated_at: previousUpdatedAt })
      .where("id", "=", period.id).execute();

    await expect(new GatewayLedgerRepository(db).createLedgerLine(fixture.line))
      .resolves.toMatchObject({ raw_input_tokens: "40", api_cost: "0.4" });
    const updated = await db.selectFrom("operating_bill_period").select("updated_at")
      .where("id", "=", period.id).executeTakeFirstOrThrow();
    expect(updated.updated_at.getTime()).toBeGreaterThan(previousUpdatedAt.getTime());
  });

  it("账期不存在时 attempt-first 先发布在途屏障，完整 finalize 后才允许关账", async () => {
    const fixture = await seedSettlementFixture(
      "attempt-first", { status: "IN_PROGRESS", createUsage: false },
    );
    await removeSeededAttempt(fixture);
    const fixtureMonth = currentShanghaiMonth();
    expect(await db.selectFrom("operating_bill_period").select("id")
      .where("enterprise_id", "=", fixture.enterpriseId)
      .where("period_month", "=", `${fixtureMonth}-01`).executeTakeFirst()).toBeUndefined();

    const repository = new GatewayLedgerRepository(db);
    const attempt = await repository.createAttempt({
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      attempt_no: 1,
      provider_resource_id: fixture.resourceId,
      upstream_model: "attempt-first-upstream",
    });
    await expectCloseRejected(fixture, "POOL-043 attempt-first 在途拒绝关账");

    await repository.updateAttemptResult(attempt.id, {
      finished_at: new Date(), http_status: 200, response_committed: true,
    });
    await repository.createUsageAndLedgerLineIfAbsent(
      atomicForAttempt(fixture, attempt.id, "attempt-first"),
    );
    await repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture));
    await expect(new OperatingBillRepository(db).closeMonth({
      enterpriseId: fixture.enterpriseId,
      adminId: fixture.adminId,
      month: fixtureMonth,
      allowIncomplete: true,
      note: "POOL-043 attempt-first 完整结算后关账",
    })).resolves.toMatchObject({ status: "CLOSED", version: 1 });
  });

  it("账期不存在时 close-first 先冻结，后续 attempt 在上游访问前被拒绝", async () => {
    const fixture = await seedSettlementFixture(
      "close-first", { status: "IN_PROGRESS", createUsage: false },
    );
    await removeSeededAttempt(fixture);
    const fixtureMonth = currentShanghaiMonth();
    await expect(new OperatingBillRepository(db).closeMonth({
      enterpriseId: fixture.enterpriseId,
      adminId: fixture.adminId,
      month: fixtureMonth,
      allowIncomplete: true,
      note: "POOL-043 close-first",
    })).resolves.toMatchObject({ status: "CLOSED", version: 1 });

    const repository = new GatewayLedgerRepository(db);
    await expect(repository.createAttempt({
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      attempt_no: 1,
      provider_resource_id: fixture.resourceId,
      upstream_model: "close-first-upstream",
    })).rejects.toBeInstanceOf(OperatingBillClosedError);
    expect(await repository.listAttempts(fixture.requestId)).toHaveLength(0);
  });

  it("usage→ledger 窗口不可见半成品，IN_PROGRESS 使关账 fail-close 直到原子 finalize", async () => {
    const fixture = await seedSettlementFixture(
      "atomic", { status: "IN_PROGRESS", createUsage: false },
    );
    const fixtureMonth = currentShanghaiMonth();
    await sql`DROP TRIGGER IF EXISTS pool043_block_ledger_line ON ledger_line`.execute(db);
    await sql`DROP FUNCTION IF EXISTS pool043_block_ledger_line()`.execute(db);
    await sql`
      CREATE FUNCTION pool043_block_ledger_line() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(43043001);
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `.execute(db);
    await sql`
      CREATE TRIGGER pool043_block_ledger_line
      BEFORE INSERT ON ledger_line
      FOR EACH ROW EXECUTE FUNCTION pool043_block_ledger_line()
    `.execute(db);

    let markBlockerReady!: () => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<void>((resolve) => { markBlockerReady = resolve; });
    const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocker = db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(43043001)`.execute(trx);
      markBlockerReady();
      await blockerRelease;
    });
    await blockerReady;
    let settlement: ReturnType<GatewayLedgerRepository["createUsageAndLedgerLineIfAbsent"]> | undefined;
    let closing: ReturnType<OperatingBillRepository["closeMonth"]> | undefined;
    try {
      settlement = new GatewayLedgerRepository(db)
        .createUsageAndLedgerLineIfAbsent(fixture.atomic);
      await waitForBlockedLedgerInsert();
      const invisibleUsage = await db.selectFrom("usage_event")
        .select(({ fn }) => fn.countAll().as("count"))
        .where("enterprise_id", "=", fixture.enterpriseId).executeTakeFirstOrThrow();
      expect(Number(invisibleUsage.count)).toBe(0);
      closing = new OperatingBillRepository(db).closeMonth({
        enterpriseId: fixture.enterpriseId, adminId: fixture.adminId,
        month: fixtureMonth, allowIncomplete: true,
        note: "POOL-043 原子结算 completion barrier 证据",
      });
      await waitForCloseAdvisoryLock();
      releaseBlocker();
      await blocker;
      await expect(settlement).resolves.toMatchObject({ created: true });
      await expect(closing).rejects.toBeInstanceOf(OperatingBillConcurrentModificationError);

      const replay = await new GatewayLedgerRepository(db)
        .createUsageAndLedgerLineIfAbsent(fixture.atomic);
      expect(replay.created).toBe(false);
      expect(await db.selectFrom("usage_event").select("id")
        .where("enterprise_id", "=", fixture.enterpriseId).execute()).toHaveLength(1);
      expect(await db.selectFrom("ledger_line").select("id")
        .where("enterprise_id", "=", fixture.enterpriseId).execute()).toHaveLength(1);
      expect(await new GatewayLedgerRepository(db)
        .getLedgerTransaction(fixture.atomic.usage.ai_request_id)).toBeUndefined();
      expect((await new GatewayLedgerRepository(db)
        .getRequest(fixture.atomic.usage.ai_request_id))?.status).toBe("IN_PROGRESS");

      const finalized = await new GatewayLedgerRepository(db).finalizeLedgerSettlementIfAbsent({
        ai_request_id: fixture.atomic.usage.ai_request_id,
        enterprise_id: fixture.enterpriseId,
        principal_id: fixture.employeeId,
        total_input_tokens: 40n,
        total_output_tokens: 5n,
        total_cache_tokens: 3n,
        total_reasoning_tokens: 0n,
        total_deducted_quota: 0n,
        total_api_cost: "0.4",
        usage_quality: "PROVIDER_REPORTED",
        attempt_count: 1,
        request_status: "SUCCEEDED",
      });
      expect(finalized).toMatchObject({ attempt_count: 1, status: "SETTLED" });
      expect((await new GatewayLedgerRepository(db)
        .getRequest(fixture.atomic.usage.ai_request_id))?.status).toBe("SUCCEEDED");
      await expect(new OperatingBillRepository(db).closeMonth({
        enterpriseId: fixture.enterpriseId, adminId: fixture.adminId,
        month: fixtureMonth, allowIncomplete: true,
        note: "POOL-043 原子 finalize 后关账",
      })).resolves.toMatchObject({ status: "CLOSED", version: 1 });
    } finally {
      releaseBlocker();
      await Promise.allSettled([
        blocker,
        ...(settlement ? [settlement] : []),
        ...(closing ? [closing] : []),
      ]);
      await sql`DROP TRIGGER IF EXISTS pool043_block_ledger_line ON ledger_line`.execute(db);
      await sql`DROP FUNCTION IF EXISTS pool043_block_ledger_line()`.execute(db);
    }
  });

  it("原子结算可自愈旧 usage-only，重试不会重复 ledger_line", async () => {
    const fixture = await seedSettlementFixture("heal", { status: "IN_PROGRESS" });
    const repository = new GatewayLedgerRepository(db);
    await expect(repository.createUsageAndLedgerLineIfAbsent(fixture.atomic))
      .resolves.toMatchObject({ created: true, usage: { id: fixture.usageId } });
    await expect(repository.createUsageAndLedgerLineIfAbsent(fixture.atomic))
      .resolves.toMatchObject({ created: false, usage: { id: fixture.usageId } });
    expect(await db.selectFrom("usage_event").select("id")
      .where("enterprise_id", "=", fixture.enterpriseId).execute()).toHaveLength(1);
    expect(await db.selectFrom("ledger_line").select("id")
      .where("enterprise_id", "=", fixture.enterpriseId).execute()).toHaveLength(1);
    await repository.finalizeLedgerSettlementIfAbsent({
      ai_request_id: fixture.atomic.usage.ai_request_id,
      enterprise_id: fixture.enterpriseId,
      principal_id: fixture.employeeId,
      total_input_tokens: 40n,
      total_output_tokens: 5n,
      total_cache_tokens: 3n,
      total_deducted_quota: 0n,
      total_api_cost: "0.4",
      usage_quality: "PROVIDER_REPORTED",
      attempt_count: 1,
      request_status: "SUCCEEDED",
    });
  });

  it("历史 usage-only 自愈沿用原 created_at，不把旧事实写入修复月份", async () => {
    const fixture = await seedSettlementFixture("historical-heal", { status: "IN_PROGRESS" });
    const historicalAt = new Date("2025-03-18T04:05:06.789Z");
    await db.updateTable("usage_event").set({ created_at: historicalAt })
      .where("id", "=", fixture.usageId).execute();

    const result = await new GatewayLedgerRepository(db)
      .createUsageAndLedgerLineIfAbsent(fixture.atomic);
    expect(result).toMatchObject({ created: true, usage: { id: fixture.usageId } });
    expect(result.line.created_at.toISOString()).toBe(historicalAt.toISOString());
    expect(result.usage.created_at.toISOString()).toBe(historicalAt.toISOString());
  });

  it("历史 usage-only 所属月份已 CLOSED 时拒绝自愈且不产生 ledger_line", async () => {
    const fixture = await seedSettlementFixture("historical-closed", { status: "IN_PROGRESS" });
    const historicalAt = new Date("2025-04-18T04:05:06.789Z");
    await db.updateTable("usage_event").set({ created_at: historicalAt })
      .where("id", "=", fixture.usageId).execute();
    await db.insertInto("operating_bill_period").values({
      enterprise_id: fixture.enterpriseId,
      period_month: "2025-04-01",
      status: "CLOSED",
      current_version: 1,
      created_by: fixture.adminId,
    }).execute();

    await expect(new GatewayLedgerRepository(db)
      .createUsageAndLedgerLineIfAbsent(fixture.atomic))
      .rejects.toBeInstanceOf(OperatingBillClosedError);
    expect(await db.selectFrom("ledger_line").select("id")
      .where("enterprise_id", "=", fixture.enterpriseId).execute()).toHaveLength(0);
  });

  it("finalize 拒绝事务外旧 totals 与未完成 attempt，且不发布 terminal", async () => {
    const fixture = await seedSettlementFixture(
      "finalize-guard", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    await repository.createUsageAndLedgerLineIfAbsent(fixture.atomic);

    await expect(repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture, {
      total_input_tokens: 39n,
    }))).rejects.toThrow("settlement_totals_stale");
    await expect(repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture, {
      attempt_count: 2,
    }))).rejects.toThrow("settlement_attempt_incomplete");
    expect(await repository.getLedgerTransaction(fixture.requestId)).toBeUndefined();
    expect((await repository.getRequest(fixture.requestId))?.status).toBe("IN_PROGRESS");

    await repository.createAttempt({
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      attempt_no: 2,
      provider_resource_id: fixture.resourceId,
      upstream_model: "unfinished-upstream",
    });
    await expect(repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture, {
      attempt_count: 2,
    }))).rejects.toThrow("settlement_attempt_incomplete");
    expect(await repository.getLedgerTransaction(fixture.requestId)).toBeUndefined();
    expect((await repository.getRequest(fixture.requestId))?.status).toBe("IN_PROGRESS");
  });

  it("finalize 逐项拒绝旧 totals、缺 ledger line 与错误主体", async () => {
    const fixture = await seedSettlementFixture(
      "finalize-all-totals", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    await expect(repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture, {
      ai_request_id: randomUUID(),
    }))).rejects.toThrow("settlement_request_not_found");
    await repository.createUsageAndLedgerLineIfAbsent(fixture.atomic);
    const staleInputs: Array<Partial<FinalizeInput>> = [
      { total_output_tokens: 6n },
      { total_cache_tokens: 4n },
      { total_reasoning_tokens: 1n },
      { total_deducted_quota: 1n },
      { total_api_cost: "0.41" },
      { usage_quality: "ESTIMATED" },
    ];
    for (const stale of staleInputs) {
      await expect(repository.finalizeLedgerSettlementIfAbsent(
        finalizationFor(fixture, stale),
      )).rejects.toThrow("settlement_totals_stale");
    }
    await expect(repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture, {
      principal_id: randomUUID(),
    }))).rejects.toThrow("settlement_principal_conflict");
    expect(await repository.getLedgerTransaction(fixture.requestId)).toBeUndefined();
    expect((await repository.getRequest(fixture.requestId))?.status).toBe("IN_PROGRESS");

    const missingLine = await seedSettlementFixture(
      "finalize-missing-line", { status: "IN_PROGRESS" },
    );
    await expect(new GatewayLedgerRepository(db).finalizeLedgerSettlementIfAbsent(
      finalizationFor(missingLine),
    )).rejects.toThrow("settlement_usage_without_line");
  });

  it("API 成本未知时以零占位结算，但保留 Ledger Line 的 null 事实", async () => {
    const fixture = await seedSettlementFixture(
      "unknown-api-cost", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    const result = await repository.createUsageAndLedgerLineIfAbsent({
      usage: { ...fixture.atomic.usage },
      ledger_line: { ...fixture.atomic.ledger_line, api_cost: null },
    });
    expect(result.line.api_cost).toBeNull();
    await expect(repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture, {
      total_api_cost: "0",
    }))).resolves.toMatchObject({ total_api_cost: "0", status: "SETTLED" });
  });

  it("finalize 的 terminal 重放仅允许状态与错误身份完全一致", async () => {
    const fixture = await seedSettlementFixture(
      "terminal-replay", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    await repository.createUsageAndLedgerLineIfAbsent(fixture.atomic);
    const terminal = finalizationFor(fixture, {
      request_status: "FAILED",
      error_classification: "UPSTREAM_ERROR",
      error_code: "provider_timeout",
    });
    await expect(repository.finalizeLedgerSettlementIfAbsent(terminal))
      .resolves.toMatchObject({ status: "SETTLED" });
    await expect(repository.finalizeLedgerSettlementIfAbsent(terminal))
      .resolves.toMatchObject({ status: "SETTLED" });
    await expect(repository.finalizeLedgerSettlementIfAbsent({
      ...terminal, request_status: "SUCCEEDED",
    })).rejects.toThrow("settlement_terminal_conflict");
    await expect(repository.finalizeLedgerSettlementIfAbsent({
      ...terminal, error_classification: "CLIENT_ERROR",
    })).rejects.toThrow("settlement_terminal_conflict");
    await expect(repository.finalizeLedgerSettlementIfAbsent({
      ...terminal, error_code: "different_code",
    })).rejects.toThrow("settlement_terminal_conflict");

    const withoutTransaction = await seedSettlementFixture(
      "terminal-no-tx", { status: "SUCCEEDED", createUsage: false },
    );
    await expect(new GatewayLedgerRepository(db).finalizeLedgerSettlementIfAbsent(
      finalizationFor(withoutTransaction),
    )).rejects.toThrow("settlement_terminal_conflict");
  });

  it("attempt 创建拒绝不存在资源、重复启动与重复身份漂移", async () => {
    const fixture = await seedSettlementFixture(
      "attempt-identity", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    await expect(repository.createAttempt({
      ai_request_id: randomUUID(),
      enterprise_id: fixture.enterpriseId,
      attempt_no: 1,
      provider_resource_id: fixture.resourceId,
      upstream_model: "missing-request",
    })).rejects.toThrow("settlement_request_not_found");
    await expect(repository.createAttempt({
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      attempt_no: 2,
      provider_resource_id: randomUUID(),
      upstream_model: "missing-resource",
    })).rejects.toThrow("attempt_resource_conflict");
    await expect(repository.createAttempt({
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      attempt_no: 1,
      provider_resource_id: fixture.resourceId,
      upstream_model: `upstream-attempt-identity`,
    })).rejects.toThrow("attempt_already_started");
    await expect(repository.createAttempt({
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      attempt_no: 1,
      provider_resource_id: fixture.resourceId,
      upstream_model: "changed-upstream",
    })).rejects.toThrow("attempt_identity_conflict");
  });

  it("terminal 发布后拒绝 late attempt 与 late usage，账本计数保持不变", async () => {
    const fixture = await seedSettlementFixture(
      "terminal", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    await repository.createUsageAndLedgerLineIfAbsent(fixture.atomic);
    await repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture));

    await expect(repository.createAttempt({
      ai_request_id: fixture.requestId,
      enterprise_id: fixture.enterpriseId,
      attempt_no: 2,
      provider_resource_id: fixture.resourceId,
      upstream_model: "late-upstream",
    })).rejects.toThrow("settlement_request_terminal");
    await expect(repository.createUsageAndLedgerLineIfAbsent(
      atomicForAttempt(fixture, fixture.attemptId, "late"),
    )).rejects.toThrow("settlement_request_terminal");
    expect(await repository.listAttempts(fixture.requestId)).toHaveLength(1);
    expect(await repository.listUsageEvents(fixture.requestId)).toHaveLength(1);
    expect(await repository.listLedgerLines(fixture.requestId)).toHaveLength(1);
  });

  it("dedup 重放逐字段核验完整 usage 与 ledger_line 冻结事实", async () => {
    const fixture = await seedSettlementFixture(
      "dedup-fields", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    const billingRule = await db.insertInto("billing_rule").values({
      enterprise_id: fixture.enterpriseId,
      provider_resource_id: fixture.resourceId,
      upstream_model: null,
      rule_type: "API_PRICE",
      rule_version: "pool043-v1",
      effective_from: new Date(0),
      effective_to: null,
      timezone: null,
      days_of_week: null,
      start_time: null,
      end_time: null,
      multiplier: "1.25000000",
      cache_hit_price: null,
      cache_miss_price: null,
      output_price: null,
      source: "POOL-043",
    }).returning("id").executeTakeFirstOrThrow();
    const canonical: CreateUsageLedgerLineInput = {
      usage: {
        ...fixture.atomic.usage,
        reasoning_tokens: 2n,
        upstream_usage_id: "provider-usage-001",
      },
      ledger_line: {
        ...fixture.atomic.ledger_line,
        raw_reasoning_tokens: 2n,
        deducted_quota: 48n,
        billing_rule_id: billingRule.id,
        multiplier: "1.25000000",
        rule_version: "pool043-v1",
        billing_rule_snapshot: { source: "POOL-043", price: "0.4" },
      },
    };
    await expect(repository.createUsageAndLedgerLineIfAbsent(canonical)).resolves.toMatchObject({
      created: true,
      usage: { reasoning_tokens: "2", upstream_usage_id: "provider-usage-001" },
      line: {
        raw_reasoning_tokens: "2",
        deducted_quota: "48",
        billing_rule_id: billingRule.id,
        rule_version: "pool043-v1",
        multiplier: "1.25000000",
        billing_rule_snapshot: { source: "POOL-043", price: "0.4" },
      },
    });

    const missingAttemptId = randomUUID();
    await expect(repository.createUsageAndLedgerLineIfAbsent({
      usage: {
        ...canonical.usage,
        upstream_attempt_id: missingAttemptId,
        dedup_key: `${canonical.usage.dedup_key}-missing-attempt`,
      },
      ledger_line: {
        ...canonical.ledger_line,
        upstream_attempt_id: missingAttemptId,
      },
    })).rejects.toThrow("usage_attempt_conflict");

    const usageConflicts: Array<[
      string,
      Partial<CreateUsageLedgerLineInput["usage"]>,
      string,
    ]> = [
      ["upstream_attempt_id", { upstream_attempt_id: randomUUID() }, "usage_ledger_input_conflict"],
      ["provider_resource_id", { provider_resource_id: randomUUID() }, "usage_ledger_input_conflict"],
      ["input_tokens", { input_tokens: 41n }, "usage_ledger_input_conflict"],
      ["output_tokens", { output_tokens: 6n }, "usage_ledger_input_conflict"],
      ["cache_tokens", { cache_tokens: 4n }, "usage_ledger_input_conflict"],
      ["reasoning_tokens", { reasoning_tokens: 1n }, "usage_ledger_input_conflict"],
      ["usage_quality", { usage_quality: "ESTIMATED" }, "usage_ledger_input_conflict"],
      ["upstream_usage_id", { upstream_usage_id: "provider-usage-002" }, "usage_dedup_conflict"],
    ];
    for (const [field, changed, error] of usageConflicts) {
      await expect(repository.createUsageAndLedgerLineIfAbsent({
        usage: { ...canonical.usage, ...changed },
        ledger_line: { ...canonical.ledger_line },
      }), field).rejects.toThrow(error);
    }

    const lineConflicts: Array<[
      string,
      Partial<CreateUsageLedgerLineInput["ledger_line"]>,
      string,
    ]> = [
      ["ai_request_id", { ai_request_id: randomUUID() }, "usage_ledger_input_conflict"],
      ["enterprise_id", { enterprise_id: randomUUID() }, "usage_ledger_input_conflict"],
      ["upstream_attempt_id", { upstream_attempt_id: randomUUID() }, "usage_ledger_input_conflict"],
      ["provider_resource_id", { provider_resource_id: randomUUID() }, "usage_ledger_input_conflict"],
      ["principal_id", { principal_id: randomUUID() }, "settlement_principal_conflict"],
      ["resource_mode", { resource_mode: "CODING_PLAN" }, "settlement_resource_mode_conflict"],
      ["raw_input_tokens", { raw_input_tokens: 41n }, "usage_ledger_input_conflict"],
      ["raw_output_tokens", { raw_output_tokens: 6n }, "usage_ledger_input_conflict"],
      ["raw_cache_tokens", { raw_cache_tokens: 4n }, "usage_ledger_input_conflict"],
      ["raw_reasoning_tokens", { raw_reasoning_tokens: 1n }, "usage_ledger_input_conflict"],
      ["deducted_quota", { deducted_quota: 49n }, "ledger_line_conflict"],
      ["api_cost", { api_cost: "0.41" }, "ledger_line_conflict"],
      ["usage_quality", { usage_quality: "ESTIMATED" }, "usage_ledger_input_conflict"],
      ["billing_rule_id", { billing_rule_id: randomUUID() }, "ledger_line_conflict"],
      ["rule_version", { rule_version: "pool043-v2" }, "ledger_line_conflict"],
      ["multiplier", { multiplier: "1.3" }, "ledger_line_conflict"],
      ["billing_rule_snapshot", { billing_rule_snapshot: { source: "changed" } }, "ledger_line_conflict"],
    ];
    for (const [field, changed, error] of lineConflicts) {
      await expect(repository.createUsageAndLedgerLineIfAbsent({
        usage: { ...canonical.usage },
        ledger_line: { ...canonical.ledger_line, ...changed },
      }), field).rejects.toThrow(error);
    }
    expect(await repository.listUsageEvents(fixture.requestId)).toHaveLength(1);
    expect(await repository.listLedgerLines(fixture.requestId)).toHaveLength(1);
    await expect(repository.finalizeLedgerSettlementIfAbsent(finalizationFor(fixture, {
      total_reasoning_tokens: 2n,
      total_deducted_quota: 48n,
    }))).resolves.toMatchObject({
      total_reasoning_tokens: "2",
      total_deducted_quota: "48",
      status: "SETTLED",
    });
  });

  it("allowIncomplete 也拒绝冻结 usage-only 硬缺口", async () => {
    const fixture = await seedSettlementFixture("gap-usage-only");
    await expectCloseRejected(fixture, "POOL-043 usage-only 硬缺口");
  });

  it("allowIncomplete 也拒绝冻结 line-without-transaction 硬缺口", async () => {
    const fixture = await seedSettlementFixture("gap-line-without-tx");
    await insertLegacyLineDirectly(fixture);
    await expectCloseRejected(fixture, "POOL-043 line-without-transaction 硬缺口");
  });

  it("allowIncomplete 也拒绝冻结 transaction totals mismatch 硬缺口", async () => {
    const fixture = await seedSettlementFixture("gap-tx-mismatch");
    await insertLegacyLineDirectly(fixture);
    await insertLegacyTransactionDirectly(fixture, {
      total_input_tokens: 41n,
    });
    await expectCloseRejected(fixture, "POOL-043 transaction mismatch 硬缺口");
  });

  it("allowIncomplete 也拒绝冻结 terminal request 的 unfinished attempt", async () => {
    const fixture = await seedSettlementFixture(
      "gap-terminal-attempt", { createUsage: false },
    );
    await db.updateTable("upstream_attempt").set({ finished_at: null })
      .where("id", "=", fixture.attemptId).execute();
    await expectCloseRejected(fixture, "POOL-043 terminal unfinished attempt 硬缺口");
  });

  it("兼容写入口保留幂等语义，并由原子 finalize 发布 terminal", async () => {
    const fixture = await seedSettlementFixture(
      "guarded-compat", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    const usage = await repository.createUsageEventIfAbsent({
      ...fixture.atomic.usage,
      reasoning_tokens: 7n,
      upstream_usage_id: "pool043-compat-upstream-usage",
    });
    expect(usage).toMatchObject({
      reasoning_tokens: "7",
      upstream_usage_id: "pool043-compat-upstream-usage",
    });
    await expect(repository.createUsageEventIfAbsent({
      ...fixture.atomic.usage,
      reasoning_tokens: 7n,
      upstream_usage_id: "pool043-compat-upstream-usage",
    })).resolves.toBeUndefined();
    const billingRule = await db.insertInto("billing_rule").values({
      enterprise_id: fixture.enterpriseId,
      provider_resource_id: fixture.resourceId,
      upstream_model: null,
      rule_type: "API_PRICE",
      rule_version: "pool043-v1",
      effective_from: new Date(0),
      effective_to: null,
      timezone: null,
      days_of_week: null,
      start_time: null,
      end_time: null,
      multiplier: "1.25000000",
      cache_hit_price: null,
      cache_miss_price: null,
      output_price: null,
      source: "POOL-043",
    }).returning("id").executeTakeFirstOrThrow();
    await expect(repository.createLedgerLine({
      ...fixture.line,
      usage_event_id: usage!.id,
      raw_reasoning_tokens: 7n,
      deducted_quota: 48n,
      billing_rule_id: billingRule.id,
      rule_version: "pool043-v1",
      multiplier: "1.25000000",
      billing_rule_snapshot: { source: "POOL-043" },
    })).resolves.toMatchObject({
      raw_input_tokens: "40",
      raw_reasoning_tokens: "7",
      deducted_quota: "48",
      api_cost: "0.4",
      billing_rule_id: billingRule.id,
      rule_version: "pool043-v1",
      multiplier: "1.25000000",
      billing_rule_snapshot: { source: "POOL-043" },
    });
    const totals = finalizationFor(fixture, {
      total_reasoning_tokens: 7n,
      total_deducted_quota: 48n,
      overage: true,
    });
    await expect(repository.createLedgerTransactionIfAbsent(totals))
      .resolves.toMatchObject({
        total_reasoning_tokens: "7", total_deducted_quota: "48",
        overage: true, attempt_count: 1, status: "SETTLED",
      });
    await expect(repository.createLedgerTransactionIfAbsent(totals))
      .resolves.toBeUndefined();

    await expect(repository.finalizeLedgerSettlementIfAbsent(totals))
      .resolves.toMatchObject({ attempt_count: 1, status: "SETTLED" });
    expect((await repository.getRequest(fixture.requestId))?.status).toBe("SUCCEEDED");
  });

  it("兼容写入口拒绝缺失 request/attempt、错误主体与任一种既有结算事实", async () => {
    const repository = new GatewayLedgerRepository(db);
    await expect(repository.updateRequestStatus(randomUUID(), "FAILED"))
      .rejects.toThrow("settlement_request_not_found");
    await expect(repository.updateAttemptResult(randomUUID(), { finished_at: new Date() }))
      .rejects.toThrow("settlement_attempt_not_found");

    const invalidUsage = await seedSettlementFixture(
      "guarded-invalid-usage", { status: "IN_PROGRESS", createUsage: false },
    );
    await expect(repository.createUsageEventIfAbsent({
      ...invalidUsage.atomic.usage,
      ai_request_id: randomUUID(),
    })).rejects.toThrow("settlement_request_not_found");
    await expect(repository.createUsageEventIfAbsent({
      ...invalidUsage.atomic.usage,
      upstream_attempt_id: randomUUID(),
    })).rejects.toThrow("usage_attempt_conflict");
    await expect(repository.createLedgerTransactionIfAbsent(finalizationFor(invalidUsage, {
      principal_id: randomUUID(),
    }))).rejects.toThrow("settlement_principal_conflict");

    const unfinished = await seedSettlementFixture(
      "early-unfinished", { status: "IN_PROGRESS", createUsage: false },
    );
    await db.updateTable("upstream_attempt").set({ finished_at: null })
      .where("id", "=", unfinished.attemptId).execute();
    await expect(repository.updateRequestStatus(unfinished.requestId, "FAILED"))
      .rejects.toThrow("unsettled_request_terminal_write");

    const finishedAttempt = await seedSettlementFixture(
      "early-finished-attempt", { status: "IN_PROGRESS", createUsage: false },
    );
    await expect(repository.updateRequestStatus(finishedAttempt.requestId, "FAILED"))
      .rejects.toThrow("unsettled_request_terminal_write");

    const usageOnly = await seedSettlementFixture(
      "early-usage", { status: "IN_PROGRESS" },
    );
    await expect(repository.updateRequestStatus(usageOnly.requestId, "FAILED"))
      .rejects.toThrow("unsettled_request_terminal_write");

    const line = await seedSettlementFixture(
      "early-line", { status: "IN_PROGRESS" },
    );
    await insertLegacyLineDirectly(line);
    await expect(repository.updateRequestStatus(line.requestId, "FAILED"))
      .rejects.toThrow("unsettled_request_terminal_write");

    const transaction = await seedSettlementFixture(
      "early-transaction", { status: "IN_PROGRESS", createUsage: false },
    );
    await insertLegacyTransactionDirectly(transaction);
    await expect(repository.updateRequestStatus(transaction.requestId, "FAILED"))
      .rejects.toThrow("unsettled_request_terminal_write");
  });

  it("无错误字段的早退显式归一为 null，并正确保存 attempt 结果", async () => {
    const fixture = await seedSettlementFixture(
      "guarded-defaults", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    const firstByteAt = new Date("2026-08-09T01:02:03.000Z");
    const finishedAt = new Date("2026-08-09T01:02:04.000Z");
    await repository.updateAttemptResult(fixture.attemptId, {
      http_status: 503,
      response_committed: true,
      first_byte_at: firstByteAt,
      finished_at: finishedAt,
      error_classification: "UPSTREAM_ERROR",
      error_code: "provider_unavailable",
      failure_layer: "PROVIDER",
      switch_reason: "retry",
    });
    expect(await db.selectFrom("upstream_attempt").selectAll()
      .where("id", "=", fixture.attemptId).executeTakeFirstOrThrow()).toMatchObject({
      http_status: 503,
      response_committed: true,
      first_byte_at: firstByteAt,
      finished_at: finishedAt,
      error_classification: "UPSTREAM_ERROR",
      error_code: "provider_unavailable",
      failure_layer: "PROVIDER",
      switch_reason: "retry",
    });
    await removeSeededAttempt(fixture);
    await repository.updateRequestStatus(fixture.requestId, "SUCCEEDED");
    expect(await repository.getRequest(fixture.requestId)).toMatchObject({
      status: "SUCCEEDED", error_classification: null, error_code: null,
    });

    const defaultTransaction = await seedSettlementFixture(
      "guarded-default-tx", { status: "IN_PROGRESS", createUsage: false },
    );
    await expect(repository.createLedgerTransactionIfAbsent(
      finalizationFor(defaultTransaction, { overage: undefined }),
    )).resolves.toMatchObject({ overage: false });
  });

  it("当前月保守拦截企业在途请求，历史空月不被误拦", async () => {
    const fixture = await seedSettlementFixture(
      "pending-month", { status: "IN_PROGRESS", createUsage: false },
    );
    const now = new Date();
    await db.updateTable("upstream_attempt")
      .set({ started_at: new Date("2020-01-15T00:00:00.000Z") })
      .where("id", "=", fixture.attemptId).execute();
    expect(await hasPendingOperatingBillSettlement(
      db, fixture.enterpriseId, currentShanghaiMonth(), now,
    )).toBe(true);
    expect(await hasPendingOperatingBillSettlement(
      db, fixture.enterpriseId, "2020-02", now,
    )).toBe(false);
  });

  it("终态撤权一次提交全部事实，汇总既有 Attempt 且重放不重复结算", async () => {
    const scenario = await seedTerminalRejectedAccounting("terminal-success");
    const repository = new GatewayLedgerRepository(db);
    const transaction = await repository.finalizeRejectedAttemptSettlementIfAbsent(scenario.input);

    expect(transaction).toMatchObject({
      total_input_tokens: "40",
      total_output_tokens: "5",
      total_cache_tokens: "3",
      total_reasoning_tokens: "0",
      total_deducted_quota: "0",
      total_api_cost: "0.40000000",
      usage_quality: "MIXED:PROVIDER_REPORTED+UNKNOWN",
      attempt_count: 2,
      overage: false,
      status: "SETTLED",
    });
    expect(await repository.getRequest(scenario.fixture.requestId)).toMatchObject({
      status: "FAILED",
      error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
      error_code: "candidate_admission_revoked",
    });
    expect(await repository.listUsageEvents(scenario.fixture.requestId)).toHaveLength(2);
    expect(await repository.listLedgerLines(scenario.fixture.requestId)).toHaveLength(2);
    expect(await db.selectFrom("upstream_attempt").select(["finished_at", "error_code"])
      .where("id", "=", scenario.currentAttemptId).executeTakeFirstOrThrow())
      .toMatchObject({
        finished_at: scenario.input.attempt_result.finished_at,
        error_code: "candidate_admission_revoked",
      });
    expect(BigInt((await db.selectFrom("quota_counter").select("used_value")
      .where("grant_id", "=", scenario.grantId).executeTakeFirstOrThrow()).used_value)).toBe(0n);
    const releasedAt = (await db.selectFrom("concurrency_lease").select("released_at")
      .where("id", "=", scenario.leaseId).executeTakeFirstOrThrow()).released_at;
    expect(releasedAt).not.toBeNull();

    const replay = await repository.finalizeRejectedAttemptSettlementIfAbsent({
      ...scenario.input,
      attempt_result: { ...scenario.input.attempt_result, finished_at: new Date() },
    });
    expect(replay.id).toBe(transaction.id);
    expect(await repository.listUsageEvents(scenario.fixture.requestId)).toHaveLength(2);
    expect(await repository.listLedgerLines(scenario.fixture.requestId)).toHaveLength(2);
    expect(await db.selectFrom("ledger_transaction").select("id")
      .where("ai_request_id", "=", scenario.fixture.requestId).execute()).toHaveLength(1);
    expect(BigInt((await db.selectFrom("quota_counter").select("used_value")
      .where("grant_id", "=", scenario.grantId).executeTakeFirstOrThrow()).used_value)).toBe(0n);
    expect((await db.selectFrom("concurrency_lease").select("released_at")
      .where("id", "=", scenario.leaseId).executeTakeFirstOrThrow()).released_at)
      .toEqual(releasedAt);
  });

  it.each(["nonzero", "api-cost-unknown", "error-identity"] as const)(
    "终态撤权拒绝伪造的零事实或错误身份：%s",
    async (kind) => {
      const scenario = await seedTerminalRejectedAccounting(`invalid-${kind.slice(0, 10)}`);
      const input: TerminalRejectedInput = {
        ...scenario.input,
        usage: { ...scenario.input.usage },
        ledger_line: { ...scenario.input.ledger_line },
        attempt_result: { ...scenario.input.attempt_result },
      };
      if (kind === "nonzero") {
        input.usage.input_tokens = 1n;
        input.ledger_line.raw_input_tokens = 1n;
      } else if (kind === "api-cost-unknown") {
        input.ledger_line.api_cost = null;
      } else {
        input.error_code = "different_terminal_error";
      }
      await expect(new GatewayLedgerRepository(db)
        .finalizeRejectedAttemptSettlementIfAbsent(input))
        .rejects.toThrow("terminal_rejection_fact_conflict");
      await expectTerminalSettlementRolledBack(scenario);
    },
  );

  it("终态撤权入口按企业定位 request，不接受跨企业身份", async () => {
    const scenario = await seedTerminalRejectedAccounting("terminal-enterprise");
    const otherEnterpriseId = randomUUID();
    await expect(new GatewayLedgerRepository(db).finalizeRejectedAttemptSettlementIfAbsent({
      ...scenario.input,
      usage: { ...scenario.input.usage, enterprise_id: otherEnterpriseId },
      ledger_line: { ...scenario.input.ledger_line, enterprise_id: otherEnterpriseId },
    })).rejects.toThrow("settlement_request_not_found");
    await expectTerminalSettlementRolledBack(scenario);
  });

  it("终态重放逐项核验主体、请求终态、错误身份和 Attempt 结果", async () => {
    const scenario = await seedTerminalRejectedAccounting("term-replay");
    const repository = new GatewayLedgerRepository(db);
    await repository.finalizeRejectedAttemptSettlementIfAbsent(scenario.input);

    await expect(repository.finalizeRejectedAttemptSettlementIfAbsent({
      ...scenario.input,
      ledger_line: { ...scenario.input.ledger_line, principal_id: randomUUID() },
    })).rejects.toThrow("settlement_principal_conflict");
    await expect(repository.finalizeRejectedAttemptSettlementIfAbsent({
      ...scenario.input,
      attempt_result: { ...scenario.input.attempt_result, http_status: 409 },
    })).rejects.toThrow("settlement_attempt_result_conflict");

    for (const update of [
      { status: "SUCCEEDED" },
      { error_classification: "INTERNAL" },
      { error_code: "different_terminal_error" },
    ]) {
      await db.updateTable("ai_request").set(update)
        .where("id", "=", scenario.fixture.requestId).execute();
      await expect(repository.finalizeRejectedAttemptSettlementIfAbsent(scenario.input))
        .rejects.toThrow("settlement_terminal_conflict");
      await db.updateTable("ai_request").set({
        status: "FAILED",
        error_classification: scenario.input.error_classification,
        error_code: scenario.input.error_code,
      }).where("id", "=", scenario.fixture.requestId).execute();
    }

    await db.deleteFrom("ledger_transaction")
      .where("ai_request_id", "=", scenario.fixture.requestId).execute();
    await expect(repository.finalizeRejectedAttemptSettlementIfAbsent(scenario.input))
      .rejects.toThrow("settlement_terminal_conflict");
  });

  it("终态 request UPDATE 未命中时全部写入回滚", async () => {
    const scenario = await seedTerminalRejectedAccounting("terminal-status-zero");
    const repository = new GatewayLedgerRepository(db);
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `pool043_skip_request_${suffix}`;
    const triggerName = `pool043_skip_request_trg_${suffix}`;
    await sql`CREATE FUNCTION ${sql.raw(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(db);
    await sql`CREATE TRIGGER ${sql.raw(triggerName)} BEFORE UPDATE ON ai_request
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(functionName)}()`.execute(db);
    try {
      await expect(repository.finalizeRejectedAttemptSettlementIfAbsent(scenario.input))
        .rejects.toThrow("settlement_status_conflict");
    } finally {
      await sql`DROP TRIGGER ${sql.raw(triggerName)} ON ai_request`.execute(db);
      await sql`DROP FUNCTION ${sql.raw(functionName)}()`.execute(db);
    }
    await expectTerminalSettlementRolledBack(scenario);
  });

  it.each([
    { label: "attempt-update", table: "upstream_attempt", operation: "UPDATE" },
    { label: "usage-insert", table: "usage_event", operation: "INSERT" },
    { label: "line-insert", table: "ledger_line", operation: "INSERT" },
    { label: "quota-update", table: "quota_counter", operation: "UPDATE" },
    { label: "lease-update", table: "concurrency_lease", operation: "UPDATE" },
    { label: "transaction-insert", table: "ledger_transaction", operation: "INSERT" },
    { label: "request-update", table: "ai_request", operation: "UPDATE" },
  ] as const)("终态撤权在 $label 故障时整体回滚", async ({ label, table, operation }) => {
    const scenario = await seedTerminalRejectedAccounting(`fault-${label.slice(0, 12)}`);
    const repository = new GatewayLedgerRepository(db);
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `pool043_terminal_fault_${suffix}`;
    const triggerName = `pool043_terminal_fault_trg_${suffix}`;
    await sql`CREATE FUNCTION ${sql.raw(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'pool043_terminal_fault';
      END $$`.execute(db);
    await sql`CREATE TRIGGER ${sql.raw(triggerName)} BEFORE ${sql.raw(operation)}
      ON ${sql.raw(table)} FOR EACH ROW EXECUTE FUNCTION ${sql.raw(functionName)}()`.execute(db);
    try {
      await expect(repository.finalizeRejectedAttemptSettlementIfAbsent(scenario.input))
        .rejects.toThrow("pool043_terminal_fault");
    } finally {
      await sql`DROP TRIGGER ${sql.raw(triggerName)} ON ${sql.raw(table)}`.execute(db);
      await sql`DROP FUNCTION ${sql.raw(functionName)}()`.execute(db);
    }
    await expectTerminalSettlementRolledBack(scenario);
  });

  it("非终态撤权清算故障整体回滚，重试成功且重放不重复退额度", async () => {
    const fixture = await seedSettlementFixture(
      "nonterminal-revoke", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    await db.updateTable("upstream_attempt").set({
      finished_at: null,
      http_status: null,
      response_committed: false,
      error_classification: null,
      error_code: null,
      switch_reason: null,
    }).where("id", "=", fixture.attemptId).execute();
    const grant = await db.insertInto("principal_grant").values({
      enterprise_id: fixture.enterpriseId,
      principal_id: fixture.employeeId,
      provider: "pool043-nonterminal-revoke",
      model_alias: "ql-pool043-nonterminal-revoke",
      quota_value: 1_000n,
      allow_overage: false,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("quota_counter").values({
      grant_id: grant.id,
      used_value: 37n,
    }).execute();
    const lease = await db.insertInto("concurrency_lease").values({
      enterprise_id: fixture.enterpriseId,
      provider_resource_id: fixture.resourceId,
      ai_request_id: fixture.requestId,
      expires_at: new Date(Date.now() + 60_000),
    }).returning("id").executeTakeFirstOrThrow();
    const zeroFact = {
      usage: {
        ...fixture.atomic.usage,
        input_tokens: 0n,
        output_tokens: 0n,
        cache_tokens: 0n,
        reasoning_tokens: 0n,
        usage_quality: "UNKNOWN",
      },
      ledger_line: {
        ...fixture.atomic.ledger_line,
        raw_input_tokens: 0n,
        raw_output_tokens: 0n,
        raw_cache_tokens: 0n,
        raw_reasoning_tokens: 0n,
        deducted_quota: null,
        api_cost: "0.00000000",
        usage_quality: "UNKNOWN",
        billing_rule_id: null,
        rule_version: null,
        multiplier: null,
        billing_rule_snapshot: null,
      },
      attempt_result: {
        http_status: 503,
        response_committed: false,
        finished_at: new Date(),
        error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
        error_code: "candidate_admission_revoked",
        switch_reason: null,
      },
      quota_settlements: [{
        grant_id: grant.id,
        reserved_estimate: 37n,
        actual_deducted: 0n,
      }],
    };

    // lease 身份故障发生在 quota UPDATE 之后；事务必须把 line 与 quota 一并回滚。
    await expect(repository.persistAttemptUsageAccountingIfAbsent({
      ...zeroFact,
      release_lease_ids: [randomUUID()],
    })).rejects.toThrow("settlement_lease_conflict");
    expect(await repository.listUsageEvents(fixture.requestId)).toEqual([]);
    expect(await repository.listLedgerLines(fixture.requestId)).toEqual([]);
    expect(BigInt((await db.selectFrom("quota_counter").select("used_value")
      .where("grant_id", "=", grant.id).executeTakeFirstOrThrow()).used_value)).toBe(37n);
    expect((await db.selectFrom("concurrency_lease").select("released_at")
      .where("id", "=", lease.id).executeTakeFirstOrThrow()).released_at).toBeNull();
    expect(await db.selectFrom("upstream_attempt")
      .select(["finished_at", "error_code"])
      .where("id", "=", fixture.attemptId).executeTakeFirstOrThrow())
      .toMatchObject({ finished_at: null, error_code: null });
    expect(await repository.getRequest(fixture.requestId)).toMatchObject({ status: "IN_PROGRESS" });

    const first = await repository.persistAttemptUsageAccountingIfAbsent({
      ...zeroFact,
      release_lease_ids: [lease.id],
    });
    expect(first.created).toBe(true);
    expect(first.line).toMatchObject({ api_cost: "0.00000000", usage_quality: "UNKNOWN" });
    expect(BigInt((await db.selectFrom("quota_counter").select("used_value")
      .where("grant_id", "=", grant.id).executeTakeFirstOrThrow()).used_value)).toBe(0n);
    const releasedAt = (await db.selectFrom("concurrency_lease").select("released_at")
      .where("id", "=", lease.id).executeTakeFirstOrThrow()).released_at;
    expect(releasedAt).not.toBeNull();
    expect(await db.selectFrom("upstream_attempt")
      .select(["http_status", "finished_at", "error_code"])
      .where("id", "=", fixture.attemptId).executeTakeFirstOrThrow())
      .toMatchObject({
        http_status: 503,
        finished_at: zeroFact.attempt_result.finished_at,
        error_code: "candidate_admission_revoked",
      });
    expect(await repository.getRequest(fixture.requestId)).toMatchObject({ status: "IN_PROGRESS" });
    expect(await repository.getLedgerTransaction(fixture.requestId)).toBeUndefined();

    const replay = await repository.persistAttemptUsageAccountingIfAbsent({
      ...zeroFact,
      release_lease_ids: [lease.id],
    });
    expect(replay.created).toBe(false);
    expect(BigInt((await db.selectFrom("quota_counter").select("used_value")
      .where("grant_id", "=", grant.id).executeTakeFirstOrThrow()).used_value)).toBe(0n);
    expect((await db.selectFrom("concurrency_lease").select("released_at")
      .where("id", "=", lease.id).executeTakeFirstOrThrow()).released_at)
      .toEqual(releasedAt);
  });

  it("非终态清算提交后发生同 Grant 新预占，旧 Attempt 重放不得再次扣减", async () => {
    const scenario = await seedNonterminalAccounting("replay-new-reserve");
    const repository = new GatewayLedgerRepository(db);
    await repository.persistAttemptUsageAccountingIfAbsent(scenario.input);
    await db.updateTable("quota_counter").set({ used_value: 19n })
      .where("grant_id", "=", scenario.grantId).execute();

    await expect(repository.persistAttemptUsageAccountingIfAbsent(scenario.input))
      .resolves.toMatchObject({ created: false });
    expect(BigInt((await db.selectFrom("quota_counter").select("used_value")
      .where("grant_id", "=", scenario.grantId).executeTakeFirstOrThrow()).used_value))
      .toBe(19n);
    expect(await repository.getRequest(scenario.fixture.requestId))
      .toMatchObject({ status: "IN_PROGRESS" });
  });

  it.each([
    ["http_status", 409],
    ["response_committed", true],
    ["error_classification", "INTERNAL"],
    ["error_code", "different_revocation"],
    ["switch_reason", "ROUTE_REVOKED"],
  ] as const)("非终态清算重放拒绝 Attempt 结果漂移：%s", async (field, value) => {
    const scenario = await seedNonterminalAccounting(`drift-${field.slice(0, 8)}`);
    const repository = new GatewayLedgerRepository(db);
    await repository.persistAttemptUsageAccountingIfAbsent(scenario.input);
    const drifted = {
      ...scenario.input,
      attempt_result: { ...scenario.input.attempt_result, [field]: value },
    };
    await expect(repository.persistAttemptUsageAccountingIfAbsent(drifted))
      .rejects.toThrow("settlement_attempt_result_conflict");
    expect(await repository.listLedgerLines(scenario.fixture.requestId)).toHaveLength(1);
  });

  it("Attempt UPDATE 被 PostgreSQL trigger 丢弃时，零事实与资源结算全部回滚", async () => {
    const scenario = await seedNonterminalAccounting("attempt-update-zero");
    const repository = new GatewayLedgerRepository(db);
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `pool043_skip_attempt_${suffix}`;
    const triggerName = `pool043_skip_attempt_trg_${suffix}`;
    await sql`CREATE FUNCTION ${sql.raw(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(db);
    await sql`CREATE TRIGGER ${sql.raw(triggerName)} BEFORE UPDATE ON upstream_attempt
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(functionName)}()`.execute(db);
    try {
      await expect(repository.persistAttemptUsageAccountingIfAbsent(scenario.input))
        .rejects.toThrow("settlement_attempt_result_conflict");
    } finally {
      await sql`DROP TRIGGER ${sql.raw(triggerName)} ON upstream_attempt`.execute(db);
      await sql`DROP FUNCTION ${sql.raw(functionName)}()`.execute(db);
    }
    expect(await repository.listUsageEvents(scenario.fixture.requestId)).toEqual([]);
    expect(await repository.listLedgerLines(scenario.fixture.requestId)).toEqual([]);
    expect(BigInt((await db.selectFrom("quota_counter").select("used_value")
      .where("grant_id", "=", scenario.grantId).executeTakeFirstOrThrow()).used_value))
      .toBe(scenario.reserved);
    expect((await db.selectFrom("concurrency_lease").select("released_at")
      .where("id", "=", scenario.leaseId).executeTakeFirstOrThrow()).released_at).toBeNull();
    expect(await db.selectFrom("upstream_attempt").select(["finished_at", "error_code"])
      .where("id", "=", scenario.fixture.attemptId).executeTakeFirstOrThrow())
      .toMatchObject({ finished_at: null, error_code: null });
  });

  it.each([
    { label: "quota-over", quota: 10n, actual: 15n, overage: 5n },
    { label: "quota-under", quota: 10n, actual: 9n, overage: 0n },
  ])("非终态清算按实际扣减重算额度与超额：$label", async ({ label, quota, actual, overage }) => {
    const scenario = await seedNonterminalAccounting(label, { quota, reserved: 37n });
    const repository = new GatewayLedgerRepository(db);
    scenario.input.quota_settlements![0]!.actual_deducted = actual;

    await repository.persistAttemptUsageAccountingIfAbsent(scenario.input);
    const counter = await db.selectFrom("quota_counter")
      .select(["used_value", "overage_value"])
      .where("grant_id", "=", scenario.grantId).executeTakeFirstOrThrow();
    expect(BigInt(counter.used_value)).toBe(actual);
    expect(BigInt(counter.overage_value)).toBe(overage);
  });

  it.each(["missing-counter", "enterprise-mismatch", "principal-mismatch"] as const)(
    "非终态清算拒绝不属于请求主体的额度事实：%s",
    async (kind) => {
      const scenario = await seedNonterminalAccounting(`identity-${kind.slice(0, 4)}`);
      let conflictingGrantId = scenario.grantId;
      if (kind === "missing-counter") {
        await db.deleteFrom("quota_counter").where("grant_id", "=", scenario.grantId).execute();
      } else if (kind === "enterprise-mismatch") {
        const otherEnterprise = await db.insertInto("enterprise").values({
          name: "额度企业身份冲突",
        }).returning("id").executeTakeFirstOrThrow();
        conflictingGrantId = (await db.insertInto("principal_grant").values({
          enterprise_id: otherEnterprise.id,
          principal_id: scenario.fixture.employeeId,
          provider: "acct-ent-conflict",
          model_alias: "ql-ent-conflict",
          quota_value: 1_000n,
          allow_overage: false,
        }).returning("id").executeTakeFirstOrThrow()).id;
        await db.insertInto("quota_counter").values({
          grant_id: conflictingGrantId,
          used_value: scenario.reserved,
        }).execute();
      } else {
        const otherPrincipal = await db.insertInto("principal").values({
          enterprise_id: scenario.fixture.enterpriseId,
          type: "EMPLOYEE",
          name: "额度身份冲突主体",
        }).returning("id").executeTakeFirstOrThrow();
        conflictingGrantId = (await db.insertInto("principal_grant").values({
          enterprise_id: scenario.fixture.enterpriseId,
          principal_id: otherPrincipal.id,
          provider: "acct-identity-other-principal",
          model_alias: "ql-identity-other-principal",
          quota_value: 1_000n,
          allow_overage: false,
        }).returning("id").executeTakeFirstOrThrow()).id;
        await db.insertInto("quota_counter").values({
          grant_id: conflictingGrantId,
          used_value: scenario.reserved,
        }).execute();
      }
      scenario.input.quota_settlements![0]!.grant_id = conflictingGrantId;
      const repository = new GatewayLedgerRepository(db);
      await expect(repository.persistAttemptUsageAccountingIfAbsent(scenario.input))
        .rejects.toThrow("settlement_quota_grant_conflict");
      expect(await repository.listUsageEvents(scenario.fixture.requestId)).toEqual([]);
      expect(await repository.listLedgerLines(scenario.fixture.requestId)).toEqual([]);
      expect(await repository.getRequest(scenario.fixture.requestId))
        .toMatchObject({ status: "IN_PROGRESS" });
    },
  );

  it.each(["enterprise-mismatch", "request-mismatch"] as const)(
    "非终态清算拒绝不属于本企业请求的租约：%s",
    async (kind) => {
      const scenario = await seedNonterminalAccounting(`lease-${kind.slice(0, 4)}`);
      let leaseEnterpriseId = scenario.fixture.enterpriseId;
      let leaseRequestId: string | null = scenario.fixture.requestId;
      if (kind === "enterprise-mismatch") {
        leaseEnterpriseId = (await db.insertInto("enterprise").values({
          name: "租约身份冲突企业",
        }).returning("id").executeTakeFirstOrThrow()).id;
      } else {
        leaseRequestId = null;
      }
      const conflictingLease = await db.insertInto("concurrency_lease").values({
        enterprise_id: leaseEnterpriseId,
        provider_resource_id: scenario.fixture.resourceId,
        ai_request_id: leaseRequestId,
        expires_at: new Date(Date.now() + 60_000),
      }).returning("id").executeTakeFirstOrThrow();
      scenario.input.release_lease_ids = [conflictingLease.id];
      const repository = new GatewayLedgerRepository(db);

      await expect(repository.persistAttemptUsageAccountingIfAbsent(scenario.input))
        .rejects.toThrow("settlement_lease_conflict");
      expect((await db.selectFrom("concurrency_lease").select("released_at")
        .where("id", "=", conflictingLease.id).executeTakeFirstOrThrow()).released_at).toBeNull();
      expect(await repository.listUsageEvents(scenario.fixture.requestId)).toEqual([]);
      expect(await repository.getRequest(scenario.fixture.requestId))
        .toMatchObject({ status: "IN_PROGRESS" });
    },
  );

  it("同一并发租约重复出现在输入时去重并只释放一次", async () => {
    const scenario = await seedNonterminalAccounting("duplicate-lease");
    scenario.input.release_lease_ids = [scenario.leaseId, scenario.leaseId];
    const repository = new GatewayLedgerRepository(db);
    await expect(repository.persistAttemptUsageAccountingIfAbsent(scenario.input))
      .resolves.toMatchObject({ created: true });
    expect((await db.selectFrom("concurrency_lease").select("released_at")
      .where("id", "=", scenario.leaseId).executeTakeFirstOrThrow()).released_at)
      .not.toBeNull();
  });

  it("无事实早退可幂等发布 terminal，随后所有结算写入口均 fail-closed", async () => {
    const fixture = await seedSettlementFixture(
      "guarded-terminal", { status: "IN_PROGRESS", createUsage: false },
    );
    const repository = new GatewayLedgerRepository(db);
    await removeSeededAttempt(fixture);
    await repository.updateRequestStatus(
      fixture.requestId, "FAILED", "CLIENT_INVALID", "request_rejected",
    );
    expect(await repository.getRequest(fixture.requestId)).toMatchObject({
      status: "FAILED",
      error_classification: "CLIENT_INVALID",
      error_code: "request_rejected",
    });
    await expect(repository.updateRequestStatus(
      fixture.requestId, "FAILED", "CLIENT_INVALID", "request_rejected",
    )).resolves.toBeUndefined();
    await expect(repository.updateRequestStatus(
      fixture.requestId, "FAILED", "CLIENT_INVALID", "different_error",
    )).rejects.toThrow("settlement_terminal_conflict");
    await expect(repository.updateAttemptResult(fixture.attemptId, {
      switch_reason: "late-update",
    })).rejects.toThrow("settlement_attempt_not_found");
    await expect(repository.createUsageEventIfAbsent(fixture.atomic.usage))
      .rejects.toThrow("settlement_request_terminal");
    await expect(repository.createLedgerLine(fixture.line))
      .rejects.toThrow("settlement_request_terminal");
    await expect(repository.createLedgerTransactionIfAbsent(finalizationFor(fixture)))
      .rejects.toThrow("settlement_request_terminal");
  });

  it("不同企业同月屏障相互独立", async () => {
    const firstEnterpriseId = randomUUID();
    const secondEnterpriseId = randomUUID();
    let markReady!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction().execute(async (trx) => {
      await acquireOperatingBillMonthWriteBarrier(trx, firstEnterpriseId, "2026-08");
      markReady();
      await released;
    });
    await ready;
    try {
      await expect(db.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx);
        await acquireOperatingBillMonthWriteBarrier(trx, secondEnterpriseId, "2026-08");
      })).resolves.toBeUndefined();
    } finally {
      release();
      await blocker;
    }
  });
});
