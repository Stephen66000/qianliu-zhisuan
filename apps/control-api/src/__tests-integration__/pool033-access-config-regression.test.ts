/**
 * POOL-033 接入配置回归测试 —— refreshKeyModels 白名单 bug 修复验证。
 *
 * 背景：原 refreshKeyModels 依赖 model_route.enabled=true 决定白名单。虽然 PUT
 * 接入配置时就绪校验（catalog）正确地要求 route 启用，但配置成功后若 route 状态
 * 发生变化（如管理员停用某条路由做上游维护），原实现会在下一次 refreshKeyModels
 * 触发时把整个厂商的型号从白名单清空 → 员工连其他仍可用的型号都用不了。
 *
 * 白名单语义是"该员工被静态授权哪些型号"，路由启停属于调度层（Gateway listCandidates）
 * 关注点，不该让 Key 静态授权集意外缩小。本文件覆盖该回归。
 *
 * 同时覆盖 DeepSeek Flash/Pro 双模型业务场景：
 *   开通厂商池 → 两型号默认全在白名单 → 掐一个 → 白名单只剩另一个 → 重开恢复。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";
import { EmployeeModelRuleRepository } from "@qianliu/database";
import { sql } from "kysely";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let cookie: string;
let ruleRepo: EmployeeModelRuleRepository;

const enterpriseId = randomUUID();
const adminId = randomUUID();
const providerId = randomUUID();
const resourceId = randomUUID();
// 模拟 DeepSeek 的两个型号：Flash 和 Pro（各自独立 unified_model，符合 stableModelAlias 产出）。
const flashModelId = randomUUID();
const proModelId = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  ruleRepo = new EmployeeModelRuleRepository(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL-033-REGRESSION" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "pool033reg", display_name: "POOL-033-REGRESSION",
    password_hash: await hashPassword("POOL-033-Regression-Password!"), status: "ACTIVE",
  }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "deepseek", status: "ACTIVE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId, name: "DeepSeek 账号",
    mode: "API", credential_type: "API_KEY", status: "ACTIVE",
  }).execute();
  await db.insertInto("unified_model").values([
    { id: flashModelId, enterprise_id: enterpriseId, alias: "qianliu-deepseek-flash",
      display_name: "DeepSeek V4 Flash", status: "ACTIVE" },
    { id: proModelId, enterprise_id: enterpriseId, alias: "qianliu-deepseek-pro",
      display_name: "DeepSeek V4 Pro", status: "ACTIVE" },
  ]).execute();
  // route 启用（让 catalog 判定 ready，PUT 就绪校验能通过；模拟管理员 onboard 后启用的真实状态）。
  await db.insertInto("model_route").values([
    { enterprise_id: enterpriseId, unified_model_id: flashModelId, provider_resource_id: resourceId,
      upstream_model: "deepseek-flash", enabled: true },
    { enterprise_id: enterpriseId, unified_model_id: proModelId, provider_resource_id: resourceId,
      upstream_model: "deepseek-pro", enabled: true },
  ]).execute();
  // 计价规则（Flash/Pro 各一条，单价不同）。
  await db.insertInto("billing_rule").values([
    { enterprise_id: enterpriseId, provider_resource_id: resourceId, upstream_model: "deepseek-flash",
      rule_type: "API_PRICE", rule_version: "flash-v1", effective_from: new Date("2026-01-01T00:00:00Z"),
      cache_miss_price: "0.000001", output_price: "0.000002", enabled: true },
    { enterprise_id: enterpriseId, provider_resource_id: resourceId, upstream_model: "deepseek-pro",
      rule_type: "API_PRICE", rule_version: "pro-v1", effective_from: new Date("2026-01-01T00:00:00Z"),
      cache_miss_price: "0.000002", output_price: "0.000004", enabled: true },
  ]).execute();

  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/auth/login",
    payload: { username: "pool033reg", password: "POOL-033-Regression-Password!" },
  });
  const header = login.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

/** 建一个带 ACTIVE Key 的员工，返回 principalId。 */
async function createEmployeeWithKey(name: string): Promise<string> {
  const principalId = randomUUID();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name, status: "ACTIVE",
  }).execute();
  await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId, principal_id: principalId, key_prefix: `sk-${name}`,
    key_digest: randomUUID(), allowed_model_ids: JSON.stringify([]) as unknown as string[], status: "ACTIVE",
  }).execute();
  return principalId;
}

