/**
 * gateway WP2-S2 集成测试：API 资金 PENDING 调用准入解除（AFR-02 / 迁移 0094）。
 *
 * 复用 w11-resource-pool.test.ts 的构造模式（Testcontainer PG17 + migrateToLatest +
 * ResourcePoolRepository），覆盖 plan.md task 4.3 的机制层断言：
 *   (a) AT-AFR-04 机制层：新建无资金账户的 API 资源（已激活企业）不再被种入 PENDING，
 *       直接进入可服务集合并能产生用量与费用估算（loadApiCostEstimation，ACE-03 同源）；
 *   (b) AT-AFR-05 机制层：仅 finance_state=PENDING 的存量留档资源可服务（存量行仅留档，
 *       不再参与调度）；
 *   (c) AT-AFR-06 机制层：CREDENTIAL_INVALID 隔离仍拒绝（拒绝原因与隔离语义不变，
 *       零上游调用——可服务集合排除 + upstream_attempt 零新增）。
 *
 * 不触达 quota_block_state（:443）与 evaluateAdmission（:451）语义；其回归锚点为
 * w11-resource-pool.test.ts / cpqw-quota-window.test.ts 全绿。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createKysely,
  migrateToLatest,
  loadApiCostEstimation,
  type Database,
} from "@qianliu/database";
import { ResourcePoolRepository } from
  "../../../../packages/database/src/repositories/resource-pool-repository.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { RESOURCE_STATUS, STATE_REASON } from "@qianliu/domain";

let pg: PostgresTestInstance;
let db: Database;
let poolRepo: ResourcePoolRepository;
const ENT_ID = randomUUID();
const ACTIVATED_AT = new Date("2026-09-21T10:00:00.000Z");
let providerId: string;
let adminId: string;
let principalId: string;
let keyId: string;
/** 新建无资金账户资源（0094 后：无 finance_state 行、立即可服务）。 */
let freshApiResourceId: string;
/** 存量 PENDING 留档资源（直插 finance_state 行，模拟 0094 前种入）。 */
let legacyPendingResourceId: string;
/** 凭证隔离资源（CREDENTIAL_INVALID，机制层拒绝锚点）。 */
let credInvalidResourceId: string;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  poolRepo = new ResourcePoolRepository(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-WP2准入解除" }).execute();
  adminId = randomUUID();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: ENT_ID, username: "wp2-admin",
    display_name: "WP2 管理员", password_hash: "test",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "kimi", name: "Kimi", adapter_type: "kimi",
  }).returning("id").executeTakeFirstOrThrow();
  providerId = provider.id;

  principalId = randomUUID();
  keyId = randomUUID();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "WP2 员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: ENT_ID, principal_id: principalId,
    key_prefix: "ql_wp2", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();

  // 已激活（strict_writes_enabled）企业：0081 时代在此新建 API 资源会被种入 PENDING，
  // 0094 删除种入触发器后不再有行（AFR-02）。
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: ENT_ID, strict_writes_enabled: true,
    activated_at: ACTIVATED_AT, activated_by_admin_user_id: adminId,
  }).execute();

  const mkResource = async (name: string) => {
    const r = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID, provider_id: providerId, name,
      mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    return r.id;
  };
  freshApiResourceId = await mkResource(`wp2-fresh-api-${randomUUID().slice(0, 8)}`);
  legacyPendingResourceId = await mkResource(`wp2-legacy-pending-${randomUUID().slice(0, 8)}`);
  credInvalidResourceId = await mkResource(`wp2-cred-invalid-${randomUUID().slice(0, 8)}`);

  // 存量 PENDING 留档行（0094 后种入已退役，只能直插构造；D4：行仅留档不参与调度）。
  await db.insertInto("provider_resource_finance_state").values({
    enterprise_id: ENT_ID, provider_resource_id: legacyPendingResourceId,
    required_currencies: JSON.stringify([]) as never,
  }).execute();
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

