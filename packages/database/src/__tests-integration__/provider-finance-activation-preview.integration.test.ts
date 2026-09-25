import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { ActivationDraft } from "@qianliu/domain";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

import {
  createKysely,
  FACT_WATERMARK_SECTIONS,
  GatewayLedgerRepository,
  buildFactWatermark,
  loadActivationScope,
  migrateToLatest,
  PROVIDER_FINANCE_CUTOVER,
  ProviderFinanceActivationPreviewRepository,
} from "../index.js";

/**
 * WP02 集成测试（PFA-01、PFA-02、PFH-01～PFH-05）。
 *
 * 与 domain 单测互补：这里只证明「必须依赖真实数据库才能证明」的性质。
 * - 只读候选投影在 READ ONLY 事务内零写入；候选元数据只在独立控制事务里落库；
 * - READ ONLY 是 PostgreSQL 强制的（写语句 25006），不是调用方约定；
 * - 完整事实水位为 §5.2 的十个分段，且新增 ledger_line 会使旧水位失效；
 * - 历史修复「固定行集」不吸收候选生成之后新增的用量行。
 *
 * 守恒与缺口规则（跨月、负余额、UNKNOWN_COST、周期歧义、顺序无关哈希）由
 * packages/domain 的 provider-finance-activation-projection.test.ts 覆盖。
 */

const CUTOVER_ISO = PROVIDER_FINANCE_CUTOVER.toISOString();
const SNAPSHOT_ISO = "2026-10-15T00:00:00.000Z";
const SNAPSHOT = new Date(SNAPSHOT_ISO);

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer("provider_finance_activation_preview"); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

interface Seeded {
  enterpriseId: string;
  adminId: string;
  providerId: string;
  apiResourceId: string;
  planResourceId: string;
  principalId: string;
  principalKeyId: string;
}