async function putAccessConfig(
  principalId: string,
  expectedVersion: number,
  idempotencyKey: string,
  providers: Array<{ provider_code: string; quota_value: string; enabled_model_ids: string[] }>,
) {
  return app.inject({
    method: "PUT", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
    payload: {
      expected_version: expectedVersion, idempotency_key: idempotencyKey,
      providers: providers.map((p) => ({
        provider_code: p.provider_code, quota_value: p.quota_value,
        allow_overage: false, valid_until: null, enabled_model_ids: p.enabled_model_ids,
      })),
    },
  });
}

async function readAllowedModelIds(principalId: string): Promise<string[]> {
  const row = await db.selectFrom("principal_key").select("allowed_model_ids")
    .where("principal_id", "=", principalId).where("status", "=", "ACTIVE")
    .executeTakeFirstOrThrow();
  return row.allowed_model_ids ?? [];
}

async function accessConfigurationSideEffects(principalId: string) {
  const counts = await sql<{
    versions: string;
    assignments: string;
    grants: string;
    counters: string;
    disabled_models: string;
    idempotency_rows: string;
    config_states: string;
    operation_logs: string;
  }>`
    SELECT
      (SELECT count(*)::text FROM employee_model_rule_version WHERE enterprise_id = ${enterpriseId}::uuid) AS versions,
      (SELECT count(*)::text FROM employee_model_rule_assignment WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${principalId}::uuid) AS assignments,
      (SELECT count(*)::text FROM principal_grant WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${principalId}::uuid) AS grants,
      (SELECT count(*)::text FROM quota_counter qc JOIN principal_grant pg ON pg.id = qc.grant_id WHERE pg.enterprise_id = ${enterpriseId}::uuid AND pg.principal_id = ${principalId}::uuid) AS counters,
      (SELECT count(*)::text FROM principal_provider_disabled_model WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${principalId}::uuid) AS disabled_models,
      (SELECT count(*)::text FROM principal_access_idempotency WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${principalId}::uuid) AS idempotency_rows,
      (SELECT count(*)::text FROM principal_access_config_state WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${principalId}::uuid) AS config_states,
      (SELECT count(*)::text FROM operation_log WHERE enterprise_id = ${enterpriseId}::uuid) AS operation_logs
  `.execute(db);
  return {
    counts: counts.rows[0],
    allowedModelIds: await readAllowedModelIds(principalId),
  };
}

describe("POOL-033 接入配置回归：DeepSeek Flash/Pro 双模型完整流程", () => {
  it("开通 DeepSeek 池（Flash+Pro 全选），白名单含两个型号", async () => {
    const principalId = await createEmployeeWithKey("FlashPro-全选");
    const put = await putAccessConfig(principalId, 1, "regression-all-001", [
      { provider_code: "deepseek", quota_value: "300000000", enabled_model_ids: [flashModelId, proModelId] },
    ]);
    expect(put.statusCode).toBe(200);
    expect(put.json().changes.pools_added).toEqual(["deepseek"]);

    const allowed = await readAllowedModelIds(principalId);
    expect(allowed).toContain(flashModelId);
    expect(allowed).toContain(proModelId);
    expect(allowed).toHaveLength(2);
  });

  it("掐掉 Pro 后，白名单只剩 Flash；Pro 进显式禁用清单且其 assignment 已停用", async () => {
    const principalId = await createEmployeeWithKey("FlashPro-掐Pro");
    await putAccessConfig(principalId, 1, "regression-disable-001", [
      { provider_code: "deepseek", quota_value: "300000000", enabled_model_ids: [flashModelId, proModelId] },
    ]);
    const put = await putAccessConfig(principalId, 2, "regression-disable-002", [
      { provider_code: "deepseek", quota_value: "300000000", enabled_model_ids: [flashModelId] },
    ]);
    expect(put.statusCode).toBe(200);

    // 掐掉的 Pro 进显式禁用清单。
    const disabled = await db.selectFrom("principal_provider_disabled_model").select("unified_model_id")
      .where("principal_id", "=", principalId).execute();
    expect(disabled.map((r) => r.unified_model_id)).toContain(proModelId);
    expect(disabled.map((r) => r.unified_model_id)).not.toContain(flashModelId);

    // Pro 的 assignment 已被停用（修复后：同一规则版本内掐型号会停用旧 assignment）。
    const proAssignment = await db.selectFrom("employee_model_rule_assignment").select("status")
      .where("principal_id", "=", principalId)
      .where("unified_model_id", "=", proModelId).execute();
    expect(proAssignment.length).toBe(1);
    expect(proAssignment[0]!.status).toBe("DISABLED");

    // 白名单只剩 Flash（Pro 被禁用清单排除 + assignment 停用，两层都不再含 Pro）。
    const allowed = await readAllowedModelIds(principalId);
    expect(allowed).toContain(flashModelId);
    expect(allowed).not.toContain(proModelId);
    expect(allowed).toHaveLength(1);
  });

  it("重新勾选 Pro 后，白名单恢复 Flash + Pro", async () => {
    const principalId = await createEmployeeWithKey("FlashPro-重开");
    await putAccessConfig(principalId, 1, "regression-reenable-001", [
      { provider_code: "deepseek", quota_value: "300000000", enabled_model_ids: [flashModelId, proModelId] },
    ]);
    await putAccessConfig(principalId, 2, "regression-reenable-002", [
      { provider_code: "deepseek", quota_value: "300000000", enabled_model_ids: [flashModelId] },
    ]);
    const put = await putAccessConfig(principalId, 3, "regression-reenable-003", [
      { provider_code: "deepseek", quota_value: "300000000", enabled_model_ids: [flashModelId, proModelId] },
    ]);
    expect(put.statusCode).toBe(200);

    const allowed = await readAllowedModelIds(principalId);
    expect(allowed).toContain(flashModelId);
    expect(allowed).toContain(proModelId);
    expect(allowed).toHaveLength(2);

    const disabled = await db.selectFrom("principal_provider_disabled_model").select("unified_model_id")
      .where("principal_id", "=", principalId).execute();
    expect(disabled.map((r) => r.unified_model_id)).not.toContain(proModelId);
  });
});

