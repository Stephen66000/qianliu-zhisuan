import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import {
  createKysely,
  GatewayLedgerRepository,
  migrateToLatest,
  PROVIDER_FINANCE_CUTOVER,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";
import { hashPassword } from "../auth/password.js";

/**
 * WP04 Control API 集成测试（tasks 4.1～4.5；PFU-01、PFU-03、PFU-04、PFU-06、PFA-02～PFA-09）。
 *
 * 与数据库层 WP03 套件的分工：WP03 证明"必须依赖真实 PostgreSQL 才能证明"的原子性/锁/幂等；
 * 本套件只证明 **HTTP 边界的合同**：
 * - 会话身份是权威来源，请求体身份一律被严格 schema 拒绝（PFA-07）；
 * - 激活错误码 → HTTP 404/409（含 `retryable`）的完整映射，且任何一层都不自动重试；
 * - `activation-state` 的候选元数据脱敏：不泄漏草稿载荷、证据引用与逐行修复基准；
 * - 静默租约控制接口的启动/查询/解除与 60 分钟上限；
 * - 失败审计只落非敏感字段且在投影失败前即写入；
 * - `DARK` 停写时不可逆激活与静默租约变更 404，读接口与**预检**仍可用
 *   （PFA-08；恢复手册要求"修复后重新执行完整预检与业务确认，再恢复 ACTIVE"）；
 * - 跨站写请求被同一 origin 门禁拦截（沿用既有 CSRF 门禁，未新增旁路）；
 * - 只读（`resources.view`）管理员可读不可写。
 */

const CUTOVER_ISO = PROVIDER_FINANCE_CUTOVER.toISOString();
const PASSWORD = "PF04-Test-Password!";
/** 只存在于草稿载荷中的证据引用：一旦出现在 `activation-state` 即视为脱敏失败。 */
const EVIDENCE_MARKER = "evidence://pf04-secret-marker";
/** 只存在于草稿载荷中的账户金额：同上。 */
const AMOUNT_MARKER = "137.42";
const LEGACY_LOCK = (enterpriseId: string) => `provider-finance-activation:${enterpriseId}`;

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
/** 首个企业（最早 `created_at`）：登录路由是单企业口径，只有它可用于真实登录。 */
let loginEnterprise: { enterpriseId: string; adminId: string };

beforeAll(async () => {
  pg = await startPostgresContainer("provider_finance_activation_http");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  loginEnterprise = await seedEnterprise("pf04_login", new Date("2020-01-01T00:00:00.000Z"));
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
}, 180_000);

afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); }, 60_000);

interface Seeded {
  enterpriseId: string;
  superAdminId: string;
  readOnlyAdminId: string;
  providerId: string;
  apiResourceId: string;
  planResourceId: string;
  principalId: string;
  principalKeyId: string;
  superCookie: string;
  readOnlyCookie: string;
}

/**
 * 直接落库一个会话并返回 Cookie。
 *
 * 登录路由是一期单企业口径（只认最早创建的 enterprise），而本套件需要为每个用例
 * 建独立企业（激活不可逆）。因此会话直接写 `admin_session`，仍走 `requireAuth`
 * 同一条 `findSessionByTokenHash` 校验路径，不绕过任何门禁。
 */
async function sessionFor(adminId: string): Promise<string> {
  const token = generateSessionToken();
  await db.insertInto("admin_session").values({ admin_user_id: adminId,
    token_hash: digestSessionToken(token), expires_at: new Date(Date.now() + 8 * 3_600_000) }).execute();
  return `qianliu_admin_session=${token}`;
}

/**
 * 每个用例独立的隔离企业：激活不可逆，跨用例共享企业会让用例互相污染。
 * 同时建立超级管理员与"只有 `resources.view`"的自定义岗位管理员，用于权限门禁用例。
 * `createdAt` 显式早于其它企业，用于保证登录路由（取最早企业）可命中。
 */
async function seedEnterprise(name: string, createdAt?: Date): Promise<Seeded> {
  const enterpriseId = randomUUID(); const superAdminId = randomUUID();
  const readOnlyAdminId = randomUUID(); const providerId = randomUUID();
  const apiResourceId = randomUUID(); const planResourceId = randomUUID();
  const principalId = randomUUID(); const principalKeyId = randomUUID();
  const passwordHash = await hashPassword(PASSWORD);
  await db.insertInto("enterprise").values({ id: enterpriseId, name,
    ...(createdAt ? { created_at: createdAt } : {}) }).execute();
  await db.insertInto("admin_user").values([
    { id: superAdminId, enterprise_id: enterpriseId, username: `${name}-super`,
      password_hash: passwordHash, status: "ACTIVE" },
    { id: readOnlyAdminId, enterprise_id: enterpriseId, username: `${name}-viewer`,
      password_hash: passwordHash, status: "ACTIVE", role_code: "CUSTOM" },
  ]).execute();
  // 自定义岗位只授予 `resources.view`：读接口可用、写接口必须 403（PFU-06）。
  await db.insertInto("admin_role").values({ enterprise_id: enterpriseId, name: "只读观察员",
    permissions: { resources: { view: true, operate: false } } }).execute();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: "deepseek", name: `DeepSeek ${name}`, adapter_type: "OPENAI_COMPATIBLE" }).execute();
  await db.insertInto("provider_resource").values([
    { id: apiResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: `${name}-API`, mode: "API", credential_type: "API_KEY" },
    { id: planResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: `${name}-PLAN`, mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION" },
  ]).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
    type: "EMPLOYEE", name: `${name} user`, department_label: null, person_id: null,
    owner_person_id: null }).execute();
  await db.insertInto("principal_key").values({ id: principalKeyId, enterprise_id: enterpriseId,
    principal_id: principalId, key_prefix: `ql-${name.slice(-6)}`, key_digest: `${name}-digest`,
    allowed_model_ids: [], ip_allowlist: [], expires_at: null, quota_limit: null,
    concurrency_limit: null, last_used_at: null, revoked_at: null }).execute();
  // 切换时点前采集的厂商余额快照 → 为 API 资源登记 CNY 必要币种账户（PFA-01）。
  await sql`
    INSERT INTO provider_resource_operating_snapshot
      (id, enterprise_id, provider_resource_id, version, source, collected_at,
       currency, current_balance, usage_calculation)
    VALUES (${randomUUID()}::uuid, ${enterpriseId}::uuid, ${apiResourceId}::uuid, 1, 'ADMIN',
            ${CUTOVER_ISO}::timestamptz, 'CNY', 50, 'MANUAL_SNAPSHOT')
  `.execute(db);
  return { enterpriseId, superAdminId, readOnlyAdminId, providerId, apiResourceId, planResourceId,
    principalId, principalKeyId,
    superCookie: await sessionFor(superAdminId), readOnlyCookie: await sessionFor(readOnlyAdminId) };
}

