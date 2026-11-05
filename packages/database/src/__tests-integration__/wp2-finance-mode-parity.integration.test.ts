/**
 * WP2-S5 金额一致性验收（AT-X01 机制层 / WP2 plan §4.6＋§6 完成条件 5）：
 *   1. 同一企业、同一期间、同一批消费事实，strict_writes 关（draft 主路径）与开
 *      （finance 投影路径）两条路径的账单 apiCost / apiSpends（含资源级 apiCost）
 *      逐字面值相等——两条路径金额同源（loadApiCostEstimation，WP1 合同 §4 裁定 2
 *      后端部分 / ACE-06）；
 *   2. 已关账版本内容不变（AT-X05 机制层）：冻结后修改账本计价事实、切换资金模式，
 *      读取已关账月份永远返回冻结版本，不按新规则重算（AFR-06/AFR-07 红线）；
 *   3. 资金域缺口码（API_OPENING_BALANCE_MISSING 等）对当前期两条路径均停产（AFR-07）；
 *   4. G5/AT-ACE-06：同一消费窗口内仅插入更晚的官方余额快照（PROVIDER_SYNC＋
 *      PROVIDER_API、余额更小）后重读估算——amounts/completeness/gaps 逐字不变
 *      （估算不读官方余额，不以余额差补造用量或费用）。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, loadApiCostEstimation, OperatingBillRepository,
  type OperatingBillSnapshot } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => {
  pg = await startPostgresContainer("wp2_finance_mode_parity");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

const MONTH = "2031-11";
const occurredAt = new Date("2031-11-05T03:00:00.000Z");
/** 已计价 CNY 部分合计（估算 known part 的字面期望值）。 */
const KNOWN_CNY = "12.34000000";

