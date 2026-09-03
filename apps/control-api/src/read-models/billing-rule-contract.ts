import { z } from "zod";
import { DecimalString, TimeString } from "./dispatch-policy-contract.js";

const BillingWindowSchema = z.object({
  timezone: z.string().min(1).max(64),
  days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),
  start_time: TimeString,
  end_time: TimeString,
}).superRefine((window, ctx) => {
  if (window.start_time === window.end_time) {
    ctx.addIssue({ code: "custom", path: ["end_time"], message: "起止时间不能相同" });
  }
  if (window.days_of_week && new Set(window.days_of_week).size !== window.days_of_week.length) {
    ctx.addIssue({ code: "custom", path: ["days_of_week"], message: "星期不能重复" });
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: window.timezone }).format();
  } catch {
    ctx.addIssue({ code: "custom", path: ["timezone"], message: "无效 IANA 时区" });
  }
});

const BillingRuleSchema = z.object({
  rule_type: z.enum(["API_PRICE", "TIME_WINDOW", "MODEL_TIER", "CACHE_STATE"]),
  rule_version: z.string().min(1).max(64),
  provider_resource_id: z.string().uuid().nullable().optional(),
  upstream_model: z.string().min(1).max(128).nullable().optional(),
  effective_from: z.string().datetime(),
  effective_to: z.string().datetime().nullable().optional(),
  timezone: z.string().min(1).max(64).nullable().optional(),
  days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),
  start_time: TimeString.nullable().optional(),
  end_time: TimeString.nullable().optional(),
  windows: z.array(BillingWindowSchema).min(1).max(32).nullable().optional(),
  multiplier: DecimalString.nullable().optional(),
  cache_hit_price: DecimalString.nullable().optional(),
  cache_miss_price: DecimalString.nullable().optional(),
  output_price: DecimalString.nullable().optional(),
  currency: z.string().length(3).optional(),
  priority: z.number().int().min(0).optional(),
  source: z.string().max(255).nullable().optional(),
});

type BillingRuleInput = z.infer<typeof BillingRuleSchema>;

export const CreateBillingRuleSchema = BillingRuleSchema.superRefine((input, ctx) => {
  const windowState = validateWindowConfiguration(input, ctx);
  validateEffectivePeriod(input, ctx);
  validatePricingSemantics(input, ctx, windowState);
});

function validateWindowConfiguration(input: BillingRuleInput, ctx: z.RefinementCtx) {
  const windowParts = [input.timezone, input.start_time, input.end_time];
  const configuredWindowParts = windowParts.filter((value) => value !== null && value !== undefined);
  const hasWindows = Boolean(input.windows && input.windows.length > 0);
  if (hasWindows && configuredWindowParts.length > 0) {
    ctx.addIssue({ code: "custom", path: ["windows"], message: "windows 与旧版单时间窗字段不能同时配置" });
  }
  if (configuredWindowParts.length !== 0 && configuredWindowParts.length !== windowParts.length) {
    ctx.addIssue({ code: "custom", path: ["timezone"], message: "timezone、start_time、end_time 必须同时配置" });
  }
  if (input.start_time && input.end_time && input.start_time === input.end_time) {
    ctx.addIssue({ code: "custom", path: ["end_time"], message: "起止时间不能相同" });
  }
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format();
    } catch {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "无效 IANA 时区" });
    }
  }
  if (input.days_of_week && new Set(input.days_of_week).size !== input.days_of_week.length) {
    ctx.addIssue({ code: "custom", path: ["days_of_week"], message: "星期不能重复" });
  }
  if (input.days_of_week && configuredWindowParts.length !== windowParts.length) {
    ctx.addIssue({ code: "custom", path: ["days_of_week"], message: "星期限制必须配合完整时间窗" });
  }
  if (input.windows) {
    const keys = input.windows.map((window) =>
      `${window.timezone}|${window.days_of_week?.join(",") ?? "*"}|${window.start_time}|${window.end_time}`
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", path: ["windows"], message: "时间窗不能重复" });
    }
  }
  return { hasWindows, configuredWindowPartsCount: configuredWindowParts.length, windowPartsCount: windowParts.length };
}

function validateEffectivePeriod(input: BillingRuleInput, ctx: z.RefinementCtx): void {
  if (input.effective_to && new Date(input.effective_to) <= new Date(input.effective_from)) {
    ctx.addIssue({ code: "custom", path: ["effective_to"], message: "effective_to 必须晚于 effective_from" });
  }
}

function validatePricingSemantics(
  input: BillingRuleInput,
  ctx: z.RefinementCtx,
  windowState: ReturnType<typeof validateWindowConfiguration>,
): void {
  const prices = [input.cache_hit_price, input.cache_miss_price, input.output_price];
  if (input.rule_type === "API_PRICE") {
    if (input.multiplier !== null && input.multiplier !== undefined) {
      ctx.addIssue({ code: "custom", path: ["multiplier"], message: "API 价格规则不能配置额度倍率" });
    }
    if (prices.every((value) => value === null || value === undefined)) {
      ctx.addIssue({ code: "custom", path: ["cache_miss_price"], message: "API 价格规则至少配置一个单价" });
    }
  }
  if (input.rule_type === "TIME_WINDOW" || input.rule_type === "MODEL_TIER") {
    if (input.multiplier === null || input.multiplier === undefined) {
      ctx.addIssue({ code: "custom", path: ["multiplier"], message: "额度规则必须配置倍率" });
    }
    if (prices.some((value) => value !== null && value !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["cache_miss_price"], message: "额度倍率规则不能配置 API 单价" });
    }
  }
  if (input.rule_type === "TIME_WINDOW" && !windowState.hasWindows
    && windowState.configuredWindowPartsCount !== windowState.windowPartsCount) {
    ctx.addIssue({ code: "custom", path: ["start_time"], message: "时段倍率规则必须配置完整时间窗" });
  }
  if (input.rule_type === "MODEL_TIER"
    && (windowState.hasWindows || windowState.configuredWindowPartsCount > 0 || input.days_of_week)) {
    ctx.addIssue({ code: "custom", path: ["timezone"], message: "模型档位规则不使用时间窗" });
  }
}
