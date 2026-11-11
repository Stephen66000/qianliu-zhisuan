/**
 * API 费用估算聚合语义定向集成测试（WP1 S2 / task 2.2）。
 *
 * 依据：OpenSpec change simplify-api-cost-and-official-balance
 *   - specs/api-cost-estimation ACE-04（保留未知与已知部分）、ACE-05（按消费事实
 *     而非成功次数汇总：失败/重试计入、重复结算只计一次、历史处置保留）；
 *   - handoff/acceptance-plan.md §3 夹具 F02/F03（AT-ACE-09/10、AT-X03 服务层前提）；
 *   - WP1 plan.md §4 决策 2/3（重复终态幂等由 dedup/IfAbsent 保证、历史处置可追溯）。
 *
 * 覆盖（合同 S2 §1.1-§1.5）：
 *   1) 失败 Attempt 与重试都计入（ACE-05 场景 1 / F03）：同一请求 Attempt1 失败但
 *      已计价 0.01000000 CNY + Attempt2 成功计价 0.02000000 CNY →
 *      amounts=[{CNY,"0.03000000"}]、KNOWN_COMPLETE；两行 attempt 事实各自保留，
 *      不因失败状态被剔除。结算走真实入口 persistAttemptUsageAccountingIfAbsent
 *      （apps/gateway pipeline attempt-usage-settlement.ts 的 failover 路径：request
 *      保持 IN_PROGRESS，attempt_result 冻结失败/成功终态）。
 *   2) 重复终态只计一次（plan §4 决策 2 / AT-X03）：以相同 dedup 证据
 *      （dedup_key=<requestId>:attempt<N>）重复提交同一终态 → created=false、
 *      每个 Attempt 仍只一行，聚合仍 0.03000000（不得 0.04/0.06）；
 *      §1.2b 进一步覆盖“事务回滚 → 重放”：结算事务中途回滚零残留，随后对同一
 *      Attempt 重放结算仍只计一次（行数与金额不变、dedup 证据唯一）——结算事务
 *      约束不可移除（重复终态幂等在回滚后仍成立，AT-X03 回滚轮）。
 *   3) 历史处置不变（ACE-05 场景 2 / AT-ACE-10）：0086/0091 合法处置
 *      （provider_finance_usage_cost_disposition）在新读取下仍生效——
 *      excludedNoRecordedCost=1、无 PRICE_MISSING/USAGE_UNKNOWN 误报；原始 ledger 行
 *      与处置记录内容不被聚合读取改写（前后快照对比）；
 *      loadExcludedUsageCostLineIds 对同一行仍返回排除。
 *   4) 请求内混币不被合并（F-020 延伸 / ACE-07）：同一请求两条已计价行分属 CNY/USD
 *      → 聚合两桶分列、无混币总额、无缺口（行级币种已知即完整）。
 *   5) 零费用与未知并存（ACE-04 组合）：同期间 CONFIRMED_ZERO_NO_UPSTREAM +
 *      已计价 1 元 + UNKNOWN → amounts=[1 CNY]、KNOWN_PARTIAL、USAGE_UNKNOWN=1、
 *      零费用行不产生缺口。
 *
 * 夹具惯例：沿用 S1 api-cost-estimation.integration.test.ts（每场景独立企业、绝不写
 * 资金表/期初）；结算路径沿用 gateway-compat-cost-status.integration.test.ts 的
 * GatewayLedgerRepository facade。不修改上述既有测试文件。
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, loadApiCostEstimation, GatewayLedgerRepository,
  loadExcludedUsageCostLineIds, type ApiCostEstimationGap,
} from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const start = new Date("2026-09-01T00:00:00+08:00");
const end = new Date("2026-10-01T00:00:00+08:00");

beforeAll(async () => {
  pg = await startPostgresContainer("api_cost_estimation_attempts");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

interface Fixture {
  enterpriseId: string;
  adminId: string;
  principalId: string;
  keyId: string;
  resourceId: string;
}

/** 每个场景独立企业；绝不写 provider_finance_event/快照/期初（ACE-03 前提）。 */
async function fixture(): Promise<Fixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "API 估算语义测试" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: adminId,
    password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工",
    person_id: null, owner_person_id: null, department_label: null,
    created_at: new Date("2026-08-01T00:00:00+08:00"),
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_test", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "api 资源", mode: "API",
    credential_type: "API_KEY", created_at: new Date("2026-08-01T00:00:00+08:00"),
  }).returning("id").executeTakeFirstOrThrow();
  return { enterpriseId, adminId, principalId, keyId, resourceId: resource.id };
}

