import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";

const IDS = {
  provider: "00000000-0000-4000-8000-000000000110",
  resource: "00000000-0000-4000-8000-000000000111",
  employee: "00000000-0000-4000-8000-000000000120",
  key: "00000000-0000-4000-8000-000000000121",
  flash: "00000000-0000-4000-8000-000000000130",
  pro: "00000000-0000-4000-8000-000000000131",
  flashRoute: "00000000-0000-4000-8000-000000000132",
  proRoute: "00000000-0000-4000-8000-000000000133",
  project: "00000000-0000-4000-8000-000000000140",
  flashRequest: "00000000-0000-4000-8000-000000000150",
  proRequest: "00000000-0000-4000-8000-000000000151",
  flashAttempt: "00000000-0000-4000-8000-000000000152",
  proAttempt: "00000000-0000-4000-8000-000000000153",
  flashUsage: "00000000-0000-4000-8000-000000000154",
  proUsage: "00000000-0000-4000-8000-000000000155",
  flashLine: "00000000-0000-4000-8000-000000000156",
  proLine: "00000000-0000-4000-8000-000000000157",
  flashTransaction: "00000000-0000-4000-8000-000000000158",
  proTransaction: "00000000-0000-4000-8000-000000000159",
} as const;

export async function seedPool043OperatingBill(
  db: Kysely<Database>,
  enterpriseId: string,
  _adminId: string,
  existingResourceId: string,
  now: Date,
): Promise<void> {
  const flashAt = new Date("2026-08-08T01:00:00.000Z");
  const proAt = new Date("2026-08-08T02:00:00.000Z");
  await db.insertInto("provider").values({
    id: IDS.provider, enterprise_id: enterpriseId, code: "pool043-deepseek",
    name: "DeepSeek", adapter_type: "deepseek",
    supported_protocols: JSON.stringify(["chat", "messages"]) as unknown as string[],
  }).execute();
  await db.insertInto("provider_resource").values({
    id: IDS.resource, enterprise_id: enterpriseId, provider_id: IDS.provider,
    name: "DeepSeek E2E API", mode: "API", credential_type: "API_KEY", status: "ACTIVE",
  }).execute();
  await db.insertInto("unified_model").values([
    { id: IDS.flash, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-flash", display_name: "DeepSeek V4 Flash" },
    { id: IDS.pro, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-pro", display_name: "DeepSeek V4 Pro" },
  ]).execute();
  await db.insertInto("model_route").values([
    { id: IDS.flashRoute, enterprise_id: enterpriseId, unified_model_id: IDS.flash,
      provider_resource_id: IDS.resource, upstream_model: "deepseek-v4-flash" },
    { id: IDS.proRoute, enterprise_id: enterpriseId, unified_model_id: IDS.pro,
      provider_resource_id: IDS.resource, upstream_model: "deepseek-v4-pro" },
  ]).execute();
  await db.insertInto("principal").values([
    { id: IDS.employee, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "于滔", department_label: "产品研发部" },
    { id: IDS.project, enterprise_id: enterpriseId, type: "PROJECT", name: "POOL-043 星河项目" },
  ]).execute();
  await db.insertInto("principal_key").values({
    id: IDS.key, enterprise_id: enterpriseId, principal_id: IDS.employee,
    key_prefix: "sk-pool043", key_digest: "pool043-e2e-digest-never-plaintext",
    allowed_model_ids: JSON.stringify([IDS.flash, IDS.pro]) as unknown as string[], status: "ACTIVE",
  }).execute();
  await db.insertInto("ai_request").values([
    { id: IDS.flashRequest, enterprise_id: enterpriseId, principal_id: IDS.employee,
      principal_key_id: IDS.key, protocol: "chat",
      unified_model: "qianliu-deepseek-deepseek-v4-flash", unified_model_id: IDS.flash,
      status: "SUCCEEDED", started_at: flashAt, finished_at: new Date(flashAt.getTime() + 500) },
    { id: IDS.proRequest, enterprise_id: enterpriseId, principal_id: IDS.employee,
      principal_key_id: IDS.key, protocol: "chat", unified_model: "ql-deepseek-v4-pro",
      unified_model_id: IDS.pro, status: "SUCCEEDED", started_at: proAt,
      finished_at: new Date(proAt.getTime() + 500) },
  ]).execute();
  await db.insertInto("upstream_attempt").values([
    { id: IDS.flashAttempt, ai_request_id: IDS.flashRequest, enterprise_id: enterpriseId,
      attempt_no: 1, provider_resource_id: IDS.resource, upstream_model: "deepseek-v4-flash",
      started_at: flashAt, finished_at: new Date(flashAt.getTime() + 500), http_status: 200,
      response_committed: true },
    { id: IDS.proAttempt, ai_request_id: IDS.proRequest, enterprise_id: enterpriseId,
      attempt_no: 1, provider_resource_id: IDS.resource, upstream_model: "deepseek-v4-pro",
      started_at: proAt, finished_at: new Date(proAt.getTime() + 500), http_status: 200,
      response_committed: true },
  ]).execute();
  await db.insertInto("usage_event").values([
    { id: IDS.flashUsage, ai_request_id: IDS.flashRequest, enterprise_id: enterpriseId,
      upstream_attempt_id: IDS.flashAttempt, provider_resource_id: IDS.resource,
      input_tokens: 150n, output_tokens: 30n, cache_tokens: 20n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: "pool043-e2e-flash", created_at: flashAt },
    { id: IDS.proUsage, ai_request_id: IDS.proRequest, enterprise_id: enterpriseId,
      upstream_attempt_id: IDS.proAttempt, provider_resource_id: IDS.resource,
      input_tokens: 200n, output_tokens: 50n, cache_tokens: 40n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: "pool043-e2e-pro", created_at: proAt },
  ]).execute();
  await db.insertInto("ledger_line").values([
    { id: IDS.flashLine, ai_request_id: IDS.flashRequest, enterprise_id: enterpriseId,
      usage_event_id: IDS.flashUsage, upstream_attempt_id: IDS.flashAttempt,
      provider_resource_id: IDS.resource, principal_id: IDS.employee, resource_mode: "API",
      raw_input_tokens: 150n, raw_output_tokens: 30n, raw_cache_tokens: 20n,
      deducted_quota: null, api_cost: "3.2", usage_quality: "PROVIDER_REPORTED", created_at: flashAt },
    { id: IDS.proLine, ai_request_id: IDS.proRequest, enterprise_id: enterpriseId,
      usage_event_id: IDS.proUsage, upstream_attempt_id: IDS.proAttempt,
      provider_resource_id: IDS.resource, principal_id: IDS.employee, resource_mode: "API",
      raw_input_tokens: 200n, raw_output_tokens: 50n, raw_cache_tokens: 40n,
      deducted_quota: null, api_cost: "4.8", usage_quality: "PROVIDER_REPORTED", created_at: proAt },
  ]).execute();
  await db.insertInto("ledger_transaction").values([
    { id: IDS.flashTransaction, ai_request_id: IDS.flashRequest, enterprise_id: enterpriseId,
      principal_id: IDS.employee, total_input_tokens: 150n, total_output_tokens: 30n,
      total_cache_tokens: 20n, total_deducted_quota: 0n, total_api_cost: "3.2",
      usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED", created_at: flashAt },
    { id: IDS.proTransaction, ai_request_id: IDS.proRequest, enterprise_id: enterpriseId,
      principal_id: IDS.employee, total_input_tokens: 200n, total_output_tokens: 50n,
      total_cache_tokens: 40n, total_deducted_quota: 0n, total_api_cost: "4.8",
      usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED", created_at: proAt },
  ]).execute();
  await db.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: enterpriseId, provider_resource_id: IDS.resource, version: 1,
    source: "PROVIDER_SYNC", collected_at: new Date("2026-08-08T03:00:00.000Z"),
    currency: "CNY", current_balance: "1000", current_period_cost: "8",
  }).execute();
  await db.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: enterpriseId, provider_resource_id: existingResourceId, version: 1,
    source: "PROVIDER_SYNC", collected_at: new Date(now.getTime() - 1_000),
    currency: "CNY", recharge_amount: "10000", current_balance: "4800",
    current_period_cost: "5200",
  }).execute();
}
