import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { ActivationDraft } from "@qianliu/domain";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { countFinanceGaps } from "../repositories/provider-finance-gaps.js";

import {
  createKysely,
  GatewayLedgerRepository,
  insertOpeningBalanceTx,
  insertSubscriptionTx,
  mapActivationFailure,
  migrateToLatest,
  PROVIDER_FINANCE_CUTOVER,
  ProviderFinanceActivationCoordinator,
  ProviderFinanceActivationError,
  ProviderFinanceActivationPreviewRepository,
  ProviderFinanceError,
  applyUsageRepairsTx,
  type ActivateInput,
} from "../index.js";

/**
 * WP03 集成测试（PFA-02～PFA-07、PFH-02～PFH-05）。
 *
 * 与 domain 单测互补：这里只证明"必须依赖真实 PostgreSQL 才能证明"的性质：
 * - 一个 `SERIALIZABLE` 事务内的原子激活与整体回滚（中途失败零写入、进程提交前退出）；
 * - legacy 与 v1 两把 `pg_try_advisory_xact_lock` 的互斥与"不等待"语义；
 * - 四字段修复的行级锁定、逐行非目标哈希复验与"新增行不被吸收"；
 * - 幂等重放 / 同键不同候选 / 已激活不同请求三种终态；
 * - `40001` 覆盖**语句边界与提交边界**、`40P01` 覆盖**语句边界**，两者都映射为
 *   `ACTIVATION_RETRY_REQUIRED` 且零自动重试（`40P01` 未构造真实互锁，故不声称提交边界）。
 */

