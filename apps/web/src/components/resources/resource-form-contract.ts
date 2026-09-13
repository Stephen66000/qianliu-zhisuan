import type { FieldErrors } from "react-hook-form";
import { z } from "zod";

import type { ProviderResourceItem } from "../../api/types";
import { formatMoney } from "../../lib/format";
import {
  NUMERIC_30_8_INTEGER_MAX,
  validateIntegerAmount,
} from "../writes/IntegerAmountInput";
import { validateMoneyAmount } from "../writes/MoneyAmountInput";

const OptionalMoney = z.string().superRefine((value, ctx) => {
  const message = validateMoneyAmount(value);
  if (message) ctx.addIssue({ code: "custom", message });
});
const OptionalIntegerQuota = z.string().superRefine((value, ctx) => {
  const message = validateIntegerAmount(value, NUMERIC_30_8_INTEGER_MAX, false);
  if (message) ctx.addIssue({ code: "custom", message });
});

export const CreateResourceSchema = z.object({
  provider_id: z.string().uuid("请选择厂商"),
  name: z.string().min(1, "名称不能为空").max(255),
  mode: z.enum(["API", "CODING_PLAN"]),
  credential_type: z.enum(["API_KEY", "OAUTH", "SUBSCRIPTION_SESSION"]),
  credential_plaintext: z.string().min(1, "凭证不能为空"),
  concurrency_limit: z.string().refine(
    (value) => value === "" || /^\d+$/.test(value) && Number(value) > 0,
    "并发上限必须是正整数",
  ),
  currency: z.string().max(8),
  recharge_amount: OptionalMoney,
  current_balance: OptionalMoney,
  current_period_cost: OptionalMoney,
  cumulative_cost: OptionalMoney,
  balance_updated_at: z.string(),
  cost_period_start: z.string(),
  cost_period_end: z.string(),
  package_name: z.string().max(255),
  package_cost: OptionalMoney,
  total_quota: OptionalIntegerQuota,
  quota_unit: z.string().max(32),
  effective_from: z.string(),
  effective_until: z.string(),
  reset_cycle: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]),
  reset_anchor_at: z.string(),
}).superRefine((value, ctx) => {
  if (value.mode === "CODING_PLAN" && !value.total_quota) {
    ctx.addIssue({ code: "custom", path: ["total_quota"], message: "套餐资源必须填写总额度" });
  }
  if (value.mode === "CODING_PLAN" && value.reset_cycle !== "NONE" && !value.reset_anchor_at) {
    ctx.addIssue({ code: "custom", path: ["reset_anchor_at"], message: "请选择重置日期" });
  }
});

export type CreateResourceValues = z.infer<typeof CreateResourceSchema>;

export function formError(errors: FieldErrors<CreateResourceValues>, field: keyof CreateResourceValues) {
  const message = errors[field]?.message;
  return typeof message === "string" ? message : undefined;
}

export const EditResourceSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(255),
  concurrency_limit: z.string().refine(
    (value) => value === "" || /^\d+$/.test(value) && Number(value) > 0,
    "并发限制必须是正整数",
  ),
});
export type EditResourceValues = z.infer<typeof EditResourceSchema>;

export const EMPTY_OPERATING_DRAFT: Record<string, string> = {
  currency: "CNY", recharge_amount: "", current_balance: "", current_period_cost: "",
  cumulative_cost: "", balance_updated_at: "", cost_period_start: "", cost_period_end: "",
  package_name: "", package_cost: "", total_quota: "", quota_unit: "TOKEN",
  effective_from: "", effective_until: "", reset_cycle: "NONE", reset_anchor_at: "",
};

export const OPERATING_FIELDS = [
  ["total_quota", "厂商总额度", "text"], ["quota_unit", "原生单位", "text"],
  ["package_name", "套餐名称", "text"], ["package_cost", "套餐费用", "text"],
  ["recharge_amount", "充值金额", "text"], ["current_balance", "当前余额", "text"],
  ["current_period_cost", "本期实际费用", "text"], ["cumulative_cost", "累计费用", "text"],
  ["currency", "币种", "text"], ["balance_updated_at", "余额更新时间", "datetime-local"],
  ["cost_period_start", "费用周期开始", "datetime-local"],
  ["cost_period_end", "费用周期结束", "datetime-local"],
  ["effective_from", "套餐生效时间", "datetime-local"],
  ["effective_until", "套餐失效时间", "datetime-local"],
  ["reset_cycle", "重置周期", "select"], ["reset_anchor_at", "重置日期", "datetime-local"],
] as const;

