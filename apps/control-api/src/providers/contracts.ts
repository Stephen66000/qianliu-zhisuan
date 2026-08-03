import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import {
  type discoverProviderModels,
  ProviderModelDiscoveryError,
  type DiscoveredProviderModel,
  type ProviderCode,
} from "@qianliu/provider-adapters";

export const CreateProviderSchema = z.object({
  code: z.enum(["deepseek", "zhipu", "kimi"]),
  name: z.string().min(1).max(128),
  adapter_type: z.string().min(1).max(32),
  supported_protocols: z.array(z.string()).optional(),
  capability_set: z.record(z.string(), z.unknown()).optional(),
});

const DecimalText = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d+)?$/.test(value), "必须是非负十进制数");

const ADMIN_MONEY_FIELDS = [
  "recharge_amount",
  "current_balance",
  "cumulative_cost",
  "current_period_cost",
  "package_cost",
] as const;

export const OperatingSnapshotSchema = z.object({
  source: z.enum(["ADMIN", "PROVIDER_SYNC", "BILL_RECONCILIATION"]).default("ADMIN"),
  collected_at: z.string().datetime(),
  currency: z.string().min(3).max(8).nullable().optional(),
  recharge_amount: DecimalText.nullable().optional(),
  current_balance: DecimalText.nullable().optional(),
  cumulative_cost: DecimalText.nullable().optional(),
  current_period_cost: DecimalText.nullable().optional(),
  cost_period_start: z.string().datetime().nullable().optional(),
  cost_period_end: z.string().datetime().nullable().optional(),
  balance_updated_at: z.string().datetime().nullable().optional(),
  package_name: z.string().max(255).nullable().optional(),
  package_cost: DecimalText.nullable().optional(),
  total_quota: DecimalText.nullable().optional(),
  quota_unit: z.string().min(1).max(32).nullable().optional(),
  used_quota: DecimalText.nullable().optional(),
  remaining_quota: DecimalText.nullable().optional(),
  effective_from: z.string().datetime().nullable().optional(),
  effective_until: z.string().datetime().nullable().optional(),
  reset_cycle: z.string().max(32).nullable().optional(),
  reset_anchor_at: z.string().datetime().nullable().optional(),
  next_reset_at: z.string().datetime().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.source === "ADMIN") {
    for (const field of ADMIN_MONEY_FIELDS) {
      const amount = value[field];
      if (amount !== null && amount !== undefined && !/^\d+(?:\.\d{1,2})?$/.test(amount)) {
        ctx.addIssue({ code: "custom", path: [field], message: "人工录入金额最多保留两位小数" });
      }
    }
  }
  if (value.effective_from && value.effective_until
      && new Date(value.effective_until) <= new Date(value.effective_from)) {
    ctx.addIssue({ code: "custom", path: ["effective_until"], message: "套餐失效时间必须晚于生效时间" });
  }
  if (value.total_quota !== null && value.total_quota !== undefined
      && value.used_quota !== null && value.used_quota !== undefined
      && value.remaining_quota !== null && value.remaining_quota !== undefined
      && !new Decimal(value.total_quota).equals(new Decimal(value.used_quota).plus(value.remaining_quota))) {
    ctx.addIssue({ code: "custom", path: ["remaining_quota"], message: "总额度必须等于已用额度加剩余额度" });
  }
});

const API_ONLY_OPERATING_FIELDS = [
  "recharge_amount", "current_balance", "cumulative_cost", "current_period_cost",
  "cost_period_start", "cost_period_end", "balance_updated_at",
] as const;

const PLAN_ONLY_OPERATING_FIELDS = [
  "package_name", "package_cost", "total_quota", "quota_unit", "used_quota",
  "remaining_quota", "effective_from", "effective_until", "reset_cycle",
  "reset_anchor_at", "next_reset_at",
] as const;