/** (a) 的用量夹具：一条已计价 API ledger_line（同源估算 ACE-03 口径，不建任何资金表数据）。 */
async function seedPricedUsage(input: { resourceId: string; at: Date; cost: string }) {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: ENT_ID, principal_id: principalId,
    principal_key_id: keyId, protocol: "chat", unified_model: "kimi", status: "SUCCEEDED",
    started_at: input.at, finished_at: input.at,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    enterprise_id: ENT_ID, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: input.resourceId, upstream_model: "moonshot-v1-8k",
    http_status: 200, response_committed: true, finished_at: input.at,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    enterprise_id: ENT_ID, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    provider_resource_id: input.resourceId, input_tokens: 1000n, output_tokens: 100n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: input.at,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    enterprise_id: ENT_ID, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    usage_event_id: usage.id, provider_resource_id: input.resourceId,
    principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: input.cost, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    // F3：生产已计价行自 9bf1560 起冻结快照（含 sourceStatus）；夹具补齐生产形态。
    billing_rule_snapshot: { sourceStatus: "VERIFIED" },
    usage_quality: "PROVIDER_REPORTED", settled_at: input.at, created_at: input.at,
  }).execute();
  return { requestId, attemptId: attempt.id };
}

describe("WP2-S2 API 资金 PENDING 准入解除（AFR-02 / 迁移 0094）", () => {
  it("(a) 新建无资金账户 API 资源：无 finance_state 行、立即可服务、产生用量与费用估算（AT-AFR-04）", async () => {
    // 0094 up 后种入触发器已删除：已激活企业新建 API 资源无 finance_state 行。
    const financeRows = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .where("provider_resource_id", "=", freshApiResourceId).execute();
    expect(financeRows).toEqual([]);

    // 无任何资金账户/期初/就绪标记 → 进入可服务集合（AFR-02 准入解除）。
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).toContain(freshApiResourceId);
    const servableRow = servable.find((s) => s.id === freshApiResourceId)!;
    expect(servableRow.mode).toBe("API");
    expect(servableRow.status).toBe(RESOURCE_STATUS.ACTIVE);
    expect(servableRow.probe).toBe(false);

    // 产生正常用量（ledger_line）与同源费用估算——估算只依赖账本行，不依赖资金表
    // （ACE-03；无 provider_finance_event/快照/期初数据）。
    const at = new Date();
    await seedPricedUsage({ resourceId: freshApiResourceId, at, cost: "0.00150000" });
    const estimation = await loadApiCostEstimation(db, ENT_ID, {
      start: new Date(at.getTime() - 60_000), end: new Date(at.getTime() + 60_000),
      resourceIds: [freshApiResourceId],
    });
    expect(estimation.completeness).toBe("KNOWN_COMPLETE");
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "0.00150000" }]);
    expect(estimation.gaps).toEqual([]);
  });

  it("(b) 仅 finance_state=PENDING 的存量资源可服务（AT-AFR-05）", async () => {
    // 存量留档行确认仍为 PENDING（行本身未被迁移改动）。
    const stateRow = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .where("provider_resource_id", "=", legacyPendingResourceId).executeTakeFirstOrThrow();
    expect(stateRow.state).toBe("PENDING");

    // 准入解除后 PENDING 不再排除：该资源可服务（唯一"问题"就是旧资金标记）。
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).toContain(legacyPendingResourceId);
  });

  it("(c) CREDENTIAL_INVALID 隔离仍拒绝：拒绝原因不变、零上游调用（AT-AFR-06）", async () => {
    const transition = await poolRepo.recordFailure(
      credInvalidResourceId, "UPSTREAM_CREDENTIAL_INVALID", new Date(),
    );
    expect(transition).not.toBeNull();
    expect(transition!.toStatus).toBe(RESOURCE_STATUS.CREDENTIAL_INVALID);
    expect(transition!.reason).toBe(STATE_REASON.CREDENTIAL_REJECTED);
    expect(transition!.isolates).toBe(true);

    // 终态隔离照旧被可服务集合排除（资金准入解除不放松其他准入门槛）。
    const servable = await poolRepo.listServableResources(ENT_ID);
    expect(servable.map((s) => s.id)).not.toContain(credInvalidResourceId);

    // 零上游调用（机制层）：隔离资源没有任何 upstream_attempt 落库；
    // 人工恢复入口也照旧拒绝 CREDENTIAL_INVALID（原恢复流程不变）。
    const attempts = await db.selectFrom("upstream_attempt").selectAll()
      .where("provider_resource_id", "=", credInvalidResourceId).execute();
    expect(attempts).toEqual([]);
    expect(await poolRepo.adminRecover(credInvalidResourceId)).toBeNull();
    expect((await poolRepo.getResource(credInvalidResourceId))?.status).toBe("CREDENTIAL_INVALID");
  });
});
