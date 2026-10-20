import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Insertable } from "kysely";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer } from "@qianliu/testing";
import { queryModelUsageForRange, queryTopModelsForRange } from "../report-jobs.js";
import { runDailyTokenReport } from "../daily-token-report.js";
import * as raster from "../render-png.js";

const fixtures = [
  { alias: "ql-deepseek-flash", display: "deepseek-flash", label: "deepseek-flash", requests: 1265, tokens: 161882485 },
  { alias: "ql-glm-5.3-flash", display: "GLM-5.3-Flash", label: "GLM 5.3 Flash", requests: 695, tokens: 89654981 },
  { alias: "ql-glm-5.3", display: "GLM-5.3", label: "GLM 5.3", requests: 18, tokens: 3236275 },
  { alias: "ql-k3", display: "K3", label: "K3", requests: 5, tokens: 4656 },
];
let pg: Awaited<ReturnType<typeof startPostgresContainer>>;
let db: ReturnType<typeof createKysely>, enterpriseId: string, principalId: string, keyId: string;
const models = new Map<string, string>();
const start = new Date("2026-10-19T00:00:00+08:00"), end = new Date("2026-10-20T00:00:00+08:00");

beforeAll(async () => {
  pg = await startPostgresContainer("report_model_labels");
  db = createKysely(pg.connectionString); await migrateToLatest(db);
  enterpriseId = (await db.insertInto("enterprise").values({ name: "合成报表企业", timezone: "Asia/Shanghai" }).returning("id").executeTakeFirstOrThrow()).id;
  const person = (await db.insertInto("person").values({ enterprise_id: enterpriseId, name: "合成成员" }).returning("id").executeTakeFirstOrThrow()).id;
  principalId = (await db.insertInto("principal").values({ enterprise_id: enterpriseId, person_id: person, type: "EMPLOYEE", name: "合成成员" }).returning("id").executeTakeFirstOrThrow()).id;
  keyId = (await db.insertInto("principal_key").values({ enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "model-label", key_digest: randomUUID() }).returning("id").executeTakeFirstOrThrow()).id;
  const requests: Insertable<Database["ai_request"]>[] = [], ledger: Insertable<Database["ledger_transaction"]>[] = [];
  const at = new Date("2026-10-19T08:00:00+08:00");
  for (const fixture of fixtures) {
    const modelId = (await db.insertInto("unified_model").values({ enterprise_id: enterpriseId, alias: fixture.alias, display_name: fixture.display }).returning("id").executeTakeFirstOrThrow()).id;
    models.set(fixture.alias, modelId);
    const perRequest = Math.floor(fixture.tokens / fixture.requests), remainder = fixture.tokens % fixture.requests;
    for (let index = 0; index < fixture.requests; index++) {
      const id = randomUUID(), tokens = BigInt(perRequest + (index < remainder ? 1 : 0));
      requests.push({ id, enterprise_id: enterpriseId, principal_id: principalId, principal_key_id: keyId, protocol: "OPENAI_CHAT", unified_model: fixture.alias, unified_model_id: modelId, status: "SUCCEEDED", started_at: at, finished_at: at });
      ledger.push({ enterprise_id: enterpriseId, ai_request_id: id, principal_id: principalId, total_input_tokens: tokens, total_output_tokens: 0n, total_deducted_quota: tokens / 3n, total_api_cost: "0", api_cost_status: "NOT_APPLICABLE", usage_quality: "UPSTREAM_REPORTED", attempt_count: 1, status: "SETTLED", created_at: at });
    }
  }
  await db.insertInto("unified_model").values({ enterprise_id: enterpriseId, alias: "ql-unused", display_name: "Unused model" }).execute();
  await db.insertInto("ai_request").values(requests).execute();
  await db.insertInto("ledger_transaction").values(ledger).execute();
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await db?.destroy(); await pg?.stop(); });

