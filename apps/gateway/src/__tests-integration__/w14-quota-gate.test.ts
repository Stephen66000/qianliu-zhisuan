/**
 * gateway W14 集成测试：额度门禁 + 并发租约（WT-06 + 并发不穿透 + 恢复）。
 *
 * 用真实 PostgreSQL + QuotaGateRepository 验证：
 *   - WT-06：额度耗尽后 REJECT_EXHAUSTED 停止；开 allow_overage 后 ALLOW_OVERAGE 并产生超额记录
 *   - 预占→结算校正：预占 estimated、按实际 deducted_quota 校正（多退少补）
 *   - 并发租约：活跃数达 concurrency_limit → 拒绝新租约；释放后可再获取；不穿透
 *   - 恢复任务：过期未释放租约被 reclaim
 *   - 额度按 deducted_quota（W13 倍率后）扣减，不是 raw
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createKysely,
  migrateToLatest,
  QuotaGateRepository,
  type Database,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { QUOTA_DECISION } from "@qianliu/domain";

let pg: PostgresTestInstance;
let db: Database;
let quotaRepo: QuotaGateRepository;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
let grantId: string;
let resourceId: string;
let keyId: string;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  quotaRepo = new QuotaGateRepository(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-W14额度" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "员工" }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "kimi", name: "Kimi", adapter_type: "kimi",
  }).returningAll().executeTakeFirstOrThrow();
  resourceId = (await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "Kimi 资源",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION", concurrency_limit: 2,
  }).returningAll().executeTakeFirstOrThrow()).id;
  // 授权：quota 10000，不允许超额
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID, provider: "kimi",
    model_alias: "qianliu-kimi-k3", quota_value: 10000n, allow_overage: false,
  }).returningAll().executeTakeFirstOrThrow();
  grantId = grant.id;
  await db.insertInto("quota_counter").values({ grant_id: grantId }).execute();
  // ai_request 外键需要 principal_key：建一个（租约挂在真实请求上）
  keyId = randomUUID();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID,
    key_prefix: "ql-test", key_digest: "digest-w14",
    allowed_model_ids: JSON.stringify([]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
}, 120_000);

/** 建一个真实 ai_request（concurrency_lease.ai_request_id 外键）。 */
async function makeAiRequest(): Promise<string> {
  const id = randomUUID();
  await db.insertInto("ai_request").values({
    id, enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID, principal_key_id: keyId,
    protocol: "chat", unified_model: "qianliu-kimi-k3", status: "IN_PROGRESS",
  }).execute();
  return id;
}

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

async function counter() {
  return db.selectFrom("quota_counter").selectAll().where("grant_id", "=", grantId).executeTakeFirstOrThrow();
}

