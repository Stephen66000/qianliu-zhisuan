/**
 * S3b（WP1 合同 §1.2/§1.3）集成证据：
 *   a) 用量总览模型行期间/处置口径与 loadApiCostEstimation 一致（同批行同值字面值）——
 *      queryUsageRows 已统一 settled_at 半开窗口 + effectiveReportedApiCostSql 处置投影；
 *   b) 经营账单当前期 draft 的资源级/汇总 API 费用＝估算字面值，余额桥接机制字段
 *      （opening/ending/recharge、balanceBridgeFacts、apiSpendStatus）保留产出；
 *   c) 已关账版本快照内容逐字节不变（AFR-06），reopen 后 draft 反映估算口径；
 *   d) G23/AT-AFR-12：仅有余额桥接、无任何请求计价（ledger_line）的月份——桥接字段
 *      （opening/recharge/ending）与桥接可算性状态照常产出、原值保留，估算主值为
 *      精确 0 语义（无计价行），不把桥接金额 30 填成「API费用估算」已确认值。
 * 依据：ACE-03/04/06/07、AFR-06/07、AFR-12、WP0 contracts.md C1、S3a 移交项。
 */
import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, DashboardRepository, OperatingBillRepository,
  loadApiCostEstimation } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
// 2026-09 上海自然月：[2026-08-31T16:00Z, 2026-09-30T16:00Z)。
const start = new Date("2026-08-31T16:00:00.000Z");
const end = new Date("2026-09-30T16:00:00.000Z");
const anchor = new Date("2026-09-10T04:00:00.000Z");

beforeAll(async () => {
  pg = await startPostgresContainer("api_cost_draft_model_alignment");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

interface Fixture {
  enterpriseId: string;
  adminId: string;
  principalId: string;
  keyId: string;
  resourceId: string;
  modelId: string;
}

/** 独立企业；不写任何资金账户/期初/余额数据（ACE-03 前提）。 */
async function fixture(): Promise<Fixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "S3b 对齐核对" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: adminId,
    password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工",
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_s3b", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "api 资源", mode: "API",
    credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  const model = await db.insertInto("unified_model").values({
    enterprise_id: enterpriseId, alias: "ql-s3b-model", display_name: "S3B Model",
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: enterpriseId, unified_model_id: model.id,
    provider_resource_id: resource.id, upstream_model: "s3b-upstream", enabled: true,
  }).execute();
  return { enterpriseId, adminId, principalId, keyId, resourceId: resource.id, modelId: model.id };
}

interface SeedLineInput {
  at: Date;
  /** 缺省＝settled_at 与 created_at 相同；显式给出即可构造两列分属不同期间的行。 */
  settledAt?: Date;
  cost: string | null;
  currency?: string | null;
  status?: "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST";
}

async function seedLine(f: Fixture, input: SeedLineInput): Promise<string> {
  const requestId = randomUUID();
  const at = input.at;
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: f.enterpriseId, principal_id: f.principalId,
    principal_key_id: f.keyId, protocol: "chat", unified_model: "model",
    unified_model_id: f.modelId,
    status: "SUCCEEDED", started_at: at, finished_at: at,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: f.resourceId, upstream_model: "s3b-upstream", http_status: 200,
    response_committed: true, finished_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    provider_resource_id: f.resourceId, input_tokens: 1000n, output_tokens: 100n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const status = input.status
    ?? (input.cost === null ? "UNKNOWN_COST" : "PRICED_USAGE");
  await db.insertInto("ledger_line").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    usage_event_id: usage.id, provider_resource_id: f.resourceId, principal_id: f.principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: input.cost,
    api_cost_currency: (input.cost === null || input.currency === null
      || status === "CONFIRMED_ZERO_NO_UPSTREAM")
      ? null : input.currency ?? "CNY",
    api_cost_status: status,
    usage_quality: "PROVIDER_REPORTED",
    settled_at: input.settledAt ?? at, created_at: at,
  }).execute();
  // 生产结算链同时写 SETTLED 汇总事务（closeMonth 的 pending-settlement 保护以此为准）。
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId, enterprise_id: f.enterpriseId, principal_id: f.principalId,
    total_input_tokens: 1000n, total_output_tokens: 100n, total_cache_tokens: 0n,
    total_reasoning_tokens: 0n, total_deducted_quota: 0n,
    total_api_cost: status === "CONFIRMED_ZERO_NO_UPSTREAM" ? "0" : input.cost,
    api_cost_status: status,
    usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED", created_at: at,
  }).execute();
  return requestId;
}

