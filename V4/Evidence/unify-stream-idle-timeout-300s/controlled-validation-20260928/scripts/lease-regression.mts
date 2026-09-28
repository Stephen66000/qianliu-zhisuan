/**
 * 数据库级并发租约回归（tasks 4.2）—— 受控环境预验收（2026-09-28）。
 *
 * 代码候选：30337df87ba721bcab932d77d880f50649374bc9（本文件仅为证据载体，不改产品代码）。
 * 运行环境：隔离 Docker PostgreSQL（postgres:17-alpine，与 testing 工厂同 digest），
 * 真实迁移（migrateToLatest）+ 真实 QuotaGateRepository SQL。
 * 时钟策略：不真实等待 300/660 秒；通过向 reclaimExpiredLeases 传入未来 now、
 * 并直接读取 expires_at 与 acquired_at 差值做断言（等价于数据库时间推进）。
 *
 * 覆盖：
 *   B1 生产同源派生：requestTimeoutMs=600_000 → concurrencyLeaseTtlMs=660_000（含 60 秒余量）；
 *   B2 TTL 写入：acquireLease(leaseTtlMs=660_000) 落库 expires_at - acquired_at = 660 秒（±2 秒）；
 *   B3 跨 300 秒窗口不提前回收：t+300s 回收 0 条，且并发满时第二次获取被拒（不重复放行）；
 *   B4 完成/取消/超时路径释放只发生一次：releaseLease 幂等（第二次 no-op，released_at 不变）；
 *   B5 过期恢复边界：expires_at 时刻（严格 <）不回收；expires_at+1ms 回收 1 条并放行新租约。
 */
import { randomUUID } from "node:crypto";
import { startPostgresContainer } from "../../../../../packages/testing/src/postgres-container.js";
import { createKysely } from "../../../../../packages/database/src/kysely.js";
import { migrateToLatest } from "../../../../../packages/database/src/migrator.js";
import { QuotaGateRepository } from "../../../../../packages/database/src/repositories/quota-gate-repository.js";
import { createProductionUpstreamRuntime } from "../../../../../apps/gateway/src/upstream-caller-factory.js";

