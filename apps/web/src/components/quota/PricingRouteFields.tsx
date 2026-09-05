import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { copyPrice, pricingCopyCandidates, currentPricingSet } from "./pricing-copy";

export function PricingRouteFields({ model: m }: { model: QuotaRulesPageModel }) {
  const selectedRoute = m.allRoutes.find((route) => route.id === m.selectedRuleRouteId);
  const candidates = pricingCopyCandidates(m.allRules, m.resources,
    selectedRoute?.provider_resource_id ?? "", selectedRoute?.upstream_model ?? "");
  const clearDrafts = () => { m.setQueuedRules([]); m.setSourceRuleIds([]); m.setReplaceExisting(false); m.setSubmissionId(crypto.randomUUID()); };
  return <>
    <FormField htmlFor="pricing-model" label="模型">
      <select id="pricing-model" className={INPUT_CLASS} value={m.selectedModelId ?? ""}
        onChange={(event) => { m.setSelectedModelId(event.target.value); m.setSelectedRuleRouteId("");
          m.ruleForm.setValue("provider_resource_id", ""); m.ruleForm.setValue("upstream_model", ""); clearDrafts(); }}>
        <option value="">请选择模型</option>
        {m.models.filter((item) => !item.archived_at).map((item) => <option key={item.id} value={item.id}>
          {item.display_name}（{item.alias}）{item.status === "PENDING_CONFIG" ? " · 待配置" : ""}</option>)}
      </select>
    </FormField>
    <FormField htmlFor="pricing-resource" label="厂商资源" error={m.ruleForm.formState.errors.provider_resource_id?.message}>
      <select id="pricing-resource" className={INPUT_CLASS} value={m.selectedRuleRouteId} onChange={(event) => {
        const route = m.allRoutes.find((item) => item.id === event.target.value);
        m.setSelectedRuleRouteId(event.target.value); clearDrafts();
        m.ruleForm.setValue("provider_resource_id", route?.provider_resource_id ?? "");
        m.ruleForm.setValue("upstream_model", route?.upstream_model ?? "");
        m.routeForm.setValue("priority", route?.priority ?? 100); m.routeForm.setValue("weight", route?.weight ?? 1);
        const resource = m.resources.find((item) => item.id === route?.provider_resource_id);
        m.ruleForm.setValue("rule_type", resource?.mode === "CODING_PLAN" ? "MODEL_TIER" : "API_PRICE");
        m.ruleForm.setValue("pricing_mode", "ABSOLUTE");
        m.ruleForm.setValue("cache_hit_price", ""); m.ruleForm.setValue("cache_miss_price", ""); m.ruleForm.setValue("output_price", "");
        m.ruleForm.setValue("windows", []);
      }}>
        <option value="">请选择资源</option>
        {m.allRoutes.filter((route) => !route.archived_at).map((route) => {
          const resource = m.resources.find((item) => item.id === route.provider_resource_id);
          return <option key={route.id} value={route.id} disabled={!resource || !["ACTIVE", "DEGRADED"].includes(resource.status)}>
            {resource?.name} · {resource?.mode} · {route.upstream_model}</option>;
        })}
      </select>
    </FormField>
    <FormField htmlFor="pricing-route-priority" label="路由优先级">
      <input id="pricing-route-priority" type="number" className={INPUT_CLASS} {...m.routeForm.register("priority")} />
    </FormField>
    <FormField htmlFor="pricing-route-weight" label="路由权重">
      <input id="pricing-route-weight" type="number" min="1" className={INPUT_CLASS} {...m.routeForm.register("weight")} />
    </FormField>
    <div className="md:col-span-4 border-t border-ql-border pt-3">
      <h3 className="mb-2 font-medium">计价</h3>
      <FormField htmlFor="pricing-copy" label="沿用同厂商整套价格">
        <select id="pricing-copy" className={INPUT_CLASS} value="" onChange={(event) => {
          const source = candidates.find((rule) => rule.id === event.target.value);
          if (!source || !selectedRoute) return;
          const set = currentPricingSet(candidates, source);
          const suffix = Date.now().toString(36);
          const values = set.map((rule, index) => copyPrice(rule, selectedRoute.provider_resource_id, selectedRoute.upstream_model, `${suffix}-${index}`));
          m.ruleForm.reset(values[0]); m.setQueuedRules(values.slice(1)); m.setSourceRuleIds(set.map((rule) => rule.id));
          m.setSubmissionId(crypto.randomUUID());
        }}>
          <option value="">{candidates.length ? "选择来源后核对价格、时段及版本" : "无可用候选，请填写价格"}</option>
          {candidates.map((rule) => <option key={rule.id} value={rule.id}>{rule.upstream_model} · {rule.rule_version} · {rule.currency}</option>)}
        </select>
      </FormField>
      {m.sourceRuleIds.length > 0 ? <p className="mt-2 text-xs">已沿用 {m.sourceRuleIds.length} 条规则；目标模型和生效时间已更新，请核对后保存。</p> : null}
      <label className="mt-3 flex gap-2 text-xs"><input type="checkbox" checked={m.replaceExisting}
        onChange={(event) => m.setReplaceExisting(event.target.checked)} />
        从新生效时间起替换此资源、此模型的整套旧价格（历史结算保留）</label>
      {selectedRoute && !selectedRoute.enabled ? <p className="mt-2 text-xs">启用前需在厂商资源的模型同步面板完成真实验证。</p> : null}
    </div>
  </>;
}
