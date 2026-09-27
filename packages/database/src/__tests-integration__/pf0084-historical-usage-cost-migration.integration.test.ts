import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { createKysely, type Database } from "../kysely.js";
import { createMigrator, migrateDown, migrateToLatest } from "../migrator.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { rollbackTo } from "./migration-rollback.js";

/**
 * 0084 定向迁移验证（2026-09-27 最小增量·功能 B）：
 *  - fresh DB 到 0084；
 *  - 现有 0083 升级到 0084；
 *  - down/up 直接验证（0084 down 必须精确恢复 0060 约束）；
 *  - shape 约束拒绝正数金额与非空 cash_paid_cny；
 *  - 既有 API_LEGACY_COST_ADJUSTMENT 约束原样保留（0060 触发器 + CHECK 双重失败关闭）。
 *
 * `provider_finance_event` 是 append-only（DELETE 被触发器拒绝），因此所有会成功
 * 的插入都在**故意回滚的事务**里执行：断言通过后整体回滚，保证同容器内后续
 * down/up 用例不受残留行影响（0060 约束恢复会被 0084 类型行阻断）。
 */

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("pf_0084_historical_usage_cost");
}, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

interface MinimalSeed {
  enterpriseId: string;
  adminId: string;
  apiResourceId: string;
}

type Executor = Kysely<Database> | Transaction<Database>;

async function seedMinimal(db: Executor): Promise<MinimalSeed> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const providerId = randomUUID();
  const apiResourceId = randomUUID();
  await db.insertInto("enterprise").values({
    id: enterpriseId, name: `0084-${randomUUID().slice(0, 8)}`,
  }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: `0084-${randomUUID().slice(0, 8)}`,
    display_name: "A", password_hash: "test", status: "ACTIVE",
  }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: `pf84-${randomUUID().slice(0, 8)}`,
    name: "0084 provider", adapter_type: "OPENAI_COMPATIBLE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: apiResourceId, enterprise_id: enterpriseId, provider_id: providerId,
    name: "0084-API", mode: "API", credential_type: "API_KEY",
  }).execute();
  return { enterpriseId, adminId, apiResourceId };
}

async function insertHistoricalCostEvent(
  db: Executor, seed: MinimalSeed,
  overrides: {
    accountAmount?: string; cashPaidCny?: string | null; legacyCostResolutionId?: string | null;
    idempotencyKey?: string; occurredAt?: Date;
  } = {},
): Promise<void> {
  await db.insertInto("provider_finance_event").values({
    enterprise_id: seed.enterpriseId,
    provider_resource_id: seed.apiResourceId,
    event_type: "API_HISTORICAL_USAGE_COST",
    account_amount: overrides.accountAmount ?? "-40.45720000",
    account_currency: "CNY",
    cash_paid_cny: overrides.cashPaidCny === undefined ? null : overrides.cashPaidCny,
    occurred_at: overrides.occurredAt ?? new Date("2026-09-10T04:00:00.000Z"),
    external_reference: null,
    reversal_of_event_id: null,
    correction_of_event_id: null,
    reconciliation_case_id: null,
    legacy_cost_resolution_id: overrides.legacyCostResolutionId ?? null,
    description: "历史 API 消耗（管理员确认的旧库计价汇总）",
    evidence_ref: "admin-declared:legacy-db-api-cost:00000000000000000000000000000000",
    source: "MIGRATION",
    idempotency_key: overrides.idempotencyKey ?? "pf-u-test-0001",
    created_by_admin_user_id: seed.adminId,
  }).execute();
}

/** 故意回滚标记：事务体内断言完成后抛出，外层捕获即视为「已验证并回滚」。 */
class VerifiedRollback extends Error {}

