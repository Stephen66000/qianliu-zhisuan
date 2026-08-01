/**
 * gateway W11 集成测试：凭证生命周期与账号池（WT-07/WT-19 + 故障注入）。
 *
 * 用真实 PostgreSQL（Testcontainer）+ ResourcePoolRepository 验证：
 *   - WT-07：同资源池账号失效后，可服务集合只剩健康账号（单资源隔离，不波及同池）
 *   - WT-19：SUBSCRIPTION_SESSION 刷新失败仅隔离对应资源；重新授权后 adminRecover 受控恢复；
 *           隔离/恢复全程 resource_status_event 审计留痕
 *   - 故障注入：429 冷却退避（到期半开）、临时故障达阈值熔断、成功半开恢复
 *   - canary：凭证明文/正文在 resource_status_event 0 命中
 *
 * Gateway 请求路径的多候选 failover 在 W12；W11 落地状态机本体 + 单资源隔离语义。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import {
  createKysely,
  migrateToLatest,
  ResourcePoolRepository,
  type Database,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createPgCanarySink, scanCanary } from "@qianliu/observability";
import { RESOURCE_STATUS, STATE_REASON } from "@qianliu/domain";

let pg: PostgresTestInstance;
let db: Database;
let poolRepo: ResourcePoolRepository;
const ENT_ID = randomUUID();
let providerId: string;
let resA: string; // 池 pool-kimi 账号 A（SUBSCRIPTION_SESSION）
let resB: string; // 池 pool-kimi 账号 B（SUBSCRIPTION_SESSION）
let resC: string; // 池 pool-deepseek 账号 C（API_KEY，对照组）

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  poolRepo = new ResourcePoolRepository(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-W11账号池" }).execute();
  const kimi = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "kimi", name: "Kimi", adapter_type: "kimi",
  }).returningAll().executeTakeFirstOrThrow();
  providerId = kimi.id;

  const mkResource = async (name: string, poolId: string, credentialType: "SUBSCRIPTION_SESSION" | "API_KEY") => {
    const r = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID,
      provider_id: providerId,
      name,
      mode: "CODING_PLAN",
      credential_type: credentialType,
      resource_pool_id: poolId,
      credential_fingerprint: `${name}-fp`,
      credential_version: 1,
    }).returningAll().executeTakeFirstOrThrow();
    return r.id;
  };
  resA = await mkResource("kimi-pool-A", "pool-kimi", "SUBSCRIPTION_SESSION");
  resB = await mkResource("kimi-pool-B", "pool-kimi", "SUBSCRIPTION_SESSION");
  resC = await mkResource("kimi-pool-C", "pool-deepseek", "API_KEY");
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("W11 凭证生命周期与账号池", () => {
  it("WT-07：账号 A 401 → 仅 A 隔离（CREDENTIAL_INVALID），同池 B 与对照 C 不受影响", async () => {
    const t = await poolRepo.recordFailure(resA, "UPSTREAM_CREDENTIAL_INVALID", new Date());
    expect(t).not.toBeNull();
    expect(t!.toStatus).toBe(RESOURCE_STATUS.CREDENTIAL_INVALID);
    expect(t!.reason).toBe(STATE_REASON.CREDENTIAL_REJECTED);
    expect(t!.isolates).toBe(true);

    // 同池可服务集合只剩 B（单资源隔离，WT-07 切换同池账号的前提）
    const servable = await poolRepo.listServableResources(ENT_ID, "pool-kimi");
    expect(servable.map((s) => s.id)).toEqual([resB]);

    // 对照池 C 不受影响
    const servableAll = await poolRepo.listServableResources(ENT_ID);
    expect(servableAll.map((s) => s.id).sort()).toEqual([resB, resC].sort());

    // 审计留痕
    const events = await poolRepo.listStatusEvents(resA);
    expect(events).toHaveLength(1);
    expect(events[0]!.from_status).toBe("ACTIVE");
    expect(events[0]!.to_status).toBe("CREDENTIAL_INVALID");
    expect(events[0]!.error_classification).toBe("UPSTREAM_CREDENTIAL_INVALID");

    // 幂等：重复 401 不产生新事件
    const again = await poolRepo.recordFailure(resA, "UPSTREAM_CREDENTIAL_INVALID", new Date());
    expect(again).toBeNull();
    expect(await poolRepo.listStatusEvents(resA)).toHaveLength(1);
  });

  it("WT-19：B 刷新失败仅隔离 B；adminRecover 受控恢复（新凭证版本+过期时间）后可服务", async () => {
    // 刷新失败 → CREDENTIAL_INVALID + 刷新状态落库
    const t = await poolRepo.recordRefreshFailure(resB, "OAUTH_REFRESH_REJECTED", new Date());
    expect(t!.toStatus).toBe(RESOURCE_STATUS.CREDENTIAL_INVALID);
    expect(t!.reason).toBe(STATE_REASON.REFRESH_FAILED);

    const rowB = await poolRepo.getResource(resB);
    expect(rowB!.credential_refresh_status).toBe("FAILED");
    expect(rowB!.refresh_error_classification).toBe("OAUTH_REFRESH_REJECTED");

    // 仅 B 被隔离；C 仍在服务（WT-19：其他健康账号继续服务）
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).toEqual([resC]);

    // 非隔离态不可 adminRecover（防御）
    expect(await poolRepo.adminRecover(resC)).toBeNull();

    // 重新授权后受控恢复：新凭证版本 + 新过期时间 → DEGRADED（需探测确认）
    const newExpiry = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const rec = await poolRepo.adminRecover(resB, { credentialVersion: 2, credentialExpiresAt: newExpiry });
    expect(rec!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(rec!.reason).toBe(STATE_REASON.ADMIN_RECOVER);

    const rowB2 = await poolRepo.getResource(resB);
    expect(rowB2!.credential_version).toBe(2);
    expect(rowB2!.credential_refresh_status).toBe("OK");
    expect(rowB2!.refresh_error_classification).toBeNull();

    // 恢复后重新可服务（DEGRADED 可服务，W12 评分降权）
    const servable2 = await poolRepo.listServableResources(ENT_ID);
    expect(servable2.map((s) => s.id).sort()).toEqual([resB, resC].sort());

    // 审计轨迹完整：REFRESH_FAILED → ADMIN_RECOVER（actor=admin）
    const reasons = (await poolRepo.listStatusEvents(resB)).map((e) => e.reason);
    expect(reasons).toEqual([STATE_REASON.REFRESH_FAILED, STATE_REASON.ADMIN_RECOVER]);
  });

  it("故障注入：429 短时冷却且同波去重 → 到期半开探测 → 成功降级恢复", async () => {
    const now = Date.now();
    const wave = await Promise.all([1, 2, 3].map(() => poolRepo.recordFailure(
      resC,
      "UPSTREAM_RATE_LIMITED",
      new Date(now),
      { retryAfterMs: 5_000 },
    )));
    const t = wave.find((transition) => transition !== null)!;
    expect(wave.filter((transition) => transition !== null)).toHaveLength(1);
    expect(t!.toStatus).toBe(RESOURCE_STATUS.RATE_LIMITED);
    expect(t!.cooldownUntil).toBe(now + 5_000);
    // 同一冷却窗口内并发失败不重复累计，也不延长冷却。
    expect(await poolRepo.recordFailure(
      resC,
      "UPSTREAM_RATE_LIMITED",
      new Date(now + 1_000),
      { retryAfterMs: 60_000 },
    )).toBeNull();
    expect((await poolRepo.getResource(resC))!.consecutive_failures).toBe(1);

    // 冷却中：不可服务
    const during = await poolRepo.listServableResources(ENT_ID, undefined, new Date(now + 4_000));
    expect(during.map((s) => s.id)).not.toContain(resC);

    // 冷却到期：半开探测窗口（admit + probe）
    const after = await poolRepo.listServableResources(ENT_ID, undefined, new Date(now + 5_000));
    const probeC = after.find((s) => s.id === resC);
    expect(probeC).toBeDefined();
    expect(probeC!.probe).toBe(true);

    // 多实例同时看到半开候选时，只能有一个真实请求获得探针租约。
    const leases = await Promise.all([1, 2, 3].map(() =>
      poolRepo.tryAcquireHalfOpenProbe(resC, new Date(now + 5_000))));
    expect(leases.filter(Boolean)).toHaveLength(1);

    // 半开探测成功 → DEGRADED（一次成功不抹掉趋势）
    const ok = await poolRepo.recordSuccess(resC);
    expect(ok!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(ok!.reason).toBe(STATE_REASON.HALF_OPEN_PROBE_OK);

    // 再次成功 → ACTIVE
    const ok2 = await poolRepo.recordSuccess(resC);
    expect(ok2!.toStatus).toBe(RESOURCE_STATUS.ACTIVE);
  });

  it("RA-W04：连续 5xx/传输故障达到旧阈值仍不硬隔离", async () => {
    // 客户端错误不计入健康
    expect(await poolRepo.recordFailure(resC, "CLIENT_INVALID", new Date())).toBeNull();
    let row = await poolRepo.getResource(resC);
    expect(row!.consecutive_failures).toBe(0);
    expect(row!.status).toBe("ACTIVE");

    // 3 次技术故障只累计健康事实
    const t1 = await poolRepo.recordFailure(resC, "UPSTREAM_TEMPORARY", new Date());
    expect(t1!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t1!.isolates).toBe(false);
    await poolRepo.recordFailure(resC, "TRANSPORT_ERROR", new Date());
    const t3 = await poolRepo.recordFailure(resC, "UPSTREAM_TEMPORARY", new Date());
    expect(t3!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    expect(t3!.reason).toBe(STATE_REASON.PASSIVE_FAILURE);
    expect(t3!.cooldownUntil).toBeNull();

    row = await poolRepo.getResource(resC);
    expect(row!.consecutive_failures).toBe(3);
    expect(row!.status).toBe("DEGRADED");
    const ok = await poolRepo.recordSuccess(resC);
    expect(ok!.toStatus).toBe(RESOURCE_STATUS.ACTIVE);
  });

  it("凭证到期检查：credential_expires_at 到达 → EXPIRED 隔离（WT-19 到期路径）", async () => {
    // B 设置已过期的凭证时间
    await db.updateTable("provider_resource")
      .set({ credential_expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", resB)
      .execute();
    const t = await poolRepo.checkCredentialExpiry(resB, new Date());
    expect(t!.toStatus).toBe(RESOURCE_STATUS.EXPIRED);
    expect(t!.reason).toBe(STATE_REASON.CREDENTIAL_EXPIRED);

    // EXPIRED 不可服务，可 adminRecover
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).not.toContain(resB);
    const rec = await poolRepo.adminRecover(resB, { credentialExpiresAt: new Date(Date.now() + 86400_000) });
    expect(rec!.toStatus).toBe(RESOURCE_STATUS.DEGRADED);
    await poolRepo.recordSuccess(resB); // 回 ACTIVE
  });

  it("canary：凭证明文/请求正文在 resource_status_event 0 命中", async () => {
    const CANARY = "W11_CREDENTIAL_PLAINTEXT_CANARY_XX_24680";
    // 用 canary 作为"凭证明文"制造一次刷新失败（错误分类字段不应记录明文）
    await db.updateTable("provider_resource")
      .set({ credential_fingerprint: `${CANARY}-fp-only` })
      .where("id", "=", resA)
      .execute();

    const scanFn = async (canary: string): Promise<number> => {
      // resource_status_event 只存状态/分类/原因，不得出现凭证明文与指纹以外字段；
      // 此处验证 canary 明文不会进入事件表（fingerprint 列允许存指纹，canary 不是指纹格式）
      const result = await sql`SELECT COUNT(*)::int AS hits FROM (SELECT row_to_json(r)::text AS txt FROM resource_status_event r) s WHERE s.txt LIKE ${"%" + canary + "%"}`.execute(db);
      return Number((result.rows[0] as { hits: number }).hits);
    };
    const result = await scanCanary(CANARY, [createPgCanarySink(scanFn)]);
    expect(result.hits.postgres, "resource_status_event 不得出现凭证明文/正文").toBe(0);
    expect(result.passed).toBe(true);
  });
});
