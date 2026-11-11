/**
 * loadApiCostEstimationByResource 批量分组入口一致性回归（W20-10 / R2 性能修复）。
 *
 * 合同要求：多资源（≥3，含缺价行/未知行/多币种各至少 1）场景下，批量入口每资源
 * 结果与逐资源 loadApiCostEstimation（resourceIds:[id]）结果逐字段一致——
 * amounts 数组、completeness、gaps 计数、priceBasis 集合（本文件用整对象 toEqual
 * 覆盖全部字段，另加显式语义断言证明夹具确实含缺价/未知用量/多币种元素）。
 *
 * 覆盖：
 *   1) 单企业 5 资源（RA 明确零＋快照依据、RB 多币种＋缺价行、RC 未知用量＋处置排除、
 *      RD 期间零行、RE 有账本行但不在请求清单）批量一次读取 vs 逐资源调用逐字段一致；
 *      RE 不出现在批量结果（scope 隔离）；期间零行资源有条目且与单资源空期间语义一致；
 *   2) 空资源清单 → 空 Map（与 query.ts 无 API 资源时的逐资源循环空集同语义）；
 *   3) 请求清单重复 id 收敛为单一条目（防御，ANY 语义不变）。
 *
 * 一致性依据（实现侧）：api-cost-estimation.ts——批量版复用同一 estimationLinesSql、
 * 同一 ESTIMATE_COUNT_PROJECTION / ESTIMATE_PRICED_SUM 聚合片段、同一
 * assembleApiCostEstimation 派生，仅追加 GROUP BY provider_resource_id 维度。
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, loadApiCostEstimation,
  loadApiCostEstimationByResource, type ApiCostEstimationGap,
  type ApiCostEstimationGapReason } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const start = new Date("2026-09-01T00:00:00+08:00");
const end = new Date("2026-10-01T00:00:00+08:00");

beforeAll(async () => {
  pg = await startPostgresContainer("api_cost_estimation_by_resource");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

interface Fixture {
  enterpriseId: string;
  adminId: string;
  principalId: string;
  keyId: string;
  providerId: string;
}

async function fixture(): Promise<Fixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "批量估算一致性测试" }).execute();
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
  return { enterpriseId, adminId, principalId, keyId, providerId: provider.id };
}

async function createResource(f: Fixture, name: string): Promise<string> {
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: f.enterpriseId, provider_id: f.providerId, name, mode: "API",
    credential_type: "API_KEY", created_at: new Date("2026-08-01T00:00:00+08:00"),
  }).returning("id").executeTakeFirstOrThrow();
  return resource.id;
}

async function seedRule(f: Fixture, sourceStatus: "VERIFIED" | "UNVERIFIED") {
  return db.insertInto("billing_rule").values({
    enterprise_id: f.enterpriseId, rule_type: "API_PRICE",
    rule_version: `v-${sourceStatus.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    effective_from: new Date("2026-08-01T00:00:00+08:00"),
    cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004",
    currency: "CNY", priority: 10, source: "fixture", source_status: sourceStatus,
  }).returning(["id", "rule_version"]).executeTakeFirstOrThrow();
}

/** 与 api-cost-estimation.integration.test.ts 的 seedLine 同构（生产结算链落行形态）。 */
async function seedLine(
  f: Fixture,
  input: {
    at: Date;
    cost: string | null;
    currency?: string | null;
    status: "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST" | "NOT_MIGRATED";
    usageQuality?: string;
    rule?: { id: string; rule_version: string } | null;
    snapshot?: Record<string, unknown> | null;
    resourceId: string;
  },
): Promise<{ id: string; requestId: string }> {
  const requestId = randomUUID();
  const at = input.at;
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: f.enterpriseId, principal_id: f.principalId,
    principal_key_id: f.keyId, protocol: "chat", unified_model: "model",
    status: "SUCCEEDED", started_at: at, finished_at: at,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: input.resourceId, upstream_model: "model", http_status: 200,
    response_committed: true, finished_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    provider_resource_id: input.resourceId, input_tokens: 1000n, output_tokens: 100n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: input.usageQuality ?? "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const line = await db.insertInto("ledger_line").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    usage_event_id: usage.id, provider_resource_id: input.resourceId, principal_id: f.principalId,
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
    billing_rule_snapshot: input.snapshot ?? null,
  }).returning("id").executeTakeFirstOrThrow();
  return { id: line.id, requestId };
}

