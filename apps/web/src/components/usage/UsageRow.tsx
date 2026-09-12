import { ChevronDown, ChevronRight } from "lucide-react";

import type { UsageRecord } from "../../api/types";
import { formatCount, formatDateTimeFull, formatDuration, formatMoney } from "../../lib/format";
import { RequestDrilldown } from "../../pages/RequestDrilldown";
import { StatusTag } from "../dashboard/StatusTag";

const STATUS_LABEL: Record<string, string> = {
  PENDING: "等待中", SUCCEEDED: "成功", FAILED: "失败",
  IN_PROGRESS: "进行中", CANCELLED: "已取消",
};
const AGENT_LABEL: Record<string, string> = {
  WORKBUDDY: "WorkBuddy", CODEX: "Codex", ZCODE: "Z Code", CLAUDE_CODE: "Claude Code",
  QIANLIU_IDE: "仟流 IDE", OTHER: "其他", UNKNOWN: "未知",
};
const AGENT_SOURCE_LABEL: Record<string, string> = {
  DECLARED_HEADER: "客户端声明（有限可信）", VERIFIED_USER_AGENT: "User-Agent 观测",
  PROTOCOL_FEATURE: "协议特征（有限可信）", NONE: "无识别信息",
};

function StatusCell({ status }: { status: string }) {
  const tone = status === "FAILED" ? "danger" : "neutral";
  return <StatusTag tone={tone}>{STATUS_LABEL[status] ?? status}</StatusTag>;
}

function ApiCostCell({ record }: { record: UsageRecord }) {
  if (!record.hasSettlement) {
    return <span className="text-ql-fg-tertiary">未结算</span>;
  }
  if (record.totalApiCost === "0" || record.totalApiCost === "0.00000000") {
    return <span className="text-ql-fg-secondary">套餐内</span>;
  }
  const symbol = record.costCurrency === "USD" ? "$" : "¥";
  return <span>{symbol}{formatMoney(record.totalApiCost)}</span>;
}

export function UsageRow({ record, expanded, onToggle }: {
  record: UsageRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  return <>
    <tr className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg hover:bg-ql-surface-subtle">
      <td className="py-2.5 pr-2">
        <button aria-expanded={expanded} aria-label={expanded ? "收起路由过程" : "展开路由过程"}
          className="flex h-6 w-6 items-center justify-center rounded-md text-ql-fg-tertiary hover:bg-ql-surface-muted hover:text-ql-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-action"
          onClick={onToggle} type="button">
          {expanded ? <ChevronDown aria-hidden className="h-4 w-4" /> : <ChevronRight aria-hidden className="h-4 w-4" />}
        </button>
      </td>
      <td className="max-w-[10rem] truncate py-2.5 pr-4 font-mono text-[12px] text-ql-fg-secondary">{record.requestId}</td>
      <td className="whitespace-nowrap py-2.5 pr-4 font-medium">{record.principalName}</td>
      <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
        <span className="block text-ql-fg">{AGENT_LABEL[record.agentFamily] ?? record.agentFamily}</span>
        <span className="block text-[11px]" title={record.clientId ?? undefined}>
          {record.agentVersion ? `v${record.agentVersion}` : "版本未知"} · {AGENT_SOURCE_LABEL[record.agentIdentitySource] ?? record.agentIdentitySource}
        </span>
      </td>
      <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">{record.unifiedModel}</td>
      <td className="min-w-[9rem] py-2.5 pr-4 text-ql-fg-secondary">
        {record.finalProviderResourceName ? <>
          <span className="block text-ql-fg">{record.finalProviderResourceName}</span>
          <span className="block text-[12px]">{record.finalProviderName ?? record.finalProviderCode ?? "未知厂商"}</span>
        </> : "—"}
      </td>
      <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">{formatCount(record.totalInputTokens)}</td>
      <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">{formatCount(record.totalOutputTokens)}</td>
      <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">{formatCount(record.totalCacheTokens)}</td>
      <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
        {formatCount(record.totalDeductedQuota)}
        {record.overage === true ? <span className="ml-1 text-[11px] text-ql-danger">超额</span> : null}
      </td>
      <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]"><ApiCostCell record={record} /></td>
      <td className="py-2.5 pr-4"><StatusCell status={record.status} /></td>
      <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">{formatDateTimeFull(record.startedAt)}</td>
      <td className="py-2.5 text-right [font-variant-numeric:tabular-nums]">
        {record.durationMs === null ? "—" : formatDuration(record.durationMs)}
      </td>
    </tr>
    {expanded ? <tr className="border-b border-ql-border-zone">
      <td className="bg-ql-surface-subtle p-3" colSpan={14}><RequestDrilldown requestId={record.requestId} /></td>
    </tr> : null}
  </>;
}