export const PLAN_OPERATING_KEYS = new Set([
  "total_quota", "quota_unit", "package_name", "reset_cycle", "reset_anchor_at",
]);
export const API_OPERATING_KEYS = new Set<string>();
export const MONEY_OPERATING_KEYS = new Set([
  "package_cost", "recharge_amount", "current_balance", "current_period_cost", "cumulative_cost",
]);
export const RESET_CYCLE_LABELS: Record<string, string> = {
  NONE: "不重置", DAILY: "每日", WEEKLY: "每周", MONTHLY: "每月", QUARTERLY: "每季", YEARLY: "每年",
};

export function operatingFieldsForMode(mode: ProviderResourceItem["mode"]) {
  const keys = mode === "API" ? API_OPERATING_KEYS : PLAN_OPERATING_KEYS;
  return OPERATING_FIELDS.filter(([key]) => keys.has(key));
}

export function operatingPayload(draft: Record<string, string>, mode: ProviderResourceItem["mode"]) {
  const value = (key: string) => draft[key]?.trim() || null;
  const date = (key: string) => {
    const raw = draft[key];
    if (!raw) return null;
    const withShanghaiOffset = `${raw.length === 16 ? `${raw}:00` : raw}+08:00`;
    return new Date(withShanghaiOffset).toISOString();
  };
  const payload = {
    source: "ADMIN" as const, collected_at: new Date().toISOString(), currency: value("currency"),
    recharge_amount: value("recharge_amount"), current_balance: value("current_balance"),
    current_period_cost: value("current_period_cost"), cumulative_cost: value("cumulative_cost"),
    balance_updated_at: date("balance_updated_at"), cost_period_start: date("cost_period_start"),
    cost_period_end: date("cost_period_end"), package_name: value("package_name"),
    package_cost: value("package_cost"), total_quota: value("total_quota"), quota_unit: value("quota_unit"),
    effective_from: date("effective_from"), effective_until: date("effective_until"),
    reset_cycle: value("reset_cycle"), reset_anchor_at: date("reset_anchor_at"),
  };
  return mode === "API"
    ? { ...payload, package_name: null, package_cost: null, total_quota: null, quota_unit: null,
        effective_from: null, effective_until: null, reset_cycle: null, reset_anchor_at: null }
    : { ...payload, currency: null, package_cost: null, effective_from: null, effective_until: null,
        recharge_amount: null, current_balance: null, cumulative_cost: null,
        current_period_cost: null, cost_period_start: null, cost_period_end: null, balance_updated_at: null };
}

export function operatingDraftFromResource(resource: ProviderResourceItem): Record<string, string> {
  const snapshot = resource.operating_snapshot;
  const result = { ...EMPTY_OPERATING_DRAFT };
  if (!snapshot) return result;
  for (const [key, , type] of OPERATING_FIELDS) {
    const raw = snapshot[key as keyof typeof snapshot];
    result[key] = typeof raw === "string"
      ? type === "datetime-local"
        ? new Date(new Date(raw).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16)
        : MONEY_OPERATING_KEYS.has(key)
          ? formatMoney(raw).replaceAll(",", "")
          : key === "total_quota" && /^\d+\.0+$/.test(raw) ? raw.slice(0, raw.indexOf(".")) : raw
      : "";
  }
  return result;
}

export function planDraftError(draft: Record<string, string>): string | null {
  if (!draft.total_quota) return "请填写厂商总额度";
  const quotaError = validateIntegerAmount(draft.total_quota, NUMERIC_30_8_INTEGER_MAX);
  if (quotaError) return quotaError;
  if (draft.reset_cycle !== "NONE" && !draft.reset_anchor_at) return "请选择重置日期";
  return null;
}

export function operatingMoneyError(draft: Record<string, string>): string | null {
  for (const [key, label] of OPERATING_FIELDS) {
    if (!MONEY_OPERATING_KEYS.has(key)) continue;
    const message = validateMoneyAmount(draft[key] ?? "");
    if (message) return `${label}：${message}`;
  }
  return null;
}

/**
 * 厂商资源命名格式化：在基础名称后追加 6 位年月日数字后缀（如 -260913）。
 * 若已有 6 位或 8 位日期标识（如 -260913 或 -260913-01），则不重复追加。
 */
export function formatResourceNameWithDate(baseName: string, date = new Date()): string {
  const trimmed = baseName.trim();
  if (!trimmed) return "";
  if (/(?:^|[^\d])(?:\d{6}|\d{8})(?:-\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${trimmed}-${yy}${mm}${dd}`;
}

