import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";

const IDS = {
  provider: "00000000-0000-4000-8000-000000000210",
  resource: "00000000-0000-4000-8000-000000000211",
  flash: "00000000-0000-4000-8000-000000000130",
  pro: "00000000-0000-4000-8000-000000000131",
  flashRequest: "00000000-0000-4000-8000-000000000214",
  proRequest: "00000000-0000-4000-8000-000000000215",
  flashAttempt: "00000000-0000-4000-8000-000000000216",
  proAttempt: "00000000-0000-4000-8000-000000000217",
  flashUsage: "00000000-0000-4000-8000-000000000218",
  proUsage: "00000000-0000-4000-8000-000000000219",
} as const;

export async function seedPool042Dashboard(
  db: Kysely<Database>, enterpriseId: string, principalId: string, keyId: string, now: Date,
): Promise<void> {
  const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const monthStart = Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), 1) -
    8 * 60 * 60 * 1000;
  const flashAt = new Date(Math.max(monthStart, now.getTime() - 60 * 60 * 1000));
  const proAt = new Date(Math.max(monthStart, now.getTime() - 30 * 60 * 1000));
  await db.insertInto("provider").values({
    id: IDS.provider, enterprise_id: enterpriseId, code: "pool042-deepseek",
    name: "DeepSeek Token E2E", adapter_type: "deepseek",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: IDS.resource, enterprise_id: enterpriseId, provider_id: IDS.provider,
    name: "DeepSeek Token E2E API", mode: "API", credential_type: "API_KEY", status: "ACTIVE",
  }).execute();
  await db.insertInto("billing_rule").values([
    {
      enterprise_id: enterpriseId, provider_resource_id: IDS.resource,
      upstream_model: "deepseek-v4-flash", rule_type: "API_PRICE", rule_version: "pool042-flash",
      effective_from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      cache_hit_price: "0.001", cache_miss_price: "0.002", output_price: "0.004",
      currency: "CNY", enabled: true,
    },
    {
      enterprise_id: enterpriseId, provider_resource_id: IDS.resource,
      upstream_model: "deepseek-v4-pro", rule_type: "API_PRICE", rule_version: "pool042-pro",
      effective_from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      cache_hit_price: "0.001", cache_miss_price: "0.003", output_price: "0.006",
      currency: "CNY", enabled: true,
    },
  ]).execute();
  await db.insertInto("ai_request").values([
    { id: IDS.flashRequest, enterprise_id: enterpriseId, principal_id: principalId,
      principal_key_id: keyId, protocol: "chat", unified_model: "legacy-pool042-flash",
      unified_model_id: IDS.flash, status: "SUCCEEDED", started_at: flashAt, finished_at: flashAt },
    { id: IDS.proRequest, enterprise_id: enterpriseId, principal_id: principalId,
      principal_key_id: keyId, protocol: "chat", unified_model: "legacy-pool042-pro",
      unified_model_id: IDS.pro, status: "SUCCEEDED", started_at: proAt, finished_at: proAt },
  ]).execute();
  await db.insertInto("upstream_attempt").values([
    { id: IDS.flashAttempt, ai_request_id: IDS.flashRequest, enterprise_id: enterpriseId,
      attempt_no: 1, provider_resource_id: IDS.resource, upstream_model: "deepseek-v4-flash",
      started_at: flashAt, finished_at: flashAt, http_status: 200, response_committed: true },
    { id: IDS.proAttempt, ai_request_id: IDS.proRequest, enterprise_id: enterpriseId,
      attempt_no: 1, provider_resource_id: IDS.resource, upstream_model: "deepseek-v4-pro",
      started_at: proAt, finished_at: proAt, http_status: 200, response_committed: true },
  ]).execute();
  await db.insertInto("usage_event").values([
    { id: IDS.flashUsage, ai_request_id: IDS.flashRequest, enterprise_id: enterpriseId,
      upstream_attempt_id: IDS.flashAttempt, provider_resource_id: IDS.resource,
      input_tokens: 150n, output_tokens: 30n, cache_tokens: 20n, reasoning_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: "pool042-e2e-flash", created_at: flashAt },
    { id: IDS.proUsage, ai_request_id: IDS.proRequest, enterprise_id: enterpriseId,
      upstream_attempt_id: IDS.proAttempt, provider_resource_id: IDS.resource,
      input_tokens: 200n, output_tokens: 50n, cache_tokens: 40n, reasoning_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: "pool042-e2e-pro", created_at: proAt },
  ]).execute();
  await db.insertInto("ledger_line").values([
    { ai_request_id: IDS.flashRequest, enterprise_id: enterpriseId, usage_event_id: IDS.flashUsage,
      upstream_attempt_id: IDS.flashAttempt, provider_resource_id: IDS.resource,
      principal_id: principalId, resource_mode: "API", raw_input_tokens: 150n,
      raw_output_tokens: 30n, raw_cache_tokens: 20n, raw_reasoning_tokens: 0n,
      api_cost: "3.2", usage_quality: "PROVIDER_REPORTED", created_at: flashAt },
    { ai_request_id: IDS.proRequest, enterprise_id: enterpriseId, usage_event_id: IDS.proUsage,
      upstream_attempt_id: IDS.proAttempt, provider_resource_id: IDS.resource,
      principal_id: principalId, resource_mode: "API", raw_input_tokens: 200n,
      raw_output_tokens: 50n, raw_cache_tokens: 40n, raw_reasoning_tokens: 0n,
      api_cost: "4.8", usage_quality: "PROVIDER_REPORTED", created_at: proAt },
  ]).execute();
  await db.insertInto("provider_resource_operating_snapshot").values([
    {
      enterprise_id: enterpriseId, provider_resource_id: IDS.resource, version: 1,
      source: "PROVIDER_SYNC", collected_at: new Date(monthStart),
      currency: "CNY", current_balance: "1008",
    },
    {
      enterprise_id: enterpriseId, provider_resource_id: IDS.resource, version: 2,
      source: "PROVIDER_SYNC", collected_at: new Date(now.getTime() - 60_000),
      currency: "CNY", current_balance: "1000", current_period_cost: "8",
    },
  ]).execute();
}
