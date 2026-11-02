import type { Transaction } from "kysely";
import { carryoverDraftKey, type ActivationDraft, type NormalizedActivationCandidate } from "@qianliu/domain";
import type { Database } from "../kysely.js";
import { ProviderFinanceActivationError, type ActivationCandidateView } from "./provider-finance-activation-types.js";
import {
  closeLegacyPurchaseTx, insertCarryoverPeriodTx, insertHistoricalUsageCostTx,
  insertOpeningBalanceTx, insertRechargeTx, insertSubscriptionTx, legacySourceMarker,
} from "./provider-finance-activation-writes.js";

interface DraftFactWriteScope { enterpriseId: string; adminId: string }

export interface DraftWriteCounts {
  openings: number;
  recharges: number;
  historicalUsageCosts: number;
  purchases: number;
  carryovers: number;
  legacyResolutions: number;
  periodIdByDraftKey: Map<string, string>;
}

export async function writeActivationDraftFacts(
  trx: Transaction<Database>, input: DraftFactWriteScope,
  candidate: ActivationCandidateView, reverified: { candidate: NormalizedActivationCandidate },
): Promise<DraftWriteCounts> {
  const namespace = `activation:${candidate.candidateId}:`;
  const periodIdByDraftKey = new Map<string, string>();
  const openings = await writeOpenings(trx, input, reverified, namespace);
  const recharges = await writeRecharges(trx, input, reverified, namespace);
  const historicalUsageCosts = await writeHistoricalUsageCosts(trx, input, reverified, namespace);
  const purchases = await writePurchases(trx, input, reverified, namespace, periodIdByDraftKey);
  const carryovers = await writeCarryovers(trx, input, reverified, periodIdByDraftKey);
  const legacyResolutions = await writeLegacyClosures(trx, input, reverified, namespace);
  return {
    openings, recharges, historicalUsageCosts, purchases, carryovers, legacyResolutions,
    periodIdByDraftKey,
  };
}

async function writeOpenings(
  trx: Transaction<Database>, input: DraftFactWriteScope, reverified: { candidate: NormalizedActivationCandidate }, namespace: string,
): Promise<number> {
  let written = 0;
  for (const opening of reverified.candidate.apiOpeningBalances) {
    const existing = await trx.selectFrom("provider_finance_event").select(["account_amount"])
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", opening.resourceId)
      .where("account_currency", "=", opening.accountCurrency)
      .where("event_type", "=", "API_OPENING_BALANCE").executeTakeFirst();
    if (existing) {
      // 已存在金额相同的原始期初视为已满足（PFH-01 只允许一条）；金额不同即缺口，不得覆盖。
      if (existing.account_amount !== opening.accountAmount) {
        throw new ProviderFinanceActivationError(
          "CANDIDATE_STALE", "该账户已存在金额不同的原始期初余额，不得覆盖",
          { resourceId: opening.resourceId, accountCurrency: opening.accountCurrency });
      }
      continue;
    }
    await insertOpeningBalanceTx(trx, {
      enterpriseId: input.enterpriseId, resourceId: opening.resourceId, adminId: input.adminId,
      accountAmount: opening.accountAmount, accountCurrency: opening.accountCurrency,
      description: opening.description, evidenceRef: opening.evidenceRef,
      idempotencyKey: `${namespace}opening:${opening.resourceId}:${opening.accountCurrency}`,
      source: "MIGRATION", externalReference: null,
    });
    written += 1;
  }
  return written;
}

async function writeRecharges(
  trx: Transaction<Database>, input: DraftFactWriteScope, reverified: { candidate: NormalizedActivationCandidate }, namespace: string,
): Promise<number> {
  let written = 0;
  for (const recharge of reverified.candidate.historicalApiRecharges) {
    await insertRechargeTx(trx, {
      enterpriseId: input.enterpriseId, resourceId: recharge.resourceId, adminId: input.adminId,
      accountAmount: recharge.accountAmount, accountCurrency: recharge.accountCurrency,
      cashPaidCny: recharge.cashPaidCny, occurredAt: new Date(recharge.occurredAt),
      // 迁移行写来源标记（旧账本据此排除该记录）；订单引用仍留在草稿与关闭审计里。
      externalReference: legacySourceMarker(recharge.sourceRecordId, recharge.externalReference),
      description: recharge.description,
      evidenceRef: recharge.evidenceRef,
      idempotencyKey: `${namespace}${recharge.recordIdempotencyKey}`,
    }, { source: "MIGRATION" });
    written += 1;
  }
  return written;
}

/**
 * 历史 API 消耗（0084）：负向资金事实与期初、充值等在同一 `SERIALIZABLE` 事务内一次写入。
 * 记录级幂等键由草稿规范化确定性生成；重放时
 * `provider_finance_idempotency_key_uq` 唯一索引兜底，不会重复入账。
 */
async function writeHistoricalUsageCosts(
  trx: Transaction<Database>, input: DraftFactWriteScope, reverified: { candidate: NormalizedActivationCandidate }, namespace: string,
): Promise<number> {
  let written = 0;
  for (const cost of reverified.candidate.historicalApiCosts) {
    await insertHistoricalUsageCostTx(trx, {
      enterpriseId: input.enterpriseId, resourceId: cost.resourceId, adminId: input.adminId,
      accountCurrency: cost.accountCurrency, costAmount: cost.costAmount,
      occurredAt: new Date(cost.occurredAt),
      description: cost.description, evidenceRef: cost.evidenceRef,
      idempotencyKey: `${namespace}${cost.recordIdempotencyKey}`,
    });
    written += 1;
  }
  return written;
}

