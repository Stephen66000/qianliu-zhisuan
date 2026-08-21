import type { Kysely } from "kysely";
import {
  parseRequestShapeSummary,
  parseUpstreamErrorEvidence,
} from "@qianliu/provider-adapters";

import type { Database } from "../kysely.js";
import type {
  CreateLedgerTransactionInput,
  LedgerLine,
  LedgerLineInput,
  LedgerTransaction,
  UsageEvent,
  UsageInput,
} from "./gateway-ledger-types.js";
import { GatewayLedgerSettlementConflictError } from "./gateway-ledger-settlement.js";
import { guardOperatingBillLedgerWrite } from "./operating-bill-write-barrier.js";
import { ensureRequestAttributionSnapshot } from "./request-attribution-writer.js";

export interface AttemptResultUpdate {
  http_status?: number | null;
  response_committed?: boolean;
  first_byte_at?: Date | null;
  finished_at?: Date | null;
  error_classification?: string | null;
  error_code?: string | null;
  failure_layer?: string | null;
  switch_reason?: string | null;
  upstream_error_evidence?: Record<string, unknown> | null;
  request_shape_summary?: Record<string, unknown> | null;
}

interface TerminalRequestIdentity {
  status: string;
  error_classification: string | null;
  error_code: string | null;
}

export interface GuardedLedgerUsageIdentity {
  ai_request_id: string;
  enterprise_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string;
  resource_enterprise_id: string;
  mode: string;
}

/** @internal 终态幂等必须同时匹配状态与错误身份。 */
export function isSameTerminalRequest(
  request: TerminalRequestIdentity,
  status: string,
  errorClassification: string | null,
  errorCode: string | null,
): boolean {
  return request.status === status
    && request.error_classification === errorClassification
    && request.error_code === errorCode;
}

/** @internal 任一结算事实存在时，早退入口都不得越过原子 finalize。 */
export function hasSettlementFacts(
  attemptCount: number,
  usage: unknown,
  line: unknown,
  transaction: unknown,
): boolean {
  return attemptCount > 0
    || usage !== undefined
    || line !== undefined
    || transaction !== undefined;
}

/** @internal 兼容 ledger 写入口的租户、请求、资源模式和主体身份必须闭合。 */
export function assertGuardedLedgerIdentity(
  usage: GuardedLedgerUsageIdentity | undefined,
  requestPrincipalId: string,
  input: LedgerLineInput,
): asserts usage is GuardedLedgerUsageIdentity {
  if (!usage
    || usage.ai_request_id !== input.ai_request_id
    || usage.enterprise_id !== input.enterprise_id
    || usage.upstream_attempt_id !== input.upstream_attempt_id
    || usage.provider_resource_id !== input.provider_resource_id
    || usage.resource_enterprise_id !== input.enterprise_id
    || usage.mode !== input.resource_mode
    || requestPrincipalId !== input.principal_id) {
    throw new GatewayLedgerSettlementConflictError("ledger_usage_conflict");
  }
}

