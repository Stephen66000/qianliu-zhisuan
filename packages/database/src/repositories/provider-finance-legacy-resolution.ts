import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { sql, type Kysely } from "kysely";

import type { Database } from "../kysely.js";
import { guardOperatingBillLedgerWrite } from "./operating-bill-write-barrier.js";
import type { LegacyApiCostResolutionInput, LegacyApiCostResolutionView } from "./provider-finance-cutover-types.js";
import {
  PROVIDER_FINANCE_CUTOVER,
  PROVIDER_FINANCE_LEGACY_COST_CUTOFF,
  ProviderFinanceError,
} from "./provider-finance-types.js";
import { canonicalProviderCode } from "@qianliu/provider-adapters";

export async function resolveLegacyApiCostGap(
  db: Kysely<Database>,
  input: LegacyApiCostResolutionInput,
): Promise<LegacyApiCostResolutionView> {
  if (input.windowStart.getTime() !== PROVIDER_FINANCE_CUTOVER.getTime()
    || input.windowEndInclusive.getTime() !== PROVIDER_FINANCE_LEGACY_COST_CUTOFF.getTime()
    || input.windowEndInclusive.getTime() > Date.now()) {
    throw new ProviderFinanceError("INVALID_REQUEST", "历史费用封口窗口不合法");
  }
  const requestHash = createHash("sha256").update(JSON.stringify({
    enterpriseId: input.enterpriseId, resourceId: input.resourceId,
    adminId: input.adminId, accountCurrency: input.accountCurrency,
    windowStart: input.windowStart.toISOString(),
    windowEndInclusive: input.windowEndInclusive.toISOString(),
    providerBalanceSnapshotId: input.providerBalanceSnapshotId,
    evidenceRef: input.evidenceRef,
  })).digest("hex");
  return db.transaction().setIsolationLevel("serializable").execute(async (trx) => {
    const earlyPrior = await trx.selectFrom("provider_finance_idempotency")
      .select(["request_hash", "response_snapshot"])
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
    if (earlyPrior) {
      if (earlyPrior.request_hash !== requestHash) {
        throw new ProviderFinanceError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同请求");
      }
      return { ...(earlyPrior.response_snapshot as unknown as LegacyApiCostResolutionView),
        replayed: true };
    }
    const resource = await trx.selectFrom("provider_resource")
      .innerJoin("provider", (join) => join
        .onRef("provider.enterprise_id", "=", "provider_resource.enterprise_id")
        .onRef("provider.id", "=", "provider_resource.provider_id"))
      .select(["provider_resource.mode", "provider.code as provider_code"])
      .where("provider_resource.enterprise_id", "=", input.enterpriseId)
      .where("provider_resource.id", "=", input.resourceId)
      .where("provider_resource.status", "<>", "DELETED").forUpdate().executeTakeFirst();
    if (!resource) throw new ProviderFinanceError("NOT_FOUND", "厂商资源不存在");
    if (resource.mode !== "API" || canonicalProviderCode(resource.provider_code) !== "deepseek") {
      throw new ProviderFinanceError("INVALID_MODE", "历史动态费用封口只允许DeepSeek API资源");
    }
    const prior = await trx.selectFrom("provider_finance_idempotency")
      .select(["request_hash", "response_snapshot"])
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
    if (prior) {
      if (prior.request_hash !== requestHash) {
        throw new ProviderFinanceError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同请求");
      }
      return { ...(prior.response_snapshot as unknown as LegacyApiCostResolutionView),
        replayed: true };
    }
    await guardOperatingBillLedgerWrite(trx, input.enterpriseId, input.windowEndInclusive);
    const snapshot = await trx.selectFrom("provider_resource_operating_snapshot")
      .select(["id", "current_balance", "currency", "collected_at", "source",
        "balance_source"])
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .where("id", "=", input.providerBalanceSnapshotId).executeTakeFirst();
    if (!snapshot || snapshot.source !== "PROVIDER_SYNC"
      || snapshot.balance_source !== "PROVIDER_API"
      || snapshot.currency !== input.accountCurrency || snapshot.current_balance === null
      || snapshot.collected_at.getTime() !== input.windowEndInclusive.getTime()) {
      throw new ProviderFinanceError("CONFLICT", "必须使用窗口末端的厂商API余额快照");
    }
    const [fundsResult, knownResult, unknownResult] = await Promise.all([
      sql<{ amount: string }>`SELECT COALESCE(SUM(account_amount),0)::text AS amount
        FROM provider_finance_event WHERE enterprise_id=${input.enterpriseId}::uuid
         AND provider_resource_id=${input.resourceId}::uuid
         AND account_currency=${input.accountCurrency}
         AND occurred_at<=${input.windowEndInclusive}`.execute(trx),
      sql<{ amount: string }>`SELECT COALESCE(SUM(api_cost),0)::text AS amount
        FROM ledger_line WHERE enterprise_id=${input.enterpriseId}::uuid
         AND provider_resource_id=${input.resourceId}::uuid
         AND resource_mode='API' AND api_cost_status='PRICED_USAGE'
         AND settled_at>=${input.windowStart} AND settled_at<=${input.windowEndInclusive}`
        .execute(trx),
      trx.selectFrom("ledger_line").select("id")
        .where("enterprise_id", "=", input.enterpriseId)
        .where("provider_resource_id", "=", input.resourceId)
        .where("resource_mode", "=", "API").where("api_cost_status", "=", "UNKNOWN_COST")
        .where("api_cost", "is", null).where("api_cost_currency", "is", null)
        .where("legacy_cost_resolution_id", "is", null)
        .where("settled_at", ">=", input.windowStart)
        .where("settled_at", "<=", input.windowEndInclusive).forUpdate().execute(),
    ]);
    if (unknownResult.length === 0) {
      throw new ProviderFinanceError("CONFLICT", "封口窗口内没有待解决的未知API费用");
    }
    const knownApiCost = new Decimal(knownResult.rows[0]!.amount);
    const localBefore = new Decimal(fundsResult.rows[0]!.amount).minus(knownApiCost);
    const providerBalance = new Decimal(snapshot.current_balance);
    const missingCost = localBefore.minus(providerBalance);
    if (!missingCost.isPositive()) {
      throw new ProviderFinanceError("CONFLICT", "厂商余额未形成正向历史费用缺口");
    }
    const fixed = (value: Decimal) => value.toDecimalPlaces(8).toFixed(8);
    const resolution = await trx.insertInto("provider_finance_legacy_cost_resolution").values({
      enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
      account_currency: input.accountCurrency, window_start: input.windowStart,
      window_end_inclusive: input.windowEndInclusive,
      provider_balance_snapshot_id: input.providerBalanceSnapshotId,
      provider_confirmed_balance: fixed(providerBalance),
      local_balance_before_adjustment: fixed(localBefore), known_api_cost: fixed(knownApiCost),
      missing_api_cost: fixed(missingCost), unknown_line_count: BigInt(unknownResult.length),
      adjustment_event_id: null, evidence_ref: input.evidenceRef,
      created_by_admin_user_id: input.adminId, resolved_at: null,
    }).returning("id").executeTakeFirstOrThrow();
    const event = await trx.insertInto("provider_finance_event").values({
      enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
      event_type: "API_LEGACY_COST_ADJUSTMENT", account_amount: fixed(missingCost.negated()),
      account_currency: input.accountCurrency, cash_paid_cny: null,
      occurred_at: input.windowEndInclusive, external_reference: null,
      reversal_of_event_id: null, correction_of_event_id: null, reconciliation_case_id: null,
      legacy_cost_resolution_id: resolution.id,
      description: "9月1日至暗部署前DeepSeek历史动态费用封口",
      evidence_ref: input.evidenceRef, source: "MIGRATION",
      idempotency_key: input.idempotencyKey, created_by_admin_user_id: input.adminId,
    }).returning("id").executeTakeFirstOrThrow();
    const linked = await trx.updateTable("ledger_line").set({
      legacy_cost_resolution_id: resolution.id,
    }).where("id", "in", unknownResult.map((row) => row.id))
      .where("legacy_cost_resolution_id", "is", null).executeTakeFirst();
    if (Number(linked.numUpdatedRows) !== unknownResult.length) {
      throw new ProviderFinanceError("CONFLICT", "历史未知费用行在封口时发生变化");
    }
    await trx.updateTable("provider_finance_legacy_cost_resolution").set({
      status: "RESOLVED", adjustment_event_id: event.id,
      resolved_at: new Date(), updated_at: new Date(),
    }).where("id", "=", resolution.id).executeTakeFirstOrThrow();
    const response: LegacyApiCostResolutionView = {
      id: resolution.id, adjustmentEventId: event.id,
      providerResourceId: input.resourceId, accountCurrency: input.accountCurrency,
      windowStart: input.windowStart.toISOString(),
      windowEndInclusive: input.windowEndInclusive.toISOString(),
      providerConfirmedBalance: fixed(providerBalance),
      localBalanceBeforeAdjustment: fixed(localBefore), knownApiCost: fixed(knownApiCost),
      missingApiCost: fixed(missingCost), unknownLineCount: String(unknownResult.length),
      replayed: false,
    };
    await trx.insertInto("operation_log").values({ actor_source: "ADMIN",
      enterprise_id: input.enterpriseId, admin_user_id: input.adminId,
      action: "provider_finance_legacy_cost.resolve",
      target_type: "provider_finance_legacy_cost_resolution", target_id: resolution.id,
      result: "SUCCESS", failure_reason: null,
      change_summary: JSON.stringify(response) as unknown as Record<string, unknown>,
    }).execute();
    await trx.insertInto("provider_finance_idempotency").values({
      enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
      idempotency_key: input.idempotencyKey, request_hash: requestHash,
      response_snapshot: JSON.stringify(response) as unknown as Record<string, unknown>,
    }).execute();
    return response;
  });
}
