import { PageShell } from "../components/layout/PageShell";
import { DepartmentBudgetEntry } from "../components/quota/DepartmentBudgetEntry";
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
  return (
    <PageShell description="按统一模型、Model Route、计价规则模板、调度策略的依赖顺序配置" title="额度规则">
      {model.error ? <p className="mb-4 rounded-lg bg-ql-danger-soft p-3 text-[13px] text-ql-danger" role="alert">{model.error.message}</p> : null}
      <DepartmentBudgetEntry />
      <label className="mb-4 inline-flex items-center gap-2 text-[12px] text-ql-fg-secondary">
        <input checked={model.showArchived} onChange={(event) => model.setShowArchived(event.target.checked)} type="checkbox" />
        查看已归档配置（历史、快照和审计仍保留）
      </label>
      <QuotaModelSection model={model} />
      <QuotaRouteSection model={model} />
      <QuotaBillingSection model={model} />
      <QuotaPolicySection model={model} />
      <QuotaDialogs model={model} />
    </PageShell>
  );
}
