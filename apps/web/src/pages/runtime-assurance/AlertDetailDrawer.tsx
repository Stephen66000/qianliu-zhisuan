import { X } from "lucide-react";
import type { ReactNode } from "react";
import { AlertHandlingForm } from "./AlertHandlingForm";

import type { AlertItem } from "../../api/types";
import { StatusTag } from "../../components/dashboard/StatusTag";
import { RequestDrilldown } from "../RequestDrilldown";
import { faultGuidance, faultCategory } from "./alert-guidance";
import {
  formatTime,
  isHandled,
  recoveryText,
  hasVerifiedRecovery,
} from "./alert-presenters";

export function AlertDetailDrawer({
  alert,
  principalName,
  providerName,
  resourceName,
  startHandling = false,
  handledError = false,
  handledPending,
  onClose,
  onHandle,
}: {
  alert: AlertItem;
  principalName?: string;
  providerName?: string;
  resourceName?: string;
  startHandling?: boolean;
  handledError?: boolean;
  handledPending: boolean;
  onClose: () => void;
  onHandle: (note: string) => void;
}) {
  const handled = isHandled(alert);
  const recovered = hasVerifiedRecovery(alert);
  const guidance = faultGuidance(alert);
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
            <StatusTag tone={severityTone}>
              {{ HIGH: "高", MEDIUM: "中", LOW: "低" }[alert.severity]}等级
            </StatusTag>
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
                label="模型"
                value={alert.model ?? "未记录；可在关联请求中核对"}
              />
              <DetailValue
                label="厂商 / 资源"
                value={
                  [providerName, resourceName].filter(Boolean).join(" / ") ||
                  "未关联"
                }
              />
            </div>
          </DetailSection>
          <DetailSection title="异常原因">
            <div className="grid gap-4 sm:grid-cols-2">
              <DetailValue label="异常类型" value={faultCategory(alert)} />
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
          <DetailSection title="影响范围">
            <p className="text-[12px] leading-5 text-ql-fg-secondary">
              {guidance.scope}
            </p>
          </DetailSection>
          <DetailSection title="处理建议">
            <p className="text-[12px] leading-5 text-ql-fg-secondary">
              {guidance.advice}
            </p>
          </DetailSection>
          <DetailSection title="处理情况">
            <AlertHandlingForm
              alert={alert}
              startHandling={startHandling}
              handledPending={handledPending}
              handledError={handledError}
              onHandle={onHandle}
            />
          </DetailSection>
          <DetailSection title="恢复依据">
            <div
              className={`rounded-lg p-3 text-[12px] leading-5 ${recovered ? "bg-ql-success-soft text-ql-success" : "bg-ql-warning-soft text-ql-warning"}`}
            >
              {recovered
                ? `${String(alert.recoveryEvidence?.summary)} · ${formatTime(String(alert.recoveryEvidence?.verifiedAt))}`
                : recoveryText(alert) === "单次失败记录"
                  ? "这是历史失败记录；后续新请求成功不会改写本次结果，请在处理说明中记录跟进结论。"
                  : "尚无可靠恢复证据。历史自动恢复标记和预计恢复时间不代表调用已恢复成功。"}
              {recovered && alert.recoveryEvidence?.referenceId ? (
                <p className="mt-2 break-all">
                  证据编号：{String(alert.recoveryEvidence.referenceId)}
                </p>
              ) : null}
            </div>
          </DetailSection>
          <DetailSection title="关联请求与事件记录">
            {alert.aiRequestId ? (
              <div className="mb-4">
                <RequestDrilldown requestId={alert.aiRequestId} />
              </div>
            ) : null}
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
                  　系统根据证据确认恢复
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
