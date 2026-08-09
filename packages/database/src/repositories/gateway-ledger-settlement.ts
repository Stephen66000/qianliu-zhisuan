import { Decimal } from "decimal.js";
import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "../kysely.js";
import type {
  CreateAttemptInput,
  CreateLedgerTransactionInput,
  CreateUsageLedgerLineInput,
  FinalizeLedgerSettlementInput,
  LedgerLine,
  LedgerTransaction,
  UpstreamAttempt,
  UsageLedgerLineResult,
} from "./gateway-ledger-types.js";
import {
  assertAttemptMatches,
  assertLineMatches,
  assertTransactionMatches,
  assertUsageLineInputCoherent,
  assertUsageMatches,
  GatewayLedgerSettlementConflictError,
} from "./gateway-ledger-settlement-assertions.js";
import { guardOperatingBillLedgerWrite } from "./operating-bill-write-barrier.js";
import { settleQuota as calculateSettledQuota } from "@qianliu/domain";

export {
  assertAttemptMatches,
  assertLineMatches,
  assertTransactionMatches,
  assertUsageLineInputCoherent,
  assertUsageMatches,
  GatewayLedgerSettlementConflictError,
  optionalBigintEquals,
  optionalDecimalEquals,
  stableJson,
} from "./gateway-ledger-settlement-assertions.js";

/** 多 Attempt 请求的 transaction 口径必须显式保留混合质量，不能由行顺序决定。 */
export function summarizeLedgerUsageQuality(
  lines: ReadonlyArray<Pick<LedgerLine, "usage_quality">>,
): string {
  const qualities = [...new Set(lines.map((line) => line.usage_quality))].sort();
  if (qualities.length === 0) return "UNKNOWN";
  return qualities.length === 1 ? qualities[0]! : `MIXED:${qualities.join("+")}`;
}

/** 上游访问前持久化唯一 attempt，但不在网络调用期间占用数据库连接。 */
export async function createGuardedUpstreamAttempt(
  db: Kysely<Database>,
  input: CreateAttemptInput,
): Promise<UpstreamAttempt> {
  const startedAt = new Date();
  return db.transaction().execute(async (trx) => {
    await lockInProgressRequest(trx, input.enterprise_id, input.ai_request_id);
    const resource = await trx.selectFrom("provider_resource").select("id")
      .where("id", "=", input.provider_resource_id)
      .where("enterprise_id", "=", input.enterprise_id).executeTakeFirst();
    if (!resource) throw new GatewayLedgerSettlementConflictError("attempt_resource_conflict");
    const existing = await trx.selectFrom("upstream_attempt").selectAll()
      .where("enterprise_id", "=", input.enterprise_id)
      .where("ai_request_id", "=", input.ai_request_id)
      .where("attempt_no", "=", input.attempt_no)
      .executeTakeFirst();
    if (existing) {
      assertAttemptMatches(existing, input);
      throw new GatewayLedgerSettlementConflictError("attempt_already_started");
    }
    await guardOperatingBillLedgerWrite(trx, input.enterprise_id, startedAt);
    return trx.insertInto("upstream_attempt").values({
      ai_request_id: input.ai_request_id,
      enterprise_id: input.enterprise_id,
      attempt_no: input.attempt_no,
      provider_resource_id: input.provider_resource_id,
      upstream_model: input.upstream_model,
      started_at: startedAt,
    }).returningAll().executeTakeFirstOrThrow();
  });
}

/**
 * usage_event 与对应 ledger_line 同一事务提交。所有结算写入口先锁 request：
 * finalize 发布 terminal 后，任何迟到的 attempt/usage 都会 fail-closed。
 */
