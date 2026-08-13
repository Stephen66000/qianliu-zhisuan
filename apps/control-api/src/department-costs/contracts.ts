import { Decimal } from "decimal.js";
import { z } from "zod";
import type { BudgetStatus } from "./types.js";

export const MonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
export const IdSchema = z.string().uuid();

const DecimalText = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d{1,8})?$/.test(value), "金额必须是最多 8 位小数的非负数");

export const BudgetPutSchema = z.object({
  amount: DecimalText,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3,8}$/),
  warning_threshold: z.union([z.string(), z.number()]).transform(String)
    .refine((value) => /^\d+(?:\.\d{1,8})?$/.test(value), "警戒线必须是小数")
    .refine((value) => new Decimal(value).gt(0) && new Decimal(value).lte(1), "警戒线必须大于 0 且不超过 1"),
  expected_version: z.number().int().nonnegative(),
  idempotency_key: z.string().trim().min(8).max(128),
});

export const PurchasePostSchema = z.object({
  purchase_type: z.enum(["API_RECHARGE", "PACKAGE_PURCHASE"]),
  description: z.string().trim().min(1).max(255).nullable().optional(),
  amount: DecimalText.refine((value) => new Decimal(value).gt(0), "采购金额必须大于 0"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3,8}$/),
  purchased_at: z.string().datetime({ offset: true }),
  service_period_start: z.string().date().nullable().optional(),
  service_period_end: z.string().date().nullable().optional(),
  evidence_ref: z.string().trim().max(4000).nullable().optional(),
  idempotency_key: z.string().trim().min(8).max(128),
}).superRefine((value, context) => {
  const start = value.service_period_start;
  const end = value.service_period_end;
  if ((start === null || start === undefined) !== (end === null || end === undefined)) {
    context.addIssue({ code: "custom", path: ["service_period_end"], message: "服务周期起止必须同时填写" });
  } else if (start && end && end < start) {
    context.addIssue({ code: "custom", path: ["service_period_end"], message: "服务周期结束日不得早于开始日" });
  }
});

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export function money(value: Decimal.Value): string {
  return new Money(value).toDecimalPlaces(8).toFixed(8);
}

export function budgetState(cost: string | null, amount: string | null, threshold: string | null): {
  rate: string | null;
  status: BudgetStatus;
} {
  if (cost === null || amount === null || threshold === null || new Money(amount).lte(0)) {
    return { rate: null, status: "NOT_SET" };
  }
  const rate = new Money(cost).div(amount);
  return {
    rate: rate.toDecimalPlaces(8).toFixed(8),
    status: rate.gte(1) ? "OVER_BUDGET" : rate.gte(threshold) ? "WARNING" : "NORMAL",
  };
}

export function monthDate(month: string): string {
  return `${month}-01`;
}