/** 处于 failover 中途的请求：结算入口（lockInProgressRequest）要求 status=IN_PROGRESS。 */
async function seedInProgressRequest(f: Fixture): Promise<string> {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: f.enterpriseId, principal_id: f.principalId,
    principal_key_id: f.keyId, protocol: "chat", unified_model: "model",
    status: "IN_PROGRESS", started_at: new Date("2026-09-10T12:00:00+08:00"),
  }).execute();
  return requestId;
}

interface AttemptSpec {
  attemptNo: number;
  cost: string;
  currency: "CNY" | "USD";
  at: Date;
  result: {
    http_status: number;
    response_committed: boolean;
    error_classification: string | null;
    error_code: string | null;
    switch_reason: string | null;
  };
}

const FAILED_BUT_PRICED: AttemptSpec["result"] = {
  // 上游 5xx 失败（runtime-controls.mapToClassification → UPSTREAM_TEMPORARY），
  // 但厂商已在错误响应中上报用量并完成计价（ACE-05“有消费的失败”）。
  http_status: 502, response_committed: false,
  error_classification: "UPSTREAM_TEMPORARY", error_code: "upstream_502",
  switch_reason: "UPSTREAM_TEMPORARY",
};
const SUCCEEDED: AttemptSpec["result"] = {
  http_status: 200, response_committed: true,
  error_classification: null, error_code: null, switch_reason: null,
};

async function createAttempt(
  f: Fixture, repo: GatewayLedgerRepository, requestId: string, attemptNo: number,
): Promise<string> {
  const attempt = await repo.createAttempt({
    ai_request_id: requestId, enterprise_id: f.enterpriseId, attempt_no: attemptNo,
    provider_resource_id: f.resourceId, upstream_model: "model",
  });
  return attempt.id;
}

/** 真实结算入口（attempt-usage-settlement.ts 同构）：同一 spec 重放必须幂等。 */
async function settleAttemptFacts(
  f: Fixture, repo: GatewayLedgerRepository, requestId: string, attemptId: string, spec: AttemptSpec,
) {
  return repo.persistAttemptUsageAccountingIfAbsent({
    usage: {
      enterprise_id: f.enterpriseId, ai_request_id: requestId,
      upstream_attempt_id: attemptId, provider_resource_id: f.resourceId,
      input_tokens: 1000n, output_tokens: 100n, cache_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED",
      dedup_key: `${requestId}:attempt${spec.attemptNo}`,
    },
    ledger_line: {
      ai_request_id: requestId, enterprise_id: f.enterpriseId,
      upstream_attempt_id: attemptId, provider_resource_id: f.resourceId,
      principal_id: f.principalId, resource_mode: "API",
      raw_input_tokens: 1000n, raw_output_tokens: 100n, raw_cache_tokens: 0n,
      deducted_quota: null,
      api_cost: spec.cost, api_cost_currency: spec.currency,
      api_cost_status: "PRICED_USAGE",
      // F3：生产结算链自 9bf1560 起在 ledger_line.billing_rule_snapshot 冻结
      // 含 sourceStatus 的规则快照；夹具按生产形态补齐。
      billing_rule_snapshot: { sourceStatus: "VERIFIED" },
      settled_at: spec.at,
      usage_quality: "PROVIDER_REPORTED",
    },
    attempt_result: { ...spec.result, finished_at: spec.at },
  });
}

interface SeedLineInput {
  at: Date;
  cost: string | null;
  currency?: string | null;
  status: "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST" | "NOT_MIGRATED";
  usageQuality?: string;
  resourceOverride?: string;
}

