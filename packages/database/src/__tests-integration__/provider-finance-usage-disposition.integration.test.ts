import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateDown, migrateToLatest, ProviderFinanceRepository } from "../index.js";
import { createAnalysisFixture } from "./fixtures/operating-analysis.js";
import { countFinanceGaps } from "../repositories/provider-finance-gaps.js";
import { effectiveUsageCostDispositionSql } from "../repositories/provider-finance-usage-dispositions.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => {
  pg = await startPostgresContainer("finance_usage_dispositions");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function fixture() {
  const base = await createAnalysisFixture(db);
  const resourceId = base.resources.get("deepseek")!;
  const common = { enterprise_id: base.enterpriseId, provider_resource_id: resourceId,
    account_currency: "CNY" as const, cash_paid_cny: null, external_reference: null,
    reversal_of_event_id: null, correction_of_event_id: null, reconciliation_case_id: null,
    description: "Synthetic opening", evidence_ref: "fixture", source: "MIGRATION" as const,
    created_by_admin_user_id: base.adminId };
  await db.insertInto("provider_finance_event").values([
    { ...common, event_type: "API_OPENING_BALANCE", account_amount: "50",
      occurred_at: new Date("2026-09-01T00:00:00+08:00"), idempotency_key: randomUUID() },
    { ...common, event_type: "API_RECHARGE", account_amount: "150", cash_paid_cny: "150",
      occurred_at: new Date("2026-09-02T00:00:00+08:00"), idempotency_key: randomUUID() },
  ]).execute();
  return { ...base, resourceId };
}

async function line(f: Awaited<ReturnType<typeof fixture>>, cost: string | null = null,
  snapshotCost?: string, existingRequestId?: string) {
  const requestId = existingRequestId ?? randomUUID();
  const at = new Date("2026-09-25T10:00:00+08:00");
  const tokens = cost === null ? 0n : 10n;
  if (!existingRequestId) await db.insertInto("ai_request").values({ id: requestId, enterprise_id: f.enterpriseId,
    principal_id: f.a, principal_key_id: f.keys.get(f.a)!, protocol: "openai", unified_model: "model",
    status: cost === null ? "FAILED" : "SUCCEEDED", error_code: cost === null ? "client_cancelled" : null,
    started_at: at, finished_at: at }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, attempt_no: existingRequestId ? 2 : 1, provider_resource_id: f.resourceId,
    upstream_model: "model", started_at: at, finished_at: at, http_status: cost === null ? 0 : 200,
    error_code: cost === null ? "client_cancelled" : null }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, upstream_attempt_id: attempt.id, provider_resource_id: f.resourceId,
    input_tokens: tokens, output_tokens: 0n, cache_tokens: 0n, reasoning_tokens: 0n,
    usage_quality: "UNKNOWN", dedup_key: `${requestId}:${attempt.id}`, created_at: at }).returning("id").executeTakeFirstOrThrow();
  const ledger = await db.insertInto("ledger_line").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, upstream_attempt_id: attempt.id, usage_event_id: usage.id,
    provider_resource_id: f.resourceId, principal_id: f.a, resource_mode: "API",
    raw_input_tokens: tokens, raw_output_tokens: 0n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: cost, api_cost_status: cost === null ? "UNKNOWN_COST" : "PRICED_USAGE",
    api_cost_currency: cost === null ? null : "CNY", usage_quality: "UNKNOWN", settled_at: at, created_at: at,
    billing_rule_snapshot: snapshotCost ? { apiCost: snapshotCost, currency: "CNY" } : null,
  }).returning("id").executeTakeFirstOrThrow();
  if (!existingRequestId) await db.insertInto("ledger_transaction").values({ ai_request_id: requestId, enterprise_id: f.enterpriseId,
    principal_id: f.a, total_api_cost: cost ?? "0", api_cost_status: cost === null ? "UNKNOWN_COST" : "PRICED_USAGE",
    usage_quality: "UNKNOWN", status: "SETTLED", created_at: at }).execute();
  return { id: ledger.id, requestId };
}

