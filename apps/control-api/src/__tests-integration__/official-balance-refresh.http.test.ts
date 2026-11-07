import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  decodeKek,
  digestSessionToken,
  encryptCredential,
  generateSessionToken,
} from "@qianliu/provider-adapters";
import { hashPassword } from "../auth/password.js";

/**
 * WP3 task 3.2 / OAB-03：手动刷新端点 POST /provider-resources/:id/official-balance/refresh。
 *
 * 验收锚点：AT-OAB-05（不要求登记充值）、AT-OAB-06（view-only 403＋GET 可读、凭证不下发）、
 * AT-X02（冷却/在途不无限触发查询、失败后仍可按合同再次刷新）。
 * 上游一律注入 fetch（vi.stubGlobal），不触达真实厂商；凭证用 server dev placeholder KEK
 * 加密（buildControlApi 测试态 fallback 同源），响应/审计断言不含凭证明文。
 */
const PASSWORD = "WP3-Refresh-Password!";
const DEV_KEK_BASE64 = "ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA=";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
const fetchMock = vi.fn();

function okBalance(total: string): unknown {
  return {
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: total,
      granted_balance: "10", topped_up_balance: "100" }],
  };
}

function stubFetch(handler: () => unknown): void {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => handler());
  vi.stubGlobal("fetch", fetchMock);
}

async function sessionFor(adminId: string): Promise<string> {
  const token = generateSessionToken();
  await (db as ReturnType<typeof createKysely>).insertInto("admin_session").values({
    admin_user_id: adminId, token_hash: digestSessionToken(token),
    expires_at: new Date(Date.now() + 8 * 3_600_000),
  }).execute();
  return `qianliu_admin_session=${token}`;
}

interface Seeded {
  enterpriseId: string; superCookie: string; viewerCookie: string;
  deepseekResourceId: string; noCredentialResourceId: string; zhipuResourceId: string;
}

async function seedEnterprise(name: string): Promise<Seeded> {
  const enterpriseId = randomUUID();
  const superAdminId = randomUUID(); const viewerAdminId = randomUUID();
  const providerId = randomUUID(); const zhipuProviderId = randomUUID();
  const deepseekResourceId = randomUUID(); const planResourceId = randomUUID();
  const noCredentialResourceId = randomUUID(); const zhipuResourceId = randomUUID();
  const passwordHash = await hashPassword(PASSWORD);
  const kek = decodeKek(DEV_KEK_BASE64);
  const d = db as ReturnType<typeof createKysely>;
  await d.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
  await d.insertInto("admin_user").values([
    { id: superAdminId, enterprise_id: enterpriseId, username: `${name}-super`,
      password_hash: passwordHash, status: "ACTIVE" },
    { id: viewerAdminId, enterprise_id: enterpriseId, username: `${name}-viewer`,
      password_hash: passwordHash, status: "ACTIVE", role_code: "CUSTOM" },
  ]).execute();
  // 自定义岗位只授予 resources.view：余额可读、刷新必须 403（PFU-06 / AT-OAB-06）。
  await d.insertInto("admin_role").values({ enterprise_id: enterpriseId, name: "只读观察员",
    permissions: { resources: { view: true, operate: false } } }).execute();
  await d.insertInto("provider").values([
    { id: providerId, enterprise_id: enterpriseId, code: "deepseek",
      name: `DeepSeek ${name}`, adapter_type: "OPENAI_COMPATIBLE" },
    { id: zhipuProviderId, enterprise_id: enterpriseId, code: "zhipu",
      name: `智谱 ${name}`, adapter_type: "OPENAI_COMPATIBLE" },
  ]).execute();
  await d.insertInto("provider_resource").values([
    { id: deepseekResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: `${name}-DeepSeek-API`, mode: "API", credential_type: "API_KEY",
      credential_ciphertext: JSON.stringify(encryptCredential("sk-test-secret-123", kek)) },
    { id: planResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: `${name}-DeepSeek-PLAN`, mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION" },
    { id: noCredentialResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: `${name}-DeepSeek-NoCred`, mode: "API", credential_type: "API_KEY" },
    { id: zhipuResourceId, enterprise_id: enterpriseId, provider_id: zhipuProviderId,
      name: `${name}-Zhipu-API`, mode: "API", credential_type: "API_KEY",
      credential_ciphertext: JSON.stringify(encryptCredential("sk-zhipu-secret", kek)) },
  ]).execute();
  return {
    enterpriseId,
    superCookie: await sessionFor(superAdminId),
    viewerCookie: await sessionFor(viewerAdminId),
    deepseekResourceId, noCredentialResourceId, zhipuResourceId,
  };
}

const refresh = (cookie: string, id: string, body?: Record<string, unknown>) => app.inject({
  method: "POST",
  url: `/provider-resources/${id}/official-balance/refresh`,
  headers: { cookie },
  ...(body ? { payload: body } : {}),
});

async function attemptCount(resourceId: string): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM provider_resource_operating_sync_attempt
    WHERE provider_resource_id = ${resourceId}::uuid
  `.execute(db);
  return result.rows[0]!.count;
}

async function snapshotCount(resourceId: string): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM provider_resource_operating_snapshot
    WHERE provider_resource_id = ${resourceId}::uuid
  `.execute(db);
  return result.rows[0]!.count;
}

