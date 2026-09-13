import { useState } from "react";
import { PageShell } from "../components/layout/PageShell";
import { AlertsPanel } from "./runtime-assurance/AlertsPanel";
import { NotificationRecipientsPanel } from "./runtime-assurance/NotificationRecipientsPanel";

export function RuntimeAssurancePage() {
  const [activeTab, setActiveTab] = useState<"alerts" | "notifications">("alerts");

  return (
    <PageShell
      description="集中查询、处理并追踪系统运行异常，配置企业微信关键事件推送规则与接收人员"
      title="运行保障"
    >
      <div className="mb-5 flex gap-5 border-b border-ql-border" role="tablist">
        <button
          aria-selected={activeTab === "alerts"}
          className={`px-1 pb-3 text-[13px] font-medium transition-colors ${
            activeTab === "alerts"
              ? "border-b-2 border-ql-action text-ql-action"
              : "text-ql-fg-tertiary hover:text-ql-fg"
          }`}
          onClick={() => setActiveTab("alerts")}
          role="tab"
          type="button"
        >
          异常中心
        </button>
        <button
          aria-selected={activeTab === "notifications"}
          className={`px-1 pb-3 text-[13px] font-medium transition-colors ${
            activeTab === "notifications"
              ? "border-b-2 border-ql-action text-ql-action"
              : "text-ql-fg-tertiary hover:text-ql-fg"
          }`}
          onClick={() => setActiveTab("notifications")}
          role="tab"
          type="button"
        >
          通知人员
        </button>
      </div>

      {activeTab === "alerts" ? <AlertsPanel /> : <NotificationRecipientsPanel />}
    </PageShell>
  );
}
