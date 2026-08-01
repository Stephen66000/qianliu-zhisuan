import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, UsageRepository } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

interface SeededUsage {
  enterpriseId: string;
  otherEnterpriseId: string;
  principalId: string;
  providerId: string;
  finalResourceId: string;
  overageRequestId: string;
}

async function seedUsage(): Promise<SeededUsage> {
  const enterpriseId = randomUUID();
  const otherEnterpriseId = randomUUID();
  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "用量筛选企业" },
    { id: otherEnterpriseId, name: "隔离企业" },
  ]).execute();

  const providerId = randomUUID();
  const resourceA = randomUUID();
  const resourceB = randomUUID();
  await db.insertInto("provider").values({
    id: providerId,
    enterprise_id: enterpriseId,
    code: "zhipu",
    name: "智谱",
    adapter_type: "zhipu",
  }).execute();
  await db.insertInto("provider_resource").values([
    {
      id: resourceA,
      enterprise_id: enterpriseId,
      provider_id: providerId,
      name: "首选资源",
      mode: "CODING_PLAN",
      credential_type: "API_KEY",
    },
    {
      id: resourceB,
      enterprise_id: enterpriseId,
      provider_id: providerId,
      name: "最终资源",
      mode: "CODING_PLAN",
      credential_type: "API_KEY",
    },
  ]).execute();

  const principalId = randomUUID();
  const otherPrincipalId = randomUUID();
  await db.insertInto("principal").values([
    { id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "王小明研发" },
    { id: otherPrincipalId, enterprise_id: otherEnterpriseId, type: "EMPLOYEE", name: "王小明隔离" },
  ]).execute();
  const keyId = randomUUID();
  const otherKeyId = randomUUID();
  await db.insertInto("principal_key").values([
    {
      id: keyId,
      enterprise_id: enterpriseId,
      principal_id: principalId,
      key_prefix: "sk-usage",
      key_digest: `digest-${randomUUID()}`,
      status: "ACTIVE",
    },
    {
      id: otherKeyId,
      enterprise_id: otherEnterpriseId,
      principal_id: otherPrincipalId,
      key_prefix: "sk-other",
      key_digest: `digest-${randomUUID()}`,
      status: "ACTIVE",
    },
  ]).execute();

  const overageRequestId = randomUUID();
  const normalRequestId = randomUUID();
  const isolatedRequestId = randomUUID();
  const now = Date.now();
  await db.insertInto("ai_request").values([
    {
      id: overageRequestId,
      enterprise_id: enterpriseId,
      principal_id: principalId,
      principal_key_id: keyId,
      protocol: "chat",
      unified_model: "qianliu-glm",
      client_id: "WorkBuddy",
      status: "SUCCEEDED",
      started_at: new Date(now - 2_000),
      finished_at: new Date(now - 1_000),
    },
    {
      id: normalRequestId,
      enterprise_id: enterpriseId,
      principal_id: principalId,
      principal_key_id: keyId,
      protocol: "chat",
      unified_model: "qianliu-glm",
      client_id: "Codex",
      status: "FAILED",
      started_at: new Date(now - 4_000),
      finished_at: new Date(now - 3_000),
    },
    {
      id: isolatedRequestId,
      enterprise_id: otherEnterpriseId,
      principal_id: otherPrincipalId,
      principal_key_id: otherKeyId,
      protocol: "chat",
      unified_model: "qianliu-glm",
      client_id: "WorkBuddy",
      status: "SUCCEEDED",
      started_at: new Date(now - 2_000),
      finished_at: new Date(now - 1_000),
    },
  ]).execute();
  await db.insertInto("ledger_transaction").values([
    {
      ai_request_id: overageRequestId,
      enterprise_id: enterpriseId,
      principal_id: principalId,
      total_deducted_quota: 120n,
      total_api_cost: "0",
      overage: true,
      usage_quality: "PROVIDER_REPORTED",
      attempt_count: 2,
      created_at: new Date(now),
    },
    {
      ai_request_id: normalRequestId,
      enterprise_id: enterpriseId,
      principal_id: principalId,
      total_deducted_quota: 10n,
      total_api_cost: "0",
      overage: false,
      usage_quality: "PROVIDER_REPORTED",
      attempt_count: 0,
      created_at: new Date(now - 3_000),
    },
    {
      ai_request_id: isolatedRequestId,
      enterprise_id: otherEnterpriseId,
      principal_id: otherPrincipalId,
      total_deducted_quota: 999n,
      total_api_cost: "0",
      overage: true,
      usage_quality: "PROVIDER_REPORTED",
      attempt_count: 0,
      created_at: new Date(now),
    },
  ]).execute();

  for (const [attemptNo, resourceId] of [[1, resourceA], [2, resourceB]] as const) {
    const attempt = await db.insertInto("upstream_attempt").values({
      ai_request_id: overageRequestId,
      enterprise_id: enterpriseId,
      attempt_no: attemptNo,
      provider_resource_id: resourceId,
      upstream_model: "glm-4.6",
      response_committed: attemptNo === 2,
    }).returningAll().executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      ai_request_id: overageRequestId,
      enterprise_id: enterpriseId,
      upstream_attempt_id: attempt.id,
      provider_resource_id: resourceId,
      input_tokens: 40n,
      output_tokens: 20n,
      cache_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED",
      dedup_key: `usage-${overageRequestId}-${attemptNo}`,
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      ai_request_id: overageRequestId,
      enterprise_id: enterpriseId,
      usage_event_id: usage.id,
      upstream_attempt_id: attempt.id,
      provider_resource_id: resourceId,
      principal_id: principalId,
      resource_mode: "CODING_PLAN",
      raw_input_tokens: 40n,
      raw_output_tokens: 20n,
      raw_cache_tokens: 0n,
      deducted_quota: 60n,
      usage_quality: "PROVIDER_REPORTED",
    }).execute();
  }

  return {
    enterpriseId,
    otherEnterpriseId,
    principalId,
    providerId,
    finalResourceId: resourceB,
    overageRequestId,
  };
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("POOL-012 UsageRepository 数据库筛选", () => {
  let seeded: SeededUsage;

  beforeAll(async () => {
    seeded = await seedUsage();
  });

  it("请求/主体部分搜索、组合筛选与分页总数同口径", async () => {
    const repo = new UsageRepository(db);
    const result = await repo.list({
      enterpriseId: seeded.enterpriseId,
      search: seeded.overageRequestId.slice(6, 20),
      principalId: seeded.principalId,
      clientId: "WorkBuddy",
      providerId: seeded.providerId,
      providerResourceId: seeded.finalResourceId,
      unifiedModel: "qianliu-glm",
      status: "SUCCEEDED",
      overageOnly: true,
      limit: 1,
      offset: 0,
    });
    expect(result.total).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      requestId: seeded.overageRequestId,
      principalName: "王小明研发",
      finalProviderCode: "zhipu",
      finalProviderResourceId: seeded.finalResourceId,
      finalProviderResourceName: "最终资源",
      overage: true,
    });
  });

  it("overageOnly 在 SQL 中执行且不跨企业", async () => {
    const repo = new UsageRepository(db);
    const own = await repo.list({ enterpriseId: seeded.enterpriseId, overageOnly: true });
    expect(own.total).toBe(1);
    expect(own.records.map((record) => record.requestId)).toEqual([seeded.overageRequestId]);
    expect(own.records.every((record) => record.principalName !== "王小明隔离")).toBe(true);

    const searchedByName = await repo.list({
      enterpriseId: seeded.enterpriseId,
      search: "王小明",
      limit: 1,
    });
    expect(searchedByName.total).toBe(2);
    expect(searchedByName.records).toHaveLength(1);
  });

  it("厂商资源筛选与列表展示使用同一最终命中资源口径", async () => {
    const firstAttempt = await db
      .selectFrom("upstream_attempt")
      .select("provider_resource_id")
      .where("ai_request_id", "=", seeded.overageRequestId)
      .where("attempt_no", "=", 1)
      .executeTakeFirstOrThrow();
    const repo = new UsageRepository(db);

    const result = await repo.list({
      enterpriseId: seeded.enterpriseId,
      providerResourceId: firstAttempt.provider_resource_id,
    });
    expect(result.total).toBe(0);
    expect(result.records).toHaveLength(0);
  });
});
