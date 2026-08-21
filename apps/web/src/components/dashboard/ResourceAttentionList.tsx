import { CircleAlert } from "lucide-react";

import type { ResourceBreakdownItem } from "../../api/types";
import { StatusTag } from "./StatusTag";

const STATUS_LABEL: Record<string, string> = {
  DEGRADED: "降级",
  RATE_LIMITED: "限流冷却",
  UNAVAILABLE: "不可用",
  EXHAUSTED: "额度耗尽",
  EXPIRED: "已过期",
  CREDENTIAL_INVALID: "凭证失效",
};

export interface ResourceAttentionItem {
  resourceId: string;
  resourceName: string;
  providerName: string;
  mode: ResourceBreakdownItem["mode"];
  status: string;
}

export function ResourceAttentionList({ items }: { items: ResourceAttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-ql-border bg-ql-surface p-5">
      <div className="flex items-center gap-2">
        <CircleAlert aria-hidden className="h-4 w-4 text-ql-danger" />
        <p className="text-[14px] font-semibold text-ql-fg">当前异常厂商资源</p>
        <StatusTag tone="danger">{items.length} 个需处理</StatusTag>
      </div>
      <ul className="mt-3 divide-y divide-ql-border-zone">
        {items.map((item) => (
          <li className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0" key={item.resourceId}>
            <div>
              <a className="text-[13px] font-medium text-ql-action" href={`/resources#health-${item.resourceId}`}>
                {item.resourceName}
              </a>
              <span className="ml-2 text-[11px] text-ql-fg-tertiary">
                {item.providerName} · {item.mode === "API" ? "API" : "套餐"}
              </span>
            </div>
            <StatusTag tone={item.status === "DEGRADED" || item.status === "RATE_LIMITED" ? "warning" : "danger"}>
              {STATUS_LABEL[item.status] ?? item.status}
            </StatusTag>
          </li>
        ))}
      </ul>
    </div>
  );
}
