import { X } from "lucide-react";
import type { ReactNode } from "react";

import type { AlertItem } from "../../api/types";
import { StatusTag } from "../../components/dashboard/StatusTag";
import { INPUT_CLASS } from "../../components/writes/FormField";
import { RequestDrilldown } from "../RequestDrilldown";
import {
  DOMAIN_LABEL,
  formatTime,
  isActionable,
  isHandled,
  recoveryText,
} from "./alert-presenters";

export function AlertDetailDrawer({
  alert,
  principalName,
  providerName,
  resourceName,
  handledPending,
  onClose,
  onHandle,
}: {
  alert: AlertItem;
  principalName?: string;
  providerName?: string;
  resourceName?: string;
  handledPending: boolean;
  onClose: () => void;
  onHandle: () => void;
}) {
  const handled = isHandled(alert);
  const recovered =
    alert.status === "AUTO_RESOLVED" || Boolean(alert.sourceClearedAt);
  const severityTone =
    alert.severity === "HIGH"
      ? "danger"
      : alert.severity === "MEDIUM"
        ? "warning"
        : "neutral";
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      role="presentation"
    >
      <aside
        aria-labelledby="alert-detail-title"
        aria-modal="true"
        className="h-full w-full max-w-xl overflow-y-auto border-l border-ql-border bg-ql-surface shadow-2xl"
        role="dialog"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-ql-border bg-ql-surface px-5 py-4">
          <div>
            <h2 className="font-semibold text-ql-fg" id="alert-detail-title">
              异常详情
            </h2>
            <p className="mt-1 text-[11px] text-ql-fg-tertiary">{alert.id}</p>
          </div>
          <button
            aria-label="关闭异常详情"
            className="rounded-lg p-1 text-ql-fg-tertiary hover:bg-ql-surface-subtle"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap gap-2">
            <StatusTag tone={handled ? "success" : "danger"}>
              {handled ? "已处理" : "未处理"}
            </StatusTag>
            <StatusTag tone={recovered ? "success" : "warning"}>
              {recoveryText(alert)}
            </StatusTag>
            <StatusTag tone={severityTone}>{alert.severity}</StatusTag>
          </div>
          <DetailSection title="基本信息">
            <div className="grid gap-4 sm:grid-cols-2">
              <DetailValue
                label="发生时间"
                value={formatTime(alert.firstSeenAt)}
              />
              <DetailValue
                label="最后出现"
                value={formatTime(alert.lastSeenAt)}
              />
              <DetailValue label="使用主体" value={principalName ?? "系统级"} />
              <DetailValue
                label="厂商 / 资源"
                value={
                  [providerName, resourceName].filter(Boolean).join(" / ") ||
                  "未关联"
                }
              />
            </div>
          </DetailSection>
          <DetailSection title="异常内容">
            <div className="grid gap-4 sm:grid-cols-2">
              <DetailValue
                label="异常类型"
                value={DOMAIN_LABEL[alert.domain]}
              />
              <DetailValue label="异常信号" value={alert.signal} />
            </div>
            <div className="mt-3 rounded-lg bg-ql-surface-subtle p-3">
              <p className="text-[13px] font-medium text-ql-fg">
                {alert.title}
              </p>
              <p className="mt-1 text-[12px] leading-5 text-ql-fg-secondary">
                {alert.detail ?? "无补充说明"}
              </p>
            </div>
          </DetailSection>
          <DetailSection title="处理情况">
            <label className="text-[11px] text-ql-fg-tertiary">
              是否处理
              <select
                aria-label="详情是否处理"
                className={`${INPUT_CLASS} mt-1 w-full`}
                disabled={!isActionable(alert) || handledPending}
                onChange={(event) => {
                  if (event.target.value === "yes") onHandle();
                }}
                value={handled ? "yes" : "no"}
              >
                <option value="no">否</option>
                <option value="yes">是</option>
              </select>
            </label>
            <p className="mt-2 text-[11px] text-ql-fg-tertiary">
              修改为“是”后立即保存，不再设置单独的“标记已处理”按钮。
            </p>
            {alert.resolutionNote ? (
              <p className="mt-3 rounded-lg bg-ql-surface-subtle p-3 text-[12px] text-ql-fg-secondary">
                {alert.resolutionNote}
              </p>
            ) : null}
          </DetailSection>
          <DetailSection title="恢复情况">
            <div
              className={`rounded-lg p-3 text-[12px] leading-5 ${recovered ? "bg-ql-success-soft text-ql-success" : "bg-ql-warning-soft text-ql-warning"}`}
            >
              {recovered
                ? `后台已恢复${alert.sourceClearedAt ? ` · ${formatTime(alert.sourceClearedAt)}` : ""}`
                : "后台尚未恢复，系统将继续检测；恢复后自动更新为“已自动恢复”。"}
            </div>
          </DetailSection>
          {alert.aiRequestId ? (
            <DetailSection title="关联请求">
              <RequestDrilldown requestId={alert.aiRequestId} />
            </DetailSection>
          ) : null}
          <DetailSection title="事件记录">
            <ol className="space-y-3 border-l border-ql-border pl-4 text-[12px] text-ql-fg-secondary">
              <li>
                <span className="font-medium text-ql-fg">
                  {formatTime(alert.firstSeenAt)}
                </span>
                　检测到异常并创建记录
              </li>
              {handled ? (
                <li>
                  <span className="font-medium text-ql-fg">
                    {formatTime(alert.resolvedAt)}
                  </span>
                  　管理员已处理
                </li>
              ) : null}
              {recovered ? (
                <li>
                  <span className="font-medium text-ql-fg">
                    {formatTime(alert.sourceClearedAt ?? alert.resolvedAt)}
                  </span>
                  　后台自动确认恢复
                </li>
              ) : null}
            </ol>
          </DetailSection>
        </div>
      </aside>
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-ql-border pt-5">
      <h3 className="mb-3 text-[13px] font-semibold text-ql-fg">{title}</h3>
      {children}
    </section>
  );
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-ql-fg-tertiary">{label}</p>
      <p className="mt-1 text-[12px] text-ql-fg">{value}</p>
    </div>
  );
}
