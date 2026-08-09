export interface PrincipalAccessModelRow {
  unified_model_id: string;
  display_name: string;
  alias: string;
  provider_code: string;
  provider_name: string;
  provider_resource_id: string;
  resource_name: string;
  mode: "API" | "CODING_PLAN";
  resource_status: string;
  model_status: string;
  route_enabled: boolean;
  ready: boolean;
  unavailable_reasons: string[];
}

export interface PrincipalAccessPoolRow {
  id: string;
  provider: string;
  quota_value: bigint;
  allow_overage: boolean;
  valid_until: Date | null;
  used_value: bigint;
  source: string;
}

/** 将仓储查询结果装配成按厂商分块的单主体接入读模型。 */
export function assemblePrincipalAccessReadModel(input: {
  principal: { id: string; name: string; status: string; department_label: string | null };
  key: { key_prefix: string; status: string; created_at: Date } | undefined;
  models: PrincipalAccessModelRow[];
  pools: PrincipalAccessPoolRow[];
  disabledKeys: Set<string>;
  manualPendingIds: string[];
  configVersion: number;
}) {
  const byProvider = new Map<string, { name: string; models: PrincipalAccessModelRow[] }>();
  for (const model of input.models) {
    const bucket = byProvider.get(model.provider_code) ?? { name: model.provider_name, models: [] };
    bucket.models.push(model);
    byProvider.set(model.provider_code, bucket);
  }
  const providers = [...byProvider.entries()].map(([code, bucket]) => {
    const pool = input.pools.find((item) => item.provider === code) ?? null;
    return {
      provider_code: code,
      provider_name: bucket.name,
      pool: pool ? {
        grant_id: pool.id,
        quota_value: pool.quota_value.toString(),
        quota_used: pool.used_value.toString(),
        allow_overage: pool.allow_overage,
        valid_until: pool.valid_until,
        source: pool.source,
        over_limit: pool.used_value > pool.quota_value,
      } : null,
      models: bucket.models.map((model) => ({
        unified_model_id: model.unified_model_id,
        display_name: model.display_name,
        alias: model.alias,
        provider_resource_id: model.provider_resource_id,
        resource_name: model.resource_name,
        resource_mode: model.mode,
        ready: model.ready,
        unavailable_reasons: model.unavailable_reasons,
        enabled: pool !== null && !input.disabledKeys.has(`${code}:${model.unified_model_id}`),
      })),
    };
  });
  const enabledModelCount = providers.reduce(
    (count, provider) => count + provider.models.filter((model) => model.enabled).length,
    0,
  );
  return {
    principal: input.principal,
    key: input.key ? {
      key_prefix: input.key.key_prefix,
      status: input.key.status,
      created_at: input.key.created_at,
      authorization_status: enabledModelCount > 0 ? "AUTHORIZED" : "PENDING",
    } : null,
    providers,
    summary: {
      total_quota: input.pools.reduce((total, pool) => total + pool.quota_value, 0n).toString(),
      provider_count: input.pools.length,
      model_count: enabledModelCount,
    },
    manual_pending_takeover: input.manualPendingIds,
    config_version: input.configVersion,
  };
}