async function seedLine(f: Fixture, input: SeedLineInput): Promise<{ id: string; requestId: string }> {
  const requestId = randomUUID();
  const resourceId = input.resourceOverride ?? f.resourceId;
  const at = input.at;
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: f.enterpriseId, principal_id: f.principalId,
    principal_key_id: f.keyId, protocol: "chat", unified_model: "model",
    status: "SUCCEEDED", started_at: at, finished_at: at,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: resourceId, upstream_model: "model", http_status: 200,
    response_committed: true, finished_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    provider_resource_id: resourceId, input_tokens: 1000n, output_tokens: 100n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: input.usageQuality ?? "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const line = await db.insertInto("ledger_line").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    usage_event_id: usage.id, provider_resource_id: resourceId, principal_id: f.principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: input.cost,
    // 0085 shape 约束：CONFIRMED_ZERO 行 api_cost=0 且币种必须为 NULL。
    api_cost_currency: (input.cost === null || input.currency === null)
      ? null : input.currency ?? "CNY",
    api_cost_status: input.status,
    // F3：生产已计价行自 9bf1560 起冻结含 sourceStatus 的快照；夹具按生产形态补齐。
    // CONFIRMED_ZERO 行生产恒 billing_rule_snapshot=null（rejectedAttemptEvidence），保持原样。
    billing_rule_snapshot: input.status === "PRICED_USAGE"
      ? { sourceStatus: "VERIFIED" } : null,
    usage_quality: input.usageQuality ?? "PROVIDER_REPORTED",
    settled_at: at, created_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  return { id: line.id, requestId };
}

/** 0086/0091 合法处置：冻结 to_jsonb(line)，仅对 UNKNOWN_COST 且无已记成本事实的行生效。 */
async function seedDisposition(f: Fixture, line: { id: string; requestId: string }) {
  const fact = await sql<{ fact: Record<string, unknown> }>`
    SELECT to_jsonb(line) AS fact FROM ledger_line line
    WHERE line.enterprise_id=${f.enterpriseId}::uuid AND line.id=${line.id}::uuid`.execute(db);
  await db.insertInto("provider_finance_usage_cost_disposition").values({
    enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId,
    ledger_line_id: line.id, ai_request_id: line.requestId,
    decision: "EXCLUDE_NO_SERVER_COST",
    original_ledger_fact: fact.rows[0]!.fact,
    server_cost_evidence: { request: line.requestId, policy: "server-recorded-cost-only", recordedCost: null },
    reason: "Administrator directs this exact unpriced record to be excluded from internal accounting",
    evidence_ref: `fixture-decision:${line.id}`,
    decided_by_admin_user_id: f.adminId,
    idempotency_key: randomUUID(),
    request_hash: createHash("sha256").update(line.id).digest("hex"),
  }).execute();
}

function gapOf(gaps: ApiCostEstimationGap[], reason: ApiCostEstimationGap["reason"]): number {
  return gaps.find((gap) => gap.reason === reason)?.count ?? 0;
}

