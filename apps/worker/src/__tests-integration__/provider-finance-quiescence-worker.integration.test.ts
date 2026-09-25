import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createKysely,
  migrateToLatest,
  ProviderFinanceRepository,
  runSubscriptionAutoRenewals,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { generateOperatingBillGuarded } from "../operating-bill/runner.js";
import { runProviderOperatingSyncTick } from "../provider-operating-sync/runner.js";

/**
 * WP04 任务 4.5：Worker 静默门禁（PFA-09）。
 *
 * 激活预检把"资源、快照、购买、资金事件、订阅周期、用量、计价与运行状态"的完整事实水位
 * 冻结进候选。静默期内任何会改变这些事实的定时任务都会让候选立刻漂移——因此
 * Worker 必须在**服务端时间**判定下整企业跳过：
 * - 自动续订（写资金事件 + 订阅周期）；
 * - 厂商经营同步（写 `provider_resource_operating_snapshot`）；
 * - 月账聚合（读取涉及月份完整性，被跳过而不是"以过期快照生成"）。
 *
 * 跳过不是失败：租约到期或被解除后下一个 tick 自动恢复，无需人工干预或补偿。
 */

const PASSWORD_HASH = "not-used";
const KEK = Buffer.alloc(32, 7).toString("base64");
const DAY = 86_400_000;
const d = (value: string) => new Date(`${value}T00:00:00+08:00`);

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

beforeAll(async () => {
  pg = await startPostgresContainer("provider_finance_quiescence_worker");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 180_000);

afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

interface Fixture {
  enterpriseId: string; adminId: string; apiResourceId: string; planResourceId: string;
}

/** 自足夹具：一个企业 + 一个 API 资源 + 一个已登记自动续订的 Coding Plan 资源。 */
async function seed(name: string, periodEndExclusive: Date): Promise<Fixture> {
  const enterpriseId = randomUUID(); const adminId = randomUUID();
  const providerId = randomUUID(); const apiResourceId = randomUUID(); const planResourceId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
    username: `${name}-admin`, password_hash: PASSWORD_HASH, status: "ACTIVE" }).execute();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: "kimi", name: `Kimi ${name}`, adapter_type: "OPENAI_COMPATIBLE", status: "ACTIVE" }).execute();
  await db.insertInto("provider_resource").values([
    { id: apiResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: `${name}-API`, mode: "API", credential_type: "API_KEY", status: "ACTIVE" },
    { id: planResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: `${name}-PLAN`, mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
      status: "ACTIVE" },
  ]).execute();
  // 自动续订只在企业已激活严格资金写时运行。
  await sql`
    INSERT INTO provider_finance_runtime_state
      (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at)
    VALUES (${enterpriseId}::uuid, true, now(), ${adminId}::uuid, now())
  `.execute(db);
  await new ProviderFinanceRepository(db).recordSubscription({
    enterpriseId, resourceId: planResourceId, adminId, kind: "PURCHASE",
    productName: `Kimi 套餐 ${name}`, accountAmount: "199", accountCurrency: "CNY",
    cashPaidCny: "199", occurredAt: new Date(periodEndExclusive.getTime() - DAY),
    periodStart: new Date(periodEndExclusive.getTime() - DAY), periodEndExclusive,
    idempotencyKey: randomUUID(),
  });
  return { enterpriseId, adminId, apiResourceId, planResourceId };
}

/** 建立"相对给定 tick 时间仍有效"的静默租约（窗口约束：expires ≤ started + 60min）。 */
async function upsertLease(fixture: Fixture, input: {
  status: "ACTIVE" | "RELEASED" | "EXPIRED"; startedAt: Date; expiresAt: Date;
  releasedAt?: Date; reason?: string;
}): Promise<void> {
  await sql`
    INSERT INTO provider_finance_activation_quiescence
      (enterprise_id, status, started_by_admin_user_id, started_at, expires_at,
       released_at, release_reason)
    VALUES (${fixture.enterpriseId}::uuid, ${input.status}, ${fixture.adminId}::uuid,
            ${input.startedAt}, ${input.expiresAt}, ${input.releasedAt ?? null}, ${input.reason ?? null})
    ON CONFLICT (enterprise_id) DO UPDATE SET
      status = EXCLUDED.status, started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at,
      released_at = EXCLUDED.released_at, release_reason = EXCLUDED.release_reason
  `.execute(db);
}

async function renewalEvents(enterpriseId: string): Promise<number> {
  const row = await db.selectFrom("provider_finance_event")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("enterprise_id", "=", enterpriseId)
    .where("source", "=", "SYSTEM_RENEWAL").executeTakeFirstOrThrow();
  return Number(row.count);
}

async function syncAttempts(enterpriseId: string): Promise<number> {
  const row = await db.selectFrom("provider_resource_operating_sync_attempt")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
  return Number(row.count);
}

