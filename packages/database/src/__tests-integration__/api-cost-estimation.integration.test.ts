/**
 * API 费用估算统一聚合入口集成测试（WP1 C1 / S1 合同 §5）。
 *
 * 覆盖：
 *   a) 无任何资金表数据（不建 provider_finance_event/快照/期初）的企业，已计价行 →
 *      amounts 正常产出（ACE-03 / AT-ACE-05 服务层核心）；
 *   b) 1 CNY + 2 USD 分列，两桶分别正确，绝不混币相加（ACE-07）；
 *   c) 已计价 1+2 元 + 用量已知缺价格行 → amounts=[3 CNY] + KNOWN_PARTIAL + PRICE_MISSING=1
 *      （F02 / ACE-04 场景 1）；
 *   d) 仅 CONFIRMED_ZERO_NO_UPSTREAM → ZERO_CONFIRMED、无缺口（ACE-04 场景 2）；
 *   e) 处置排除行 → excludedNoRecordedCost=1、无该缺口、金额不变（ACE-05 场景 2 前提）；
 *   f) price_basis 含 ruleId/ruleVersion/sourceStatus；UNVERIFIED 计价行触发
 *      PRICE_BASIS_UNVERIFIED 计数且不影响 completeness；
 *   g) 迁移 0093：billing_rule.source_status 存在、存量默认 UNVERIFIED、CHECK 拒绝非法值、
 *      down 可回滚、重放后数据保留。
 * 另记录合同语义：期间无任何 API 行 → KNOWN_COMPLETE + 空 amounts（S1 §3.3）。
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, loadApiCostEstimation,
  type ApiCostEstimationGap } from "../index.js";
import { rollbackTo } from "./migration-rollback.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const start = new Date("2026-09-01T00:00:00+08:00");
const end = new Date("2026-10-01T00:00:00+08:00");

beforeAll(async () => {
  pg = await startPostgresContainer("api_cost_estimation");
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

/** 每个场景独立企业；绝不写 provider_finance_event/快照/期初（ACE-03 核心前提）。 */
async function fixture(): Promise<Fixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "API 估算测试" }).execute();
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

