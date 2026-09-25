import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createKysely, GatewayLedgerRepository, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { generateApiKey, digestApiKey, apiKeyPrefix } from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { stubPipeline } from "../pipeline/stub-pipeline.js";

/**
 * WP04 任务 4.5：Gateway 静默门禁（PFA-09）。
 *
 * 只证明数据面最关键的一条性质：**有效静默租约内的新模型调用在 pipeline 之前被短路**，
 * 因此既不访问上游、也不创建任何 `ai_request` / `upstream_attempt` / `usage_event` /
 * `ledger_line` 事实（否则候选的事实水位会持续漂移、排空永远无法完成）。
 *
 * 计数用两层证据：
 * - pipeline 回调自增的 `pipelineCalls`（等价于"是否到达上游/账本阶段"）；
 * - pipeline 第一件事就是写 `ai_request`，因此"零事实"可直接用行数断言。
 *
 * 到期恢复是纯服务端时间判定（`ACTIVE AND expires_at > now`）：把租约窗口整体推到过去、
 * 或置为 `RELEASED`，流量必须立刻恢复，且不需要任何清理动作。
 */

const PEPPER = "pf04-gateway-pepper-32bytes-min!!!";
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let keyId: string;
let validKey: string;
let adminId: string;
let pipelineCalls = 0;

/** 用真实流水线**第一件事**（写 ai_request）代表"上游/账本阶段已开始"。 */
const ledger = () => new GatewayLedgerRepository(db);

beforeAll(async () => {
  pg = await startPostgresContainer("provider_finance_quiescence_gateway");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  adminId = randomUUID();
  await db.insertInto("enterprise").values({ id: ENT_ID, name: "PF04 静默门禁企业" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: ENT_ID,
    username: "pf04-gateway-admin", password_hash: "test", status: "ACTIVE" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID,
    type: "EMPLOYEE", name: "静默门禁员工", department_label: null, person_id: null,
    owner_person_id: null }).execute();
  const modelId = (await db.insertInto("unified_model").values({ enterprise_id: ENT_ID,
    alias: "qianliu-deepseek", display_name: "仟流 DeepSeek", status: "ACTIVE" })
    .returning("id").executeTakeFirstOrThrow()).id;
  // 完整的模型可见性链（key 白名单 → route → 资源 → provider → 计费规则 → Grant）：
  // 让 `/v1/models` 在静默期内有可断言的内容，证明"只读元数据端点不受门禁影响"。
  const providerId = (await db.insertInto("provider").values({ enterprise_id: ENT_ID,
    code: "deepseek", name: "DeepSeek", adapter_type: "deepseek", status: "ACTIVE" })
    .returning("id").executeTakeFirstOrThrow()).id;
  const resourceId = (await db.insertInto("provider_resource").values({ enterprise_id: ENT_ID,
    provider_id: providerId, name: "DeepSeek 主账号", mode: "API", credential_type: "API_KEY",
    status: "ACTIVE" }).returning("id").executeTakeFirstOrThrow()).id;
  await db.insertInto("model_route").values({ enterprise_id: ENT_ID, unified_model_id: modelId,
    provider_resource_id: resourceId, upstream_model: "deepseek-chat", enabled: true }).execute();
  await db.insertInto("billing_rule").values({ enterprise_id: ENT_ID,
    provider_resource_id: resourceId, upstream_model: "deepseek-chat", rule_type: "API_PRICE",
    rule_version: "pf04-gate", effective_from: new Date(0), cache_miss_price: "0.000001" }).execute();
  await db.insertInto("principal_grant").values({ enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID, provider: "deepseek", model_alias: "qianliu-deepseek",
    quota_value: 1_000_000n, status: "ACTIVE" }).execute();
  validKey = generateApiKey();
  keyId = (await db.insertInto("principal_key").values({ enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID, key_prefix: apiKeyPrefix(validKey),
    key_digest: digestApiKey(validKey, PEPPER),
    allowed_model_ids: JSON.stringify([modelId]) as unknown as string[],
    status: "ACTIVE", expires_at: null }).returning("id").executeTakeFirstOrThrow()).id;

  app = buildGateway(db, PEPPER, async (input) => {
    pipelineCalls += 1;
    // 模拟真实流水线的首笔事实写入：门禁若短路，这一行就不会出现。
    await ledger().createRequest({ id: randomUUID(), enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID, principal_key_id: keyId, protocol: "OPENAI_CHAT",
      unified_model: "qianliu-deepseek", unified_model_id: null });
    await stubPipeline(input);
  });
  await app.ready();
}, 180_000);

afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); }, 60_000);

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${validKey}` };
}

function chatRequest() {
  return app.inject({ method: "POST", url: "/v1/chat/completions",
    headers: { ...authHeader(), "content-type": "application/json" },
    payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] } });
}

async function requestCount(): Promise<number> {
  const row = await db.selectFrom("ai_request")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("enterprise_id", "=", ENT_ID).executeTakeFirstOrThrow();
  return Number(row.count);
}

/** 按企业主键 upsert 一条静默租约（窗口约束：expires > started 且 ≤ started + 60min）。 */
async function upsertLease(input: {
  status: "ACTIVE" | "RELEASED" | "EXPIRED";
  startedAt: Date; expiresAt: Date; releasedAt?: Date; reason?: string;
}): Promise<void> {
  await sql`
    INSERT INTO provider_finance_activation_quiescence
      (enterprise_id, status, started_by_admin_user_id, started_at, expires_at,
       released_at, release_reason)
    VALUES (${ENT_ID}::uuid, ${input.status}, ${adminId}::uuid, ${input.startedAt}, ${input.expiresAt},
            ${input.releasedAt ?? null}, ${input.reason ?? null})
    ON CONFLICT (enterprise_id) DO UPDATE SET
      status = EXCLUDED.status, started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at,
      released_at = EXCLUDED.released_at, release_reason = EXCLUDED.release_reason
  `.execute(db);
}

describe.sequential("PF-INIT WP04：Gateway 静默门禁（零上游）", () => {
  it("有效静默租约内新调用 503 enterprise_maintenance，零上游且零账本事实", async () => {
    // 基线：无租约时请求正常走 pipeline。
    const baselineCalls = pipelineCalls;
    const allowed = await chatRequest();
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(pipelineCalls).toBe(baselineCalls + 1);
    const afterBaseline = await requestCount();
    expect(afterBaseline).toBe(1);

    const now = Date.now();
    await upsertLease({ status: "ACTIVE", startedAt: new Date(now),
      expiresAt: new Date(now + 30 * 60_000) });

    const blocked = await chatRequest();
    expect(blocked.statusCode, blocked.body).toBe(503);
    expect(blocked.json().error).toMatchObject({
      code: "enterprise_maintenance", type: "service_unavailable_error", retryable: true,
      param: null, maintenance_until: expect.any(String),
    });
    expect(blocked.headers["retry-after"]).toBe("60");
    // 同一门禁覆盖全部模型调用端点（chat / messages / responses）。
    for (const url of ["/v1/messages", "/v1/responses"]) {
      const other = await app.inject({ method: "POST", url,
        headers: { ...authHeader(), "content-type": "application/json" },
        payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] } });
      expect(other.statusCode, `${url} → ${other.body}`).toBe(503);
      expect(other.json().error.code).toBe("enterprise_maintenance");
    }
    // 上游/账本阶段一次都没有到达：回调未触发，且没有新增任何 ai_request。
    expect(pipelineCalls).toBe(baselineCalls + 1);
    expect(await requestCount()).toBe(afterBaseline);

    // 只读元数据端点不受静默门禁影响，控制台仍需能读取模型列表。
    const models = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(models.statusCode, models.body).toBe(200);
    expect(models.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qianliu-deepseek" })]));

    // 未认证请求仍是鉴权失败，不得被误报为"企业维护中"。
    const unauthenticated = await app.inject({ method: "POST", url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] } });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("租约到期或被解除后自动恢复流量，无需清理动作", async () => {
    const expiredStart = new Date(Date.now() - 2 * 3_600_000);
    await upsertLease({ status: "ACTIVE", startedAt: expiredStart,
      expiresAt: new Date(expiredStart.getTime() + 30 * 60_000) });

    const before = pipelineCalls;
    const recovered = await chatRequest();
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(pipelineCalls).toBe(before + 1);
    expect(await requestCount()).toBe(2);

    // 显式解除（RELEASED 终态）同样立即恢复流量。
    const now = Date.now();
    await upsertLease({ status: "RELEASED", startedAt: new Date(now - 3_600_000),
      expiresAt: new Date(now - 3_000_000), releasedAt: new Date(now), reason: "维护结束" });
    const afterRelease = await chatRequest();
    expect(afterRelease.statusCode, afterRelease.body).toBe(200);
    expect(pipelineCalls).toBe(before + 2);
    expect(await requestCount()).toBe(3);
  });
});
