import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createKysely, migrateToLatest, UsageOverviewRepository } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { readEmployeeReportFacts, reportQuotaCutoff } from "../report-facts.js";
import { runCompanyWeeklyReport, runPersonalWeeklyReports } from "../report-jobs.js";
import { runEmployeeQuotaInitializationTick } from "../quota-initialization.js";
import { renderSvgToPng } from "../render-png.js";
import { quotaReconcileScope, quotaPreflightScope, runQuotaReconcileCommand } from "../quota-reconcile-cli.js";
import { readQuotaSwitchPreflight } from "../quota-preflight.js";
import { queryModelUsageForRange } from "../model-facts.js";

let pg: PostgresTestInstance; let db: ReturnType<typeof createKysely>; let enterpriseId: string;
let employee: string; let key: string; let project: string; let projectKey: string;
const now = new Date("2026-11-02T01:00:00Z");
async function usage(principal: string, principalKey: string, model: string, tokens: bigint, date = "2026-11-01T10:00:00+08:00") {
  const id = randomUUID(), at = new Date(date);
  await db.insertInto("ai_request").values({ id, enterprise_id: enterpriseId, principal_id: principal, principal_key_id: principalKey,
    protocol: "OPENAI_CHAT", unified_model: model, status: "SUCCEEDED", started_at: at, finished_at: at }).execute();
  await db.insertInto("ledger_transaction").values({ enterprise_id: enterpriseId, ai_request_id: id, principal_id: principal,
    total_input_tokens: tokens, total_output_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0", api_cost_status: "NOT_APPLICABLE",
    usage_quality: "UPSTREAM_REPORTED", attempt_count: 1, status: "SETTLED", created_at: at }).execute();
}
beforeAll(async () => {
  pg = await startPostgresContainer("employee_report_facts"); db = createKysely(pg.connectionString); await migrateToLatest(db);
  enterpriseId = (await db.insertInto("enterprise").values({ name: "报表一致性合成企业", timezone: "Asia/Shanghai" }).returning("id").executeTakeFirstOrThrow()).id;
  const person = (await db.insertInto("person").values({ enterprise_id: enterpriseId, name: "欧阳测试长姓名成员", department_label: "跨部门人工智能研发与产品创新团队" }).returning("id").executeTakeFirstOrThrow()).id;
  employee = (await db.insertInto("principal").values({ enterprise_id: enterpriseId, person_id: person, type: "EMPLOYEE", name: "欧阳测试长姓名成员" }).returning("id").executeTakeFirstOrThrow()).id;
  project = (await db.insertInto("principal").values({ enterprise_id: enterpriseId, type: "PROJECT", name: "不得混入员工" }).returning("id").executeTakeFirstOrThrow()).id;
  key = (await db.insertInto("principal_key").values({ enterprise_id: enterpriseId, principal_id: employee, key_prefix: "facts", key_digest: randomUUID() }).returning("id").executeTakeFirstOrThrow()).id;
  projectKey = (await db.insertInto("principal_key").values({ enterprise_id: enterpriseId, principal_id: project, key_prefix: "project", key_digest: randomUUID() }).returning("id").executeTakeFirstOrThrow()).id;
  for (const provider of ["deepseek", "zhipu", "kimi"]) await db.insertInto("principal_grant").values({ enterprise_id: enterpriseId, principal_id: employee,
    provider, model_alias: "*", pool_model_alias: "*", quota_value: 100000000n, allow_overage: true, status: "ACTIVE",
    valid_from: new Date("2026-09-01T00:00:00Z"), created_at: new Date("2026-09-01T00:00:00Z"), updated_at: new Date("2026-09-01T00:00:00Z") }).execute();
  await db.insertInto("principal_grant").values({ enterprise_id: enterpriseId, principal_id: project, provider: "project-provider", model_alias: "*", quota_value: 300000000n }).execute();
  for (const [model, tokens] of [["DeepSeek V3", 4000000n], ["GLM 5.3 Flash", 3000000n], ["GLM 5.3", 2000000n], ["K3", 1000000n]] as const)
    await usage(employee, key, model, tokens);
  await usage(project, projectKey, "PROJECT-ONLY", 99999999n);
  await usage(employee, key, "OUTSIDE-NEXT-DAY", 99999999n, "2026-11-02T00:00:00+08:00");
}, 120_000);
afterAll(async () => { vi.restoreAllMocks(); await db?.destroy(); await pg?.stop(); }, 60_000);

