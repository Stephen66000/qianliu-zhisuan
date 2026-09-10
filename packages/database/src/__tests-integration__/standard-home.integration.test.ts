import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  createKysely,
  getStandardHomeSummary,
  loadStandardHomeResources,
  loadWindowBridgeCosts,
  loadWindowOperatingFinance,
  migrateToLatest,
  OperatingBillRepository,
  previousEmployeeWindow,
  type Database,
  type OperatingBillSnapshot,
} from "../index.js";

/**
 * 标准版首页聚合集成测试（HOME-STANDARD-20260910 WP02）。
 *
 * 固定时钟 asOf = 2026-09-10T06:00:00Z（北京 14:00）：
 *   - 当前上海自然月 = 2026-09-01 00:00 ~ 10-01 00:00（北京时间）；
 *   - 上月同期窗 = 2026-08-01 00:00 ~ 2026-08-10 14:00（北京时间）。
 * 覆盖 AC02/AC03/AC04：Token 只算 SUCCEEDED 行（失败行不进 Token 但进项目账）；
 * 同期排除 8 月 20 日窗外行；局部异常 + 同步失败分别呈现。
 */
describe.sequential("标准版首页聚合（getStandardHomeSummary）", () => {
  let pg: PostgresTestInstance;
  let db: Database;
  const enterpriseId = randomUUID();
  const employeeA = randomUUID();
  const employeeB = randomUUID();
  const projectP = randomUUID();
  const keyA = randomUUID();
  const keyB = randomUUID();
  const adminId = randomUUID();
  const asOf = new Date("2026-09-10T06:00:00.000Z");

  beforeAll(async () => {
    pg = await startPostgresContainer("standard_home_c1");
    db = createKysely(pg.connectionString);
    await migrateToLatest(db);
    await db.insertInto("enterprise").values({
      id: enterpriseId, name: "标准版首页", timezone: "Asia/Shanghai",
    }).execute();
    await db.insertInto("admin_user").values({
      id: adminId, enterprise_id: enterpriseId, username: "home-admin",
      password_hash: "test-only",
    }).execute();
    await db.insertInto("principal").values([
      { id: employeeA, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工甲" },
      { id: employeeB, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工乙" },
      { id: projectP, enterprise_id: enterpriseId, type: "PROJECT", name: "项目丙" },
    ]).execute();
    await db.insertInto("principal_key").values([
      {
        id: keyA, enterprise_id: enterpriseId, principal_id: employeeA,
        key_prefix: "home_a", key_digest: randomUUID(), status: "ACTIVE",
      },
      {
        id: keyB, enterprise_id: enterpriseId, principal_id: employeeB,
        key_prefix: "home_b", key_digest: randomUUID(), status: "ACTIVE",
      },
    ]).execute();
  }, 120_000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (pg) await pg.stop();
  }, 60_000);

  /** 建厂商资源；返回资源 ID。 */
  async function createResource(input: {
    providerCode: string; providerName: string; name: string;
    mode: "API" | "CODING_PLAN"; status?: string;
  }): Promise<{ providerId: string; resourceId: string }> {
    let providerId: string | undefined;
    const existing = await db.selectFrom("provider")
      .where("enterprise_id", "=", enterpriseId)
      .where("code", "=", input.providerCode)
      .select("id")
      .executeTakeFirst();
    providerId = existing?.id ?? (await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: input.providerCode, name: input.providerName,
      adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow()).id;
    const resource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: providerId, name: input.name,
      mode: input.mode, credential_type: "API_KEY", status: input.status ?? "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    return { providerId: providerId!, resourceId: resource.id };
  }

  interface LineInput {
    principalId: string; keyId: string; resourceId: string;
    mode?: "API" | "CODING_PLAN";
    at: Date;
    input: bigint; output: bigint;
    requestStatus?: "SUCCEEDED" | "FAILED";
    settled?: boolean;
    projectId?: string;
    usageQuality?: string;
    apiCost?: string | null;
    apiCostStatus?: "PRICED_USAGE" | "UNKNOWN_COST" | null;
  }

  /** 写入 ai_request + upstream_attempt + usage_event + ledger_line（+可选 ledger_transaction）。 */
  async function addLine(input: LineInput): Promise<string> {
    const requestId = randomUUID();
    await db.insertInto("ai_request").values({
      id: requestId, enterprise_id: enterpriseId, principal_id: input.principalId,
      principal_key_id: input.keyId, protocol: "chat", unified_model: "home-model",
      status: input.requestStatus ?? "SUCCEEDED", started_at: input.at, finished_at: input.at,
    }).execute();
    const attempt = await db.insertInto("upstream_attempt").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
      provider_resource_id: input.resourceId, upstream_model: "home-upstream",
      finished_at: input.at, http_status: input.requestStatus === "FAILED" ? 500 : 200,
      response_committed: input.requestStatus !== "FAILED",
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
      provider_resource_id: input.resourceId, input_tokens: input.input,
      output_tokens: input.output, cache_tokens: 0n, reasoning_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: `home-${requestId}`, created_at: input.at,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
      upstream_attempt_id: attempt.id, provider_resource_id: input.resourceId,
      principal_id: input.principalId, resource_mode: input.mode ?? "API",
      raw_input_tokens: input.input, raw_output_tokens: input.output,
      raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, deducted_quota: null,
      api_cost: input.apiCost ?? null,
      api_cost_currency: input.apiCost !== undefined && input.apiCost !== null ? "CNY" : null,
      api_cost_status: input.apiCostStatus ?? (input.apiCost ? "PRICED_USAGE" : null),
      usage_quality: input.usageQuality ?? "PROVIDER_REPORTED", created_at: input.at,
      settled_at: input.settled === false ? null : input.at,
    }).execute();
    if (input.projectId) {
      await db.insertInto("operating_bill_request_project_assignment").values({
        enterprise_id: enterpriseId, ai_request_id: requestId,
        project_principal_id: input.projectId, assigned_by: adminId, reason: "测试归属",
      }).execute();
    }
    return requestId;
  }

  /** 写入 ledger_transaction（用量概览口径事实）。 */
  async function addTransaction(input: {
    requestId: string; principalId: string; at: Date;
    status?: "SETTLED" | "PENDING";
    requestStatus?: "SUCCEEDED" | "FAILED";
  }): Promise<void> {
    if (input.requestStatus === "FAILED") {
      await db.updateTable("ai_request").set({ status: "FAILED" })
        .where("id", "=", input.requestId).execute();
    }
    await db.insertInto("ledger_transaction").values({
      ai_request_id: input.requestId, enterprise_id: enterpriseId,
      principal_id: input.principalId, usage_quality: "PROVIDER_REPORTED",
      status: input.status ?? "SETTLED", created_at: input.at,
    }).execute();
  }

  it("四指标、同期窗口与资源区聚合按口径返回", async () => {
    const zhipu = await createResource({
      providerCode: "zhipu", providerName: "智谱", name: "智谱 Coding Plan", mode: "CODING_PLAN",
    });
    const zhipu2 = await createResource({
      providerCode: "zhipu", providerName: "智谱", name: "智谱 Coding Plan 2", mode: "CODING_PLAN",
    });
    const openaiOk = await createResource({
      providerCode: "openai", providerName: "OpenAI", name: "OpenAI API 主", mode: "API",
    });
    const openaiBad = await createResource({
      providerCode: "openai", providerName: "OpenAI", name: "OpenAI API 备",
      mode: "API", status: "CREDENTIAL_INVALID",
    });

    // —— 当月（北京 2026-09）——
    const r1 = await addLine({
      principalId: employeeA, keyId: keyA, resourceId: zhipu.resourceId,
      mode: "CODING_PLAN", at: new Date("2026-09-05T03:00:00Z"),
      input: 100n, output: 50n, projectId: projectP,
    });
    await addTransaction({
      requestId: r1, principalId: employeeA, at: new Date("2026-09-05T03:00:00Z"),
    });
    const r2 = await addLine({
      principalId: employeeA, keyId: keyA, resourceId: openaiOk.resourceId,
      at: new Date("2026-09-08T02:00:00Z"), input: 30n, output: 20n, projectId: projectP,
    });
    await addTransaction({
      requestId: r2, principalId: employeeA, at: new Date("2026-09-08T02:00:00Z"),
    });
    // 失败但确有消耗的请求：不进 Token（SUCCEEDED 过滤），但进项目账（不筛状态）。
    const r3 = await addLine({
      principalId: employeeB, keyId: keyB, resourceId: openaiOk.resourceId,
      at: new Date("2026-09-09T02:00:00Z"), input: 40n, output: 40n,
      requestStatus: "FAILED", projectId: projectP,
    });
    await addTransaction({
      requestId: r3, principalId: employeeB, at: new Date("2026-09-09T02:00:00Z"),
      requestStatus: "FAILED",
    });

    // —— 上月同期窗内（北京 2026-08-01 ~ 08-10 14:00）——
    const r4 = await addLine({
      principalId: employeeA, keyId: keyA, resourceId: zhipu.resourceId,
      mode: "CODING_PLAN", at: new Date("2026-08-05T03:00:00Z"),
      input: 80n, output: 20n, projectId: projectP,
    });
    await addTransaction({
      requestId: r4, principalId: employeeA, at: new Date("2026-08-05T03:00:00Z"),
    });
    // 上月同期窗之后（8 月 20 日）：不得进入同期。
    await addLine({
      principalId: employeeA, keyId: keyA, resourceId: zhipu.resourceId,
      mode: "CODING_PLAN", at: new Date("2026-08-20T03:00:00Z"),
      input: 500n, output: 500n,
    });

    // —— 经营同步状态：智谱成功；OpenAI 失败 ——
    await db.insertInto("provider_resource_operating_sync_attempt").values([
      {
        enterprise_id: enterpriseId, provider_resource_id: zhipu.resourceId,
        sync_day: new Date("2026-09-10T00:00:00Z"), balance_status: "SUCCESS",
        cost_status: "SUCCESS", snapshot_id: null, provider_data_at: new Date("2026-09-10T05:00:00Z"),
        started_at: new Date("2026-09-10T05:00:00Z"), completed_at: new Date("2026-09-10T05:05:00Z"),
        next_sync_at: new Date("2026-09-11T05:00:00Z"), error_code: null,
        failure_reason: null, adapter_version: "test",
      },
      {
        enterprise_id: enterpriseId, provider_resource_id: zhipu2.resourceId,
        sync_day: new Date("2026-09-10T00:00:00Z"), balance_status: "SUCCESS",
        cost_status: "SUCCESS", snapshot_id: null, provider_data_at: new Date("2026-09-10T05:00:00Z"),
        started_at: new Date("2026-09-10T05:00:00Z"), completed_at: new Date("2026-09-10T05:05:00Z"),
        next_sync_at: new Date("2026-09-11T05:00:00Z"), error_code: null,
        failure_reason: null, adapter_version: "test",
      },
      {
        enterprise_id: enterpriseId, provider_resource_id: openaiOk.resourceId,
        sync_day: new Date("2026-09-10T00:00:00Z"), balance_status: "FAILED",
        cost_status: "SUCCESS", snapshot_id: null, provider_data_at: null,
        started_at: new Date("2026-09-10T05:00:00Z"), completed_at: new Date("2026-09-10T05:05:00Z"),
        next_sync_at: new Date("2026-09-11T05:00:00Z"), error_code: "UPSTREAM_TIMEOUT",
        failure_reason: "超时", adapter_version: "test",
      },
    ]).execute();
    // 凭证失效资源的状态迁移事件（reason 取最新一条）
    await db.insertInto("resource_status_event").values({
      enterprise_id: enterpriseId, provider_resource_id: openaiBad.resourceId,
      from_status: "ACTIVE", to_status: "CREDENTIAL_INVALID", reason: "CREDENTIAL_REJECTED",
      actor: "SYSTEM", time_reliable: true, created_at: new Date("2026-09-09T00:00:00Z"),
    }).execute();

    const bill = await new OperatingBillRepository(db).getBill(enterpriseId, "2026-09");
    const summary = await getStandardHomeSummary(db, {
      enterpriseId, asOf, bill, financeRead: false,
    });

    // Token：当月 SUCCEEDED 合计 = (100+50) + (30+20) = 200；失败行 80 不计入。
    expect(summary.tokenUsage.current.totalTokens).toBe("200");
    expect(summary.tokenUsage.current.inputTokens).toBe("130");
    expect(summary.tokenUsage.current.outputTokens).toBe("70");
    expect(summary.tokenUsage.current.usageQuality).toBe("EXACT");
    expect(summary.tokenUsage.rangeStart).toBe("2026-08-31T16:00:00.000Z");
    expect(summary.tokenUsage.previous.totalTokens).toBe("100");
    expect(summary.tokenUsage.previous.window.rangeStart).toBe("2026-07-31T16:00:00.000Z");
    expect(summary.tokenUsage.previous.window.rangeEndExclusive).toBe("2026-08-10T06:00:00.000Z");
    expect(summary.tokenUsage.previous.window.truncated).toBe(false);

    // 费用：经营账单同源（余额桥接口径，fixture 无余额快照 → 已知部分为空并给出原因）。
    expect(summary.monthlyCost.month).toBe("2026-09");
    expect(summary.monthlyCost.billStatus).toBe("DRAFT");
    expect(summary.monthlyCost.previous?.basis).toBe("BALANCE_BRIDGE");
    expect(summary.monthlyCost.previous?.window.rangeEndExclusive).toBe("2026-08-10T06:00:00.000Z");

    // 活跃员工：用量概览口径 = 当月 SETTLED + SUCCEEDED 去重主体 = 员工甲（乙的失败请求不入）。
    expect(summary.activeEmployees.current).toBe(1);
    expect(summary.activeEmployees.timezone).toBe("Asia/Shanghai");
    expect(summary.activeEmployees.previous.count).toBe(1);
    expect(summary.activeEmployees.previous.window.truncated).toBe(false);

    // 活跃项目：经营口径（不筛状态）= 项目丙（含乙的失败消耗行）。
    expect(summary.activeProjects.current).toBe(1);
    expect(summary.activeProjects.previous.count).toBe(1);

    // 资源区：2 家厂商 4 项资源；OpenAI 局部异常（1/2 异常）+ 凭证失效关注信息；智谱正常。
    expect(summary.resources.providerCount).toBe(2);
    expect(summary.resources.resourceCount).toBe(4);
    const openai = summary.resources.providers.find((row) => row.providerCode === "openai");
    const zhipuRow = summary.resources.providers.find((row) => row.providerCode === "zhipu");
    expect(openai?.statusCategory).toBe("PARTIAL_ABNORMAL");
    expect(openai?.worstStatus).toBe("CREDENTIAL_INVALID");
    expect(openai?.abnormalResourceCount).toBe(1);
    expect(openai?.attention).toContain("凭证失效");
    expect(openai?.attention).toContain("需要更新凭证");
    expect(openai?.modes).toEqual([{ mode: "API", count: 2 }]);
    expect(zhipuRow?.statusCategory).toBe("NORMAL");
    expect(zhipuRow?.statusLabel).toBe("正常");
    expect(zhipuRow?.modes).toEqual([{ mode: "CODING_PLAN", count: 2 }]);
    expect(summary.resources.attentionProviderCount).toBe(1);
    expect(summary.resources.updatedAt).not.toBeNull();
  });

  it("上月无对应日（asOf=3 月 30 日）时同期窗口截止上月月末并标记截断", async () => {
    const summary = await getStandardHomeSummary(db, {
      enterpriseId, asOf: new Date("2026-03-30T06:00:00.000Z"),
      bill: await new OperatingBillRepository(db).getBill(enterpriseId, "2026-03"),
      financeRead: false,
    });
    expect(summary.tokenUsage.previous.window.truncated).toBe(true);
    expect(summary.tokenUsage.previous.window.rangeStart).toBe("2026-01-31T16:00:00.000Z");
    expect(summary.tokenUsage.previous.window.rangeEndExclusive).toBe("2026-02-28T16:00:00.000Z");
    expect(summary.activeEmployees.previous.window.truncated).toBe(true);
    expect(summary.activeProjects.previous.window.truncated).toBe(true);
  });

  it("R01-F03：同厂商资源同步混合新鲜度/缺失/失败不被最新同步掩盖，并给出范围", async () => {
    const freshAt = new Date(asOf.getTime() - 3_600_000);
    const staleAt = new Date("2026-09-01T05:00:00.000Z");
    const mixedFresh = await createResource({
      providerCode: "mixed-co", providerName: "混合厂商", name: "新鲜资源", mode: "API",
    });
    const mixedStale = await createResource({
      providerCode: "mixed-co", providerName: "混合厂商", name: "过期资源", mode: "API",
    });
    await createResource({
      providerCode: "mixed-co", providerName: "混合厂商", name: "未同步资源", mode: "API",
    });
    const failFresh = await createResource({
      providerCode: "mixed-fail", providerName: "失败厂商", name: "失败厂商新鲜", mode: "API",
    });
    const failBad = await createResource({
      providerCode: "mixed-fail", providerName: "失败厂商", name: "失败厂商同步失败", mode: "API",
    });
    const sync = (resourceId: string, day: Date, balance: "SUCCESS" | "FAILED",
      errorCode: string | null, completedAt: Date) => ({
      enterprise_id: enterpriseId, provider_resource_id: resourceId,
      sync_day: new Date("2026-09-10T00:00:00Z"), balance_status: balance,
      cost_status: "SUCCESS" as const, snapshot_id: null, provider_data_at: balance === "SUCCESS" ? day : null,
      started_at: day, completed_at: completedAt, next_sync_at: new Date("2026-09-11T05:00:00Z"),
      error_code: errorCode, failure_reason: null, adapter_version: "test",
    });
    await db.insertInto("provider_resource_operating_sync_attempt").values([
      sync(mixedFresh.resourceId, freshAt, "SUCCESS", null, new Date("2026-09-10T05:05:00Z")),
      sync(mixedStale.resourceId, staleAt, "SUCCESS", null, new Date("2026-09-01T05:05:00Z")),
      // mixedNoSync：不写任何同步记录
      sync(failFresh.resourceId, freshAt, "SUCCESS", null, new Date("2026-09-10T05:05:00Z")),
      sync(failBad.resourceId, freshAt, "FAILED", "AUTH_REJECTED", new Date("2026-09-10T05:05:00Z")),
    ]).execute();

    const resources = await loadStandardHomeResources(db, enterpriseId, asOf);
    const mixed = resources.providers.find((row) => row.providerCode === "mixed-co");
    const fail = resources.providers.find((row) => row.providerCode === "mixed-fail");
    expect(mixed?.syncFailed).toBe(false);
    expect(mixed?.syncStale).toBe(true);
    expect(mixed?.attention).toContain("其中 1 项资源经营数据同步超过 36 小时未成功");
    expect(mixed?.attention).toContain("其中 1 项资源尚未执行经营数据同步");
    expect(fail?.syncFailed).toBe(true);
    expect(fail?.attention).toContain("其中 1 项资源经营数据同步失败（AUTH_REJECTED）");
    expect(fail?.attention).toContain("额度与余额情况需分别确认");
  });

  it("R01-F01：资金读模型同期窗口复用权威缺口规则（已知部分保留、缺口显式）", async () => {
    const prevStart = new Date("2026-07-31T16:00:00.000Z");
    const prevEnd = new Date("2026-08-10T06:00:00.000Z");
    const inWindow = new Date("2026-08-05T03:00:00.000Z");
    const openaiOk = (await db.selectFrom("provider_resource")
      .where("enterprise_id", "=", enterpriseId)
      .where("name", "=", "OpenAI API 主")
      .select("id").executeTakeFirst())!;
    // 已知费用：窗口内 PRICED_USAGE。
    await addLine({
      principalId: employeeA, keyId: keyA, resourceId: openaiOk.id,
      at: inWindow, input: 10n, output: 5n, apiCost: "12.50", apiCostStatus: "PRICED_USAGE",
    });
    // 缺口 1：窗口内 UNKNOWN_COST。
    await addLine({
      principalId: employeeA, keyId: keyA, resourceId: openaiOk.id,
      at: inWindow, input: 7n, output: 7n, apiCost: null, apiCostStatus: "UNKNOWN_COST",
    });
    // 缺口 2：窗口内套餐采购未登记现金支出（MIGRATION 来源允许早于切换时点的历史事件）。
    const planResource = (await db.selectFrom("provider_resource")
      .where("enterprise_id", "=", enterpriseId)
      .where("name", "=", "智谱 Coding Plan")
      .select("id").executeTakeFirst())!;
    // 事件与订阅周期受 DEFERRABLE 闭合触发器约束，需在同一事务内成对写入。
    await db.transaction().execute(async (trx) => {
      const event = await trx.insertInto("provider_finance_event").values({
        enterprise_id: enterpriseId, provider_resource_id: planResource.id,
        event_type: "CODING_PLAN_PURCHASE", account_amount: "300", account_currency: "CNY",
        cash_paid_cny: null, occurred_at: inWindow, external_reference: null,
        reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: null, description: "测试采购", evidence_ref: null,
        source: "MIGRATION", idempotency_key: `home-c2-${randomUUID()}`,
        created_by_admin_user_id: adminId,
      }).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("provider_subscription_period").values({
        enterprise_id: enterpriseId, provider_resource_id: planResource.id,
        finance_event_id: event.id, product_name: "测试套餐",
        // 周期边界须为北京时间自然日零点（0059 range check）；带 finance_event_id 的周期 source 须为 PURCHASE/RENEWAL
        period_start: new Date("2026-08-04T16:00:00.000Z"),
        period_end_exclusive: new Date("2026-09-04T16:00:00.000Z"),
        source: "PURCHASE", created_by_admin_user_id: adminId,
      }).execute();
    });

    const window = await loadWindowOperatingFinance(db, enterpriseId, prevStart, prevEnd);
    expect(window.totalSpends).toEqual([{ currency: "CNY", amount: "12.50000000" }]);
    expect(window.incompleteReason).toContain("API_USAGE_COST_UNKNOWN");
    expect(window.incompleteReason).toContain("CASH_PAID_CNY_MISSING");
  });

  it("V14-C2 F-B：financeRead=true 时同期费用走资金读模型口径并透传缺口", async () => {
    // 依赖上方 R01-F01 用例已写入同期窗事实：PRICED_USAGE 12.50、UNKNOWN_COST 行、
    // 未登记现金支出的套餐采购事件。
    const summary = await getStandardHomeSummary(db, {
      enterpriseId, asOf,
      bill: await new OperatingBillRepository(db).getBill(enterpriseId, "2026-09"),
      financeRead: true,
    });
    expect(summary.monthlyCost.previous?.basis).toBe("FINANCE_READ_MODEL");
    expect(summary.monthlyCost.previous?.totalSpends)
      .toEqual([{ currency: "CNY", amount: "12.50000000" }]);
    expect(summary.monthlyCost.previous?.incompleteReason).toContain("API_USAGE_COST_UNKNOWN");
    expect(summary.monthlyCost.previous?.incompleteReason).toContain("CASH_PAID_CNY_MISSING");
    expect(summary.monthlyCost.previous?.window.rangeStart).toBe("2026-07-31T16:00:00.000Z");
    expect(summary.monthlyCost.previous?.window.truncated).toBe(false);
  });

  it("R01-F02：同期 Token 质量与未知数进入契约（分母不完整可见）", async () => {
    const zhipuRow = (await db.selectFrom("provider_resource")
      .where("enterprise_id", "=", enterpriseId)
      .where("name", "=", "智谱 Coding Plan")
      .select("id").executeTakeFirst())!;
    await addLine({
      principalId: employeeA, keyId: keyA, resourceId: zhipuRow.id,
      mode: "CODING_PLAN", at: new Date("2026-08-06T03:00:00.000Z"),
      input: 9n, output: 9n, usageQuality: "UNKNOWN",
    });
    const summary = await getStandardHomeSummary(db, {
      enterpriseId, asOf,
      bill: await new OperatingBillRepository(db).getBill(enterpriseId, "2026-09"),
      financeRead: false,
    });
    expect(summary.tokenUsage.previous.usageQuality).toBe("UNKNOWN");
    expect(summary.tokenUsage.previous.unknownCount).toBeGreaterThanOrEqual(1);
    expect(summary.tokenUsage.current.usageQuality).toBe("EXACT");
  });

  it("R01：企业时区非上海时，员工同期窗口按企业时区计算", async () => {
    const enterpriseNy = randomUUID();
    const nyEmployee = randomUUID();
    const nyKey = randomUUID();
    await db.insertInto("enterprise").values({
      id: enterpriseNy, name: "纽约时区企业", timezone: "America/New_York",
    }).execute();
    await db.insertInto("principal").values({
      id: nyEmployee, enterprise_id: enterpriseNy, type: "EMPLOYEE", name: "纽约员工",
    }).execute();
    await db.insertInto("principal_key").values({
      id: nyKey, enterprise_id: enterpriseNy, principal_id: nyEmployee,
      key_prefix: "home_ny", key_digest: randomUUID(), status: "ACTIVE",
    }).execute();
    // 2026-08-05 10:00Z = 纽约 8 月 5 日 06:00，落在纽约同期窗 [08-01 00:00, 08-10 02:00) 内。
    const at = new Date("2026-08-05T10:00:00.000Z");
    const requestId = randomUUID();
    await db.insertInto("ai_request").values({
      id: requestId, enterprise_id: enterpriseNy, principal_id: nyEmployee,
      principal_key_id: nyKey, protocol: "chat", unified_model: "home-model",
      status: "SUCCEEDED", started_at: at, finished_at: at,
    }).execute();
    await db.insertInto("ledger_transaction").values({
      ai_request_id: requestId, enterprise_id: enterpriseNy, principal_id: nyEmployee,
      usage_quality: "PROVIDER_REPORTED", status: "SETTLED", created_at: at,
    }).execute();

    const summary = await getStandardHomeSummary(db, {
      enterpriseId: enterpriseNy, asOf,
      bill: await new OperatingBillRepository(db).getBill(enterpriseNy, "2026-09"),
      financeRead: false,
    });
    expect(summary.activeEmployees.timezone).toBe("America/New_York");
    expect(summary.activeEmployees.previous.count).toBe(1);
    // 纽约 8 月 1 日 00:00 = 04:00Z；纽约 8 月 10 日 02:00（asOf 同一时刻）= 06:00Z。
    expect(summary.activeEmployees.previous.window.rangeStart).toBe("2026-08-01T04:00:00.000Z");
    expect(summary.activeEmployees.previous.window.rangeEndExclusive).toBe("2026-08-10T06:00:00.000Z");
  });

  it("V14-C4 G01：恢复待确认、额度耗尽与限流文案按状态证据呈现（状态恢复分支）", async () => {
    await createResource({
      providerCode: "ex-api", providerName: "耗尽API厂商", name: "耗尽 API", mode: "API",
      status: "EXHAUSTED",
    });
    await createResource({
      providerCode: "ex-plan", providerName: "耗尽套餐厂商", name: "耗尽套餐", mode: "CODING_PLAN",
      status: "EXHAUSTED",
    });
    await createResource({
      providerCode: "rl-co", providerName: "限流厂商", name: "限流资源", mode: "API",
      status: "RATE_LIMITED",
    });
    const recovered = await createResource({
      providerCode: "rec-co", providerName: "恢复厂商", name: "恢复资源", mode: "CODING_PLAN",
      status: "DEGRADED",
    });
    await db.insertInto("resource_status_event").values({
      enterprise_id: enterpriseId, provider_resource_id: recovered.resourceId,
      from_status: "EXHAUSTED", to_status: "DEGRADED", reason: "QUOTA_SYNC_RECOVERED",
      actor: "SYSTEM", time_reliable: true, created_at: new Date("2026-09-09T12:00:00Z"),
    }).execute();
    await createResource({
      providerCode: "mix2-co", providerName: "混合降级厂商", name: "健康资源", mode: "API",
    });
    await createResource({
      providerCode: "mix2-co", providerName: "混合降级厂商", name: "降级资源", mode: "API",
      status: "DEGRADED",
    });

    const resources = await loadStandardHomeResources(db, enterpriseId, asOf);
    const byCode = (code: string) =>
      resources.providers.find((row) => row.providerCode === code);
    const exApiRow = byCode("ex-api");
    const exPlanRow = byCode("ex-plan");
    const rlRow = byCode("rl-co");
    const recRow = byCode("rec-co");
    const mixRow = byCode("mix2-co");

    // 凭证外异常：额度耗尽按形态区分文案与处置提示
    expect(exApiRow?.statusCategory).toBe("ABNORMAL");
    expect(exApiRow?.statusLabel).toBe("余额不足");
    expect(exApiRow?.attention).toContain("余额不足，需充值后等待余额同步");
    expect(exPlanRow?.statusLabel).toBe("套餐额度耗尽");
    expect(exPlanRow?.attention).toContain("需补充套餐或等待额度重置");
    // 限流：冷却恢复提示
    expect(rlRow?.statusLabel).toBe("限流冷却");
    expect(rlRow?.attention).toContain("冷却到期后自动探测恢复");
    // 状态恢复：额度同步恢复且时间可信 → 待确认（不冒充正常，也不算调用失败）
    expect(recRow?.statusCategory).toBe("PENDING_CONFIRM");
    expect(recRow?.statusLabel).toBe("额度已恢复，待调用确认");
    // 局部降级：仍可使用
    expect(mixRow?.statusCategory).toBe("PARTIAL_ABNORMAL");
    expect(mixRow?.statusLabel).toBe("降级（仍可使用）");
    // 新增厂商计入厂商/资源总数
    expect(resources.resourceCount).toBeGreaterThanOrEqual(4 + 6);
  });

  it("V14-C4 G01/G02：余额桥接完整时有已知金额且允许比较", async () => {
    const ent = randomUUID();
    await db.insertInto("enterprise").values({ id: ent, name: "桥接完整企业" }).execute();
    const provider = await db.insertInto("provider").values({
      enterprise_id: ent, code: "bridge-ok", name: "桥接厂商", adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();
    const api = await db.insertInto("provider_resource").values({
      enterprise_id: ent, provider_id: provider.id, name: "桥接 API",
      mode: "API", credential_type: "API_KEY", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    const plan = await db.insertInto("provider_resource").values({
      enterprise_id: ent, provider_id: provider.id, name: "桥接套餐",
      mode: "CODING_PLAN", credential_type: "API_KEY", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    // 期初快照（≤ 上月月初）余额 100；期末快照（窗口内）余额 30 → API 花费 70。
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: ent, provider_resource_id: api.id, version: 1,
      source: "PROVIDER_SYNC", collected_at: new Date("2026-07-30T00:00:00Z"),
      currency: "CNY", current_balance: "100", current_period_cost: "0",
      balance_updated_at: new Date("2026-07-30T00:00:00Z"),
    }).execute();
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: ent, provider_resource_id: api.id, version: 2,
      source: "PROVIDER_SYNC", collected_at: new Date("2026-08-05T00:00:00Z"),
      currency: "CNY", current_balance: "30", current_period_cost: "0",
      balance_updated_at: new Date("2026-08-05T00:00:00Z"),
    }).execute();
    // 套餐期末快照：当月套餐费用 300。
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: ent, provider_resource_id: plan.id, version: 1,
      source: "PROVIDER_SYNC", collected_at: new Date("2026-08-05T00:00:00Z"),
      currency: "CNY", current_balance: null, current_period_cost: null,
      package_cost: "300", effective_from: new Date("2026-08-01T00:00:00Z"),
      effective_until: new Date("2026-09-01T00:00:00Z"),
      balance_updated_at: new Date("2026-08-05T00:00:00Z"),
    }).execute();

    const bridge = await loadWindowBridgeCosts(db, ent,
      new Date("2026-07-31T16:00:00.000Z"), new Date("2026-08-10T06:00:00.000Z"));
    expect(bridge.apiSpendStatus).toBe("CALCULABLE");
    expect(bridge.apiSpend).toBe("70.00000000");
    expect(bridge.totalSpends).toEqual([{ currency: "CNY", amount: "370.00000000" }]);

    const summary = await getStandardHomeSummary(db, {
      enterpriseId: ent, asOf,
      bill: await new OperatingBillRepository(db).getBill(ent, "2026-09"),
      financeRead: false,
    });
    expect(summary.monthlyCost.previous?.basis).toBe("BALANCE_BRIDGE");
    expect(summary.monthlyCost.previous?.totalSpends)
      .toEqual([{ currency: "CNY", amount: "370.00000000" }]);
    expect(summary.monthlyCost.previous?.incompleteReason).toBeNull();
  });

  it("V14-C4 G01/G02：故障注入（缺失期末快照）时透出已知套餐金额（已知部分保留）", async () => {
    const ent = randomUUID();
    await db.insertInto("enterprise").values({ id: ent, name: "桥接不完整企业" }).execute();
    const provider = await db.insertInto("provider").values({
      enterprise_id: ent, code: "bridge-bad", name: "桥接缺失厂商", adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();
    const badApi = await db.insertInto("provider_resource").values({
      enterprise_id: ent, provider_id: provider.id, name: "缺失期末 API",
      mode: "API", credential_type: "API_KEY", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    const plan = await db.insertInto("provider_resource").values({
      enterprise_id: ent, provider_id: provider.id, name: "缺失期末套餐",
      mode: "CODING_PLAN", credential_type: "API_KEY", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    // 故障注入：API 仅有期初快照，期末快照缺失（API 花费无法桥接）。
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: ent, provider_resource_id: badApi.id, version: 1,
      source: "PROVIDER_SYNC", collected_at: new Date("2026-07-30T00:00:00Z"),
      currency: "CNY", current_balance: "50", current_period_cost: "0",
      balance_updated_at: new Date("2026-07-30T00:00:00Z"),
    }).execute();
    // 套餐（如上月 Kimi 订阅）期末快照存在，套餐费用 200 为已知事实。
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: ent, provider_resource_id: plan.id, version: 1,
      source: "PROVIDER_SYNC", collected_at: new Date("2026-08-05T00:00:00Z"),
      currency: "CNY", current_balance: null, current_period_cost: null,
      package_cost: "200", effective_from: new Date("2026-08-01T00:00:00Z"),
      effective_until: new Date("2026-09-01T00:00:00Z"),
      balance_updated_at: new Date("2026-08-05T00:00:00Z"),
    }).execute();

    const bridge = await loadWindowBridgeCosts(db, ent,
      new Date("2026-07-31T16:00:00.000Z"), new Date("2026-08-10T06:00:00.000Z"));
    // 数据级故障注入断言：API 期末缺失 → ENDING_BALANCE_MISSING，已知套餐金额保留但总额不完整。
    expect(bridge.apiSpendStatus).toBe("ENDING_BALANCE_MISSING");
    expect(bridge.packageCosts).toEqual([{ currency: "CNY", amount: "200.00000000" }]);
    expect(bridge.totalSpends).toEqual([]);

    const summary = await getStandardHomeSummary(db, {
      enterpriseId: ent, asOf,
      bill: await new OperatingBillRepository(db).getBill(ent, "2026-09"),
      financeRead: false,
    });
    expect(summary.monthlyCost.previous?.basis).toBe("BALANCE_BRIDGE");
    // 已知部分保留：上月 Kimi 套餐金额透出（不再"不可完整计算"），缺期末的 API 未计入即视为
    // 无该花费事实（缺口不可凭空标记，未知金额只能由权威缺口规则识别，不能臆造）。
    expect(summary.monthlyCost.previous?.totalSpends)
      .toEqual([{ currency: "CNY", amount: "200.00000000" }]);
    expect(summary.monthlyCost.previous?.incompleteReason).toBeNull();
  });

  it("V14-C4 G01：经营账单无总额且无缺口原因时回退到跨币种提示（bill fallback）", async () => {
    const ent = randomUUID();
    await db.insertInto("enterprise").values({ id: ent, name: "账单回退企业" }).execute();
    const summary = await getStandardHomeSummary(db, {
      enterpriseId: ent, asOf,
      bill: makeBill({
        month: "2026-09",
        summary: {
          totalCost: null, apiCost: null, ledgerApiCost: null, openingBalance: null,
          monthlyRecharge: null, apiSpendStatus: "CALCULABLE", apiSpendReason: null,
          packageCost: "300.00000000", endingBalance: null, endingBalanceCurrency: null,
          openingBalances: [], rechargeAmounts: [], endingBalances: [], apiSpends: [],
          packageCosts: [{ currency: "CNY", amount: "300.00000000" }], totalSpends: [],
          planUtilization: null, activePrincipalCount: 0,
          confirmedValueAmount: "0.00000000", confirmedNonMonetaryCount: 0,
          unallocatedCost: "0.00000000",
        },
      }),
      financeRead: false,
    });
    expect(summary.monthlyCost.current.totalSpends).toEqual([]);
    expect(summary.monthlyCost.current.incompleteReason).toBe("不可跨币种合计；已知项保留");
  });

  it("V14-C4 G02b：countFinanceGaps 六缺口码正/反控制（数据级定向故障注入）", async () => {
    // 独立企业，逐码注入正控制（应计数）与反控制（不应计数）。
    const ent = randomUUID();
    await db.insertInto("enterprise").values({ id: ent, name: "缺口注入企业" }).execute();
    // 资金事件/解决记录的管理员外键要求同企业管理员。
    const admin = randomUUID();
    await db.insertInto("admin_user").values({
      id: admin, enterprise_id: ent, username: "gap-admin", password_hash: "test-only",
    }).execute();
    const provider = await db.insertInto("provider").values({
      enterprise_id: ent, code: "gap-co", name: "缺口厂商", adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();

    const mk = async (name: string, mode: "API" | "CODING_PLAN" = "API") =>
      (await db.insertInto("provider_resource").values({
        enterprise_id: ent, provider_id: provider.id, name,
        mode, credential_type: "API_KEY", status: "ACTIVE",
      }).returning("id").executeTakeFirstOrThrow()).id;
    const rUnknown = await mk("未知费用");
    const rCurrencyMissing = await mk("缺币种");
    const rCurrencyConflict = await mk("币种冲突");
    const rNoOpening = await mk("缺期初");
    const rWithOpening = await mk("有期初");
    const rNoPeriod = await mk("缺订阅周期", "CODING_PLAN");
    const rWithPeriod = await mk("有订阅周期", "CODING_PLAN");
    const rRechargeNoCash = await mk("充值未登记现金");
    const rRechargeWithCash = await mk("充值已登记现金");
    // 遗留成本解决记录的触发器要求 DeepSeek 形态资源。
    const providerDeep = await db.insertInto("provider").values({
      enterprise_id: ent, code: "deepseek", name: "缺口 DeepSeek", adapter_type: "deepseek",
    }).returning("id").executeTakeFirstOrThrow();
    const rResolved = (await db.insertInto("provider_resource").values({
      enterprise_id: ent, provider_id: providerDeep.id, name: "已解决未知费用",
      mode: "API", credential_type: "API_KEY", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow()).id;
    // API_RECHARGE 触发器要求同币种期初余额事件。
    const openingFor = (resourceId: string, key: string) => db.insertInto("provider_finance_event").values({
      enterprise_id: ent, provider_resource_id: resourceId,
      event_type: "API_OPENING_BALANCE", account_amount: "100", account_currency: "CNY",
      cash_paid_cny: null, occurred_at: new Date("2026-08-31T16:00:00.000Z"),
      external_reference: null, reversal_of_event_id: null, correction_of_event_id: null,
      reconciliation_case_id: null, description: null, evidence_ref: null,
      source: "MIGRATION", idempotency_key: `gap-${key}-${randomUUID()}`,
      created_by_admin_user_id: admin,
    }).execute();
    await openingFor(rRechargeNoCash, "nocash");
    await openingFor(rRechargeWithCash, "withcash");

    const inWin = new Date("2026-08-05T00:00:00.000Z");
    const line = async (resourceId: string, extra: {
      api_cost?: string | null; api_cost_currency?: "CNY" | "USD" | null;
      api_cost_status?: "PRICED_USAGE" | "UNKNOWN_COST" | null;
      billing_rule_snapshot?: Record<string, unknown> | null;
      subscription_period_id?: string | null;
      resolution_id?: string | null;
      mode?: "API" | "CODING_PLAN";
      settledAt?: Date;
    }, exec: Kysely<Database> = db) => {
      const requestId = randomUUID();
      const mode = extra.mode ?? "API";
      await exec.insertInto("ai_request").values({
        id: requestId, enterprise_id: ent, principal_id: employeeA,
        principal_key_id: keyA, protocol: "chat", unified_model: "gap-model",
        status: "SUCCEEDED", started_at: inWin, finished_at: inWin,
      }).execute();
      const attempt = await exec.insertInto("upstream_attempt").values({
        ai_request_id: requestId, enterprise_id: ent, attempt_no: 1,
        provider_resource_id: resourceId, upstream_model: "gap-upstream",
        finished_at: inWin, http_status: 200, response_committed: true,
      }).returning("id").executeTakeFirstOrThrow();
      const usage = await exec.insertInto("usage_event").values({
        ai_request_id: requestId, enterprise_id: ent, upstream_attempt_id: attempt.id,
        provider_resource_id: resourceId, input_tokens: 1n, output_tokens: 1n,
        cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
        dedup_key: `gap-${requestId}`, created_at: inWin,
      }).returning("id").executeTakeFirstOrThrow();
      await exec.insertInto("ledger_line").values({
        ai_request_id: requestId, enterprise_id: ent, usage_event_id: usage.id,
        upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
        principal_id: employeeA, resource_mode: mode,
        raw_input_tokens: 1n, raw_output_tokens: 1n, raw_cache_tokens: 0n,
        raw_reasoning_tokens: 0n, deducted_quota: null,
        usage_quality: "PROVIDER_REPORTED", created_at: inWin,
        settled_at: extra.settledAt ?? inWin,
        legacy_cost_resolution_id: extra.resolution_id ?? null,
        subscription_period_id: extra.subscription_period_id ?? null,
        api_cost: extra.api_cost ?? null,
        api_cost_currency: extra.api_cost_currency ?? null,
        api_cost_status: extra.api_cost_status ?? null,
        billing_rule_snapshot: extra.billing_rule_snapshot ?? null,
      }).execute();
    };

    // 正控制：各缺口码各注入一条应计数的记录。
    await line(rUnknown, { api_cost: null, api_cost_status: "UNKNOWN_COST" });
    // 遗留数据故障注入：缺币种的已计价行在 0059 形状约束下不可新写入，
    // 临时解除约束注入"迁移前遗留行"，再以 NOT VALID 重建约束（等效历史库形态）。
    await db.schema.alterTable("ledger_line")
      .dropConstraint("ledger_line_api_cost_fact_shape_check").execute();
    await line(rCurrencyMissing, {
      api_cost: "5", api_cost_currency: null, api_cost_status: "PRICED_USAGE",
    });
    await sql`ALTER TABLE ledger_line ADD CONSTRAINT
      ledger_line_api_cost_fact_shape_check CHECK (
        api_cost_status IS NULL
        OR (api_cost_status='PRICED_USAGE' AND resource_mode='API'
          AND api_cost IS NOT NULL AND api_cost_currency IS NOT NULL)
        OR (api_cost_status='CONFIRMED_ZERO_NO_UPSTREAM' AND resource_mode='API'
          AND api_cost=0 AND api_cost_currency IS NULL)
        OR (api_cost_status='UNKNOWN_COST' AND resource_mode='API'
          AND api_cost IS NULL AND api_cost_currency IS NULL)
        OR (api_cost_status='NOT_APPLICABLE' AND resource_mode='CODING_PLAN'
          AND api_cost IS NULL AND api_cost_currency IS NULL)
      ) NOT VALID`.execute(db);
    await line(rCurrencyConflict, {
      api_cost: "6", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
      billing_rule_snapshot: { currency: "USD" },
    });
    await line(rNoOpening, { api_cost: "7", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE" });
    await line(rNoPeriod, { api_cost: null, api_cost_status: null, mode: "CODING_PLAN" });

    // 反控制：同类事实但已补齐，不应计数。
    // 解决记录要求精确指向该资源的余额快照。
    // 0061 校验：快照须 PROVIDER_SYNC + PROVIDER_API 来源、币种/余额/采集时刻与记录精确一致。
    const resolvedSnap = await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: ent, provider_resource_id: rResolved, version: 1,
      source: "PROVIDER_SYNC", collected_at: new Date("2026-09-03T06:56:18.540Z"),
      currency: "CNY", current_balance: "100", current_period_cost: "0",
      balance_source: "PROVIDER_API",
      balance_updated_at: new Date("2026-09-03T06:56:18.540Z"),
    }).returning("id").executeTakeFirstOrThrow();
    // 反控制：同类事实但已补齐，不应计数。
    // 业务流程：先 OPEN 解决记录 → 调整事件回指（金额=-缺失、时点=固定截止）→ 转 RESOLVED。
    const resolution = await db.insertInto("provider_finance_legacy_cost_resolution").values({
      enterprise_id: ent, provider_resource_id: rResolved, account_currency: "CNY",
      // 0060/0061 固定窗口约束：起始锁定为迁移时点、截止锁定为解决时点。
      window_start: new Date("2026-08-31T16:00:00.000Z"),
      window_end_inclusive: new Date("2026-09-03T06:56:18.540Z"),
      provider_balance_snapshot_id: resolvedSnap.id,
      // 金额守恒：调整前余额 - 缺失费用 = 确认余额；缺失>0、未知行>0。
      provider_confirmed_balance: "100", local_balance_before_adjustment: "105",
      known_api_cost: "0", missing_api_cost: "5", unknown_line_count: 1n,
      status: "OPEN", evidence_ref: "gap-test", created_by_admin_user_id: admin,
    }).returning("id").executeTakeFirstOrThrow();
    // 闭环触发器为 DEFERRED：调整事件与解决记录互指，须同事务提交完成闭环。
    await db.transaction().execute(async (trx) => {
      const adjustment = await trx.insertInto("provider_finance_event").values({
        enterprise_id: ent, provider_resource_id: rResolved,
        event_type: "API_LEGACY_COST_ADJUSTMENT", account_amount: "-5", account_currency: "CNY",
        cash_paid_cny: null, occurred_at: new Date("2026-09-03T06:56:18.540Z"),
        external_reference: null, reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: null, description: "缺口注入调整", evidence_ref: null,
        source: "MIGRATION", idempotency_key: `gap-adj-${randomUUID()}`,
        legacy_cost_resolution_id: resolution.id,
        created_by_admin_user_id: admin,
      }).returning("id").executeTakeFirstOrThrow();
      await line(rResolved, {
        api_cost: null, api_cost_status: "UNKNOWN_COST",
        resolution_id: resolution.id,
        // 解决记录的固定窗口为 2026-08-31T16:00 ~ 09-03T06:56：行结算时点必须落在其中。
        settledAt: new Date("2026-08-31T20:00:00.000Z"),
      }, trx);
      await trx.updateTable("provider_finance_legacy_cost_resolution")
        .set({
          status: "RESOLVED", adjustment_event_id: adjustment.id,
          resolved_at: new Date("2026-08-10T06:00:00.000Z"),
        })
        .where("id", "=", resolution.id).execute();
    });
    await db.insertInto("provider_finance_event").values({
      enterprise_id: ent, provider_resource_id: rWithOpening,
      event_type: "API_OPENING_BALANCE", account_amount: "100", account_currency: "CNY",
      cash_paid_cny: null, occurred_at: new Date("2026-08-31T16:00:00.000Z"),
      external_reference: null, reversal_of_event_id: null, correction_of_event_id: null,
      reconciliation_case_id: null, description: null, evidence_ref: null,
      source: "MIGRATION", idempotency_key: `gap-opening-${randomUUID()}`,
      created_by_admin_user_id: admin,
    }).execute();
    await line(rWithOpening, { api_cost: "8", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE" });
    const period = await db.insertInto("provider_subscription_period").values({
      enterprise_id: ent, provider_resource_id: rWithPeriod,
      finance_event_id: null, product_name: "缺口套餐",
      period_start: new Date("2026-07-31T16:00:00.000Z"),
      period_end_exclusive: new Date("2026-09-30T16:00:00.000Z"),
      source: "MIGRATED_CARRYOVER", migration_source_record_id: randomUUID(),
      created_by_admin_user_id: admin,
    }).returning("id").executeTakeFirstOrThrow().then(async (row) => {
      await db.updateTable("provider_subscription_period")
        .set({ source: "MIGRATED_CARRYOVER" })
        .where("id", "=", row.id).execute();
      return row;
    });
    await line(rWithPeriod, {
      api_cost: null, api_cost_status: null, subscription_period_id: period.id,
      mode: "CODING_PLAN",
    });
    await db.insertInto("provider_finance_event").values({
      enterprise_id: ent, provider_resource_id: rRechargeWithCash,
      event_type: "API_RECHARGE", account_amount: "50", account_currency: "CNY",
      cash_paid_cny: "50", occurred_at: inWin, external_reference: null,
      reversal_of_event_id: null, correction_of_event_id: null,
      reconciliation_case_id: null, description: null, evidence_ref: null,
      source: "MIGRATION", idempotency_key: `gap-cash-${randomUUID()}`,
      created_by_admin_user_id: admin,
    }).execute();
    await db.insertInto("provider_finance_event").values({
      enterprise_id: ent, provider_resource_id: rRechargeNoCash,
      event_type: "API_RECHARGE", account_amount: "60", account_currency: "CNY",
      cash_paid_cny: null, occurred_at: inWin, external_reference: null,
      reversal_of_event_id: null, correction_of_event_id: null,
      reconciliation_case_id: null, description: null, evidence_ref: null,
      source: "MIGRATION", idempotency_key: `gap-nocash-${randomUUID()}`,
      created_by_admin_user_id: admin,
    }).execute();

    const window = await loadWindowOperatingFinance(db, ent,
      new Date("2026-07-31T16:00:00.000Z"), new Date("2026-08-10T06:00:00.000Z"));
    const reason = window.incompleteReason ?? "";
    // 正控制逐码命中
    expect(reason).toContain("API_USAGE_COST_UNKNOWN:1");
    expect(reason).toContain("API_COST_CURRENCY_MISSING:1");
    expect(reason).toContain("API_COST_CURRENCY_CONFLICT:1");
    // 币种冲突行与缺期初行均无期初事件：两条 PRICED_USAGE 行都计入该缺口。
    expect(reason).toContain("OPENING_BALANCE_MISSING:2");
    expect(reason).toContain("SUBSCRIPTION_PERIOD_MISSING:1");
    expect(reason).toContain("CASH_PAID_CNY_MISSING:1");
    // 反控制：已解决/已补齐事实不计数
    const resolvedLine = reason.match(/API_USAGE_COST_UNKNOWN:(\d+)/);
    expect(resolvedLine?.[1]).toBe("1");

    // 窗口外事实不计数：同类型 UNKNOWN_COST 行放到窗口之外。
    const outWin = await loadWindowOperatingFinance(db, ent,
      new Date("2026-06-30T16:00:00.000Z"), new Date("2026-07-30T16:00:00.000Z"));
    expect(outWin.totalSpends).toEqual([]);
    expect(outWin.incompleteReason).toBeNull();
  });

  it("V14-C4 G01：员工同期窗口在企业不存在时传播明确错误", async () => {
    await expect(previousEmployeeWindow(db, randomUUID(), asOf))
      .rejects.toMatchObject({ name: "UsageOverviewEnterpriseNotFoundError" });
  });
});

function makeBill(overrides: Partial<OperatingBillSnapshot> = {}): OperatingBillSnapshot {
  return {
    month: "2026-09",
    timezone: "Asia/Shanghai",
    periodStart: "2026-08-31T16:00:00.000Z",
    periodEnd: "2026-09-30T16:00:00.000Z",
    status: "DRAFT",
    version: 0,
    generatedAt: "2026-09-10T06:00:00.000Z",
    closedAt: null,
    closedBy: null,
    closeNote: null,
    summary: {
      totalCost: null,
      apiCost: null,
      ledgerApiCost: null,
      openingBalance: null,
      monthlyRecharge: null,
      apiSpendStatus: "CALCULABLE",
      apiSpendReason: null,
      packageCost: null,
      endingBalance: null,
      endingBalanceCurrency: null,
      openingBalances: [],
      rechargeAmounts: [],
      endingBalances: [],
      apiSpends: [],
      packageCosts: [],
      totalSpends: [],
      planUtilization: null,
      activePrincipalCount: 0,
      confirmedValueAmount: "0.00000000",
      confirmedNonMonetaryCount: 0,
      unallocatedCost: "0.00000000",
    },
    providers: [],
    subjects: [],
    values: [],
    gaps: [],
    sourceFacts: { ledgerLineCount: 0, operatingSnapshotIds: [] },
    ...overrides,
  };
}
