import { Link } from "react-router-dom";
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
import { Button } from "../ui/Button";

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
  _quality: OperatingBillUsageQuality,
): string {
  if (value === null) return "未知";
  const formatted = formatCount(value);
  return formatted;
}

export function accountPercentage(
  value: string | null,
  _quality: OperatingBillUsageQuality,
): string {
  if (value === null) return "—";
  const formatted = `${value}%`;
  return formatted;
}

export function accountMoney(value: string | null): string {
  return value === null ? "未知" : `¥${formatMoney(value)}`;
}

export function accountApiMoney(totals: Pick<OperatingBillMetricTotals, "apiCost" | "knownApiCost">): string {
  if (totals.apiCost !== null) return accountMoney(totals.apiCost);
  return totals.knownApiCost !== null && totals.knownApiCost !== undefined && Number(totals.knownApiCost) > 0
    ? accountMoney(totals.knownApiCost) : "未知";
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

/** Existing project/department display only; employee budgets must never use this mixed-pool legacy projection. */
export function legacyAccountQuota(allocatedQuota: string | null | undefined, totalTokens: string | null) {
  const allocated = allocatedQuota ? Number(allocatedQuota) : 0;
  const used = totalTokens ? Number(totalTokens) : 0;
  return {
    allocated: allocated > 0 ? formatCount(allocatedQuota!) : "不限",
    usageRate: allocated > 0 && totalTokens !== null ? `${((used / allocated) * 100).toFixed(1)}%` : "—",
    remaining: allocated > 0 && totalTokens !== null ? formatCount(String(Math.max(0, allocated - used))) : "不限",
  };
}

export function MetricGrid({ totals, quotaScope }: { totals: OperatingBillMetricTotals; quotaScope?: "EMPLOYEE" }) {
  const tokenValue = (value: string | null) => totals.usageQuality === "UNKNOWN" ? null : value;
  const quota = quotaScope === "EMPLOYEE" ? null : legacyAccountQuota(totals.allocatedQuota, totals.totalTokens);

  const metrics: Array<{
    label: string;
    value: string | null;
    tokens?: boolean;
    highlight?: boolean;
  }> = [
    {
      label: "本月分配额度",
      value: quota?.allocated ?? null,
      tokens: true,
    },
    {
      label: "本月token使用量",
      value: tokenValue(totals.totalTokens),
      tokens: true,
    },
    {
      label: "token使用率",
      value: quota?.usageRate ?? null,
    },
    {
      label: "本月剩余额度",
      value: quota?.remaining ?? null,
      tokens: true,
    },
    {
      label: "月度总花费",
      value:
        totals.totalAllocatedCost !== null && totals.totalAllocatedCost !== undefined
          ? accountMoney(totals.totalAllocatedCost)
          : totals.apiCost !== null
            ? accountMoney(totals.apiCost)
            : totals.usageQuality === "UNKNOWN"
              ? null
              : "¥0.00",
    },
    // WP4-S4（ACE-01）：部门/项目/员工 live 账行 apiCost 已是 effectiveReportedApiCostSql
    // 同源估算口径（WP1 合同 §3），统一估算命名；CLOSED 月由 Shell 历史横幅标识。
    { label: "API 费用估算", value: accountApiMoney(totals) },
    {
      label: "套餐分摊",
      value:
        totals.packageAllocatedCost !== null && totals.packageAllocatedCost !== undefined
          ? accountMoney(totals.packageAllocatedCost)
          : totals.usageQuality === "UNKNOWN"
            ? null
            : "¥0.00",
    },
    {
      label: "活跃天数",
      value: totals.activeDays === null ? null : String(totals.activeDays),
    },
    { label: "请求次数", value: String(totals.requestCount) },
  ];
  return (
    <section
      aria-label="账单指标"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
    >
      {metrics.filter(metric => quotaScope !== "EMPLOYEE" || !["本月分配额度", "token使用率", "本月剩余额度"].includes(metric.label)).map((metric) => (
        <BillStat
          key={metric.label}
          {...metric}
          missing="未知"
        />
      ))}
      {quotaScope === "EMPLOYEE" ? <p className="col-span-full text-[13px] text-ql-fg-secondary">员工额度按厂商、月份和单位分列，请在<Link className="text-ql-action" to="/principals">员工接入配置</Link>查看；本页不推算历史余额。</p> : null}
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
        <thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[13px] text-ql-fg-tertiary">
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
      <span className="text-[13px] text-ql-fg-secondary">
        {start}–{end} / {total}
      </span>
      <Button
        variant="secondary" size="sm"
        disabled={offset === 0}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        type="button"
      >上一页</Button>
      <Button
        variant="secondary" size="sm"
        disabled={offset + limit >= total}
        onClick={() => onOffsetChange(offset + limit)}
        type="button"
      >下一页</Button>
    </nav>
  );
}