const results: Array<{ case: string; pass: boolean; detail: string }> = [];
function record(name: string, pass: boolean, detail: string): void {
  results.push({ case: name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}
function assert(cond: boolean, name: string, detail: string): void {
  record(name, cond, detail);
  if (!cond) process.exitCode = 1;
}

const pg = await startPostgresContainer("qianliu_siv300_lease", "qianliu_siv300", "<redacted-ephemeral-pw>");
const db = createKysely(pg.connectionString);
try {
  const applied = await migrateToLatest(db);
  console.log(`migrations_applied=${applied.length} head=${applied.at(-1) ?? "none"}`);

  const entId = randomUUID();
  const providerId = randomUUID();
  const resourceId = randomUUID();
  const principalId = randomUUID();
  await db.insertInto("enterprise").values({ id: entId, name: "SIV300 租约回归" }).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: entId, type: "EMPLOYEE", name: "租约回归主体" }).execute();
  const principalKey = await db.insertInto("principal_key").values({
    enterprise_id: entId, principal_id: principalId,
    key_prefix: "siv300", key_digest: "siv300-lease-regression-digest", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const principalKeyId = principalKey.id;
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: entId, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: entId, provider_id: providerId, name: "租约回归资源",
    mode: "API", credential_type: "API_KEY", concurrency_limit: 1,
  }).execute();
  // acquireLease 写 ai_request_id 受 FK 约束：为每个请求 id 预置真实 ai_request 行。
  const seedAiRequest = async (reqId: string): Promise<void> => {
    await db.insertInto("ai_request").values({
      id: reqId, enterprise_id: entId, principal_id: principalId, principal_key_id: principalKeyId,
      protocol: "openai", unified_model: "lease-regression-model",
    }).execute();
  };

  // B1 生产同源派生：600s 总时限 + 60s 安全余量 = 660s（装配级同源，非重写逻辑）。
  const runtime = createProductionUpstreamRuntime({ GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS: "600000" });
  assert(runtime.concurrencyLeaseTtlMs === 660_000, "B1 同源派生 leaseTtl=660s",
    `requestTimeoutMs=${runtime.requestTimeoutMs} concurrencyLeaseTtlMs=${runtime.concurrencyLeaseTtlMs}`);

  const repo = new QuotaGateRepository(db);
  const lease = async (reqId: string, ttl?: number) => repo.acquireLease({
    enterpriseId: entId, providerResourceId: resourceId, aiRequestId: reqId,
    ...(ttl === undefined ? {} : { leaseTtlMs: ttl }),
  });

  // B2 TTL 真实写库：660 秒 ±2 秒。
  const reqA = randomUUID();
  await seedAiRequest(reqA);
  const leaseA = await lease(reqA, 660_000);
  assert(leaseA !== null, "B2a 获取租约成功", `leaseId=${leaseA}`);
  if (leaseA) {
    const rowA = (await db.selectFrom("concurrency_lease").selectAll()
      .where("id", "=", leaseA).executeTakeFirstOrThrow());
    const ttlMs = rowA.expires_at.getTime() - rowA.acquired_at.getTime();
    assert(Math.abs(ttlMs - 660_000) <= 2_000, "B2b TTL=660s 落库",
      `expires_at-acquired_at=${ttlMs}ms`);
  }

  // B3 跨 300 秒窗口：t+300s 回收 0 条；并发满（limit=1）第二次获取被拒。
  const t300 = new Date(Date.now() + 300_000);
  const reclaimedAt300 = await repo.reclaimExpiredLeases(t300);
  assert(reclaimedAt300 === 0, "B3a t+300s 不提前回收", `reclaimed=${reclaimedAt300}`);
  const reqB = randomUUID();
  await seedAiRequest(reqB);
  const leaseB = await lease(reqB);
  assert(leaseB === null, "B3b 并发满不重复放行", `secondAcquire=${leaseB === null ? "rejected(null)" : String(leaseB)}`);

  // B4 释放幂等（完成/取消/超时三条路径都只会调用一次 releaseLease；重复调用必须 no-op）。
  const releasedAtBefore = (await db.selectFrom("concurrency_lease").selectAll()
    .where("id", "=", leaseA!).executeTakeFirstOrThrow()).released_at;
  await repo.releaseLease(leaseA!);
  const afterFirst = (await db.selectFrom("concurrency_lease").selectAll()
    .where("id", "=", leaseA!).executeTakeFirstOrThrow()).released_at;
  await repo.releaseLease(leaseA!); // 模拟重复释放（不得改变状态）
  const afterSecond = (await db.selectFrom("concurrency_lease").selectAll()
    .where("id", "=", leaseA!).executeTakeFirstOrThrow()).released_at;
  assert(releasedAtBefore === null && afterFirst !== null && afterSecond!.getTime() === afterFirst!.getTime(),
    "B4 释放只发生一次（幂等）",
    `before=${releasedAtBefore?.toISOString() ?? "null"} first=${afterFirst?.toISOString()} second=${afterSecond?.toISOString()}`);
  const activeAfterRelease = await repo.activeConcurrency(resourceId);
  assert(activeAfterRelease === 0, "B4b 释放后活跃并发=0", `active=${activeAfterRelease}`);

  // B5 过期恢复边界：严格 expires_at < now 才回收。
  const reqC = randomUUID();
  await seedAiRequest(reqC);
  const leaseC = await lease(reqC, 5_000);
  const rowC = (await db.selectFrom("concurrency_lease").selectAll()
    .where("id", "=", leaseC!).executeTakeFirstOrThrow());
  const reclaimedAtExact = await repo.reclaimExpiredLeases(new Date(rowC.expires_at.getTime()));
  assert(reclaimedAtExact === 0, "B5a 恰在 expires_at 不回收（严格 <）", `reclaimed=${reclaimedAtExact}`);
  const reclaimedAtPlus1 = await repo.reclaimExpiredLeases(new Date(rowC.expires_at.getTime() + 1));
  assert(reclaimedAtPlus1 === 1, "B5b expires_at+1ms 回收 1 条", `reclaimed=${reclaimedAtPlus1}`);
  const reqD = randomUUID();
  await seedAiRequest(reqD);
  const leaseD = await lease(reqD);
  assert(leaseD !== null, "B5c 回收后新请求放行", `newLease=${leaseD !== null}`);
} finally {
  await db.destroy();
  await pg.stop();
}

const failed = results.filter((r) => !r.pass);
console.log(`SUMMARY total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length > 0 ? 1 : 0);
