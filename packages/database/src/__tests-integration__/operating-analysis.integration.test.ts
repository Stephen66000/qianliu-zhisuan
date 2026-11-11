import {
  createAnalysisFixture,
  seedAnalysisUsage as usage,
} from "./fixtures/operating-analysis.js";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createKysely,
  migrateToLatest,
  ProviderFinanceRepository,
  loadOperatingAnalysis,
  savePrincipalAccounting,
  readPrincipalAccounting,
  loadOperatingDepartmentAccounts,
  OperatingBillAccountRepository,
  OperatingBillRepository,
} from "../index.js";
import { ensureRequestAttributionSnapshot } from "../repositories/request-attribution-writer.js";
import {
  startPostgresContainer,
  type PostgresTestInstance,
} from "@qianliu/testing";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => {
  pg = await startPostgresContainer("operating_analysis");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 60_000);
const tenant = () => createAnalysisFixture(db);
// Request and assignment clocks must share the database timeline in this fixture.
const requestTime = async () => (await sql<{at: Date}>`SELECT date_trunc('milliseconds',clock_timestamp()) + interval '1 millisecond' AS at`.execute(db)).rows[0]!.at;

describe("经营分析真实数据链", () => {
  it("混合未知计量时保留已记录 Token、YTD 与峰值参考值，并标明不完整", async () => {
    const t = await tenant();
    await usage(t,t.a,"kimi",200n,new Date("2026-08-02T00:00:00Z"));
    await usage(t,t.a,"kimi",0n,new Date("2026-08-03T00:00:00Z"),"0","UNKNOWN");
    await usage(t,t.a,"kimi",300n,new Date("2026-09-02T00:00:00Z"));
    await usage(t,t.b,"zhipu",100n,new Date("2026-09-02T00:00:00Z"));
    await usage(t,t.a,"kimi",0n,new Date("2026-09-03T00:00:00Z"),"0","UNKNOWN");
    const report = await loadOperatingAnalysis(db,t.enterpriseId,"2026-09",new Date("2026-09-06T12:00:00Z"));
    expect(report.summary).toMatchObject({companyTokens:"400",ytdAverageTokens:"300.00",ytdAverageChange:"50.00",perCapitaTokens:"200.00",perCapitaChange:"0.00",planUtilization:"100.00"});
    expect(report.months[8]).toMatchObject({totalTokens:"400",usageIncomplete:true});
    expect(report.months[9]!.totalTokens).toBeNull();
    const kimi = report.plans.find((p)=>p.providerCode==="kimi")!;
    expect(kimi).toMatchObject({peakTokens:"300",historyIncomplete:true});
    expect(kimi.months[7]).toMatchObject({totalTokens:"200",utilization:"66.67",usageIncomplete:true});
    expect(kimi.months[8]).toMatchObject({totalTokens:"300",utilization:"100.00",usageIncomplete:true});
  });
  it("YTD、各月系统人数、实付和充值到账保持独立，峰值使用真实月度 Token", async () => {
    const t = await tenant(),
      finance = new ProviderFinanceRepository(db);
    // F-P2-6 前置事实：企业已激活 + 资源 PENDING（资源级 ADMIN 期初门槛）。
    await sql`
      INSERT INTO provider_finance_runtime_state
        (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at)
      VALUES (${t.enterpriseId}::uuid, true, now(), ${t.adminId}::uuid, now())
      ON CONFLICT (enterprise_id) DO NOTHING
    `.execute(db);
    await db.insertInto("provider_resource_finance_state").values({
      enterprise_id: t.enterpriseId, provider_resource_id: t.resources.get("deepseek")!,
      state: "PENDING",
    }).execute();
    await finance.recordOpeningBalance({
      enterpriseId: t.enterpriseId,
      adminId: t.adminId,
      resourceId: t.resources.get("deepseek")!,
      accountAmount: "100",
      accountCurrency: "CNY",
      occurredAt: new Date("2026-09-01T00:00:00+08:00"),
      idempotencyKey: randomUUID(),
    });
    await finance.recordRecharge({
      enterpriseId: t.enterpriseId,
      adminId: t.adminId,
      resourceId: t.resources.get("deepseek")!,
      accountAmount: "120",
      accountCurrency: "CNY",
      cashPaidCny: "100",
      occurredAt: new Date("2026-09-02T00:00:00+08:00"),
      idempotencyKey: randomUUID(),
    });
    await finance.recordRecharge({enterpriseId:t.enterpriseId,adminId:t.adminId,resourceId:t.resources.get("deepseek")!,accountAmount:"50",accountCurrency:"CNY",cashPaidCny:"50",occurredAt:new Date("2026-09-01T00:00:00+08:00"),idempotencyKey:randomUUID()});
    await usage(t,t.a,"deepseek",50n,new Date("2026-09-01T00:00:00+08:00"),"2");
    const subscriptionPeriodIds = new Map<string, string>();
    for (const [code, amount] of [
      ["kimi", "199"],
      ["zhipu", "99"],
    ]) {
      const { periodId } = await finance.recordSubscription({
        enterpriseId: t.enterpriseId,
        adminId: t.adminId,
        resourceId: t.resources.get(code!)!,
        accountAmount: amount!,
        accountCurrency: "CNY",
        cashPaidCny: amount!,
        occurredAt: new Date("2026-09-01T00:00:00+08:00"),
        periodStart: new Date("2026-09-01T00:00:00+08:00"),
        periodEndExclusive: new Date("2026-10-01T00:00:00+08:00"),
        kind: "PURCHASE",
        productName: code!,
        idempotencyKey: randomUUID(),
      });
      subscriptionPeriodIds.set(code!, periodId);
    }
    // 8 月 kimi 用量归属切换前既有周期（MIGRATED_CARRYOVER：无资金事件，不影响实付口径）。
    const kimiCarryoverPeriodId = (await db.insertInto("provider_subscription_period").values({
      enterprise_id: t.enterpriseId, provider_resource_id: t.resources.get("kimi")!,
      finance_event_id: null, product_name: "kimi",
      period_start: new Date("2026-08-01T00:00:00+08:00"),
      period_end_exclusive: new Date("2026-09-01T00:00:00+08:00"),
      source: "MIGRATED_CARRYOVER", migration_source_record_id: randomUUID(),
      created_by_admin_user_id: t.adminId,
    }).returning("id").executeTakeFirstOrThrow()).id;
    await usage(t, t.a, "kimi", 100n, new Date("2026-08-02T00:00:00Z"),
      "0", "PROVIDER_REPORTED", kimiCarryoverPeriodId);
    await usage(t, t.a, "kimi", 100n, new Date("2026-09-02T00:00:00Z"),
      "0", "PROVIDER_REPORTED", subscriptionPeriodIds.get("kimi")!);
    await usage(t, t.b, "zhipu", 200n, new Date("2026-09-03T00:00:00Z"),
      "0", "PROVIDER_REPORTED", subscriptionPeriodIds.get("zhipu")!);
    await usage(
      t,
      t.a,
      "deepseek",
      500n,
      new Date("2026-09-04T00:00:00Z"),
      "10",
    );
    await usage(
      t,
      t.a,
      "deepseek",
      500n,
      new Date("2026-09-20T00:00:00Z"),
      "50",
    );
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: t.enterpriseId,
      provider_resource_id: t.resources.get("deepseek")!,
      version: 1,
      source: "PROVIDER_SYNC",
      collected_at: new Date("2026-09-06T00:00:22+08:00"),
      currency: "CNY",
      current_balance: "356.61",
      provider_balance_available: true,
      balance_source: "PROVIDER_API",
      balance_updated_at: new Date("2026-09-06T00:00:22+08:00"),
      usage_calculation: "SYSTEM_LEDGER",
    }).execute();
    const report = await loadOperatingAnalysis(
      db,
      t.enterpriseId,
      "2026-09",
      new Date("2026-09-06T12:00:00Z"),
    );
    expect(report.summary).toMatchObject({
      companyTokens: "850",
      ytdAverageTokens: "475.00",
      ytdAverageChange: "375.00",
      perCapitaTokens: "425.00",
      perCapitaChange: "325.00",
      planUtilization: "100.00",
    });
    expect(report.months[7]).toMatchObject({
      employeeCount: 1,
      totalTokens: "100",
      perCapitaTokens: "100.00",
    });
    expect(report.months[8]).toMatchObject({
      employeeCount: 2,
      totalTokens: "850",
    });
    expect(report.cashSummary).toMatchObject({ yearCash: "448.00" });
    // S3c 断言迁移（追加合同 §1 / ACE-06）：apiSpend 改由 loadApiCostEstimation 同源估算，
    // 按 settled_at 半开窗口聚合整个 operatingBillMonthRange、无 asOf 截断（S1 估算合同；
    // 与经营账单 draft、首页读者同期间语义），故 09-20 结算的已计价行（50.00）计入 9 月
    // 估算：2+10+50=62.00；不再沿用资金视图 settled_at<=asOf 的旧值 12.00。
    // opening/recharge/paidCny/ending 为资金域轨迹字段（WP2/WP4 处置），仍走资金视图
    // asOf 口径，数值不变。
    expect(report.apiAccounts[0]!.months[8]).toMatchObject({
      openingBalance: "100.00",
      recharge: "170.00",
      paidCny: "150.00",
      apiSpend: "62.00",
      apiSpendComplete: true,
      endingBalance: "258.00",
    });
    expect(report.officialApiBalances).toEqual([
      expect.objectContaining({ providerCode: "deepseek", providerName: "DeepSeek",
        resourceName: "deepseek", currency: "CNY", balance: "356.61000000",
        syncedAt: "2026-09-05T16:00:22.000Z" }),
    ]);
    await usage(t, t.a, "kimi", 900n, new Date("2026-09-05T00:00:00Z"),
      "0", "PROVIDER_REPORTED", subscriptionPeriodIds.get("kimi")!);
    const august = await loadOperatingAnalysis(
      db,
      t.enterpriseId,
      "2026-08",
      new Date("2026-09-06T12:00:00Z"),
    );
    expect(
      august.plans.find((plan) => plan.providerCode === "kimi")!.months[7]!
        .utilization,
    ).toBe("10.00");
    expect(august.cashSummary.yearCash).toBe("0.00");
    await db
      .updateTable("principal")
      .set({
        archived_at: new Date("2026-09-05T00:00:00Z"),
        status: "DISABLED",
      })
      .where("id", "=", t.b)
      .execute();
    const updated = await loadOperatingAnalysis(
      db,
      t.enterpriseId,
      "2026-09",
      new Date("2026-09-06T12:00:00Z"),
    );
    expect(updated.months[7]!.employeeCount).toBe(1);
    expect(updated.months[8]!.employeeCount).toBe(1);
  }, 30_000);

  // ---- S3c（追加合同 §4）：年度聚合 apiSpend/apiSpendComplete 同源估算对齐用例 ----
  it("S3c：无资金事件、有已结算已计价行时月度 apiSpend 取估算字面值（ACE-03/06）", async () => {
    // 不登记任何期初/充值/资金激活事件——估算不依赖资金初始化（ACE-03）。
    const t = await tenant();
    await usage(t, t.a, "deepseek", 100n, new Date("2026-09-02T00:00:00Z"), "7.5");
    const report = await loadOperatingAnalysis(
      db,
      t.enterpriseId,
      "2026-09",
      new Date("2026-09-06T12:00:00Z"),
    );
    const account = report.apiAccounts.find(
      (row) => row.providerCode === "deepseek",
    );
    expect(account).toBeDefined();
    expect(account!.months[8]).toMatchObject({
      apiSpend: "7.50",
      apiSpendComplete: true,
    });
    // apiReviews totals 随新源自然更新（合同 §1.2）：1-8 月无 API 行为精确 0，合计不变。
    expect(account!.totals.apiSpend).toBe("7.50");
    expect(account!.totals.apiSpendComplete).toBe(true);
  });

  it("S3c：多币种估算不混加，apiSpend 为 null 且不完整（ACE-07）", async () => {
    const t = await tenant();
    await usage(t, t.a, "deepseek", 10n, new Date("2026-09-02T00:00:00Z"), "2");
    const usd = await usage(
      t,
      t.a,
      "deepseek",
      10n,
      new Date("2026-09-03T00:00:00Z"),
      "3",
    );
    await db
      .updateTable("ledger_line")
      .set({ api_cost_currency: "USD" })
      .where("ai_request_id", "=", usd)
      .execute();
    const report = await loadOperatingAnalysis(
      db,
      t.enterpriseId,
      "2026-09",
      new Date("2026-09-06T12:00:00Z"),
    );
    const rows = report.apiAccounts.filter(
      (row) => row.providerCode === "deepseek",
    );
    expect(rows.map((row) => row.currency).sort()).toEqual(["CNY", "USD"]);
    for (const row of rows) {
      expect(row.months[8]).toMatchObject({
        apiSpend: null,
        apiSpendComplete: false,
      });
    }
  });

  it("S3c：混合已知与缺口时保留已计价金额并标记不完整（ACE-04）", async () => {
    const t = await tenant();
    await usage(t, t.a, "deepseek", 100n, new Date("2026-09-02T00:00:00Z"), "2.5");
    const gap = await usage(
      t,
      t.a,
      "deepseek",
      25n,
      new Date("2026-09-03T00:00:00Z"),
      "0",
      "UNKNOWN",
    );
    await db
      .updateTable("ledger_line")
      .set({ api_cost: null, api_cost_currency: null, api_cost_status: "UNKNOWN_COST" })
      .where("ai_request_id", "=", gap)
      .execute();
    const report = await loadOperatingAnalysis(
      db,
      t.enterpriseId,
      "2026-09",
      new Date("2026-09-06T12:00:00Z"),
    );
    expect(
      report.apiAccounts.find((row) => row.providerCode === "deepseek")!.months[8],
    ).toMatchObject({ apiSpend: "2.50", apiSpendComplete: false });
  });

  it("S3c：资金轨迹字段（期初/充值/实付/期末）与估算 apiSpend 并存产出", async () => {
    const t = await tenant();
    const finance = new ProviderFinanceRepository(db);
    // F-P2-6 前置事实：企业已激活 + 资源 PENDING（资源级 ADMIN 期初门槛）。
    await sql`
      INSERT INTO provider_finance_runtime_state
        (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at)
      VALUES (${t.enterpriseId}::uuid, true, now(), ${t.adminId}::uuid, now())
      ON CONFLICT (enterprise_id) DO NOTHING
    `.execute(db);
    await db.insertInto("provider_resource_finance_state").values({
      enterprise_id: t.enterpriseId,
      provider_resource_id: t.resources.get("deepseek")!,
      state: "PENDING",
    }).execute();
    await finance.recordOpeningBalance({
      enterpriseId: t.enterpriseId,
      adminId: t.adminId,
      resourceId: t.resources.get("deepseek")!,
      accountAmount: "80",
      accountCurrency: "CNY",
      occurredAt: new Date("2026-09-01T00:00:00+08:00"),
      idempotencyKey: randomUUID(),
    });
    await finance.recordRecharge({
      enterpriseId: t.enterpriseId,
      adminId: t.adminId,
      resourceId: t.resources.get("deepseek")!,
      accountAmount: "20",
      accountCurrency: "CNY",
      cashPaidCny: "20",
      occurredAt: new Date("2026-09-02T00:00:00+08:00"),
      idempotencyKey: randomUUID(),
    });
    await usage(t, t.a, "deepseek", 10n, new Date("2026-09-02T00:00:00Z"), "4");
    const report = await loadOperatingAnalysis(
      db,
      t.enterpriseId,
      "2026-09",
      new Date("2026-09-06T12:00:00Z"),
    );
    // 轨迹字段仍由资金域产出（WP2/WP4 处置），apiSpend 已切同源估算（ACE-03/06）。
    expect(report.apiAccounts[0]!.months[8]).toMatchObject({
      openingBalance: "80.00",
      recharge: "20.00",
      paidCny: "20.00",
      apiSpend: "4.00",
      apiSpendComplete: true,
      endingBalance: "96.00",
    });
  });

  it("跨企业隔离，未知用量和无人数不伪装为零或人均", async () => {
    const t = await tenant();
    await usage(
      t,
      t.a,
      "kimi",
      0n,
      new Date("2026-09-02T00:00:00Z"),
      "0",
      "UNKNOWN",
    );
    const report = await loadOperatingAnalysis(
      db,
      t.enterpriseId,
      "2026-09",
      new Date("2026-09-06T12:00:00Z"),
    );
    expect(report.summary.companyTokens).toBeNull();
    expect(report.summary.ytdAverageTokens).toBeNull();
    expect(report.summary.perCapitaTokens).toBeNull();
    await usage(t, t.a, "zhipu", 100n, new Date("2026-09-02T00:00:00Z"));
    const incompletePlans = await loadOperatingAnalysis(db, t.enterpriseId, "2026-09", new Date("2026-09-06T12:00:00Z"));
    expect(incompletePlans.plans.find((plan) => plan.providerCode === "zhipu")!.months[8]!.utilization).toBe("100.00");
    expect(incompletePlans.summary.planUtilization).toBeNull();
    const other = await tenant();
    const isolated = await loadOperatingAnalysis(
      db,
      other.enterpriseId,
      "2026-09",
      new Date("2026-09-06T12:00:00Z"),
    );
    expect(isolated.summary.companyTokens).toBe("0");
    expect(isolated.cashSummary.yearCash).toBe("0.00");
    expect(isolated.months[0]!.employeeCount).toBe(0);
    expect(isolated.months[0]!.perCapitaTokens).toBeNull();
  });

  it("项目通过负责人归部门，新关系不搬迁旧请求，资料不足必须明确失败", async () => {
    const t = await tenant(),
      other = await tenant();
    const base = { enterpriseId: t.enterpriseId, adminId: t.adminId };
    await expect(
      savePrincipalAccounting(db, {
        ...base,
        principalId: t.a,
        expectedVersion: 0,
      }),
    ).rejects.toThrow("员工必须指定部门");
    await savePrincipalAccounting(db, {
      ...base,
      principalId: t.a,
      departmentName: "研发部",
      expectedVersion: 0,
    });
    await expect(
      savePrincipalAccounting(db, {
        ...base,
        principalId: t.project,
        ownerPrincipalId: other.a,
        expectedVersion: 0,
      }),
    ).rejects.toThrow("系统内的员工");
    await savePrincipalAccounting(db, {
      ...base,
      principalId: t.project,
      ownerPrincipalId: t.a,
      expectedVersion: 0,
    });
    const first = await usage(t, t.project, "deepseek", 5n, await requestTime(), "2");
    await db
      .transaction()
      .execute((trx) =>
        ensureRequestAttributionSnapshot(trx, t.enterpriseId, first),
      );
    await savePrincipalAccounting(db, {
      ...base,
      principalId: t.a,
      departmentName: "售前部",
      expectedVersion: 1,
    });
    await expect(
      savePrincipalAccounting(db, {
        ...base,
        principalId: t.a,
        departmentName: "错误部门",
        expectedVersion: 1,
      }),
    ).rejects.toThrow("归属已被修改");
    const second = await usage(t, t.project, "deepseek", 7n, await requestTime(), "3");
    await db
      .transaction()
      .execute((trx) =>
        ensureRequestAttributionSnapshot(trx, t.enterpriseId, second),
      );
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
    })
      .format(new Date())
      .slice(0, 7);
    const bill = await loadOperatingDepartmentAccounts(
      db,
      t.enterpriseId,
      month,
    );
    expect(
      bill.rows.find((row) => row.subjectName === "研发部")!.totals,
    ).toMatchObject({
      totalTokens: "5",
      apiCost: "2.00000000",
      requestCount: 1,
    });
    expect(
      bill.rows.find((row) => row.subjectName === "售前部")!.totals,
    ).toMatchObject({
      totalTokens: "7",
      apiCost: "3.00000000",
      requestCount: 1,
    });
    expect(bill.totals).toMatchObject({
      totalTokens: "12",
      apiCost: "5.00000000",
      requestCount: 2,
    });
    expect(
      (await readPrincipalAccounting(db, t.enterpriseId, t.project)).assignment
        ?.ownerPrincipalId,
    ).toBe(t.a);
    const person = await db
      .insertInto("person")
      .values({ enterprise_id: t.enterpriseId, name: "目录员工 A" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const unit = await db
      .insertInto("organization_unit")
      .values({
        enterprise_id: t.enterpriseId,
        name: "客服部",
        parent_id: null,
        external_source_id: null,
        external_unit_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("principal")
      .set({ person_id: person.id, department_label: "客服部" })
      .where("id", "=", t.a)
      .execute();
    await db
      .insertInto("organization_membership")
      .values({
        enterprise_id: t.enterpriseId,
        person_id: person.id,
        organization_unit_id: unit.id,
        is_primary: true,
        valid_until: null,
        source: "EXCEL",
      })
      .execute();
    const third = await usage(t, t.project, "deepseek", 2n, await requestTime(), "4");
    await db
      .transaction()
      .execute((trx) =>
        ensureRequestAttributionSnapshot(trx, t.enterpriseId, third),
      );
    expect(
      (
        await loadOperatingDepartmentAccounts(db, t.enterpriseId, month)
      ).rows.find((row) => row.subjectName === "客服部")!.totals.apiCost,
    ).toBe("4.00000000");
    expect(
      (await readPrincipalAccounting(db, t.enterpriseId, t.a)).assignment
        ?.departmentId,
    ).toBe(unit.id);
    expect(
      (
        await savePrincipalAccounting(db, {
          ...base,
          principalId: t.a,
          departmentName: "售前部",
          expectedVersion: 2,
        })
      ).version,
    ).toBe(3);
  });
  it("手工员工负责人没有 person_id 时，结账后仍保留负责人", async () => {
    const t = await tenant();
    await savePrincipalAccounting(db, {enterpriseId:t.enterpriseId,adminId:t.adminId,principalId:t.a,departmentName:"研发部",expectedVersion:0});
    await savePrincipalAccounting(db, {enterpriseId:t.enterpriseId,adminId:t.adminId,principalId:t.project,ownerPrincipalId:t.a,expectedVersion:0});
    const at = await requestTime();
    const request = await usage(t,t.project,"deepseek",5n,at,"2");
    await db.transaction().execute((trx) => ensureRequestAttributionSnapshot(trx,t.enterpriseId,request));
    const month = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit"}).format(at).slice(0,7);
    const accounts = new OperatingBillAccountRepository(db);
    const live = await accounts.listAccounts(t.enterpriseId,month,"PROJECT");
    expect(live.rows[0]!.projectOwner).toEqual({personId:null,personName:"员工 A"});
    await new OperatingBillRepository(db).closeMonth({enterpriseId:t.enterpriseId,adminId:t.adminId,month,allowIncomplete:true,note:"测试允许缺少历史厂商快照"});
    const frozen = await accounts.listAccounts(t.enterpriseId,month,"PROJECT");
    expect(frozen.status).toBe("CLOSED");
    expect(frozen.rows[0]!.projectOwner).toEqual(live.rows[0]!.projectOwner);
  });
});