/** 在事务里插入合法事件、断言可读，然后整体回滚（append-only 表的无残留验证法）。 */
async function assertEventInsertable(db: Kysely<Database>, seed: MinimalSeed): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await insertHistoricalCostEvent(trx, seed, {
      idempotencyKey: `pf-u-test-${randomUUID().slice(0, 8)}`,
    });
    const row = await trx.selectFrom("provider_finance_event").select("id")
      .where("enterprise_id", "=", seed.enterpriseId)
      .where("event_type", "=", "API_HISTORICAL_USAGE_COST")
      .executeTakeFirstOrThrow();
    expect(row.id).toBeDefined();
    throw new VerifiedRollback();
  }).catch((error) => {
    if (!(error instanceof VerifiedRollback)) throw error;
  });
}

async function constraintDefinition(db: Executor, name: string): Promise<string> {
  const row = await sql<{ definition: string }>`
    SELECT pg_get_constraintdef(oid)::text AS definition
      FROM pg_constraint WHERE conname = ${name} LIMIT 1`.execute(db);
  return row.rows[0]?.definition ?? "";
}

async function indexExists(db: Executor, name: string): Promise<boolean> {
  const row = await sql`
    SELECT 1 FROM pg_indexes WHERE indexname = ${name} LIMIT 1`.execute(db);
  return row.rows.length > 0;
}

