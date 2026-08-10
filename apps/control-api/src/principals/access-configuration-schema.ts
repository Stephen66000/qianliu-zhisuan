import { z } from "zod";

const PoolSchema = z.object({
  provider_code: z.string().trim().min(1).max(32),
  quota_value: z.string().regex(/^\d+$/, "额度必须是非负整数字符串").transform((value) => BigInt(value)),
  allow_overage: z.boolean().default(false),
  valid_until: z.coerce.date().nullable().default(null),
  enabled_model_ids: z.array(z.string().uuid().transform((id) => id.toLowerCase()))
    .refine((ids) => new Set(ids).size === ids.length, "enabled_model_ids 不能重复")
    .default([]),
});

export const PrincipalAccessConfigurationPutSchema = z.object({
  expected_version: z.number().int().positive(),
  idempotency_key: z.string().trim().min(8).max(128),
  providers: z.array(PoolSchema)
    .refine(
      (providers) => new Set(providers.map((provider) => provider.provider_code)).size === providers.length,
      "provider_code 不能重复",
    )
    .default([]),
});