describe("POOL-041 接入配置重复输入 fail-fast", () => {
  it("重复 provider_code 返回稳定 400，数据库零副作用", async () => {
    const principalId = await createEmployeeWithKey("POOL041-重复厂商");
    const before = await accessConfigurationSideEffects(principalId);
    const response = await putAccessConfig(principalId, 1, "pool041-provider-duplicate", [
      { provider_code: "deepseek", quota_value: "1000000", enabled_model_ids: [flashModelId] },
      { provider_code: "deepseek", quota_value: "2000000", enabled_model_ids: [proModelId] },
    ]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_request",
      message: "provider_code 不能重复",
    });
    expect(await accessConfigurationSideEffects(principalId)).toEqual(before);
  });

  it("同一 provider 内重复 enabled_model_ids 返回稳定 400，数据库零副作用", async () => {
    const principalId = await createEmployeeWithKey("POOL041-重复型号");
    const before = await accessConfigurationSideEffects(principalId);
    const response = await putAccessConfig(principalId, 1, "pool041-model-duplicate", [
      {
        provider_code: "deepseek",
        quota_value: "1000000",
        enabled_model_ids: [flashModelId, flashModelId],
      },
    ]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_request",
      message: "enabled_model_ids 不能重复",
    });
    expect(await accessConfigurationSideEffects(principalId)).toEqual(before);
  });
});

describe("POOL-033 回归：route 状态变化不清空白名单（bug 修复核心）", () => {
  it("配置成功后停用 route，refreshKeyModels 不清空已授权白名单", async () => {
    const principalId = await createEmployeeWithKey("Route变化-保护");
    // 配置成功（route 全启用，就绪校验通过）。
    await putAccessConfig(principalId, 1, "regression-routestop-001", [
      { provider_code: "deepseek", quota_value: "300000000", enabled_model_ids: [flashModelId, proModelId] },
    ]);
    let allowed = await readAllowedModelIds(principalId);
    expect(allowed).toHaveLength(2);

    // 模拟管理员停用 Flash 的路由（上游维护）。原 bug：这会让 refreshKeyModels 清空白名单。
    // 用 Flash 而非 Pro，避免污染后续依赖 Pro 就绪的测试。
    await db.updateTable("model_route").set({ enabled: false, updated_at: new Date() })
      .where("unified_model_id", "=", flashModelId)
      .where("enterprise_id", "=", enterpriseId).execute();

    // 再次触发 refreshKeyModels（模拟任何后续保存/规则变更触发重算）。
    await db.transaction().execute(async (trx) => {
      await ruleRepo.refreshKeyModels(trx, enterpriseId, principalId);
    });

    // 修复后：白名单仍含 Pro（route 启停是调度层关注点，不该缩小静态授权集）。
    // 注意：Flash 的 route 虽停用，但白名单是"被授权的型号集合"，Gateway 调度时会发现
    // Flash 无可用路由而拒绝实际调用——这是调度层的职责，不是白名单层的。
    allowed = await readAllowedModelIds(principalId);
    expect(allowed).toContain(proModelId);
    expect(allowed.length).toBeGreaterThanOrEqual(1);

    // 恢复 Flash route，避免污染后续测试。
    await db.updateTable("model_route").set({ enabled: true, updated_at: new Date() })
      .where("unified_model_id", "=", flashModelId)
      .where("enterprise_id", "=", enterpriseId).execute();
  });
});