export async function createUsageLedgerLineAtomically(
  db: Kysely<Database>,
  input: CreateUsageLedgerLineInput,
): Promise<UsageLedgerLineResult> {
  return db.transaction().execute(async (trx) => {
    assertUsageLineInputCoherent(input);
    const request = await lockInProgressRequest(
      trx, input.usage.enterprise_id, input.usage.ai_request_id,
    );
    if (request.principal_id !== input.ledger_line.principal_id) {
      throw new GatewayLedgerSettlementConflictError("settlement_principal_conflict");
    }
    const attempt = await trx.selectFrom("upstream_attempt")
      .innerJoin("provider_resource", "provider_resource.id", "upstream_attempt.provider_resource_id")
      .select(["upstream_attempt.id", "provider_resource.mode"])
      .where("upstream_attempt.id", "=", input.usage.upstream_attempt_id)
      .where("upstream_attempt.enterprise_id", "=", input.usage.enterprise_id)
      .where("upstream_attempt.ai_request_id", "=", input.usage.ai_request_id)
      .where("upstream_attempt.provider_resource_id", "=", input.usage.provider_resource_id)
      .where("provider_resource.enterprise_id", "=", input.usage.enterprise_id)
      .executeTakeFirst();
    if (!attempt) throw new GatewayLedgerSettlementConflictError("usage_attempt_conflict");
    if (attempt.mode !== input.ledger_line.resource_mode) {
      throw new GatewayLedgerSettlementConflictError("settlement_resource_mode_conflict");
    }
    let usage = await trx.selectFrom("usage_event").selectAll()
      .where("dedup_key", "=", input.usage.dedup_key).forUpdate().executeTakeFirst();
    if (!usage) {
      const createdAt = new Date();
      await guardOperatingBillLedgerWrite(trx, input.usage.enterprise_id, createdAt);
      usage = await trx.insertInto("usage_event").values({
        ai_request_id: input.usage.ai_request_id,
        enterprise_id: input.usage.enterprise_id,
        upstream_attempt_id: input.usage.upstream_attempt_id,
        provider_resource_id: input.usage.provider_resource_id,
        input_tokens: input.usage.input_tokens,
        output_tokens: input.usage.output_tokens,
        cache_tokens: input.usage.cache_tokens,
        reasoning_tokens: input.usage.reasoning_tokens ?? 0n,
        usage_quality: input.usage.usage_quality,
        dedup_key: input.usage.dedup_key,
        upstream_usage_id: input.usage.upstream_usage_id ?? null,
        created_at: createdAt,
      }).returningAll().executeTakeFirstOrThrow();
    }
    assertUsageMatches(usage, input);
    const lines = await trx.selectFrom("ledger_line").selectAll()
      .where("usage_event_id", "=", usage.id).orderBy("created_at", "asc")
      .orderBy("id", "asc").execute();
    if (lines.length > 1) throw new GatewayLedgerSettlementConflictError("duplicate_ledger_line");
    if (lines[0]) {
      assertLineMatches(lines[0], input);
      return { usage, line: lines[0], created: false };
    }

    // 历史 usage-only 自愈必须保留 usage 的事实月份，不能按修复执行时间跨月改账。
    await guardOperatingBillLedgerWrite(trx, input.usage.enterprise_id, usage.created_at);
    const line = await trx.insertInto("ledger_line").values({
      ...input.ledger_line,
      usage_event_id: usage.id,
      raw_reasoning_tokens: input.ledger_line.raw_reasoning_tokens ?? 0n,
      deducted_quota: input.ledger_line.deducted_quota ?? null,
      api_cost: input.ledger_line.api_cost ?? null,
      billing_rule_id: input.ledger_line.billing_rule_id ?? null,
      rule_version: input.ledger_line.rule_version ?? null,
      multiplier: input.ledger_line.multiplier ?? null,
      billing_rule_snapshot: input.ledger_line.billing_rule_snapshot ?? null,
      created_at: usage.created_at,
    }).returningAll().executeTakeFirstOrThrow();
    return { usage, line, created: true };
  });
}

/**
 * 请求汇总与 terminal status 同一事务。锁内重新核验 PostgreSQL 明细聚合，
 * 不信任事务外旧快照；terminal status 是关账的 completion barrier。
 */
