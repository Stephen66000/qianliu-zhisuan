import { Search } from "lucide-react";
import type { ReactNode } from "react";

import type {
  OperatingBillMetricTotals,
  OperatingBillUsageQuality,
} from "../../api/operating-bill-accounts";
import { formatCount, formatMoney } from "../../lib/format";
import { StatusTag } from "../dashboard/StatusTag";
import { BillStat } from "./BillStat";
import { inputClass } from "./BillShared";

const qualityLabels: Record<OperatingBillUsageQuality, string> = {
  EXACT: "精确用量",
  ESTIMATED: "估算用量",
  ACCOUNT_AGGREGATED: "账号汇总",
  MIXED: "混合口径",
  UNKNOWN: "用量未知",
};

export function UsageQualityTag({ quality }: { quality: OperatingBillUsageQuality }) {
  return (
    <StatusTag tone={quality === "EXACT" ? "success" : quality === "UNKNOWN" ? "danger" : "warning"}>
      {qualityLabels[quality]}
    </StatusTag>
  );
}

export function accountCount(
  value: string | null,
  quality: OperatingBillUsageQuality,
): string {
  if (value === null || quality === "UNKNOWN") return "未知";
  const formatted = formatCount(value);
  return quality === "EXACT" ? formatted : `约 ${formatted}`;
}

export function accountPercentage(
  value: string | null,
  quality: OperatingBillUsageQuality,
): string {
  if (value === null || quality === "UNKNOWN") return "—";
  const formatted = `${value}%`;
  return quality === "EXACT" ? formatted : `约 ${formatted}`;
}

export function accountMoney(value: string | null): string {
  return value === null ? "未知" : `¥${formatMoney(value)}`;
}

export function accountQuota(value: string | null): string {
  return value === null ? "未知" : formatCount(value);
}

export function accountTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function MetricGrid({ totals }: { totals: OperatingBillMetricTotals }) {
  const tokenValue = (value: string | null) =>
    totals.usageQuality === "UNKNOWN" ? null : value;
  const metrics: Array<{
    label: string;
    value: string | null;
    tokens?: boolean;
  }> = [
    {
      label: "本月总 Token",
      value: tokenValue(totals.totalTokens),
      tokens: true,
    },
    {
      label: "输入 Token",
      value: tokenValue(totals.inputTokens),
      tokens: true,
    },
    {
      label: "输出 Token",
      value: tokenValue(totals.outputTokens),
      tokens: true,
    },
    { label: "API 消费", value: accountMoney(totals.apiCost) },
    {
      label: "活跃天数",
      value: totals.activeDays === null ? null : String(totals.activeDays),
    },
    { label: "请求次数", value: String(totals.requestCount) },
  ];
  return (
    <section
      aria-label="账单指标"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
        <span className="text-[12px] text-ql-fg-secondary">Token 计量口径</span>
        <UsageQualityTag quality={totals.usageQuality} />
      </div>
      {metrics.map((metric) => (
        <BillStat
          key={metric.label}
          {...metric}
          missing="未知"
          approximate={metric.tokens && totals.usageQuality !== "EXACT"}
        />
      ))}
    </section>
  );
}

export function AccountFilters({
  providerCode,
  search,
  providers,
  searchLabel,
  onProviderChange,
  onSearchChange,
}: {
  providerCode: string;
  search: string;
  providers: Array<{ providerCode: string; providerName: string }>;
  searchLabel: string;
  onProviderChange: (value: string) => void;
  onSearchChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <select
        aria-label="厂商"
        className={`${inputClass} min-w-36`}
        onChange={(event) => onProviderChange(event.target.value)}
        value={providerCode}
      >
        <option value="">全部厂商</option>
        {providers.map((provider) => (
          <option key={provider.providerCode} value={provider.providerCode}>
            {provider.providerName}
          </option>
        ))}
      </select>
      <label className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-ql-fg-tertiary" />
        <input
          aria-label={searchLabel}
          className={`${inputClass} w-64 pl-9`}
          maxLength={255}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchLabel}
          value={search}
        />
      </label>
    </div>
  );
}

export function AccountTable({
  headers,
  children,
  leadingTextColumns = 2,
}: {
  headers: string[];
  children: ReactNode;
  leadingTextColumns?: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[92rem] text-left text-[13px]">
        <thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[12px] text-ql-fg-tertiary">
          <tr>
            {headers.map((header, index) => (
              <th
                scope="col"
                className={`whitespace-nowrap px-3 py-2 font-medium ${index >= leadingTextColumns ? "text-right" : ""}`}
                key={header}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function AccountCell({ children, numeric = false }: { children: ReactNode; numeric?: boolean }) {
  return (
    <td
      className={`whitespace-nowrap px-3 py-3 ${
        numeric ? "text-right font-medium tabular-nums text-ql-fg" : "text-ql-fg-secondary"
      }`}
    >
      {children}
    </td>
  );
}

export function AccountPagination({
  limit, offset, total, onOffsetChange,
}: {
  limit: number;
  offset: number;
  total: number;
  onOffsetChange: (offset: number) => void;
}) {
  if (total === 0) return null;
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <nav aria-label="账单分页" className="flex items-center justify-end gap-3 border-t border-ql-border-zone px-4 py-3">
      <span className="text-[12px] text-ql-fg-secondary">
        {start}–{end} / {total}
      </span>
      <button
        className="rounded-lg border border-ql-border-zone px-3 py-1.5 text-[12px] text-ql-fg disabled:opacity-40"
        disabled={offset === 0}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        type="button"
      >上一页</button>
      <button
        className="rounded-lg border border-ql-border-zone px-3 py-1.5 text-[12px] text-ql-fg disabled:opacity-40"
        disabled={offset + limit >= total}
        onClick={() => onOffsetChange(offset + limit)}
        type="button"
      >下一页</button>
    </nav>
  );
}