/** HTTP 形态的完整草稿（严格 schema 下的必填字段；含仅在草稿中出现的脱敏标记）。 */
function httpDraft(apiResourceId: string) {
  return {
    schema_version: "1",
    api_opening_balances: [{
      resource_id: apiResourceId, account_currency: "CNY", account_amount: AMOUNT_MARKER,
      occurred_at: CUTOVER_ISO, description: "切换时点厂商余额",
      evidence_ref: EVIDENCE_MARKER, source_record_id: null,
    }],
    historical_api_recharges: [],
    coding_plan_purchases: [],
    coding_plan_carryovers: [],
    legacy_purchase_resolutions: [],
  };
}

function startLeaseRequest(cookie: string, durationSeconds?: number) {
  return app.inject({ method: "POST", url: "/provider-finance/activation-quiescence",
    headers: { cookie }, payload: durationSeconds === undefined ? {} : { duration_seconds: durationSeconds } });
}

function previewRequest(cookie: string, draft: unknown) {
  return app.inject({ method: "POST", url: "/provider-finance/activation-preview",
    headers: { cookie }, payload: draft });
}

function activateRequest(cookie: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/provider-finance/activate",
    headers: { cookie }, payload });
}

async function previewOk(seeded: Seeded) {
  const lease = await startLeaseRequest(seeded.superCookie);
  expect(lease.statusCode, lease.body).toBe(201);
  const preview = await previewRequest(seeded.superCookie, httpDraft(seeded.apiResourceId));
  expect(preview.statusCode, preview.body).toBe(200);
  const body = preview.json();
  expect(body.decision).toBe("GO_CANDIDATE");
  expect(body.gaps).toEqual([]);
  return body as { candidate_id: string; candidate_hash: string; fact_watermark_hash: string;
    expires_at: string };
}

/** 落库一条用量行（含 ai_request / attempt / usage_event 依赖链），用于制造事实水位漂移。 */
async function insertLedgerLine(
  seeded: Seeded,
  options: { settledAt: Date | null; createdAt: Date; apiCost?: string; snapshotCurrency?: string },
): Promise<string> {
  const requestId = randomUUID();
  const ledger = new GatewayLedgerRepository(db);
  await ledger.createRequest({ id: requestId, enterprise_id: seeded.enterpriseId,
    principal_id: seeded.principalId, principal_key_id: seeded.principalKeyId,
    protocol: "OPENAI_CHAT", unified_model: "deepseek-chat", unified_model_id: null });
  const attempt = await ledger.createAttempt({ ai_request_id: requestId,
    enterprise_id: seeded.enterpriseId, attempt_no: 1,
    provider_resource_id: seeded.apiResourceId, upstream_model: "deepseek-chat" });
  const usage = await ledger.createUsageEventIfAbsent({ ai_request_id: requestId,
    enterprise_id: seeded.enterpriseId, upstream_attempt_id: attempt.id,
    provider_resource_id: seeded.apiResourceId, input_tokens: 10n, output_tokens: 2n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: `${requestId}:attempt1` });
  const lineId = randomUUID();
  const snapshot = options.snapshotCurrency === undefined ? null
    : JSON.stringify({ currency: options.snapshotCurrency });
  await sql`
    INSERT INTO ledger_line
      (id, ai_request_id, enterprise_id, usage_event_id, upstream_attempt_id,
       provider_resource_id, principal_id, resource_mode, raw_input_tokens,
       raw_output_tokens, raw_cache_tokens, raw_reasoning_tokens, deducted_quota,
       api_cost, api_cost_currency, api_cost_status, subscription_period_id,
       settled_at, usage_quality, billing_rule_snapshot, billing_rule_id, created_at)
    VALUES (${lineId}::uuid, ${requestId}::uuid, ${seeded.enterpriseId}::uuid,
            ${usage!.id}::uuid, ${attempt.id}::uuid, ${seeded.apiResourceId}::uuid,
            ${seeded.principalId}::uuid, 'API', 10, 2, 0, 0, NULL,
            ${options.apiCost ?? null}, NULL, NULL, NULL, ${options.settledAt},
            'PROVIDER_REPORTED', ${snapshot}::jsonb, NULL, ${options.createdAt})
  `.execute(db);
  const finishedAt = options.settledAt ?? options.createdAt;
  await sql`UPDATE ai_request SET status='SUCCEEDED', finished_at=${finishedAt}
             WHERE id=${requestId}::uuid`.execute(db);
  await sql`UPDATE upstream_attempt SET finished_at=${finishedAt}, http_status=200
             WHERE id=${attempt.id}::uuid`.execute(db);
  return lineId;
}