async function disposition(f: Awaited<ReturnType<typeof fixture>>, ledger: { id: string; requestId: string }) {
  const fact = await sql<{ fact: Record<string, unknown> }>`SELECT to_jsonb(line) AS fact FROM ledger_line line
    WHERE line.enterprise_id=${f.enterpriseId}::uuid AND line.id=${ledger.id}::uuid`.execute(db);
  return { enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId, ledger_line_id: ledger.id,
    ai_request_id: ledger.requestId, decision: "EXCLUDE_NO_SERVER_COST" as const,
    original_ledger_fact: fact.rows[0]!.fact,
    server_cost_evidence: { request: ledger.requestId, policy: "server-recorded-cost-only", recordedCost: null },
    reason: "Administrator directs this exact unpriced record to be excluded from internal accounting",
    evidence_ref: `fixture-decision:${ledger.id}`, decided_by_admin_user_id: f.adminId,
    idempotency_key: randomUUID(), request_hash: createHash("sha256").update(ledger.id).digest("hex") };
}

async function isEffective(id: string) {
  return db.selectFrom("ledger_line as ll").select(effectiveUsageCostDispositionSql("ll").as("effective"))
    .where("ll.id", "=", id).executeTakeFirstOrThrow();
}

const septemberStart = new Date("2026-09-01T00:00:00+08:00");
const octoberStart = new Date("2026-10-01T00:00:00+08:00");