async function seedRule(f: Fixture, sourceStatus: "VERIFIED" | "UNVERIFIED") {
  const rule = await db.insertInto("billing_rule").values({
    enterprise_id: f.enterpriseId, rule_type: "API_PRICE",
    rule_version: `v-${sourceStatus.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    effective_from: new Date("2026-08-01T00:00:00+08:00"),
    cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004",
    currency: "CNY", priority: 10, source: "fixture", source_status: sourceStatus,
  }).returning(["id", "rule_version"]).executeTakeFirstOrThrow();
  return rule;
}

interface SeedLineInput {
  at: Date;
  cost: string | null;
  currency?: string | null;
  status: "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST" | "NOT_MIGRATED";
  usageQuality?: string;
  rule?: { id: string; rule_version: string } | null;
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
    usage_quality: input.usageQuality ?? "PROVIDER_REPORTED",
    settled_at: at, created_at: at,
    billing_rule_id: input.rule?.id ?? null,
    rule_version: input.rule?.rule_version ?? null,
  }).returning("id").executeTakeFirstOrThrow();
  return { id: line.id, requestId };
}

/** 0086 合法处置：冻结 to_jsonb(line)，仅对 UNKNOWN_COST 且无已记成本事实的行生效。 */
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

describe("loadApiCostEstimation（同源费用估算，不依赖资金数据）", () => {
  it("a) 无资金表数据的企业：已计价行正常产出 amounts（ACE-03/AT-ACE-05）", async () => {
    const f = await fixture();
    const rule = await seedRule(f, "VERIFIED");
    await seedLine(f, {
      at: new Date("2026-09-10T12:00:00+08:00"), cost: "0.00104000",
      currency: "CNY", status: "PRICED_USAGE", rule,
    });
    // ACE-02 场景：输入含缓存命中的分项计价字面值（600×1 + 400×0.1 + 200×2)/1e6 = 0.00104。
    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.scope).toEqual({ enterpriseId: f.enterpriseId, resourceIds: null });
    expect(result.period).toEqual({ start, end });
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "0.00104000" }]);
    expect(result.completeness).toBe("KNOWN_COMPLETE");
    expect(result.gaps).toEqual([]);
    expect(result.excludedNoRecordedCost).toBe(0);
    // 资金域表保持空：估算读取不依赖它们（集成层面证明 ACE-03）。
    const financeEvents = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM provider_finance_event
      WHERE enterprise_id=${f.enterpriseId}::uuid`.execute(db);
    expect(financeEvents.rows[0]!.count).toBe("0");
  });

  it("b) 1 CNY + 2 USD 分列，两桶分别正确、绝不混币相加（ACE-07）", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE" });
    await seedLine(f, { at: new Date("2026-09-11T12:00:00+08:00"),
      cost: "2.00000000", currency: "USD", status: "PRICED_USAGE" });
    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.amounts).toEqual([
      { currency: "CNY", amount: "1.00000000" },
      { currency: "USD", amount: "2.00000000" },
    ]);
    expect(result.amounts).toHaveLength(2); // 不存在混币总额桶
    expect(result.completeness).toBe("KNOWN_COMPLETE");
    expect(result.gaps).toEqual([]);
  });

  it("b2) resourceIds 过滤：scope 原样回显且只聚合所选资源", async () => {
    const f = await fixture();
    const provider = await db.insertInto("provider").values({
      enterprise_id: f.enterpriseId, code: "openai", name: "OpenAI",
      adapter_type: "OPENAI_COMPATIBLE",
    }).returning("id").executeTakeFirstOrThrow();
    const other = await db.insertInto("provider_resource").values({
      enterprise_id: f.enterpriseId, provider_id: provider.id, name: "另一个 API 资源",
      mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE" });
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "5.00000000", currency: "CNY", status: "PRICED_USAGE", resourceOverride: other.id });
    const result = await loadApiCostEstimation(db, f.enterpriseId,
      { start, end, resourceIds: [f.resourceId] });
    expect(result.scope.resourceIds).toEqual([f.resourceId]);
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "1.00000000" }]);
  });

  it("c) 已计价 1+2 元 + 用量已知缺价格行 → [3 CNY] + KNOWN_PARTIAL + PRICE_MISSING=1（F02/ACE-04）", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE" });
    await seedLine(f, { at: new Date("2026-09-11T12:00:00+08:00"),
      cost: "2.00000000", currency: "CNY", status: "PRICED_USAGE" });
    await seedLine(f, { at: new Date("2026-09-12T12:00:00+08:00"),
      cost: null, status: "UNKNOWN_COST", usageQuality: "PROVIDER_REPORTED" });
    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "3.00000000" }]);
    expect(result.completeness).toBe("KNOWN_PARTIAL");
    expect(gapOf(result.gaps, "PRICE_MISSING")).toBe(1);
    expect(result.excludedNoRecordedCost).toBe(0);
  });

  it("d) 仅 CONFIRMED_ZERO_NO_UPSTREAM → ZERO_CONFIRMED、无缺口（ACE-04 场景 2）", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "0", currency: null, status: "CONFIRMED_ZERO_NO_UPSTREAM" });
    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.amounts).toEqual([]);
    expect(result.completeness).toBe("ZERO_CONFIRMED");
    expect(result.gaps).toEqual([]);
    expect(result.excludedNoRecordedCost).toBe(0);
  });

  it("e) 处置排除行 → excludedNoRecordedCost=1、无该缺口、金额不变（ACE-05 场景 2）", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE" });
    const cancelled = await seedLine(f, { at: new Date("2026-09-11T12:00:00+08:00"),
      cost: null, status: "UNKNOWN_COST", usageQuality: "PROVIDER_REPORTED" });
    await seedDisposition(f, cancelled);
    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "1.00000000" }]);
    expect(result.excludedNoRecordedCost).toBe(1);
    expect(result.completeness).toBe("KNOWN_COMPLETE");
    expect(result.gaps).toEqual([]);
  });

  it("f) priceBasis 含 ruleId/ruleVersion/sourceStatus；UNVERIFIED 计价行触发 PRICE_BASIS_UNVERIFIED 且不影响 completeness", async () => {
    const f = await fixture();
    const unverified = await seedRule(f, "UNVERIFIED");
    const verified = await seedRule(f, "VERIFIED");
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE", rule: unverified });
    await seedLine(f, { at: new Date("2026-09-11T12:00:00+08:00"),
      cost: "2.00000000", currency: "CNY", status: "PRICED_USAGE", rule: verified });
    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.priceBasis).toEqual([
      { ruleId: verified.id, ruleVersion: verified.rule_version, sourceStatus: "VERIFIED" },
      { ruleId: unverified.id, ruleVersion: unverified.rule_version, sourceStatus: "UNVERIFIED" },
    ].sort((x, y) => x.ruleId.localeCompare(y.ruleId)));
    expect(gapOf(result.gaps, "PRICE_BASIS_UNVERIFIED")).toBe(1);
    // 信息性缺口不改变完整性（两行均已计价，无其他缺口）。
    expect(result.completeness).toBe("KNOWN_COMPLETE");
    expect(result.amounts).toEqual([{ currency: "CNY", amount: "3.00000000" }]);
  });

  it("s1§3.3 语义记录：期间无任何 API 行 → KNOWN_COMPLETE + 空 amounts", async () => {
    const f = await fixture();
    const result = await loadApiCostEstimation(db, f.enterpriseId,
      { start: new Date("2026-09-01T00:00:00+08:00"), end: new Date("2026-09-02T00:00:00+08:00") });
    expect(result.amounts).toEqual([]);
    expect(result.completeness).toBe("KNOWN_COMPLETE");
    expect(result.gaps).toEqual([]);
    expect(result.excludedNoRecordedCost).toBe(0);
    expect(result.priceBasis).toEqual([]);
  });

  it("s1§3.3 语义记录：NOT_MIGRATED/USAGE_UNKNOWN 各自成缺口", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: null, status: "NOT_MIGRATED", usageQuality: "PROVIDER_REPORTED" });
    await seedLine(f, { at: new Date("2026-09-11T12:00:00+08:00"),
      cost: null, status: "UNKNOWN_COST", usageQuality: "UNKNOWN" });
    const result = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(result.completeness).toBe("KNOWN_PARTIAL");
    expect(gapOf(result.gaps, "NOT_MIGRATED")).toBe(1);
    expect(gapOf(result.gaps, "USAGE_UNKNOWN")).toBe(1);
    expect(gapOf(result.gaps, "PRICE_MISSING")).toBe(0);
  });
});

