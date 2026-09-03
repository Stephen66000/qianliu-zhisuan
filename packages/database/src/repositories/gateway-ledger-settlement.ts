import { Decimal } from "decimal.js";
import { type Kysely, type Transaction } from "kysely";

import type { Database } from "../kysely.js";
import type {
  CreateAttemptInput, CreateLedgerTransactionInput, CreateUsageLedgerLineInput,
  FinalizeLedgerSettlementInput, LedgerLine, LedgerTransaction,
  PersistAttemptUsageAccountingInput, UpstreamAttempt, UsageLedgerLineResult,
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
import { loadRequestSettlementFacts } from "./gateway-ledger-request-facts.js";
import { settleQuota as calculateSettledQuota } from "@qianliu/domain";
import { ensureRequestAttributionSnapshot } from "./request-attribution-writer.js";
import { resolveSubscriptionPeriodAtSettlement } from "./subscription-period-attribution.js";

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
  db: Kysely<Database>, input: CreateUsageLedgerLineInput,
): Promise<UsageLedgerLineResult> {
  return db.transaction().execute((trx) => persistUsageLedgerLine(trx, input));
}

/**
 * 非终态 Attempt 的事实、额度退回和租约释放同事务提交。
 *
 * 锁序与 terminal finalize 一致：request → attempt → 账本事实/月屏障 →
 * quota_counter（按 grant 排序）→ concurrency_lease（按 id 排序）。只有首次创建
 * ledger_line 时执行资源结算；
 * 因此 PostgreSQL 回滚后可安全重试，成功提交后重放不会重复退额度。
 */
export async function persistAttemptUsageAccountingAtomically(
  db: Kysely<Database>,
  input: PersistAttemptUsageAccountingInput,
): Promise<UsageLedgerLineResult> {
  return db.transaction().execute(async (trx) => {
    const result = await persistUsageLedgerLine(trx, input, input.attempt_result);
    if (result.created) {
      await settleRequestAccounting(trx, {
        ai_request_id: input.usage.ai_request_id,
        enterprise_id: input.usage.enterprise_id,
        principal_id: input.ledger_line.principal_id,
        quota_settlements: input.quota_settlements,
        release_lease_ids: input.release_lease_ids,
      }, new Date());
    }
    return result;
  });
}