/** 直接插入一条**已过期**的 PREVIEWED 候选（TTL 表达式约束要求 expires = created + 30min）。 */
async function insertExpiredCandidate(seeded: Seeded) {
  const candidateId = randomUUID();
  const hash = "a".repeat(64);
  const draft = JSON.stringify({ schema_version: "1", api_opening_balances: [],
    historical_api_recharges: [], coding_plan_purchases: [], coding_plan_carryovers: [],
    legacy_purchase_resolutions: [] });
  await sql`
    INSERT INTO provider_finance_activation_attempt
      (id, enterprise_id, candidate_hash, fact_watermark_hash, decision, status,
       gap_summary, projection_summary, usage_repair_baseline, candidate_draft,
       created_by_admin_user_id, created_at, expires_at)
    VALUES (${candidateId}::uuid, ${seeded.enterpriseId}::uuid, ${hash}, ${hash},
            'GO_CANDIDATE', 'PREVIEWED', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
            ${draft}::jsonb, ${seeded.superAdminId}::uuid,
            now() - interval '2 hours', now() - interval '90 minutes')
  `.execute(db);
  return candidateId;
}

/** 在独立连接/事务里持有一把咨询锁，用于验证锁竞争 → 409 ACTIVATION_IN_PROGRESS。 */
async function withHeldLock(key: string, body: () => Promise<void>): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  const readyGate = new Promise<void>((resolve) => { ready = resolve; });
  const holder = db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0::bigint))`.execute(trx);
    ready();
    await gate;
  });
  await readyGate;
  try { await body(); } finally { release(); await holder; }
}

describe.sequential("PF-INIT WP04：Control API 激活与静默接口", () => {
  // =====================================================================
  // 4.1 activation-state：运行模式、范围摘要、候选元数据与回执（PFU-01、PFU-03、PFU-06）
  // =====================================================================

  it("activation-state：未激活态返回模式与切换时点；预检后只暴露候选元数据并脱敏草稿载荷", async () => {
    const seeded = await seedEnterprise("pf04_state");

    // 真实登录会话（登录路由单企业口径）同样被接受，证明未绕过任何会话门禁。
    const realLogin = await app.inject({ method: "POST", url: "/auth/login",
      payload: { username: "pf04_login-super", password: PASSWORD } });
    expect(realLogin.statusCode, realLogin.body).toBe(200);
    const loginCookie = (Array.isArray(realLogin.headers["set-cookie"])
      ? realLogin.headers["set-cookie"][0] : realLogin.headers["set-cookie"])!.split(";")[0]!;
    const viaLogin = await app.inject({ method: "GET", url: "/provider-finance/activation-state",
      headers: { cookie: loginCookie } });
    expect(viaLogin.statusCode, viaLogin.body).toBe(200);
    expect(viaLogin.json().mode).toBe("ACTIVE");
    const loginSession = await app.inject({ method: "GET", url: "/auth/me",
      headers: { cookie: loginCookie } });
    expect(loginSession.json().admin.enterpriseId).toBe(loginEnterprise.enterpriseId);

    // 会话门禁：无会话与伪造会话都必须失败关闭。
    expect((await app.inject({ method: "GET", url: "/provider-finance/activation-state" })).statusCode)
      .toBe(401);
    const forged = await app.inject({ method: "GET", url: "/provider-finance/activation-state",
      headers: { cookie: "qianliu_admin_session=forged-session-token" } });
    expect(forged.statusCode).toBe(401);

    const initial = await app.inject({ method: "GET", url: "/provider-finance/activation-state",
      headers: { cookie: seeded.superCookie } });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      mode: "ACTIVE", cutover_at: CUTOVER_ISO, strict_writes_enabled: false,
      scope_summary: null, latest_candidate: null, activation_receipt: null,
    });
    expect(initial.json().quiescence).toMatchObject({ status: null, active: false });

    // 只读（resources.view）管理员可读同一状态接口。
    const readOnly = await app.inject({ method: "GET", url: "/provider-finance/activation-state",
      headers: { cookie: seeded.readOnlyCookie } });
    expect(readOnly.statusCode, readOnly.body).toBe(200);

    const preview = await previewOk(seeded);

    const state = await app.inject({ method: "GET", url: "/provider-finance/activation-state",
      headers: { cookie: seeded.superCookie } });
    expect(state.statusCode, state.body).toBe(200);
    const body = state.json();
    expect(body).toMatchObject({
      mode: "ACTIVE", cutover_at: CUTOVER_ISO, strict_writes_enabled: false,
      quiescence: { active: true, status: "ACTIVE", drain: { drained: true } },
      latest_candidate: {
        candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
        fact_watermark_hash: preview.fact_watermark_hash, decision: "GO_CANDIDATE",
        status: "PREVIEWED", gap_summary: [], expired: false,
      },
      // 范围摘要只给账户数量与必要账户，不给逐行草稿。
      scope_summary: {
        account_count: expect.any(Number),
        required_accounts: expect.arrayContaining([
          { resource_id: seeded.apiResourceId, currency: "CNY" }]),
        months_checked: expect.any(Array),
        usage_repair_rows: expect.any(Number),
      },
    });
    expect(body.latest_candidate).not.toHaveProperty("candidate_draft");
    expect(body.latest_candidate).not.toHaveProperty("usage_repair_baseline");
    expect(body.latest_candidate).not.toHaveProperty("projection");
    // 整个响应体都不得出现草稿载荷（证据引用 / 金额）。
    const serialized = state.body;
    expect(serialized).not.toContain(EVIDENCE_MARKER);
    expect(serialized).not.toContain(AMOUNT_MARKER);
    expect(serialized).not.toContain("candidate_draft");
    expect(serialized).not.toContain("usage_repair_baseline");

    // 候选行确实持久化了草稿（0079），否则上面的脱敏断言毫无意义。
    const stored = await db.selectFrom("provider_finance_activation_attempt")
      .select("candidate_draft").where("id", "=", preview.candidate_id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.candidate_draft)).toContain(EVIDENCE_MARKER);
  });

  // =====================================================================
  // 4.2 activation-preview：会话身份、严格 schema 与静默排空门禁（PFA-02、PFA-03、PFA-07）
  // =====================================================================

  it("activation-preview：拒绝请求体身份与非法草稿，未建立静默租约或剩余不足时失败关闭", async () => {
    const seeded = await seedEnterprise("pf04_preview");
    const draft = httpDraft(seeded.apiResourceId);

    // 未建立静默租约 → 连投影都不算（PFA-09：排空未完成不得生成候选）。
    const noLease = await previewRequest(seeded.superCookie, draft);
    expect(noLease.statusCode, noLease.body).toBe(409);
    expect(noLease.json()).toMatchObject({ error: "activation_not_quiescent" });

    // 严格 schema：请求体不接受任何可覆盖会话的身份字段（PFA-07）。
    for (const injected of [{ enterprise_id: randomUUID() }, { admin_id: randomUUID() },
      { draft: {}, enterpriseId: seeded.enterpriseId }]) {
      const response = await previewRequest(seeded.superCookie, { ...draft, ...injected });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_request" });
    }

    // 证据必填（PFH-06）：缺证据/空证据的草稿不得进入投影。
    const absentEvidence = await previewRequest(seeded.superCookie, {
      ...draft,
      api_opening_balances: [{ ...draft.api_opening_balances[0]!, evidence_ref: undefined }],
    });
    expect(absentEvidence.statusCode).toBe(400);
    expect(absentEvidence.json()).toMatchObject({ error: "invalid_request" });
    for (const evidence of ["", "   "]) {
      const blankEvidence = await previewRequest(seeded.superCookie, {
        ...draft,
        api_opening_balances: [{ ...draft.api_opening_balances[0]!, evidence_ref: evidence }],
      });
      expect(blankEvidence.statusCode).toBe(400);
      expect(blankEvidence.json().message).toMatch(/证据/);
    }

    // 只读管理员只有 `resources.view`：写接口必须 403（PFU-06）。
    const denied = await previewRequest(seeded.readOnlyCookie, draft);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json()).toMatchObject({ error: "permission_denied" });

    // 剩余不足 5 分钟的租约不足以完成激活，预检即拒绝。
    const shortLease = await startLeaseRequest(seeded.superCookie, 240);
    expect(shortLease.statusCode, shortLease.body).toBe(201);
    const shortPreview = await previewRequest(seeded.superCookie, draft);
    expect(shortPreview.statusCode, shortPreview.body).toBe(409);
    expect(shortPreview.json()).toMatchObject({ error: "activation_not_quiescent" });

    // 重新建立有效静默期后预检成功，并返回候选、水位、有效期与结构化缺口。
    const valid = await startLeaseRequest(seeded.superCookie);
    expect(valid.statusCode, valid.body).toBe(201);
    expect(valid.json().lease).toMatchObject({ status: "ACTIVE" });
    const preview = await previewRequest(seeded.superCookie, draft);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      decision: "GO_CANDIDATE", gaps: [],
      candidate_id: expect.any(String),
      candidate_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      fact_watermark_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      expires_at: expect.any(String),
      preview_committed_at: expect.any(String),
      scope_summary: expect.any(Object),
    });
  });

  it("activation-preview：未排空（在途请求）时拒绝并且不落候选", async () => {
    const seeded = await seedEnterprise("pf04_preview_drain");
    expect((await startLeaseRequest(seeded.superCookie)).statusCode).toBe(201);
    const ledger = new GatewayLedgerRepository(db);
    await ledger.createRequest({ id: randomUUID(), enterprise_id: seeded.enterpriseId,
      principal_id: seeded.principalId, principal_key_id: seeded.principalKeyId,
      protocol: "OPENAI_CHAT", unified_model: "deepseek-chat", unified_model_id: null });

    const blocked = await previewRequest(seeded.superCookie, httpDraft(seeded.apiResourceId));
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "activation_not_quiescent" });
    // 预检失败不得留下候选。
    expect(await db.selectFrom("provider_finance_activation_attempt").select("id")
      .where("enterprise_id", "=", seeded.enterpriseId).execute()).toHaveLength(0);
  });

  // =====================================================================
  // 4.3 activate：成功、同键重放与终态冲突（PFA-04～PFA-07、PFA-09）
  // =====================================================================

  it("activate：权威身份来自会话，成功激活并同键重放；随后同候选新键为 ALREADY_ACTIVATED", async () => {
    const seeded = await seedEnterprise("pf04_activate");
    const preview = await previewOk(seeded);
    const body = { candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
      idempotency_key: "pf04-key-1", confirm_enterprise_id: seeded.enterpriseId };

    // 请求体不接受可覆盖会话的 `enterprise_id` / `admin_id`。
    for (const injected of [{ enterprise_id: randomUUID() }, { admin_id: randomUUID() }]) {
      const rejected = await activateRequest(seeded.superCookie, { ...body, ...injected });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json()).toMatchObject({ error: "invalid_request" });
    }

    const activated = await activateRequest(seeded.superCookie, body);
    expect(activated.statusCode, activated.body).toBe(200);
    expect(activated.json()).toMatchObject({
      replayed: false, candidate_id: preview.candidate_id,
      receipt: { conservationPassed: true, conservationFailures: [],
        factCounts: { openings: 1 } },
    });

    // 同键同候选重放首次回执，不产生第二组事实。
    const replay = await activateRequest(seeded.superCookie, body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, candidate_id: preview.candidate_id });
    expect(replay.json().receipt).toEqual(activated.json().receipt);

    // 已激活企业不得再被另一请求激活。
    const second = await activateRequest(seeded.superCookie,
      { ...body, idempotency_key: "pf04-key-2" });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({ error: "already_activated", retryable: false });

    // 事实与就绪状态：一条期初、资源 READY、严格写开启、回执可见。
    const openings = await db.selectFrom("provider_finance_event")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("enterprise_id", "=", seeded.enterpriseId)
      .where("event_type", "=", "API_OPENING_BALANCE").executeTakeFirstOrThrow();
    expect(openings.count).toBe("1");
    const states = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", seeded.enterpriseId).execute();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ provider_resource_id: seeded.apiResourceId, state: "READY" });

    const state = await app.inject({ method: "GET", url: "/provider-finance/activation-state",
      headers: { cookie: seeded.superCookie } });
    expect(state.json()).toMatchObject({
      mode: "ACTIVE", strict_writes_enabled: true,
      latest_candidate: { status: "ACTIVATED" },
      activation_receipt: { conservationPassed: true },
      activated_by_admin_user_id: seeded.superAdminId,
    });
    expect(state.json().activated_at).not.toBeNull();
  });

  it("跨企业隔离：他企业候选不可激活、不可见，且失败关闭为 404 而不泄漏存在性", async () => {
    const owner = await seedEnterprise("pf04_tenant_owner");
    const intruder = await seedEnterprise("pf04_tenant_intruder");
    const ownerPreview = await previewOk(owner);
    expect((await startLeaseRequest(intruder.superCookie)).statusCode).toBe(201);

    // (a) 会话一致地提交他企业候选：候选按会话企业作用域查询 → 不存在，绝不跨租户读取。
    const crossTenant = await activateRequest(intruder.superCookie, {
      candidate_id: ownerPreview.candidate_id,
      candidate_hash: ownerPreview.candidate_hash,
      idempotency_key: "pf04-cross-tenant-1",
      confirm_enterprise_id: intruder.enterpriseId });
    expect(crossTenant.statusCode, crossTenant.body).toBe(404);
    expect(crossTenant.json()).toMatchObject({ error: "candidate_not_found" });

    // (b) 把确认企业伪造成所有者的 ID：伪造身份在第一步就被拒绝，根本走不到候选查询。
    const forged = await activateRequest(intruder.superCookie, {
      candidate_id: ownerPreview.candidate_id,
      candidate_hash: ownerPreview.candidate_hash,
      idempotency_key: "pf04-cross-tenant-2",
      confirm_enterprise_id: owner.enterpriseId });
    expect(forged.statusCode, forged.body).toBe(409);
    expect(forged.json()).toMatchObject({ error: "session_enterprise_mismatch" });

    // 侵入者的状态接口只能看到自己的企业与自己的（空的）候选。
    const intruderState = await app.inject({ method: "GET", url: "/provider-finance/activation-state",
      headers: { cookie: intruder.superCookie } });
    expect(intruderState.statusCode, intruderState.body).toBe(200);
    expect(intruderState.json()).toMatchObject({ latest_candidate: null,
      scope_summary: null, activation_receipt: null });
    expect(intruderState.body).not.toContain(ownerPreview.candidate_id);

    // 所有者的候选未被任何跨租户尝试污染。
    expect(await db.selectFrom("provider_finance_activation_attempt").select("status")
      .where("id", "=", ownerPreview.candidate_id).executeTakeFirstOrThrow())
      .toEqual({ status: "PREVIEWED" });
    expect(await db.selectFrom("provider_finance_event").select("id")
      .where("enterprise_id", "=", owner.enterpriseId).execute()).toHaveLength(0);
  });

  it("activate：候选不存在 404；企业二次确认与会话不一致 409；两者都落非敏感失败审计", async () => {
    const seeded = await seedEnterprise("pf04_notfound");

    const missingCandidateId = randomUUID();
    const mismatchCandidateId = randomUUID();
    const missing = await activateRequest(seeded.superCookie, { candidate_id: missingCandidateId,
      candidate_hash: "b".repeat(64), idempotency_key: "pf04-missing-1",
      confirm_enterprise_id: seeded.enterpriseId });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json()).toMatchObject({ error: "candidate_not_found" });

    const mismatch = await activateRequest(seeded.superCookie, { candidate_id: mismatchCandidateId,
      candidate_hash: "b".repeat(64), idempotency_key: "pf04-mismatch-1",
      confirm_enterprise_id: randomUUID() });
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: "session_enterprise_mismatch" });

    // 失败审计只记错误码、候选标识与可重试性，不含草稿/证据/金额。
    const audits = await db.selectFrom("operation_log").selectAll()
      .where("enterprise_id", "=", seeded.enterpriseId)
      .where("action", "=", "provider_finance.activation_activate.failure")
      .orderBy("created_at", "asc").execute();
    expect(audits.map((row) => row.result)).toEqual(["FAILURE", "FAILURE"]);
    expect(audits.every((row) => row.admin_user_id === seeded.superAdminId)).toBe(true);
    const byCode = new Map(audits.map((row) => [row.failure_reason,
      row.change_summary as Record<string, unknown>]));
    expect(byCode.get("CANDIDATE_NOT_FOUND")).toMatchObject({
      code: "CANDIDATE_NOT_FOUND", candidate_id: missingCandidateId, retryable: false });
    expect(byCode.get("SESSION_ENTERPRISE_MISMATCH")).toMatchObject({
      code: "SESSION_ENTERPRISE_MISMATCH", candidate_id: mismatchCandidateId, retryable: false });
    for (const summary of byCode.values()) {
      expect(JSON.stringify(summary)).not.toContain(EVIDENCE_MARKER);
      expect(JSON.stringify(summary)).not.toContain(AMOUNT_MARKER);
    }
  });

  it("activate：候选过期 409 CANDIDATE_EXPIRED；解除静默后 409 ACTIVATION_NOT_QUIESCENT", async () => {
    const expiredSeeded = await seedEnterprise("pf04_expired");
    const expiredCandidate = await insertExpiredCandidate(expiredSeeded);
    const expired = await activateRequest(expiredSeeded.superCookie, {
      candidate_id: expiredCandidate, candidate_hash: "a".repeat(64),
      idempotency_key: "pf04-expired-1", confirm_enterprise_id: expiredSeeded.enterpriseId });
    expect(expired.statusCode, expired.body).toBe(409);
    expect(expired.json()).toMatchObject({ error: "candidate_expired", retryable: false });

    // 解除静默后候选仍在有效期内，但静默门禁必须拦下激活且零写入。
    const seeded = await seedEnterprise("pf04_release");
    const preview = await previewOk(seeded);
    const released = await app.inject({ method: "POST",
      url: "/provider-finance/activation-quiescence/release", headers: { cookie: seeded.superCookie },
      payload: { reason: "复核结束，提前恢复流量" } });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().lease).toMatchObject({ status: "RELEASED" });

    const notQuiescent = await activateRequest(seeded.superCookie, {
      candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
      idempotency_key: "pf04-release-1", confirm_enterprise_id: seeded.enterpriseId });
    expect(notQuiescent.statusCode, notQuiescent.body).toBe(409);
    expect(notQuiescent.json()).toMatchObject({ error: "activation_not_quiescent" });
    expect(await db.selectFrom("provider_finance_event").select("id")
      .where("enterprise_id", "=", seeded.enterpriseId).execute()).toHaveLength(0);
    expect(await db.selectFrom("provider_finance_activation_attempt").select("status")
      .where("id", "=", preview.candidate_id).executeTakeFirstOrThrow())
      .toEqual({ status: "PREVIEWED" });

    // 重新建立静默期即可用同一候选完成激活（无需重新预检）。
    expect((await startLeaseRequest(seeded.superCookie)).statusCode).toBe(201);
    const retried = await activateRequest(seeded.superCookie, {
      candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
      idempotency_key: "pf04-release-2", confirm_enterprise_id: seeded.enterpriseId });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ replayed: false });
  });

  it("activate：预检后事实漂移 409 CANDIDATE_STALE 且零写入", async () => {
    const seeded = await seedEnterprise("pf04_stale");
    const preview = await previewOk(seeded);
    // 预检后新增历史用量事实（切换前采集、切换后结算），使完整事实水位漂移。
    await insertLedgerLine(seeded, { createdAt: new Date("2026-08-25T04:00:00.000Z"),
      settledAt: new Date("2026-09-05T04:00:00.000Z"), apiCost: "2", snapshotCurrency: "CNY" });

    const stale = await activateRequest(seeded.superCookie, {
      candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
      idempotency_key: "pf04-stale-1", confirm_enterprise_id: seeded.enterpriseId });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: "candidate_stale", retryable: false });
    expect(await db.selectFrom("provider_finance_event").select("id")
      .where("enterprise_id", "=", seeded.enterpriseId).execute()).toHaveLength(0);
    expect(await db.selectFrom("provider_finance_runtime_state").select("enterprise_id")
      .where("enterprise_id", "=", seeded.enterpriseId).execute()).toHaveLength(0);
    expect(await db.selectFrom("provider_finance_activation_attempt").select("status")
      .where("id", "=", preview.candidate_id).executeTakeFirstOrThrow())
      .toEqual({ status: "PREVIEWED" });
  });

  it("activate：同键不同候选 409 IDEMPOTENCY_CONFLICT；锁被占用 409 ACTIVATION_IN_PROGRESS（retryable）", async () => {
    const seeded = await seedEnterprise("pf04_idem");
    const preview = await previewOk(seeded);

    // legacy 命名空间锁被占用 → 立即失败、不等待（PFA-05）。
    await withHeldLock(LEGACY_LOCK(seeded.enterpriseId), async () => {
      const busy = await activateRequest(seeded.superCookie, {
        candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
        idempotency_key: "pf04-lock-1", confirm_enterprise_id: seeded.enterpriseId });
      expect(busy.statusCode, busy.body).toBe(409);
      expect(busy.json()).toMatchObject({ error: "activation_in_progress", retryable: true });
    });
    expect(await db.selectFrom("provider_finance_activation_attempt").select("status")
      .where("id", "=", preview.candidate_id).executeTakeFirstOrThrow())
      .toEqual({ status: "PREVIEWED" });

    const first = await activateRequest(seeded.superCookie, {
      candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
      idempotency_key: "pf04-lock-1", confirm_enterprise_id: seeded.enterpriseId });
    expect(first.statusCode, first.body).toBe(200);

    // 同幂等键但候选不同 → 冲突，绝不伪装成重放。
    const conflicting = await activateRequest(seeded.superCookie, {
      candidate_id: randomUUID(), candidate_hash: preview.candidate_hash,
      idempotency_key: "pf04-lock-1", confirm_enterprise_id: seeded.enterpriseId });
    expect(conflicting.statusCode, conflicting.body).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: "idempotency_conflict", retryable: false });
  });

  it("activate：提交边界序列化失败 409 ACTIVATION_RETRY_REQUIRED（retryable）且零自动重试、零事实", async () => {
    const seeded = await seedEnterprise("pf04_retry");
    const preview = await previewOk(seeded);
    // 在激活事务会写入的资金事件表上挂一个 DEFERRABLE INITIALLY DEFERRED 约束触发器，
    // 让失败恰好发生在 COMMIT 边界（而非语句边界），覆盖"提交期 40001"的映射路径。
    await sql`CREATE FUNCTION pf04_retry_probe() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated commit boundary failure' USING ERRCODE = '40001'; END;
      $$`.execute(db);
    await sql`CREATE CONSTRAINT TRIGGER pf04_retry_trigger
      AFTER INSERT ON provider_finance_event
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION pf04_retry_probe()`.execute(db);
    try {
      const response = await activateRequest(seeded.superCookie, {
        candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
        idempotency_key: "pf04-retry-1", confirm_enterprise_id: seeded.enterpriseId });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: "activation_retry_required", retryable: true });
    } finally {
      await sql`DROP TRIGGER IF EXISTS pf04_retry_trigger ON provider_finance_event`.execute(db);
      await sql`DROP FUNCTION IF EXISTS pf04_retry_probe()`.execute(db);
    }

    // 整体回滚：零事实、零严格写、候选保持 PREVIEWED（HTTP 层不做任何重试）。
    expect(await db.selectFrom("provider_finance_event").select("id")
      .where("enterprise_id", "=", seeded.enterpriseId).execute()).toHaveLength(0);
    expect(await db.selectFrom("provider_finance_runtime_state").select("enterprise_id")
      .where("enterprise_id", "=", seeded.enterpriseId).execute()).toHaveLength(0);
    expect(await db.selectFrom("provider_finance_activation_attempt").select("status")
      .where("id", "=", preview.candidate_id).executeTakeFirstOrThrow())
      .toEqual({ status: "PREVIEWED" });
    // 触发器移除后同一候选可正常激活，证明前面的失败确实是可重试的环境故障而非数据问题。
    const recovered = await activateRequest(seeded.superCookie, {
      candidate_id: preview.candidate_id, candidate_hash: preview.candidate_hash,
      idempotency_key: "pf04-retry-2", confirm_enterprise_id: seeded.enterpriseId });
    expect(recovered.statusCode, recovered.body).toBe(200);
  });

  // =====================================================================
  // 4.5 静默租约控制接口（PFA-09）
  // =====================================================================

  it("静默租约：启动上限 60 分钟、查询暴露租约与排空、解除需理由且写审计", async () => {
    const seeded = await seedEnterprise("pf04_lease");
    const now = Date.now();

    const started = await startLeaseRequest(seeded.superCookie, 3600);
    expect(started.statusCode, started.body).toBe(201);
    const lease = started.json().lease as { started_at: string; expires_at: string; status: string };
    expect(lease.status).toBe("ACTIVE");
    // 60 分钟上限：服务端时间决定到期，客户端无法延展。
    expect(new Date(lease.expires_at).getTime() - new Date(lease.started_at).getTime()).toBe(3_600_000);
    expect(new Date(lease.expires_at).getTime()).toBeGreaterThan(now);
    expect(new Date(lease.expires_at).getTime()).toBeLessThanOrEqual(now + 3_600_000 + 5_000);

    // 超过 60 分钟的请求被 schema 拒绝，服务端上限不可绕过。
    const tooLong = await startLeaseRequest(seeded.superCookie, 3601);
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: "invalid_request" });

    const queried = await app.inject({ method: "GET", url: "/provider-finance/activation-quiescence",
      headers: { cookie: seeded.superCookie } });
    expect(queried.statusCode, queried.body).toBe(200);
    expect(queried.json()).toMatchObject({ lease: { status: "ACTIVE" },
      quiescence: { active: true, remaining_seconds: expect.any(Number),
        insufficient_for_activation: false, drain: { drained: true } } });

    // 解除必须带理由；写接口对只读管理员一律 403。
    expect((await app.inject({ method: "POST",
      url: "/provider-finance/activation-quiescence/release", headers: { cookie: seeded.superCookie },
      payload: {} })).statusCode).toBe(400);
    const denied = await app.inject({ method: "POST", url: "/provider-finance/activation-quiescence",
      headers: { cookie: seeded.readOnlyCookie }, payload: {} });
    expect(denied.statusCode, denied.body).toBe(403);

    const released = await app.inject({ method: "POST",
      url: "/provider-finance/activation-quiescence/release", headers: { cookie: seeded.superCookie },
      payload: { reason: "维护窗口提前结束" } });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().lease).toMatchObject({ status: "RELEASED",
      release_reason: "维护窗口提前结束", released_at: expect.any(String) });
    const after = await app.inject({ method: "GET", url: "/provider-finance/activation-quiescence",
      headers: { cookie: seeded.superCookie } });
    expect(after.json().quiescence).toMatchObject({ active: false });

    // 启动与解除都留审计（PFA-09 可审计）。
    const actions = await db.selectFrom("operation_log").select("action")
      .where("enterprise_id", "=", seeded.enterpriseId)
      .where("action", "like", "provider_finance.activation_quiescence%").execute();
    expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining([
      expect.stringContaining("quiescence"), expect.stringContaining("release")]));
  });

  // =====================================================================
  // 4.4 安全：DARK 停写、跨站写门禁（PFA-07、PFA-08、PFU-06）
  // =====================================================================

  it("DARK 停写：只读与预检可用，不可逆激活与静默变更一律 404", async () => {
    const seeded = await seedEnterprise("pf04_dark");
    const prior = process.env.PROVIDER_FINANCE_MODE;
    process.env.PROVIDER_FINANCE_MODE = "DARK";
    const { buildControlApi } = await import("../server.js");
    const darkApp = buildControlApi(db); await darkApp.ready();
    try {
      const state = await darkApp.inject({ method: "GET", url: "/provider-finance/activation-state",
        headers: { cookie: seeded.superCookie } });
      expect(state.statusCode, state.body).toBe(200);
      expect(state.json().mode).toBe("DARK");
      const quiescence = await darkApp.inject({ method: "GET",
        url: "/provider-finance/activation-quiescence", headers: { cookie: seeded.superCookie } });
      expect(quiescence.statusCode, quiescence.body).toBe(200);

      // 预检在 DARK 下保持可用（恢复手册：先预检，再恢复 ACTIVE）。未建立静默租约
      // 时走领域门禁失败关闭（409），而不是被停写门禁一刀切 404。
      const preview = await darkApp.inject({ method: "POST", url: "/provider-finance/activation-preview",
        headers: { cookie: seeded.superCookie }, payload: httpDraft(seeded.apiResourceId) });
      expect(preview.statusCode, preview.body).toBe(409);
      expect(preview.json()).toMatchObject({ error: "activation_not_quiescent" });

      for (const call of [
        { url: "/provider-finance/activate", payload: { candidate_id: randomUUID(),
          candidate_hash: "b".repeat(64), idempotency_key: "pf04-dark-1",
          confirm_enterprise_id: seeded.enterpriseId } },
        { url: "/provider-finance/activation-quiescence", payload: {} },
        { url: "/provider-finance/activation-quiescence/release", payload: { reason: "dark" } },
      ]) {
        const response = await darkApp.inject({ method: "POST", url: call.url,
          headers: { cookie: seeded.superCookie }, payload: call.payload });
        expect(response.statusCode, `${call.url} → ${response.body}`).toBe(404);
      }
      // 停写期间不得产生任何候选或租约（预检被静默门禁拒绝，同样不落候选）。
      expect(await db.selectFrom("provider_finance_activation_attempt").select("id")
        .where("enterprise_id", "=", seeded.enterpriseId).execute()).toHaveLength(0);
      expect(await db.selectFrom("provider_finance_activation_quiescence").select("enterprise_id")
        .where("enterprise_id", "=", seeded.enterpriseId).execute()).toHaveLength(0);
    } finally {
      await darkApp.close();
      if (prior === undefined) delete process.env.PROVIDER_FINANCE_MODE;
      else process.env.PROVIDER_FINANCE_MODE = prior;
    }
  });

  it("跨站写门禁：配置 WEB_ORIGIN 后激活写接口沿用同一 origin 门禁，跨站写 403", async () => {
    const seeded = await seedEnterprise("pf04_origin");
    const prior = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = "https://console.example.com";
    const { buildControlApi } = await import("../server.js");
    const originApp = buildControlApi(db); await originApp.ready();
    try {
      const crossSite = await originApp.inject({ method: "POST",
        url: "/provider-finance/activation-quiescence", headers: { cookie: seeded.superCookie,
          origin: "https://evil.example.com" }, payload: {} });
      expect(crossSite.statusCode, crossSite.body).toBe(403);
      expect(crossSite.json()).toMatchObject({ error: "forbidden_origin" });

      const sameOrigin = await originApp.inject({ method: "POST",
        url: "/provider-finance/activation-quiescence", headers: { cookie: seeded.superCookie,
          origin: "https://console.example.com" }, payload: {} });
      expect(sameOrigin.statusCode, sameOrigin.body).toBe(201);

      // 读接口（安全方法）不受跨站门禁影响。
      const read = await originApp.inject({ method: "GET",
        url: "/provider-finance/activation-state", headers: { cookie: seeded.superCookie,
          origin: "https://evil.example.com" } });
      expect(read.statusCode, read.body).toBe(200);
    } finally {
      await originApp.close();
      if (prior === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = prior;
    }
  });
});