export function operatingSnapshotModeError(
  mode: "API" | "CODING_PLAN",
  snapshot: z.output<typeof OperatingSnapshotSchema>,
): string | null {
  const forbidden = mode === "API" ? PLAN_ONLY_OPERATING_FIELDS : API_ONLY_OPERATING_FIELDS;
  const populated = forbidden.filter((field) => {
    const value = snapshot[field];
    return value !== null && value !== undefined && value !== "";
  });
  if (populated.length > 0) {
    return mode === "API"
      ? `API 资源不能写入套餐字段：${populated.join(", ")}`
      : `套餐资源不能写入 API 充值/余额字段：${populated.join(", ")}`;
  }
  if (mode === "CODING_PLAN" && snapshot.source === "ADMIN") {
    if (!snapshot.total_quota) return "套餐资源必须填写总额度";
    if (!snapshot.effective_from) return "套餐资源必须填写生效时间";
    const resetCycle = snapshot.reset_cycle?.toUpperCase() ?? "NONE";
    if (!["NONE", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"].includes(resetCycle)) {
      return "重置周期必须是不重置、每日、每周、每月、每季或每年";
    }
    if (resetCycle !== "NONE" && !snapshot.reset_anchor_at) return "启用周期重置时必须填写重置日期";
  }
  return null;
}

export const CreateResourceSchema = z.object({
  provider_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  mode: z.enum(["API", "CODING_PLAN"]),
  credential_type: z.enum(["API_KEY", "OAUTH", "SUBSCRIPTION_SESSION"]),
  credential_plaintext: z.string().min(1),
  upstream_models: z.array(z.string()).optional(),
  concurrency_limit: z.number().int().positive().optional(),
  operating_snapshot: OperatingSnapshotSchema.optional(),
});

export const ModelDiscoverySchema = z.object({
  provider_id: z.string().uuid(),
  mode: z.enum(["API", "CODING_PLAN"]),
  credential_plaintext: z.string().min(1),
});

export const OnboardResourceSchema = CreateResourceSchema.omit({ upstream_models: true }).extend({
  idempotency_key: z.string().min(8).max(128),
  selected_model_ids: z.array(z.string().min(1).max(128)).min(1).max(100),
});

export const ConfirmDiscoveredModelsSchema = z.object({
  selected_model_ids: z.array(z.string().min(1).max(128)).min(1).max(100),
});

export const CreateUnifiedModelSchema = z.object({
  alias: z.string().min(1).max(64),
  display_name: z.string().min(1).max(128),
  required_capabilities: z.array(z.string()).optional(),
});

export const CreateRouteSchema = z.object({
  unified_model_id: z.string().uuid(),
  provider_resource_id: z.string().uuid(),
  upstream_model: z.string().min(1).max(128),
  priority: z.number().int().optional(),
  weight: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

export function isProviderCode(value: string): value is ProviderCode {
  return value === "deepseek" || value === "zhipu" || value === "kimi";
}

export function publicDiscovery(discovery: Awaited<ReturnType<typeof discoverProviderModels>>) {
  return {
    source: discovery.source,
    source_version: discovery.sourceVersion,
    discovered_at: discovery.discoveredAt.toISOString(),
    models: discovery.models,
  };
}

export function selectCompatibleModels(models: DiscoveredProviderModel[], selectedIds: string[]) {
  const selected = new Set(selectedIds);
  const matches = models.filter((model) => selected.has(model.id) && model.compatible);
  return matches.length === selected.size ? matches : null;
}

export function onboardingRequestFingerprint(input: {
  providerCode: ProviderCode;
  providerId: string;
  name: string;
  mode: "API" | "CODING_PLAN";
  credentialType: "API_KEY" | "OAUTH" | "SUBSCRIPTION_SESSION";
  credentialFingerprint: string;
  concurrencyLimit?: number;
  operatingSnapshot?: z.output<typeof OperatingSnapshotSchema>;
  selectedModelIds: string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    provider_code: input.providerCode,
    provider_id: input.providerId,
    name: input.name,
    mode: input.mode,
    credential_type: input.credentialType,
    credential_fingerprint: input.credentialFingerprint,
    concurrency_limit: input.concurrencyLimit ?? null,
    operating_snapshot: input.operatingSnapshot ?? null,
    selected_model_ids: [...input.selectedModelIds].sort(),
  })).digest("hex");
}

export function sendDiscoveryError(
  reply: { code(status: number): { send(body: unknown): unknown } },
  cause: unknown,
) {
  if (!(cause instanceof ProviderModelDiscoveryError)) throw cause;
  const status = cause.code === "UNAUTHORIZED" ? 401 : cause.code === "RATE_LIMITED" ? 429 : 502;
  return reply.code(status).send({
    error: `model_discovery_${cause.code.toLowerCase()}`,
    message: cause.message,
  });
}

export function toOperatingSnapshotInput(
  value: z.output<typeof OperatingSnapshotSchema>,
  mode: "API" | "CODING_PLAN",
) {
  const systemCalculated = value.source === "ADMIN" && mode === "CODING_PLAN";
  return {
    ...value,
    used_quota: systemCalculated ? null : value.used_quota,
    remaining_quota: systemCalculated ? null : value.remaining_quota,
    next_reset_at: systemCalculated ? null : value.next_reset_at ? new Date(value.next_reset_at) : null,
    usage_calculation: systemCalculated ? "SYSTEM_LEDGER" as const : "MANUAL_SNAPSHOT" as const,
    reset_timezone: systemCalculated ? "Asia/Shanghai" : null,
    reset_cycle: systemCalculated ? value.reset_cycle ?? "NONE" : value.reset_cycle,
    collected_at: new Date(value.collected_at),
    cost_period_start: value.cost_period_start ? new Date(value.cost_period_start) : null,
    cost_period_end: value.cost_period_end ? new Date(value.cost_period_end) : null,
    balance_updated_at: value.balance_updated_at ? new Date(value.balance_updated_at) : null,
    effective_from: value.effective_from ? new Date(value.effective_from) : null,
    effective_until: value.effective_until ? new Date(value.effective_until) : null,
    reset_anchor_at: value.reset_anchor_at ? new Date(value.reset_anchor_at) : null,
  };
}
