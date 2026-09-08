import { PageShell } from "../components/layout/PageShell";
import { AlertsPanel } from "./runtime-assurance/AlertsPanel";

export function RuntimeAssurancePage() {
  return (
    <PageShell
      description="集中查询、处理并追踪系统运行异常；通知与人员待企业微信身份链路完成后开放"
      title="运行保障"
    >
      <div className="mb-5 flex gap-5 border-b border-ql-border" role="tablist">
        <button
          aria-selected="true"
          className="border-b-2 border-ql-action px-1 pb-3 text-[13px] font-medium text-ql-action"
          role="tab"
          type="button"
        >
          异常中心
        </button>
        <button
          aria-selected="false"
          className="cursor-not-allowed px-1 pb-3 text-[13px] text-ql-fg-tertiary"
          disabled
          role="tab"
          type="button"
        >
          通知与人员
          <span className="ml-1.5 rounded bg-ql-warning-soft px-1.5 py-0.5 text-[10px] text-ql-warning">
            暂缓
          </span>
        </button>
      </div>
      <AlertsPanel />
    </PageShell>
  );
}
