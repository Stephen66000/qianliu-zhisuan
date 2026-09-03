import { z } from "zod";
import { OperatingSnapshotSchema } from "../providers/contracts.js";
import type { ResourceViewInput } from "./types.js";

const ExpectedVersion = z.number().int().positive();
const QuotaValue = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+$/.test(value), { message: "额度必须是非负整数" })
  .transform((value) => BigInt(value));

export const UpdateResourceSchema = z.object({
  expected_version: ExpectedVersion,
  name: z.string().min(1).max(255).optional(),
  concurrency_limit: z.number().int().positive().nullable().optional(),
  upstream_models: z.array(z.string().min(1).max(128)).max(100).nullable().optional(),
  operating_snapshot: OperatingSnapshotSchema.optional(),
}).strict();

export const UpdateUnifiedModelSchema = z.object({
  expected_version: ExpectedVersion,
  display_name: z.string().min(1).max(128).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

export const UpdateModelRouteSchema = z.object({
  expected_version: ExpectedVersion,
  priority: z.number().int().optional(),
  weight: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

export const UpdateGrantSchema = z.object({
  expected_version: ExpectedVersion,
  quota_value: QuotaValue.optional(),
  allow_overage: z.boolean().optional(),
  valid_until: z.string().datetime().nullable().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

export const UpdateBillingRuleSchema = z.object({
  expected_version: ExpectedVersion,
  effective_to: z.string().datetime().nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();

export const ArchiveLifecycleSchema = z.object({ expected_version: ExpectedVersion }).strict();
export const RecoverResourceSchema = z.object({
  credential_plaintext: z.string().min(1).optional(),
});

/** 资源公开视图（绝不返回密文/明文）。 */
export function resourceView(resource: ResourceViewInput, operatingSnapshot: unknown = null) {
  return {
    id: resource.id,
    provider_id: resource.provider_id,
    name: resource.name,
    mode: resource.mode,
    credential_type: resource.credential_type,
    credential_fingerprint: resource.credential_fingerprint,
    credential_version: resource.credential_version,
    status: resource.status,
    upstream_models: resource.upstream_models,
    concurrency_limit: resource.concurrency_limit,
    version: resource.version,
    monthly_budget_amount: resource.monthly_budget_amount ?? null,
    monthly_budget_currency: resource.monthly_budget_currency ?? null,
    created_at: resource.created_at,
    updated_at: resource.updated_at,
    operating_snapshot: operatingSnapshot,
  };
}
