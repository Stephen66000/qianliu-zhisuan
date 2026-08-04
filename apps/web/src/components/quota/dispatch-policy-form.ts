import { z } from "zod";

const OptionalTime = z.string().refine(
  (value) => value === "" || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value),
  "时间格式应为 HH:mm",
);
const OptionalDecimal = z.string().refine(
  (value) => value === "" || /^\d+(?:\.\d+)?$/.test(value),
  "请输入非负数字",
);

export const DispatchPolicyFormSchema = z.object({
  match_unified_model: z.string(),
  match_resource_mode: z.enum(["", "API", "CODING_PLAN"]),
  match_provider_resource_id: z.string(),
  match_timezone: z.string().max(64),
  match_days_of_week: z.string().refine(
    (value) => value === "" || value.split(",").every((day) => /^[1-7]$/.test(day.trim())),
    "星期使用 1-7，以逗号分隔",
  ),
  match_start_time: OptionalTime,
  match_end_time: OptionalTime,
  match_price_multiplier_min: OptionalDecimal,
  match_remaining_quota_ratio_max: z.string().refine(
    (value) => value === "" || /^\d+(?:\.\d+)?$/.test(value) && Number(value) >= 0 && Number(value) <= 1,
    "额度比例应为 0 到 1",
  ),
  match_forecast_exhaust_risk: z.boolean(),
  match_principal_scope_mode: z.enum(["ALL", "SELECTED"]),
  match_principal_scope: z.array(z.string().uuid()),
  action: z.enum(["ALLOW", "SWITCH", "RATE_LIMIT", "REJECT", "ALLOW_OVERAGE"]),
  switch_equivalent_group: z.string(),
  rate_limit_per_minute: z.string().refine(
    (value) => value === "" || /^\d+$/.test(value) && Number(value) > 0,
    "限流值必须是正整数",
  ),
  policy_version: z.string().min(1, "版本不能为空").max(32),
  priority: z.coerce.number().int().min(0),
  description: z.string().max(2000),
}).superRefine((input, ctx) => {
  const timeParts = [input.match_timezone, input.match_start_time, input.match_end_time].filter(Boolean);
  if (timeParts.length !== 0 && timeParts.length !== 3) {
    ctx.addIssue({ code: "custom", path: ["match_timezone"], message: "时区和起止时间必须同时填写" });
  }
  if (input.match_start_time && input.match_start_time === input.match_end_time) {
    ctx.addIssue({ code: "custom", path: ["match_end_time"], message: "起止时间不能相同" });
  }
  if (input.action === "SWITCH") {
    const ids = input.switch_equivalent_group.split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length < 2) {
      ctx.addIssue({ code: "custom", path: ["switch_equivalent_group"], message: "至少选择两个等价资源" });
    }
  }
  if (input.action === "RATE_LIMIT" && !input.rate_limit_per_minute) {
    ctx.addIssue({ code: "custom", path: ["rate_limit_per_minute"], message: "请填写每分钟请求数" });
  }
  if (input.match_principal_scope_mode === "SELECTED" && input.match_principal_scope.length === 0) {
    ctx.addIssue({ code: "custom", path: ["match_principal_scope"], message: "请至少选择一个主体" });
  }
});

export type DispatchPolicyValues = z.infer<typeof DispatchPolicyFormSchema>;
export type DispatchPolicyInput = z.input<typeof DispatchPolicyFormSchema>;

export function buildDispatchPolicyPayload(values: DispatchPolicyValues) {
  const split = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
  return {
    match_unified_model: values.match_unified_model || null,
    match_resource_mode: values.match_resource_mode || null,
    match_provider_resource_id: values.match_provider_resource_id || null,
    match_timezone: values.match_timezone || null,
    match_days_of_week: values.match_days_of_week ? split(values.match_days_of_week).map(Number) : null,
    match_start_time: values.match_start_time || null,
    match_end_time: values.match_end_time || null,
    match_price_multiplier_min: values.match_price_multiplier_min || null,
    match_remaining_quota_ratio_max: values.match_remaining_quota_ratio_max || null,
    match_forecast_exhaust_risk: values.match_forecast_exhaust_risk || null,
    match_principal_scope: values.match_principal_scope_mode === "SELECTED"
      ? values.match_principal_scope : null,
    action: values.action,
    switch_equivalent_group: values.action === "SWITCH" ? split(values.switch_equivalent_group) : null,
    rate_limit_per_minute: values.action === "RATE_LIMIT" ? Number(values.rate_limit_per_minute) : null,
    policy_version: values.policy_version,
    priority: values.priority,
    description: values.description || null,
    source: "WEB_ADMIN",
  };
}
