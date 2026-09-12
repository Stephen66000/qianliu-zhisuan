import { z } from "zod";
import type { BillingRule, Principal } from "../api/types";
import { normalizeToPerToken } from "../lib/price-unit";

const OptionalDecimal = z.string().refine(
  (value) => value === "" || /^\d+(?:\.\d+)?$/.test(value),
  "请输入非负十进制数",
);
const OptionalTime = z.string().refine(
  (value) => value === "" || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value),
  "时间格式应为 HH:MM",
);

export const BillingWindowFormSchema = z
  .object({
    timezone: z.string().min(1, "时区不能为空").max(64),
    days_of_week: z.string().refine(
      (value) =>
        value === ""
        || value.split(",").every((day) => /^[1-7]$/.test(day.trim())),
      "星期使用 1-7，以逗号分隔",
    ),
    start_time: OptionalTime,
    end_time: OptionalTime,
  })
  .superRefine((window, ctx) => {
    const complete = Boolean(window.timezone && window.start_time && window.end_time);
    if (!complete) {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "时区和起止时间必须同时填写" });
    }
    if (window.start_time && window.start_time === window.end_time) {
      ctx.addIssue({ code: "custom", path: ["end_time"], message: "起止时间不能相同" });
    }
  });

export const BillingRuleSchema = z
  .object({
    rule_type: z.enum(["API_PRICE", "TIME_WINDOW", "MODEL_TIER", "CACHE_STATE"]),
    pricing_mode: z.enum(["ABSOLUTE", "MULTIPLIER"]).optional(),
    currency: z.enum(["CNY", "USD"]).optional(),
    rule_version: z.string().min(1, "版本不能为空").max(64),
    provider_resource_id: z.string().uuid("请选择资源"),
    upstream_model: z.string().min(1, "上游模型不能为空").max(128),
    effective_from: z.string().min(1, "生效时间不能为空"),
    effective_to: z.string(),
    windows: z.array(BillingWindowFormSchema).max(32, "最多配置 32 个时间窗"),
    multiplier: OptionalDecimal,
    cache_hit_price: OptionalDecimal,
    cache_miss_price: OptionalDecimal,
    output_price: OptionalDecimal,
    priority: z.coerce.number().int().min(0),
  })
  .superRefine((input, ctx) => {
    const configuredWindows = input.windows.filter(
      (window) => window.timezone && window.start_time && window.end_time,
    );
    if (input.effective_to && new Date(input.effective_to) <= new Date(input.effective_from)) {
      ctx.addIssue({ code: "custom", path: ["effective_to"], message: "失效时间必须晚于生效时间" });
    }
    if (input.rule_type === "API_PRICE") {
      if (input.pricing_mode !== "MULTIPLIER" && input.multiplier) {
        ctx.addIssue({ code: "custom", path: ["multiplier"], message: "API 价格规则不使用额度倍率" });
      }
      if (!input.cache_hit_price && !input.cache_miss_price && !input.output_price) {
        ctx.addIssue({ code: "custom", path: ["cache_miss_price"], message: "至少填写一个单价" });
      }
      for (const field of ["cache_hit_price", "cache_miss_price", "output_price"] as const) {
        if (!input[field]) ctx.addIssue({ code: "custom", path: [field], message: "请填写单价，免费项目请明确填 0" });
      }
      if (input.pricing_mode === "MULTIPLIER" && (!input.multiplier || !/[1-9]/.test(input.multiplier)
        || !input.cache_hit_price || !input.cache_miss_price || !input.output_price)) {
        ctx.addIssue({ code: "custom", path: ["multiplier"], message: "填写正倍率与三项基础单价，零价请明确填 0" });
      }
    }
    if (input.rule_type === "TIME_WINDOW" || input.rule_type === "MODEL_TIER") {
      if (!input.multiplier) {
        ctx.addIssue({ code: "custom", path: ["multiplier"], message: "额度规则必须填写倍率" });
      }
      if (input.cache_hit_price || input.cache_miss_price || input.output_price) {
        ctx.addIssue({ code: "custom", path: ["cache_miss_price"], message: "额度倍率规则不使用 API 单价" });
      }
    }
    if (input.rule_type === "TIME_WINDOW" && configuredWindows.length === 0) {
      ctx.addIssue({ code: "custom", path: ["windows"], message: "时段倍率至少配置一个时间窗" });
    }
    if (input.rule_type === "MODEL_TIER" && configuredWindows.length > 0) {
      ctx.addIssue({ code: "custom", path: ["windows"], message: "模型档位不使用时间窗" });
    }
  });

