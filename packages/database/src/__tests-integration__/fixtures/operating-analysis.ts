import { randomUUID } from "node:crypto";
import type { createKysely } from "../../index.js";

export async function createAnalysisFixture(
  db: ReturnType<typeof createKysely>,
) {
  const enterpriseId = randomUUID(),
    adminId = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    project = randomUUID();
  await db
    .insertInto("enterprise")
    .values({ id: enterpriseId, name: "分析测试" })
    .execute();
  await db
    .insertInto("admin_user")
    .values({
      id: adminId,
      enterprise_id: enterpriseId,
      username: adminId,
      password_hash: "not-used",
      status: "ACTIVE",
    })
    .execute();
  await db
    .insertInto("principal")
    .values([
      {
        id: a,
        enterprise_id: enterpriseId,
        type: "EMPLOYEE",
        name: "员工 A",
        person_id: null,
        owner_person_id: null,
        department_label: null,
        created_at: new Date("2026-08-01T00:00:00+08:00"),
      },
      {
        id: b,
        enterprise_id: enterpriseId,
        type: "EMPLOYEE",
        name: "员工 B",
        person_id: null,
        owner_person_id: null,
        department_label: null,
        created_at: new Date("2026-09-01T00:00:00+08:00"),
      },
      {
        id: project,
        enterprise_id: enterpriseId,
        type: "PROJECT",
        name: "康派",
        person_id: null,
        owner_person_id: null,
        department_label: null,
      },
    ])
    .execute();
  const keys = new Map<string, string>();
  for (const id of [a, b, project]) {
    const key = randomUUID();
    keys.set(id, key);
    await db
      .insertInto("principal_key")
      .values({
        id: key,
        enterprise_id: enterpriseId,
        principal_id: id,
        key_prefix: "ql_test",
        key_digest: randomUUID(),
        allowed_model_ids: [],
      })
      .execute();
  }
  const resources = new Map<string, string>();
  for (const code of ["deepseek", "kimi", "zhipu"]) {
    const provider = await db
      .insertInto("provider")
      .values({
        enterprise_id: enterpriseId,
        code,
        name: code === "kimi" ? "Kimi" : code === "zhipu" ? "智谱" : "DeepSeek",
        adapter_type: "OPENAI_COMPATIBLE",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const resource = await db
      .insertInto("provider_resource")
      .values({
        enterprise_id: enterpriseId,
        provider_id: provider.id,
        name: code,
        mode: code === "deepseek" ? "API" : "CODING_PLAN",
        credential_type: "API_KEY",
        // F-P2-6：资源级期初不得早于资源创建时点——夹具资源为切换前既有资源。
        created_at: new Date("2026-08-01T00:00:00+08:00"),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    resources.set(code, resource.id);
  }
  return { db, enterpriseId, adminId, a, b, project, keys, resources };
}
export async function seedAnalysisUsage(
  t: Awaited<ReturnType<typeof createAnalysisFixture>>,
  principal: string,
  code: string,
  tokens: bigint,
  at: Date,
  cost = "0",
  quality = "PROVIDER_REPORTED",
  periodId: string | null = null,
) {
  const db = t.db;
  const request = randomUUID(),
    resource = t.resources.get(code)!;
  await db
    .insertInto("ai_request")
    .values({
      id: request,
      enterprise_id: t.enterpriseId,
      principal_id: principal,
      principal_key_id: t.keys.get(principal)!,
      protocol: "chat",
      unified_model: "analysis",
      status: "SUCCEEDED",
      started_at: at,
      finished_at: at,
    })
    .execute();
  const attempt = await db
    .insertInto("upstream_attempt")
    .values({
      enterprise_id: t.enterpriseId,
      ai_request_id: request,
      attempt_no: 1,
      provider_resource_id: resource,
      upstream_model: "analysis",
      http_status: 200,
      response_committed: true,
      finished_at: at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const event = await db
    .insertInto("usage_event")
    .values({
      enterprise_id: t.enterpriseId,
      ai_request_id: request,
      upstream_attempt_id: attempt.id,
      provider_resource_id: resource,
      input_tokens: tokens,
      output_tokens: 0n,
      cache_tokens: 0n,
      reasoning_tokens: 0n,
      usage_quality: quality,
      dedup_key: request,
      created_at: at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("ledger_line")
    .values({
      enterprise_id: t.enterpriseId,
      ai_request_id: request,
      upstream_attempt_id: attempt.id,
      usage_event_id: event.id,
      provider_resource_id: resource,
      principal_id: principal,
      resource_mode: code === "deepseek" ? "API" : "CODING_PLAN",
      raw_input_tokens: tokens,
      raw_output_tokens: 0n,
      raw_cache_tokens: 0n,
      deducted_quota: code === "deepseek" ? null : tokens,
      api_cost: code === "deepseek" ? cost : null,
      api_cost_status: code === "deepseek" ? "PRICED_USAGE" : "NOT_APPLICABLE",
      api_cost_currency: code === "deepseek" ? "CNY" : null,
      subscription_period_id: periodId,
      settled_at: at,
      created_at: at,
      usage_quality: quality,
    })
    .execute();
  await db
    .insertInto("ledger_transaction")
    .values({
      enterprise_id: t.enterpriseId,
      ai_request_id: request,
      principal_id: principal,
      total_input_tokens: tokens,
      total_output_tokens: 0n,
      total_cache_tokens: 0n,
      total_reasoning_tokens: 0n,
      total_deducted_quota: code === "deepseek" ? 0n : tokens,
      total_api_cost: code === "deepseek" ? cost : "0",
      usage_quality: quality,
      attempt_count: 1,
      status: "SETTLED",
      created_at: at,
    })
    .execute();
  return request;
}
