#!/usr/bin/env tsx
/**
 * M5 Playwright 确定性夹具。
 *
 * 只允许连接本机且数据库名以 `_e2e` 结尾；随后清空业务表并写入固定 ID 数据。
 * 测试数据与试点库物理隔离，禁止在共享/生产数据库运行。
 */
import { createKysely, migrateToLatest } from "@qianliu/database";
import { sql } from "kysely";
import { hashPassword } from "../auth/password.js";

const IDS = {
  enterprise: "00000000-0000-4000-8000-000000000001",
  admin: "00000000-0000-4000-8000-000000000002",
  provider: "00000000-0000-4000-8000-000000000010",
  resource: "00000000-0000-4000-8000-000000000011",
  isolatedResource: "00000000-0000-4000-8000-000000000012",
  model: "00000000-0000-4000-8000-000000000013",
  route: "00000000-0000-4000-8000-000000000014",
  principal: "00000000-0000-4000-8000-000000000020",
  key: "00000000-0000-4000-8000-000000000021",
  grant: "00000000-0000-4000-8000-000000000022",
  counter: "00000000-0000-4000-8000-000000000023",
  request: "00000000-0000-4000-8000-000000000030",
  candidate1: "00000000-0000-4000-8000-000000000031",
  candidate2: "00000000-0000-4000-8000-000000000032",
  attempt1: "00000000-0000-4000-8000-000000000033",
  attempt2: "00000000-0000-4000-8000-000000000034",
  usage1: "00000000-0000-4000-8000-000000000035",
  usage2: "00000000-0000-4000-8000-000000000036",
  billingRule: "00000000-0000-4000-8000-000000000037",
  ledgerLine1: "00000000-0000-4000-8000-000000000038",
  ledgerLine2: "00000000-0000-4000-8000-000000000039",
  transaction: "00000000-0000-4000-8000-000000000040",
  forecast: "00000000-0000-4000-8000-000000000041",
  policy: "00000000-0000-4000-8000-000000000042",
  decision: "00000000-0000-4000-8000-000000000043",
  alert: "00000000-0000-4000-8000-000000000044",
  streamRequest: "00000000-0000-4000-8000-000000000050",
  streamCandidate: "00000000-0000-4000-8000-000000000051",
  streamAttempt: "00000000-0000-4000-8000-000000000052",
  streamUsage: "00000000-0000-4000-8000-000000000053",
  streamLedgerLine: "00000000-0000-4000-8000-000000000054",
  streamTransaction: "00000000-0000-4000-8000-000000000055",
} as const;

function assertDedicatedDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const databaseName = url.pathname.slice(1);
  if (!local || !databaseName.endsWith("_e2e")) {
    throw new Error(
      "拒绝写入：M5 E2E 夹具只允许本机且数据库名以 `_e2e` 结尾（例如 qianliu_e2e）",
    );
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL 未设置");
  assertDedicatedDatabase(databaseUrl);

  const db = createKysely(databaseUrl);
  try {
    await migrateToLatest(db);
    await sql`
      TRUNCATE TABLE
        alert_event, reconciliation_discrepancy, reconciliation_run,
        dispatch_decision, dispatch_policy, supply_forecast, concurrency_lease,
        ledger_transaction, ledger_line, billing_rule, usage_event, upstream_attempt,
        route_candidate, ai_request, resource_status_event, model_route, unified_model,
        quota_counter, principal_grant, principal_key, employee_login, principal,
        provider_resource_operating_snapshot,
        provider_resource, provider, operation_log, admin_session, admin_user, enterprise
      RESTART IDENTITY CASCADE
    `.execute(db);

    const now = new Date();
    const finishedAt = new Date(now.getTime() + 2_500);
    const passwordHash = await hashPassword("admin123");

    await db
      .insertInto("enterprise")
      .values({ id: IDS.enterprise, name: "仟流 M5 E2E 企业" })
      .execute();
    await db
      .insertInto("admin_user")
      .values({
        id: IDS.admin,
        enterprise_id: IDS.enterprise,
        username: "admin",
        password_hash: passwordHash,
        status: "ACTIVE",
      })
      .execute();
    await db
      .insertInto("provider")
      .values({
        id: IDS.provider,
        enterprise_id: IDS.enterprise,
        code: "zhipu",
        name: "智谱 E2E",
        adapter_type: "zhipu",
        supported_protocols: JSON.stringify(["chat", "messages"]) as unknown as string[],
      })
      .execute();
    await db
      .insertInto("provider_resource")
      .values([
        {
          id: IDS.resource,
          enterprise_id: IDS.enterprise,
          provider_id: IDS.provider,
          name: "E2E 智谱主资源",
          mode: "API",
          credential_type: "API_KEY",
          credential_fingerprint: "sha256:e2e-safe-fingerprint",
          credential_version: 1,
          upstream_models: JSON.stringify(["glm-4.6", "glm-4.5"]) as unknown as string[],
          concurrency_limit: 8,
          status: "ACTIVE",
        },
        {
          id: IDS.isolatedResource,
          enterprise_id: IDS.enterprise,
          provider_id: IDS.provider,
          name: "E2E 待恢复资源",
          mode: "CODING_PLAN",
          credential_type: "SUBSCRIPTION_SESSION",
          credential_fingerprint: "sha256:e2e-isolated-fingerprint",
          credential_version: 1,
          upstream_models: JSON.stringify(["glm-4.6"]) as unknown as string[],
          concurrency_limit: 2,
          status: "CREDENTIAL_INVALID",
          refresh_error_classification: "TOKEN_EXPIRED",
        },
      ])
      .execute();
    await db
      .insertInto("unified_model")
      .values({
        id: IDS.model,
        enterprise_id: IDS.enterprise,
        alias: "qianliu-glm",
        display_name: "仟流 GLM",
        required_capabilities: JSON.stringify(["chat"]) as unknown as string[],
      })
      .execute();
    await db
      .insertInto("model_route")
      .values({
        id: IDS.route,
        enterprise_id: IDS.enterprise,
        unified_model_id: IDS.model,
        provider_resource_id: IDS.resource,
        upstream_model: "glm-4.6",
        priority: 10,
        weight: 5,
        enabled: true,
      })
      .execute();
    await db
      .insertInto("principal")
      .values({
        id: IDS.principal,
        enterprise_id: IDS.enterprise,
        type: "EMPLOYEE",
        name: "E2E 固定员工",
        department_label: "研发部",
      })
      .execute();
    await db
      .insertInto("principal_key")
      .values({
        id: IDS.key,
        enterprise_id: IDS.enterprise,
        principal_id: IDS.principal,
        key_prefix: "sk-e2e01",
        key_digest: "e2e-digest-only-never-plaintext",
        allowed_model_ids: JSON.stringify([IDS.model]) as unknown as string[],
        status: "ACTIVE",
      })
      .execute();
    await db
      .insertInto("principal_grant")
      .values({
        id: IDS.grant,
        enterprise_id: IDS.enterprise,
        principal_id: IDS.principal,
        provider: "zhipu",
        model_alias: "qianliu-glm",
        quota_value: 100_000n,
        allow_overage: true,
      })
      .execute();
    await db
      .insertInto("quota_counter")
      .values({
        id: IDS.counter,
        grant_id: IDS.grant,
        used_value: 2_000n,
        overage_value: 100n,
      })
      .execute();
    await db
      .insertInto("ai_request")
      .values([
        {
          id: IDS.request,
          enterprise_id: IDS.enterprise,
          principal_id: IDS.principal,
          principal_key_id: IDS.key,
          idempotency_key: "m5-e2e-fixed-request",
          protocol: "openai",
          unified_model: "qianliu-glm",
          stream: false,
          status: "SUCCEEDED",
          client_id: "m5-playwright",
          started_at: now,
          finished_at: finishedAt,
        },
        {
          id: IDS.streamRequest,
          enterprise_id: IDS.enterprise,
          principal_id: IDS.principal,
          principal_key_id: IDS.key,
          idempotency_key: "m5-e2e-stream-interrupted",
          protocol: "openai",
          unified_model: "qianliu-glm",
          stream: true,
          status: "FAILED",
          client_id: "m5-playwright",
          started_at: new Date(now.getTime() + 5_000),
          finished_at: new Date(now.getTime() + 6_000),
          error_classification: "STREAM_INTERRUPTED",
          error_code: "UPSTREAM_STREAM_CLOSED",
        },
      ])
      .execute();
    await db
      .insertInto("route_candidate")
      .values([
        {
          id: IDS.candidate1,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          provider_resource_id: IDS.resource,
          upstream_model: "glm-4.6",
          priority: 10,
          weight: 5,
          selected: true,
          score_factors: {
            static_priority: 10,
            load: 0.25,
            error_rate: 0.01,
            latency_ms: 620,
            quota_remaining: 0.8,
            reset_at: "2026-07-29T00:00:00.000Z",
            cost: 0.2,
            affinity: 1,
          },
          total_score: "0.95",
          reason_code: "SELECTED",
        },
        {
          id: IDS.candidate2,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          provider_resource_id: IDS.resource,
          upstream_model: "glm-4.5",
          priority: 20,
          weight: 1,
          selected: false,
          score_factors: { static_priority: 20, error_rate: 0.03, latency_ms: 900 },
          total_score: "0.72",
          reason_code: "LOWER_SCORE",
        },
        {
          id: IDS.streamCandidate,
          ai_request_id: IDS.streamRequest,
          enterprise_id: IDS.enterprise,
          provider_resource_id: IDS.resource,
          upstream_model: "glm-4.6",
          priority: 10,
          weight: 5,
          selected: true,
          score_factors: { static_priority: 10, affinity: 1 },
          total_score: "0.93",
          reason_code: "SELECTED",
        },
      ])
      .execute();
    await db
      .insertInto("upstream_attempt")
      .values([
        {
          id: IDS.attempt1,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          attempt_no: 1,
          provider_resource_id: IDS.resource,
          upstream_model: "glm-4.6",
          started_at: now,
          finished_at: new Date(now.getTime() + 700),
          http_status: 500,
          error_classification: "UPSTREAM_5XX",
          error_code: "E2E_UPSTREAM_FAILURE",
          response_committed: false,
          switch_reason: "upstream_5xx",
        },
        {
          id: IDS.attempt2,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          attempt_no: 2,
          provider_resource_id: IDS.resource,
          upstream_model: "glm-4.6",
          started_at: new Date(now.getTime() + 750),
          first_byte_at: new Date(now.getTime() + 1_100),
          finished_at: finishedAt,
          http_status: 200,
          response_committed: true,
        },
        {
          id: IDS.streamAttempt,
          ai_request_id: IDS.streamRequest,
          enterprise_id: IDS.enterprise,
          attempt_no: 1,
          provider_resource_id: IDS.resource,
          upstream_model: "glm-4.6",
          started_at: new Date(now.getTime() + 5_000),
          first_byte_at: new Date(now.getTime() + 5_200),
          finished_at: new Date(now.getTime() + 6_000),
          http_status: 502,
          error_classification: "STREAM_INTERRUPTED",
          error_code: "UPSTREAM_STREAM_CLOSED",
          response_committed: true,
          switch_reason: null,
        },
      ])
      .execute();
    await db
      .insertInto("usage_event")
      .values([
        {
          id: IDS.usage1,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          upstream_attempt_id: IDS.attempt1,
          provider_resource_id: IDS.resource,
          input_tokens: 40n,
          output_tokens: 10n,
          cache_tokens: 5n,
          usage_quality: "PROVIDER_REPORTED",
          dedup_key: "m5-e2e-attempt-1",
        },
        {
          id: IDS.usage2,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          upstream_attempt_id: IDS.attempt2,
          provider_resource_id: IDS.resource,
          input_tokens: 160n,
          output_tokens: 90n,
          cache_tokens: 15n,
          usage_quality: "PROVIDER_REPORTED",
          dedup_key: "m5-e2e-attempt-2",
        },
        {
          id: IDS.streamUsage,
          ai_request_id: IDS.streamRequest,
          enterprise_id: IDS.enterprise,
          upstream_attempt_id: IDS.streamAttempt,
          provider_resource_id: IDS.resource,
          input_tokens: 20n,
          output_tokens: 5n,
          cache_tokens: 0n,
          usage_quality: "PROVIDER_REPORTED",
          dedup_key: "m5-e2e-stream-attempt",
        },
      ])
      .execute();
    await db
      .insertInto("billing_rule")
      .values({
        id: IDS.billingRule,
        enterprise_id: IDS.enterprise,
        provider_resource_id: IDS.resource,
        upstream_model: "glm-4.6",
        rule_type: "API_PRICE",
        rule_version: "e2e-v1",
        effective_from: new Date(now.getTime() - 86_400_000),
        cache_hit_price: "0.1",
        cache_miss_price: "0.2",
        output_price: "0.4",
        currency: "CNY",
        priority: 10,
        source: "M5_E2E_SEED",
      })
      .execute();
    await db
      .insertInto("ledger_line")
      .values([
        {
          id: IDS.ledgerLine1,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          usage_event_id: IDS.usage1,
          upstream_attempt_id: IDS.attempt1,
          provider_resource_id: IDS.resource,
          principal_id: IDS.principal,
          resource_mode: "API",
          raw_input_tokens: 40n,
          raw_output_tokens: 10n,
          raw_cache_tokens: 5n,
          deducted_quota: 55n,
          api_cost: "45.00000000",
          usage_quality: "PROVIDER_REPORTED",
          billing_rule_id: IDS.billingRule,
          rule_version: "e2e-v1",
          multiplier: "1",
        },
        {
          id: IDS.streamLedgerLine,
          ai_request_id: IDS.streamRequest,
          enterprise_id: IDS.enterprise,
          usage_event_id: IDS.streamUsage,
          upstream_attempt_id: IDS.streamAttempt,
          provider_resource_id: IDS.resource,
          principal_id: IDS.principal,
          resource_mode: "API",
          raw_input_tokens: 20n,
          raw_output_tokens: 5n,
          raw_cache_tokens: 0n,
          deducted_quota: 25n,
          api_cost: "1.00000000",
          usage_quality: "PROVIDER_REPORTED",
          billing_rule_id: IDS.billingRule,
          rule_version: "e2e-v1",
          multiplier: "1",
        },
        {
          id: IDS.ledgerLine2,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          usage_event_id: IDS.usage2,
          upstream_attempt_id: IDS.attempt2,
          provider_resource_id: IDS.resource,
          principal_id: IDS.principal,
          resource_mode: "API",
          raw_input_tokens: 160n,
          raw_output_tokens: 90n,
          raw_cache_tokens: 15n,
          deducted_quota: 265n,
          api_cost: "80.00000000",
          usage_quality: "PROVIDER_REPORTED",
          billing_rule_id: IDS.billingRule,
          rule_version: "e2e-v1",
          multiplier: "1",
        },
      ])
      .execute();
    await db
      .insertInto("ledger_transaction")
      .values([
        {
          id: IDS.transaction,
          ai_request_id: IDS.request,
          enterprise_id: IDS.enterprise,
          principal_id: IDS.principal,
          total_input_tokens: 200n,
          total_output_tokens: 100n,
          total_cache_tokens: 20n,
          total_deducted_quota: 320n,
          total_api_cost: "125.00000000",
          overage: true,
          usage_quality: "PROVIDER_REPORTED",
          attempt_count: 2,
          status: "SETTLED",
        },
        {
          id: IDS.streamTransaction,
          ai_request_id: IDS.streamRequest,
          enterprise_id: IDS.enterprise,
          principal_id: IDS.principal,
          total_input_tokens: 20n,
          total_output_tokens: 5n,
          total_cache_tokens: 0n,
          total_deducted_quota: 25n,
          total_api_cost: "1.00000000",
          overage: false,
          usage_quality: "PROVIDER_REPORTED",
          attempt_count: 1,
          status: "SETTLED",
        },
      ])
      .execute();
    await db
      .insertInto("provider_resource_operating_snapshot")
      .values({
        enterprise_id: IDS.enterprise,
        provider_resource_id: IDS.resource,
        version: 1,
        source: "PROVIDER_SYNC",
        collected_at: new Date(now.getTime() - 1_000),
        currency: "CNY",
        recharge_amount: "10000",
        current_balance: "4800",
        current_period_cost: "5200",
      })
      .execute();
    await db
      .insertInto("supply_forecast")
      .values({
        id: IDS.forecast,
        enterprise_id: IDS.enterprise,
        provider_resource_id: IDS.resource,
        rate_1h: "100",
        rate_24h: "2400",
        rate_7d: "16800",
        forecast_exhaust_at: new Date(now.getTime() + 12 * 3_600_000),
        next_recover_at: new Date(now.getTime() + 72 * 3_600_000),
        coverage_hours: "12",
        remaining_quota: "4800",
        confidence: "HIGH",
        data_points: 168,
        algorithm_version: "e2e-v1",
        snapshot_at: now,
      })
      .execute();
    await db
      .insertInto("dispatch_policy")
      .values({
        id: IDS.policy,
        enterprise_id: IDS.enterprise,
        status: "PUBLISHED",
        match_unified_model: "qianliu-glm",
        match_resource_mode: "API",
        match_provider_resource_id: IDS.resource,
        action: "ALLOW",
        policy_version: "e2e-v1",
        priority: 10,
        description: "M5 E2E 固定调度策略",
        source: "M5_E2E_SEED",
      })
      .execute();
    await db
      .insertInto("dispatch_decision")
      .values({
        id: IDS.decision,
        enterprise_id: IDS.enterprise,
        ai_request_id: IDS.request,
        dispatch_input: {
          selectedResourceId: IDS.resource,
          candidateResourceIds: [IDS.resource],
          priceMultiplier: 1,
        },
        matched_policy_id: IDS.policy,
        matched_policy_version: "e2e-v1",
        matched_policy_action: "ALLOW",
        final_action: "ALLOW",
        reason_code: "POLICY_MATCHED",
        reason_detail: "命中 M5 E2E 固定策略",
        counterfactual_cost: "140",
        actual_cost: "125",
        dispatch_saving: "15",
        saving_calculable: true,
      })
      .execute();
    await db
      .insertInto("alert_event")
      .values({
        id: IDS.alert,
        enterprise_id: IDS.enterprise,
        alert_key: `CREDENTIAL_INVALID:CREDENTIAL_INVALID:${IDS.isolatedResource}`,
        domain: "CREDENTIAL_INVALID",
        signal: "credential_invalid",
        severity: "HIGH",
        title: "凭证失效：E2E 待恢复资源",
        detail: "E2E 固定告警：凭证已失效，需受控恢复",
        resource_id: IDS.isolatedResource,
        status: "OPEN",
      })
      .execute();

    console.log(
      JSON.stringify({
        status: "ok",
        enterpriseId: IDS.enterprise,
        requestId: IDS.request,
        principalId: IDS.principal,
      }),
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error("M5 E2E seed 失败", error);
  process.exitCode = 1;
});