describe.sequential("PF-INIT WP02：只读候选投影与事实水位", () => {
  async function seedEnterprise(
    db: ReturnType<typeof createKysely>, name: string,
  ): Promise<Seeded> {
    const enterpriseId = randomUUID(); const adminId = randomUUID();
    const providerId = randomUUID(); const apiResourceId = randomUUID();
    const planResourceId = randomUUID();
    const principalId = randomUUID(); const principalKeyId = randomUUID();
    await db.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
    await db.insertInto("admin_user").values({
      id: adminId, enterprise_id: enterpriseId, username: name,
      display_name: name.toUpperCase(), password_hash: "test", status: "ACTIVE",
    }).execute();
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
    return { enterpriseId, adminId, providerId, apiResourceId, planResourceId, principalId, principalKeyId };
  }

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

  /** 造一条落库的 API 用量行（含 ai_request/attempt/usage_event 依赖链）。 */
  async function insertApiLedgerLine(
    db: ReturnType<typeof createKysely>, seeded: Seeded,
    options: { settledAt: Date | null; createdAt: Date },
  ): Promise<string> {
    const requestId = randomUUID();
    const ledger = new GatewayLedgerRepository(db);
    await ledger.createRequest({ id: requestId, enterprise_id: seeded.enterpriseId,
      principal_id: seeded.principalId, principal_key_id: seeded.principalKeyId,
      protocol: "OPENAI_CHAT", unified_model: "deepseek-chat", unified_model_id: null });
    const attempt = await ledger.createAttempt({ ai_request_id: requestId,
      enterprise_id: seeded.enterpriseId, attempt_no: 1,
      provider_resource_id: seeded.apiResourceId, upstream_model: "deepseek-chat" });
    const usage = await ledger.createUsageEventIfAbsent({ ai_request_id: requestId,
      enterprise_id: seeded.enterpriseId, upstream_attempt_id: attempt.id,
      provider_resource_id: seeded.apiResourceId, input_tokens: 10n, output_tokens: 2n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: `${requestId}:attempt1` });
    const lineId = randomUUID();
    await sql`
      INSERT INTO ledger_line
        (id, ai_request_id, enterprise_id, usage_event_id, upstream_attempt_id,
         provider_resource_id, principal_id, resource_mode, raw_input_tokens,
         raw_output_tokens, raw_cache_tokens, raw_reasoning_tokens, deducted_quota,
         api_cost, api_cost_currency, api_cost_status, subscription_period_id,
         settled_at, usage_quality, billing_rule_snapshot, created_at)
      VALUES (${lineId}::uuid, ${requestId}::uuid, ${seeded.enterpriseId}::uuid,
              ${usage!.id}::uuid, ${attempt.id}::uuid, ${seeded.apiResourceId}::uuid,
              ${seeded.principalId}::uuid, 'API', 10, 2, 0, 0, NULL,
              NULL, NULL, NULL, NULL, ${options.settledAt}, 'PROVIDER_REPORTED',
              NULL, ${options.createdAt})
    `.execute(db);
    return lineId;
  }

  /** 资金与控制表的按企业行数快照，用于证明预检零写入。 */
  async function financeCounts(
    db: ReturnType<typeof createKysely>, enterpriseId: string,
  ): Promise<Record<string, number>> {
    const tables = [
      "provider_finance_event", "provider_subscription_period", "ledger_line",
      "resource_purchase_record", "provider_resource_operating_snapshot",
      "provider_finance_legacy_cost_resolution", "provider_finance_activation_attempt",
      "provider_finance_activation_quiescence", "provider_resource_finance_state",
      "provider_finance_runtime_state",
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

  it("只读投影零写入，候选元数据仅在独立控制事务落库", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pfinit_preview");
      const repo = new ProviderFinanceActivationPreviewRepository(db);
      const draft = draftFor(seeded.apiResourceId);

      const before = await financeCounts(db, seeded.enterpriseId);

      const projection = await repo.buildCandidateProjection({
        enterpriseId: seeded.enterpriseId, adminId: seeded.adminId, draft, now: SNAPSHOT,
      });

      // 只读投影：资金表、周期、ledger_line、候选、租约、资源状态全部零变化。
      expect(await financeCounts(db, seeded.enterpriseId)).toEqual(before);
      // 候选元数据尚未落库——预检第一步绝不写候选。
      expect(await repo.loadLatestCandidate(seeded.enterpriseId)).toBeNull();

      // 完整事实水位覆盖 §5.2 的十个分段，且顺序与 FACT_WATERMARK_SECTIONS 一致。
      expect(projection.factWatermark.sections.map((entry) => entry.section))
        .toEqual([...FACT_WATERMARK_SECTIONS]);
      expect(projection.factWatermark.sections).toHaveLength(10);
      expect(projection.factWatermark.hash).toMatch(/^[a-f0-9]{64}$/);

      // 范围加载器把 API 资源与切换前快照登记的 CNY 账户纳入范围。
      expect(projection.scope.resources.map((resource) => resource.resourceId))
        .toContain(seeded.apiResourceId);
      expect(projection.scope.accounts).toEqual([
        expect.objectContaining({ resourceId: seeded.apiResourceId, currency: "CNY" }),
      ]);

      // 范围加载器与水位构建可脱离预检单独调用（只读接口）。
      const scope = await loadActivationScope(db, {
        enterpriseId: seeded.enterpriseId, snapshotAt: SNAPSHOT_ISO,
      });
      expect(scope.resources).toHaveLength(2);
      expect(scope.window.map((entry) => entry.month)).toEqual(projection.scope.window.map((entry) => entry.month));

      // 独立控制事务保存候选。
      const preview = await repo.previewActivation({
        enterpriseId: seeded.enterpriseId, adminId: seeded.adminId, draft, now: SNAPSHOT,
      });
      const after = await financeCounts(db, seeded.enterpriseId);
      expect(after.provider_finance_activation_attempt).toBe(1);
      // 除候选表外，其余财务/周期/用量表保持零写入。
      for (const [table, count] of Object.entries(before)) {
        if (table === "provider_finance_activation_attempt") continue;
        expect(after[table]).toBe(count);
      }
      // TTL 自只读事务提交时刻起算 30 分钟，且候选哈希与只读投影一致。
      const ttl = new Date(preview.expiresAt).getTime() - new Date(preview.previewCommittedAt).getTime();
      expect(ttl).toBe(1_800_000);
      expect(preview.candidateHash).toBe(projection.candidateHash);
      expect(preview.factWatermark.hash).toBe(projection.factWatermark.hash);
    } finally {
      await db.destroy();
    }
  });

  it("READ ONLY 由数据库强制：只读事务内的写语句被 25006 拒绝", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pfinit_readonly");

      const forbiddenId = randomUUID();
      await expect(db.transaction().execute(async (trx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        await sql`INSERT INTO enterprise (id, name) VALUES (${forbiddenId}::uuid, 'forbidden')`.execute(trx);
      })).rejects.toThrow(/read-only transaction|25006/i);

      const row = await db.selectFrom("enterprise").select("id")
        .where("id", "=", forbiddenId).executeTakeFirst();
      expect(row).toBeUndefined();
      expect(seeded.enterpriseId).toBeTruthy();
    } finally {
      await db.destroy();
    }
  });

  it("水位确定且新增 ledger_line 使旧水位失效", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pfinit_watermark");

      const first = await buildFactWatermark(db, {
        enterpriseId: seeded.enterpriseId, snapshotAt: SNAPSHOT_ISO,
      });
      const repeat = await buildFactWatermark(db, {
        enterpriseId: seeded.enterpriseId, snapshotAt: SNAPSHOT_ISO,
      });
      // 同一事实集合重复构建必须得到同一摘要（不依赖 updated_at 或遍历顺序）。
      expect(repeat.hash).toBe(first.hash);
      expect(repeat.sections).toEqual(first.sections);

      await insertApiLedgerLine(db, seeded, {
        settledAt: new Date("2026-09-10T04:00:00.000Z"), createdAt: new Date("2026-09-10T04:00:01.000Z"),
      });

      const after = await buildFactWatermark(db, {
        enterpriseId: seeded.enterpriseId, snapshotAt: SNAPSHOT_ISO,
      });
      expect(after.hash).not.toBe(first.hash);
      const beforeLine = first.sections.find((entry) => entry.section === "ledger_line")!;
      const afterLine = after.sections.find((entry) => entry.section === "ledger_line")!;
      expect(afterLine.count).toBe(beforeLine.count + 1);
      expect(afterLine.digest).not.toBe(beforeLine.digest);
      // 未被改动的分段摘要保持不变（分段级失效，不是整体失效）。
      const beforeResource = first.sections.find((entry) => entry.section === "provider_resource")!;
      const afterResource = after.sections.find((entry) => entry.section === "provider_resource")!;
      expect(afterResource).toEqual(beforeResource);
    } finally {
      await db.destroy();
    }
  });

  it("固定修复行集只包含候选时点已存在的资格行，不吸收之后新增的行", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seeded = await seedEnterprise(db, "pfinit_repair");
      const repo = new ProviderFinanceActivationPreviewRepository(db);
      const draft = draftFor(seeded.apiResourceId);

      // 切换时点后、缺少结算时间的 API 用量行 → 资格修复行（修复 settled_at）。
      const originalLine = await insertApiLedgerLine(db, seeded, {
        settledAt: null, createdAt: new Date("2026-09-12T04:00:00.000Z"),
      });

      const firstProjection = await repo.buildCandidateProjection({
        enterpriseId: seeded.enterpriseId, adminId: seeded.adminId, draft, now: SNAPSHOT,
      });
      const firstRow = firstProjection.usageRepairBaseline.find((row) => row.ledgerLineId === originalLine);
      expect(firstRow).toBeDefined();
      expect(firstRow!.eligibleRepairs).toContain("settled_at");

      // 候选生成之后又出现一条同样需要修复的用量行。
      const lateLine = await insertApiLedgerLine(db, seeded, {
        settledAt: null, createdAt: new Date("2026-09-13T04:00:00.000Z"),
      });
      expect(firstProjection.usageRepairBaseline.map((row) => row.ledgerLineId)).not.toContain(lateLine);

      // 再次预检会产出新的候选，其固定行集包含新行——证明行集按候选时点重新确定，
      // 而不是让既有候选静默吸收新行。
      const secondProjection = await repo.buildCandidateProjection({
        enterpriseId: seeded.enterpriseId, adminId: seeded.adminId, draft, now: SNAPSHOT,
      });
      expect(secondProjection.usageRepairBaseline.map((row) => row.ledgerLineId)).toContain(lateLine);
      expect(secondProjection.usageRepairBaseline.length).toBe(firstProjection.usageRepairBaseline.length + 1);
      // 行集稳定排序：按 ledgerLineId 升序。
      const ids = secondProjection.usageRepairBaseline.map((row) => row.ledgerLineId);
      expect([...ids].sort()).toEqual(ids);
    } finally {
      await db.destroy();
    }
  });
});