export async function persistUsageLedgerLine(
  trx: Transaction<Database>,
  input: CreateUsageLedgerLineInput,
  attemptResult?: PersistAttemptUsageAccountingInput["attempt_result"],
): Promise<UsageLedgerLineResult> {
  assertUsageLineInputCoherent(input);
  const request = await lockInProgressRequest(
    trx, input.usage.enterprise_id, input.usage.ai_request_id,
  );
  if (request.principal_id !== input.ledger_line.principal_id) {
    throw new GatewayLedgerSettlementConflictError("settlement_principal_conflict");
  }
  let attemptQuery = trx.selectFrom("upstream_attempt")
    .innerJoin("provider_resource", "provider_resource.id", "upstream_attempt.provider_resource_id")
    .select([
      "upstream_attempt.id", "upstream_attempt.finished_at", "upstream_attempt.http_status",
      "upstream_attempt.response_committed", "upstream_attempt.error_classification",
      "upstream_attempt.error_code", "upstream_attempt.switch_reason", "provider_resource.mode",
    ])
    .where("upstream_attempt.id", "=", input.usage.upstream_attempt_id)
    .where("upstream_attempt.enterprise_id", "=", input.usage.enterprise_id)
    .where("upstream_attempt.ai_request_id", "=", input.usage.ai_request_id)
    .where("upstream_attempt.provider_resource_id", "=", input.usage.provider_resource_id)
    .where("provider_resource.enterprise_id", "=", input.usage.enterprise_id);
  if (attemptResult) attemptQuery = attemptQuery.forUpdate();
  const attempt = await attemptQuery.executeTakeFirst();
  if (!attempt) throw new GatewayLedgerSettlementConflictError("usage_attempt_conflict");
  if (attempt.mode !== input.ledger_line.resource_mode) {
    throw new GatewayLedgerSettlementConflictError("settlement_resource_mode_conflict");
  }
  if (attemptResult) {
    if (attempt.finished_at === null) {
      const updated = await trx.updateTable("upstream_attempt").set(attemptResult)
        .where("id", "=", input.usage.upstream_attempt_id)
        .where("enterprise_id", "=", input.usage.enterprise_id)
        .where("ai_request_id", "=", input.usage.ai_request_id)
        .where("finished_at", "is", null).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new GatewayLedgerSettlementConflictError("settlement_attempt_result_conflict");
      }
    } else if (attempt.http_status !== attemptResult.http_status
      || attempt.response_committed !== attemptResult.response_committed
      || attempt.error_classification !== attemptResult.error_classification
      || attempt.error_code !== attemptResult.error_code
      || attempt.switch_reason !== attemptResult.switch_reason) {
      throw new GatewayLedgerSettlementConflictError("settlement_attempt_result_conflict");
    }
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
  const settledAt = input.ledger_line.settled_at ?? usage.created_at;
  const subscriptionPeriodId = await resolveSubscriptionPeriodAtSettlement(
    trx, input.ledger_line, settledAt,
  );
  const line = await trx.insertInto("ledger_line").values({
    ...input.ledger_line,
    usage_event_id: usage.id,
    raw_reasoning_tokens: input.ledger_line.raw_reasoning_tokens ?? 0n,
    deducted_quota: input.ledger_line.deducted_quota ?? null,
    api_cost: input.ledger_line.api_cost ?? null,
    api_cost_currency: input.ledger_line.api_cost_currency ?? null,
    api_cost_status: input.ledger_line.api_cost_status ?? null,
    subscription_period_id: subscriptionPeriodId,
    settled_at: settledAt,
    billing_rule_id: input.ledger_line.billing_rule_id ?? null,
    rule_version: input.ledger_line.rule_version ?? null,
    multiplier: input.ledger_line.multiplier ?? null,
    billing_rule_snapshot: input.ledger_line.billing_rule_snapshot ?? null,
    created_at: usage.created_at,
  }).returningAll().executeTakeFirstOrThrow();
  return { usage, line, created: true };
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
      // 兼容 0048 前已终态请求：结算重放可幂等补齐 v1 归属。
      await ensureRequestAttributionSnapshot(trx, input.enterprise_id, input.ai_request_id);
      return existing;
    }

    await assertRequestReadyToFinalize(trx, input);
    await settleRequestAccounting(trx, input, finishedAt);
    const transaction = existing ?? await insertLedgerTransaction(trx, input);
    assertTransactionMatches(transaction, input);
    await ensureRequestAttributionSnapshot(trx, input.enterprise_id, input.ai_request_id);
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
  const facts = await loadRequestSettlementFacts(db, input.enterprise_id, input.ai_request_id);
  if (facts.attemptCount !== input.attempt_count) {
    throw new GatewayLedgerSettlementConflictError("settlement_attempt_incomplete");
  }
  if (facts.totalInputTokens !== input.total_input_tokens
    || facts.totalOutputTokens !== input.total_output_tokens
    || facts.totalCacheTokens !== input.total_cache_tokens
    || facts.totalReasoningTokens !== (input.total_reasoning_tokens ?? 0n)
    || facts.totalDeductedQuota !== input.total_deducted_quota
    || !new Decimal(facts.totalApiCost).eq(input.total_api_cost)
    || summarizeLedgerUsageQuality(
      facts.usageQualities.map((usage_quality) => ({ usage_quality })),
    ) !== input.usage_quality) {
    throw new GatewayLedgerSettlementConflictError("settlement_totals_stale");
  }
}

export async function settleRequestAccounting(
  db: Transaction<Database>,
  input: Pick<FinalizeLedgerSettlementInput,
    "ai_request_id" | "enterprise_id" | "principal_id"
    | "quota_settlements" | "release_lease_ids">,
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
      .orderBy("id", "asc")
      .forUpdate().execute();
    if (leases.length !== leaseIds.length) {
      throw new GatewayLedgerSettlementConflictError("settlement_lease_conflict");
    }
    await db.updateTable("concurrency_lease").set({ released_at: now })
      .where("id", "in", leaseIds)
      .where("released_at", "is", null).execute();
  }
}

export async function insertLedgerTransaction(
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
