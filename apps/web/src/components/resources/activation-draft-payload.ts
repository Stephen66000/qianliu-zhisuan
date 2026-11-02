/** 草稿业务载荷构造与输入归一化；保持显式零值、空行省略及历史隐藏字段合同。 */
import type {
  ActivationDraftPayload,
  CodingPlanCarryoverDraftPayload,
  CodingPlanPurchaseDraftPayload,
  HistoricalApiCostDraftPayload,
  HistoricalRechargeDraftPayload,
  LegacyPurchaseResolutionDraftPayload,
  OpeningBalanceDraftPayload,
} from "../../api/provider-finance-activation-types";

import {
  ACTIVATION_SCHEMA_VERSION,
  isOpeningRowBlank, isRechargeRowBlank, isCostRowBlank,
  isPurchaseRowBlank, isCarryoverRowBlank, isLegacyRowBlank,
  type ActivationDraftState, type OpeningRowState, type RechargeRowState,
  type HistoricalCostRowState, type PurchaseRowState, type CarryoverRowState,
  type LegacyRowState,
} from "./activation-draft-state";
import { toInstant } from "./activation-draft-validation";

function toOpeningPayload(row: OpeningRowState, cutoverAt: string): OpeningBalanceDraftPayload {
  return {
    resource_id: row.resourceId.trim(),
    account_currency: row.accountCurrency,
    // 零值原样保留；空值不可能到达此处（本地校验已拦截，空行已被省略）。
    account_amount: row.accountAmount.trim(),
    occurred_at: cutoverAt,
    description: row.description.trim(),
    evidence_ref: row.evidenceRef.trim(),
    ...(row.sourceRecordId.trim() === "" ? {} : { source_record_id: row.sourceRecordId.trim() }),
  };
}

function toRechargePayload(row: RechargeRowState): HistoricalRechargeDraftPayload {
  // 载荷只含管理员填写的六项：事实说明、证据引用、来源旧记录与幂等键由服务端生成。
  return {
    resource_id: row.resourceId.trim(),
    account_currency: row.accountCurrency,
    account_amount: row.accountAmount.trim(),
    cash_paid_cny: row.cashPaidCny.trim(),
    occurred_at: toInstant(row.occurredAtLocal) ?? "",
    external_reference: row.externalReference.trim(),
  };
}

function toCostPayload(row: HistoricalCostRowState): HistoricalApiCostDraftPayload {
  // 载荷只含管理员填写的四项：说明、证据与幂等键由服务端按
  // 资源、币种、切换时点、截止时间、金额确定性生成。
  return {
    resource_id: row.resourceId.trim(),
    account_currency: row.accountCurrency,
    cost_amount: row.costAmount.trim(),
    cost_until_at: toInstant(row.costUntilLocal) ?? "",
  };
}

function toPurchasePayload(row: PurchaseRowState): CodingPlanPurchaseDraftPayload {
  return {
    resource_id: row.resourceId.trim(),
    kind: row.kind,
    product_name: row.productName.trim(),
    account_amount: row.accountAmount.trim(),
    account_currency: row.accountCurrency,
    cash_paid_cny: row.cashPaidCny.trim(),
    service_period_start: row.servicePeriodStart.trim(),
    ...(row.servicePeriodEnd.trim() === "" ? {} : { service_period_end: row.servicePeriodEnd.trim() }),
    occurred_at: toInstant(row.occurredAtLocal) ?? "",
    external_reference: row.externalReference.trim(),
    auto_renew: row.autoRenew,
    description: row.description.trim(),
    evidence_ref: row.evidenceRef.trim(),
    ...(row.sourceRecordId.trim() === "" ? {} : { source_record_id: row.sourceRecordId.trim() }),
    ...(row.carryoverSnapshotId.trim() === "" ? {} : { carryover_snapshot_id: row.carryoverSnapshotId.trim() }),
    record_idempotency_key: row.recordIdempotencyKey,
  };
}

function toCarryoverPayload(row: CarryoverRowState): CodingPlanCarryoverDraftPayload {
  // 管理员声明路径（2026-09-27 最小兼容修复）：UI 只有四项；快照引用恒为 null，
  // 说明与证据引用由服务端按资源、产品、周期确定性生成（ADMIN_DECLARED_CARRYOVER）。
  // snapshotId/description/evidenceRef 作为隐藏状态保留在行状态里以兼容
  // localStorage v1 已保存草稿的完整恢复，但不进入载荷。
  return {
    resource_id: row.resourceId.trim(),
    product_name: row.productName.trim(),
    period_start: row.periodStart.trim(),
    period_end: row.periodEnd.trim(),
    snapshot_id: null,
  };
}

function toLegacyPayload(row: LegacyRowState): LegacyPurchaseResolutionDraftPayload {
  return {
    legacy_record_id: row.legacyRecordId.trim(),
    resource_id: row.resourceId.trim(),
    resolution: row.resolution,
    ...(row.financeEventId.trim() === "" ? {} : { finance_event_id: row.financeEventId.trim() }),
    ...(row.migratedExternalReference.trim() === ""
      ? {} : { migrated_external_reference: row.migratedExternalReference.trim() }),
    ...(row.reason.trim() === "" ? {} : { reason: row.reason.trim() }),
    ...(row.evidenceRef.trim() === "" ? {} : { evidence_ref: row.evidenceRef.trim() }),
  };
}

/**
 * 构造预检请求体。载荷中**只有业务草稿**：不含 `enterprise_id` / `admin_id`
 * （PFU-02、PFA-07），权威身份由服务端从会话取得。
 */
export function buildActivationDraft(
  state: ActivationDraftState, cutoverAt: string,
): ActivationDraftPayload {
  return {
    schema_version: ACTIVATION_SCHEMA_VERSION,
    api_opening_balances: state.apiOpeningBalances.filter((row) => !isOpeningRowBlank(row))
      .map((row) => toOpeningPayload(row, cutoverAt)),
    historical_api_recharges: state.historicalApiRecharges.filter((row) => !isRechargeRowBlank(row))
      .map(toRechargePayload),
    historical_api_costs: state.historicalApiCosts.filter((row) => !isCostRowBlank(row))
      .map(toCostPayload),
    coding_plan_purchases: state.codingPlanPurchases.filter((row) => !isPurchaseRowBlank(row))
      .map(toPurchasePayload),
    coding_plan_carryovers: state.codingPlanCarryovers.filter((row) => !isCarryoverRowBlank(row))
      .map(toCarryoverPayload),
    legacy_purchase_resolutions: state.legacyResolutions.filter((row) => !isLegacyRowBlank(row))
      .map(toLegacyPayload),
  };
}
