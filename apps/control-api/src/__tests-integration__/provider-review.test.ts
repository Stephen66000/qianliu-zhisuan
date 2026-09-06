import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sql, type KyselyPlugin } from "kysely";
import { createKysely, DashboardRepository, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { loadResourceTokenUtilization, loadResourceUtilizationSnapshot } from "../resource-insights/token-utilization.js";
import { listResourceUtilization } from "../resource-insights/query.js";
import { buildControlApi } from "../server.js";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const enterpriseId = randomUUID();
const principalId = randomUUID();
const keyId = randomUUID();
const now = new Date("2026-09-05T04:00:00Z");
let providerId: string;

beforeAll(async () => {
  pg = await startPostgresContainer("provider_review");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "资源复盘", timezone: "Asia/Shanghai" }).execute();
  await db.insertInto("admin_user").values({ enterprise_id: enterpriseId, username: "provider-review-admin",
    password_hash: await hashPassword("provider-review-test-password"), status: "ACTIVE" }).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "测试主体" }).execute();
  await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "review", key_digest: randomUUID(), status: "ACTIVE" }).execute();
  const provider = await db.insertInto("provider").values({ enterprise_id: enterpriseId,
    code: "deepseek", name: "DeepSeek", adapter_type: "openai" }).returning("id").executeTakeFirstOrThrow();
  providerId = provider.id;
}, 120_000);

afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function resource(mode: "API" | "CODING_PLAN" = "API", createdAt = "2026-05-31T16:00:00Z") {
  return db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: providerId,
    name: randomUUID(), mode, credential_type: "API_KEY", status: "ACTIVE", created_at: new Date(createdAt),
  }).returning(["id", "mode"]).executeTakeFirstOrThrow();
}