async function modelRow(f: Fixture) {
  const overview = await new DashboardRepository(db)
    .getResourceUsageOverview(f.enterpriseId, anchor.getTime());
  const detail = overview.modelDetails.find((row) => row.resourceId === f.resourceId);
  expect(detail).toBeDefined();
  return { detail: detail!, provider: overview.providerSummaries
    .find((row) => row.providerCode === "deepseek") };
}

describe("用量总览模型行期间/处置口径与估算一致（合同 §1.2）", () => {
  it("同批已计价+明确零行：模型行 monthlyCost 与估算金额字面值相等", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-05T10:00:00+08:00"), cost: "1.05", status: "PRICED_USAGE" });
    await seedLine(f, { at: new Date("2026-09-06T10:00:00+08:00"), cost: "0",
      status: "CONFIRMED_ZERO_NO_UPSTREAM" });

    const estimation = await loadApiCostEstimation(db, f.enterpriseId,
      { start, end, resourceIds: [f.resourceId] });
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "1.05000000" }]);

    const { detail, provider } = await modelRow(f);
    // 同批行同值：模型行/汇总行/统一估算三方字面值相等（ACE-06）。
    expect(detail.monthlyCost).toBe("1.05000000");
    expect(detail.monthlyCost).toBe(estimation.amounts[0]!.amount);
    expect(provider?.monthlyCost).toBe("1.05000000");
  });

  it("期间归集按 settled_at 半开窗口：settled 出窗不计、settled 入窗即计（与估算一致）", async () => {
    const f = await fixture();
    // created_at 在 9 月、settled_at 已到 10 月窗口外：老 created_at 口径会误计。
    await seedLine(f, {
      at: new Date("2026-09-07T10:00:00+08:00"),
      settledAt: new Date("2026-10-01T00:00:00+08:00"),
      cost: "7.00",
    });
    // created_at 在 8 月、settled_at 落在 9 月窗口内：老 created_at 口径会漏计。
    await seedLine(f, {
      at: new Date("2026-08-15T10:00:00+08:00"),
      settledAt: new Date("2026-09-08T10:00:00+08:00"),
      cost: "2.00",
    });

    const estimation = await loadApiCostEstimation(db, f.enterpriseId,
      { start, end, resourceIds: [f.resourceId] });
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "2.00000000" }]);

    const { detail, provider } = await modelRow(f);
    expect(detail.monthlyCost).toBe("2.00000000");
    expect(detail.monthlyTotalTokens).toBe("1100"); // 仅 settled 入窗的 8 月行
    expect(provider?.monthlyCost).toBe("2.00000000");
  });

  it("处置投影口径：UNKNOWN_COST 行置空模型行金额；合法处置排除后模型行与估算恢复同值", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-05T10:00:00+08:00"), cost: "1.05", status: "PRICED_USAGE" });
    const unknownRequest = await seedLine(f, {
      at: new Date("2026-09-06T10:00:00+08:00"), cost: null, status: "UNKNOWN_COST",
    });

    const beforeDisposition = await loadApiCostEstimation(db, f.enterpriseId,
      { start, end, resourceIds: [f.resourceId] });
    expect(beforeDisposition.completeness).toBe("KNOWN_PARTIAL");
    expect(beforeDisposition.amounts).toEqual([{ currency: "CNY", amount: "1.05000000" }]);
    expect(beforeDisposition.gaps).toEqual([{ reason: "PRICE_MISSING", count: 1 }]);
    const { detail: unknownDetail } = await modelRow(f);
    // 处置投影下未处置的未知行：api_cost 投影为 NULL → 模型行金额不可计算（不冒充精确值）。
    expect(unknownDetail.monthlyCost).toBeNull();

    // 登记合法处置（0086/0091 显式排除；原始账本事实不动）。
    const unknownLine = await db.selectFrom("ledger_line").select("id")
      .where("enterprise_id", "=", f.enterpriseId)
      .where("ai_request_id", "=", unknownRequest).executeTakeFirstOrThrow();
    await db.insertInto("provider_finance_recorded_cost_policy").values({
      enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId,
      authorized_by_admin_user_id: f.adminId, reason: "Owner approved recorded costs only",
      evidence_ref: "s3b-test-policy",
    }).execute();
    await sql`
      INSERT INTO provider_finance_usage_cost_disposition
        (enterprise_id, provider_resource_id, ledger_line_id, ai_request_id, decision,
         original_ledger_fact, server_cost_evidence, reason, evidence_ref,
         decided_by_admin_user_id, idempotency_key, request_hash)
      SELECT line.enterprise_id, line.provider_resource_id, line.id, line.ai_request_id,
             'EXCLUDE_NO_SERVER_COST', to_jsonb(line), '{"source":"s3b-test"}'::jsonb,
             'owner approved', 's3b-test:evidence', ${f.adminId}::uuid,
             ${"s3b-" + randomUUID()}, ${createHash("sha256").update(unknownRequest).digest("hex")}
        FROM ledger_line line
       WHERE line.id = ${unknownLine.id}::uuid
    `.execute(db);

    const afterDisposition = await loadApiCostEstimation(db, f.enterpriseId,
      { start, end, resourceIds: [f.resourceId] });
    expect(afterDisposition.excludedNoRecordedCost).toBe(1);
    expect(afterDisposition.gaps).toEqual([]);
    expect(afterDisposition.completeness).toBe("KNOWN_COMPLETE");

    const { detail: disposedDetail } = await modelRow(f);
    // 同批行同值：被处置排除的行按处置投影计为已知 0，模型行恢复与估算相同的金额字面值。
    expect(disposedDetail.monthlyCost).toBe("1.05000000");
    expect(disposedDetail.monthlyCost).toBe(afterDisposition.amounts[0]!.amount);
  });
});

