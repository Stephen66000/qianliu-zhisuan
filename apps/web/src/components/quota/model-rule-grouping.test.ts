import { describe, expect, it } from "vitest";
import type { BillingRule, ModelRouteItem, Provider, ProviderResourceItem, UnifiedModel } from "../../api/types";
import {
  groupRulesByModel,
  formatRulePricing,
  formatRuleTimeWindows,
  formatRuleEffective,
  getGroupStatus,
} from "./model-rule-grouping";

function mockRule(partial: Partial<BillingRule> & { id: string }): BillingRule {
  return {
    id: partial.id,
    rule_type: partial.rule_type ?? "API_PRICE",
    rule_version: partial.rule_version ?? `v-${partial.id}`,
    provider_resource_id: partial.provider_resource_id ?? "res-1",
    upstream_model: partial.upstream_model ?? "glm-5.3",
    effective_from: partial.effective_from ?? "2026-01-01T00:00:00.000Z",
    effective_to: partial.effective_to ?? null,
    timezone: "Asia/Shanghai",
    days_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: null,
    end_time: null,
    time_windows: partial.time_windows ?? [],
    multiplier: partial.multiplier ?? null,
    cache_hit_price: partial.cache_hit_price ?? "0.000001",
    cache_miss_price: partial.cache_miss_price ?? "0.000002",
    output_price: partial.output_price ?? "0.000004",
    currency: partial.currency ?? "CNY",
    priority: partial.priority ?? 100,
    enabled: partial.enabled ?? true,
    source: "MANUAL",
    version: 1,
    archived_at: partial.archived_at ?? null,
    archived_by_admin_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pricing_mode: partial.pricing_mode ?? "ABSOLUTE",
  };
}

describe("model-rule-grouping 聚合逻辑", () => {
  const providers: Provider[] = [
    { id: "prov-zhipu", name: "智谱 AI" } as unknown as Provider,
    { id: "prov-kimi", name: "Moonshot Kimi" } as unknown as Provider,
  ];

  const resources: ProviderResourceItem[] = [
    {
      id: "res-zhipu",
      provider_id: "prov-zhipu",
      name: "智谱 API 资源",
      mode: "API",
      status: "ACTIVE",
    } as unknown as ProviderResourceItem,
    {
      id: "res-kimi",
      provider_id: "prov-kimi",
      name: "Kimi Coding 资源",
      mode: "CODING_PLAN",
      status: "ACTIVE",
    } as unknown as ProviderResourceItem,
  ];

  const models: UnifiedModel[] = [
    {
      id: "model-glm",
      alias: "glm-5.3",
      display_name: "GLM-5.3 统一大模型",
    } as unknown as UnifiedModel,
  ];

  const routes: ModelRouteItem[] = [
    {
      id: "route-1",
      unified_model_id: "model-glm",
      provider_resource_id: "res-zhipu",
      upstream_model: "glm-5.3",
    } as unknown as ModelRouteItem,
  ];

  it("将同一模型的全天基础规则与高峰期规则正确聚合成一个 ModelRuleGroup", () => {
    const rules = [
      mockRule({
        id: "base-1",
        provider_resource_id: "res-zhipu",
        upstream_model: "glm-5.3",
        time_windows: [],
        enabled: true,
      }),
      mockRule({
        id: "peak-1",
        provider_resource_id: "res-zhipu",
        upstream_model: "glm-5.3",
        time_windows: [
          { timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5], start_time: "14:00", end_time: "18:00" },
        ],
        multiplier: "1.5",
        pricing_mode: "MULTIPLIER",
        enabled: true,
      }),
    ];

    const groups = groupRulesByModel(rules, resources, providers, models, routes);
    expect(groups).toHaveLength(1);

    const g = groups[0]!;
    expect(g.providerName).toBe("智谱 AI");
    expect(g.resourceName).toBe("智谱 API 资源");
    expect(g.upstreamModel).toBe("glm-5.3");
    expect(g.unifiedModelName).toBe("GLM-5.3 统一大模型");
    expect(g.baseRule?.id).toBe("base-1");
    expect(g.peakRules).toHaveLength(1);
    expect(g.peakRules[0]!.id).toBe("peak-1");
    expect(g.status).toBe("ACTIVE");
  });

  it("支持仅有基础规则、无高峰期规则的模型", () => {
    const rules = [
      mockRule({
        id: "base-kimi",
        provider_resource_id: "res-kimi",
        upstream_model: "k3-coding",
        rule_type: "MODEL_TIER",
        multiplier: "2.0",
        time_windows: [],
        enabled: true,
      }),
    ];

    const groups = groupRulesByModel(rules, resources, providers, models, routes);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.providerName).toBe("Moonshot Kimi");
    expect(g.resourceMode).toBe("CODING_PLAN");
    expect(g.baseRule?.id).toBe("base-kimi");
    expect(g.peakRules).toHaveLength(0);
    expect(g.status).toBe("ACTIVE");
  });

  it("当基础规则被停用时正确计算状态", () => {
    const rules = [
      mockRule({
        id: "base-disabled",
        provider_resource_id: "res-zhipu",
        upstream_model: "glm-5.3",
        time_windows: [],
        enabled: false,
      }),
    ];

    const groups = groupRulesByModel(rules, resources, providers, models, routes);
    expect(groups[0]!.status).toBe("DISABLED");
  });

  it("正确格式化价格和时间窗口", () => {
    const apiRule = mockRule({
      id: "api-1",
      rule_type: "API_PRICE",
      currency: "CNY",
      cache_hit_price: "0.000001",
      cache_miss_price: "0.000002",
      output_price: "0.000004",
      time_windows: [],
    });
    expect(formatRulePricing(apiRule)).toBe("CNY/百万 Token: 命中 1 / 未命中 2 / 输出 4");
    expect(formatRuleTimeWindows(apiRule)).toBe("全天 24 小时生效");

    const peakRule = mockRule({
      id: "peak-1",
      rule_type: "API_PRICE",
      currency: "CNY",
      pricing_mode: "MULTIPLIER",
      multiplier: "1.5",
      cache_hit_price: "0.000001",
      cache_miss_price: "0.000002",
      output_price: "0.000004",
      time_windows: [
        { timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5], start_time: "14:00", end_time: "18:00" },
      ],
    });
    expect(formatRulePricing(peakRule)).toBe(
      "CNY/百万 Token: 命中 1 / 未命中 2 / 输出 4 × 1.5"
    );
    expect(formatRuleTimeWindows(peakRule)).toContain("14:00–18:00 (Asia/Shanghai)");

    const tierRule = mockRule({
      id: "tier-1",
      rule_type: "MODEL_TIER",
      multiplier: "3.5",
      time_windows: [],
    });
    expect(formatRulePricing(tierRule)).toBe("×3.5");
  });

  it("格式化规则生效时间区间", () => {
    const r = mockRule({
      id: "r-eff",
      effective_from: "2026-01-01T08:00:00.000Z",
      effective_to: null,
    });
    expect(formatRuleEffective(r)).toContain("长期有效");

    const rWithTo = mockRule({
      id: "r-to",
      effective_from: "2026-01-01T08:00:00.000Z",
      effective_to: "2026-12-31T23:59:59.000Z",
    });
    expect(formatRuleEffective(rWithTo)).not.toContain("长期有效");
  });
});
