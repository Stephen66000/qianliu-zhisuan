import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelRuleCard } from "./ModelRuleCard";
import type { BillingRule } from "../../api/types";
import type { ModelRuleGroup } from "./model-rule-grouping";

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

describe("ModelRuleCard 组件", () => {
  const baseRule = mockRule({
    id: "base-1",
    rule_version: "v-base-1",
    time_windows: [],
    enabled: true,
  });

  const peakRule = mockRule({
    id: "peak-1",
    rule_version: "v-peak-1",
    multiplier: "1.5",
    pricing_mode: "MULTIPLIER",
    time_windows: [
      { timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5], start_time: "14:00", end_time: "18:00" },
    ],
    enabled: true,
  });

  const sampleGroup: ModelRuleGroup = {
    id: "res-1::glm-5.3",
    providerResourceId: "res-1",
    upstreamModel: "glm-5.3",
    resourceName: "智谱 API 生产资源",
    resourceMode: "API",
    providerId: "prov-1",
    providerName: "智谱 AI",
    unifiedModelName: "GLM-5.3",
    baseRule,
    allBaseRules: [baseRule],
    peakRules: [peakRule],
    allRules: [baseRule, peakRule],
    status: "ACTIVE",
  };

  it("完整渲染模型卡片：模型信息、全天基础规则和高峰期规则", () => {
    render(<ModelRuleCard group={sampleGroup} />);

    // Header checks
    expect(screen.getByText("glm-5.3")).toBeInTheDocument();
    expect(screen.getByText("智谱 AI · 智谱 API 生产资源")).toBeInTheDocument();
    expect(screen.getByText("API 计费")).toBeInTheDocument();
    expect(screen.getAllByText("生效中").length).toBeGreaterThan(0);

    // Base Rule section checks
    expect(screen.getByText("基础规则（全天）")).toBeInTheDocument();
    expect(screen.getByText("v-base-1")).toBeInTheDocument();
    expect(screen.getByText("¥1.00")).toBeInTheDocument();
    expect(screen.getByText("¥2.00")).toBeInTheDocument();
    expect(screen.getByText("¥4.00")).toBeInTheDocument();

    // Peak Rule section checks
    expect(screen.getByText("高峰期规则（时段浮动）")).toBeInTheDocument();
    expect(screen.getByText("v-peak-1")).toBeInTheDocument();
    expect(screen.getByText(/14:00–18:00/)).toBeInTheDocument();
    expect(screen.getByText(/基础单价 × 1.5/)).toBeInTheDocument();
  });

  it("高峰期规则为 API 绝对单价模式时，同样展示规范价格小方块", () => {
    const absolutePeakRule = mockRule({
      id: "peak-abs",
      rule_version: "v-peak-abs",
      pricing_mode: "ABSOLUTE",
      multiplier: null,
      cache_hit_price: "0.00000004",
      cache_miss_price: "0.000002",
      output_price: "0.000008",
      time_windows: [
        { timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "12:00" },
      ],
      enabled: true,
    });
    const absGroup: ModelRuleGroup = {
      ...sampleGroup,
      peakRules: [absolutePeakRule],
      allRules: [baseRule, absolutePeakRule],
    };
    render(<ModelRuleCard group={absGroup} />);
    expect(screen.getByText("¥0.04")).toBeInTheDocument();
    expect(screen.getByText("¥8.00")).toBeInTheDocument();
  });

  it("当未配置高峰期规则时显示友好空状态及添加按钮", async () => {
    const user = userEvent.setup();
    const onAddPeak = vi.fn();
    const groupWithoutPeak: ModelRuleGroup = {
      ...sampleGroup,
      peakRules: [],
      allRules: [baseRule],
    };

    render(<ModelRuleCard group={groupWithoutPeak} onAddPeakWindow={onAddPeak} />);

    expect(screen.getByText("未配置高峰期时段规则（全天执行基础单价）")).toBeInTheDocument();
    const addBtn = screen.getByRole("button", { name: "配置高峰期规则" });
    await user.click(addBtn);
    expect(onAddPeak).toHaveBeenCalledWith(groupWithoutPeak);
  });

  it("点击基础规则停用/启用触发 onUpdateRule 回调", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    render(<ModelRuleCard group={sampleGroup} onUpdateRule={onUpdate} />);

    const stopButtons = screen.getAllByRole("button", { name: "停用" });
    expect(stopButtons.length).toBeGreaterThan(0);
    await user.click(stopButtons[0]!);

    expect(onUpdate).toHaveBeenCalledWith(baseRule, { enabled: false });
  });

  it("已停用规则显示归档按钮", async () => {
    const user = userEvent.setup();
    const onSetArchive = vi.fn();
    const disabledBase = { ...baseRule, enabled: false };
    const disabledGroup: ModelRuleGroup = {
      ...sampleGroup,
      baseRule: disabledBase,
      allBaseRules: [disabledBase],
      peakRules: [],
      allRules: [disabledBase],
      status: "DISABLED",
    };

    render(
      <ModelRuleCard
        group={disabledGroup}
        onSetArchiveTarget={onSetArchive}
      />
    );

    const archiveBtn = screen.getByRole("button", { name: "归档" });
    await user.click(archiveBtn);
    expect(onSetArchive).toHaveBeenCalledWith({ kind: "rule", item: disabledBase });
  });
});