describe("0086 explicit server-recorded-cost accounting decisions", () => {
  it("upgrades an existing 0085 database without changing its ledger facts", async () => {
    // CPQW：迁移头随后续工作包追加；先回退比 0086 更新的迁移再锚定 0086（惯例见
    // pool046 注释与 migration-rollback.ts docstring）。
    while (await latestMigrationIs(db, "0086_provider_finance_usage_cost_disposition") === false) {
      await migrateDown(db);
    }
    expect(await migrateDown(db)).toBe("0086_provider_finance_usage_cost_disposition");
    const f = await fixture();
    const item = await line(f);
    const before = await db.selectFrom("ledger_line").selectAll().where("id", "=", item.id).executeTakeFirstOrThrow();
    await migrateToLatest(db);
    expect(await db.selectFrom("ledger_line").selectAll().where("id", "=", item.id).executeTakeFirstOrThrow()).toEqual(before);
    expect(await isEffective(item.id)).toEqual({ effective: false });
  });

  it("carries over the known balance after exactly four decisions while retaining every raw fact", async () => {
    const f = await fixture();
    await line(f, "7");
    const unknown = await Promise.all(Array.from({ length: 4 }, () => line(f)));
    const repo = new ProviderFinanceRepository(db);
    expect(await repo.getCurrentBalance(f.enterpriseId, f.resourceId, "CNY", octoberStart))
      .toMatchObject({ state: "INCOMPLETE_USAGE_COST", balance: null });
    const before = await db.selectFrom("ledger_line").selectAll().where("enterprise_id", "=", f.enterpriseId)
      .orderBy("id").execute();
    for (const item of unknown) await db.insertInto("provider_finance_usage_cost_disposition")
      .values(await disposition(f, item)).execute();
    expect(await repo.getCurrentBalance(f.enterpriseId, f.resourceId, "CNY", octoberStart))
      .toMatchObject({ state: "NORMAL", balance: "193.00000000", components: { usageDebits: "7.00000000" } });
    const views = await repo.listResourceFinanceViews(f.enterpriseId, "2026-10", octoberStart);
    expect(views.find((view) => view.resourceId === f.resourceId)?.accounts[0])
      .toMatchObject({ monthOpeningState: "NORMAL", monthOpeningBalance: "193.00000000" });
    expect((await countFinanceGaps(db, f.enterpriseId, septemberStart, octoberStart))
      .find((gap) => gap.code === "API_USAGE_COST_UNKNOWN")?.count).toBe("0");
    expect(await db.selectFrom("ledger_line").selectAll().where("enterprise_id", "=", f.enterpriseId)
      .orderBy("id").execute()).toEqual(before);
    const fifth = await line(f);
    expect(await isEffective(fifth.id)).toEqual({ effective: false });
    expect(await repo.getCurrentBalance(f.enterpriseId, f.resourceId, "CNY", octoberStart))
      .toMatchObject({ state: "INCOMPLETE_USAGE_COST", gaps: [{ code: "API_USAGE_COST_UNKNOWN",
        requestId: fifth.requestId, ledgerLineId: fifth.id }] });
  });

  it("rejects recorded costs and never lets an old decision hide a subsequently priced row", async () => {
    const f = await fixture();
    const priced = await line(f, "3");
    await expect(db.insertInto("provider_finance_usage_cost_disposition")
      .values(await disposition(f, priced)).execute()).rejects.toThrow(/unpriced API/);
    const frozenCost = await line(f, null, "2.5");
    await expect(db.insertInto("provider_finance_usage_cost_disposition")
      .values(await disposition(f, frozenCost)).execute()).rejects.toThrow(/recorded server cost/);
    const later = await line(f);
    await db.insertInto("provider_finance_usage_cost_disposition").values(await disposition(f, later)).execute();
    await db.updateTable("ledger_line").set({ api_cost_status: "PRICED_USAGE", api_cost: "4",
      api_cost_currency: "CNY" }).where("id", "=", later.id).execute();
    expect(await isEffective(later.id)).toEqual({ effective: false });
    const balance = await new ProviderFinanceRepository(db).getCurrentBalance(f.enterpriseId, f.resourceId, "CNY", octoberStart);
    expect(balance?.components.usageDebits).toBe("7.00000000");
  });

  it("gives a recorded positive request total precedence over an unpriced single-attempt row", async () => {
    const f = await fixture();
    const item = await line(f);
    await db.updateTable("ledger_transaction").set({ api_cost_status: "PRICED_USAGE", total_api_cost: "5" })
      .where("ai_request_id", "=", item.requestId).execute();
    await expect(db.insertInto("provider_finance_usage_cost_disposition")
      .values(await disposition(f, item)).execute()).rejects.toThrow(/recorded server cost/);
  });

  it("keeps other priced attempts and rejects positive request costs not yet accounted for", async () => {
    const f = await fixture();
    const item = await line(f);
    await line(f, "3", undefined, item.requestId);
    await db.updateTable("ledger_transaction").set({ api_cost_status: "PRICED_USAGE", total_api_cost: "5" })
      .where("ai_request_id", "=", item.requestId).execute();
    await expect(db.insertInto("provider_finance_usage_cost_disposition")
      .values(await disposition(f, item)).execute()).rejects.toThrow(/recorded server cost/);
    await db.updateTable("ledger_transaction").set({ total_api_cost: "3" })
      .where("ai_request_id", "=", item.requestId).execute();
    await db.insertInto("provider_finance_usage_cost_disposition").values(await disposition(f, item)).execute();
    expect(await new ProviderFinanceRepository(db).getCurrentBalance(f.enterpriseId, f.resourceId, "CNY", octoberStart))
      .toMatchObject({ state: "NORMAL", balance: "197.00000000", components: { usageDebits: "3.00000000" } });
    // A later recorded cost cannot be silently hidden by the old exclusion decision.
    await db.updateTable("ledger_transaction").set({ total_api_cost: "5" })
      .where("ai_request_id", "=", item.requestId).execute();
    expect(await isEffective(item.id)).toEqual({ effective: false });
  });

  it("enforces immutable tenant-bound original snapshots and refuses audit-data rollback", async () => {
    const f = await fixture();
    const item = await line(f);
    const original = await disposition(f, item);
    await expect(db.insertInto("provider_finance_usage_cost_disposition").values({ ...original,
      original_ledger_fact: {} }).execute()).rejects.toThrow(/snapshot mismatch/);
    await expect(db.insertInto("provider_finance_usage_cost_disposition").values({ ...original,
      provider_resource_id: f.resources.get("kimi")! }).execute()).rejects.toThrow(/identity mismatch/);
    const row = await db.insertInto("provider_finance_usage_cost_disposition").values(original)
      .returning("id").executeTakeFirstOrThrow();
    await expect(db.updateTable("provider_finance_usage_cost_disposition").set({ reason: "replace" })
      .where("id", "=", row.id).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom("provider_finance_usage_cost_disposition").where("id", "=", row.id).execute())
      .rejects.toThrow(/append-only/);
    // CPQW：先回退比 0086 更新的迁移（0087 等），使 0086 成为可回滚的最近迁移；
    // 0086 自身的 down 守卫随后拒绝回退（审计事实保留）。
    while (await latestMigrationIs(db, "0086_provider_finance_usage_cost_disposition") === false) {
      await migrateDown(db);
    }
    await expect(migrateDown(db)).rejects.toThrow(/0086 rollback blocked/);
  });
});

/** 当前最新已应用迁移是否等于目标（供迁移测试锚定，而非假设迁移头）。 */
async function latestMigrationIs(db: Kysely<unknown>, expected: string): Promise<boolean> {
  const row = await db.selectFrom("kysely_migration")
    .select("name")
    .orderBy("timestamp", "desc")
    .orderBy("name", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.name === expected;
}