export async function finalizeLedgerSettlementAtomically(
  db: Kysely<Database>,
  input: FinalizeLedgerSettlementInput,
): Promise<LedgerTransaction> {
  const finishedAt = new Date();
  return db.transaction().execute(async (trx) => {
    const request = await trx.selectFrom("ai_request").select([
      "id", "status", "principal_id", "error_classification", "error_code",
    ])
      .where("id", "=", input.ai_request_id)
      .where("enterprise_id", "=", input.enterprise_id)
      .forUpdate().executeTakeFirst();
    if (!request) throw new GatewayLedgerSettlementConflictError("settlement_request_not_found");
    if (request.principal_id !== input.principal_id) {
      throw new GatewayLedgerSettlementConflictError("settlement_principal_conflict");
    }
    const existing = await trx.selectFrom("ledger_transaction").selectAll()
      .where("ai_request_id", "=", input.ai_request_id).executeTakeFirst();
    if (request.status !== "IN_PROGRESS") {
      if (!existing || request.status !== input.request_status) {
        throw new GatewayLedgerSettlementConflictError("settlement_terminal_conflict");
      }
      if (request.error_classification !== (input.error_classification ?? null)
        || request.error_code !== (input.error_code ?? null)) {
        throw new GatewayLedgerSettlementConflictError("settlement_terminal_conflict");
      }
      assertTransactionMatches(existing, input);
      return existing;
    }

    await assertRequestReadyToFinalize(trx, input);
    await settleRequestAccounting(trx, input, finishedAt);
    const transaction = existing ?? await insertLedgerTransaction(trx, input);
    assertTransactionMatches(transaction, input);
    const updated = await trx.updateTable("ai_request").set({
      status: input.request_status,
      finished_at: finishedAt,
      error_classification: input.error_classification ?? null,
      error_code: input.error_code ?? null,
    }).where("id", "=", input.ai_request_id)
      .where("enterprise_id", "=", input.enterprise_id)
      .where("status", "=", "IN_PROGRESS").executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw new GatewayLedgerSettlementConflictError("settlement_status_conflict");
    }
    return transaction;
  });
}

async function lockInProgressRequest(
  db: Transaction<Database>,
  enterpriseId: string,
  requestId: string,
): Promise<{ status: string; principal_id: string }> {
  const request = await db.selectFrom("ai_request").select(["status", "principal_id"])
    .where("enterprise_id", "=", enterpriseId).where("id", "=", requestId)
    .forUpdate().executeTakeFirst();
  if (!request) throw new GatewayLedgerSettlementConflictError("settlement_request_not_found");
  if (request.status !== "IN_PROGRESS") {
    throw new GatewayLedgerSettlementConflictError("settlement_request_terminal");
  }
  return request;
}

async function assertRequestReadyToFinalize(
  db: Transaction<Database>,
  input: CreateLedgerTransactionInput,
): Promise<void> {
  const attempt = await db.selectFrom("upstream_attempt").select((eb) => [
    eb.fn.countAll<string>().as("total"),
    eb.fn.count<string>("finished_at").as("finished"),
  ]).where("enterprise_id", "=", input.enterprise_id)
    .where("ai_request_id", "=", input.ai_request_id).executeTakeFirstOrThrow();
  if (Number(attempt.total) !== input.attempt_count || attempt.finished !== attempt.total) {
    throw new GatewayLedgerSettlementConflictError("settlement_attempt_incomplete");
  }
  const missingLine = await sql<{ missing: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM usage_event usage
       WHERE usage.enterprise_id = ${input.enterprise_id}
         AND usage.ai_request_id = ${input.ai_request_id}
         AND NOT EXISTS (
           SELECT 1 FROM ledger_line line
            WHERE line.enterprise_id = usage.enterprise_id
              AND line.usage_event_id = usage.id
         )
    ) AS missing
  `.execute(db);
  if (missingLine.rows[0]?.missing) {
    throw new GatewayLedgerSettlementConflictError("settlement_usage_without_line");
  }
  const missingAttemptFact = await sql<{ missing: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM upstream_attempt attempt
       WHERE attempt.enterprise_id = ${input.enterprise_id}
         AND attempt.ai_request_id = ${input.ai_request_id}
         AND NOT EXISTS (
           SELECT 1 FROM usage_event usage
           JOIN ledger_line line
             ON line.enterprise_id = usage.enterprise_id
            AND line.usage_event_id = usage.id
            AND line.upstream_attempt_id = attempt.id
            WHERE usage.enterprise_id = attempt.enterprise_id
              AND usage.ai_request_id = attempt.ai_request_id
              AND usage.upstream_attempt_id = attempt.id
         )
    ) AS missing
  `.execute(db);
  if (missingAttemptFact.rows[0]?.missing) {
    throw new GatewayLedgerSettlementConflictError("settlement_attempt_fact_missing");
  }
  const totals = await sql<{
    input_tokens: string;
    output_tokens: string;
    cache_tokens: string;
    reasoning_tokens: string;
    deducted_quota: string;
    api_cost: string;
    api_cost_known: boolean;
    usage_qualities: string[] | null;
  }>`
    SELECT COALESCE(SUM(raw_input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(raw_output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(raw_cache_tokens), 0)::text AS cache_tokens,
           COALESCE(SUM(raw_reasoning_tokens), 0)::text AS reasoning_tokens,
           COALESCE(SUM(deducted_quota), 0)::text AS deducted_quota,
           COALESCE(SUM(api_cost) FILTER (WHERE resource_mode = 'API'), 0)::text AS api_cost,
           COUNT(*) FILTER (WHERE resource_mode = 'API')
             = COUNT(api_cost) FILTER (WHERE resource_mode = 'API') AS api_cost_known,
           ARRAY_AGG(DISTINCT usage_quality) AS usage_qualities
      FROM ledger_line
     WHERE enterprise_id = ${input.enterprise_id}
       AND ai_request_id = ${input.ai_request_id}
  `.execute(db);
  const total = totals.rows[0]!;
  const expectedApiCost = total.api_cost_known ? total.api_cost : "0";
  if (BigInt(total.input_tokens) !== input.total_input_tokens
    || BigInt(total.output_tokens) !== input.total_output_tokens
    || BigInt(total.cache_tokens) !== input.total_cache_tokens
    || BigInt(total.reasoning_tokens) !== (input.total_reasoning_tokens ?? 0n)
    || BigInt(total.deducted_quota) !== input.total_deducted_quota
    || !new Decimal(expectedApiCost).eq(input.total_api_cost)
    || summarizeLedgerUsageQuality(
      (total.usage_qualities ?? []).map((usage_quality) => ({ usage_quality })),
    ) !== input.usage_quality) {
    throw new GatewayLedgerSettlementConflictError("settlement_totals_stale");
  }
}