const CUTOVER_ISO = PROVIDER_FINANCE_CUTOVER.toISOString();
const LEGACY_LOCK = (enterpriseId: string) => `provider-finance-activation:${enterpriseId}`;
const V1_LOCK = (enterpriseId: string) => `qianliu:provider-finance-activation:v1:${enterpriseId}`;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 把一个瞬时按上海时区折算成 `YYYY-MM-DD` 自然日。 */
function shanghaiDay(instant: Date): string {
  return new Date(instant.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 历史用量行的采集时点（严格早于切换时点）与结算时点（切换之后，故进入候选窗口）。
 *
 * 两个门禁共同界定了"可激活的修复行"：
 * - PFH-04 只允许修复**历史**用量；
 * - PFA-09 的排空门禁把**切换时点之后**仍未定价的 API 用量行视作在途结算并拒绝激活。
 *
 * 因此可激活的修复行必然是"切换前采集、切换后结算、但缺少定价/周期归属"的行。
 * 这也解释了为什么修复基准里 `settled_at` 一栏对这类行是空操作：
 * `settled_at IS NULL` 的行要么在窗口之外，要么一定会被排空门禁拦下。
 */
const LEGACY_USAGE_CREATED_AT = new Date("2026-08-25T04:00:00.000Z");
const LEGACY_USAGE_SETTLED_AT = new Date("2026-09-05T04:00:00.000Z");

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer("provider_finance_activation_apply"); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

interface Seeded {
  enterpriseId: string;
  adminId: string;
  secondAdminId: string;
  providerId: string;
  apiResourceId: string;
  planResourceId: string;
  principalId: string;
  principalKeyId: string;
}

describe.sequential("PF-INIT WP03：企业级原子激活", () => {
  type Db = ReturnType<typeof createKysely>;

  async function seedEnterprise(db: Db, name: string): Promise<Seeded> {
    const enterpriseId = randomUUID(); const adminId = randomUUID(); const secondAdminId = randomUUID();
    const providerId = randomUUID(); const apiResourceId = randomUUID(); const planResourceId = randomUUID();
    const principalId = randomUUID(); const principalKeyId = randomUUID();
    await db.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
    await db.insertInto("admin_user").values([
      { id: adminId, enterprise_id: enterpriseId, username: `${name}-a`, display_name: "A",
        password_hash: "test", status: "ACTIVE" },
      { id: secondAdminId, enterprise_id: enterpriseId, username: `${name}-b`, display_name: "B",
        password_hash: "test", status: "ACTIVE" },
    ]).execute();
    await db.insertInto("provider").values({
      id: providerId, enterprise_id: enterpriseId, code: name, name, adapter_type: "OPENAI_COMPATIBLE",
    }).execute();
    await db.insertInto("provider_resource").values([
      { id: apiResourceId, enterprise_id: enterpriseId, provider_id: providerId,
        name: `${name}-API`, mode: "API", credential_type: "API_KEY" },
      { id: planResourceId, enterprise_id: enterpriseId, provider_id: providerId,
        name: `${name}-PLAN`, mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION" },
    ]).execute();
    await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
      type: "EMPLOYEE", name: `${name} user`, department_label: null, person_id: null,
      owner_person_id: null }).execute();
    await db.insertInto("principal_key").values({ id: principalKeyId, enterprise_id: enterpriseId,
      principal_id: principalId, key_prefix: `ql-${name.slice(0, 6)}`, key_digest: `${name}-digest`,
      allowed_model_ids: [], ip_allowlist: [], expires_at: null, quota_limit: null,
      concurrency_limit: null, last_used_at: null, revoked_at: null }).execute();
    // 切换时点前采集的厂商余额快照 → 为 API 资源登记 CNY 必要币种账户。
    await sql`
      INSERT INTO provider_resource_operating_snapshot
        (id, enterprise_id, provider_resource_id, version, source, collected_at,
         currency, current_balance, usage_calculation)
      VALUES (${randomUUID()}::uuid, ${enterpriseId}::uuid, ${apiResourceId}::uuid, 1, 'ADMIN',
              ${CUTOVER_ISO}::timestamptz, 'CNY', 50, 'MANUAL_SNAPSHOT')
    `.execute(db);
    return { enterpriseId, adminId, secondAdminId, providerId, apiResourceId, planResourceId,
      principalId, principalKeyId };
  }

  /** 只补期初的最小草稿：足以得到 GO_CANDIDATE。 */
  function draftFor(apiResourceId: string): ActivationDraft {
    return {
      schema_version: "1",
      api_opening_balances: [{
        resource_id: apiResourceId, account_currency: "CNY", account_amount: "100",
        occurred_at: CUTOVER_ISO, description: "切换时点厂商余额",
        evidence_ref: "evidence://opening", source_record_id: null,
      }],
      historical_api_recharges: [],
      coding_plan_purchases: [],
      coding_plan_carryovers: [],
      legacy_purchase_resolutions: [],
    };
  }

  /** 落库一条用量行（含 ai_request / attempt / usage_event 依赖链）。 */
  async function insertLedgerLine(
    db: Db, seeded: Seeded,
    options: {
      mode: "API" | "CODING_PLAN"; resourceId: string;
      settledAt: Date | null; createdAt: Date;
      apiCost?: string | null; apiCostCurrency?: "CNY" | "USD" | null;
      apiCostStatus?: string | null; snapshotCurrency?: string | null;
      billingRuleId?: string | null; tokens?: number; outputTokens?: number;
    },
  ): Promise<string> {
    const requestId = randomUUID();
    const ledger = new GatewayLedgerRepository(db);
    await ledger.createRequest({ id: requestId, enterprise_id: seeded.enterpriseId,
      principal_id: seeded.principalId, principal_key_id: seeded.principalKeyId,
      protocol: "OPENAI_CHAT", unified_model: "deepseek-chat", unified_model_id: null });
    const attempt = await ledger.createAttempt({ ai_request_id: requestId,
      enterprise_id: seeded.enterpriseId, attempt_no: 1,
      provider_resource_id: options.resourceId, upstream_model: "deepseek-chat" });
    const tokens = options.tokens ?? 10;
    // 零 Token 测试由调用方明确区分费用未知与费用已知，不能仅凭 Token 推断零费用。
    const outputTokens = options.outputTokens ?? 2;
    const usage = await ledger.createUsageEventIfAbsent({ ai_request_id: requestId,
      enterprise_id: seeded.enterpriseId, upstream_attempt_id: attempt.id,
      provider_resource_id: options.resourceId, input_tokens: BigInt(tokens),
      output_tokens: BigInt(outputTokens),
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: `${requestId}:attempt1` });
    const lineId = randomUUID();
    const snapshot = options.snapshotCurrency === undefined ? null
      : JSON.stringify({ currency: options.snapshotCurrency });
    await sql`
      INSERT INTO ledger_line
        (id, ai_request_id, enterprise_id, usage_event_id, upstream_attempt_id,
         provider_resource_id, principal_id, resource_mode, raw_input_tokens,
         raw_output_tokens, raw_cache_tokens, raw_reasoning_tokens, deducted_quota,
         api_cost, api_cost_currency, api_cost_status, subscription_period_id,
         settled_at, usage_quality, billing_rule_snapshot, billing_rule_id, created_at)
      VALUES (${lineId}::uuid, ${requestId}::uuid, ${seeded.enterpriseId}::uuid,
              ${usage!.id}::uuid, ${attempt.id}::uuid, ${options.resourceId}::uuid,
              ${seeded.principalId}::uuid, ${options.mode}, ${tokens}, ${outputTokens}, 0, 0, NULL,
              ${options.apiCost ?? null}, ${options.apiCostCurrency ?? null},
              ${options.apiCostStatus ?? null}, NULL, ${options.settledAt}, 'PROVIDER_REPORTED',
              ${snapshot}::jsonb, ${options.billingRuleId ?? null}, ${options.createdAt})
    `.execute(db);
    // 依赖链必须已终结，否则 PFA-09 静默排空门禁会因"在途请求/未完成 Attempt"拒绝激活。
    const finishedAt = options.settledAt ?? options.createdAt;
    await sql`UPDATE ai_request SET status='SUCCEEDED', finished_at=${finishedAt}
               WHERE id=${requestId}::uuid`.execute(db);
    await sql`UPDATE upstream_attempt SET finished_at=${finishedAt}, http_status=200
               WHERE id=${attempt.id}::uuid`.execute(db);
    return lineId;
  }

  /** 资金/控制表按企业的行数快照，用于证明零写入。 */
  async function financeCounts(db: Db, enterpriseId: string): Promise<Record<string, number>> {
    const tables = [
      "provider_finance_event", "provider_subscription_period", "ledger_line",
      "provider_finance_activation_attempt", "provider_finance_activation_quiescence",
      "provider_resource_finance_state", "provider_finance_runtime_state", "operation_log",
    ] as const;
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM ${sql.table(table)}
         WHERE enterprise_id=${enterpriseId}::uuid`.execute(db);
      counts[table] = Number(row.rows[0]!.count);
    }
    return counts;
  }

  async function startLease(db: Db, seeded: Seeded, durationSeconds = 3600): Promise<void> {
    const repo = new ProviderFinanceActivationCoordinator(db);
    await repo.startQuiescenceLease({
      enterpriseId: seeded.enterpriseId, adminId: seeded.adminId, now: new Date(), durationSeconds,
    });
  }

  /** 预检出一个 GO 候选，返回候选视图与激活入参骨架。 */
  async function previewGo(db: Db, seeded: Seeded, draft: ActivationDraft) {
    const repo = new ProviderFinanceActivationPreviewRepository(db);
    const preview = await repo.previewActivation({
      enterpriseId: seeded.enterpriseId, adminId: seeded.adminId, draft,
    });
    expect(preview.decision).toBe("GO_CANDIDATE");
    expect(preview.gaps).toEqual([]);
    return preview;
  }

  function activateInput(
    seeded: Seeded, preview: { candidateId: string; candidateHash: string },
    draft: ActivationDraft, idempotencyKey: string, overrides: Partial<ActivateInput> = {},
  ): ActivateInput {
    return {
      enterpriseId: seeded.enterpriseId, adminId: seeded.adminId,
      candidateId: preview.candidateId, candidateHash: preview.candidateHash,
      idempotencyKey, confirmEnterpriseId: seeded.enterpriseId, draft, ...overrides,
    };
  }

  async function candidateStatus(db: Db, candidateId: string): Promise<string> {
    const row = await db.selectFrom("provider_finance_activation_attempt").select("status")
      .where("id", "=", candidateId).executeTakeFirstOrThrow();
    return row.status;
  }

  async function assertNoActivating(db: Db, enterpriseId: string): Promise<void> {
    const rows = await db.selectFrom("provider_finance_activation_attempt").select("status")
      .where("enterprise_id", "=", enterpriseId).execute();
    expect(rows.map((row) => row.status)).not.toContain("ACTIVATING");
  }

  // =====================================================================
  // 1. 成功路径与同键同候选重放
  // =====================================================================

  it("零 Token 但费用未知的失败与成功 API 行都使资金预检 NO_GO", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_zero_unknown");
      const at = new Date("2026-09-10T04:00:00.000Z");
      const failedLine = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: at, createdAt: at,
        apiCost: null, apiCostStatus: "UNKNOWN_COST", tokens: 0, outputTokens: 0,
      });
      const failedRequest = await db.selectFrom("ledger_line").select("ai_request_id")
        .where("id", "=", failedLine).executeTakeFirstOrThrow();
      await db.updateTable("ai_request").set({ status: "FAILED" })
        .where("id", "=", failedRequest.ai_request_id).execute();
      await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: at, createdAt: at,
        apiCost: null, apiCostStatus: null, tokens: 0, outputTokens: 0,
      });
      const gaps = await countFinanceGaps(db, seeded.enterpriseId, PROVIDER_FINANCE_CUTOVER,
        new Date("2026-10-01T00:00:00+08:00"));
      expect(gaps.find((gap) => gap.code === "API_USAGE_COST_UNKNOWN")?.count).toBe("2");
      await startLease(db, seeded);
      const preview = await new ProviderFinanceActivationPreviewRepository(db).previewActivation({
        enterpriseId: seeded.enterpriseId, adminId: seeded.adminId,
        draft: draftFor(seeded.apiResourceId),
      });
      expect(preview.decision).toBe("NO_GO");
      expect(preview.gaps.some((gap) => gap.code === "UNKNOWN_COST")).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it("激活成功：事实落库、严格写开启、范围资源 READY、候选 ACTIVATED 与不可变回执；同键同候选重放", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_success");
      const draft = draftFor(seeded.apiResourceId);
      // 一条切换时点前采集、切换后结算、但始终未定价的 API 用量行
      // → 固定修复行（api_cost_currency + api_cost_status）。
      const lineId = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: LEGACY_USAGE_SETTLED_AT,
        createdAt: LEGACY_USAGE_CREATED_AT, apiCost: "1.5", snapshotCurrency: "CNY",
      });
      await startLease(db, seeded);
      const preview = await previewGo(db, seeded, draft);
      expect(preview.usageRepairBaseline.map((row) => row.ledgerLineId)).toEqual([lineId]);

      const repo = new ProviderFinanceActivationCoordinator(db);
      const outcome = await repo.activate(activateInput(seeded, preview, draft, "activate-happy"));

      expect(outcome.replayed).toBe(false);
      expect(outcome.receipt.conservationPassed).toBe(true);
      expect(outcome.receipt.conservationFailures).toEqual([]);
      expect(outcome.receipt.factCounts.openings).toBe(1);
      expect(outcome.receipt.factCounts.usageRepairs).toBe(1);
      expect(outcome.receipt.monthsChecked).toEqual(preview.projection.monthsChecked);
      expect(await candidateStatus(db, preview.candidateId)).toBe("ACTIVATED");
      await assertNoActivating(db, seeded.enterpriseId);

      // 初始化事实与严格写。
      const opening = await db.selectFrom("provider_finance_event").selectAll()
        .where("enterprise_id", "=", seeded.enterpriseId)
        .where("event_type", "=", "API_OPENING_BALANCE").executeTakeFirstOrThrow();
      expect(opening.account_amount).toBe("100.00000000");
      expect(opening.occurred_at.toISOString()).toBe(CUTOVER_ISO);
      const runtime = await sql<{ strict_writes_enabled: boolean; activated_at: Date | null }>`
        SELECT strict_writes_enabled, activated_at FROM provider_finance_runtime_state
         WHERE enterprise_id=${seeded.enterpriseId}::uuid`.execute(db);
      expect(runtime.rows[0]?.strict_writes_enabled).toBe(true);
      expect(runtime.rows[0]?.activated_at).not.toBeNull();

      // 范围资源 READY 且登记必要币种；只覆盖 API 资源。
      const states = await db.selectFrom("provider_resource_finance_state").selectAll()
        .where("enterprise_id", "=", seeded.enterpriseId).execute();
      expect(states.map((row) => row.provider_resource_id)).toEqual([seeded.apiResourceId]);
      expect(states[0]!.state).toBe("READY");
      expect(states[0]!.required_currencies).toEqual(["CNY"]);
      expect(states[0]!.ready_by_admin_user_id).toBe(seeded.adminId);

      // 四字段修复生效，且非目标字段（Token）未变。
      const line = await db.selectFrom("ledger_line").selectAll().where("id", "=", lineId)
        .executeTakeFirstOrThrow();
      expect(line.settled_at).not.toBeNull();
      expect(line.api_cost_status).toBe("PRICED_USAGE");
      expect(line.api_cost_currency).toBe("CNY");
      expect(line.raw_input_tokens).toBe("10");

      // 审计含候选哈希、事实计数与修复摘要。
      const audit = await db.selectFrom("operation_log").selectAll()
        .where("enterprise_id", "=", seeded.enterpriseId)
        .where("action", "=", "provider_finance.activation.activate").executeTakeFirstOrThrow();
      const summary = audit.change_summary as Record<string, unknown>;
      expect(summary.candidate_hash).toBe(preview.candidateHash);
      expect(summary.fact_watermark_hash).toBe(preview.factWatermark.hash);
      expect(summary.idempotency_key).toBe("activate-happy");

      // 提交成功但响应丢失：同键同候选重放首次回执，不产生第二组事实。
      const replay = await repo.activate(activateInput(seeded, preview, draft, "activate-happy"));
      expect(replay.replayed).toBe(true);
      expect(replay.receipt).toEqual(outcome.receipt);
      const openings = await db.selectFrom("provider_finance_event")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("enterprise_id", "=", seeded.enterpriseId)
        .where("event_type", "=", "API_OPENING_BALANCE").executeTakeFirstOrThrow();
      expect(openings.count).toBe("1");
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 2. 幂等与终态冲突（3.4）
  // =====================================================================

  it("幂等冲突：同键不同候选 IDEMPOTENCY_CONFLICT；已激活不同请求 ALREADY_ACTIVATED", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_conflict");
      const draft = draftFor(seeded.apiResourceId);
      await startLease(db, seeded);
      const preview = await previewGo(db, seeded, draft);
      const repo = new ProviderFinanceActivationCoordinator(db);
      const first = await repo.activate(activateInput(seeded, preview, draft, "key-alpha"));
      expect(first.replayed).toBe(false);

      // 同键但候选不同（另一候选 id）→ 冲突，不得伪装成重放。
      await expect(repo.activate(activateInput(seeded,
        { candidateId: randomUUID(), candidateHash: preview.candidateHash }, draft, "key-alpha")))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      // 同键同候选但哈希不同 → 同样是幂等冲突。
      await expect(repo.activate(activateInput(seeded,
        { candidateId: preview.candidateId, candidateHash: "f".repeat(64) }, draft, "key-alpha")))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      // 已激活企业不得再产出可激活候选：严格写已开启，预检直接拒绝。
      const second = new ProviderFinanceActivationPreviewRepository(db);
      await expect(second.previewActivation({
        enterpriseId: seeded.enterpriseId, adminId: seeded.adminId, draft: draftFor(seeded.apiResourceId),
      })).rejects.toMatchObject({ code: "ALREADY_ACTIVATED" });
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-beta")))
        .rejects.toMatchObject({ code: "ALREADY_ACTIVATED" });

      expect(await candidateStatus(db, preview.candidateId)).toBe("ACTIVATED");
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 3. 锁竞争与旧/新锁互斥（PFA-05）
  // =====================================================================

  it("legacy 锁与 v1 锁：任一被占用即立即 409 ACTIVATION_IN_PROGRESS，释放后恢复正常", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_locks");
      const draft = draftFor(seeded.apiResourceId);
      await startLease(db, seeded);
      const preview = await previewGo(db, seeded, draft);
      const repo = new ProviderFinanceActivationCoordinator(db);
      const before = await financeCounts(db, seeded.enterpriseId);

      // 旧路径（activateStrictWrites）持有的 legacy 命名空间锁必须与新激活互斥。
      await withHeldLock(db, LEGACY_LOCK(seeded.enterpriseId), async () => {
        await expect(repo.activate(activateInput(seeded, preview, draft, "key-lock-legacy")))
          .rejects.toMatchObject({ code: "ACTIVATION_IN_PROGRESS" });
      });
      // 专用 v1 64 位命名空间锁同理。
      await withHeldLock(db, V1_LOCK(seeded.enterpriseId), async () => {
        await expect(repo.activate(activateInput(seeded, preview, draft, "key-lock-v1")))
          .rejects.toMatchObject({ code: "ACTIVATION_IN_PROGRESS" });
      });
      // 锁被占用时零写入，候选保持 PREVIEWED。
      expect(await financeCounts(db, seeded.enterpriseId)).toEqual(before);
      expect(await candidateStatus(db, preview.candidateId)).toBe("PREVIEWED");

      // 锁释放后同一候选可以正常激活。
      const ok = await repo.activate(activateInput(seeded, preview, draft, "key-lock-ok"));
      expect(ok.replayed).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it("双管理员并发激活：最多一组初始化事实与一个激活结果，另一请求失败关闭", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_race");
      const draft = draftFor(seeded.apiResourceId);
      await startLease(db, seeded);
      const preview = await previewGo(db, seeded, draft);
      const repo = new ProviderFinanceActivationCoordinator(db);

      const results = await Promise.allSettled([
        repo.activate(activateInput(seeded, preview, draft, "race-key")),
        repo.activate(activateInput(seeded, preview, draft, "race-key",
          { adminId: seeded.secondAdminId })),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      const codes = results.filter((result) => result.status === "rejected")
        .map((result) => (result as PromiseRejectedResult).reason as ProviderFinanceActivationError)
        .map((error) => error.code);
      for (const code of codes) {
        expect(["ACTIVATION_IN_PROGRESS", "ALREADY_ACTIVATED", "ACTIVATION_RETRY_REQUIRED"])
          .toContain(code);
      }
      // 唯一性：一组期初、一行激活结果。
      const openings = await db.selectFrom("provider_finance_event")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("enterprise_id", "=", seeded.enterpriseId)
        .where("event_type", "=", "API_OPENING_BALANCE").executeTakeFirstOrThrow();
      expect(openings.count).toBe("1");
      const activated = await db.selectFrom("provider_finance_activation_attempt").select("id")
        .where("enterprise_id", "=", seeded.enterpriseId).where("status", "=", "ACTIVATED").execute();
      expect(activated).toHaveLength(1);
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 4. 静默门禁（PFA-09）
  // =====================================================================

  it("静默门禁：无租约、剩余不足 5 分钟、未排空都拒绝且零写入", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_quiescence");
      const draft = draftFor(seeded.apiResourceId);
      const repo = new ProviderFinanceActivationCoordinator(db);

      // 无租约：先预检（预检本身不要求门禁通过），再尝试激活。
      const preview = await previewGo(db, seeded, draft);
      const before = await financeCounts(db, seeded.enterpriseId);
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-no-lease")))
        .rejects.toMatchObject({ code: "ACTIVATION_NOT_QUIESCENT" });

      // 租约剩余不足 5 分钟：建立一份只有 4 分钟的租约。
      // 用"短租约"而不是把 now 推后，是为了让候选的 30 分钟 TTL 仍然有效，
      // 从而把失败确切归因到静默门禁而不是候选过期。
      await startLease(db, seeded, 240);
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-short-lease")))
        .rejects.toMatchObject({ code: "ACTIVATION_NOT_QUIESCENT" });

      // 重新建立有效租约，使后续失败可确切归因到"排空未完成"。
      await startLease(db, seeded);

      // 排空：切换时点之后仍存在「未结算/未分类」的 API 用量行，且它不在任何候选的固定修复行集内。
      // 该行刻意用零 Token、已知费用构造：它不构成费用未知缺口（仍能预检出 GO 候选），
      // 但确实是切换时点之后未定价、且现有规则无法确定修复的行 → 必须被排空门禁拦下。
      const unfrozenLine = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId,
        settledAt: new Date("2026-09-08T04:00:00.000Z"),
        createdAt: new Date("2026-09-08T04:00:00.000Z"),
        apiCost: "6", apiCostCurrency: "CNY", tokens: 0, outputTokens: 0,
      });
      // 重新预检，让候选水位包含该行——失败必须归因到排空门禁本身，而不是候选漂移。
      const blocked = await previewGo(db, seeded, draft);
      expect(blocked.usageRepairBaseline.map((row) => row.ledgerLineId)).not.toContain(unfrozenLine);
      await expect(repo.activate(activateInput(seeded, blocked, draft, "key-unpaired")))
        .rejects.toMatchObject({ code: "ACTIVATION_NOT_QUIESCENT" });

      // 在途请求：这不是"等待确定性修复的历史事实"，任何情况下都不豁免。
      await sql`
        INSERT INTO ai_request (id, enterprise_id, principal_id, principal_key_id, protocol,
          unified_model, status, started_at)
        VALUES (${randomUUID()}::uuid, ${seeded.enterpriseId}::uuid, ${seeded.principalId}::uuid,
                ${seeded.principalKeyId}::uuid, 'OPENAI_CHAT', 'deepseek-chat', 'IN_PROGRESS', now())
      `.execute(db);
      await expect(repo.activate(activateInput(seeded, blocked, draft, "key-not-drained")))
        .rejects.toMatchObject({ code: "ACTIVATION_NOT_QUIESCENT" });

      // 四种拒绝都不得留下任何事实写入。
      const after = await financeCounts(db, seeded.enterpriseId);
      expect(after.provider_finance_event).toBe(before.provider_finance_event);
      expect(after.provider_subscription_period).toBe(before.provider_subscription_period);
      expect(after.provider_resource_finance_state).toBe(before.provider_resource_finance_state);
      expect(after.provider_finance_runtime_state).toBe(before.provider_finance_runtime_state);
      expect(await candidateStatus(db, preview.candidateId)).toBe("PREVIEWED");
      expect(before.provider_finance_event).toBe(0);
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 4b. 排空门禁的豁免边界（PFH-04 主路径可达性）
  // =====================================================================

  it("候选已冻结的切换后未结算可修复行可通过排空并在同一事务修复；在途请求与未结束 Attempt 不豁免", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_drain_scope");
      const draft = draftFor(seeded.apiResourceId);
      const repo = new ProviderFinanceActivationCoordinator(db);
      await startLease(db, seeded);

      // 生产口径的终态行：**切换时点之后创建**、`settled_at` 仍为 NULL，
      // 但已由候选判定为确定性可修复（定价规则快照币种为 CNY 且 api_cost 已知）。
      // 修复会把它标成 PRICED_USAGE，因此它不构成经营账单缺口，候选仍为 GO_CANDIDATE。
      const frozenLine = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: null,
        createdAt: new Date("2026-09-03T04:00:00.000Z"), apiCost: "2.5", snapshotCurrency: "CNY",
      });
      const preview = await previewGo(db, seeded, draft);
      expect(preview.usageRepairBaseline.map((row) => row.ledgerLineId)).toEqual([frozenLine]);
      expect(preview.usageRepairBaseline[0]!.eligibleRepairs).toContain("settled_at");

      // 回归护栏：不传豁免集时，这一行确实被计入"未结算/未分类"并判定未排空——
      // 也就是说没有这个豁免出口，四字段修复的主路径在生产上不可达。
      const strict = await repo.collectDrainReport(seeded.enterpriseId);
      expect(strict.unpairedUsageLines).toBe(1);
      expect(strict.exoneratedUsageLines).toBe(0);
      expect(strict.drained).toBe(false);

      // 传入候选固定行集后：该行恰好被排除，其余计数不变，豁免数可审计。
      const scoped = await repo.collectDrainReport(seeded.enterpriseId, undefined, {
        excludeLedgerLineIds: preview.usageRepairBaseline.map((row) => row.ledgerLineId),
      });
      expect(scoped.unpairedUsageLines).toBe(0);
      expect(scoped.exoneratedUsageLines).toBe(1);
      expect(scoped.drained).toBe(true);

      // 在途请求即使企业里已存在候选固定行，也绝不进入豁免。
      const ledger = new GatewayLedgerRepository(db);
      const inFlightId = randomUUID();
      await ledger.createRequest({
        id: inFlightId, enterprise_id: seeded.enterpriseId, principal_id: seeded.principalId,
        principal_key_id: seeded.principalKeyId, protocol: "OPENAI_CHAT",
        unified_model: "deepseek-chat", unified_model_id: null,
      });
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-inflight")))
        .rejects.toMatchObject({ code: "ACTIVATION_NOT_QUIESCENT" });

      // 请求终结后仍有未结束的 Attempt → 同样不豁免。
      await ledger.createAttempt({
        ai_request_id: inFlightId, enterprise_id: seeded.enterpriseId, attempt_no: 1,
        provider_resource_id: seeded.apiResourceId, upstream_model: "deepseek-chat",
      });
      await sql`UPDATE ai_request SET status='SUCCEEDED', finished_at=now()
                 WHERE id=${inFlightId}::uuid`.execute(db);
      const attemptOnly = await repo.collectDrainReport(seeded.enterpriseId, undefined,
        { excludeLedgerLineIds: [frozenLine] });
      expect(attemptOnly.inProgressRequests).toBe(0);
      expect(attemptOnly.openAttempts).toBe(1);
      expect(attemptOnly.unpairedUsageLines).toBe(0);
      expect(attemptOnly.drained).toBe(false);
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-attempt")))
        .rejects.toMatchObject({ code: "ACTIVATION_NOT_QUIESCENT" });

      // 被拦下的两次尝试都必须是零写入、候选保持 PREVIEWED。
      const counts = await financeCounts(db, seeded.enterpriseId);
      expect(counts.provider_finance_event).toBe(0);
      expect(counts.provider_finance_runtime_state).toBe(0);
      expect(counts.provider_resource_finance_state).toBe(0);
      expect(await candidateStatus(db, preview.candidateId)).toBe("PREVIEWED");

      // 收尾在途工作后，同一候选可以激活，并在同一事务内修复该固定行。
      await sql`UPDATE upstream_attempt SET finished_at=now(), http_status=200
                 WHERE ai_request_id=${inFlightId}::uuid`.execute(db);
      const outcome = await repo.activate(activateInput(seeded, preview, draft, "key-frozen"));
      expect(outcome.receipt.factCounts.usageRepairs).toBe(1);
      const repaired = await db.selectFrom("ledger_line").selectAll()
        .where("id", "=", frozenLine).executeTakeFirstOrThrow();
      // `settled_at` 由候选基准补为创建时点，定价与币种同事务落库。
      expect(repaired.settled_at?.toISOString()).toBe("2026-09-03T04:00:00.000Z");
      expect(repaired.api_cost_status).toBe("PRICED_USAGE");
      expect(repaired.api_cost_currency).toBe("CNY");
      expect(repaired.subscription_period_id).toBeNull();
      expect(await candidateStatus(db, preview.candidateId)).toBe("ACTIVATED");
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  it("排空豁免只认候选冻结行：预检后出现的同形状行与新行都被挡下且不被修复", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_drain_freeze");
      const draft = draftFor(seeded.apiResourceId);
      const repo = new ProviderFinanceActivationCoordinator(db);
      await startLease(db, seeded);

      // 候选冻结的固定行：与上一个用例同形状（切换后创建、未结算、确定性可修复）。
      const frozenLine = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: null,
        createdAt: new Date("2026-09-02T04:00:00.000Z"), apiCost: "1", snapshotCurrency: "CNY",
      });
      const preview = await previewGo(db, seeded, draft);
      expect(preview.usageRepairBaseline.map((row) => row.ledgerLineId)).toEqual([frozenLine]);

      // (a) **同形状**但晚于候选出现的行：它不在候选固定行集里，因此既拿不到豁免、也不会被修复。
      const lateSameShape = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: null,
        createdAt: new Date("2026-09-06T04:00:00.000Z"), apiCost: "3", snapshotCurrency: "CNY",
      });
      expect(preview.usageRepairBaseline.map((row) => row.ledgerLineId)).not.toContain(lateSameShape);
      const beforeSameShape = await financeCounts(db, seeded.enterpriseId);
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-late-frozen")))
        .rejects.toMatchObject({ code: "CANDIDATE_STALE" });
      expect(await financeCounts(db, seeded.enterpriseId)).toEqual(beforeSameShape);
      expect(await candidateStatus(db, preview.candidateId)).toBe("PREVIEWED");

      // (b) 预检后新增的任意新行同样不会被吸收。
      const lateOther = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId,
        settledAt: new Date("2026-09-09T04:00:00.000Z"),
        createdAt: new Date("2026-09-09T04:00:00.000Z"),
        apiCost: "4", apiCostCurrency: "CNY", tokens: 0,
      });
      const beforeOther = await financeCounts(db, seeded.enterpriseId);
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-late-other")))
        .rejects.toMatchObject({ code: "CANDIDATE_STALE" });
      expect(await financeCounts(db, seeded.enterpriseId)).toEqual(beforeOther);
      expect(beforeOther.provider_finance_event).toBe(0);

      // 三条行的 api_cost_status 全部原样为 NULL：候选冻结集之外的任何行都不会被修复。
      for (const id of [frozenLine, lateSameShape, lateOther]) {
        const row = await db.selectFrom("ledger_line").selectAll().where("id", "=", id)
          .executeTakeFirstOrThrow();
        expect(row.api_cost_status).toBeNull();
      }
      // 两条"未结算且币种为空"的行必须原样保持，证明没有发生任何修复写入。
      for (const id of [frozenLine, lateSameShape]) {
        const row = await db.selectFrom("ledger_line").selectAll().where("id", "=", id)
          .executeTakeFirstOrThrow();
        expect(row.api_cost_currency).toBeNull();
        expect(row.settled_at).toBeNull();
      }
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 5. 候选过期与水位漂移（PFA-01、PFA-03）
  // =====================================================================

  it("候选过期 409 CANDIDATE_EXPIRED；预检后新增事实 409 CANDIDATE_STALE 且零写入", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_stale");
      const draft = draftFor(seeded.apiResourceId);
      await startLease(db, seeded);
      const preview = await previewGo(db, seeded, draft);
      const repo = new ProviderFinanceActivationCoordinator(db);

      // 过期：now 超过候选 expires_at（TTL 不滑动续期）。
      const expiredNow = new Date(new Date(preview.expiresAt).getTime() + 1_000);
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-expired",
        { now: expiredNow }))).rejects.toMatchObject({ code: "CANDIDATE_EXPIRED" });

      // 水位漂移：预检后出现新的历史 ledger_line（采集时点早于切换时点，不触发排空门禁），
      // 但完整事实水位已变化。
      await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: LEGACY_USAGE_SETTLED_AT,
        createdAt: LEGACY_USAGE_CREATED_AT, apiCost: "2", snapshotCurrency: "CNY",
      });
      const before = await financeCounts(db, seeded.enterpriseId);
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-stale")))
        .rejects.toMatchObject({ code: "CANDIDATE_STALE" });
      expect(await financeCounts(db, seeded.enterpriseId)).toEqual(before);
      expect(await candidateStatus(db, preview.candidateId)).toBe("PREVIEWED");

      // 草稿与候选不一致（改了金额）也必须是 CANDIDATE_STALE，不能静默按新草稿写入。
      const tampered = draftFor(seeded.apiResourceId);
      tampered.api_opening_balances[0]!.account_amount = "999";
      await expect(repo.activate(activateInput(seeded, preview, tampered, "key-tampered")))
        .rejects.toMatchObject({ code: "CANDIDATE_STALE" });
      expect(await financeCounts(db, seeded.enterpriseId)).toEqual(before);
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 6. 固定修复行集：哈希变化与新增行（PFH-04）
  // =====================================================================

  it("固定修复行集只锁定候选主键：新增行不会被吸收，也不放行激活", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_repair_guard");
      const draft = draftFor(seeded.apiResourceId);
      await startLease(db, seeded);
      // 历史修复行：切换前采集、切换后结算、未定价。
      const fixedLine = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: LEGACY_USAGE_SETTLED_AT,
        createdAt: LEGACY_USAGE_CREATED_AT, apiCost: "3", snapshotCurrency: "CNY",
      });
      const preview = await previewGo(db, seeded, draft);
      const storedRow = preview.usageRepairBaseline.find((row) => row.ledgerLineId === fixedLine);
      expect(storedRow).toBeDefined();
      expect(storedRow!.eligibleRepairs).toContain("api_cost_currency");
      expect(storedRow!.eligibleRepairs).toContain("api_cost_status");

      // 候选之后新增的同形行根本不在固定行集内（行集按候选时点冻结）。
      const lateLine = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: LEGACY_USAGE_SETTLED_AT,
        createdAt: LEGACY_USAGE_CREATED_AT, apiCost: "4", snapshotCurrency: "CNY",
      });
      expect(preview.usageRepairBaseline.map((row) => row.ledgerLineId)).not.toContain(lateLine);

      const repo = new ProviderFinanceActivationCoordinator(db);
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-late-line")))
        .rejects.toMatchObject({ code: "CANDIDATE_STALE" });
      // 新增行未被修复、也未被水位豁免；固定行同样未被改动。
      const late = await db.selectFrom("ledger_line").selectAll().where("id", "=", lateLine)
        .executeTakeFirstOrThrow();
      expect(late.api_cost_status).toBeNull();
      expect(late.api_cost_currency).toBeNull();
      const fixed = await db.selectFrom("ledger_line").selectAll().where("id", "=", fixedLine)
        .executeTakeFirstOrThrow();
      expect(fixed.api_cost_status).toBeNull();
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  it("允许字段直测：settled_at 可修复，非目标字段改动被逐行哈希挡住", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_repair_primitive");
      const draft = draftFor(seeded.apiResourceId);
      // 本行只用于**直测 3.2 原语**、不经过协调器，因此不必满足 PFA-09 排空门禁，
      // 可以保留"切换时点后仍未结算"的形态，用以覆盖 settled_at 这一允许字段。
      const settledLine = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: null,
        createdAt: new Date("2026-09-12T04:00:00.000Z"), apiCost: "3", snapshotCurrency: "CNY",
      });
      const preview = await previewGo(db, seeded, draft);
      const storedRow = preview.usageRepairBaseline.find((row) => row.ledgerLineId === settledLine);
      expect(storedRow).toBeDefined();
      expect(storedRow!.eligibleRepairs).toContain("settled_at");

      // 把非目标字段（Token）改掉后按候选基准修复，必须被逐行哈希挡住。
      await db.updateTable("ledger_line").set({ raw_input_tokens: 999n })
        .where("id", "=", settledLine).execute();
      await expect(db.transaction().execute(async (trx) => applyUsageRepairsTx(trx, {
        enterpriseId: seeded.enterpriseId, snapshotAt: new Date(),
        baseline: [{ ...storedRow! }],
        targets: [{
          ledgerLineId: settledLine, settledAt: new Date().toISOString(),
          apiCostCurrency: "CNY", apiCostStatus: "PRICED_USAGE", subscriptionPeriodId: null,
        }],
      }))).rejects.toMatchObject({ code: "CANDIDATE_STALE" });
      // 被拒绝后四个允许字段必须原样未改（只有被篡改的 Token 是 999）。
      const guarded = await db.selectFrom("ledger_line").selectAll().where("id", "=", settledLine)
        .executeTakeFirstOrThrow();
      expect(guarded.settled_at).toBeNull();
      expect(guarded.api_cost_status).toBeNull();
      expect(guarded.api_cost_currency).toBeNull();
      expect(guarded.subscription_period_id).toBeNull();
      expect(guarded.raw_input_tokens).toBe("999");
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 7. 中途故障零写入与进程提交前退出（PFA-04）
  // =====================================================================

  it("中途故障整体回滚；进程提交前退出时候选保持 PREVIEWED 且不存在 ACTIVATING", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_rollback");
      const draft = draftFor(seeded.apiResourceId);
      await startLease(db, seeded);
      const fixedLine = await insertLedgerLine(db, seeded, {
        mode: "API", resourceId: seeded.apiResourceId, settledAt: LEGACY_USAGE_SETTLED_AT,
        createdAt: LEGACY_USAGE_CREATED_AT, apiCost: "5", snapshotCurrency: "CNY",
      });
      const preview = await previewGo(db, seeded, draft);
      const repo = new ProviderFinanceActivationCoordinator(db);
      const before = await financeCounts(db, seeded.enterpriseId);

      // 损坏固定修复行的非目标字段：事实水位与逐行非目标哈希都会捕获它。
      // 无论在哪一步失败，结果都必须是零写入、候选保持 PREVIEWED。
      await db.updateTable("ledger_line").set({ raw_output_tokens: 777n })
        .where("id", "=", fixedLine).execute();
      await expect(repo.activate(activateInput(seeded, preview, draft, "key-partial")))
        .rejects.toMatchObject({ code: "CANDIDATE_STALE" });
      expect(await financeCounts(db, seeded.enterpriseId)).toEqual(before);
      expect(await candidateStatus(db, preview.candidateId)).toBe("PREVIEWED");
      const line = await db.selectFrom("ledger_line").selectAll().where("id", "=", fixedLine)
        .executeTakeFirstOrThrow();
      expect(line.api_cost_status).toBeNull();
      expect(line.api_cost_currency).toBeNull();

      // 进程提交前退出：用同一批 3.1 原语在 SERIALIZABLE 事务内写入多张表（资金事件 + 周期），
      // 然后不提交直接终止——已完成的内部写入必须随事务一并回滚。
      await expect(db.transaction().setIsolationLevel("serializable").execute(async (trx) => {
        await insertOpeningBalanceTx(trx, {
          enterpriseId: seeded.enterpriseId, resourceId: seeded.apiResourceId, adminId: seeded.adminId,
          accountAmount: "123", accountCurrency: "CNY", description: "模拟写入",
          evidenceRef: "evidence://simulated", idempotencyKey: "simulated-opening",
        });
        await insertSubscriptionTx(trx, {
          enterpriseId: seeded.enterpriseId, resourceId: seeded.planResourceId, adminId: seeded.adminId,
          kind: "PURCHASE", productName: "模拟套餐", accountAmount: "199", accountCurrency: "CNY",
          cashPaidCny: "199", occurredAt: new Date("2026-08-31T18:00:00.000Z"),
          externalReference: "SIMULATED-1", description: "模拟写入",
          evidenceRef: "evidence://simulated-plan", idempotencyKey: "simulated-subscription",
          periodStart: new Date("2026-08-31T16:00:00.000Z"),
          periodEndExclusive: new Date("2026-09-30T16:00:00.000Z"),
        }, { source: "MIGRATION", actorAdminId: seeded.adminId });
        await trx.updateTable("provider_finance_activation_attempt").set({
          status: "ACTIVATED", activation_idempotency_key: "simulated",
          activation_result: {} as never, activated_by_admin_user_id: seeded.adminId,
          activated_at: new Date(),
        }).where("id", "=", preview.candidateId).execute();
        throw new Error("simulated process exit before commit");
      })).rejects.toThrow(/simulated process exit/);

      expect(await financeCounts(db, seeded.enterpriseId)).toEqual(before);
      expect(await candidateStatus(db, preview.candidateId)).toBe("PREVIEWED");
      expect(before.provider_finance_event).toBe(0);
      expect(before.provider_subscription_period).toBe(0);
      expect(before.provider_finance_runtime_state).toBe(0);
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 8. class 40 故障映射：语句/提交边界的 40001 与语句边界的 40P01（PFA-04）
  // =====================================================================

  it("40001 覆盖语句与提交边界、40P01 覆盖语句边界，均映射为 ACTIVATION_RETRY_REQUIRED，且协调器零自动重试", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);

      // 语句边界 · 序列化失败（40001）：真实 PostgreSQL 抛出的原始 SQLSTATE。
      const statementError = await db.transaction().setIsolationLevel("serializable")
        .execute(async (trx) => {
          await sql`DO $$ BEGIN
            RAISE EXCEPTION 'simulated serialization failure' USING ERRCODE = '40001';
          END $$`.execute(trx);
        }).catch((error: unknown) => error);
      expect((statementError as { code?: string }).code).toBe("40001");
      // 消息文本必须来自上面这条 DO 块：证明是"真的执行并抛出"，而不是只检查到字符串常量。
      expect((statementError as { message?: string }).message).toContain("simulated serialization failure");

      // 语句边界 · 死锁（40P01）：另一条 class 40 的真实 SQLSTATE，必须独立注入并单独断言，
      // 不能只因为 `mapActivationFailure` 的判据里同时出现两个码就默认它已被覆盖。
      // 这里只做语句边界注入（不人为构造真实行锁互锁），因此不声称 40P01 覆盖提交边界。
      const deadlockError = await db.transaction().setIsolationLevel("serializable")
        .execute(async (trx) => {
          await sql`DO $$ BEGIN
            RAISE EXCEPTION 'simulated deadlock detected' USING ERRCODE = '40P01';
          END $$`.execute(trx);
        }).catch((error: unknown) => error);
      expect((deadlockError as { code?: string }).code).toBe("40P01");
      // 同上：消息文本来自本条 DO 块，证明 40P01 注入确实执行（而非仅被 grep 到）。
      expect((deadlockError as { message?: string }).message).toContain("simulated deadlock detected");

      // 提交边界（仅 40001）：DEFERRABLE INITIALLY DEFERRED 约束触发器在 COMMIT 才抛 40001。
      const enterpriseId = randomUUID();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "pf03_commit_boundary" }).execute();
      await sql`
        CREATE TABLE pf03_commit_boundary_probe (id integer PRIMARY KEY)
      `.execute(db);
      await sql`CREATE FUNCTION pf03_commit_boundary_fail() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated commit boundary failure' USING ERRCODE = '40001'; END;
        $$`.execute(db);
      await sql`CREATE CONSTRAINT TRIGGER pf03_commit_boundary_trigger
        AFTER INSERT ON pf03_commit_boundary_probe
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION pf03_commit_boundary_fail()`.execute(db);
      try {
        const commitError = await db.transaction().setIsolationLevel("serializable")
          .execute(async (trx) => {
            await sql`INSERT INTO pf03_commit_boundary_probe (id) VALUES (1)`.execute(trx);
          }).catch((error: unknown) => error);
        expect((commitError as { code?: string }).code).toBe("40001");

        // 映射器：三条真实原始错误都得到 409 ACTIVATION_RETRY_REQUIRED 且 retryable=true，
        // 且 detail.sqlstate 必须回带各自的原始 SQLSTATE（证明是逐码映射而非巧合）。
        for (const [error, sqlstate] of [
          [statementError, "40001"], [deadlockError, "40P01"], [commitError, "40001"],
        ] as const) {
          const mapped = mapActivationFailure(error) as ProviderFinanceActivationError;
          expect(mapped).toBeInstanceOf(ProviderFinanceActivationError);
          expect(mapped.code).toBe("ACTIVATION_RETRY_REQUIRED");
          expect(mapped.retryable).toBe(true);
          expect((mapped.detail as { sqlstate?: string }).sqlstate).toBe(sqlstate);
        }
        // 非序列化错误不得被改写成可重试错误（例如真实约束冲突）。
        const other = Object.assign(new Error("unique violation"), { code: "23505" });
        expect(mapActivationFailure(other)).toBe(other);

        // 回归（I1 复审 P2-3）：Tx 原语抛出的确定性 `ProviderFinanceError`（如
        // "账户金额必须为正"）曾被统一改写为 `CANDIDATE_STALE`——暗示"重新预检
        // 可解"并掩盖原始错误码。修复后必须映射为独立的 `FACT_WRITE_INVALID`。
        const deterministic = new ProviderFinanceError(
          "INVALID_REQUEST", "账户金额必须为正", { amount: "-1" });
        const mappedDeterministic = mapActivationFailure(
          deterministic,
        ) as ProviderFinanceActivationError;
        expect(mappedDeterministic).toBeInstanceOf(ProviderFinanceActivationError);
        expect(mappedDeterministic.code).toBe("FACT_WRITE_INVALID");
        expect(mappedDeterministic.retryable).toBe(false);
        expect((mappedDeterministic.detail as { code?: string }).code).toBe("INVALID_REQUEST");
        expect(mappedDeterministic.message).toContain("账户金额必须为正");
      } finally {
        await sql`DROP TRIGGER IF EXISTS pf03_commit_boundary_trigger ON pf03_commit_boundary_probe`.execute(db);
        await sql`DROP FUNCTION IF EXISTS pf03_commit_boundary_fail()`.execute(db);
        await sql`DROP TABLE IF EXISTS pf03_commit_boundary_probe`.execute(db);
      }
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 9. Coding Plan 购买 / 跨切换周期 / 旧记录关闭（PFH-02、PFH-03）
  // =====================================================================

  it("Coding Plan 购买、跨切换周期与旧记录 MIGRATED 关闭：周期唯一归属且关闭有不可变映射", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_plan");
      // 当前上海自然月边界（避免硬编码窗口被"当前周期"守卫拒绝）。
      const shanghaiNow = new Date(Date.now() + SHANGHAI_OFFSET_MS);
      const y = shanghaiNow.getUTCFullYear(); const m = shanghaiNow.getUTCMonth();
      const monthStart = new Date(Date.UTC(y, m, 1) - SHANGHAI_OFFSET_MS);          // 上海本月 1 日 00:00
      const nextMonthStart = new Date(Date.UTC(y, m + 1, 1) - SHANGHAI_OFFSET_MS);  // 上海下月 1 日 00:00
      const serviceStartDay = shanghaiDay(monthStart);                              // 本月 1 日
      const serviceEndDay = shanghaiDay(new Date(nextMonthStart.getTime() - DAY_MS)); // 本月最后一日
      const purchasedAt = new Date(monthStart.getTime() + 10 * 3_600_000);          // 服务开始日 10:00
      const planLine = await insertLedgerLine(db, seeded, {
        mode: "CODING_PLAN", resourceId: seeded.planResourceId,
        settledAt: new Date(monthStart.getTime() + 2 * DAY_MS),
        createdAt: new Date(monthStart.getTime() + 2 * DAY_MS),
        tokens: 7,
      });
      // 切换时点后的旧购买记录，尚无资金事件 → 必须被唯一关闭。
      // `resource_purchase_record` 未登记进 Kysely Database 类型（facts 装载走原生 SQL），
      // 这里同样以原生 SQL 插入，与既有 cutover 用例保持一致。
      const legacy = await sql<{ id: string }>`
        INSERT INTO resource_purchase_record
          (enterprise_id, provider_resource_id, purchase_type, amount, currency, purchased_at,
           service_period_start, service_period_end, source, created_by, description, evidence_ref)
        VALUES (${seeded.enterpriseId}::uuid, ${seeded.planResourceId}::uuid, 'PACKAGE_PURCHASE',
                199, 'CNY', ${purchasedAt.toISOString()}::timestamptz,
                ${serviceStartDay}::date, ${serviceEndDay}::date, 'ADMIN',
                ${seeded.adminId}::uuid, 'Kimi 套餐', 'evidence://legacy-plan')
        RETURNING id`.execute(db).then((result) => result.rows[0]!);

      const draft: ActivationDraft = {
        schema_version: "1",
        api_opening_balances: draftFor(seeded.apiResourceId).api_opening_balances,
        historical_api_recharges: [],
        coding_plan_purchases: [{
          resource_id: seeded.planResourceId, kind: "PURCHASE", product_name: "Kimi 套餐",
          account_amount: "199", account_currency: "CNY", cash_paid_cny: "199",
          service_period_start: serviceStartDay,
          service_period_end: serviceEndDay,
          occurred_at: purchasedAt.toISOString(), external_reference: "ORD-PLAN-1",
          auto_renew: false, description: "套餐购买", evidence_ref: "evidence://plan-purchase",
          source_record_id: legacy.id, carryover_snapshot_id: null,
          record_idempotency_key: "plan-purchase-1",
        }],
        coding_plan_carryovers: [],
        legacy_purchase_resolutions: [{
          legacy_record_id: legacy.id, resource_id: seeded.planResourceId,
          resolution: "MIGRATED", finance_event_id: null,
          migrated_external_reference: "ORD-PLAN-1", reason: null, evidence_ref: null,
        }],
      };
      await startLease(db, seeded);
      const preview = await previewGo(db, seeded, draft);
      // 固定修复行集只有那一条套餐用量行；eligibleRows 计的是"行数"而非"字段数"。
      expect(preview.usageRepairs.eligibleRows).toBe(1);

      const repo = new ProviderFinanceActivationCoordinator(db);
      const outcome = await repo.activate(activateInput(seeded, preview, draft, "key-plan", {
        adminId: seeded.adminId,
      }));
      // 与候选 id 无关的显式断言：覆盖率而非占位。
      expect(outcome.receipt.factCounts.purchases).toBe(1);
      expect(outcome.receipt.factCounts.legacyResolutions).toBe(1);
      expect(outcome.receipt.factCounts.usageRepairs).toBe(1);

      // 周期唯一归属：套餐用量行的 subscription_period_id 指向刚写入的周期。
      const line = await db.selectFrom("ledger_line").selectAll().where("id", "=", planLine)
        .executeTakeFirstOrThrow();
      expect(line.subscription_period_id).not.toBeNull();
      expect(line.api_cost_status).toBe("NOT_APPLICABLE");
      const period = await db.selectFrom("provider_subscription_period").selectAll()
        .where("id", "=", line.subscription_period_id!).executeTakeFirstOrThrow();
      expect(period.provider_resource_id).toBe(seeded.planResourceId);
      expect(period.source).toBe("MIGRATED_PURCHASE");
      expect(period.migration_source_record_id).toBe(legacy.id);

      // 旧记录关闭：留下不可变映射（旧记录 → 迁移事件）。
      const closure = await db.selectFrom("operation_log").selectAll()
        .where("enterprise_id", "=", seeded.enterpriseId)
        .where("action", "=", "provider_finance.legacy_purchase.close").executeTakeFirstOrThrow();
      expect(closure.target_id).toBe(legacy.id);
      const closureSummary = closure.change_summary as Record<string, unknown>;
      expect(closureSummary.resolution).toBe("MIGRATED");
      expect(closureSummary.migrated_event_id).toBe(period.finance_event_id);
      // v2（WP07 缺陷 D-1 修复）：迁移事件的 `external_reference` **必须**是旧账本排除标记
      // `'legacy-purchase:' || 源记录 id`。四处聚合读模型正是以它判定「旧记录已被新账本承接」，
      // 否则同一笔付款会被新旧两套账本各计一次（实测套餐金额 199 → 398）。
      const migratedEvent = await db.selectFrom("provider_finance_event")
        .select(["external_reference", "account_amount"])
        .where("id", "=", period.finance_event_id!).executeTakeFirstOrThrow();
      expect(migratedEvent.external_reference).toBe(`legacy-purchase:${legacy.id}`);
      // 排除必须真的生效：该旧记录不再被旧账本认领（未被任何事件以约定标记认领）。
      const orphaned = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM resource_purchase_record purchase
         WHERE purchase.id=${legacy.id}::uuid
           AND NOT EXISTS (
             SELECT 1 FROM provider_finance_event event
              WHERE event.enterprise_id=purchase.enterprise_id
                AND event.provider_resource_id=purchase.provider_resource_id
                AND event.external_reference=('legacy-purchase:'||purchase.id::text))`
        .execute(db);
      expect(Number(orphaned.rows[0]!.count)).toBe(0);
      // 业务订单引用不丢失：仍保留在关闭审计的不可变映射里。
      expect(closureSummary.external_reference).toBe("ORD-PLAN-1");
      // 单元：同一旧记录只允许一个终态关闭决定。
      const closures = await db.selectFrom("operation_log")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("enterprise_id", "=", seeded.enterpriseId)
        .where("target_id", "=", legacy.id).executeTakeFirstOrThrow();
      expect(closures.count).toBe("1");
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  });

  // =====================================================================
  // 10. 迁移的历史 API 充值：同类重复计入防线（WP07 缺陷 D-1 的充值侧覆盖）
  // =====================================================================

  it("迁移的历史 API 充值：写入来源标记使旧账本不再重复认领，订单引用保留在关闭审计", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pf03_recharge");
      const shanghaiNow = new Date(Date.now() + SHANGHAI_OFFSET_MS);
      const y = shanghaiNow.getUTCFullYear(); const m = shanghaiNow.getUTCMonth();
      const monthStart = new Date(Date.UTC(y, m, 1) - SHANGHAI_OFFSET_MS);
      const purchasedAt = new Date(monthStart.getTime() + 12 * 3_600_000);
      // 切换时点后的旧充值记录，尚无资金事件 → 必须被唯一关闭。
      const legacyRecharge = await sql<{ id: string }>`
        INSERT INTO resource_purchase_record
          (enterprise_id, provider_resource_id, purchase_type, amount, currency, purchased_at,
           service_period_start, service_period_end, source, created_by, description, evidence_ref)
        VALUES (${seeded.enterpriseId}::uuid, ${seeded.apiResourceId}::uuid, 'API_RECHARGE',
                50, 'CNY', ${purchasedAt.toISOString()}::timestamptz,
                NULL, NULL, 'ADMIN', ${seeded.adminId}::uuid,
                'DeepSeek 旧充值', 'evidence://legacy-recharge')
        RETURNING id`.execute(db).then((result) => result.rows[0]!);

      const draft: ActivationDraft = {
        ...draftFor(seeded.apiResourceId),
        historical_api_recharges: [{
          resource_id: seeded.apiResourceId, account_currency: "CNY",
          account_amount: "50", cash_paid_cny: "50", occurred_at: purchasedAt.toISOString(),
          external_reference: "ORD-RECHARGE-1", description: "旧充值迁移",
          evidence_ref: "evidence://recharge", source_record_id: legacyRecharge.id,
          record_idempotency_key: "recharge-1",
        }],
        legacy_purchase_resolutions: [{
          legacy_record_id: legacyRecharge.id, resource_id: seeded.apiResourceId,
          resolution: "MIGRATED", finance_event_id: null,
          migrated_external_reference: "ORD-RECHARGE-1", reason: null, evidence_ref: null,
        }],
      };
      await startLease(db, seeded);
      const preview = await previewGo(db, seeded, draft);
      const repo = new ProviderFinanceActivationCoordinator(db);
      const outcome = await repo.activate(activateInput(seeded, preview, draft, "key-recharge"));
      expect(outcome.receipt.factCounts.recharges).toBe(1);
      expect(outcome.receipt.factCounts.legacyResolutions).toBe(1);

      // 充值事件的 `external_reference` 与购买路径同口径：来源标记，而非业务订单引用。
      const event = await db.selectFrom("provider_finance_event")
        .select(["external_reference", "account_amount", "source"])
        .where("enterprise_id", "=", seeded.enterpriseId)
        .where("event_type", "=", "API_RECHARGE").executeTakeFirstOrThrow();
      expect(event).toMatchObject({ external_reference: `legacy-purchase:${legacyRecharge.id}`,
        account_amount: "50.00000000", source: "MIGRATION" });
      const orphaned = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM resource_purchase_record purchase
         WHERE purchase.id=${legacyRecharge.id}::uuid
           AND NOT EXISTS (
             SELECT 1 FROM provider_finance_event event
              WHERE event.enterprise_id=purchase.enterprise_id
                AND event.provider_resource_id=purchase.provider_resource_id
                AND event.external_reference=('legacy-purchase:'||purchase.id::text))`
        .execute(db);
      expect(Number(orphaned.rows[0]!.count)).toBe(0);
      const closure = await db.selectFrom("operation_log").select("change_summary")
        .where("enterprise_id", "=", seeded.enterpriseId)
        .where("action", "=", "provider_finance.legacy_purchase.close").executeTakeFirstOrThrow();
      expect((closure.change_summary as Record<string, unknown>).external_reference)
        .toBe("ORD-RECHARGE-1");
      await assertNoActivating(db, seeded.enterpriseId);
    } finally {
      await db.destroy();
    }
  }, 120_000);
});

/** 在独立连接/事务里持有一把咨询锁，供锁互斥用例使用。 */
async function withHeldLock(
  db: ReturnType<typeof createKysely>, key: string, body: () => Promise<void>,
): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  const readyGate = new Promise<void>((resolve) => { ready = resolve; });
  const holder = db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0::bigint))`.execute(trx);
    ready();
    await gate;
  });
  await readyGate;
  try {
    await body();
  } finally {
    release();
    await holder;
  }
}
