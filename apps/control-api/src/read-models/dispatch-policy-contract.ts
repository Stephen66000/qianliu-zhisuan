import { z } from "zod";

export const DecimalString = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((value) => /^\d+(?:\.\d+)?$/.test(value), {
    message: "价格必须是非负十进制数",
  });

export const TimeString = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);

export const CreateDispatchPolicySchema = z
  .object({
    match_unified_model: z.string().min(1).max(64).nullable().optional(),
    match_resource_mode: z.enum(["API", "CODING_PLAN"]).nullable().optional(),
    match_provider_resource_id: z.string().uuid().nullable().optional(),
    match_timezone: z.string().min(1).max(64).nullable().optional(),
    match_days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),
    match_start_time: TimeString.nullable().optional(),
    match_end_time: TimeString.nullable().optional(),
    match_price_multiplier_min: DecimalString.nullable().optional(),
    match_remaining_quota_ratio_max: z
      .union([z.string(), z.number()])
      .transform(Number)
      .refine((value) => Number.isFinite(value) && value >= 0 && value <= 1)
      .transform(String)
      .nullable()
      .optional(),
    match_forecast_exhaust_risk: z.boolean().nullable().optional(),
    match_principal_scope: z.array(z.string().uuid()).max(500).nullable().optional(),
    action: z.enum(["ALLOW", "SWITCH", "RATE_LIMIT", "REJECT", "ALLOW_OVERAGE"]),
    switch_equivalent_group: z.array(z.string().uuid()).max(100).nullable().optional(),
    rate_limit_per_minute: z.number().int().positive().nullable().optional(),
    policy_version: z.string().min(1).max(32),
    priority: z.number().int().min(0).optional(),
    description: z.string().max(2000).nullable().optional(),
    source: z.string().max(128).nullable().optional(),
  })
  .superRefine((input, ctx) => {
    const timeParts = [
      input.match_timezone,
      input.match_start_time,
      input.match_end_time,
    ].filter((value) => value !== null && value !== undefined);
    if (timeParts.length !== 0 && timeParts.length !== 3) {
      ctx.addIssue({
        code: "custom",
        path: ["match_timezone"],
        message: "时区和起止时间必须同时配置",
      });
    }
    if (input.match_start_time && input.match_start_time === input.match_end_time) {
      ctx.addIssue({ code: "custom", path: ["match_end_time"], message: "起止时间不能相同" });
    }
    if (input.match_timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: input.match_timezone }).format();
      } catch {
        ctx.addIssue({ code: "custom", path: ["match_timezone"], message: "无效 IANA 时区" });
      }
    }
    if (
      input.match_days_of_week
      && new Set(input.match_days_of_week).size !== input.match_days_of_week.length
    ) {
      ctx.addIssue({ code: "custom", path: ["match_days_of_week"], message: "星期不能重复" });
    }
    if (input.match_days_of_week && timeParts.length !== 3) {
      ctx.addIssue({ code: "custom", path: ["match_days_of_week"], message: "星期限制必须配合完整时间窗" });
    }
    if (
      input.action === "SWITCH"
      && (!input.switch_equivalent_group || input.switch_equivalent_group.length < 2)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["switch_equivalent_group"],
        message: "SWITCH 至少配置两个等价资源",
      });
    }
    if (input.action === "RATE_LIMIT" && !input.rate_limit_per_minute) {
      ctx.addIssue({
        code: "custom",
        path: ["rate_limit_per_minute"],
        message: "RATE_LIMIT 必须配置每分钟请求数",
      });
    }
  });

export function dispatchPolicyFields(input: z.output<typeof CreateDispatchPolicySchema>) {
  return {
    matchUnifiedModel: input.match_unified_model ?? null,
    matchResourceMode: input.match_resource_mode ?? null,
    matchProviderResourceId: input.match_provider_resource_id ?? null,
    matchTimezone: input.match_timezone ?? null,
    matchDaysOfWeek: input.match_days_of_week ?? null,
    matchStartTime: input.match_start_time ?? null,
    matchEndTime: input.match_end_time ?? null,
    matchPriceMultiplierMin: input.match_price_multiplier_min ?? null,
    matchRemainingQuotaRatioMax: input.match_remaining_quota_ratio_max ?? null,
    matchForecastExhaustRisk: input.match_forecast_exhaust_risk ?? null,
    matchPrincipalScope: input.match_principal_scope ?? null,
    action: input.action,
    switchEquivalentGroup: input.switch_equivalent_group ?? null,
    rateLimitPerMinute: input.rate_limit_per_minute ?? null,
    policyVersion: input.policy_version,
    priority: input.priority,
    description: input.description,
    source: input.source ?? "WEB_ADMIN",
  };
}
