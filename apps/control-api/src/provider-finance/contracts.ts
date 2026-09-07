import { Decimal } from "decimal.js";
import { z } from "zod";

export const ResourceParams = z.object({ id: z.string().uuid() });
export const Currency = z.enum(["CNY", "USD"]);
const Amount = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d{1,8})?$/.test(value), "金额最多保留8位小数");
const PositiveAmount = Amount.refine((value) => new Decimal(value).gt(0), "金额必须大于0");
const SignedAmount = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^-?\d+(?:\.\d{1,8})?$/.test(value), "差额最多保留8位小数")
  .refine((value) => !new Decimal(value).isZero(), "差额不能为0");
const CashPaidCny = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d{1,2})?$/.test(value), "人民币实付最多保留2位小数")
  .refine((value) => new Decimal(value).gt(0), "人民币实付必须大于0");
const Common = z.object({
  account_currency: Currency,
  occurred_at: z.string().datetime({ offset: true }),
  external_reference: z.string().trim().min(1).max(255).nullable().optional(),
  description: z.string().trim().min(1).max(1000).nullable().optional(),
  evidence_ref: z.string().trim().min(1).max(4000).nullable().optional(),
  idempotency_key: z.string().trim().min(8).max(128),
});
export const OpeningBalanceBody = Common.omit({ external_reference: true }).extend({
  account_amount: Amount,
});
export const RechargeBody = Common.extend({
  account_amount: PositiveAmount,
  cash_paid_cny: CashPaidCny,
});
export const OpeningCorrectionBody = Common.omit({ external_reference: true }).extend({
  account_amount: SignedAmount,
  opening_event_id: z.string().uuid(),
});
export const SubscriptionBody = Common.extend({
  auto_renew: z.boolean().optional(),
  kind: z.enum(["PURCHASE", "RENEWAL"]),
  product_name: z.string().trim().min(1).max(255),
  account_amount: PositiveAmount,
  cash_paid_cny: CashPaidCny,
  service_period_start: z.string().date(),
  service_period_end: z.string().date().optional(),
}).refine((value) => !value.service_period_end
  || value.service_period_end >= value.service_period_start, {
  path: ["service_period_end"], message: "服务周期结束日不得早于开始日",
}).refine((value) => !value.service_period_end
  || value.service_period_end === defaultServiceEndDate(value.service_period_start)
  || Boolean(value.description), {
  path: ["description"], message: "非默认自然月周期必须在说明中填写调整原因",
});
export const BalanceQuery = z.object({
  currency: Currency,
  as_of: z.string().datetime({ offset: true }).optional(),
});
export const EventQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  type: z.enum([
    "API_OPENING_BALANCE", "API_OPENING_BALANCE_CORRECTION", "API_RECHARGE",
    "API_BALANCE_RECONCILIATION", "API_LEGACY_COST_ADJUSTMENT",
    "CODING_PLAN_PURCHASE", "CODING_PLAN_RENEWAL", "REVERSAL",
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const ReconciliationQuery = z.object({
  status: z.enum(["OPEN", "REJECTED", "RESOLVED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const ReversalBody = z.object({
  reason: z.string().trim().min(1).max(1000),
  evidence_ref: z.string().trim().min(1).max(4000),
  idempotency_key: z.string().trim().min(8).max(128),
});
export const ReconciliationCaseBody = z.object({
  account_currency: Currency,
  provider_confirmed_balance: Amount,
  balance_as_of: z.string().datetime({ offset: true }),
  evidence_ref: z.string().trim().min(1).max(4000),
});
export const ReconciliationDecisionBody = z.object({
  expected_version: z.number().int().positive(),
  note: z.string().trim().min(1).max(2000),
  idempotency_key: z.string().trim().min(8).max(128),
});
export const DuplicateConfirmationBody = z.object({
  confirmation_token: z.string().min(16).max(255),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key: z.string().trim().min(8).max(128),
});
export const MonthQuery = z.object({ month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/) });

export function shanghaiDayStart(value: string): Date {
  return new Date(`${value}T00:00:00+08:00`);
}

export function dayAfterShanghaiDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1) - 8 * 3600_000);
}

export function defaultServiceEndDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const lastDayOfNextMonth = new Date(Date.UTC(year!, month! + 1, 0)).getUTCDate();
  const nextAnniversary = Date.UTC(year!, month!, Math.min(day!, lastDayOfNextMonth));
  return new Date(nextAnniversary - 24 * 3600_000).toISOString().slice(0, 10);
}

export function currentShanghaiMonthRange(now = new Date()): { from: Date; to: Date } {
  const shanghai = new Date(now.getTime() + 8 * 3600_000);
  const year = shanghai.getUTCFullYear();
  const month = shanghai.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1) - 8 * 3600_000),
    to: new Date(Date.UTC(year, month + 1, 1) - 8 * 3600_000),
  };
}