/** 0086 合同：处置冻结 to_jsonb(line)，仅对 UNKNOWN_COST 且无已记成本事实的行生效。 */
async function seedDisposition(f: Fixture, line: { id: string; requestId: string }, resourceId: string) {
  const fact = await sql<{ fact: Record<string, unknown> }>`
    SELECT to_jsonb(line) AS fact FROM ledger_line line
    WHERE line.enterprise_id=${f.enterpriseId}::uuid AND line.id=${line.id}::uuid`.execute(db);
  await db.insertInto("provider_finance_usage_cost_disposition").values({
    enterprise_id: f.enterpriseId, provider_resource_id: resourceId,
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

function gapOf(gaps: ApiCostEstimationGap[], reason: ApiCostEstimationGapReason): number {
  return gaps.find((gap) => gap.reason === reason)?.count ?? 0;
}

describe("loadApiCostEstimationByResource（批量分组入口，与逐资源调用逐字段一致）", () => {
  it("1) 五资源一次批量读取：每资源与 resourceIds:[id] 单资源调用整对象 toEqual；RE 隔离；RD 空期间有条目", async () => {
    const f = await fixture();
    const [ra, rb, rc, rd, re] = await Promise.all([
      createResource(f, "RA 快照依据+明确零"),
      createResource(f, "RB 多币种+缺价行"),
      createResource(f, "RC 未知用量+处置排除"),
      createResource(f, "RD 期间零行"),
      createResource(f, "RE 不在请求清单"),
    ]);
    const verifiedRule = await seedRule(f, "VERIFIED");
    const unverifiedRule = await seedRule(f, "UNVERIFIED");

    // RA：3 笔已计价（2 VERIFIED 快照＋1 UNVERIFIED 快照）＋1 明确零 → KNOWN_COMPLETE
    // ＋PRICE_BASIS_UNVERIFIED:1（金额 1+2+0.5=3.5 CNY）。
    await seedLine(f, { at: new Date("2026-09-02T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE",
      rule: verifiedRule, snapshot: { sourceStatus: "VERIFIED" }, resourceId: ra });
    await seedLine(f, { at: new Date("2026-09-03T12:00:00+08:00"),
      cost: "2.00000000", currency: "CNY", status: "PRICED_USAGE",
      rule: verifiedRule, snapshot: { sourceStatus: "VERIFIED" }, resourceId: ra });
    await seedLine(f, { at: new Date("2026-09-04T12:00:00+08:00"),
      cost: "0.50000000", currency: "CNY", status: "PRICED_USAGE",
      rule: unverifiedRule, snapshot: { sourceStatus: "UNVERIFIED" }, resourceId: ra });
    await seedLine(f, { at: new Date("2026-09-05T12:00:00+08:00"),
      cost: "0", currency: null, status: "CONFIRMED_ZERO_NO_UPSTREAM", resourceId: ra });

    // RB：多币种（CNY+USD）＋缺价行（UNKNOWN_COST、带规则与缺失价快照）→
    // KNOWN_PARTIAL＋PRICE_MISSING:1＋priceBasis 含 VERIFIED 规则行。
    await seedLine(f, { at: new Date("2026-09-06T12:00:00+08:00"),
      cost: "1.00000000", currency: "CNY", status: "PRICED_USAGE",
      rule: verifiedRule, snapshot: { sourceStatus: "VERIFIED" }, resourceId: rb });
    await seedLine(f, { at: new Date("2026-09-07T12:00:00+08:00"),
      cost: "2.50000000", currency: "USD", status: "PRICED_USAGE", resourceId: rb });
    await seedLine(f, { at: new Date("2026-09-08T12:00:00+08:00"),
      cost: null, status: "UNKNOWN_COST", usageQuality: "PROVIDER_REPORTED",
      rule: verifiedRule,
      snapshot: { pricingMode: "ABSOLUTE", ruleType: "API_PRICE", currency: "CNY",
        cacheHitPrice: null, cacheMissPrice: "0.0000001", outputPrice: "0.000002",
        sourceStatus: "VERIFIED" },
      resourceId: rb });

    // RC：未知用量行（usage_quality UNKNOWN、无成本）＋处置排除行 →
    // KNOWN_PARTIAL＋USAGE_UNKNOWN:1＋excludedNoRecordedCost=1、金额桶为空。
    await seedLine(f, { at: new Date("2026-09-09T12:00:00+08:00"),
      cost: null, status: "UNKNOWN_COST", usageQuality: "UNKNOWN", resourceId: rc });
    const excludedLine = await seedLine(f, { at: new Date("2026-09-10T12:00:00+08:00"),
      cost: null, status: "UNKNOWN_COST", usageQuality: "PROVIDER_REPORTED", resourceId: rc });
    await seedDisposition(f, excludedLine, rc);

    // RE：有账本行但不在请求清单——批量结果不得包含，其行也不得混入其他资源金额。
    await seedLine(f, { at: new Date("2026-09-11T12:00:00+08:00"),
      cost: "9.90000000", currency: "CNY", status: "PRICED_USAGE", resourceId: re });
    // RD：期间零行（不种任何账本行）。

    const batch = await loadApiCostEstimationByResource(db, f.enterpriseId, {
      start, end, resourceIds: [ra, rb, rc, rd],
    });
    // scope 隔离：仅返回请求清单内的资源条目。
    expect([...batch.keys()].sort()).toEqual([ra, rb, rc, rd].sort());

    // 核心合同：每资源整对象与逐资源单资源调用逐字段一致（scope/period/amounts/
    // completeness/gaps/priceBasis/excludedNoRecordedCost 全字段）。
    for (const resourceId of [ra, rb, rc, rd]) {
      const single = await loadApiCostEstimation(db, f.enterpriseId, {
        start, end, resourceIds: [resourceId],
      });
      expect(batch.get(resourceId)).toEqual(single);
    }

    // 显式语义断言（证明夹具确实覆盖合同要素：多币种/缺价/未知/明确零/处置排除/空期间）。
    const raEstimation = batch.get(ra)!;
    expect(raEstimation.amounts).toEqual([{ currency: "CNY", amount: "3.50000000" }]);
    expect(raEstimation.completeness).toBe("KNOWN_COMPLETE");
    expect(gapOf(raEstimation.gaps, "PRICE_BASIS_UNVERIFIED")).toBe(1);
    // priceBasis 集合相等（SQL 按 rule_id 排序，UUID 随机故断言不依赖顺序）。
    expect(raEstimation.priceBasis).toHaveLength(2);
    expect(raEstimation.priceBasis).toEqual(expect.arrayContaining([
      { ruleId: unverifiedRule.id, ruleVersion: unverifiedRule.rule_version, sourceStatus: "UNVERIFIED" },
      { ruleId: verifiedRule.id, ruleVersion: verifiedRule.rule_version, sourceStatus: "VERIFIED" },
    ]));

    const rbEstimation = batch.get(rb)!;
    // 多币种分列不混加（amounts 数组逐字段）。
    expect(rbEstimation.amounts).toEqual([
      { currency: "CNY", amount: "1.00000000" },
      { currency: "USD", amount: "2.50000000" },
    ]);
    expect(rbEstimation.completeness).toBe("KNOWN_PARTIAL");
    expect(gapOf(rbEstimation.gaps, "PRICE_MISSING")).toBe(1);
    expect(rbEstimation.priceBasis).toEqual([
      { ruleId: verifiedRule.id, ruleVersion: verifiedRule.rule_version, sourceStatus: "VERIFIED" },
    ]);

    const rcEstimation = batch.get(rc)!;
    expect(rcEstimation.amounts).toEqual([]);
    expect(rcEstimation.completeness).toBe("KNOWN_PARTIAL");
    expect(gapOf(rcEstimation.gaps, "USAGE_UNKNOWN")).toBe(1);
    expect(rcEstimation.excludedNoRecordedCost).toBe(1);

    // 期间零行资源：有条目且与单资源空期间语义一致（KNOWN_COMPLETE＋空 amounts/gaps）。
    const rdEstimation = batch.get(rd)!;
    expect(rdEstimation.completeness).toBe("KNOWN_COMPLETE");
    expect(rdEstimation.amounts).toEqual([]);
    expect(rdEstimation.gaps).toEqual([]);
    expect(rdEstimation.scope).toEqual({ enterpriseId: f.enterpriseId, resourceIds: [rd] });

    // RE 不在批量结果，其 9.90 行不泄漏进任何所请求资源的金额。
    expect(batch.has(re)).toBe(false);
    expect(raEstimation.amounts.every((row) => row.amount === "3.50000000")).toBe(true);
  });

  it("2) 空资源清单 → 空 Map（与 query.ts 无 API 资源时的逐资源循环空集同语义）", async () => {
    const f = await fixture();
    const batch = await loadApiCostEstimationByResource(db, f.enterpriseId, {
      start, end, resourceIds: [],
    });
    expect(batch.size).toBe(0);
  });

  it("3) 请求清单重复 id 收敛为单一条目，取值与单资源调用一致", async () => {
    const f = await fixture();
    const resourceId = await createResource(f, "重复 id 资源");
    await seedLine(f, { at: new Date("2026-09-12T12:00:00+08:00"),
      cost: "4.20000000", currency: "CNY", status: "PRICED_USAGE", resourceId });
    const batch = await loadApiCostEstimationByResource(db, f.enterpriseId, {
      start, end, resourceIds: [resourceId, resourceId],
    });
    expect(batch.size).toBe(1);
    const single = await loadApiCostEstimation(db, f.enterpriseId, {
      start, end, resourceIds: [resourceId],
    });
    expect(batch.get(resourceId)).toEqual(single);
    expect(batch.get(resourceId)!.amounts).toEqual([{ currency: "CNY", amount: "4.20000000" }]);
  });
});
