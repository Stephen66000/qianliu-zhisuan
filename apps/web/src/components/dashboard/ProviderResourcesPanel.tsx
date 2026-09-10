/**
 * 标准版首页「接入资源」面板（HOME-STANDARD-20260910 WP03）。
 *
 * 完整列出已接入厂商（数量不硬编码）；厂商下多资源保留数量与形态；
 * 调用状态（正常/局部异常/异常/待确认）与一句话关注信息分别展示；
 * 调用状态与额度/余额同步状态分别判断（后端已按事实聚合，此处只展示）。
 */
import { Inbox } from "lucide-react";
import { Link } from "react-router-dom";

import type { ProviderStatusCategory, StandardHomeSummary } from "../../api/types";
import { EmptyState } from "../states/EmptyState";
import { formatDateTimeShort } from "../../lib/format";

type Resources = StandardHomeSummary["resources"];
type ProviderRow = Resources["providers"][number];

const CATEGORY_TONE: Record<ProviderStatusCategory, "success" | "warning" | "danger" | "neutral"> = {
  NORMAL: "success",
  PARTIAL_ABNORMAL: "warning",
  ABNORMAL: "danger",
  PENDING_CONFIRM: "neutral",
};

const CATEGORY_LABEL: Record<ProviderStatusCategory, string> = {
  NORMAL: "正常",
  PARTIAL_ABNORMAL: "局部异常",
  ABNORMAL: "异常",
  PENDING_CONFIRM: "待确认",
};

/** R01-F05：深色 soft 令牌需按规范 §3.3 用透明度，统一走 tokens.css 的主题感知状态类。 */
const TONE_CLASSES = {
  success: "ql-status-success",
  warning: "ql-status-warning",
  danger: "ql-status-danger",
  neutral: "ql-status-neutral",
} as const;

function StatusPill({ tone, label }: { tone: keyof typeof TONE_CLASSES; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[12px] font-medium leading-[18px] ${TONE_CLASSES[tone]}`}
    >
      <span aria-hidden className="size-[5px] rounded-full bg-current" />
      {label}
    </span>
  );
}

const MODE_LABEL: Record<ProviderRow["modes"][number]["mode"], string> = {
  API: "API",
  CODING_PLAN: "Coding Plan",
};

function providerModesDetail(modes: ProviderRow["modes"]): string {
  return modes.map((item) => `${MODE_LABEL[item.mode]} · ${item.count} 项资源`).join("；");
}

export function ProviderResourcesPanel({ resources }: { resources: Resources }) {
  if (resources.providers.length === 0) {
    return (
      <EmptyState
        description="尚未登记可用 AI 资源。请前往「厂商资源 → 资源利用」登记 API 或 Coding Plan 资源。"
        icon={Inbox}
        title="尚未接入厂商资源"
      />
    );
  }
  return (
    <div data-testid="home-provider-resources">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-[12px] text-ql-fg-tertiary">
        <span data-testid="home-provider-meta">
          {resources.providerCount} 家厂商 · {resources.resourceCount} 项资源
        </span>
        {resources.attentionProviderCount > 0 ? (
          <span
            className="ql-status-warning inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[12px] font-medium leading-[18px]"
            data-testid="home-provider-attention-count"
          >
            {resources.attentionProviderCount} 家需关注
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-ql-border text-[12px] font-medium text-ql-fg-tertiary">
              <th className="h-10 px-3 py-0 font-medium md:w-[29%]">厂商 / 资源</th>
              <th className="h-10 px-3 py-0 font-medium md:w-[16%]">调用状态</th>
              <th className="h-10 px-3 py-0 font-medium">需要关注</th>
              <th className="h-10 w-16 px-3 py-0 font-medium" />
            </tr>
          </thead>
          <tbody>
            {resources.providers.map((provider) => (
              <tr
                className="border-b border-ql-border-zone transition-colors last:border-b-0 hover:bg-ql-surface-subtle"
                data-testid="home-provider-row"
                key={`${provider.providerCode}:${provider.providerName}`}
              >
                <td className="px-3 py-3.5">
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="grid size-8 shrink-0 place-items-center rounded-lg border border-ql-border bg-ql-surface-subtle text-[14px] font-semibold text-ql-fg-secondary"
                    >
                      {provider.providerName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[14px] font-medium text-ql-fg">{provider.providerName}</div>
                      <div className="mt-0.5 text-[12px] text-ql-fg-tertiary">
                        {providerModesDetail(provider.modes)}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3.5">
                  <StatusPill
                    label={CATEGORY_LABEL[provider.statusCategory]}
                    tone={CATEGORY_TONE[provider.statusCategory]}
                  />
                  {provider.statusCategory !== "NORMAL" ? (
                    <span className="mt-1 block text-[12px] text-ql-fg-tertiary">
                      {provider.statusLabel}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-3.5">
                  {provider.attention ? (
                    <span className="text-ql-fg-secondary" data-testid="home-provider-attention">
                      {provider.attention}
                    </span>
                  ) : (
                    <span className="text-ql-fg-disabled">—</span>
                  )}
                </td>
                <td className="px-3 py-3.5">
                  <Link
                    aria-label={`查看${provider.providerName}资源状态与处理入口`}
                    className="inline-flex min-h-8 items-center text-[13px] text-ql-action hover:text-ql-action-hover focus-visible:outline-2 focus-visible:outline-ql-action"
                    to="/resources?tab=supply-health"
                  >
                    查看
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 border-t border-ql-border-zone pt-3 text-[12px] text-ql-fg-tertiary">
        {resources.updatedAt
          ? `资源状态更新于 ${formatDateTimeShort(resources.updatedAt)}`
          : "暂无同步时间记录"}
        {" · 调用状态与额度/余额同步状态分别判断"}
      </p>
    </div>
  );
}