describe("employee report frozen facts", () => {
  it("uses the full employee denominator and four distinct models, excluding project and the next day", async () => {
    const facts = await readEmployeeReportFacts(db, { enterpriseId, period: "TODAY", anchor: new Date("2026-11-01T12:00:00Z"), timezone: "Asia/Shanghai", now });
    expect(facts.overview.metrics.realTokens).toBe("10000000"); expect(facts.overview.metrics.requestCount).toBe("4");
    expect(facts.models.totalModels).toBe(4); expect(facts.models.models.map(row => row.model)).toEqual(["DeepSeek V3", "GLM 5.3 Flash", "GLM 5.3"]);
    expect(facts.models.models.map(row => row.tokens / Number(facts.overview.metrics.realTokens))).toEqual([0.4, 0.3, 0.2]);
    expect(facts.quota.rows.map(row => row.provider)).not.toContain("project-provider");
    expect(facts.quota.statusLabel).toContain("待核");
  });
  it("keeps the same snapshot when a model and grant change between overview and detail reads", async () => {
    const original = UsageOverviewRepository.prototype.getOverviewSnapshot;
    const spy = vi.spyOn(UsageOverviewRepository.prototype, "getOverviewSnapshot").mockImplementationOnce(async function (this: UsageOverviewRepository, input) {
      const overview = await original.call(this, input);
      await usage(employee, key, "AFTER-SNAPSHOT", 5000000n);
      await db.updateTable("principal_grant").set({ provider: "after-snapshot", updated_at: now }).where("enterprise_id", "=", enterpriseId).where("provider", "=", "kimi").execute();
      return overview;
    });
    try {
      const facts = await readEmployeeReportFacts(db, { enterpriseId, period: "TODAY", anchor: new Date("2026-11-01T12:00:00Z"), timezone: "Asia/Shanghai", now });
      expect(facts.overview.metrics.realTokens).toBe("10000000"); expect(facts.models.totalModels).toBe(4);
      expect(facts.quota.rows.some(row => row.provider === "kimi")).toBe(true);
      expect(facts.quota.rows.some(row => row.provider === "after-snapshot")).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it("uses November quota at the end of a crossing week and creates no historical quota rows", async () => {
    const input = { db, enterpriseId, kekBase64: "unused", targetDate: new Date("2026-11-01T12:00:00Z"), now, dryRun: true };
    const company = await runCompanyWeeklyReport(input);
    const personal = await runPersonalWeeklyReports({ ...input, userPersonId: "欧阳测试长姓名成员" });
    expect(company.dateRange).toBe("10.26 - 11.1"); expect(company.svg).toContain("截至11月1日");
    expect(company.svg).toContain("共 5 个，展示 Top3");
    expect(personal[0]!.svg).toContain("截至11月1日"); expect(personal[0]!.svg).toContain("历史余额待核账");
    expect(company.svg).not.toContain("18.1"); expect(company.svg).not.toContain("project-provider");
    const quotaBefore = await db.selectFrom("principal_quota_period").selectAll().where("enterprise_id", "=", enterpriseId).execute();
    expect(quotaBefore).toHaveLength(0);
    await runEmployeeQuotaInitializationTick({ db, enterpriseId, now });
    expect(await db.selectFrom("principal_quota_period").selectAll().where("enterprise_id", "=", enterpriseId).execute()).toHaveLength(0);
    const directory = fileURLToPath(new URL("../../../../../V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/", import.meta.url)); await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "synthetic-company-weekly.svg"), company.svg!); await writeFile(resolve(directory, "synthetic-company-weekly.png"), company.pngBuffer!);
    await writeFile(resolve(directory, "synthetic-personal-weekly.svg"), personal[0]!.svg!);
    await writeFile(resolve(directory, "synthetic-personal-weekly.png"), await renderSvgToPng(personal[0]!.svg!, { fitWidth: 1080 }));
  });
  it("initializes one current monthly account and renders separate raw/plan overage and unresolved states", async () => {
    const openedAt = new Date("2026-11-01T00:00:00+08:00");
    await db.updateTable("principal_grant").set({ provider: "kimi" }).where("enterprise_id", "=", enterpriseId).where("provider", "=", "after-snapshot").execute();
    await db.updateTable("principal_grant").set({ quota_basis: "PLAN_QUOTA", valid_from: new Date("2026-10-01T00:00:00Z"), updated_at: new Date("2026-10-01T00:00:00Z") })
      .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", employee).execute();
    await db.updateTable("principal_grant").set({ quota_basis: "RAW_TOKEN" }).where("enterprise_id", "=", enterpriseId).where("provider", "=", "deepseek").execute();
    await db.updateTable("enterprise").set({ employee_quota_monthly_from: openedAt }).where("id", "=", enterpriseId).execute();
    await runEmployeeQuotaInitializationTick({ db, enterpriseId, now: openedAt });
    await runEmployeeQuotaInitializationTick({ db, enterpriseId, now: openedAt });
    const periods = await db.selectFrom("principal_quota_period").selectAll().where("enterprise_id", "=", enterpriseId).execute();
    expect(periods).toHaveLength(3);
    const request = await db.selectFrom("ai_request").select("id").where("enterprise_id", "=", enterpriseId).where("principal_id", "=", employee).executeTakeFirstOrThrow();
    let attempt = 1;
    for (const period of periods) {
      const pending = period.provider === "kimi";
      const actual = period.provider === "deepseek" ? 120000000n : 40000000n;
      const grant = await db.selectFrom("principal_grant").select("id").where("enterprise_id", "=", enterpriseId).where("principal_id", "=", employee).where("provider", "=", period.provider).executeTakeFirstOrThrow();
      await db.insertInto("principal_quota_usage").values({ enterprise_id: enterpriseId, request_id: request.id, attempt_no: attempt++, upstream_attempt_id: null,
        period_id: period.id, grant_id: grant.id, grant_version: 1, quota_basis: period.quota_basis, estimate: 5000000n,
        actual: pending ? null : actual, status: pending ? "UNKNOWN" : "SETTLED", usage_quality: pending ? "UNKNOWN" : "UPSTREAM_REPORTED",
        created_at: openedAt, settled_at: pending ? null : new Date("2026-11-01T12:00:00+08:00") }).execute();
      await db.updateTable("principal_quota_period").set({ used_value: pending ? 0n : actual, reserved_value: pending ? 5000000n : 0n,
        quality: pending ? "UNKNOWN" : "COMPLETE", updated_at: new Date("2026-11-01T12:00:00+08:00") }).where("id", "=", period.id).execute();
    }
    const input = { db, enterpriseId, kekBase64: "unused", targetDate: new Date("2026-11-01T12:00:00Z"), now, dryRun: true };
    const facts = await readEmployeeReportFacts(db, { enterpriseId, period: "WEEK", timezone: "Asia/Shanghai", anchor: input.targetDate, now });
    expect(facts.quota.statusLabel).toBe("1项超额，1项待核");
    expect(facts.quotaForPrincipal(employee).rows).toEqual(facts.quota.rows);
    expect(facts.quota.rows.find(row => row.provider === "deepseek")).toMatchObject({ basis: "实际 Token", detail: "分配 1.0 亿 · 已用 1.2 亿 · 超额 2000.0 万" });
    expect(facts.quota.rows.find(row => row.provider === "zhipu")!.detail).toContain("可用 6000.0 万");
    expect(facts.quota.rows.find(row => row.provider === "kimi")!.detail).toContain("预占 500.0 万");
    const company = await runCompanyWeeklyReport(input);
    const personal = await runPersonalWeeklyReports({ ...input, userPersonId: "欧阳测试长姓名成员" });
    expect(company.summaryText).toContain(facts.quota.statusLabel);
    expect(personal[0]!.summaryText).toContain(facts.quota.statusLabel);
    for (const row of facts.quota.rows) { expect(company.svg).toContain(row.detail); expect(company.summaryText).toContain(row.detail); }
    const directory = fileURLToPath(new URL("../../../../../V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/", import.meta.url));
    await writeFile(resolve(directory, "synthetic-monthly-quota-company.png"), company.pngBuffer!);
    await writeFile(resolve(directory, "synthetic-monthly-quota-company.svg"), company.svg!);
    await writeFile(resolve(directory, "synthetic-monthly-quota-company.txt"), company.summaryText!);
    await writeFile(resolve(directory, "synthetic-monthly-quota-personal.png"), await renderSvgToPng(personal[0]!.svg!, { fitWidth: 1080 }));
    await writeFile(resolve(directory, "synthetic-monthly-quota-personal.svg"), personal[0]!.svg!);
    await writeFile(resolve(directory, "synthetic-monthly-quota-personal.txt"), personal[0]!.summaryText!);
  });
  it("enforces the read-only transaction boundary and a preview-only CLI", async () => {
    await expect(db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      await trx.updateTable("enterprise").set({ name: "forbidden" }).where("id", "=", enterpriseId).execute();
    })).rejects.toThrow(/read-only/);
    expect(() => quotaReconcileScope(["apply"])).toThrow(/read-only/);
    expect(() => quotaReconcileScope(["preview", "--enterprise", enterpriseId])).toThrow(/Required/);
    expect(reportQuotaCutoff(new Date("2026-11-01T16:00:00Z"), "Asia/Shanghai").periodKey).toBe("2026-11");
  });
  it("explains proven legacy API/plan consumption while retaining unknown historical allocations", async () => {
    const at = new Date("2026-11-01T12:00:00+08:00");
    for (const [provider, mode, deducted] of [["legacy-raw", "API", null], ["legacy-plan", "CODING_PLAN", 600n], ["legacy-pending", "CODING_PLAN", null]] as const) {
      const vendor = await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: provider, name: provider, adapter_type: "deepseek" }).returning("id").executeTakeFirstOrThrow();
      const resource = await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: vendor.id, name: provider, mode, credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow();
      const request = randomUUID();
      await db.insertInto("ai_request").values({ id: request, enterprise_id: enterpriseId, principal_id: employee, principal_key_id: key, protocol: "OPENAI_CHAT", unified_model: provider, status: "FAILED", started_at: at, finished_at: at }).execute();
      const attempt = await db.insertInto("upstream_attempt").values({ enterprise_id: enterpriseId, ai_request_id: request, attempt_no: 1, provider_resource_id: resource.id, upstream_model: provider, http_status: 500, started_at: at, finished_at: at }).returning("id").executeTakeFirstOrThrow();
      const event = await db.insertInto("usage_event").values({ enterprise_id: enterpriseId, ai_request_id: request, upstream_attempt_id: attempt.id, provider_resource_id: resource.id, input_tokens: 1000n, output_tokens: 200n, usage_quality: "PROVIDER_REPORTED", dedup_key: randomUUID(), created_at: at }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("ledger_line").values({ enterprise_id: enterpriseId, ai_request_id: request, usage_event_id: event.id, upstream_attempt_id: attempt.id, provider_resource_id: resource.id,
        principal_id: employee, resource_mode: mode, raw_input_tokens: 1000n, raw_output_tokens: 200n, raw_cache_tokens: 500n, deducted_quota: deducted,
        api_cost: mode === "API" ? "0.12" : null, usage_quality: "PROVIDER_REPORTED", settled_at: at }).execute();
    }
    const facts = await readEmployeeReportFacts(db, { enterpriseId, period: "TODAY", anchor: at, timezone: "Asia/Shanghai", now });
    expect(facts.overview.metrics.requestCount).toBe("5"); // failed real consumption is quota evidence, not successful activity
    expect(facts.quota.rows.find(row => row.provider === "legacy-raw")).toMatchObject({ basis: "实际 Token", detail: "结算期间已证使用 0.1 万 · 历史余额待核账" });
    expect(facts.quota.rows.find(row => row.provider === "legacy-plan")).toMatchObject({ basis: "套餐折算额度", detail: "结算期间已证使用 0.1 万 · 历史余额待核账" });
    expect(facts.quota.rows.find(row => row.provider === "legacy-pending")!.detail).toContain("使用 待核");
    expect(facts.quotaForPrincipal(employee).rows).toEqual(facts.quota.rows);
  });

  it("executes historical preview and switch preflight CLI in real read-only transactions without changing facts", async () => {
    const before = await db.selectFrom("principal_quota_period").selectAll().where("enterprise_id", "=", enterpriseId).orderBy("id").execute();
    const capture: string[] = [];
    vi.stubEnv("DATABASE_URL", pg.connectionString);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { capture.push(String(chunk)); return true; });
    try {
      await runQuotaReconcileCommand(["preview", "--enterprise", enterpriseId, "--principals", employee, "--from", "2026-11-01T00:00:00+08:00", "--to", "2026-11-02T00:00:00+08:00"]);
      const historical = JSON.parse(capture.join("")); capture.length = 0;
      expect(historical.mode).toBe("READ_ONLY_PREVIEW"); expect(historical.rows).toHaveLength(3);
      expect(historical.rows.every((row: { quality: string; targetValue: null }) => row.quality === "UNKNOWN" && row.targetValue === null)).toBe(true);
      await runQuotaReconcileCommand(["preflight", "--enterprise", enterpriseId, "--month", "2099-12"]);
      expect(JSON.parse(capture.join("")).mode).toBe("READ_ONLY_PREFLIGHT");
      await expect(runQuotaReconcileCommand(["preflight", "--enterprise", "invalid-uuid", "--month", "2099-12"])).rejects.toThrow();
      vi.stubEnv("DATABASE_URL", "");
      await expect(runQuotaReconcileCommand(["preflight", "--enterprise", enterpriseId, "--month", "2099-12"])).rejects.toThrow("DATABASE_URL is required");
    } finally { output.mockRestore(); vi.unstubAllEnvs(); }
    expect(await db.selectFrom("principal_quota_period").selectAll().where("enterprise_id", "=", enterpriseId).orderBy("id").execute()).toEqual(before);
    const open = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`.execute(db);
    expect(open.rows[0]!.count).toBe("0");
    await expect(queryModelUsageForRange(db, "invalid-uuid", new Date("2026-11-01"), new Date("2026-11-02"), undefined, 3, true)).rejects.toThrow("REPORT_MODEL_FACTS_UNAVAILABLE");
  });

  it("rejects incomplete, ambiguous and write-capable CLI inputs before touching the database", () => {
    for (const args of [["preview", "--execute"], ["preview", "--enterprise", enterpriseId, "--principals", employee, "--from", "2026-11-01", "--to", "2026-11-02"],
      ["preview", "--enterprise", enterpriseId, "--principals", employee, "--from", "2026-11-02T00:00:00Z", "--to", "2026-11-01T00:00:00Z"]]) expect(() => quotaReconcileScope(args)).toThrow();
    expect(quotaReconcileScope(["preview", "--enterprise", enterpriseId, "--principals", ` ${employee}, `, "--from", "2026-11-01T00:00:00Z", "--to", "2026-11-02T00:00:00Z"]).principalIds).toEqual([employee]);
    expect(() => quotaPreflightScope(["preview"])).toThrow("read-only");
    expect(() => quotaPreflightScope(["preflight", "--month", "bad"])).toThrow("Required");
    expect(quotaPreflightScope(["preflight", "--enterprise", enterpriseId, "--month", "2099-12"])).toEqual({ enterpriseId, month: "2099-12" });
  });

  it("keeps A-only reporting and initialization compatible when the additive monthly table is not installed", async () => {
    await db.schema.alterTable("principal_quota_period").renameTo("isolated_monthly_period_not_installed").execute();
    try {
      expect(await runEmployeeQuotaInitializationTick({ db, now })).toEqual({ initialized: 0 });
      const preflight = await readQuotaSwitchPreflight(db, { enterpriseId, month: "2099-12", now });
      expect(preflight.reasons).toContain("MONTHLY_SCHEMA_NOT_READY");
      const facts = await readEmployeeReportFacts(db, { enterpriseId, period: "TODAY", anchor: new Date("2026-11-01T12:00:00Z"), timezone: "Asia/Shanghai", now });
      expect(facts.quota.statusLabel).toBe("历史余额待核账");
    } finally { await db.schema.alterTable("isolated_monthly_period_not_installed").renameTo("principal_quota_period").execute(); }
  });

});
