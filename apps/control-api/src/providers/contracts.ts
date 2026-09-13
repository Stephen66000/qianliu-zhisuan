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
    const resetCycle = snapshot.reset_cycle?.toUpperCase() ?? "NONE";
    if (!["NONE", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"].includes(resetCycle)) {
      return "重置周期必须是不重置、每日、每周、每月、每季或每年";
    }
    if (resetCycle !== "NONE" && !snapshot.reset_anchor_at) return "启用周期重置时必须填写重置日期";
  }
  return null;
}

export function financeManagedOperatingSnapshotError(
  mode: "API" | "CODING_PLAN",
  snapshot: z.output<typeof OperatingSnapshotSchema>,
): string | null {
  if (snapshot.source !== "ADMIN") return null;
  const financeFields = mode === "API"
    ? ["recharge_amount", "current_balance", "cumulative_cost", "current_period_cost",
      "cost_period_start", "cost_period_end", "balance_updated_at"] as const
    : ["package_cost", "effective_from", "effective_until"] as const;
  const populated = financeFields.filter((field) => {
    const value = snapshot[field];
    return value !== null && value !== undefined && value !== "";
  });
  return populated.length > 0
    ? `资金字段只能在充值与订阅模块登记：${populated.join(", ")}` : null;
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

export const ModelValidationSchema = z.object({
  idempotency_key: z.string().min(8).max(128),
  confirm_quota_consumption: z.literal(true),
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
    parser_version: discovery.parserVersion,
    source_url: discovery.sourceUrl,
    source_etag: discovery.sourceEtag,
    source_last_modified: discovery.sourceLastModified,
    source_content_hash: discovery.sourceContentHash,
    source_checked_at: discovery.sourceCheckedAt.toISOString(),
    discovered_at: discovery.discoveredAt.toISOString(),
    stale: discovery.stale,
    reused: discovery.reused,
    models: discovery.models.filter((model) => model.compatible),
    catalog_diff: discovery.catalogDiff ? {
      added: discovery.catalogDiff.added,
      retained: discovery.catalogDiff.retained,
      not_advertised: discovery.catalogDiff.notAdvertised,
    } : null,
    integration_states: discovery.integrationStates.map((state) => ({
      upstream_model: state.upstreamModel,
      unified_model_exists: state.unifiedModelExists,
      current_resource_route: state.currentResourceRoute,
    })),
    ...(discovery.failureCode ? { failure_code: discovery.failureCode } : {}),
  };
}

export function publicStoredDiscovery(input: {
  discovery: {
    source: string;
    source_version: string;
    parser_version: string | null;
    source_url: string | null;
    source_etag: string | null;
    source_last_modified: string | null;
    source_content_hash: string | null;
    source_checked_at: Date | null;
    discovered_at: Date;
    stale: boolean;
    status: string;
    failure_code: string | null;
  };
  items: Array<{
    upstream_model: string;
    display_name: string;
    model_type: "CHAT" | "EMBEDDING" | "IMAGE" | "UNKNOWN";
    capabilities: string[];
    source: string;
    compatible: boolean;
    unavailable_reason: string | null;
    facts: Record<string, unknown>;
    availability_status: "AVAILABLE" | "REMOVED";
  }>;
  itemsStale: boolean;
  catalogDiff?: { added: string[]; retained: string[]; notAdvertised: string[] } | null;
  integrationStates?: Array<{ upstreamModel: string; unifiedModelExists: boolean; currentResourceRoute: string }>;
  reused?: boolean;
  failureCode?: string | null;
}) {
  const checkedAt = input.discovery.source_checked_at ?? input.discovery.discovered_at;
  return {
    source: input.discovery.source,
    source_version: input.discovery.source_version,
    parser_version: input.discovery.parser_version,
    source_url: input.discovery.source_url,
    source_etag: input.discovery.source_etag,
    source_last_modified: input.discovery.source_last_modified,
    source_content_hash: input.discovery.source_content_hash,
    source_checked_at: checkedAt.toISOString(),
    discovered_at: input.discovery.discovered_at.toISOString(),
    stale: input.itemsStale || input.discovery.stale,
    reused: input.reused ?? false,
    models: input.items.filter((item) => item.compatible).map((item) => ({
      id: item.upstream_model,
      displayName: item.display_name,
      modelType: item.model_type,
      capabilities: item.capabilities,
      source: item.source,
      compatible: item.compatible,
      unavailableReason: item.unavailable_reason,
      facts: item.facts,
      availabilityStatus: item.availability_status,
    })),
    catalog_diff: input.catalogDiff ? {
      added: input.catalogDiff.added,
      retained: input.catalogDiff.retained,
      not_advertised: input.catalogDiff.notAdvertised,
    } : null,
    integration_states: input.integrationStates?.map((state) => ({
      upstream_model: state.upstreamModel,
      unified_model_exists: state.unifiedModelExists,
      current_resource_route: state.currentResourceRoute,
    })) ?? [],
    ...(input.failureCode ? { failure_code: input.failureCode } : {}),
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
    parser_version: cause.parserVersion ?? null,
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
