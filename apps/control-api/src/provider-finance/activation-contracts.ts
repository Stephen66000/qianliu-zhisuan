import { z } from "zod";
import {
  ACTIVATION_DESCRIPTION_MAX_LENGTH,
  ACTIVATION_EVIDENCE_MAX_LENGTH,
  ACTIVATION_MAX_DRAFT_ROWS,
  PROVIDER_FINANCE_ACTIVATION_SCHEMA_VERSION,
  type ActivationDraft,
} from "@qianliu/domain";

/**
 * 资金账本初始化草稿合同（WP01 任务 1.1 / PFA-02、PFA-03）。
 *
 * 严格校验：未知字段拒绝、金额精度、日期格式、证据必填、数组上限。
 * 请求体不接受权威 `enterprise_id` / `admin_id`：企业与管理员只来自认证会话（PFA-07）。
 */

const ResourceId = z.string().uuid();
const Currency = z.enum(["CNY", "USD"]);
const AccountAmount = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d{1,8})?$/.test(value), "账户金额必须为非负且最多八位小数");
const CashPaidCny = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d{1,2})?$/.test(value), "人民币实付必须最多两位小数")
  .refine((value) => Number(value) > 0, "人民币实付必须大于 0");
const Instant = z.string().datetime({ offset: true });
const ShanghaiDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "必须为 YYYY-MM-DD 上海自然日");
const Description = z.string().trim().min(1, "必须填写事实说明").max(ACTIVATION_DESCRIPTION_MAX_LENGTH);
const Evidence = z.string().trim().min(1, "必须填写证据引用").max(ACTIVATION_EVIDENCE_MAX_LENGTH);
const RecordIdempotencyKey = z.string().trim().min(8).max(128);
const DraftRows = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).max(ACTIVATION_MAX_DRAFT_ROWS, `单类草稿行数不得超过 ${ACTIVATION_MAX_DRAFT_ROWS}`);

export const OpeningBalanceDraftSchema = z.object({
  resource_id: ResourceId,
  account_currency: Currency,
  account_amount: AccountAmount,
  occurred_at: Instant,
  description: Description,
  evidence_ref: Evidence,
  source_record_id: z.string().uuid().nullable().optional(),
}).strict();

export const HistoricalRechargeDraftSchema = z.object({
  resource_id: ResourceId,
  account_currency: Currency,
  account_amount: AccountAmount,
  cash_paid_cny: CashPaidCny,
  occurred_at: Instant,
  external_reference: z.string().trim().min(1).max(255),
  description: Description,
  evidence_ref: Evidence,
  source_record_id: z.string().uuid(),
  record_idempotency_key: RecordIdempotencyKey,
}).strict();

export const CodingPlanPurchaseDraftSchema = z.object({
  resource_id: ResourceId,
  kind: z.enum(["PURCHASE", "RENEWAL"]),
  product_name: z.string().trim().min(1).max(255),
  account_amount: AccountAmount,
  account_currency: Currency,
  cash_paid_cny: CashPaidCny,
  service_period_start: ShanghaiDay,
  service_period_end: ShanghaiDay.nullable().optional(),
  occurred_at: Instant,
  external_reference: z.string().trim().min(1).max(255),
  auto_renew: z.boolean(),
  description: Description,
  evidence_ref: Evidence,
  source_record_id: z.string().uuid().nullable().optional(),
  carryover_snapshot_id: z.string().uuid().nullable().optional(),
  record_idempotency_key: RecordIdempotencyKey,
}).strict().refine((value) => !value.service_period_end
  || value.service_period_end >= value.service_period_start, {
  path: ["service_period_end"], message: "服务周期结束日不得早于开始日",
});

export const CodingPlanCarryoverDraftSchema = z.object({
  resource_id: ResourceId,
  product_name: z.string().trim().min(1).max(255),
  period_start: ShanghaiDay,
  period_end: ShanghaiDay,
  snapshot_id: z.string().uuid(),
  description: Description,
  evidence_ref: Evidence,
}).strict().refine((value) => value.period_end >= value.period_start, {
  path: ["period_end"], message: "周期结束日不得早于开始日",
});

export const LegacyPurchaseResolutionDraftSchema = z.object({
  legacy_record_id: z.string().uuid(),
  resource_id: ResourceId,
  resolution: z.enum(["MIGRATED", "ALREADY_REPRESENTED", "REJECTED_WITH_EVIDENCE"]),
  finance_event_id: z.string().uuid().nullable().optional(),
  migrated_external_reference: z.string().trim().min(1).max(255).nullable().optional(),
  reason: z.string().trim().min(1).max(1000).nullable().optional(),
  evidence_ref: Evidence.nullable().optional(),
}).strict()
  .refine((value) => value.resolution !== "ALREADY_REPRESENTED" || Boolean(value.finance_event_id), {
    path: ["finance_event_id"], message: "ALREADY_REPRESENTED 必须引用同企业同资源的资金事件",
  })
  .refine((value) => value.resolution !== "MIGRATED" || Boolean(value.migrated_external_reference), {
    path: ["migrated_external_reference"], message: "MIGRATED 必须提供外部订单引用",
  })
  .refine((value) => value.resolution !== "REJECTED_WITH_EVIDENCE"
    || (Boolean(value.reason) && Boolean(value.evidence_ref)), {
    path: ["reason"], message: "REJECTED_WITH_EVIDENCE 必须填写原因与证据",
  });