async function seedEnterprise() {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const employeeId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "WP2 模式奇偶校验" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
    username: `wp2-parity-${adminId.slice(0, 8)}`, password_hash: "test-only", status: "ACTIVE" }).execute();
  await db.insertInto("principal").values({ id: employeeId, enterprise_id: enterpriseId,
    type: "EMPLOYEE", name: "奇偶员工" }).execute();
  await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId,
    principal_id: employeeId, key_prefix: "wp2", key_digest: randomUUID() }).execute();
  const providerId = randomUUID();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: "wp2-parity", name: "奇偶厂商", adapter_type: "OPENAI_COMPATIBLE" }).execute();
  const resourceId = randomUUID();
  await db.insertInto("provider_resource").values({ id: resourceId, enterprise_id: enterpriseId,
    provider_id: providerId, name: "奇偶 API 资源", mode: "API", credential_type: "API_KEY",
    status: "ACTIVE", created_at: new Date("2031-10-01T00:00:00.000Z") }).execute();

  const addUsage = async (cost: string | null) => {
    const requestId = randomUUID();
    await db.insertInto("ai_request").values({ id: requestId, enterprise_id: enterpriseId,
      principal_id: employeeId, principal_key_id: keyId, protocol: "openai",
      unified_model: "parity-model", status: "SUCCEEDED", started_at: occurredAt,
      finished_at: occurredAt }).execute();
    const attempt = await db.insertInto("upstream_attempt").values({ ai_request_id: requestId,
      enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: resourceId,
      upstream_model: "parity-upstream", started_at: occurredAt, finished_at: occurredAt,
      http_status: 200, response_committed: true }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({ ai_request_id: requestId,
      enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
      provider_resource_id: resourceId, input_tokens: 100n, output_tokens: 10n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: requestId, created_at: occurredAt }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({ ai_request_id: requestId,
      enterprise_id: enterpriseId, usage_event_id: usage.id, upstream_attempt_id: attempt.id,
      provider_resource_id: resourceId, principal_id: employeeId, resource_mode: "API",
      raw_input_tokens: 100n, raw_output_tokens: 10n, raw_cache_tokens: 0n,
      raw_reasoning_tokens: 0n, deducted_quota: null, usage_quality: "PROVIDER_REPORTED",
      api_cost: cost, api_cost_status: cost === null ? "UNKNOWN_COST" : "PRICED_USAGE",
      api_cost_currency: cost === null ? null : "CNY",
      // F3：生产已计价行快照含冻结 sourceStatus（9bf1560 起）；夹具补齐，保持缺口断言聚焦。
      billing_rule_snapshot: cost === null ? null : { currency: "CNY", sourceStatus: "VERIFIED" },
      settled_at: occurredAt, created_at: occurredAt }).execute();
    await db.insertInto("ledger_transaction").values({ ai_request_id: requestId,
      enterprise_id: enterpriseId, principal_id: employeeId, total_input_tokens: 100n,
      total_output_tokens: 10n, total_cache_tokens: 0n, total_reasoning_tokens: 0n,
      total_deducted_quota: 0n, total_api_cost: cost,
      api_cost_status: cost === null ? "UNKNOWN_COST" : "PRICED_USAGE",
      usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED",
      created_at: occurredAt }).execute();
  };
  // 同一批消费：两条已计价（合计 12.34 CNY）＋ 一条未计价（UNKNOWN_COST）。
  await addUsage("7.77");
  await addUsage("4.57");
  await addUsage(null);
  return { enterpriseId, adminId, resourceId };
}

function billAmounts(bill: OperatingBillSnapshot) {
  return {
    apiCost: bill.summary.apiCost,
    apiSpends: bill.summary.apiSpends,
    totalSpends: bill.summary.totalSpends,
    providerApiCosts: bill.providers
      .map((row) => ({ id: row.providerResourceId, apiCost: row.apiCost }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

describe("WP2-S5 金额一致性（AT-X01 机制层）", () => {
  it("strict_writes 关与开两条路径的 draft apiCost/apiSpends 逐字面值相等（同源估算）", async () => {
    const { enterpriseId, resourceId } = await seedEnterprise();

    // 关路径：draft 主路径（finance OFF）——apiCost/apiSpends 由 loadApiCostEstimation 供给。
    const draftOff = await new OperatingBillRepository(db, "OFF").getBill(enterpriseId, MONTH);
    expect(draftOff.summary.apiCost).toBe(KNOWN_CNY);
    expect(draftOff.summary.apiSpends).toEqual([{ currency: "CNY", amount: KNOWN_CNY }]);

    // 开路径：strict_writes 置位后 finance 投影生效（ACTIVE 模式）——同一批消费的
    // 资源级与汇总 API 金额必须与关路径逐字面值相等（AT-X01）。
    const parityAdmin = (await db.selectFrom("admin_user").select("id")
      .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow()).id;
    await db.insertInto("provider_finance_runtime_state").values({ enterprise_id: enterpriseId,
      strict_writes_enabled: true, activated_at: new Date(),
      activated_by_admin_user_id: parityAdmin }).execute();
    const draftOn = await new OperatingBillRepository(db, "ACTIVE").getBill(enterpriseId, MONTH);
    // KNOWN_PARTIAL（一条 UNKNOWN_COST）→ 单币种已知部分照出＋INCOMPLETE＋估算缺口码
    // （UNKNOWN_COST 状态行＝用量已知价格缺失 → PRICE_MISSING，ACE-04 场景1）。
    expect(draftOn.summary.apiCost).toBe(KNOWN_CNY);
    expect(draftOn.summary.apiSpends).toEqual([{ currency: "CNY", amount: KNOWN_CNY }]);
    expect(draftOn.summary.apiSpendStatus).toBe("INCOMPLETE");
    expect(draftOn.summary.apiSpendReason).toBe("PRICE_MISSING:1");

    expect(billAmounts(draftOn)).toEqual(billAmounts(draftOff));
    expect(draftOn.providers.find((row) => row.providerResourceId === resourceId)?.apiCost)
      .toBe(KNOWN_CNY);

    // AFR-07：资金域缺口码对当前期两条路径均停产；用量/价格缺口（估算口径）保留。
    for (const bill of [draftOff, draftOn]) {
      const codes = bill.gaps.map((gap) => gap.code);
      for (const retired of ["API_OPENING_BALANCE_MISSING", "API_BALANCE_COST_UNKNOWN",
        "API_MONTH_OPENING_COST_UNKNOWN", "API_NEGATIVE_RECONCILIATION_REQUIRED"]) {
        expect(codes, `${bill.status}:${retired}`).not.toContain(retired);
      }
    }
  });

  it("已关账版本内容不变：冻结后改账本/切资金模式，读取仍返回冻结版本（AT-X05 机制层）", async () => {
    const { enterpriseId, resourceId } = await seedEnterprise();
    const adminId = (await db.selectFrom("admin_user").select("id")
      .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow()).id;
    await db.insertInto("provider_finance_runtime_state").values({ enterprise_id: enterpriseId,
      strict_writes_enabled: true, activated_at: new Date(), activated_by_admin_user_id: adminId });
    const activeRepo = new OperatingBillRepository(db, "ACTIVE");
    const closed = await activeRepo.closeMonth({ enterpriseId, adminId, month: MONTH,
      allowIncomplete: true, note: "WP2 奇偶校验冻结" });
    expect(closed.status).toBe("CLOSED");
    const frozenAmounts = billAmounts(closed);
    expect(frozenAmounts.apiCost).toBe(KNOWN_CNY);

    // 冻结后修改账本计价事实（生产只读路径禁止此写，测试直接更新账本行）。
    const line = await db.selectFrom("ledger_line").select("id")
      .where("enterprise_id", "=", enterpriseId).where("api_cost", "=", "7.77")
      .executeTakeFirstOrThrow();
    await db.updateTable("ledger_line").set({ api_cost: "99.99" })
      .where("id", "=", line.id).execute();
    // 冻结后切换资金模式（strict_writes 关）再读取：已关账月份永远返回冻结版本。
    await db.updateTable("provider_finance_runtime_state")
      .set({ strict_writes_enabled: false }).where("enterprise_id", "=", enterpriseId).execute();
    const reopenedRead = await new OperatingBillRepository(db, "OFF").getBill(enterpriseId, MONTH);
    expect(reopenedRead.status).toBe("CLOSED");
    expect(billAmounts(reopenedRead)).toEqual(frozenAmounts);
    const offModeRead = await new OperatingBillRepository(db, "OFF").getBill(enterpriseId, MONTH);
    expect(billAmounts(offModeRead)).toEqual(frozenAmounts);
    expect(reopenedRead.providers.find((row) => row.providerResourceId === resourceId)?.apiCost)
      .toBe(KNOWN_CNY);
  });

  // AT-ACE-06 / G5（acceptance-plan §5：只改变官方余额不增加消费，再读估算——
  // 仟流费用估算不增加，系统不以余额差补造用量或费用）：同一消费窗口先读估算基线，
  // 仅直插一条更晚的官方来源快照（source=PROVIDER_SYNC＋balance_source=PROVIDER_API、
  // 余额更小），重读估算 → amounts/completeness/gaps 逐字不变（币种金额与字符串精度
  // 完全一致）；消费事实表（ledger_line/usage_event）零新增。
  it("官方余额下降不影响估算：更晚官方快照（PROVIDER_SYNC/PROVIDER_API）插入后重读逐字不变（AT-ACE-06/G5）", async () => {
    const { enterpriseId, resourceId } = await seedEnterprise();
    const window = {
      start: new Date("2031-11-01T00:00:00.000Z"),
      end: new Date("2031-12-01T00:00:00.000Z"),
    };
    const before = await loadApiCostEstimation(db, enterpriseId, window);
    expect(before.amounts).toEqual([{ currency: "CNY", amount: KNOWN_CNY }]);
    expect(before.completeness).toBe("KNOWN_PARTIAL");
    expect(before.gaps).toEqual([{ reason: "PRICE_MISSING", count: 1 }]);

    // 平台外消费导致官方余额下降（12.34 消费 vs 官方仅剩 3.00）：只写官方快照，
    // 不写任何 ledger_line/usage_event。
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId, provider_resource_id: resourceId, version: 1,
      source: "PROVIDER_SYNC", balance_source: "PROVIDER_API",
      collected_at: new Date("2031-11-20T00:00:00.000Z"),
      currency: "CNY", current_balance: "3.00",
    }).execute();
    const snapshot = await db.selectFrom("provider_resource_operating_snapshot").selectAll()
      .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
    // 夹具自证：插入的确实是官方来源、余额更小的快照（numeric(24,8) 八位小数字面值）。
    expect([snapshot.source, snapshot.balance_source, String(snapshot.current_balance)])
      .toEqual(["PROVIDER_SYNC", "PROVIDER_API", "3.00000000"]);
    const lineCount = await db.selectFrom("ledger_line")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
    expect(lineCount.count).toBe("3"); // 仅夹具既有三条消费，无新增

    const after = await loadApiCostEstimation(db, enterpriseId, window);
    // 重读逐字不变：金额（8 位小数字符串）、完整性、缺口全部与基线一致。
    expect(after).toEqual(before);
    expect(JSON.stringify(after.amounts)).toBe(JSON.stringify(before.amounts));
    expect(JSON.stringify(after.completeness)).toBe(JSON.stringify(before.completeness));
    expect(JSON.stringify(after.gaps)).toBe(JSON.stringify(before.gaps));
  });
});