async function settleRequestAccounting(
  db: Transaction<Database>,
  input: FinalizeLedgerSettlementInput,
  now: Date,
): Promise<void> {
  const byGrant = new Map<string, { estimated: bigint; actual: bigint }>();
  for (const item of input.quota_settlements ?? []) {
    const current = byGrant.get(item.grant_id) ?? { estimated: 0n, actual: 0n };
    current.estimated += item.reserved_estimate;
    current.actual += item.actual_deducted;
    byGrant.set(item.grant_id, current);
  }
  for (const [grantId, adjustment] of [...byGrant.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const counter = await db.selectFrom("quota_counter").selectAll()
      .where("grant_id", "=", grantId).forUpdate().executeTakeFirst();
    const grant = await db.selectFrom("principal_grant")
      .select(["id", "enterprise_id", "principal_id", "quota_value"])
      .where("id", "=", grantId).executeTakeFirst();
    if (!counter || !grant
      || grant.enterprise_id !== input.enterprise_id
      || grant.principal_id !== input.principal_id) {
      throw new GatewayLedgerSettlementConflictError("settlement_quota_grant_conflict");
    }
    const used = calculateSettledQuota(
      BigInt(counter.used_value), adjustment.estimated, adjustment.actual,
    );
    const quota = BigInt(grant.quota_value);
    await db.updateTable("quota_counter").set({
      used_value: used,
      overage_value: used > quota ? used - quota : 0n,
      updated_at: now,
    }).where("grant_id", "=", grantId).execute();
  }

  const leaseIds = [...new Set(input.release_lease_ids ?? [])].sort();
  if (leaseIds.length > 0) {
    const leases = await db.selectFrom("concurrency_lease").select("id")
      .where("id", "in", leaseIds)
      .where("enterprise_id", "=", input.enterprise_id)
      .where("ai_request_id", "=", input.ai_request_id)
      .forUpdate().execute();
    if (leases.length !== leaseIds.length) {
      throw new GatewayLedgerSettlementConflictError("settlement_lease_conflict");
    }
    await db.updateTable("concurrency_lease").set({ released_at: now })
      .where("id", "in", leaseIds)
      .where("released_at", "is", null).execute();
  }
}

async function insertLedgerTransaction(
  db: Kysely<Database>,
  input: CreateLedgerTransactionInput,
): Promise<LedgerTransaction> {
  return db.insertInto("ledger_transaction").values({
    ai_request_id: input.ai_request_id,
    enterprise_id: input.enterprise_id,
    principal_id: input.principal_id,
    total_input_tokens: input.total_input_tokens,
    total_output_tokens: input.total_output_tokens,
    total_cache_tokens: input.total_cache_tokens,
    total_reasoning_tokens: input.total_reasoning_tokens ?? 0n,
    total_deducted_quota: input.total_deducted_quota,
    total_api_cost: input.total_api_cost,
    overage: input.overage ?? false,
    usage_quality: input.usage_quality,
    attempt_count: input.attempt_count,
    status: "SETTLED",
    created_at: new Date(),
  }).returningAll().executeTakeFirstOrThrow();
}