/** 完整初始化草稿（PFA-02 Scenario: Preview a complete draft）。 */
export const ActivationDraftSchema = z.object({
  schema_version: z.literal(PROVIDER_FINANCE_ACTIVATION_SCHEMA_VERSION),
  api_opening_balances: DraftRows(OpeningBalanceDraftSchema).default([]),
  historical_api_recharges: DraftRows(HistoricalRechargeDraftSchema).default([]),
  coding_plan_purchases: DraftRows(CodingPlanPurchaseDraftSchema).default([]),
  coding_plan_carryovers: DraftRows(CodingPlanCarryoverDraftSchema).default([]),
  legacy_purchase_resolutions: DraftRows(LegacyPurchaseResolutionDraftSchema).default([]),
}).strict();

/** 激活请求体：身份只用于二次确认，权威企业与管理员来自会话（PFA-07）。 */
export const ActivationRequestBody = z.object({
  candidate_id: z.string().uuid(),
  candidate_hash: z.string().regex(/^[0-9a-f]{64}$/, "候选哈希必须为小写十六进制 SHA-256"),
  idempotency_key: z.string().trim().min(8).max(128),
  confirm_enterprise_id: z.string().uuid(),
}).strict();

export const ActivationCandidateQuery = z.object({
  candidate_id: z.string().uuid().optional(),
}).strict();

export const QuiescenceStartBody = z.object({
  duration_seconds: z.number().int().positive().max(3600).optional(),
}).strict();

export const QuiescenceReleaseBody = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

export type ActivationDraftInput = z.infer<typeof ActivationDraftSchema>;
export type ActivationRequestBodyInput = z.infer<typeof ActivationRequestBody>;

/**
 * Zod 校验后的草稿 → 领域草稿（补 null 默认值，供规范化与哈希使用）。
 * 未填写的可选字段统一规范为 null，禁止 undefined 与 null 混用。
 */
export function toActivationDraft(input: ActivationDraftInput): ActivationDraft {
  return {
    schema_version: input.schema_version,
    api_opening_balances: input.api_opening_balances.map((item) => ({
      resource_id: item.resource_id,
      account_currency: item.account_currency,
      account_amount: item.account_amount,
      occurred_at: item.occurred_at,
      description: item.description,
      evidence_ref: item.evidence_ref,
      source_record_id: item.source_record_id ?? null,
    })),
    historical_api_recharges: input.historical_api_recharges.map((item) => ({
      resource_id: item.resource_id,
      account_currency: item.account_currency,
      account_amount: item.account_amount,
      cash_paid_cny: item.cash_paid_cny,
      occurred_at: item.occurred_at,
      external_reference: item.external_reference,
      description: item.description,
      evidence_ref: item.evidence_ref,
      source_record_id: item.source_record_id,
      record_idempotency_key: item.record_idempotency_key,
    })),
    coding_plan_purchases: input.coding_plan_purchases.map((item) => ({
      resource_id: item.resource_id,
      kind: item.kind,
      product_name: item.product_name,
      account_amount: item.account_amount,
      account_currency: item.account_currency,
      cash_paid_cny: item.cash_paid_cny,
      service_period_start: item.service_period_start,
      service_period_end: item.service_period_end ?? null,
      occurred_at: item.occurred_at,
      external_reference: item.external_reference,
      auto_renew: item.auto_renew,
      description: item.description,
      evidence_ref: item.evidence_ref,
      source_record_id: item.source_record_id ?? null,
      carryover_snapshot_id: item.carryover_snapshot_id ?? null,
      record_idempotency_key: item.record_idempotency_key,
    })),
    coding_plan_carryovers: input.coding_plan_carryovers.map((item) => ({
      resource_id: item.resource_id,
      product_name: item.product_name,
      period_start: item.period_start,
      period_end: item.period_end,
      snapshot_id: item.snapshot_id,
      description: item.description,
      evidence_ref: item.evidence_ref,
    })),
    legacy_purchase_resolutions: input.legacy_purchase_resolutions.map((item) => ({
      legacy_record_id: item.legacy_record_id,
      resource_id: item.resource_id,
      resolution: item.resolution,
      finance_event_id: item.finance_event_id ?? null,
      migrated_external_reference: item.migrated_external_reference ?? null,
      reason: item.reason ?? null,
      evidence_ref: item.evidence_ref ?? null,
    })),
  };
}
