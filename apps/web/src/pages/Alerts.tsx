/**
 * W20 异常告警看板 —— 四告警域 + 标记已处理 + 追踪到请求。
 *
 * PRD §11：资源是否还能用、谁的额度/费用异常；一期只在管理后台展示，
 * 可标记已处理，不发外部渠道；可从告警追踪到具体请求和上游尝试。
 * 颜色纪律：HIGH 用 danger，MEDIUM 用 warning，LOW/常态中性；OPEN 需要处理才醒目。
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { post } from "../api/client";
import { QUERY_KEYS, useAlerts } from "../api/hooks";
import type { AlertDomain, AlertItem } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { QueryGate } from "../components/states/QueryGate";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { RequestDrilldown } from "./RequestDrilldown";

const DOMAIN_LABEL: Record<AlertDomain, string> = {
  RESOURCE_UNAVAILABLE: "厂商/模型不可用",
  USAGE_SPIKE: "用量/费用异常",
  QUOTA_ANOMALY: "额度/账本异常",
  CREDENTIAL_INVALID: "凭证失效",
};

const STATUS_LABEL: Record<AlertItem["status"], string> = {
  OPEN: "未处理",
  INVESTIGATING: "处理中",
  RESOLVED: "已处理",
  IGNORED: "已忽略",
  AUTO_RESOLVED: "已自动恢复",
};

function severityTone(severity: AlertItem["severity"]): "danger" | "warning" | "neutral" {
  if (severity === "HIGH") return "danger";
  if (severity === "MEDIUM") return "warning";
  return "neutral";
}

export function AlertsPage() {
  const [showHandled, setShowHandled] = useState(false);
  const query = useAlerts(showHandled);
  useRedirectOnUnauthorized(query.error);
  const queryClient = useQueryClient();

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const disposition = useMutation({
    mutationFn: (input: { alert: AlertItem; status: "RESOLVED" | "IGNORED" | "INVESTIGATING" }) =>
      post("/alerts/disposition", {
        alert_key: input.alert.alertKey,
        status: input.status,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.alerts });
    },
  });

  const active = query.data?.alerts ?? [];
  const history = query.data?.history ?? [];
  const visible = showHandled ? [...active, ...history] : active;

  return (
    <PageShell
      description="资源可用性与额度/费用异常信号；告警实时派生自源事实并落库，源恢复自动归档，可查看处置历史"
      title="异常告警"
    >
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[13px] leading-5 text-ql-fg-secondary">
          未处理 <span className="font-semibold text-ql-fg">{active.length}</span> 条
        </p>
        <label className="flex items-center gap-2 text-[13px] text-ql-fg-secondary">
          <input
            checked={showHandled}
            onChange={(e) => setShowHandled(e.target.checked)}
            type="checkbox"
          />
          显示已处理历史
        </label>
      </div>

      <QueryGate
        emptyDescription="当前没有未处理告警。历史已处理事件可勾选右上角「显示已处理历史」查看。"
        emptyIcon={ShieldCheck}
        emptyTitle="运行正常"
        error={query.error}
        isEmpty={visible.length === 0}
        isLoading={query.isLoading}
        loadingRows={4}
        onRetry={() => void query.refetch()}
      >
        <div className="flex flex-col gap-3">
          {visible.map((alert) => (
            <AlertCard
              alert={alert}
              expanded={expandedKey === alert.alertKey}
              key={alert.alertKey}
              onDisposition={(status) => disposition.mutate({ alert, status })}
              onToggle={() => setExpandedKey(expandedKey === alert.alertKey ? null : alert.alertKey)}
              pending={disposition.isPending}
            />
          ))}
        </div>
      </QueryGate>
    </PageShell>
  );
}

function AlertCard({
  alert,
  expanded,
  onToggle,
  onDisposition,
  pending,
}: {
  alert: AlertItem;
  expanded: boolean;
  onToggle: () => void;
  onDisposition: (status: "RESOLVED" | "IGNORED" | "INVESTIGATING") => void;
  pending: boolean;
}) {
  const isOpen = alert.status === "OPEN" || alert.status === "INVESTIGATING";
  return (
    <div className="rounded-xl border border-ql-border bg-ql-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusTag tone={severityTone(alert.severity)}>{alert.severity}</StatusTag>
        <span className="text-[12px] leading-[18px] text-ql-fg-tertiary">
          {DOMAIN_LABEL[alert.domain]}
        </span>
        <span className="text-[14px] font-medium leading-[22px] text-ql-fg">{alert.title}</span>
        <span className="ml-auto flex items-center gap-2">
          <StatusTag tone={isOpen ? "warning" : "neutral"}>{STATUS_LABEL[alert.status]}</StatusTag>
          {alert.aiRequestId ? (
            <button
              className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-action"
              onClick={onToggle}
              type="button"
            >
              {expanded ? "收起请求" : "追踪请求"}
            </button>
          ) : null}
          {isOpen ? (
            <>
              <button
                className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-success hover:bg-ql-success-soft disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-action"
                disabled={pending}
                onClick={() => onDisposition("RESOLVED")}
                type="button"
              >
                标记已处理
              </button>
              <button
                className="rounded-md px-2 py-1 text-[12px] font-medium text-ql-fg-tertiary hover:bg-ql-surface-muted disabled:opacity-50"
                disabled={pending}
                onClick={() => onDisposition("IGNORED")}
                type="button"
              >
                忽略
              </button>
            </>
          ) : null}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-5 text-ql-fg-secondary">{alert.detail}</p>
      {expanded && alert.aiRequestId ? (
        <div className="mt-3">
          <RequestDrilldown requestId={alert.aiRequestId} />
        </div>
      ) : null}
    </div>
  );
}