describe("W14 额度门禁 + 并发租约", () => {
  it("额度充足 → ALLOW 并预占（used += estimated）", async () => {
    const r = await quotaRepo.reserveQuota({
      enterpriseId: ENT_ID, principalId: PRINCIPAL_ID, provider: "kimi",
      modelAlias: "qianliu-kimi-k3", estimatedCost: 3000n,
    });
    expect(r.decision).toBe(QUOTA_DECISION.ALLOW);
    expect(r.grantId).toBe(grantId);
    expect(r.reservedEstimate).toBe(3000n);
    expect(BigInt((await counter()).used_value)).toBe(3000n);
  });

  it("结算校正：预占 3000、实际 2000 → 退 1000（used=2000）", async () => {
    await quotaRepo.settleQuota(grantId, 3000n, 2000n);
    expect(BigInt((await counter()).used_value)).toBe(2000n);
  });

  it("WT-06：额度耗尽 → REJECT_EXHAUSTED 停止", async () => {
    // 已用 2000，再预占 8001 → 10001 > 10000 耗尽
    const r = await quotaRepo.reserveQuota({
      enterpriseId: ENT_ID, principalId: PRINCIPAL_ID, provider: "kimi",
      modelAlias: "qianliu-kimi-k3", estimatedCost: 8001n,
    });
    expect(r.decision).toBe(QUOTA_DECISION.REJECT_EXHAUSTED);
    // 预占未生效（used 不变）
    expect(BigInt((await counter()).used_value)).toBe(2000n);
  });

  it("WT-06：开 allow_overage → ALLOW_OVERAGE 并产生超额记录", async () => {
    await db.updateTable("principal_grant").set({ allow_overage: true }).where("id", "=", grantId).execute();
    const r = await quotaRepo.reserveQuota({
      enterpriseId: ENT_ID, principalId: PRINCIPAL_ID, provider: "kimi",
      modelAlias: "qianliu-kimi-k3", estimatedCost: 9000n,
    });
    expect(r.decision).toBe(QUOTA_DECISION.ALLOW_OVERAGE);
    expect(r.gate.overageAmount).toBe(1000n); // 2000+9000-10000
    const c = await counter();
    expect(BigInt(c.used_value)).toBe(11000n);
    expect(BigInt(c.overage_value)).toBe(1000n); // 超额记录
    // 恢复现场
    await db.updateTable("principal_grant").set({ allow_overage: false }).where("id", "=", grantId).execute();
    await quotaRepo.releaseQuota(grantId, 9000n);
    expect(BigInt((await counter()).used_value)).toBe(2000n);
  });

  it("并发租约：达 concurrency_limit 拒绝新租约，释放后可再获取（不穿透）", async () => {
    const l1 = await quotaRepo.acquireLease({ enterpriseId: ENT_ID, providerResourceId: resourceId, aiRequestId: await makeAiRequest() });
    const l2 = await quotaRepo.acquireLease({ enterpriseId: ENT_ID, providerResourceId: resourceId, aiRequestId: await makeAiRequest() });
    expect(l1).not.toBeNull();
    expect(l2).not.toBeNull();
    expect(await quotaRepo.activeConcurrency(resourceId)).toBe(2);

    // 第 3 个并发：满（limit=2）→ 拒绝
    const l3 = await quotaRepo.acquireLease({ enterpriseId: ENT_ID, providerResourceId: resourceId, aiRequestId: await makeAiRequest() });
    expect(l3).toBeNull();
    expect(await quotaRepo.activeConcurrency(resourceId)).toBe(2); // 不穿透

    // 释放一个 → 可再获取
    await quotaRepo.releaseLease(l1!);
    expect(await quotaRepo.activeConcurrency(resourceId)).toBe(1);
    const l4 = await quotaRepo.acquireLease({ enterpriseId: ENT_ID, providerResourceId: resourceId, aiRequestId: await makeAiRequest() });
    expect(l4).not.toBeNull();

    // 清理
    await quotaRepo.releaseLease(l2!);
    await quotaRepo.releaseLease(l4!);
    expect(await quotaRepo.activeConcurrency(resourceId)).toBe(0);
  });

  it("恢复任务：过期未释放租约被 reclaim（崩溃残留回收）", async () => {
    // 插入一个已过期的租约（模拟崩溃残留）
    await db.insertInto("concurrency_lease").values({
      enterprise_id: ENT_ID, provider_resource_id: resourceId, ai_request_id: await makeAiRequest(),
      expires_at: new Date(Date.now() - 1000), // 已过期
    }).execute();
    expect(await quotaRepo.activeConcurrency(resourceId)).toBe(1);

    const reclaimed = await quotaRepo.reclaimExpiredLeases(new Date());
    expect(reclaimed).toBe(1);
    expect(await quotaRepo.activeConcurrency(resourceId)).toBe(0);

    // 幂等：再次 reclaim 无效果
    expect(await quotaRepo.reclaimExpiredLeases(new Date())).toBe(0);
  });

  it("无有效授权 → REJECT_NO_GRANT", async () => {
    const r = await quotaRepo.reserveQuota({
      enterpriseId: ENT_ID, principalId: PRINCIPAL_ID, provider: "deepseek", // 无 deepseek 授权
      modelAlias: "qianliu-deepseek", estimatedCost: 100n,
    });
    expect(r.decision).toBe(QUOTA_DECISION.REJECT_NO_GRANT);
    expect(r.grantId).toBeNull();
  });
});
