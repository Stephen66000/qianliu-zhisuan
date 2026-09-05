import { PageShell } from "../components/layout/PageShell";
import { useState } from "react";
import { QuotaModelSection } from "../components/quota/QuotaModelSection";
import { QuotaRouteSection } from "../components/quota/QuotaRouteSection";
import { QuotaBillingSection } from "../components/quota/QuotaBillingSection";
import { QuotaPolicySection } from "../components/quota/QuotaPolicySection";
import { QuotaDialogs } from "../components/quota/QuotaDialogs";
import { useQuotaRulesPageModel } from "./quota-rules-page-model";

export { BillingRuleSchema, buildBillingRulePayload } from "./quota-rule-contract";
export type { BillingRuleValues } from "./quota-rule-contract";
export { buildDispatchPolicyPayload } from "../components/quota/dispatch-policy-form";

export function QuotaRulesPage() {
  const model = useQuotaRulesPageModel();
  const [tab, setTab] = useState<"pricing" | "dispatch">("pricing");
  return (
    <PageShell description="模型计价与调度策略" title="额度规则">
      {model.error ? <p className="mb-4 rounded-lg bg-ql-danger-soft p-3 text-[13px] text-ql-danger" role="alert">{model.error.message}</p> : null}
      <div role="tablist" aria-label="额度规则" className="mb-4 flex gap-4 border-b border-ql-border">
        <button role="tab" aria-selected={tab === "pricing"} onClick={() => setTab("pricing")} className={`p-3 border-b-2 ${tab === "pricing" ? "border-ql-action text-ql-action" : "border-transparent"}`}>计价</button>
        <button role="tab" aria-selected={tab === "dispatch"} onClick={() => setTab("dispatch")} className={`p-3 border-b-2 ${tab === "dispatch" ? "border-ql-action text-ql-action" : "border-transparent"}`}>调度策略</button>
      </div>
      <label className="mb-4 inline-flex items-center gap-2 text-[12px] text-ql-fg-secondary">
        <input checked={model.showArchived} onChange={(event) => model.setShowArchived(event.target.checked)} type="checkbox" />
        查看存档
      </label>
      {tab === "pricing" ? <QuotaBillingSection model={model} /> : <QuotaPolicySection model={model} />}
      {tab === "pricing" ? <details className="rounded border border-ql-border p-3">
        <summary className="cursor-pointer text-sm">已有模型与路由管理</summary>
        <QuotaModelSection model={model} managementOnly />
        <QuotaRouteSection model={model} managementOnly />
      </details> : null}
      <QuotaDialogs model={model} />
    </PageShell>
  );
}