/** 无结算事实的早退请求才能直接发布 terminal；有事实时必须走原子 finalize。 */
export async function updateUnsettledRequestStatus(
  db: Kysely<Database>,
  id: string,
  status: string,
  errorClassification?: string | null,
  errorCode?: string | null,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const request = await trx.selectFrom("ai_request")
      .select(["enterprise_id", "status", "error_classification", "error_code"])
      .where("id", "=", id).forUpdate().executeTakeFirst();
    if (!request) throw new GatewayLedgerSettlementConflictError("settlement_request_not_found");
    const nextErrorClassification = errorClassification ?? null;
    const nextErrorCode = errorCode ?? null;
    if (request.status !== "IN_PROGRESS") {
      if (isSameTerminalRequest(
        request, status, nextErrorClassification, nextErrorCode,
      )) {
        await ensureRequestAttributionSnapshot(trx, request.enterprise_id, id);
        return;
      }
      throw new GatewayLedgerSettlementConflictError("settlement_terminal_conflict");
    }
    const attempts = await trx.selectFrom("upstream_attempt")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("ai_request_id", "=", id)
      .executeTakeFirstOrThrow();
    const usage = await trx.selectFrom("usage_event").select("id")
      .where("ai_request_id", "=", id).executeTakeFirst();
    const line = await trx.selectFrom("ledger_line").select("id")
      .where("ai_request_id", "=", id).executeTakeFirst();
    const transaction = await trx.selectFrom("ledger_transaction").select("id")
      .where("ai_request_id", "=", id).executeTakeFirst();
    if (hasSettlementFacts(Number(attempts.count), usage, line, transaction)) {
      throw new GatewayLedgerSettlementConflictError("unsettled_request_terminal_write");
    }
    await trx.updateTable("ai_request").set({
      status,
      finished_at: new Date(),
      error_classification: nextErrorClassification,
      error_code: nextErrorCode,
    }).where("id", "=", id).where("status", "=", "IN_PROGRESS").execute();
    // 无 usage/ledger 也是一次完整请求；冻结其时点归属便于完整审计。
    await ensureRequestAttributionSnapshot(trx, request.enterprise_id, id);
  });
}

/** attempt 结果与 finalize 共用 request 行锁，terminal 后不可改写证据。 */
export async function updateGuardedAttemptResult(
  db: Kysely<Database>,
  id: string,
  update: AttemptResultUpdate,
): Promise<void> {
  const safeUpdate: AttemptResultUpdate = { ...update };
  if (update.upstream_error_evidence !== undefined || update.request_shape_summary !== undefined) {
    const evidence = update.http_status === 400
      ? parseUpstreamErrorEvidence(update.upstream_error_evidence)
      : null;
    const shape = update.http_status === 400
      ? parseRequestShapeSummary(update.request_shape_summary)
      : null;
    safeUpdate.upstream_error_evidence = evidence && shape ? { ...evidence } : null;
    safeUpdate.request_shape_summary = evidence && shape ? { ...shape } : null;
  }
  await db.transaction().execute(async (trx) => {
    const attempt = await trx.selectFrom("upstream_attempt")
      .select(["ai_request_id", "enterprise_id"])
      .where("id", "=", id).executeTakeFirst();
    if (!attempt) throw new GatewayLedgerSettlementConflictError("settlement_attempt_not_found");
    await lockRequestForSettlementWrite(trx, attempt.enterprise_id, attempt.ai_request_id);
    await trx.updateTable("upstream_attempt").set(safeUpdate)
      .where("id", "=", id)
      .where("ai_request_id", "=", attempt.ai_request_id)
      .where("enterprise_id", "=", attempt.enterprise_id).execute();
  });
}

/** 兼容旧调用方；真实 pipeline 应使用 usage + line 原子入口。 */
export async function createGuardedUsageEventIfAbsent(
  db: Kysely<Database>,
  input: UsageInput,
): Promise<UsageEvent | undefined> {
  const createdAt = new Date();
  return db.transaction().execute(async (trx) => {
    await lockRequestForSettlementWrite(trx, input.enterprise_id, input.ai_request_id);
    const attempt = await trx.selectFrom("upstream_attempt").select("id")
      .where("id", "=", input.upstream_attempt_id)
      .where("enterprise_id", "=", input.enterprise_id)
      .where("ai_request_id", "=", input.ai_request_id)
      .where("provider_resource_id", "=", input.provider_resource_id)
      .executeTakeFirst();
    if (!attempt) throw new GatewayLedgerSettlementConflictError("usage_attempt_conflict");
    await guardOperatingBillLedgerWrite(trx, input.enterprise_id, createdAt);
    const result = await trx.insertInto("usage_event").values({
      ai_request_id: input.ai_request_id,
      enterprise_id: input.enterprise_id,
      upstream_attempt_id: input.upstream_attempt_id,
      provider_resource_id: input.provider_resource_id,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      cache_tokens: input.cache_tokens,
      reasoning_tokens: input.reasoning_tokens ?? 0n,
      usage_quality: input.usage_quality,
      dedup_key: input.dedup_key,
      upstream_usage_id: input.upstream_usage_id ?? null,
      created_at: createdAt,
    }).onConflict((oc) => oc.column("dedup_key").doNothing())
      .returningAll().execute();
    await ensureRequestAttributionSnapshot(trx, input.enterprise_id, input.ai_request_id);
    return result[0];
  });
}