describe("0093 billing_rule.source_status 迁移与回滚（S1 §5g）", () => {
  it("存量默认 UNVERIFIED、CHECK 拒绝非法值、down 可回滚、重放保留 UNVERIFIED", async () => {
    const migrationPg = await startPostgresContainer("api_cost_estimation_0093");
    const migrationDb = createKysely(migrationPg.connectionString);
    try {
      await migrateToLatest(migrationDb);
      const enterpriseId = "11111111-1111-4111-8111-111111111111";
      await migrationDb.insertInto("enterprise").values({ id: enterpriseId, name: "0093 测试" }).execute();
      // 1) 新列存在且存量/缺省为 UNVERIFIED。
      await sql`
        INSERT INTO billing_rule (enterprise_id, rule_type, rule_version, effective_from, cache_miss_price)
        VALUES (${enterpriseId}::uuid, 'API_PRICE', 'legacy-v1', NOW(), 0.000001)`.execute(migrationDb);
      const defaulted = await sql<{ source_status: string }>`
        SELECT source_status FROM billing_rule WHERE rule_version='legacy-v1'`.execute(migrationDb);
      expect(defaulted.rows[0]!.source_status).toBe("UNVERIFIED");
      // 2) CHECK 约束拒绝非法取值。
      await expect(sql`
        UPDATE billing_rule SET source_status='OFFICIAL' WHERE rule_version='legacy-v1'`.execute(migrationDb))
        .rejects.toThrow(/billing_rule_source_status_check/);
      // 3) down 回滚到 0092：列消失。
      const rolledBack = await rollbackTo(migrationDb, "0092_employee_monthly_quota");
      expect(rolledBack.at(-1)).toBe("0092_employee_monthly_quota");
      expect(rolledBack).toContain("0093_billing_rule_source_status");
      const columns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='billing_rule' AND column_name='source_status'`.execute(migrationDb);
      expect(columns.rows).toEqual([]);
      // 4) 重放到最新：列恢复，存量行按 DEFAULT 保持 UNVERIFIED。
      const executed = await migrateToLatest(migrationDb);
      expect(executed).toContain("0093_billing_rule_source_status");
      const restored = await sql<{ source_status: string }>`
        SELECT source_status FROM billing_rule WHERE rule_version='legacy-v1'`.execute(migrationDb);
      expect(restored.rows[0]!.source_status).toBe("UNVERIFIED");
    } finally {
      await migrationDb.destroy();
      await migrationPg.stop();
    }
  }, 120_000);
});