describe("report model identity and complete counts", () => {
  it("counts four used models before limiting the table to three without changing any totals", async () => {
    const result = await queryModelUsageForRange(db, enterpriseId, start, end, undefined, 3);
    expect(result.totalModels).toBe(4);
    expect(result.models).toEqual(fixtures.slice(0, 3).map(f => ({ model: f.label, tokens: f.tokens, requestCount: f.requests })));
    const all = await queryTopModelsForRange(db, enterpriseId, start, end, undefined, 10);
    expect(all.reduce((sum, r) => sum + r.tokens, 0)).toBe(254778397);
    expect(all.reduce((sum, r) => sum + r.requestCount, 0)).toBe(1983);
    expect(all).toEqual(fixtures.map(f => ({ model: f.label, tokens: f.tokens, requestCount: f.requests })));
  });

  it("retains principal, tenant and exclusive time-range filters for both count and Top3", async () => {
    expect((await queryModelUsageForRange(db, enterpriseId, start, end, principalId, 1)).totalModels).toBe(4);
    for (const result of [
      await queryModelUsageForRange(db, randomUUID(), start, end, undefined, 3),
      await queryModelUsageForRange(db, enterpriseId, start, end, randomUUID(), 3),
      await queryModelUsageForRange(db, enterpriseId, end, new Date(end.getTime() + 86400_000), undefined, 3),
    ]) expect(result).toEqual({ models: [], totalModels: 0 });
  });

  it("the actual daily job passes four to the renderer while keeping the original three rows", async () => {
    const render = raster.renderSvgToPng, captured: string[] = [];
    const spy = vi.spyOn(raster, "renderSvgToPng").mockImplementation(async (svg, options) => { captured.push(svg); return render(svg, options); });
    try {
      const result = await runDailyTokenReport({ db, enterpriseId, kekBase64: "unused", targetDate: new Date("2026-10-19T12:00:00+08:00"), now: new Date("2026-10-20T09:00:00+08:00"), recipients: ["synthetic-viewer"], dryRun: true });
      expect(result).toMatchObject({ status: "DRY_RUN", totalTokens: 254778397, requestCount: 1983 });
      expect(captured[0]).toContain("昨日调用 4 个模型");
      expect(captured[0]).toContain("展示 Top 3");
      expect(captured[0]).toContain(">GLM 5.3 Flash</text>");
      expect(captured[0]).toContain(">GLM 5.3</text>");
      expect(captured[0]).not.toContain(">K3</text>");
    } finally { spy.mockRestore(); }
  });

  it("the legacy usage-event fallback also counts before limiting; closed-month mode does not use it", async () => {
    const provider = (await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: "fixture", name: "Fixture provider", adapter_type: "zhipu" }).returning("id").executeTakeFirstOrThrow()).id;
    const resource = (await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: provider, name: "Fixture resource", mode: "API", credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow()).id;
    const at = new Date("2026-10-18T08:00:00+08:00");
    for (const [index, fixture] of fixtures.entries()) {
      const id = randomUUID();
      await db.insertInto("ai_request").values({ id, enterprise_id: enterpriseId, principal_id: principalId, principal_key_id: keyId, protocol: "OPENAI_CHAT", unified_model: fixture.alias, unified_model_id: models.get(fixture.alias)!, status: "SUCCEEDED", started_at: at, finished_at: at }).execute();
      const attempt = (await db.insertInto("upstream_attempt").values({ ai_request_id: id, enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: resource, upstream_model: fixture.alias, started_at: at }).returning("id").executeTakeFirstOrThrow()).id;
      await db.insertInto("usage_event").values({ ai_request_id: id, enterprise_id: enterpriseId, upstream_attempt_id: attempt, provider_resource_id: resource, input_tokens: BigInt(1000 - index * 100), output_tokens: 0n, usage_quality: "PROVIDER_REPORTED", dedup_key: randomUUID(), created_at: at }).execute();
    }
    const from = new Date("2026-10-18T00:00:00+08:00"), to = new Date("2026-10-19T00:00:00+08:00");
    const result = await queryModelUsageForRange(db, enterpriseId, from, to, undefined, 3);
    expect(result.totalModels).toBe(4);
    expect(result.models.map(m => m.model)).toEqual(fixtures.slice(0, 3).map(f => f.label));
    expect(await queryModelUsageForRange(db, enterpriseId, from, to, undefined, 3, true)).toEqual({ models: [], totalModels: 0 });
  });
});