/** 兼容旧调用方；保留 usage 的事实月份，并在 CLOSED 月 fail-closed。 */
export async function createGuardedLedgerLine(
  db: Kysely<Database>,
  input: LedgerLineInput,
): Promise<LedgerLine> {
  return db.transaction().execute(async (trx) => {
    const request = await lockRequestForSettlementWrite(
      trx, input.enterprise_id, input.ai_request_id,
    );
    const usage = await trx.selectFrom("usage_event")
      .innerJoin("provider_resource", "provider_resource.id", "usage_event.provider_resource_id")
      .select([
        "usage_event.created_at", "usage_event.ai_request_id", "usage_event.enterprise_id",
        "usage_event.upstream_attempt_id", "usage_event.provider_resource_id",
        "provider_resource.mode", "provider_resource.enterprise_id as resource_enterprise_id",
      ])
      .where("usage_event.id", "=", input.usage_event_id).executeTakeFirst();
    assertGuardedLedgerIdentity(usage, request.principal_id, input);
    await guardOperatingBillLedgerWrite(trx, input.enterprise_id, usage.created_at);
    return trx.insertInto("ledger_line").values({
      ai_request_id: input.ai_request_id,
      enterprise_id: input.enterprise_id,
      usage_event_id: input.usage_event_id,
      upstream_attempt_id: input.upstream_attempt_id,
      provider_resource_id: input.provider_resource_id,
      principal_id: input.principal_id,
      resource_mode: input.resource_mode,
      raw_input_tokens: input.raw_input_tokens,
      raw_output_tokens: input.raw_output_tokens,
      raw_cache_tokens: input.raw_cache_tokens,
      raw_reasoning_tokens: input.raw_reasoning_tokens ?? 0n,
      deducted_quota: input.deducted_quota ?? null,
      api_cost: input.api_cost ?? null,
      usage_quality: input.usage_quality,
      billing_rule_id: input.billing_rule_id ?? null,
      rule_version: input.rule_version ?? null,
      multiplier: input.multiplier ?? null,
      billing_rule_snapshot: input.billing_rule_snapshot ?? null,
      created_at: usage.created_at,
    }).returningAll().executeTakeFirstOrThrow();
  });
}

/** 兼容旧测试/工具的 transaction-only 写入；不发布 terminal，关账仍会拦 IN_PROGRESS。 */
export async function createGuardedLedgerTransactionIfAbsent(
  db: Kysely<Database>,
  input: CreateLedgerTransactionInput,
): Promise<LedgerTransaction | undefined> {
  return db.transaction().execute(async (trx) => {
    const request = await lockRequestForSettlementWrite(
      trx, input.enterprise_id, input.ai_request_id,
    );
    if (request.principal_id !== input.principal_id) {
      throw new GatewayLedgerSettlementConflictError("settlement_principal_conflict");
    }
    const result = await trx.insertInto("ledger_transaction").values({
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
    }).onConflict((oc) => oc.column("ai_request_id").doNothing())
      .returningAll().execute();
    await ensureRequestAttributionSnapshot(trx, input.enterprise_id, input.ai_request_id);
    return result[0];
  });
}

async function lockRequestForSettlementWrite(
  db: Kysely<Database>,
  enterpriseId: string,
  requestId: string,
): Promise<{ status: string; principal_id: string }> {
  const request = await db.selectFrom("ai_request").select(["status", "principal_id"])
    .where("id", "=", requestId).where("enterprise_id", "=", enterpriseId)
    .forUpdate().executeTakeFirst();
  if (!request) throw new GatewayLedgerSettlementConflictError("settlement_request_not_found");
  if (request.status !== "IN_PROGRESS") {
    throw new GatewayLedgerSettlementConflictError("settlement_request_terminal");
  }
  return request;
}