describe("经营账单当前期 draft 主口径＝估算、桥接字段保留、关账版本不变（合同 §1.3）", () => {
  it("draft apiCost/totalCost/apiSpends 采用估算字面值；opening/ending/recharge/桥接事实照常产出", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-05T10:00:00+08:00"), cost: "12.34", status: "PRICED_USAGE" });
    await db.insertInto("provider_resource_operating_snapshot").values([
      { enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId, version: 1,
        source: "ADMIN", collected_at: new Date("2026-08-30T00:00:00+08:00"),
        currency: "CNY", current_balance: "100" },
      { enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId, version: 2,
        source: "ADMIN", collected_at: new Date("2026-09-20T00:00:00+08:00"),
        currency: "CNY", current_balance: "87.66" },
    ]).execute();
    await db.insertInto("resource_purchase_record").values({
      enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId,
      purchase_type: "API_RECHARGE", amount: "5", currency: "CNY",
      purchased_at: new Date("2026-09-10T00:00:00+08:00"), source: "ADMIN", created_by: f.adminId,
    }).execute();

    const estimation = await loadApiCostEstimation(db, f.enterpriseId,
      { start, end, resourceIds: [f.resourceId] });
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "12.34000000" }]);

    const bill = await new OperatingBillRepository(db).getBill(f.enterpriseId, "2026-09");
    const provider = bill.providers.find((row) => row.providerResourceId === f.resourceId);
    // 资源级 API 费用＝估算字面值（主口径）；余额桥接差 100+5−87.66=17.34 不再冒充该值。
    expect(provider?.apiCost).toBe("12.34000000");
    expect(provider?.apiCost).toBe(estimation.amounts[0]!.amount);
    expect(provider?.totalCost).toBe("12.34000000");
    // 桥接机制字段保留产出（WP2/WP4 处置；上月关账→本月期初链路依赖）。
    expect(provider).toMatchObject({
      ledgerApiCost: "12.34000000",
      openingBalance: "100.00000000",
      rechargeAmount: "5.00000000",
      endingBalance: "87.66000000",
      apiSpendStatus: "CALCULABLE",
    });
    expect(bill.sourceFacts.balanceBridgeFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerResourceId: f.resourceId, currency: "CNY",
        openingBalance: "100.00000000", rechargeAmount: "5.00000000",
        endingBalance: "87.66000000", apiSpend: "17.34000000",
        apiSpendStatus: "CALCULABLE",
      }),
    ]));
    // 汇总行：apiCost/apiSpends/totalCost/apiSpends 分列＝估算；桥接字段保留。
    expect(bill.summary).toMatchObject({
      apiCost: "12.34000000",
      apiSpends: [{ currency: "CNY", amount: "12.34000000" }],
      totalCost: "12.34000000",
      totalSpends: [{ currency: "CNY", amount: "12.34000000" }],
      openingBalance: "100.00000000",
      monthlyRecharge: "5.00000000",
      endingBalance: "87.66000000",
      apiSpendStatus: "CALCULABLE",
    });
    // 完整性机制不动：无缺口可关账。
    expect(bill.gaps).toEqual([]);
  });

  it("已关账版本快照逐字节不变（AFR-06）；reopen 后 draft 反映当前估算口径", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-05T10:00:00+08:00"), cost: "12.34", status: "PRICED_USAGE" });
    await db.insertInto("provider_resource_operating_snapshot").values([
      { enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId, version: 1,
        source: "ADMIN", collected_at: new Date("2026-08-30T00:00:00+08:00"),
        currency: "CNY", current_balance: "100" },
      { enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId, version: 2,
        source: "ADMIN", collected_at: new Date("2026-09-20T00:00:00+08:00"),
        currency: "CNY", current_balance: "87.66" },
    ]).execute();
    const repo = new OperatingBillRepository(db);
    const closed = await repo.closeMonth({
      enterpriseId: f.enterpriseId, adminId: f.adminId, month: "2026-09",
      allowIncomplete: false, note: "S3b 关账", includeDepartmentEvidence: false,
    });
    expect(closed.status).toBe("CLOSED");
    expect(closed.summary.apiCost).toBe("12.34000000");
    const frozenBefore = await db.selectFrom("operating_bill_version")
      .select("snapshot")
      .where("enterprise_id", "=", f.enterpriseId)
      .where("version", "=", 1)
      .executeTakeFirstOrThrow();
    const frozenBeforeText = JSON.stringify(frozenBefore.snapshot);

    // 关账后改写账本计价：v1 快照不得受影响；新 draft 按估算重算。
    const line = await db.selectFrom("ledger_line").select("ai_request_id")
      .where("enterprise_id", "=", f.enterpriseId)
      .where("resource_mode", "=", "API")
      .executeTakeFirstOrThrow();
    // 同步账本行与 SETTLED 汇总事务（closeMonth 的结算一致性屏障校验两者合计一致）。
    await db.updateTable("ledger_line").set({ api_cost: "99.99" })
      .where("enterprise_id", "=", f.enterpriseId)
      .where("ai_request_id", "=", line.ai_request_id).execute();
    await db.updateTable("ledger_transaction").set({ total_api_cost: "99.99" })
      .where("enterprise_id", "=", f.enterpriseId)
      .where("ai_request_id", "=", line.ai_request_id).execute();
    const stillClosed = await repo.getBill(f.enterpriseId, "2026-09");
    expect(stillClosed.status).toBe("CLOSED");
    expect(stillClosed.summary.apiCost).toBe("12.34000000");

    await repo.reopenMonth({ enterpriseId: f.enterpriseId, month: "2026-09",
      reason: "S3b 重开", adminId: f.adminId });
    const reopened = await repo.getBill(f.enterpriseId, "2026-09");
    expect(reopened.status).toBe("DRAFT");
    expect(reopened.summary.apiCost).toBe("99.99000000");

    await repo.closeMonth({
      enterpriseId: f.enterpriseId, adminId: f.adminId, month: "2026-09",
      allowIncomplete: false, note: "S3b 修正后关账", includeDepartmentEvidence: false,
    });
    const frozenAfter = await db.selectFrom("operating_bill_version")
      .select("snapshot")
      .where("enterprise_id", "=", f.enterpriseId)
      .where("version", "=", 1)
      .executeTakeFirstOrThrow();
    // 逐字节对比：已关账版本 1 内容不受后续任何重算影响（AFR-06）。
    expect(JSON.stringify(frozenAfter.snapshot)).toBe(frozenBeforeText);
  });

  // AT-AFR-12 / G23（acceptance-plan §3 F08「仅有余额桥接、无请求计价的月份」、§5
  // AT-AFR-12「查询仅有余额桥接记录的月份，检查新估算不伪填旧金额——保留原历史金额
  // 及其标签，不填入“API费用估算”作为已确认值」）：构造一个月只有期初/充值/期末事实、
  // 无任何 ledger_line 消费行。断言：
  //   1) 桥接字段照常产出且原值保留（opening 100 / recharge 50 / ending 120，桥接金额
  //      30 连同其桥接标签一起保留在 balanceBridgeFacts——原历史金额及其标签）；
  //   2) 桥接可算性按既有字段 apiSpendStatus 的实际语义断言：期初/期末事实齐全 →
  //      CALCULABLE（既有枚举的桥接可算口径；若期初缺席则属 BRIDGE_UNAVAILABLE 分支，
  //      见 monthly-operating-cost.ts——两者均为既有桥接可算性枚举，本夹具齐全故为
  //      CALCULABLE，不发明新语义）；
  //   3) 估算主值 apiCost 为无计价行时的精确 0 语义（WP1 合同 §1 estimatedApiCostFields：
  //      空 amounts 且非 KNOWN_PARTIAL → 精确 0），绝不把桥接金额 30 填成已确认估算；
  //   4) 读取层（该月 draft JSON）不出现「API费用估算=30」：任何名为 apiCost/totalCost/
  //      apiSpends/totalSpends 的字段都不承载 30。
  it("G23/F08 仅有余额桥接、无请求计价的月份：桥接原值与标签保留，估算主值精确 0、不伪填桥接 30（AT-AFR-12）", async () => {
    const f = await fixture();
    // 仅余额桥接事实：期初快照 100（9 月前）、期末快照 120（月内）、充值 50；无任何消费行。
    await db.insertInto("provider_resource_operating_snapshot").values([
      { enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId, version: 1,
        source: "ADMIN", collected_at: new Date("2026-08-30T00:00:00+08:00"),
        currency: "CNY", current_balance: "100" },
      { enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId, version: 2,
        source: "ADMIN", collected_at: new Date("2026-09-20T00:00:00+08:00"),
        currency: "CNY", current_balance: "120" },
    ]).execute();
    await db.insertInto("resource_purchase_record").values({
      enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId,
      purchase_type: "API_RECHARGE", amount: "50", currency: "CNY",
      purchased_at: new Date("2026-09-10T00:00:00+08:00"), source: "ADMIN", created_by: f.adminId,
    }).execute();
    // 夹具自证：该月确实没有任何 ledger_line（无请求计价）。
    const lineCount = await db.selectFrom("ledger_line")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("enterprise_id", "=", f.enterpriseId).executeTakeFirstOrThrow();
    expect(lineCount.count).toBe("0");
    const estimation = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(estimation.amounts).toEqual([]);
    expect(estimation.completeness).toBe("KNOWN_COMPLETE");

    const bill = await new OperatingBillRepository(db).getBill(f.enterpriseId, "2026-09");
    const provider = bill.providers.find((row) => row.providerResourceId === f.resourceId);
    // 断言 1)＋2)：桥接字段照常产出、原值保留；可算性为既有 apiSpendStatus 口径。
    expect(provider).toMatchObject({
      openingBalance: "100.00000000",
      rechargeAmount: "50.00000000",
      endingBalance: "120.00000000",
      apiSpendStatus: "CALCULABLE",
      apiSpendReason: null,
    });
    // 原历史金额（100+50-120=30）连同其桥接标签一起保留（不丢弃、不挪用为估算）。
    expect(bill.sourceFacts.balanceBridgeFacts).toEqual([expect.objectContaining({
      providerResourceId: f.resourceId, currency: "CNY",
      openingBalance: "100.00000000", rechargeAmount: "50.00000000",
      endingBalance: "120.00000000", apiSpend: "30.00000000", apiSpendStatus: "CALCULABLE",
    })]);

    // 断言 3)：估算主值精确 0（无计价行），不是桥接 30；无资金缺口/待补提示。
    expect(provider?.apiCost).toBe("0.00000000");
    expect(provider?.totalCost).toBe("0.00000000");
    expect(bill.summary.apiCost).toBe("0.00000000");
    expect(bill.summary.apiSpends).toEqual([]);
    expect(bill.summary.openingBalance).toBe("100.00000000");
    expect(bill.summary.monthlyRecharge).toBe("50.00000000");
    expect(bill.summary.endingBalance).toBe("120.00000000");
    expect(bill.summary.apiSpendStatus).toBe("CALCULABLE");
    expect(bill.gaps).toEqual([]);
    expect(bill.summary.apiSpendReason).toBeNull();

    // 断言 4)：draft JSON 全树扫描——任何估算/合计字段都不承载 30（不出现“API费用估算=30”）。
    // 估算域字段：标量 apiCost/totalCost/monthlyCost，以及 apiSpends/totalSpends 分列中
    // 的 amount 叶子（其宿主字段名沿路径携带）。桥接域字段（opening/recharge/ending/
    // apiSpend/apiSpendStatus）不在估算域，30 允许且必须留在那里。
    const estimationValuePaths: string[] = [];
    const estimationFields = new Set(["apiCost", "totalCost", "monthlyCost", "apiSpends", "totalSpends"]);
    const walk = (node: unknown, path: string, field: string | null) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`, field));
        return;
      }
      if (node !== null && typeof node === "object") {
        for (const [childKey, value] of Object.entries(node as Record<string, unknown>)) {
          walk(value, path ? `${path}.${childKey}` : childKey,
            estimationFields.has(childKey) ? childKey : field);
        }
        return;
      }
      const leafKey = path.split(".").at(-1)?.split("[").at(0) ?? null;
      const leafIsEstimationValue = field !== null
        && (leafKey === field || leafKey === "amount");
      if (leafIsEstimationValue && String(node) === "30.00000000") {
        estimationValuePaths.push(path);
      }
    };
    walk(bill, "", null);
    expect(estimationValuePaths).toEqual([]);
    // 桥接域的 30 仍在（原历史金额及其标签保留的正面证据）。
    expect(JSON.stringify(bill.sourceFacts.balanceBridgeFacts)).toContain("30.00000000");
  });
});