describe.sequential("PF-INIT WP04：Worker 静默跳过与自动恢复", () => {
  it("自动续订：有效静默租约内整企业跳过（零资金事件），租约到期后自动恢复", async () => {
    const tickNow = d("2026-09-02");
    const fixture = await seed("pf04_renewal", d("2026-09-02"));

    // 静默期内：即使到期必须续订，也必须整企业跳过。
    await upsertLease(fixture, { status: "ACTIVE", startedAt: new Date(tickNow.getTime() - 60_000),
      expiresAt: new Date(tickNow.getTime() + 30 * 60_000) });
    const skipped = await runSubscriptionAutoRenewals(db, tickNow);
    expect(skipped.created).toBe(0);
    expect(skipped.failures).toEqual([]);
    expect(skipped.skippedQuiescentEnterprises).toEqual([fixture.enterpriseId]);
    expect(await renewalEvents(fixture.enterpriseId)).toBe(0);

    // 租约到期（服务端时间判定，无需清理动作）→ 下一个 tick 自动恢复续订。
    // 窗口仍是合法的 30 分钟租约，只是整体落在过去（窗口约束要求 expires ≤ started + 60min）。
    await upsertLease(fixture, { status: "ACTIVE",
      startedAt: new Date(tickNow.getTime() - 60 * 60_000),
      expiresAt: new Date(tickNow.getTime() - 30 * 60_000) });
    const recovered = await runSubscriptionAutoRenewals(db, tickNow);
    expect(recovered.skippedQuiescentEnterprises).toEqual([]);
    expect(recovered.created).toBe(1);
    expect(await renewalEvents(fixture.enterpriseId)).toBe(1);
  });

  it("月账聚合：静默期内返回 SKIPPED_QUIESCENT 且不读取聚合；解除后恢复生成", async () => {
    const fixture = await seed("pf04_bill", d("2026-09-02"));
    let calls = 0;
    const repository = { getBill: async (enterpriseId: string, month: string) => {
      calls += 1;
      return { enterpriseId, month } as never;
    } };

    // 无租约：走真实聚合路径。
    const generated = await generateOperatingBillGuarded({ db, repository,
      enterpriseId: fixture.enterpriseId, month: "2026-09" });
    expect(generated.status).toBe("GENERATED");
    expect(calls).toBe(1);

    const now = new Date();
    await upsertLease(fixture, { status: "ACTIVE", startedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60_000) });
    const skipped = await generateOperatingBillGuarded({ db, repository,
      enterpriseId: fixture.enterpriseId, month: "2026-09" });
    expect(skipped).toEqual({ status: "SKIPPED_QUIESCENT" });
    // 跳过必须**早于**聚合：不能"读了过期快照再决定不落库"。
    expect(calls).toBe(1);

    // 解除租约后恢复生成。
    await upsertLease(fixture, { status: "RELEASED", startedAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 60_000), releasedAt: new Date(),
      reason: "静默窗口结束" });
    const after = await generateOperatingBillGuarded({ db, repository,
      enterpriseId: fixture.enterpriseId, month: "2026-09" });
    expect(after.status).toBe("GENERATED");
    expect(calls).toBe(2);
  });

  it("厂商经营同步：静默期内零扫描零快照零 attempt，跨企业时只跳过目标企业", async () => {
    const fixture = await seed("pf04_sync", d("2026-09-02"));
    const other = await seed("pf04_sync_other", d("2026-09-02"));
    const now = new Date();

    // 无租约：资源进入扫描范围。
    const baseline = await runProviderOperatingSyncTick({ db, kekBase64: KEK, now });
    expect(baseline.skippedQuiescentResources).toBe(0);
    expect(baseline.resourcesScanned).toBeGreaterThanOrEqual(2);
    const otherAttempts = await syncAttempts(other.enterpriseId);
    expect(otherAttempts).toBeGreaterThanOrEqual(1);

    // 目标企业静默：其资源整企业跳过，且不产生任何 sync attempt / snapshot。
    await upsertLease(fixture, { status: "ACTIVE", startedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60_000) });
    const before = await syncAttempts(fixture.enterpriseId);
    const tick = await runProviderOperatingSyncTick({ db, kekBase64: KEK, now });
    expect(tick.skippedQuiescentResources).toBeGreaterThanOrEqual(1);
    // 只跳过静默企业：其它企业的资源仍在扫描（不是全局停摆）。
    expect(tick.resourcesScanned).toBeGreaterThanOrEqual(2);
    expect(tick.resourcesScanned).toBe(baseline.resourcesScanned - tick.skippedQuiescentResources);
    expect(await syncAttempts(fixture.enterpriseId)).toBe(before);
    const snapshots = await db.selectFrom("provider_resource_operating_snapshot")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("enterprise_id", "=", fixture.enterpriseId)
      .where("source", "=", "PROVIDER_SYNC").executeTakeFirstOrThrow();
    expect(Number(snapshots.count)).toBe(0);

    // 租约解除后目标企业重新进入扫描范围。
    await upsertLease(fixture, { status: "RELEASED", startedAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 60_000), releasedAt: new Date(), reason: "结束" });
    const restored = await runProviderOperatingSyncTick({ db, kekBase64: KEK, now });
    expect(restored.skippedQuiescentResources).toBe(0);
    expect(await syncAttempts(fixture.enterpriseId)).toBeGreaterThanOrEqual(1);
  });
});
