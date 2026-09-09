import { ChevronRight, Search } from "lucide-react";

import type { AlertItem } from "../../api/types";
import { StatusTag } from "../../components/dashboard/StatusTag";
import { INPUT_CLASS } from "../../components/writes/FormField";
import {
  DOMAIN_LABEL,
  formatTime,
  isActionable,
  isHandled,
  recoveryText,
  hasVerifiedRecovery,
} from "./alert-presenters";

export function AlertFilters({
  month,
  principalId,
  providerId,
  search,
  principals,
  providers,
  principalDisabled,
  providerDisabled,
  onMonth,
  onPrincipal,
  onProvider,
  onSearch,
}: {
  month: string;
  principalId: string;
  providerId: string;
  search: string;
  principals: Array<{ id: string; name: string }>;
  providers: Array<{ id: string; name: string }>;
  principalDisabled?: boolean;
  providerDisabled?: boolean;
  onMonth: (value: string) => void;
  onPrincipal: (value: string) => void;
  onProvider: (value: string) => void;
  onSearch: (value: string) => void;
}) {
  return (
    <div className="mb-4 grid gap-3 rounded-xl border border-ql-border bg-ql-surface p-4 sm:grid-cols-2 xl:grid-cols-[160px_220px_190px_minmax(240px,1fr)]">
      <label className="text-[11px] text-ql-fg-tertiary">
        发生月份
        <input
          aria-label="异常月份"
          className={`${INPUT_CLASS} mt-1 w-full`}
          onChange={(e) => onMonth(e.target.value)}
          type="month"
          value={month}
        />
      </label>
      <label className="text-[11px] text-ql-fg-tertiary">
        使用主体
        <select
          aria-label="异常使用主体"
          className={`${INPUT_CLASS} mt-1 w-full`}
          disabled={principalDisabled}
          onChange={(e) => onPrincipal(e.target.value)}
          value={principalId}
        >
          <option value="">全部主体</option>
          {principals.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[11px] text-ql-fg-tertiary">
        厂商
        <select
          aria-label="异常厂商"
          className={`${INPUT_CLASS} mt-1 w-full`}
          disabled={providerDisabled}
          onChange={(e) => onProvider(e.target.value)}
          value={providerId}
        >
          <option value="">全部厂商</option>
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[11px] text-ql-fg-tertiary">
        搜索
        <span className="relative mt-1 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ql-fg-tertiary" />
          <input
            aria-label="搜索异常"
            className={`${INPUT_CLASS} w-full pl-9`}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="错误信息、资源、模型或请求 ID"
            type="search"
            value={search}
          />
        </span>
      </label>
    </div>
  );
}

export function AlertRow({
  alert,
  principalName,
  providerName,
  resourceName,
  pending,
  onHandle,
  onView,
}: {
  alert: AlertItem;
  principalName?: string;
  providerName?: string;
  resourceName?: string;
  pending: boolean;
  onHandle: () => void;
  onView: () => void;
}) {
  const handled = isHandled(alert);
  const recovered = hasVerifiedRecovery(alert);
  return (
    <tr className="border-b border-ql-border-zone last:border-0 hover:bg-ql-surface-subtle">
      <td className="p-3 text-ql-fg-secondary">
        {formatTime(alert.firstSeenAt)}
        <span className="mt-1 block text-[10px] text-ql-fg-tertiary">
          更新 {formatTime(alert.lastSeenAt)}
        </span>
      </td>
      <td className="p-3 font-medium text-ql-fg">
        {principalName ?? "系统级"}
      </td>
      <td className="p-3 text-ql-fg">
        {providerName ?? "—"}
        <span className="mt-1 block text-[10px] text-ql-fg-tertiary">
          {resourceName ?? "未关联资源"}
        </span>
      </td>
      <td className="max-w-[320px] p-3">
        <span className="font-medium text-ql-fg">{alert.title}</span>
        <span className="mt-1 block truncate text-[11px] text-ql-fg-secondary">
          {alert.detail ?? DOMAIN_LABEL[alert.domain]}
        </span>
      </td>
      <td className="p-3">
        <select
          aria-label={`${alert.title} 是否处理`}
          className="h-8 rounded-lg border border-ql-border-strong bg-ql-surface px-2 text-[12px] text-ql-fg disabled:cursor-not-allowed disabled:opacity-70"
          disabled={!isActionable(alert) || pending}
          onChange={(e) => {
            if (e.target.value === "yes") onHandle();
          }}
          value={handled ? "yes" : "no"}
        >
          <option value="no">否</option>
          <option value="yes">是</option>
        </select>
      </td>
      <td className="p-3">
        <StatusTag
          tone={recovered ? "success" : handled ? "warning" : "danger"}
        >
          {recoveryText(alert)}
        </StatusTag>
        {recovered && alert.sourceClearedAt ? (
          <span className="mt-1 block text-[10px] text-ql-fg-tertiary">
            {formatTime(alert.sourceClearedAt)}
          </span>
        ) : null}
      </td>
      <td className="p-3">
        <button
          className="inline-flex items-center gap-1 text-[12px] font-medium text-ql-action"
          onClick={onView}
          type="button"
        >
          查看
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}