async function refreshRowCount(resourceId: string): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM provider_resource_balance_refresh
    WHERE provider_resource_id = ${resourceId}::uuid
  `.execute(db);
  return result.rows[0]!.count;
}

/** 把冷却压缩到 100ms（路由按请求时读取 env），等待窗口过去后可再次刷新。 */
async function withShortCooldown(run: () => Promise<void>): Promise<void> {
  process.env.PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS = "100";
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    await run();
  } finally {
    delete process.env.PROVIDER_OPERATING_BALANCE_REFRESH_COOLDOWN_MS;
  }
}

beforeAll(async () => {
  pg = await startPostgresContainer("wp3_official_balance_refresh");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
}, 240_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  await (db as ReturnType<typeof createKysely>)?.destroy();
  await pg?.stop();
}, 60_000);

describe("POST /provider-resources/:id/official-balance/refresh（OAB-03 task 3.2）", () => {
  it("AT-OAB-05 成功刷新：ACCEPTED＋快照/attempt 落库＋审计行，响应与审计不含凭证明文", async () => {
    const seed = await seedEnterprise("refresh-ok");
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("110") }));
    const response = await refresh(seed.superCookie, seed.deepseekResourceId);
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      state: string; result: { outcome: string; balance: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string; available: boolean } };
    };
    expect(payload.state).toBe("ACCEPTED");
    expect(payload.result.outcome).toBe("SUCCEEDED");
    expect(payload.result.balance).toEqual({ currency: "CNY", total_balance: "110",
      granted_balance: "10", topped_up_balance: "100", available: true });
    // 凭证不下发浏览器（AT-OAB-06 后半）
    expect(response.body).not.toContain("sk-test-secret-123");

    const snapshotRows = await sql<{ current_balance: string; balance_source: string; source: string }>`
      SELECT current_balance::text AS current_balance, balance_source, source
        FROM provider_resource_operating_snapshot
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
    `.execute(db);
    expect(snapshotRows.rows).toHaveLength(1);
    expect(snapshotRows.rows[0]).toMatchObject({ current_balance: "110.00000000",
      balance_source: "PROVIDER_API", source: "PROVIDER_SYNC" });
    expect(await attemptCount(seed.deepseekResourceId)).toBe(1);
    const attempts = await sql<{ balance_status: string; cost_status: string; error_code: string; snapshot_id: string | null }>`
      SELECT balance_status, cost_status, error_code, snapshot_id
        FROM provider_resource_operating_sync_attempt
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
    `.execute(db);
    expect(attempts.rows[0]).toMatchObject({ balance_status: "SUCCESS", cost_status: "NOT_SUPPORTED",
      error_code: "PROVIDER_COST_API_NOT_SUPPORTED" });
    expect(attempts.rows[0]!.snapshot_id).not.toBeNull();
    expect(await refreshRowCount(seed.deepseekResourceId)).toBe(1);
    const audits = await sql<{ action: string; result: string }>`
      SELECT action, result FROM operation_log
       WHERE target_id = ${seed.deepseekResourceId}::uuid
         AND action = 'provider_resource.official_balance_refresh'
    `.execute(db);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.result).toBe("SUCCESS");
    expect(JSON.stringify(audits.rows)).not.toContain("sk-test-secret-123");
  });

  it("AT-X02 冷却：最近 attempt 的 P3 窗口内二次请求 COOLDOWN，不查上游、不留刷新行", async () => {
    const seed = await seedEnterprise("refresh-cooldown");
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("50") }));
    const first = await refresh(seed.superCookie, seed.deepseekResourceId);
    expect(first.statusCode).toBe(200);
    expect((first.json() as { state: string }).state).toBe("ACCEPTED");
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    const second = await refresh(seed.superCookie, seed.deepseekResourceId);
    expect(second.statusCode).toBe(200);
    const payload = second.json() as { state: string; retry_after_seconds: number };
    expect(payload.state).toBe("COOLDOWN");
    expect(payload.retry_after_seconds).toBeGreaterThanOrEqual(0);
    expect(payload.retry_after_seconds).toBeLessThanOrEqual(30);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    // 冷却拒绝不产生新的刷新请求行（仅在途/执行才插行）。
    expect(await refreshRowCount(seed.deepseekResourceId)).toBe(1);
  });

  it("AT-X02 在途：RUNNING 行存在 → IN_PROGRESS；租约过期由下次 begin 收敛为 FAILED，冷却外可再刷成功", async () => {
    const seed = await seedEnterprise("refresh-inflight");
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("60") }));
    // 手动造一个在途 RUNNING（另一管理员名义），租约未到期。
    await sql`
      INSERT INTO provider_resource_balance_refresh
        (enterprise_id, provider_resource_id, actor_admin_id, idempotency_key,
         status, started_at, expires_at, updated_at)
      SELECT ${seed.enterpriseId}::uuid, ${seed.deepseekResourceId}::uuid,
             a.id::uuid, gen_random_uuid(), 'RUNNING', now(), now() + interval '60 seconds', now()
        FROM admin_user a WHERE a.enterprise_id = ${seed.enterpriseId}::uuid LIMIT 1
    `.execute(db);
    const inFlight = await refresh(seed.superCookie, seed.deepseekResourceId);
    expect(inFlight.statusCode).toBe(200);
    const inFlightPayload = inFlight.json() as { state: string; retry_after_seconds: number };
    expect(inFlightPayload.state).toBe("IN_PROGRESS");
    expect(inFlightPayload.retry_after_seconds).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // 崩溃残留：把租约改到过去 → 下次 begin 收敛为 FAILED；冷却压缩后本轮执行成功。
    await sql`
      UPDATE provider_resource_balance_refresh
         SET expires_at = now() - interval '1 second'
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid AND status = 'RUNNING'
    `.execute(db);
    await withShortCooldown(async () => {
      const recovered = await refresh(seed.superCookie, seed.deepseekResourceId);
      expect(recovered.statusCode).toBe(200);
      expect((recovered.json() as { state: string; result: { outcome: string } }).state).toBe("ACCEPTED");
      expect((recovered.json() as { result: { outcome: string } }).result.outcome).toBe("SUCCEEDED");
    });
    const converged = await sql<{ status: string; error_code: string | null }>`
      SELECT status, error_code FROM provider_resource_balance_refresh
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
         AND error_code = 'REFRESH_LEASE_EXPIRED'
    `.execute(db);
    expect(converged.rows).toHaveLength(1);
    expect(converged.rows[0]!.status).toBe("FAILED");
    expect(await refreshRowCount(seed.deepseekResourceId)).toBe(2);
  });

  it("AT-X02 skew 负向（R2 C1）：DB 时钟已过期的 RUNNING（expires_at = now()-2s）必须被 begin 收敛为 FAILED，不得按宿主时钟滞留 IN_PROGRESS", async () => {
    // 依据：R1 复审 C1——宿主-testcontainer 时钟偏移（R8a 实测 ~1.2s，宿主落后）曾使
    // 「DB 时钟已过期」的租约按宿主时钟判未过期而滞留 IN_PROGRESS。根治后判定基准为
    // DB now()；本用例在真实环境 skew 下对收敛行为做行为回归（begin 收敛 → ACCEPTED，
    // 留痕 FAILED/REFRESH_LEASE_EXPIRED）。判别力说明：本用例不构成对旧实现（宿主钟
    // 判定）的独立杀死——「2s 裕量必败」的论证依赖环境 skew 实测值（宿主落后 <2s 是
    // 本环境常态而非保证），R2 终审条件 5 已纠正该说法；旧实现必失败的判别力证明见
    // 下一用例（受控偏移判别）。
    const seed = await seedEnterprise("refresh-skew-expired");
    await sql`
      INSERT INTO provider_resource_balance_refresh
        (enterprise_id, provider_resource_id, actor_admin_id, idempotency_key,
         status, started_at, expires_at, updated_at)
      SELECT ${seed.enterpriseId}::uuid, ${seed.deepseekResourceId}::uuid,
             a.id::uuid, gen_random_uuid(), 'RUNNING',
             now() - interval '62 seconds', now() - interval '2 seconds', now()
        FROM admin_user a WHERE a.enterprise_id = ${seed.enterpriseId}::uuid LIMIT 1
    `.execute(db);
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("80") }));
    const recovered = await refresh(seed.superCookie, seed.deepseekResourceId);
    expect(recovered.statusCode).toBe(200);
    const payload = recovered.json() as { state: string; result?: { outcome: string } };
    expect(payload.state).not.toBe("IN_PROGRESS");
    expect(payload.state).toBe("ACCEPTED");
    expect(payload.result?.outcome).toBe("SUCCEEDED");
    // 收敛留痕：FAILED/REFRESH_LEASE_EXPIRED，且留痕与租约同一 DB 时钟（finished_at ≥ expires_at）。
    const converged = await sql<{ status: string; error_code: string | null; finished_at: Date; expires_at: Date }>`
      SELECT status, error_code, finished_at, expires_at FROM provider_resource_balance_refresh
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
         AND error_code = 'REFRESH_LEASE_EXPIRED'
    `.execute(db);
    expect(converged.rows).toHaveLength(1);
    expect(converged.rows[0]!.status).toBe("FAILED");
    expect(converged.rows[0]!.finished_at.getTime())
      .toBeGreaterThanOrEqual(converged.rows[0]!.expires_at.getTime());
    expect(await refreshRowCount(seed.deepseekResourceId)).toBe(2);
  });

  it("AT-X02 skew 判别力（R2 终审条件 5）：受控偏移下宿主钟谓词漏/误收敛、DB 谓词均正确——旧实现（宿主钟判定）必失败，判别力不依赖环境 skew 实际值", async () => {
    // 依据：R2 终审条件 5——上一用例的真实 skew 回归不具备独立杀死旧实现的判别力。
    // 本用例在同一测试库会话内直插 RUNNING 租约，对同一行/对照行分别执行两种谓词，
    // 偏移完全受控（±10s，量级远超毫秒级执行抖动，方向覆盖双向）：
    // - 新实现谓词＝official-balance-refresh-repository.ts convergeExpiredLeases：
    //   UPDATE ... WHERE status='RUNNING' AND expires_at <= now()（DB 钟），
    //   判定与留痕（finished_at/updated_at）同用单条 UPDATE 内的 now()；
    // - 旧实现谓词模拟＝修复前 .where("expires_at", "<=", now)（宿主 JS Date，
    //   留痕亦打宿主钟），其中 $hostNow 人为注入 dbNow-10s（宿主落后）/ dbNow+10s
    //   （宿主领先）两种受控值。
    // 结论断言：宿主钟偏差（任意方向 ≥ 受控量）→ 旧判定漏收敛（落后，DB 钟已过期
    // 的行不收敛）或误收敛（领先，DB 钟未过期的行被收敛）；DB 谓词两种情况下均正确
    // → 判别力不依赖环境 skew 实际值。
    const seed = await seedEnterprise("refresh-skew-controlled");
    // DB 钟基准：受控偏移的原点。
    const dbNowRows = await sql<{ db_now: Date }>`
      SELECT now() AS db_now
    `.execute(db);
    const dbNow = dbNowRows.rows[0]!.db_now;
    const hostBehind = new Date(dbNow.getTime() - 10_000); // 模拟宿主落后 10s
    const hostAhead = new Date(dbNow.getTime() + 10_000); // 模拟宿主领先 10s

    // 直插行 A：DB 钟已过期 1s 的 RUNNING 租约（expires_at = now() - 1s）。
    const keyA = randomUUID();
    await sql`
      INSERT INTO provider_resource_balance_refresh
        (enterprise_id, provider_resource_id, actor_admin_id, idempotency_key,
         status, started_at, expires_at, updated_at)
      SELECT ${seed.enterpriseId}::uuid, ${seed.deepseekResourceId}::uuid,
             a.id::uuid, ${keyA}::uuid, 'RUNNING',
             now() - interval '62 seconds', now() - interval '1 second', now()
        FROM admin_user a WHERE a.enterprise_id = ${seed.enterpriseId}::uuid LIMIT 1
    `.execute(db);

    // 旧谓词 × 宿主落后 10s：行 A 满足 DB 钟「已过期」，但不满足 expires_at <= hostBehind
    // → 漏收敛（0 行受影响，仍滞留 RUNNING）。
    const behindMiss = await sql<{ id: string }>`
      UPDATE provider_resource_balance_refresh
         SET status = 'FAILED', error_code = 'REFRESH_LEASE_EXPIRED',
             finished_at = ${hostBehind}, updated_at = ${hostBehind}
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
         AND status = 'RUNNING'
         AND expires_at <= ${hostBehind}
      RETURNING id::text AS id
    `.execute(db);
    expect(behindMiss.rows).toHaveLength(0);
    const rowAAfterMiss = await sql<{ status: string }>`
      SELECT status FROM provider_resource_balance_refresh
       WHERE idempotency_key = ${keyA}::uuid
    `.execute(db);
    expect(rowAAfterMiss.rows).toHaveLength(1);
    expect(rowAAfterMiss.rows[0]!.status).toBe("RUNNING");

    // 新谓词（DB 钟）：同一行 A 满足 expires_at <= now() → 收敛（1 行，FAILED/
    // REFRESH_LEASE_EXPIRED）。宿主落后 10s 不影响 DB 侧判定。
    const dbClockHit = await sql<{ id: string }>`
      UPDATE provider_resource_balance_refresh
         SET status = 'FAILED', error_code = 'REFRESH_LEASE_EXPIRED',
             finished_at = now(), updated_at = now()
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
         AND status = 'RUNNING'
         AND expires_at <= now()
      RETURNING id::text AS id
    `.execute(db);
    expect(dbClockHit.rows).toHaveLength(1);
    const rowAConverged = await sql<{ status: string; error_code: string | null }>`
      SELECT status, error_code FROM provider_resource_balance_refresh
       WHERE idempotency_key = ${keyA}::uuid
    `.execute(db);
    expect(rowAConverged.rows).toHaveLength(1);
    expect(rowAConverged.rows[0]).toMatchObject({ status: "FAILED",
      error_code: "REFRESH_LEASE_EXPIRED" });

    // 对照行 B：DB 钟尚未过期（expires_at = now() + 5s）的 RUNNING 租约。
    // 行 A 已终态，满足 RUNNING 部分唯一索引（单资源同时仅一行 RUNNING）。
    const keyB = randomUUID();
    await sql`
      INSERT INTO provider_resource_balance_refresh
        (enterprise_id, provider_resource_id, actor_admin_id, idempotency_key,
         status, started_at, expires_at, updated_at)
      SELECT ${seed.enterpriseId}::uuid, ${seed.deepseekResourceId}::uuid,
             a.id::uuid, ${keyB}::uuid, 'RUNNING',
             now() - interval '1 second', now() + interval '5 seconds', now()
        FROM admin_user a WHERE a.enterprise_id = ${seed.enterpriseId}::uuid LIMIT 1
    `.execute(db);

    // 旧谓词 × 宿主领先 10s：行 B 在 DB 钟上尚未过期（expires_at > dbNow），
    // 却满足 expires_at <= hostAhead → 误收敛（1 行受影响）。
    const aheadFalseHit = await sql<{ id: string }>`
      UPDATE provider_resource_balance_refresh
         SET status = 'FAILED', error_code = 'REFRESH_LEASE_EXPIRED',
             finished_at = ${hostAhead}, updated_at = ${hostAhead}
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
         AND status = 'RUNNING'
         AND expires_at <= ${hostAhead}
      RETURNING id::text AS id
    `.execute(db);
    expect(aheadFalseHit.rows).toHaveLength(1);
    const rowBAfterFalseHit = await sql<{ status: string; error_code: string | null; expires_at: Date }>`
      SELECT status, error_code, expires_at FROM provider_resource_balance_refresh
       WHERE idempotency_key = ${keyB}::uuid
    `.execute(db);
    expect(rowBAfterFalseHit.rows).toHaveLength(1);
    // 被「误收敛」的行在 DB 钟上确实尚未过期（证明这是误杀而非漏网）。
    expect(rowBAfterFalseHit.rows[0]!.expires_at.getTime()).toBeGreaterThan(dbNow.getTime());
    expect(rowBAfterFalseHit.rows[0]!.status).toBe("FAILED");
    expect(rowBAfterFalseHit.rows[0]!.error_code).toBe("REFRESH_LEASE_EXPIRED");

    // 新谓词（DB 钟）：同一行 B 复位 RUNNING 后重放判定 → 正确不收敛（0 行，
    // 仍 RUNNING）。宿主领先 10s 也不影响 DB 侧判定。
    await sql`
      UPDATE provider_resource_balance_refresh
         SET status = 'RUNNING', error_code = NULL, finished_at = NULL, updated_at = now()
       WHERE idempotency_key = ${keyB}::uuid
    `.execute(db);
    const dbClockSkip = await sql<{ id: string }>`
      UPDATE provider_resource_balance_refresh
         SET status = 'FAILED', error_code = 'REFRESH_LEASE_EXPIRED',
             finished_at = now(), updated_at = now()
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
         AND status = 'RUNNING'
         AND expires_at <= now()
      RETURNING id::text AS id
    `.execute(db);
    expect(dbClockSkip.rows).toHaveLength(0);
    const rowBFinal = await sql<{ status: string }>`
      SELECT status FROM provider_resource_balance_refresh
       WHERE idempotency_key = ${keyB}::uuid
    `.execute(db);
    expect(rowBFinal.rows).toHaveLength(1);
    expect(rowBFinal.rows[0]!.status).toBe("RUNNING");
  });

  it("AT-OAB-06 view-only：POST 刷新 403，GET 列表余额可读；不支持厂商 422 零写入；缺凭证 409；未知资源 404", async () => {
    const seed = await seedEnterprise("refresh-perms");
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("70") }));

    const forbidden = await refresh(seed.viewerCookie, seed.deepseekResourceId);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: "permission_denied" });
    expect(fetchMock).not.toHaveBeenCalled();

    const list = await app.inject({
      method: "GET", url: "/provider-resources", headers: { cookie: seed.viewerCookie },
    });
    expect(list.statusCode).toBe(200);
    const listPayload = list.json() as { resources?: Array<{ id: string; operating_snapshot: unknown }> };
    const mine = (listPayload.resources ?? []).find((r) => r.id === seed.deepseekResourceId);
    expect(mine).toBeDefined();
    // 尚未刷新过：快照为 null（不冒充 0 值）；字段通道存在（AT-OAB-06 前半，读侧完整性 S4 深化）。
    expect(mine!.operating_snapshot).toBeNull();

    // 不支持厂商：422 official_balance_not_supported，快照/attempt/refresh 表零写入。
    const unsupported = await refresh(seed.superCookie, seed.zhipuResourceId);
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json()).toMatchObject({ error: "official_balance_not_supported" });
    expect(await snapshotCount(seed.zhipuResourceId)).toBe(0);
    expect(await attemptCount(seed.zhipuResourceId)).toBe(0);
    expect(await refreshRowCount(seed.zhipuResourceId)).toBe(0);

    // 缺凭证：409 credential_missing，零写入。
    const noCred = await refresh(seed.superCookie, seed.noCredentialResourceId);
    expect(noCred.statusCode).toBe(409);
    expect(noCred.json()).toMatchObject({ error: "credential_missing" });
    expect(await refreshRowCount(seed.noCredentialResourceId)).toBe(0);

    // 未知资源：404。
    const missing = await refresh(seed.superCookie, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "not_found" });
  });

  it("AT-X02 上游失败：失败 attempt 留痕、旧快照保留、失败态返回；冷却到期后可再次刷新成功", async () => {
    const seed = await seedEnterprise("refresh-failure");
    // 先成功一次建立"上次成功值"。
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("80") }));
    const okRun = await refresh(seed.superCookie, seed.deepseekResourceId);
    expect((okRun.json() as { result: { outcome: string } }).result.outcome).toBe("SUCCEEDED");
    const snapshotsBefore = await snapshotCount(seed.deepseekResourceId);
    expect(snapshotsBefore).toBe(1);

    // 冷却压缩后触发上游失败（HTTP 500 → INVALID_RESPONSE）。
    await withShortCooldown(async () => {
      stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
      const failedRun = await refresh(seed.superCookie, seed.deepseekResourceId);
      expect(failedRun.statusCode).toBe(200);
      const failedPayload = failedRun.json() as { state: string; result: { outcome: string; error_code: string } };
      expect(failedPayload.state).toBe("ACCEPTED");
      expect(failedPayload.result.outcome).toBe("FAILED");
      // 适配器把 5xx 映射为 UPSTREAM_UNAVAILABLE（provider-operating-facts.ts:69-73）。
      expect(failedPayload.result.error_code).toBe("UPSTREAM_UNAVAILABLE");
    });
    // 失败不写快照：上次成功值与时间天然保留。
    expect(await snapshotCount(seed.deepseekResourceId)).toBe(snapshotsBefore);
    const failedAttempts = await sql<{ balance_status: string; error_code: string; snapshot_id: string | null }>`
      SELECT balance_status, error_code, snapshot_id
        FROM provider_resource_operating_sync_attempt
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
         AND balance_status = 'FAILED'
    `.execute(db);
    expect(failedAttempts.rows).toHaveLength(1);
    expect(failedAttempts.rows[0]!.snapshot_id).toBeNull();
    // 同秒内两行 created_at 可能并列，按 result 分组计数断言（成败各一条）。
    const audits = await sql<{ result: string; count: number }>`
      SELECT result, count(*)::int AS count FROM operation_log
       WHERE target_id = ${seed.deepseekResourceId}::uuid
         AND action = 'provider_resource.official_balance_refresh'
       GROUP BY result
    `.execute(db);
    const auditsByResult = Object.fromEntries(audits.rows.map((r) => [r.result, r.count]));
    expect(auditsByResult["FAILURE"]).toBe(1);
    expect(auditsByResult["SUCCESS"]).toBe(1);

    // 冷却到期后再次刷新成功（AT-X02：失败不进入无限封锁，也不冒充成功值）。
    await withShortCooldown(async () => {
      stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("90") }));
      const retry = await refresh(seed.superCookie, seed.deepseekResourceId);
      expect((retry.json() as { state: string; result: { outcome: string } }).state).toBe("ACCEPTED");
      expect((retry.json() as { result: { outcome: string; balance: { total_balance: string } } }).result.outcome).toBe("SUCCEEDED");
      expect((retry.json() as { result: { balance: { total_balance: string } } }).result.balance.total_balance).toBe("90");
    });
    expect(await snapshotCount(seed.deepseekResourceId)).toBe(2);
    const latestAttempt = await sql<{ balance_status: string }>`
      SELECT balance_status FROM provider_resource_operating_sync_attempt
       WHERE provider_resource_id = ${seed.deepseekResourceId}::uuid
       ORDER BY started_at DESC LIMIT 1
    `.execute(db);
    expect(latestAttempt.rows[0]!.balance_status).toBe("SUCCESS");
  });

  it("C2 列表字段：GET 列表附 official_balance（结构与合同一致），view-only 可读，响应不含凭证", async () => {
    const seed = await seedEnterprise("refresh-c2");
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("110") }));
    const refreshed = await refresh(seed.superCookie, seed.deepseekResourceId);
    expect((refreshed.json() as { result: { outcome: string } }).result.outcome).toBe("SUCCEEDED");

    const list = await app.inject({
      method: "GET", url: "/provider-resources", headers: { cookie: seed.superCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain("sk-test-secret-123");
    const listPayload = list.json() as {
      resources?: Array<{ id: string; official_balance: {
        supported: boolean; status: string; expired: boolean; last_attempt_failed: boolean;
        total_balance: string | null; currency: string | null;
        composition: { granted: string | null; topped: string | null } | null;
        available: boolean | null; last_success_at: string | null;
        last_attempt: { at: string; outcome: string; reason: string | null } | null;
        next_refresh_at: string | null;
      } | null }>;
    };
    const mine = (listPayload.resources ?? []).find((r) => r.id === seed.deepseekResourceId);
    expect(mine?.official_balance).toBeDefined();
    const official = mine!.official_balance!;
    // 刚刷新成功：OK、未过期、冷却窗口内 next_refresh_at 非空。
    expect(official).toMatchObject({ supported: true, status: "OK", expired: false,
      last_attempt_failed: false, total_balance: "110.00000000", currency: "CNY",
      available: true });
    expect(official.composition).toEqual({ granted: "10.00000000", topped: "100.00000000" });
    expect(official.last_success_at).not.toBeNull();
    expect(official.last_attempt?.outcome).toBe("SUCCESS");
    // P3=30s 默认，冷却窗口内 → 下次可刷新时间非空。
    expect(official.next_refresh_at).not.toBeNull();

    // 不支持厂商资源：supported=false → UNSUPPORTED，余额字段全 null。
    const zhipuRow = (listPayload.resources ?? []).find((r) => r.id === seed.zhipuResourceId);
    expect(zhipuRow?.official_balance).toMatchObject({ supported: false, status: "UNSUPPORTED",
      total_balance: null, currency: null, composition: null, available: null,
      last_success_at: null, last_attempt: null, next_refresh_at: null });

    // view-only 管理员同样可读 official_balance（AT-OAB-06 后半的字段层）。
    const viewerList = await app.inject({
      method: "GET", url: "/provider-resources", headers: { cookie: seed.viewerCookie },
    });
    expect(viewerList.statusCode).toBe(200);
    expect(viewerList.body).not.toContain("sk-test-secret-123");
    const viewerPayload = viewerList.json() as typeof listPayload;
    const viewerRow = (viewerPayload.resources ?? []).find((r) => r.id === seed.deepseekResourceId);
    expect(viewerRow?.official_balance).toMatchObject({ supported: true, status: "OK",
      total_balance: "110.00000000" });
  });

  it("EG-02 定向补充：幂等重放——同键终态直接复用既有结果（SUCCEEDED/FAILED），不再触达上游", async () => {
    const seed = await seedEnterprise("refresh-replay");
    const keyOk = randomUUID();
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("120") }));
    const first = await refresh(seed.superCookie, seed.deepseekResourceId, { idempotency_key: keyOk });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { result: { outcome: string } }).result.outcome).toBe("SUCCEEDED");
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // 同键重放：复用 SUCCEEDED 终态，零上游调用、零新增留痕。
    const replayOk = await refresh(seed.superCookie, seed.deepseekResourceId, { idempotency_key: keyOk });
    expect(replayOk.statusCode).toBe(200);
    const okPayload = replayOk.json() as { state: string; result: { outcome: string } };
    expect(okPayload.state).toBe("ACCEPTED");
    expect(okPayload.result.outcome).toBe("SUCCEEDED");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    expect(await refreshRowCount(seed.deepseekResourceId)).toBe(1);
    expect(await attemptCount(seed.deepseekResourceId)).toBe(1);
    expect(await snapshotCount(seed.deepseekResourceId)).toBe(1);

    // FAILED 终态重放：复用既有错误码（幂等重放不受冷却影响，begin 先查键）。
    await withShortCooldown(async () => {
      stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
      const keyFail = randomUUID();
      const failed = await refresh(seed.superCookie, seed.deepseekResourceId, { idempotency_key: keyFail });
      expect(failed.statusCode).toBe(200);
      expect((failed.json() as { result: { outcome: string; error_code: string } }).result)
        .toMatchObject({ outcome: "FAILED", error_code: "UPSTREAM_UNAVAILABLE" });
      const callsAfterFail = fetchMock.mock.calls.length;
      const replayFail = await refresh(seed.superCookie, seed.deepseekResourceId, { idempotency_key: keyFail });
      expect(replayFail.statusCode).toBe(200);
      expect((replayFail.json() as { state: string; result: { outcome: string; error_code: string } }).result)
        .toMatchObject({ outcome: "FAILED", error_code: "UPSTREAM_UNAVAILABLE" });
      expect(fetchMock.mock.calls.length).toBe(callsAfterFail);
      expect(await refreshRowCount(seed.deepseekResourceId)).toBe(2);
    });
  });

  it("EG-02 定向补充：同键 RUNNING 在途 → 重放 IN_PROGRESS（retry_after 取租约剩余秒数），不触达上游", async () => {
    const seed = await seedEnterprise("refresh-replay-running");
    const key = randomUUID();
    await sql`
      INSERT INTO provider_resource_balance_refresh
        (enterprise_id, provider_resource_id, actor_admin_id, idempotency_key,
         status, started_at, expires_at, updated_at)
      SELECT ${seed.enterpriseId}::uuid, ${seed.deepseekResourceId}::uuid,
             a.id::uuid, ${key}::uuid, 'RUNNING', now(), now() + interval '30 seconds', now()
        FROM admin_user a WHERE a.enterprise_id = ${seed.enterpriseId}::uuid LIMIT 1
    `.execute(db);
    stubFetch(() => ({ ok: true, status: 200, json: async () => okBalance("130") }));
    const replay = await refresh(seed.superCookie, seed.deepseekResourceId, { idempotency_key: key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ state: "IN_PROGRESS" });
    const payload = replay.json() as { retry_after_seconds: number };
    expect(payload.retry_after_seconds).toBeGreaterThan(0);
    expect(payload.retry_after_seconds).toBeLessThanOrEqual(60);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("请求体校验：非法 idempotency_key → 400 invalid_request", async () => {
    const seed = await seedEnterprise("refresh-body");
    const bad = await refresh(seed.superCookie, seed.deepseekResourceId, { idempotency_key: "not-a-uuid" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_request" });
  });
});