async function line(target: { id: string; mode: "API" | "CODING_PLAN" }, tokens: bigint,
  at: string, createdAt = at) {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({ id: requestId, enterprise_id: enterpriseId,
    principal_id: principalId, principal_key_id: keyId, protocol: "chat", unified_model: "review",
    status: "SUCCEEDED", started_at: new Date(createdAt), finished_at: new Date(at) }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({ enterprise_id: enterpriseId,
    ai_request_id: requestId, attempt_no: 1, provider_resource_id: target.id, upstream_model: "review",
    http_status: 200, response_committed: true, finished_at: new Date(at) }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({ enterprise_id: enterpriseId,
    ai_request_id: requestId, upstream_attempt_id: attempt.id, provider_resource_id: target.id,
    input_tokens: tokens - 1n, output_tokens: 1n, cache_tokens: 2n, reasoning_tokens: 1n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: randomUUID() }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({ enterprise_id: enterpriseId, ai_request_id: requestId,
    upstream_attempt_id: attempt.id, usage_event_id: usage.id, provider_resource_id: target.id,
    principal_id: principalId, resource_mode: target.mode, raw_input_tokens: tokens - 1n,
    raw_output_tokens: 1n, raw_cache_tokens: 2n, raw_reasoning_tokens: 1n,
    usage_quality: "PROVIDER_REPORTED", api_cost: target.mode === "API" ? "1" : null,
    deducted_quota: null, created_at: new Date(createdAt), settled_at: new Date(at) }).execute();
}

it("API 和套餐一次批量聚合四个月真实 Token，旧扣减和预算不参与计算", async () => {
  const api = await resource();
  const plan = await resource("CODING_PLAN");
  for (const target of [api, plan]) {
    await line(target, 8000000n, "2026-06-02T00:00:00Z");
    await line(target, 10000000n, "2026-07-02T00:00:00Z");
    await line(target, 12000000n, "2026-08-02T00:00:00Z");
    await line(target, 9000000n, "2026-09-02T00:00:00Z");
  }
  const facts = await loadResourceTokenUtilization(db, enterpriseId, "2026-09", now);
  for (const target of [api, plan]) expect(facts.get(target.id)).toEqual({
    currentMonthTokens: "9000000", trailingThreeMonthAverageTokens: "10000000.00000000",
    baselineMonths: ["2026-06", "2026-07", "2026-08"], baselineMonthCount: 3,
    rate: "0.90000000", basis: "CURRENT_MONTH_VS_UP_TO_3_COMPLETE_MONTHS", unavailableReason: null,
  });
});

it("企业自然月及结算边界准确；当前月仅计算截止当前的记录", async () => {
  const target = await resource();
  await line(target, 999n, "2026-05-31T15:59:59.999Z"); // 基线之前
  await line(target, 30n, "2026-05-31T16:00:00Z");
  await line(target, 60n, "2026-08-31T15:59:59.999Z");
  await line(target, 40n, "2026-08-31T16:00:00Z", "2026-08-31T15:59:59Z");
  await line(target, 20n, "2026-09-05T04:00:00Z");
  await line(target, 888n, "2026-09-05T04:00:00.001Z"); // 尚未结算
  await line(target, 777n, "2026-09-30T16:00:00Z"); // 下个月
  const facts = await loadResourceTokenUtilization(db, enterpriseId, "2026-09", now);
  expect(facts.get(target.id)).toMatchObject({ currentMonthTokens: "60",
    trailingThreeMonthAverageTokens: "30.00000000", rate: "2.00000000" });
  const history = await loadResourceTokenUtilization(db, enterpriseId, "2026-08", now);
  expect(history.get(target.id)?.currentMonthTokens).toBe("60");
});

it("按可用的一个或两个完整月计算，零用量月计入均值", async () => {
  const idleMonth = await resource();
  await line(idleMonth, 300n, "2026-07-02T00:00:00Z");
  const oneMonth = await resource("API", "2026-07-29T00:00:00Z");
  await line(oneMonth, 900n, "2026-07-30T00:00:00Z"); // 注册月不完整，不进入分母
  await line(oneMonth, 300n, "2026-08-02T00:00:00Z");
  await line(oneMonth, 150n, "2026-09-02T00:00:00Z");
  const twoMonths = await resource("CODING_PLAN", "2026-06-02T00:00:00Z");
  await line(twoMonths, 300n, "2026-07-02T00:00:00Z");
  await line(twoMonths, 300n, "2026-09-02T00:00:00Z");
  const facts = await loadResourceTokenUtilization(db, enterpriseId, "2026-09", now);
  expect(facts.get(idleMonth.id)).toMatchObject({ rate: "0.00000000",
    trailingThreeMonthAverageTokens: "100.00000000", unavailableReason: null });
  expect(facts.get(oneMonth.id)).toMatchObject({ baselineMonths: ["2026-08"], baselineMonthCount: 1,
    trailingThreeMonthAverageTokens: "300.00000000", rate: "0.50000000", unavailableReason: null });
  expect(facts.get(twoMonths.id)).toMatchObject({ baselineMonths: ["2026-07", "2026-08"], baselineMonthCount: 2,
    trailingThreeMonthAverageTokens: "150.00000000", rate: "2.00000000", unavailableReason: null });
});

it("没有完整历史月或可用历史月均为零时才不计算", async () => {
  const noFullMonth = await resource("API", "2026-09-01T00:00:00Z");
  const zeroBaseline = await resource("CODING_PLAN", "2026-07-29T00:00:00Z");
  const facts = await loadResourceTokenUtilization(db, enterpriseId, "2026-09", now);
  expect(facts.get(noFullMonth.id)).toMatchObject({ baselineMonths: [], baselineMonthCount: 0,
    trailingThreeMonthAverageTokens: null, rate: null, unavailableReason: "INSUFFICIENT_HISTORY" });
  expect(facts.get(zeroBaseline.id)).toMatchObject({ baselineMonths: ["2026-08"], baselineMonthCount: 1,
    trailingThreeMonthAverageTokens: "0.00000000", rate: null, unavailableReason: "ZERO_BASELINE" });
});

it("不同企业时区与年度切换、租户隔离", async () => {
  const other = randomUUID();
  await db.insertInto("enterprise").values({ id: other, name: "隔离企业", timezone: "America/New_York" }).execute();
  try {
    expect((await loadResourceTokenUtilization(db, other, "2026-09", now)).size).toBe(0);
  } finally { await db.deleteFrom("enterprise").where("id", "=", other).execute(); }
  const target = await resource("API", "2025-09-01T00:00:00Z");
  await line(target, 90n, "2026-01-01T02:00:00Z"); // 纽约12月，上海1月
  await line(target, 30n, "2026-01-01T05:00:00Z");
  await db.updateTable("enterprise").set({ timezone: "America/New_York" }).where("id", "=", enterpriseId).execute();
  try {
    const facts = await loadResourceTokenUtilization(db, enterpriseId, "2026-01", now);
    expect(facts.get(target.id)).toMatchObject({ baselineMonths: ["2025-10", "2025-11", "2025-12"],
      currentMonthTokens: "30", trailingThreeMonthAverageTokens: "30.00000000", rate: "1.00000000" });
    const snapshot = await loadResourceUtilizationSnapshot(db, enterpriseId, "2026-01", now);
    expect(snapshot.resources.find((row) => row.resourceId === target.id)?.tokenUtilization)
      .toEqual(facts.get(target.id));
  } finally {
    await db.updateTable("enterprise").set({ timezone: "Asia/Shanghai" }).where("id", "=", enterpriseId).execute();
  }
});

it("DeepSeek 厂商池按主体去重，排除失效 Grant，兼容仅有型号授权的主体", async () => {
  const target = await resource();
  const model = await db.insertInto("unified_model").values({ enterprise_id: enterpriseId,
    alias: "ql-review", display_name: "Review" }).returning("id").executeTakeFirstOrThrow();
  // 多条路由不能令同一份额度翻倍。
  for (const r of [target, await resource()]) await db.insertInto("model_route").values({
    enterprise_id: enterpriseId, unified_model_id: model.id, provider_resource_id: r.id, upstream_model: "review",
  }).execute();
  async function grant(quota: bigint, pool: boolean, principal = randomUUID(),
    status = "ACTIVE", from = "2026-01-01T00:00:00Z", until: string | null = null) {
    await db.insertInto("principal").values({ id: principal, enterprise_id: enterpriseId,
      type: "EMPLOYEE", name: randomUUID() }).onConflict((oc) => oc.doNothing()).execute();
    await db.insertInto("principal_grant").values({ enterprise_id: enterpriseId, principal_id: principal,
      provider: "deepseek", model_alias: pool ? "*" : "ql-review", pool_model_alias: pool ? "*" : null,
      quota_value: quota, status, valid_from: new Date(from), valid_until: until ? new Date(until) : null,
    }).execute();
    return principal;
  }
  const shared = await grant(1000n, true);
  await grant(9000n, false, shared); // 已被厂商池覆盖
  await grant(2000n, true);
  await grant(300n, false); // 仅历史型号授权
  await grant(9000n, true, undefined, "DISABLED");
  await grant(9000n, true, undefined, "ARCHIVED");
  const expired = await grant(9000n, true, undefined, "ACTIVE", "2026-01-01T00:00:00Z", now.toISOString());
  await grant(400n, false, expired); // 过期池不能遮蔽仍有效的历史授权
  await grant(9000n, true, undefined, "ACTIVE", "2026-09-06T00:00:00Z");
  const overview = await new DashboardRepository(db).getResourceUsageOverview(enterpriseId, now.getTime());
  expect(overview.providerSummaries.find((row) => row.providerCode === "deepseek" && row.mode === "API")?.allocatedQuota).toBe("3700");
});

async function readUtilization(queryDb = db) {
  const app = buildControlApi(queryDb);
  try {
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login",
      payload: { username: "provider-review-admin", password: "provider-review-test-password" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"];
    if (!cookie) throw new Error("missing login cookie");
    return await app.inject({ method: "GET", url: "/provider-resources/utilization?month=2026-09",
      headers: { cookie: (Array.isArray(cookie) ? cookie[0]! : cookie).split(";")[0]! } });
  } finally { await app.close(); }
}

interface UtilizationBody {
  generatedAt: string;
  resources: Array<{ resourceId: string; realTokens: string; requestCount: number;
    tokenUtilization: { currentMonthTokens: string; rate: string | null } }>;
}

it("CQA-01：真实接口主表 Token 与分子统一截止当前，采购复盘旧读取不变", async () => {
  const targets = [await resource(), await resource("CODING_PLAN")];
  for (const target of targets) {
    await line(target, 300n, "2026-06-02T00:00:00Z");
    await line(target, 100n, "2026-09-02T00:00:00Z");
    await line(target, 900n, "2026-09-20T00:00:00Z");
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  try {
    const response = await readUtilization();
    expect(response.statusCode).toBe(200);
    const body = response.json<UtilizationBody>();
    expect(body.generatedAt).toBe(now.toISOString());
    for (const target of targets) expect(body.resources.find((row) => row.resourceId === target.id))
      .toMatchObject({ realTokens: "100", requestCount: 1,
        tokenUtilization: { currentMonthTokens: "100", rate: "1.00000000" } });
    const legacy = await listResourceUtilization(db, enterpriseId, "2026-09");
    for (const target of targets) expect(legacy.find((row) => row.resourceId === target.id)?.realTokens).toBe("1000");
  } finally { vi.useRealTimers(); }
});

it("CQA-01：并发提交的结算和新资源在下一次响应一起出现", async () => {
  const target = await resource();
  await line(target, 300n, "2026-06-02T00:00:00Z");
  await line(target, 100n, "2026-09-02T00:00:00Z");
  let injected = false;
  let addedResource: string | undefined;
  const interleave: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      // Pause after the real old-metrics SELECT; commit via a separate connection before the new SELECT.
      if (!injected && result.rows.some((row) => row.resource_id === target.id && "real_tokens" in row)) {
        injected = true;
        await line(target, 900n, "2026-09-03T00:00:00Z");
        addedResource = (await resource()).id;
      }
      return result;
    },
  };
  const first = await readUtilization(db.withPlugin(interleave));
  expect(first.statusCode).toBe(200);
  expect(injected).toBe(true);
  const body = first.json<UtilizationBody>();
  expect(body.resources.find((row) => row.resourceId === target.id))
    .toMatchObject({ realTokens: "100", tokenUtilization: { currentMonthTokens: "100" } });
  expect(body.resources.some((row) => row.resourceId === addedResource)).toBe(false);
  const second = await readUtilization();
  expect(second.statusCode).toBe(200);
  const refreshed = second.json<UtilizationBody>();
  expect(refreshed.resources.find((row) => row.resourceId === target.id))
    .toMatchObject({ realTokens: "1000", tokenUtilization: { currentMonthTokens: "1000" } });
  expect(refreshed.resources.find((row) => row.resourceId === addedResource))
    .toMatchObject({ realTokens: "0", tokenUtilization: { currentMonthTokens: "0" } });
});

it("CQA-01：聚合结果缺失时失败关闭并结束事务，后续请求仍可成功", async () => {
  let faultInjected = false;
  const missingResult: KyselyPlugin = {
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      // Fault injection at the database result boundary; the SQL itself still executes against PG17.
      if (result.rows.some((row) => "baseline_months" in row)) {
        faultInjected = true;
        return { ...result, rows: [] };
      }
      return result;
    },
  };
  const failed = await readUtilization(db.withPlugin(missingResult));
  expect(faultInjected).toBe(true);
  expect(failed.statusCode).toBe(500);
  expect(failed.json()).not.toHaveProperty("resources");
  const transactions = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity
    WHERE datname = current_database() AND state LIKE 'idle in transaction%'`.execute(db);
  expect(transactions.rows[0]?.count).toBe("0");
  const recovered = await readUtilization();
  expect(recovered.statusCode).toBe(200);
  for (const row of recovered.json<UtilizationBody>().resources) {
    expect(row.realTokens).toBe(row.tokenUtilization.currentMonthTokens);
  }
});

it.each([
  ["API", "2026-05-31T16:00:00Z", 3],
  ["CODING_PLAN", "2026-05-31T16:00:00Z", 3],
  ["API", "2026-06-02T00:00:00Z", 2],
  ["CODING_PLAN", "2026-06-02T00:00:00Z", 2],
  ["API", "2026-07-29T00:00:00Z", 1],
  ["CODING_PLAN", "2026-07-29T00:00:00Z", 1],
  ["API", "2026-09-01T00:00:00Z", 0],
  ["CODING_PLAN", "2026-09-01T00:00:00Z", 0],
] as const)("%s 自 %s 起复用本月汇总，%i 个基线月与独立四月聚合完全一致", async (mode, createdAt, months) => {
  const target = await resource(mode, createdAt);
  await line(target, 100n, "2026-06-02T00:00:00Z");
  await line(target, 200n, "2026-07-02T00:00:00Z");
  await line(target, 300n, "2026-08-02T00:00:00Z");
  await line(target, 7n, "2026-08-31T16:00:00Z", "2026-08-31T15:59:59Z");
  await line(target, 9007199254740993n, "2026-09-02T00:00:00Z");
  await line(target, 1n, now.toISOString());
  await line(target, 999n, "2026-09-05T04:00:00.001Z");
  for (const month of ["2026-08", "2026-09"]) {
    const reference = await loadResourceTokenUtilization(db, enterpriseId, month, now);
    const snapshot = await loadResourceUtilizationSnapshot(db, enterpriseId, month, now);
    const row = snapshot.resources.find((item) => item.resourceId === target.id)!;
    expect(row.tokenUtilization).toEqual(reference.get(target.id));
    expect(row.realTokens).toBe(month === "2026-09" ? "9007199254741001" : "300");
    expect(row.tokenUtilization.currentMonthTokens).toBe(row.realTokens);
    if (month === "2026-09") expect(row.tokenUtilization.baselineMonthCount).toBe(months);
  }
});