describe("POOL-033 回归：多路由型号不重复计入白名单（join 笛卡尔积修复）", () => {
  it("Flash 有两条路由时，白名单里只出现一次", async () => {
    // 给 Flash 加第二条路由（模拟主备资源）。
    const secondResourceId = randomUUID();
    await db.insertInto("provider_resource").values({
      id: secondResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: "DeepSeek 备用账号", mode: "API", credential_type: "API_KEY", status: "ACTIVE",
    }).execute();
    await db.insertInto("billing_rule").values({
      enterprise_id: enterpriseId, provider_resource_id: secondResourceId, upstream_model: "deepseek-flash",
      rule_type: "API_PRICE", rule_version: "flash-backup-v1",
      effective_from: new Date("2026-01-01T00:00:00Z"),
      cache_miss_price: "0.000001", output_price: "0.000002", enabled: true,
    }).execute();
    await db.insertInto("model_route").values({
      enterprise_id: enterpriseId, unified_model_id: flashModelId, provider_resource_id: secondResourceId,
      upstream_model: "deepseek-flash", enabled: true,
    }).execute();

    const principalId = await createEmployeeWithKey("多路由-去重");
    const put = await putAccessConfig(principalId, 1, "regression-multiroute-001", [
      { provider_code: "deepseek", quota_value: "100000000", enabled_model_ids: [flashModelId, proModelId] },
    ]);
    expect(put.statusCode).toBe(200);

    const allowed = await readAllowedModelIds(principalId);
    const flashCount = allowed.filter((id) => id === flashModelId).length;
    expect(flashCount).toBe(1);
    expect(allowed).toContain(proModelId);
    expect(allowed).toHaveLength(2);
  });
});

async function setFlashBilling(kind: "VALID" | "WRONG_TYPE" | "EMPTY_PRICE" | "OUTSIDE_WINDOW") {
  const today = new Date().getUTCDay() || 7;
  const otherDay = today === 1 ? 2 : 1;
  await db.updateTable("billing_rule").set({
    rule_type: kind === "WRONG_TYPE" ? "MODEL_TIER" : "API_PRICE",
    multiplier: kind === "WRONG_TYPE" ? "1" : null,
    cache_hit_price: null,
    cache_miss_price: kind === "EMPTY_PRICE" || kind === "WRONG_TYPE" ? null : "0.000001",
    output_price: kind === "EMPTY_PRICE" || kind === "WRONG_TYPE" ? null : "0.000002",
    timezone: null,
    days_of_week: null,
    start_time: null,
    end_time: null,
    time_windows: kind === "OUTSIDE_WINDOW"
      ? JSON.stringify([{
          timezone: "UTC",
          days_of_week: [otherDay],
          start_time: "00:00:00",
          end_time: "23:59:59",
        }]) as unknown as Array<{
          timezone: string; days_of_week: number[]; start_time: string; end_time: string;
        }>
      : null,
  }).where("enterprise_id", "=", enterpriseId)
    .where("upstream_model", "=", "deepseek-flash")
    .execute();
}

