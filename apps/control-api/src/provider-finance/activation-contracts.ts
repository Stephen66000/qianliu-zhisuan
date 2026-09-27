import { z } from "zod";
import {
  ACTIVATION_DESCRIPTION_MAX_LENGTH,
  ACTIVATION_EVIDENCE_MAX_LENGTH,
  ACTIVATION_MAX_DRAFT_ROWS,
  PROVIDER_FINANCE_ACTIVATION_SCHEMA_VERSION,
  PROVIDER_FINANCE_CUTOVER_ISO,
  rechargeEvidenceRef,
  rechargeFactDescription,
  rechargeRecordIdempotencyKey,
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

/**
 * 历史 API 充值草稿。
 *
 * 充值表单最小修复（2026-09-27）：`source_record_id` 可空——历史充值没有对应的旧
 * `resource_purchase_record` 时，允许仅凭真实厂商充值订单号录入；
 * 事实说明、证据引用与记录级幂等键改为**可选**，缺省由服务端按确定性规则生成
 * （见 `toActivationDraft`），不再要求管理员手工填写；显式提供时旧路径语义不变。
 */
export const HistoricalRechargeDraftSchema = z.object({
  resource_id: ResourceId,
  account_currency: Currency,
  account_amount: AccountAmount,
  cash_paid_cny: CashPaidCny,
  occurred_at: Instant,
  external_reference: z.string().trim().min(1).max(255),
  description: Description.optional(),
  evidence_ref: Evidence.optional(),
  source_record_id: z.string().uuid().nullable().optional(),
  record_idempotency_key: RecordIdempotencyKey.optional(),
}).strict();

/**
 * 历史 API 消耗草稿（0084，2026-09-27 最小增量）。
 *
 * 管理员只填四项；`cost_amount` 是界面输入的**正数**实际消耗金额（服务端规范化后
 * 才转成负向资金事实），事实说明、证据引用与记录级幂等键由服务端按资源、币种、
 * 切换时点、截止时间和金额确定性生成（见 `toActivationDraft`），不提供输入字段。
 * 成本截止时间不得早于固定资金切换时点，不得晚于服务器当前时间。
 */
export const HistoricalApiCostDraftSchema = z.object({
  resource_id: ResourceId,
  account_currency: Currency,
  cost_amount: z.union([z.string(), z.number()]).transform(String)
    .refine((value) => /^\d+(?:\.\d{1,8})?$/.test(value), "实际消耗金额必须为非负且最多八位小数")
    .refine((value) => Number(value) > 0, "实际消耗金额必须大于 0"),
  cost_until_at: Instant,
}).strict()
  .refine((value) => value.cost_until_at >= PROVIDER_FINANCE_CUTOVER_ISO, {
    path: ["cost_until_at"], message: "成本截止时间不得早于资金切换时点",
  })
  .refine((value) => new Date(value.cost_until_at).getTime() <= Date.now(), {
    path: ["cost_until_at"], message: "成本截止时间不得晚于当前时间",
  });

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
  // 管理员声明路径（新服务器不存在旧库快照 UUID）可缺省/显式 null；
  // 提供时保持旧路径严格关联语义。
  snapshot_id: z.string().uuid().nullable().optional(),
  // 缺省/为 null 时说明与证据引用由服务端按资源、产品、周期确定性生成（ADMIN_DECLARED_CARRYOVER）。
  description: Description.nullable().optional(),
  evidence_ref: Evidence.nullable().optional(),
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
  historical_api_costs: DraftRows(HistoricalApiCostDraftSchema).default([]),
  coding_plan_purchases: DraftRows(CodingPlanPurchaseDraftSchema).default([]),
  coding_plan_carryovers: DraftRows(CodingPlanCarryoverDraftSchema).default([]),
  legacy_purchase_resolutions: DraftRows(LegacyPurchaseResolutionDraftSchema).default([]),
}).strict()
  // 历史 API 消耗的期间开始固定为切换时点：同一（资源、币种）多条必然重叠并
  // 重复扣减，权威侧直接拒绝（不同截止时间或金额也不放行；数据库还有
  // 0084 partial unique index 兜底）。其余资金事件类型的多行语义不受影响。
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const cost of value.historical_api_costs) {
      const key = `${cost.resource_id}|${cost.account_currency}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["historical_api_costs"],
          message: "同一厂商资源与币种最多只能登记一条历史 API 消耗"
            + "（期间开始固定为资金切换时点，多条必然重叠并重复扣减）",
        });
        return;
      }
      seen.add(key);
    }
  });

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
      // 内部字段缺省自动生成（确定性、无随机数）；显式提供时保持旧路径语义不变。
      description: item.description ?? rechargeFactDescription(item.external_reference),
      evidence_ref: item.evidence_ref ?? rechargeEvidenceRef(item.external_reference),
      source_record_id: item.source_record_id ?? null,
      record_idempotency_key: item.record_idempotency_key
        ?? rechargeRecordIdempotencyKey(item.resource_id, item.external_reference),
    })),
    // 历史 API 消耗：内部字段全部由服务端按资源、币种、切换时点、截止时间、金额
    // 确定性生成（0084）；管理员载荷只含四项业务字段。
    historical_api_costs: input.historical_api_costs.map((item) => ({
      resource_id: item.resource_id,
      account_currency: item.account_currency,
      cost_amount: item.cost_amount,
      cost_until_at: item.cost_until_at,
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
      snapshot_id: item.snapshot_id ?? null,
      description: item.description ?? null,
      evidence_ref: item.evidence_ref ?? null,
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
