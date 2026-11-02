import { createHash } from "node:crypto";
import type { QuotaDb } from "./employee-quota-period-repository.js";
/** Evidence-only preview. Never infer a historical authorization from current grants. */
export async function previewEmployeeQuotaReconciliation(
  db: QuotaDb,
  input: {
    enterpriseId: string;
    principalIds: string[];
    start: Date;
    end: Date;
  },
) {
  if (!input.principalIds.length || !(input.end > input.start))
    throw new Error("quota_preview_scope_required");
  const lines = await db
    .selectFrom("ledger_line")
    .innerJoin("principal", "principal.id", "ledger_line.principal_id")
    .innerJoin(
      "provider_resource",
      "provider_resource.id",
      "ledger_line.provider_resource_id",
    )
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select([
      "ledger_line.id",
      "ledger_line.principal_id",
      "provider.code as provider",
      "ledger_line.resource_mode",
      "ledger_line.raw_input_tokens",
      "ledger_line.raw_output_tokens",
      "ledger_line.deducted_quota",
      "ledger_line.api_cost",
      "ledger_line.usage_quality",
      "ledger_line.settled_at",
    ])
    .where("ledger_line.enterprise_id", "=", input.enterpriseId)
    .where("principal.enterprise_id", "=", input.enterpriseId)
    .where("principal.type", "=", "EMPLOYEE")
    .where("ledger_line.principal_id", "in", input.principalIds)
    .where("ledger_line.settled_at", ">=", input.start)
    .where("ledger_line.settled_at", "<", input.end)
    .orderBy("ledger_line.id", "asc")
    .execute();
  const grants = await db
    .selectFrom("principal_grant")
    .leftJoin("quota_counter", "quota_counter.grant_id", "principal_grant.id")
    .innerJoin("principal", "principal.id", "principal_grant.principal_id")
    .select([
      "principal_grant.id",
      "principal_grant.principal_id",
      "principal_grant.provider",
      "principal_grant.version",
      "principal_grant.quota_basis",
      "principal_grant.quota_value",
      "principal_grant.allow_overage",
      "principal_grant.status",
      "principal_grant.valid_from",
      "principal_grant.valid_until",
      "quota_counter.used_value",
      "quota_counter.period_anchor",
    ])
    .where("principal_grant.enterprise_id", "=", input.enterpriseId)
    .where("principal.enterprise_id", "=", input.enterpriseId)
    .where("principal.type", "=", "EMPLOYEE")
    .where("principal_grant.principal_id", "in", input.principalIds)
    .where("pool_model_alias", "=", "*")
    .orderBy("principal_grant.id", "asc")
    .execute();
  const currentAuthorizationEvidence = grants.map((grant) => ({
    source: { table: "principal_grant", id: grant.id, version: grant.version },
    principalId: grant.principal_id,
    provider: grant.provider,
    basis: grant.quota_basis,
    currentTemplate: String(grant.quota_value),
    allowOverage: grant.allow_overage,
    status: grant.status,
    validFrom: grant.valid_from.toISOString(),
    validUntil: grant.valid_until?.toISOString() ?? null,
    legacyCounterStart: grant.period_anchor?.toISOString() ?? null,
    legacyUsed: grant.used_value === null ? null : String(grant.used_value),
    historicalAllocationProvable: false,
    quality: "UNKNOWN",
  }));
  const evidence = {
    schemaVersion: 1,
    mode: "READ_ONLY_PREVIEW",
    currentAuthorizationEvidence,
    scope: {
      enterpriseId: input.enterpriseId,
      principalIds: [...input.principalIds].sort(),
      start: input.start.toISOString(),
      end: input.end.toISOString(),
    },
    rows: lines.map((line) => ({
      source: { table: "ledger_line", id: line.id },
      principalId: line.principal_id,
      provider: line.provider,
      basis: line.resource_mode === "API" ? "RAW_TOKEN" : "PLAN_QUOTA",
      rawTokens: String(
        BigInt(line.raw_input_tokens) + BigInt(line.raw_output_tokens),
      ),
      planQuota:
        line.deducted_quota === null ? null : String(line.deducted_quota),
      apiCost: line.api_cost,
      usageQuality: line.usage_quality,
      settledAt: line.settled_at?.toISOString() ?? null,
      grantVersionProvable: false,
      originalValue: null,
      targetValue: null,
      difference: null,
      quality: "UNKNOWN",
      impact:
        "Historical allocation/version cannot be inferred from current grants; no apply authorized.",
    })),
  };
  return {
    ...evidence,
    hash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
}