describe("P1-02：单人接入与 Gateway 计费准入使用同一合同", () => {
  it.each([
    ["错误规则类型", "WRONG_TYPE"],
    ["API_PRICE 空价格", "EMPTY_PRICE"],
    ["API_PRICE 当前时窗未命中", "OUTSIDE_WINDOW"],
  ] as const)("API 资源遇到%s时 PUT 返回 422 且数据库零副作用", async (_name, kind) => {
    const principalId = await createEmployeeWithKey(`P102-${kind}`);
    await setFlashBilling(kind);
    try {
      const catalog = await app.inject({
        method: "GET", url: "/employee-model-rules/catalog", headers: { cookie },
      });
      const flash = catalog.json().models.find((model: { unified_model_id: string }) =>
        model.unified_model_id === flashModelId && model.provider_resource_id === resourceId);
      expect(flash).toMatchObject({ ready: false });
      expect(flash.unavailable_reasons).toContain("缺少当前生效的计价或扣减规则");

      const read = await app.inject({
        method: "GET", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
      });
      const readFlash = read.json().providers
        .find((provider: { provider_code: string }) => provider.provider_code === "deepseek")
        .models.find((model: { unified_model_id: string; provider_resource_id: string }) =>
          model.unified_model_id === flashModelId && model.provider_resource_id === resourceId);
      expect(readFlash).toMatchObject({ ready: false, enabled: false });

      const before = await accessConfigurationSideEffects(principalId);
      const response = await putAccessConfig(principalId, 1, `p102-${kind.toLowerCase()}-put`, [{
        provider_code: "deepseek", quota_value: "1000000", enabled_model_ids: [flashModelId],
      }]);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: "not_ready" });
      expect(await accessConfigurationSideEffects(principalId)).toEqual(before);
    } finally {
      await setFlashBilling("VALID");
    }
  });

  it("既有厂商池的计费规则失效后 GET、Key 与就绪状态同步撤权", async () => {
    const principalId = await createEmployeeWithKey("P102-既有池撤权");
    const put = await putAccessConfig(principalId, 1, "p102-existing-pool-put", [{
      provider_code: "deepseek", quota_value: "1000000", enabled_model_ids: [proModelId],
    }]);
    expect(put.statusCode).toBe(200);

    const before = await app.inject({
      method: "GET", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
    });
    const beforeBody = before.json();
    const beforePro = beforeBody.providers
      .find((provider: { provider_code: string }) => provider.provider_code === "deepseek")
      .models.find((model: { unified_model_id: string }) => model.unified_model_id === proModelId);
    expect(beforePro).toMatchObject({ ready: true, enabled: true });
    expect(beforeBody.summary.model_count).toBe(1);
    expect(beforeBody.key.authorization_status).toBe("AUTHORIZED");
    expect(await readAllowedModelIds(principalId)).toEqual([proModelId]);

    await db.updateTable("billing_rule").set({
      rule_type: "MODEL_TIER", multiplier: "1",
      cache_hit_price: null, cache_miss_price: null, output_price: null,
    }).where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .where("upstream_model", "=", "deepseek-pro")
      .execute();
    try {
      const after = await app.inject({
        method: "GET", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
      });
      const afterBody = after.json();
      const afterPro = afterBody.providers
        .find((provider: { provider_code: string }) => provider.provider_code === "deepseek")
        .models.find((model: { unified_model_id: string }) => model.unified_model_id === proModelId);
      expect(afterPro).toMatchObject({ ready: false, enabled: false });
      expect(afterBody.summary.model_count).toBe(0);
      expect(afterBody.key.authorization_status).toBe("PENDING");

      await db.transaction().execute(async (trx) => {
        await ruleRepo.refreshKeyModels(trx, enterpriseId, principalId);
      });
      expect(await readAllowedModelIds(principalId)).toEqual([]);
    } finally {
      await db.updateTable("billing_rule").set({
        rule_type: "API_PRICE", multiplier: null,
        cache_hit_price: null, cache_miss_price: "0.000002", output_price: "0.000004",
      }).where("enterprise_id", "=", enterpriseId)
        .where("provider_resource_id", "=", resourceId)
        .where("upstream_model", "=", "deepseek-pro")
        .execute();
    }
  });

  it("手工权限事实保留，但失效计费模型不进入 ACTIVE Key 派生白名单", async () => {
    const principalId = await createEmployeeWithKey("P102-手工基线过滤");
    await db.insertInto("principal_model_manual_authorization").values({
      enterprise_id: enterpriseId, principal_id: principalId, unified_model_id: proModelId,
    }).execute();
    await db.updateTable("principal_key").set({
      allowed_model_ids: JSON.stringify([proModelId]) as unknown as string[],
    }).where("principal_id", "=", principalId).execute();
    await db.updateTable("billing_rule").set({
      rule_type: "MODEL_TIER", multiplier: "1",
      cache_hit_price: null, cache_miss_price: null, output_price: null,
    }).where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .where("upstream_model", "=", "deepseek-pro")
      .execute();
    try {
      await db.transaction().execute(async (trx) => {
        await ruleRepo.refreshKeyModels(trx, enterpriseId, principalId);
      });
      expect(await readAllowedModelIds(principalId)).toEqual([]);
      const manual = await db.selectFrom("principal_model_manual_authorization")
        .select("unified_model_id")
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", principalId)
        .execute();
      expect(manual.map((row) => row.unified_model_id)).toEqual([proModelId]);
    } finally {
      await db.updateTable("billing_rule").set({
        rule_type: "API_PRICE", multiplier: null,
        cache_hit_price: null, cache_miss_price: "0.000002", output_price: "0.000004",
      }).where("enterprise_id", "=", enterpriseId)
        .where("provider_resource_id", "=", resourceId)
        .where("upstream_model", "=", "deepseek-pro")
        .execute();
    }
  });

  it.each([
    ["未生效", { valid_from: new Date(Date.now() + 60_000), valid_until: null }],
    ["已过期", { valid_from: new Date(0), valid_until: new Date(Date.now() - 1_000) }],
  ] as const)("%s的 ACTIVE 厂商池不进入 GET 授权摘要和 Key", async (name, validity) => {
    const principalId = await createEmployeeWithKey(`P102-池${name}`);
    const put = await putAccessConfig(principalId, 1, `p102-${name}-pool-put`, [{
      provider_code: "deepseek", quota_value: "1000000", enabled_model_ids: [proModelId],
    }]);
    expect(put.statusCode).toBe(200);
    await db.updateTable("principal_grant").set(validity)
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .where("pool_model_alias", "=", "*")
      .execute();

    const read = await app.inject({
      method: "GET", url: `/principals/${principalId}/access-configuration`, headers: { cookie },
    });
    const body = read.json();
    const deepseek = body.providers
      .find((provider: { provider_code: string }) => provider.provider_code === "deepseek");
    const pro = deepseek.models
      .find((model: { unified_model_id: string }) => model.unified_model_id === proModelId);
    expect(deepseek.pool).toBeNull();
    expect(pro).toMatchObject({ ready: true, enabled: false });
    expect(body.summary).toMatchObject({ total_quota: "0", provider_count: 0, model_count: 0 });
    expect(body.key.authorization_status).toBe("PENDING");

    await db.transaction().execute(async (trx) => {
      await ruleRepo.refreshKeyModels(trx, enterpriseId, principalId);
    });
    expect(await readAllowedModelIds(principalId)).toEqual([]);
  });

  it("CODING_PLAN 的 MODEL_TIER 缓存倍率为空时 PUT 返回 422 且数据库零副作用", async () => {
    const planProviderId = randomUUID();
    const planResourceId = randomUUID();
    const planModelId = randomUUID();
    await db.insertInto("provider").values({
      id: planProviderId, enterprise_id: enterpriseId, code: `kimi-${planProviderId.slice(0, 6)}`,
      name: "Kimi P1-02", adapter_type: "kimi", status: "ACTIVE",
    }).execute();
    await db.insertInto("provider_resource").values({
      id: planResourceId, enterprise_id: enterpriseId, provider_id: planProviderId,
      name: "Kimi 套餐", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION", status: "ACTIVE",
    }).execute();
    await db.insertInto("unified_model").values({
      id: planModelId, enterprise_id: enterpriseId, alias: `qianliu-kimi-${planModelId.slice(0, 6)}`,
      display_name: "Kimi 空倍率", status: "ACTIVE",
    }).execute();
    await db.insertInto("model_route").values({
      enterprise_id: enterpriseId, unified_model_id: planModelId,
      provider_resource_id: planResourceId, upstream_model: "kimi-k3", enabled: true,
    }).execute();
    await db.insertInto("billing_rule").values({
      enterprise_id: enterpriseId, provider_resource_id: planResourceId, upstream_model: "kimi-k3",
      rule_type: "MODEL_TIER", rule_version: "empty-multiplier-v1",
      effective_from: new Date("2026-01-01T00:00:00Z"), multiplier: null, enabled: true,
    }).execute();
    const principalId = await createEmployeeWithKey("P102-空倍率");
    const providerCode = `kimi-${planProviderId.slice(0, 6)}`;
    const before = await accessConfigurationSideEffects(principalId);

    const response = await putAccessConfig(principalId, 1, "p102-empty-multiplier-put", [{
      provider_code: providerCode, quota_value: "1000000", enabled_model_ids: [planModelId],
    }]);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: "not_ready" });
    expect(await accessConfigurationSideEffects(principalId)).toEqual(before);
  });
});