describe("0084 历史 API 消耗事件类型迁移", () => {
  it("fresh DB 到 0084：类型与 shape 约束包含新事件并拒绝非法形状", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const applied = await migrateToLatest(db);
      expect(applied).toContain("0084_provider_finance_historical_usage_cost");

      const typeCheck = await constraintDefinition(db, "provider_finance_event_type_check");
      expect(typeCheck).toContain("API_HISTORICAL_USAGE_COST");
      const shapeCheck = await constraintDefinition(db, "provider_finance_event_shape_check");
      expect(shapeCheck).toContain("API_HISTORICAL_USAGE_COST");
      // 复核修复 R2：partial unique index（企业+资源+币种，仅限历史消耗事件）。
      expect(await indexExists(db, "provider_finance_event_historical_usage_cost_uq")).toBe(true);

      const seed = await seedMinimal(db);
      // 合法形状（负金额、cash_paid_cny 为空、无任何绑定）：事务内可写入并读出，随后回滚。
      await assertEventInsertable(db, seed);
      // 复核修复 R2：同一（企业、资源、币种）第二条历史消耗被唯一索引拒绝——
      // 不同的截止时间（occurred_at）与金额都不能绕过；事务内验证并整体回滚。
      await db.transaction().execute(async (trx) => {
        await insertHistoricalCostEvent(trx, seed, { idempotencyKey: `pf-u-uniq-${randomUUID().slice(0, 8)}` });
        await expect(insertHistoricalCostEvent(trx, seed, {
          idempotencyKey: `pf-u-uniq-${randomUUID().slice(0, 8)}`,
          accountAmount: "-50.00000000",
          occurredAt: new Date("2026-09-20T04:00:00.000Z"),
        })).rejects.toMatchObject({ code: "23505" });
        throw new VerifiedRollback();
      }).catch((error) => {
        if (!(error instanceof VerifiedRollback)) throw error;
      });
      // 唯一性只限定在同一币种内：不同币种各一条仍被接受（不改其他多行语义）。
      await db.transaction().execute(async (trx) => {
        await insertHistoricalCostEvent(trx, seed, { idempotencyKey: `pf-u-uniq-${randomUUID().slice(0, 8)}` });
        await trx.insertInto("provider_finance_event").values({
          enterprise_id: seed.enterpriseId,
          provider_resource_id: seed.apiResourceId,
          event_type: "API_HISTORICAL_USAGE_COST",
          account_amount: "-10.00000000",
          account_currency: "USD",
          cash_paid_cny: null,
          occurred_at: new Date("2026-09-10T04:00:00.000Z"),
          external_reference: null,
          reversal_of_event_id: null,
          correction_of_event_id: null,
          reconciliation_case_id: null,
          legacy_cost_resolution_id: null,
          description: "历史 API 消耗（USD）",
          evidence_ref: "admin-declared:legacy-db-api-cost:test",
          source: "MIGRATION",
          idempotency_key: `pf-u-uniq-${randomUUID().slice(0, 8)}`,
          created_by_admin_user_id: seed.adminId,
        }).execute();
        throw new VerifiedRollback();
      }).catch((error) => {
        if (!(error instanceof VerifiedRollback)) throw error;
      });
      // 非法形状：正金额 → 23514 check violation（失败即无残留）。
      await expect(insertHistoricalCostEvent(db, seed, { accountAmount: "10.00000000" }))
        .rejects.toMatchObject({ code: "23514" });
      // 非法形状：cash_paid_cny 非空 → 23514。
      await expect(insertHistoricalCostEvent(db, seed, { cashPaidCny: "10.00" }))
        .rejects.toMatchObject({ code: "23514" });
      // 既有 legacy adjustment 形状不被新迁移放宽：0060 触发器在 CHECK 之前
      // 即拒绝未绑定 legacy_cost_resolution_id 的 API_LEGACY_COST_ADJUSTMENT（P0001）。
      await expect(db.insertInto("provider_finance_event").values({
        enterprise_id: seed.enterpriseId,
        provider_resource_id: seed.apiResourceId,
        event_type: "API_LEGACY_COST_ADJUSTMENT",
        account_amount: "-1.00000000",
        account_currency: "CNY",
        cash_paid_cny: null,
        occurred_at: new Date("2026-09-02T04:00:00.000Z"),
        external_reference: null,
        reversal_of_event_id: null,
        correction_of_event_id: null,
        reconciliation_case_id: null,
        legacy_cost_resolution_id: null,
        description: null,
        evidence_ref: "evidence://legacy",
        source: "MIGRATION",
        idempotency_key: `legacy-${randomUUID().slice(0, 8)}`,
        created_by_admin_user_id: null,
      }).execute()).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await db.destroy();
    }
  }, 120_000);

  it("0083 升级到 0084，down 精确恢复 0060 约束，up 可再次前向", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      // 回退到 0083（0084 down 生效）。
      await rollbackTo(db, "0083_provider_finance_resource_opening_trigger");
      const shapeAfterDown = await constraintDefinition(db, "provider_finance_event_shape_check");
      expect(shapeAfterDown).not.toContain("API_HISTORICAL_USAGE_COST");
      expect(shapeAfterDown).toContain("API_LEGACY_COST_ADJUSTMENT");
      // down 精确删除本迁移创建的 partial unique index（复核修复 R2）。
      expect(await indexExists(db, "provider_finance_event_historical_usage_cost_uq")).toBe(false);

      // 重新前向：rollbackTo 会把 0083 一并回退（0082 成为最后已应用），
      // 因此 migrateToLatest 依次重放 0083 与 0084。
      const { results, error } = await createMigrator(db).migrateToLatest();
      expect(error).toBeUndefined();
      expect((results ?? []).map((row) => row.migrationName))
        .toEqual([
          "0083_provider_finance_resource_opening_trigger",
          "0084_provider_finance_historical_usage_cost",
        ]);
      const shapeAfterUp = await constraintDefinition(db, "provider_finance_event_shape_check");
      expect(shapeAfterUp).toContain("API_HISTORICAL_USAGE_COST");
      // up 重放后 partial unique index 恢复。
      expect(await indexExists(db, "provider_finance_event_historical_usage_cost_uq")).toBe(true);
      // 且迁移后的表仍接受合法历史消耗事实（事务回滚，不残留）。
      const seed = await seedMinimal(db);
      await assertEventInsertable(db, seed);
    } finally {
      await db.destroy();
    }
  }, 120_000);

  it("0084 单步 down 后新事件类型被 0060 类型约束拒绝（失败关闭）", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const seed = await seedMinimal(db);
      const downed = await migrateDown(db);
      expect(downed).toBe("0084_provider_finance_historical_usage_cost");
      await expect(insertHistoricalCostEvent(db, seed))
        .rejects.toMatchObject({ code: "23514" });
    } finally {
      await db.destroy();
    }
  }, 120_000);
});