describe("loadApiCostEstimation 聚合语义：失败/重试/重复终态/历史处置/混币/零费用（WP1 S2）", () => {
  it("§1.1 失败 Attempt 与重试都计入：0.01(失败已计价)+0.02(成功)=0.03、两行 attempt 事实各自保留（ACE-05 场景1/F03）", async () => {
    const f = await fixture();
    const repo = new GatewayLedgerRepository(db);
    const requestId = await seedInProgressRequest(f);
    const attempt1 = await createAttempt(f, repo, requestId, 1);
    const first = await settleAttemptFacts(f, repo, requestId, attempt1, {
      attemptNo: 1, cost: "0.01000000", currency: "CNY",
      at: new Date("2026-09-10T12:00:00+08:00"), result: FAILED_BUT_PRICED,
    });
    expect(first.created).toBe(true);
    const attempt2 = await createAttempt(f, repo, requestId, 2);
    const second = await settleAttemptFacts(f, repo, requestId, attempt2, {
      attemptNo: 2, cost: "0.02000000", currency: "CNY",
      at: new Date("2026-09-10T12:05:00+08:00"), result: SUCCEEDED,
    });
    expect(second.created).toBe(true);

    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "0.03000000" }]);
    expect(result.completeness).toBe("KNOWN_COMPLETE");
    expect(result.gaps).toEqual([]);
    expect(result.excludedNoRecordedCost).toBe(0);

    // 失败 Attempt 的事实不被剔除：两个 attempt 行、两条账本行各自保留并对应。
    const attempts = await db.selectFrom("upstream_attempt").selectAll()
      .where("ai_request_id", "=", requestId).orderBy("attempt_no", "asc").execute();
    expect(attempts.map((attempt) => [attempt.attempt_no, attempt.http_status])).toEqual([[1, 502], [2, 200]]);
    const lines = await db.selectFrom("ledger_line").selectAll()
      .where("ai_request_id", "=", requestId).orderBy("created_at", "asc").execute();
    expect(lines.map((line) => [line.upstream_attempt_id, String(line.api_cost), line.api_cost_status]))
      .toEqual([
        [attempt1, "0.01000000", "PRICED_USAGE"],
        [attempt2, "0.02000000", "PRICED_USAGE"],
      ]);
    const usageEvents = await db.selectFrom("usage_event").selectAll()
      .where("ai_request_id", "=", requestId).execute();
    expect(usageEvents).toHaveLength(2);
  });

  it("§1.2 重复终态只计一次：相同 dedup 证据重放不落新行、聚合仍 0.03000000（plan §4 决策2/AT-X03）", async () => {
    const f = await fixture();
    const repo = new GatewayLedgerRepository(db);
    const requestId = await seedInProgressRequest(f);
    const attempt1 = await createAttempt(f, repo, requestId, 1);
    await settleAttemptFacts(f, repo, requestId, attempt1, {
      attemptNo: 1, cost: "0.01000000", currency: "CNY",
      at: new Date("2026-09-10T12:00:00+08:00"), result: FAILED_BUT_PRICED,
    });
    const attempt2 = await createAttempt(f, repo, requestId, 2);
    await settleAttemptFacts(f, repo, requestId, attempt2, {
      attemptNo: 2, cost: "0.02000000", currency: "CNY",
      at: new Date("2026-09-10T12:05:00+08:00"), result: SUCCEEDED,
    });

    // 对两个 Attempt 分别以完全相同的终态证据重放（重试幂等）。
    const replay1 = await settleAttemptFacts(f, repo, requestId, attempt1, {
      attemptNo: 1, cost: "0.01000000", currency: "CNY",
      at: new Date("2026-09-10T12:00:00+08:00"), result: FAILED_BUT_PRICED,
    });
    const replay2 = await settleAttemptFacts(f, repo, requestId, attempt2, {
      attemptNo: 2, cost: "0.02000000", currency: "CNY",
      at: new Date("2026-09-10T12:05:00+08:00"), result: SUCCEEDED,
    });
    expect(replay1.created).toBe(false);
    expect(replay2.created).toBe(false);

    // 仅一行的硬保证：usage_event/ledger_line 均不因重放增多。
    const lineCount = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM ledger_line
      WHERE enterprise_id=${f.enterpriseId}::uuid AND ai_request_id=${requestId}::uuid`.execute(db);
    expect(lineCount.rows[0]!.count).toBe("2");
    const usageCount = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM usage_event
      WHERE enterprise_id=${f.enterpriseId}::uuid AND ai_request_id=${requestId}::uuid`.execute(db);
    expect(usageCount.rows[0]!.count).toBe("2");

    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "0.03000000" }]);
    expect(result.completeness).toBe("KNOWN_COMPLETE");
    expect(result.gaps).toEqual([]);
  });

  // AT-X03 回滚轮 / G26（acceptance-plan §6 AT-X03：「对 F03 重复提交同一 Attempt 结算；
  // 模拟一次既有事务回滚后再试——估算仍 0.03，Token 与内部额度各只计一次；不能移除
  // 结算事务约束」）：先正常结算两笔 Attempt 得 0.03 基线；再以故意的失败事务
  // （事务内写 usage+ledger 后 abort，模拟既有结算事务中途回滚）验证零残留；
  // 随后对同一 Attempt 以完全相同的终态证据重放结算——幂等仍成立（结算事务约束
  // persistAttemptUsageAccountingAtomically 的“首次成功以 ledger_line 创建为幂等提交点”
  // 在回滚后不被削弱）。
  it("§1.2b 事务回滚后重放：故意失败的事务零残留，同一 Attempt 重放仍只计一次（AT-X03/G26）", async () => {
    const f = await fixture();
    const repo = new GatewayLedgerRepository(db);
    const requestId = await seedInProgressRequest(f);
    const attempt1 = await createAttempt(f, repo, requestId, 1);
    await settleAttemptFacts(f, repo, requestId, attempt1, {
      attemptNo: 1, cost: "0.01000000", currency: "CNY",
      at: new Date("2026-09-10T12:00:00+08:00"), result: FAILED_BUT_PRICED,
    });
    const attempt2 = await createAttempt(f, repo, requestId, 2);
    await settleAttemptFacts(f, repo, requestId, attempt2, {
      attemptNo: 2, cost: "0.02000000", currency: "CNY",
      at: new Date("2026-09-10T12:05:00+08:00"), result: SUCCEEDED,
    });
    // 正常基线：0.03 口径。
    const baseline = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(baseline.amounts).toEqual([{ currency: "CNY", amount: "0.03000000" }]);

    // 故意失败的结算事务：事务内写入第三笔（usage+ledger）后 abort 回滚
    // （模拟既有结算事务中途回滚——如进程中断/约束失败导致的整体回退）。
    await expect(db.transaction().execute(async (trx) => {
      const ghostAttempt = await trx.insertInto("upstream_attempt").values({
        enterprise_id: f.enterpriseId, ai_request_id: requestId, attempt_no: 3,
        provider_resource_id: f.resourceId, upstream_model: "model",
        http_status: 200, response_committed: true,
        finished_at: new Date("2026-09-10T12:06:00+08:00"),
      }).returning("id").executeTakeFirstOrThrow();
      const ghostUsage = await trx.insertInto("usage_event").values({
        enterprise_id: f.enterpriseId, ai_request_id: requestId,
        upstream_attempt_id: ghostAttempt.id, provider_resource_id: f.resourceId,
        input_tokens: 1000n, output_tokens: 100n, cache_tokens: 0n, reasoning_tokens: 0n,
        usage_quality: "PROVIDER_REPORTED", dedup_key: `${requestId}:attempt3`,
        created_at: new Date("2026-09-10T12:06:00+08:00"),
      }).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("ledger_line").values({
        enterprise_id: f.enterpriseId, ai_request_id: requestId,
        upstream_attempt_id: ghostAttempt.id, usage_event_id: ghostUsage.id,
        provider_resource_id: f.resourceId, principal_id: f.principalId,
        resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
        raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
        api_cost: "9.99000000", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
        usage_quality: "PROVIDER_REPORTED", settled_at: new Date("2026-09-10T12:06:00+08:00"),
        created_at: new Date("2026-09-10T12:06:00+08:00"),
      }).execute();
      throw new Error("AT-X03 故障注入：模拟既有结算事务中途回滚");
    })).rejects.toThrow(/AT-X03 故障注入/);

    // 回滚零残留：attempt/usage/ledger 行数与金额与基线完全一致（幽灵第三笔不存在）。
    const counts = async () => {
      const [attempts, usage, lines] = await Promise.all([
        db.selectFrom("upstream_attempt")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("ai_request_id", "=", requestId).executeTakeFirstOrThrow(),
        db.selectFrom("usage_event")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("ai_request_id", "=", requestId).executeTakeFirstOrThrow(),
        db.selectFrom("ledger_line")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("ai_request_id", "=", requestId).executeTakeFirstOrThrow(),
      ]);
      return [attempts.count, usage.count, lines.count];
    };
    expect(await counts()).toEqual(["2", "2", "2"]);
    const afterRollback = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(afterRollback).toEqual(baseline);

    // 重放同一 Attempt（相同终态证据）：幂等仍成立——不落新行。
    const replay = await settleAttemptFacts(f, repo, requestId, attempt2, {
      attemptNo: 2, cost: "0.02000000", currency: "CNY",
      at: new Date("2026-09-10T12:05:00+08:00"), result: SUCCEEDED,
    });
    expect(replay.created).toBe(false);
    expect(await counts()).toEqual(["2", "2", "2"]);

    // 金额不变（仍 0.03，不因回滚+重放变成 0.05/更多）＋ dedup 证据唯一。
    const afterReplay = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(afterReplay).toEqual(baseline);
    expect(afterReplay.amounts).toEqual([{ currency: "CNY", amount: "0.03000000" }]);
    const dedupRows = await db.selectFrom("usage_event")
      .select(["dedup_key", ({ fn }) => fn.countAll<string>().as("count")])
      .where("ai_request_id", "=", requestId)
      .groupBy("dedup_key").execute();
    expect(dedupRows.map((row) => [row.dedup_key, row.count]).sort((left, right) =>
      left[0].localeCompare(right[0]))).toEqual([
      [`${requestId}:attempt1`, "1"],
      [`${requestId}:attempt2`, "1"],
    ]);
  });

  it("§1.3 历史处置不变：处置仍生效、无缺口误报、原始行与处置记录不被聚合读取改写（ACE-05 场景2）", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE" });
    const cancelled = await seedLine(f, { at: new Date("2026-09-11T12:00:00+08:00"),
      cost: null, status: "UNKNOWN_COST", usageQuality: "PROVIDER_REPORTED" });
    await seedDisposition(f, cancelled);

    // 聚合读取前的原始事实快照（处置投影要求 original_ledger_fact=to_jsonb(line)）。
    const lineBefore = await db.selectFrom("ledger_line").selectAll()
      .where("id", "=", cancelled.id).executeTakeFirstOrThrow();
    const dispositionBefore = await db.selectFrom("provider_finance_usage_cost_disposition")
      .selectAll().where("ledger_line_id", "=", cancelled.id).executeTakeFirstOrThrow();
    expect(await loadExcludedUsageCostLineIds(db, f.enterpriseId, cancelled.requestId))
      .toEqual(new Set([cancelled.id]));

    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "1.00000000" }]);
    expect(result.excludedNoRecordedCost).toBe(1);
    // 被排除行不重新引入缺口/误报：无 PRICE_MISSING、无 USAGE_UNKNOWN，金额完整。
    expect(gapOf(result.gaps, "PRICE_MISSING")).toBe(0);
    expect(gapOf(result.gaps, "USAGE_UNKNOWN")).toBe(0);
    expect(result.completeness).toBe("KNOWN_COMPLETE");

    // 聚合读取后逐字段对比：原始 ledger 行与处置记录内容均未被改写。
    const lineAfter = await db.selectFrom("ledger_line").selectAll()
      .where("id", "=", cancelled.id).executeTakeFirstOrThrow();
    const dispositionAfter = await db.selectFrom("provider_finance_usage_cost_disposition")
      .selectAll().where("ledger_line_id", "=", cancelled.id).executeTakeFirstOrThrow();
    expect(lineAfter).toEqual(lineBefore);
    expect(dispositionAfter).toEqual(dispositionBefore);
    // 处置投影对同一行仍返回排除（处置与冻结事实继续匹配）。
    expect(await loadExcludedUsageCostLineIds(db, f.enterpriseId, cancelled.requestId))
      .toEqual(new Set([cancelled.id]));
  });

  it("§1.4 请求内混币不被合并：同一请求 CNY/USD 两桶分列、无混币总额、无缺口（F-020 延伸/ACE-07）", async () => {
    const f = await fixture();
    const repo = new GatewayLedgerRepository(db);
    const requestId = await seedInProgressRequest(f);
    const attempt1 = await createAttempt(f, repo, requestId, 1);
    await settleAttemptFacts(f, repo, requestId, attempt1, {
      attemptNo: 1, cost: "1.00000000", currency: "CNY",
      at: new Date("2026-09-10T12:00:00+08:00"), result: SUCCEEDED,
    });
    const attempt2 = await createAttempt(f, repo, requestId, 2);
    await settleAttemptFacts(f, repo, requestId, attempt2, {
      attemptNo: 2, cost: "2.00000000", currency: "USD",
      at: new Date("2026-09-10T12:05:00+08:00"), result: SUCCEEDED,
    });

    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    // 两桶分列（按币种字典序），不存在任何混币总额桶。
    expect(result.amounts).toEqual([
      { currency: "CNY", amount: "1.00000000" },
      { currency: "USD", amount: "2.00000000" },
    ]);
    expect(result.amounts).toHaveLength(2);
    // 行级币种已知即完整：同一请求内的混币不产生缺口。
    expect(result.completeness).toBe("KNOWN_COMPLETE");
    expect(result.gaps).toEqual([]);
  });

  it("§1.5 零费用与未知并存：零行不产生缺口、UNKNOWN 计 USAGE_UNKNOWN、金额仅已知部分（ACE-04 组合）", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "0", currency: null, status: "CONFIRMED_ZERO_NO_UPSTREAM" });
    await seedLine(f, { at: new Date("2026-09-11T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE" });
    await seedLine(f, { at: new Date("2026-09-12T12:00:00+08:00"),
      cost: null, status: "UNKNOWN_COST", usageQuality: "UNKNOWN" });

    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "1.00000000" }]);
    expect(result.completeness).toBe("KNOWN_PARTIAL");
    // 唯一实质缺口是用量未知行；零费用行不产生实质缺口，也不把缺失数据视为零补进金额。
    // R3 曾预期附加 PRICE_BASIS_UNVERIFIED:1；返修轮 R4 总指挥采纳裁定 (b)：
    // basis_unverified_rows 补 CONFIRMED_ZERO_NO_UPSTREAM 排除（零确认行恒快照 NULL、
    // 无价格依据语义）→ 信息项不再计入明确零行，仅剩 USAGE_UNKNOWN。
    expect(result.gaps).toEqual([{ reason: "USAGE_UNKNOWN", count: 1 }]);
    expect(gapOf(result.gaps, "PRICE_MISSING")).toBe(0);
    expect(result.excludedNoRecordedCost).toBe(0);
  });
});