async function writePurchases(
  trx: Transaction<Database>, input: DraftFactWriteScope, reverified: { candidate: NormalizedActivationCandidate },
  namespace: string, periodIdByDraftKey: Map<string, string>,
): Promise<number> {
  let written = 0;
  for (const purchase of reverified.candidate.codingPlanPurchases) {
    const result = await insertSubscriptionTx(trx, {
      enterpriseId: input.enterpriseId, resourceId: purchase.resourceId, adminId: input.adminId,
      kind: purchase.kind, productName: purchase.productName,
      accountAmount: purchase.accountAmount, accountCurrency: purchase.accountCurrency,
      cashPaidCny: purchase.cashPaidCny, occurredAt: new Date(purchase.occurredAt),
      // 迁移行写来源标记（旧账本据此排除该记录）；订单引用仍留在草稿与关闭审计里。
      externalReference: legacySourceMarker(purchase.sourceRecordId, purchase.externalReference),
      description: purchase.description,
      evidenceRef: purchase.evidenceRef,
      idempotencyKey: `${namespace}${purchase.recordIdempotencyKey}`,
      periodStart: new Date(purchase.periodStart),
      periodEndExclusive: new Date(purchase.periodEndExclusive),
    }, {
      source: "MIGRATION",
      // 由旧购买记录迁移而来：周期必须绑定源记录，便于后续审计追溯。
      periodSource: purchase.sourceRecordId === null ? purchase.kind : "MIGRATED_PURCHASE",
      migrationSourceRecordId: purchase.sourceRecordId,
      actorAdminId: input.adminId,
    });
    periodIdByDraftKey.set(purchase.recordIdempotencyKey, result.periodId);
    written += 1;
  }
  return written;
}

async function writeCarryovers(
  trx: Transaction<Database>, input: DraftFactWriteScope, reverified: { candidate: NormalizedActivationCandidate },
  periodIdByDraftKey: Map<string, string>,
): Promise<number> {
  let written = 0;
  for (const carryover of reverified.candidate.codingPlanCarryovers) {
    const result = await insertCarryoverPeriodTx(trx, {
      enterpriseId: input.enterpriseId, resourceId: carryover.resourceId, adminId: input.adminId,
      productName: carryover.productName,
      periodStart: new Date(carryover.periodStart),
      periodEndExclusive: new Date(carryover.periodEndExclusive),
      migrationSourceRecordId: carryover.snapshotId,
      description: carryover.description, evidenceRef: carryover.evidenceRef,
    });
    // 带快照引用的键即快照 id（旧路径）；管理员声明路径用确定性摘要键。
    periodIdByDraftKey.set(carryoverDraftKey(carryover), result.periodId);
    written += 1;
  }
  return written;
}

/**
 * 旧购买记录关闭（PFH-02）。
 *
 * MIGRATED 的"金额事实"由第 7 步写出的草稿明细行承载；
 * 这里把「旧记录 → 资金事件」的不可变映射写进关闭审计，
 * 并校验草稿行确实按 `sourceRecordId + externalReference` 绑定了该记录。
 */
async function writeLegacyClosures(
  trx: Transaction<Database>, input: DraftFactWriteScope, reverified: { candidate: NormalizedActivationCandidate }, namespace: string,
): Promise<number> {
  let written = 0;
  for (const resolution of reverified.candidate.legacyPurchaseResolutions) {
    const migratedEventId = resolution.resolution === "MIGRATED"
      ? await findMigratedEventId(trx, input, reverified, resolution.legacyRecordId,
        resolution.migratedExternalReference, namespace)
      : null;
    await closeLegacyPurchaseTx(trx, {
      enterpriseId: input.enterpriseId, resourceId: resolution.resourceId, adminId: input.adminId,
      legacyRecordId: resolution.legacyRecordId, resolution: resolution.resolution,
      migratedEventId, representedEventId: resolution.financeEventId,
      externalReference: resolution.migratedExternalReference,
      reason: resolution.reason, evidenceRef: resolution.evidenceRef,
    });
    written += 1;
  }
  return written;
}

async function findMigratedEventId(
  trx: Transaction<Database>, input: DraftFactWriteScope, reverified: { candidate: NormalizedActivationCandidate },
  legacyRecordId: string, externalReference: string | null, namespace: string,
): Promise<string | null> {
  const recharge = reverified.candidate.historicalApiRecharges.find((row) =>
    row.sourceRecordId === legacyRecordId && row.externalReference === externalReference);
  const purchase = reverified.candidate.codingPlanPurchases.find((row) =>
    row.sourceRecordId === legacyRecordId && row.externalReference === externalReference);
  const idempotencyKey = recharge
    ? `${namespace}${recharge.recordIdempotencyKey}`
    : purchase ? `${namespace}${purchase.recordIdempotencyKey}` : null;
  if (!idempotencyKey) return null;
  const event = await trx.selectFrom("provider_finance_event").select("id")
    .where("enterprise_id", "=", input.enterpriseId).where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirst();
  return event?.id ?? null;
}


export function emptyActivationDraft(): ActivationDraft {
  return {
    schema_version: "1", api_opening_balances: [], historical_api_recharges: [],
    historical_api_costs: [], coding_plan_purchases: [], coding_plan_carryovers: [],
    legacy_purchase_resolutions: [],
  };
}
