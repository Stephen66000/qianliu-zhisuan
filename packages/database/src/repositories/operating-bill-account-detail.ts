import { finishAccountSummary } from "./operating-bill-account-aggregate.js";
import { usageShare } from "./operating-bill-account-aggregate.js";
import type {
  OperatingBillAccountTotals,
  OperatingBillModelRow,
  OperatingBillProviderModelsRow,
} from "./operating-bill-account-types.js";

export interface RawEmployeeAccountSummary {
  level: "TOTAL" | "PROVIDER" | "MODEL";
  provider_code: string | null;
  provider_name: string | null;
  model_key: string | null;
  unified_model_id: string | null;
  current_alias: string | null;
  historical_aliases: string[] | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_tokens: string | null;
  reasoning_tokens: string | null;
  deducted_quota: string | null;
  api_cost: string | null;
  package_allocated_cost: string | null;
  quality_signature: string | null;
  active_days: string;
  request_count: string;
  last_used_at: Date | null;
}

function totals(row: RawEmployeeAccountSummary | undefined): OperatingBillAccountTotals {
  return finishAccountSummary({
    inputTokens: row?.input_tokens ?? "0",
    outputTokens: row?.output_tokens ?? "0",
    cacheTokens: row?.cache_tokens ?? "0",
    reasoningTokens: row?.reasoning_tokens ?? "0",
    deductedQuota: row?.deducted_quota ?? (row ? null : "0"),
    apiCost: row?.api_cost ?? (row ? null : "0"),
    packageAllocatedCost: row?.package_allocated_cost ?? (row ? null : "0"),
    qualities: row?.quality_signature?.split(",") ?? [],
    activeDays: Number(row?.active_days ?? 0),
    requestCount: Number(row?.request_count ?? 0),
    lastUsedAt: row?.last_used_at ?? null,
  });
}

export function buildEmployeeAccountSummary(rows: RawEmployeeAccountSummary[]): {
  totals: OperatingBillAccountTotals;
  providers: OperatingBillProviderModelsRow[];
  gaps: Array<{ code: "MODEL_ID_UNRESOLVED"; historicalAlias: string }>;
} {
  const providers = new Map<string, OperatingBillProviderModelsRow>();
  for (const row of rows.filter((item) => item.level === "PROVIDER")) {
    providers.set(row.provider_code!, {
      providerCode: row.provider_code!,
      providerName: row.provider_name!,
      totals: totals(row),
      models: [],
    });
  }
  const unresolved = new Set<string>();
  for (const row of rows.filter((item) => item.level === "MODEL")) {
    const provider = providers.get(row.provider_code!);
    if (!provider) continue;
    const modelTotals = totals(row);
    const historicalAliases = row.historical_aliases ?? [];
    if (!row.unified_model_id) for (const alias of historicalAliases) unresolved.add(alias);
    const model: OperatingBillModelRow = {
      unifiedModelId: row.unified_model_id,
      identityStatus: row.unified_model_id ? "RESOLVED" : "UNRESOLVED",
      currentAlias: row.current_alias,
      historicalAliases,
      totals: modelTotals,
      usageShare: usageShare(modelTotals, provider.totals),
    };
    provider.models.push(model);
  }
  const result = [...providers.values()];
  for (const provider of result) {
    provider.models.sort((left, right) => (left.currentAlias ?? left.historicalAliases[0] ?? "")
      .localeCompare(right.currentAlias ?? right.historicalAliases[0] ?? ""));
  }
  result.sort((left, right) => left.providerName.localeCompare(right.providerName));
  return {
    totals: totals(rows.find((row) => row.level === "TOTAL")),
    providers: result,
    gaps: [...unresolved].sort().map((historicalAlias) => ({
      code: "MODEL_ID_UNRESOLVED" as const,
      historicalAlias,
    })),
  };
}
