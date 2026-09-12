import { useMemo, useState } from "react";
import { Sun, Zap, Clock, ChevronDown, ChevronUp, Plus, ArrowRight, ShieldAlert } from "lucide-react";
import { StatusTag } from "../dashboard/StatusTag";
import type { BillingRule } from "../../api/types";
import { formatPricePerMillion } from "../../lib/price-unit";
import {
  type ModelRuleGroup,
  formatRulePricing,
  formatRuleTimeWindows,
  formatRuleEffective,
} from "./model-rule-grouping";
import { getRuleStatusCategory } from "./QuotaBillingSection";

export interface ModelRuleCardProps {
  group: ModelRuleGroup;
  now?: number;
  onUpdateRule?: (rule: BillingRule, patch: Record<string, unknown>) => void;
  onArchiveRule?: (rule: BillingRule, archive: boolean) => void;
  onSetArchiveTarget?: (target: { kind: "rule"; item: BillingRule }) => void;
  onAddPeakWindow?: (group: ModelRuleGroup) => void;
  onConfigureBaseRule?: (group: ModelRuleGroup) => void;
  onAdjustPricing?: (group: ModelRuleGroup) => void;
  isUpdating?: boolean;
}

function ApiPriceBoxes({
  rule,
  title = "按量计价",
}: {
  rule: BillingRule;
  title?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] text-ql-fg-tertiary">
        <span>{title}</span>
        <span>单位：{rule.currency ?? "CNY"} / 百万 Token</span>
      </div>
      <div className="grid grid-cols-3 gap-2 rounded border border-ql-border bg-ql-surface p-2 text-center text-[12px]">
        <div>
          <div className="text-[10px] text-ql-fg-tertiary">缓存命中</div>
          <div
            className="font-semibold text-ql-fg"
            title={rule.cache_hit_price ? `${rule.cache_hit_price}/Token` : undefined}
          >
            {formatPricePerMillion(rule.cache_hit_price, rule.currency, { showUnit: false })}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-ql-fg-tertiary">未命中输入</div>
          <div
            className="font-semibold text-ql-fg"
            title={rule.cache_miss_price ? `${rule.cache_miss_price}/Token` : undefined}
          >
            {formatPricePerMillion(rule.cache_miss_price, rule.currency, { showUnit: false })}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-ql-fg-tertiary">输出单价</div>
          <div
            className="font-semibold text-ql-fg"
            title={rule.output_price ? `${rule.output_price}/Token` : undefined}
          >
            {formatPricePerMillion(rule.output_price, rule.currency, { showUnit: false })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ModelRuleCard({
  group,
  now = Date.now(),
  onUpdateRule,
  onArchiveRule,
  onSetArchiveTarget,
  onAddPeakWindow,
  onConfigureBaseRule,
  onAdjustPricing,
  isUpdating = false,
}: ModelRuleCardProps) {
  const [showHistory, setShowHistory] = useState(false);

  const groupStatusTone = useMemo((): "neutral" | "success" | "warning" | "danger" => {
    switch (group.status) {
      case "ACTIVE":
        return "neutral";
      case "PENDING":
        return "neutral";
      case "DISABLED":
        return "warning";
      case "EXPIRED":
        return "warning";
      case "ARCHIVED":
        return "neutral";
      default:
        return "neutral";
    }
  }, [group.status]);

  const groupStatusLabel = useMemo(() => {
    switch (group.status) {
      case "ACTIVE":
        return "生效中";
      case "PENDING":
        return "待生效";
      case "DISABLED":
        return "已停用";
      case "EXPIRED":
        return "已到期";
      case "ARCHIVED":
        return "已归档";
      default:
        return "正常";
    }
  }, [group.status]);

  const renderRuleActions = (rule: BillingRule) => {
    if (rule.archived_at) {
      return (
        <button
          type="button"
          disabled={isUpdating}
          className="rounded px-2 py-1 text-[12px] text-ql-action hover:bg-ql-action-soft disabled:opacity-50"
          onClick={() => onArchiveRule?.(rule, false)}
        >
          取消归档
        </button>
      );
    }
    return (
      <div className="flex items-center gap-1">
        <button
          data-write-action
          type="button"
          disabled={isUpdating}
          className="rounded px-2 py-1 text-[12px] text-ql-fg-secondary hover:bg-ql-surface-muted disabled:opacity-50"
          onClick={() => onUpdateRule?.(rule, { enabled: !rule.enabled })}
        >
          {rule.enabled ? "停用" : "启用"}
        </button>
        {!rule.enabled && onSetArchiveTarget ? (
          <button
            type="button"
            disabled={isUpdating}
            className="rounded px-2 py-1 text-[12px] text-ql-fg-secondary hover:bg-ql-surface-muted disabled:opacity-50"
            onClick={() => onSetArchiveTarget({ kind: "rule", item: rule })}
          >
            归档
          </button>
        ) : null}
      </div>
    );
  };

  const renderStatusTag = (rule: BillingRule) => {
    const cat = getRuleStatusCategory(rule, now);
    const tone: "neutral" | "success" | "warning" | "danger" =
      cat === "ACTIVE" || cat === "PENDING" || cat === "ARCHIVED" ? "neutral" : "warning";
    const label =
      cat === "ACTIVE"
        ? "生效中"
        : cat === "PENDING"
        ? "待生效"
        : cat === "DISABLED"
        ? "停用"
        : cat === "EXPIRED"
        ? "已到期"
        : "已归档";
    return <StatusTag tone={tone}>{label}</StatusTag>;
  };

  return (
    <div
      data-testid={`model-rule-card-${group.id}`}
      className="mb-4 overflow-hidden rounded-xl border border-ql-border bg-ql-surface"
    >
      {/* Card Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ql-border bg-ql-surface-subtle px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ql-fg text-[14px]">
              {group.upstreamModel ?? "全部模型"}
            </span>
            {group.unifiedModelName && group.unifiedModelName !== group.upstreamModel ? (
              <span className="text-[12px] text-ql-fg-secondary">
                ({group.unifiedModelName})
              </span>
            ) : null}
          </div>
          <span className="rounded bg-ql-surface-muted px-2 py-0.5 text-[11px] font-medium text-ql-fg-secondary border border-ql-border">
            {group.providerName} · {group.resourceName}
          </span>
          <span className="rounded bg-ql-surface-brand-soft px-2 py-0.5 text-[11px] font-medium text-ql-action border border-ql-border">
            {group.resourceMode === "CODING_PLAN" ? "Coding Plan 额度" : "API 计费"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <StatusTag tone={groupStatusTone}>{groupStatusLabel}</StatusTag>
          {onAdjustPricing ? (
            <button
              type="button"
              className="rounded-md border border-ql-border bg-ql-surface px-2.5 py-1 text-[12px] font-medium text-ql-fg hover:border-ql-action hover:text-ql-action transition-colors"
              onClick={() => onAdjustPricing(group)}
            >
              调整价格
            </button>
          ) : null}
          <span className="text-[11px] text-ql-fg-tertiary tabular-nums">
            共 {group.allRules.length} 条规则版本
          </span>
        </div>
      </div>

      {/* Card Body: Base Rule vs Peak Rule */}
      <div className="grid grid-cols-1 divide-y lg:divide-y-0 lg:divide-x divide-ql-border lg:grid-cols-2 p-4 gap-4 lg:gap-6">
        {/* Left Column: Base Rule (All-day) */}
        <div className="flex flex-col justify-between">
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-medium text-[13px] text-ql-fg">
                <Sun className="h-4 w-4 text-ql-fg-secondary shrink-0" />
                <span>基础规则（全天）</span>
              </div>
              {group.baseRule ? (
                <div className="flex items-center gap-2">
                  {renderStatusTag(group.baseRule)}
                  {renderRuleActions(group.baseRule)}
                </div>
              ) : null}
            </div>

            {group.baseRule ? (
              <div className="rounded-lg border border-ql-border bg-ql-surface-subtle p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-[12px] font-semibold text-ql-fg">
                    {group.baseRule.rule_version}
                  </span>
                  <span className="text-[11px] text-ql-fg-tertiary">
                    {group.baseRule.rule_type === "API_PRICE" ? "API 刊例单价" : "基础倍率"}
                  </span>
                </div>

                <div className="mb-2.5 text-[13px] font-mono text-ql-fg">
                  {group.baseRule.rule_type === "API_PRICE" ? (
                    <ApiPriceBoxes rule={group.baseRule} title="按量计价" />
                  ) : (
                    <div className="rounded border border-ql-border bg-ql-surface p-2 text-[12px] flex items-center justify-between">
                      <span className="text-ql-fg-secondary text-[11px]">基础额度倍率：</span>
                      <strong className="font-semibold text-ql-fg">
                        ×{group.baseRule.multiplier ?? "1.0"}
                      </strong>
                    </div>
                  )}
                </div>

                <div className="space-y-1 text-[11px] text-ql-fg-secondary">
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-ql-fg-tertiary shrink-0" />
                    <span>生效时段：全天 24 小时</span>
                  </div>
                  <div className="text-ql-fg-tertiary">
                    生效周期：{formatRuleEffective(group.baseRule)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-ql-border bg-ql-surface-subtle/50 p-6 text-center">
                <p className="text-[12px] text-ql-fg-tertiary mb-2">未配置全天基础计费规则</p>
                {onConfigureBaseRule ? (
                  <button
                    type="button"
                    onClick={() => onConfigureBaseRule(group)}
                    className="inline-flex items-center gap-1 rounded-md border border-ql-border bg-ql-surface px-2.5 py-1 text-[12px] font-medium text-ql-action hover:border-ql-action hover:bg-ql-action-soft transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    配置基础规则
                  </button>
                ) : null}
              </div>
            )}
          </div>

          {group.allBaseRules.length > 1 ? (
            <div className="mt-3 text-[11px]">
              <button
                type="button"
                onClick={() => setShowHistory(!showHistory)}
                className="inline-flex items-center gap-1 text-ql-action hover:underline"
              >
                <span>其他基础版本 ({group.allBaseRules.length - 1})</span>
                {showHistory ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              {showHistory ? (
                <div className="mt-2 space-y-1 rounded border border-ql-border bg-ql-surface-subtle p-2">
                  {group.allBaseRules.slice(1).map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-[11px]">
                      <span className="font-mono text-ql-fg-secondary">{r.rule_version}</span>
                      <span>{formatRuleEffective(r)}</span>
                      {renderStatusTag(r)}
                      {renderRuleActions(r)}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Right Column: Peak Rule (Time Window) */}
        <div className="flex flex-col justify-between pt-4 lg:pt-0">
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-medium text-[13px] text-ql-fg">
                <Zap className="h-4 w-4 text-ql-fg-secondary shrink-0" />
                <span>高峰期规则（时段浮动）</span>
              </div>
              {onAddPeakWindow ? (
                <button
                  type="button"
                  onClick={() => onAddPeakWindow(group)}
                  className="inline-flex items-center gap-1 text-[12px] text-ql-action hover:underline"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加高峰时段
                </button>
              ) : null}
            </div>

            {group.peakRules.length > 0 ? (
              <div className="space-y-3">
                {group.peakRules.map((peakRule) => (
                  <div
                    key={peakRule.id}
                    className="rounded-lg border border-ql-border bg-ql-surface-subtle p-3.5"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12px] font-semibold text-ql-fg">
                          {peakRule.rule_version}
                        </span>
                        {renderStatusTag(peakRule)}
                      </div>
                      {renderRuleActions(peakRule)}
                    </div>

                    <div className="mb-2.5 text-[13px] font-mono text-ql-fg">
                      {peakRule.rule_type === "API_PRICE" && peakRule.pricing_mode !== "MULTIPLIER" ? (
                        <ApiPriceBoxes rule={peakRule} title="时段执行计价" />
                      ) : (
                        <div className="rounded border border-ql-border bg-ql-surface p-2 text-[12px] flex items-center justify-between">
                          <span className="text-ql-fg-secondary text-[11px]">
                            {peakRule.rule_type === "API_PRICE" ? "时段浮动倍率：" : "高峰额度倍率："}
                          </span>
                          <strong className="font-semibold text-ql-fg">
                            {peakRule.pricing_mode === "MULTIPLIER" && peakRule.multiplier ? (
                              <span>
                                ×{peakRule.multiplier}
                                <span className="ml-1 text-[11px] font-normal text-ql-fg-tertiary">
                                  （基础单价 × {peakRule.multiplier}）
                                </span>
                              </span>
                            ) : (
                              formatRulePricing(peakRule)
                            )}
                          </strong>
                        </div>
                      )}
                    </div>

                    <div className="space-y-1 text-[11px] text-ql-fg-secondary">
                      <div className="flex items-start gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-ql-fg-tertiary shrink-0 mt-0.5" />
                        <span className="font-mono text-ql-fg">
                          {formatRuleTimeWindows(peakRule)}
                        </span>
                      </div>
                      <div className="text-ql-fg-tertiary">
                        生效周期：{formatRuleEffective(peakRule)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-ql-border bg-ql-surface-subtle/50 p-6 text-center">
                <p className="text-[12px] text-ql-fg-tertiary mb-2">
                  未配置高峰期时段规则（全天执行基础单价）
                </p>
                {onAddPeakWindow ? (
                  <button
                    type="button"
                    onClick={() => onAddPeakWindow(group)}
                    className="inline-flex items-center gap-1 rounded-md border border-ql-border bg-ql-surface px-2.5 py-1 text-[12px] font-medium text-ql-action hover:border-ql-action hover:bg-ql-action-soft transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    配置高峰期规则
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