export const UnifiedModelSchema = z.object({
  alias: z.string().min(1, "别名不能为空").max(64),
  display_name: z.string().min(1, "显示名称不能为空").max(128),
});

export const RouteSchema = z.object({
  unified_model_id: z.string().uuid("请选择统一模型"),
  provider_resource_id: z.string().uuid("请选择资源"),
  upstream_model: z.string().min(1, "上游模型不能为空").max(128),
  priority: z.coerce.number().int(),
  weight: z.coerce.number().int().positive(),
});

export type BillingRuleValues = z.infer<typeof BillingRuleSchema>;
export type BillingRuleInput = z.input<typeof BillingRuleSchema>;
export type BillingWindowForm = z.infer<typeof BillingWindowFormSchema>;
export type UnifiedModelValues = z.infer<typeof UnifiedModelSchema>;
export type RouteValues = z.infer<typeof RouteSchema>;
export type RouteInput = z.input<typeof RouteSchema>;

export function localDateTimeValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function formatLifecycle(at: string, adminId: string | null): string {
  const time = new Date(at).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  return `${time} · ${adminId ? `操作人 ${adminId.slice(0, 8)}` : "操作人未知（历史数据）"}`;
}

export function editableWindows(rule: BillingRule): BillingWindowForm[] {
  const windows = rule.time_windows
    ?? (
      rule.timezone && rule.start_time && rule.end_time
        ? [{
            timezone: rule.timezone,
            days_of_week: rule.days_of_week,
            start_time: rule.start_time,
            end_time: rule.end_time,
          }]
        : []
    );
  return windows.map((window) => ({
    timezone: window.timezone,
    days_of_week: window.days_of_week?.join(",") ?? "",
    start_time: window.start_time.slice(0, 5),
    end_time: window.end_time.slice(0, 5),
  }));
}

function serializeWindows(windows: BillingWindowForm[]) {
  return windows.map((window) => ({
    timezone: window.timezone,
    days_of_week: window.days_of_week
      ? window.days_of_week.split(",").map((day) => Number(day.trim()))
      : null,
    start_time: window.start_time,
    end_time: window.end_time,
  }));
}

export function buildBillingRulePayload(values: BillingRuleValues) {
  return {
    rule_type: values.rule_type,
    pricing_mode: values.pricing_mode ?? "ABSOLUTE",
    rule_version: values.rule_version,
    provider_resource_id: values.provider_resource_id,
    upstream_model: values.upstream_model,
    effective_from: new Date(values.effective_from).toISOString(),
    effective_to: values.effective_to ? new Date(values.effective_to).toISOString() : null,
    windows: values.windows.length > 0 ? serializeWindows(values.windows) : null,
    multiplier: values.multiplier || null,
    cache_hit_price: normalizeToPerToken(values.cache_hit_price),
    cache_miss_price: normalizeToPerToken(values.cache_miss_price),
    output_price: normalizeToPerToken(values.output_price),
    priority: values.priority,
    currency: values.currency ?? "CNY",
    source: "WEB_ADMIN",
  };
}

export function principalList(data: { principals: Principal[] } | undefined): Principal[] {
  return data?.principals ?? [];
}

export function firstQueryError(errors: Array<Error | null>): Error | null {
  return errors.find((error) => error !== null && error !== undefined) ?? null;
}
