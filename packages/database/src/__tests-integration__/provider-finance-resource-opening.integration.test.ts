import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  createKysely,
  insertOpeningBalanceTx,
  PROVIDER_FINANCE_CUTOVER,
  ProviderFinanceRepository,
} from "../index.js";
import { createMigrator } from "../migrator.js";

/**
 * F-P2-6 资源级期初生效时点集成测试（Owner 裁决：窗口校验式）。
 *
 * 覆盖：
 * - 激活后资源级期初：不得早于资源 created_at、不得在未来；
 * - 多币种期初保持同一资源生效时点（首个期初锚定，后续币种异点拒绝）；
 * - 期初更正追随其原始期初时点（异点拒绝）；
 * - 历史初始化路径（insertOpeningBalanceTx 缺省）固定切换时点口径不变。
 *
 * PENDING → READY 前不可调度由 0078 种子 + Gateway resource-pool 排除保证，不在本文件范围。
 */
describe.sequential("F-P2-6：资源级期初生效时点", () => {
  let pg: PostgresTestInstance;
  let db: ReturnType<typeof createKysely>;
  let repo: ProviderFinanceRepository;
  let enterpriseId: string;
  let adminId: string;
  let apiResourceId: string;
  let legacyResourceId: string;

  /** 资源 created_at：期初窗口下界。 */
  const RESOURCE_CREATED_AT = "2026-09-01T00:00:00.000Z";
  /** 首个合法期初时点（created_at ≤ t ≤ now）。 */
  const OPENING_AT = "2026-09-02T01:00:00.000Z";

  beforeAll(async () => {
    pg = await startPostgresContainer("pf_resource_opening");
    db = createKysely(pg.connectionString);
    expect((await createMigrator(db).migrateToLatest()).error).toBeUndefined();
    enterpriseId = randomUUID();
    adminId = randomUUID();
    await db.insertInto("enterprise").values({ id: enterpriseId, name: "期初时点测试" }).execute();
    await db.insertInto("admin_user").values({
      id: adminId, enterprise_id: enterpriseId, username: "opening-admin",
      display_name: "OPENING-ADMIN", password_hash: "test",
    }).execute();
    const provider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: "pf-opening", name: "期初时点测试厂商",
      adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();
    const resource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.id, name: "激活后新增 API 资源",
      mode: "API", credential_type: "API_KEY", created_at: new Date(RESOURCE_CREATED_AT),
    }).returning("id").executeTakeFirstOrThrow();
    apiResourceId = resource.id;
    const legacy = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.id, name: "历史初始化口径资源",
      mode: "API", credential_type: "API_KEY", created_at: new Date(RESOURCE_CREATED_AT),
    }).returning("id").executeTakeFirstOrThrow();
    legacyResourceId = legacy.id;
    // 0083 触发器前置：企业已激活（strict_writes_enabled 不可逆置位）。
    // 0061 shape_check 要求激活行 activated_at 与 activated_by_admin_user_id 成对非空，
    // 且 (enterprise_id, activated_by_admin_user_id) 须命中 admin_user(enterprise_id, id)。
    await sql`
      INSERT INTO provider_finance_runtime_state
        (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at)
      VALUES (${enterpriseId}::uuid, true, now(), ${adminId}::uuid, now())
      ON CONFLICT (enterprise_id) DO NOTHING
    `.execute(db);
    // 0083 触发器前置：资源级 ADMIN 期初要求资源处于 PENDING。
    await db.insertInto("provider_resource_finance_state").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId, state: "PENDING",
    }).execute();
    repo = new ProviderFinanceRepository(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pg?.stop();
  }, 60_000);

  it("期初不得早于资源创建时点（下界是 created_at，而非切换时点）", async () => {
    // 晚于切换时点（2026-08-31T16:00Z）但早于资源创建 → 仍拒绝。
    await expect(repo.recordOpeningBalance({
      enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "100",
      accountCurrency: "CNY", occurredAt: new Date("2026-08-31T20:00:00.000Z"),
      description: null, evidenceRef: null, idempotencyKey: randomUUID(),
    })).rejects.toThrow("期初时间不得早于资源创建时点");
  });

  it("期初不得在未来", async () => {
    await expect(repo.recordOpeningBalance({
      enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "100",
      accountCurrency: "CNY", occurredAt: new Date(Date.now() + 60_000),
      description: null, evidenceRef: null, idempotencyKey: randomUUID(),
    })).rejects.toThrow("期初时间不能晚于当前时间");
  });

  it("合法期初落库为资源生效时点；多币种异点拒绝、同点放行", async () => {
    const cny = await repo.recordOpeningBalance({
      enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "100",
      accountCurrency: "CNY", occurredAt: new Date(OPENING_AT),
      description: "人民币期初", evidenceRef: null, idempotencyKey: randomUUID(),
    });
    expect(cny.occurredAt).toBe(OPENING_AT);

    // 不同币种但不同时点 → 拒绝（多币种保持同一资源生效时点）。
    await expect(repo.recordOpeningBalance({
      enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "20",
      accountCurrency: "USD", occurredAt: new Date("2026-09-03T01:00:00.000Z"),
      description: null, evidenceRef: null, idempotencyKey: randomUUID(),
    })).rejects.toThrow("多币种期初必须使用同一资源生效时点");

    // 同一时点 → 放行。
    const usd = await repo.recordOpeningBalance({
      enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "20",
      accountCurrency: "USD", occurredAt: new Date(OPENING_AT),
      description: "美元期初", evidenceRef: null, idempotencyKey: randomUUID(),
    });
    expect(usd.occurredAt).toBe(OPENING_AT);
  });

  it("期初更正追随原始期初时点，异点拒绝", async () => {
    const openings = await db.selectFrom("provider_finance_event")
      .select(["id", "occurred_at"])
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", apiResourceId)
      .where("event_type", "=", "API_OPENING_BALANCE")
      .where("account_currency", "=", "CNY")
      .executeTakeFirstOrThrow();

    const correction = await repo.recordOpeningCorrection({
      enterpriseId, resourceId: apiResourceId, adminId, openingEventId: openings.id,
      accountAmount: "-10", accountCurrency: "CNY", occurredAt: new Date(OPENING_AT),
      description: "期初更正：追随原始期初时点", evidenceRef: null, idempotencyKey: randomUUID(),
    });
    expect(correction.eventType).toBe("API_OPENING_BALANCE_CORRECTION");
    expect(correction.correctionOfEventId).toBe(openings.id);
    expect(correction.occurredAt).toBe(OPENING_AT);

    await expect(repo.recordOpeningCorrection({
      enterpriseId, resourceId: apiResourceId, adminId, openingEventId: openings.id,
      accountAmount: "-1", accountCurrency: "CNY",
      occurredAt: new Date("2026-09-04T00:00:00.000Z"),
      description: null, evidenceRef: null, idempotencyKey: randomUUID(),
    })).rejects.toThrow("期初更正时间必须等于原始期初时点");
  });

  it("历史初始化路径缺省口径不变：MIGRATION 源固定锚定切换时点", async () => {
    await db.transaction().execute(async (trx) => {
      const event = await insertOpeningBalanceTx(trx, {
        enterpriseId, resourceId: legacyResourceId, adminId, accountAmount: "50",
        accountCurrency: "CNY", description: null, evidenceRef: null,
        idempotencyKey: randomUUID(), source: "MIGRATION",
      });
      expect(event.occurredAt).toBe(PROVIDER_FINANCE_CUTOVER.toISOString());
    });
  });
});
