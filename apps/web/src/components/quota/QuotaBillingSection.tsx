import { useMemo, useState } from "react";
import { Gauge, LayoutGrid, List } from "lucide-react";
import { ManagementSection } from "./ManagementSection";
import { QueryGate } from "../states/QueryGate";
import { StatusTag } from "../dashboard/StatusTag";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { WeekdayPicker, formatDaysOfWeek, parseDaysOfWeek } from "./WeekdayPicker";
import { BillingRuleSchema, editableWindows, localDateTimeValue } from "../../pages/quota-rule-contract";
import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";
import { PricingRouteFields } from "./PricingRouteFields";
import { PricingPreview } from "./PricingPreview";
import { ModelDisableAction } from "./ModelDisableAction";
import { ModelRuleCard } from "./ModelRuleCard";
import { groupRulesByModel, getRuleStatusCategory, type ModelRuleGroup } from "./model-rule-grouping";
import { copyPrice, pricingCopyCandidates, currentPricingSet } from "./pricing-copy";
import { toPerMillion, toPerToken } from "../../lib/price-unit";

// eslint-disable-next-line complexity -- 已登记例外（2026-09-14 I1 审核）：规则卡片区编排组件，条件渲染密集，拆分计划见审核报告 F-P2-3。
export function QuotaBillingSection({ model }: { model: QuotaRulesPageModel }) {
  const { archiveConfig, canCreateRule, showRuleForm, setShowRuleForm, ruleForm, selectedRuleType, ruleWindowFields, appendRuleWindow, removeRuleWindow, rules, updateRule, setArchiveTarget, createRule, rulesQuery } = model;
  const [filterProvider, setFilterProvider] = useState<string>("all");
  const [filterModel, setFilterModel] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"card" | "table">("card");

  const resourceMap = useMemo(() => {
    return new Map(model.resources.map((r) => [r.id, r]));
  }, [model.resources]);

  const providerMap = useMemo(() => {
    return new Map((model.providers ?? []).map((p) => [p.id, p]));
  }, [model.providers]);

  const providerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of model.resources) {
      if (!r.provider_id) continue;
      const p = providerMap.get(r.provider_id);
      map.set(r.provider_id, p?.name ?? r.name);
    }
    for (const r of rules) {
      if (!r.provider_resource_id) continue;
      const res = resourceMap.get(r.provider_resource_id);
      if (res && res.provider_id) {
        const p = providerMap.get(res.provider_id);
        map.set(res.provider_id, p?.name ?? res.name);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [model.resources, rules, resourceMap, providerMap]);

  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rules) {
      if (!r.upstream_model) continue;
      if (filterProvider !== "all") {
        const res = r.provider_resource_id ? resourceMap.get(r.provider_resource_id) : undefined;
        if (!res || res.provider_id !== filterProvider) continue;
      }
      set.add(r.upstream_model);
    }
    return Array.from(set).sort();
  }, [rules, filterProvider, resourceMap]);

  const filteredRules = useMemo(() => {
    const now = Date.now();
    return rules.filter((rule) => {
      if (filterProvider !== "all") {
        const res = rule.provider_resource_id ? resourceMap.get(rule.provider_resource_id) : undefined;
        if (!res || res.provider_id !== filterProvider) return false;
      }
      if (filterModel !== "all") {
        if (rule.upstream_model !== filterModel) return false;
      }
      if (filterStatus !== "all") {
        const cat = getRuleStatusCategory(rule, now);
        if (cat !== filterStatus) return false;
      }
      return true;
    });
  }, [rules, filterProvider, filterModel, filterStatus, resourceMap]);

  const filteredGroups = useMemo(() => {
    return groupRulesByModel(
      filteredRules,
      model.resources,
      model.providers,
      model.models,
      model.allRoutes
    );
  }, [filteredRules, model.resources, model.providers, model.models, model.allRoutes]);

  const handleAddPeakWindow = (group: ModelRuleGroup) => {
    const route = model.allRoutes.find(
      (rt) => rt.provider_resource_id === group.providerResourceId && rt.upstream_model === group.upstreamModel
    );
    model.setShowRuleForm(true);
    if (route) {
      model.setSelectedModelId(route.unified_model_id);
      model.setSelectedRuleRouteId(route.id);
      model.routeForm.setValue("priority", route.priority);
      model.routeForm.setValue("weight", route.weight);
    }
    if (group.providerResourceId) {
      model.ruleForm.setValue("provider_resource_id", group.providerResourceId);
    }
    if (group.upstreamModel) {
      model.ruleForm.setValue("upstream_model", group.upstreamModel);
    }
    const resource = model.resources.find((item) => item.id === group.providerResourceId);
    const isCodingPlan = resource?.mode === "CODING_PLAN";
    model.ruleForm.setValue("rule_type", isCodingPlan ? "TIME_WINDOW" : "API_PRICE");
    model.ruleForm.setValue("pricing_mode", isCodingPlan ? "ABSOLUTE" : "MULTIPLIER");
    model.ruleForm.setValue("rule_version", `${group.upstreamModel ?? "model"}-peak-v1`);
    if (!isCodingPlan && group.baseRule) {
      model.ruleForm.setValue("cache_hit_price", toPerMillion(group.baseRule.cache_hit_price) ?? "");
      model.ruleForm.setValue("cache_miss_price", toPerMillion(group.baseRule.cache_miss_price) ?? "");
      model.ruleForm.setValue("output_price", toPerMillion(group.baseRule.output_price) ?? "");
      model.ruleForm.setValue("multiplier", "1.5");
    } else if (isCodingPlan && group.baseRule) {
      model.ruleForm.setValue("multiplier", group.baseRule.multiplier ?? "1.5");
    }
    model.appendRuleWindow({
      timezone: "Asia/Shanghai",
      days_of_week: "1,2,3,4,5",
      start_time: "14:00",
      end_time: "18:00",
    });
  };

  const handleConfigureBaseRule = (group: ModelRuleGroup) => {
    const route = model.allRoutes.find(
      (rt) => rt.provider_resource_id === group.providerResourceId && rt.upstream_model === group.upstreamModel
    );
    model.setShowRuleForm(true);
    if (route) {
      model.setSelectedModelId(route.unified_model_id);
      model.setSelectedRuleRouteId(route.id);
      model.routeForm.setValue("priority", route.priority);
      model.routeForm.setValue("weight", route.weight);
    }
    if (group.providerResourceId) {
      model.ruleForm.setValue("provider_resource_id", group.providerResourceId);
    }
    if (group.upstreamModel) {
      model.ruleForm.setValue("upstream_model", group.upstreamModel);
    }
    const resource = model.resources.find((item) => item.id === group.providerResourceId);
    const isCodingPlan = resource?.mode === "CODING_PLAN";
    model.ruleForm.setValue("rule_type", isCodingPlan ? "MODEL_TIER" : "API_PRICE");
    model.ruleForm.setValue("pricing_mode", "ABSOLUTE");
    model.ruleForm.setValue("rule_version", `${group.upstreamModel ?? "model"}-base-v1`);
    model.ruleForm.setValue("windows", []);
  };

  const handleAdjustPricing = (group: ModelRuleGroup) => {
    const route = model.allRoutes.find(
      (rt) => rt.provider_resource_id === group.providerResourceId && rt.upstream_model === group.upstreamModel
    );
    model.setShowRuleForm(true);
    if (route) {
      model.setSelectedModelId(route.unified_model_id);
      model.setSelectedRuleRouteId(route.id);
      model.routeForm.setValue("priority", route.priority);
      model.routeForm.setValue("weight", route.weight);
    }
    if (group.providerResourceId) {
      model.ruleForm.setValue("provider_resource_id", group.providerResourceId);
    }
    if (group.upstreamModel) {
      model.ruleForm.setValue("upstream_model", group.upstreamModel);
    }
    if (group.providerResourceId && group.upstreamModel) {
      const candidates = pricingCopyCandidates(
        model.allRules,
        model.resources,
        group.providerResourceId,
        group.upstreamModel
      );
      const source = candidates.find(
        (r) => r.provider_resource_id === group.providerResourceId && r.upstream_model === group.upstreamModel
      ) ?? candidates[0];

      if (source && route) {
        const set = currentPricingSet(candidates, source);
        const suffix = Date.now().toString(36);
        const values = set.map((r, index) =>
          copyPrice(r, route.provider_resource_id, route.upstream_model, `${suffix}-${index}`)
        );
        model.ruleForm.reset(values[0]);
        model.setQueuedRules(values.slice(1));
        model.setSourceRuleIds(set.map((r) => r.id));
        model.setSubmissionId(crypto.randomUUID());
        model.setReplaceExisting(true);
        return;
      }
    }
    if (group.baseRule) {
      const suffix = Date.now().toString(36);
      const val = copyPrice(
        group.baseRule,
        group.providerResourceId ?? "",
        group.upstreamModel ?? "",
        suffix
      );
      model.ruleForm.reset(val);
      if (group.peakRules.length > 0) {
        const queued = group.peakRules.map((pr, idx) =>
          copyPrice(pr, group.providerResourceId ?? "", group.upstreamModel ?? "", `${suffix}-peak-${idx}`)
        );
        model.setQueuedRules(queued);
        model.setSourceRuleIds([group.baseRule.id, ...group.peakRules.map((pr) => pr.id)]);
      }
      model.setReplaceExisting(true);
    }
  };

  const isFiltered = filterProvider !== "all" || filterModel !== "all" || filterStatus !== "all";
  const resetFilters = () => {
    setFilterProvider("all");
    setFilterModel("all");
    setFilterStatus("all");
  };
  return <>
      <ManagementSection
        actionLabel="新建规则"
        actionDisabled={!canCreateRule}
        hint={
          canCreateRule
            ? "选择已同步模型和资源，配置价格后保存并启用。"
            : "请先到厂商资源登记资源并同步模型。"
        }
        onAction={() => setShowRuleForm((value) => !value)}
        title="计价"
      >
        {showRuleForm ? (
          <form data-write-action
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-4 md:grid-cols-4"
            onSubmit={ruleForm.handleSubmit((values) => createRule.mutate(values))}
          >
            <PricingRouteFields model={model} />
            <FormField
              error={ruleForm.formState.errors.rule_type?.message}
              htmlFor="rule-type"
              label="规则类型"
            >
              <select className={INPUT_CLASS} id="rule-type" {...ruleForm.register("rule_type")}>
                <option value="API_PRICE">API Token 计价</option>
                <option value="TIME_WINDOW">时段倍率</option>
                <option value="MODEL_TIER">模型分层</option>
                <option value="CACHE_STATE">缓存状态</option>
              </select>
            </FormField>
            <FormField
              error={ruleForm.formState.errors.rule_version?.message}
              htmlFor="rule-version"
              label="规则版本"
            >
              <input className={INPUT_CLASS} id="rule-version" {...ruleForm.register("rule_version")} />
            </FormField>
            <input type="hidden" {...ruleForm.register("provider_resource_id")} />
            <input type="hidden" {...ruleForm.register("upstream_model")} />
            <FormField htmlFor="rule-currency" label="币种">
              <select className={INPUT_CLASS} id="rule-currency" {...ruleForm.register("currency")}><option>CNY</option><option>USD</option></select>
            </FormField>
            {selectedRuleType === "API_PRICE" ? <FormField htmlFor="rule-pricing-mode" label="计价方式">
              <select id="rule-pricing-mode" className={INPUT_CLASS} {...ruleForm.register("pricing_mode")}>
                <option value="ABSOLUTE">绝对单价</option><option value="MULTIPLIER">基础单价 × 时段倍率</option>
              </select>
            </FormField> : null}
            <FormField
              error={ruleForm.formState.errors.effective_from?.message}
              htmlFor="rule-effective-from"
              label="生效时间"
            >
              <input
                className={INPUT_CLASS}
                id="rule-effective-from"
                type="datetime-local"
                {...ruleForm.register("effective_from")}
              />
            </FormField>
            <FormField
              error={ruleForm.formState.errors.effective_to?.message}
              htmlFor="rule-effective-to"
              label="失效时间（可空）"
            >
              <input
                className={INPUT_CLASS}
                id="rule-effective-to"
                type="datetime-local"
                {...ruleForm.register("effective_to")}
              />
            </FormField>
            {selectedRuleType !== "MODEL_TIER" ? (
              <div className="md:col-span-4 rounded-lg border border-ql-border-zone p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="text-[12px] font-medium text-ql-fg">时间窗口</p>
                    <p className="text-[11px] text-ql-fg-tertiary">可配置多段；开始含、结束不含。</p>
                  </div>
                  <button
                    className="rounded px-2 py-1 text-[12px] text-ql-action hover:bg-ql-action-soft"
                    onClick={() => appendRuleWindow({
                      timezone: "Asia/Shanghai",
                      days_of_week: "1,2,3,4,5,6,7",
                      start_time: "09:00",
                      end_time: "12:00",
                    })}
                    type="button"
                  >
                    添加窗口
                  </button>
                </div>
                {(ruleForm.formState.errors.windows as { message?: string } | undefined)?.message ? (
                  <p className="mb-2 text-[11px] text-ql-danger">
                    {(ruleForm.formState.errors.windows as { message?: string }).message}
                  </p>
                ) : null}
                <div className="flex flex-col gap-2">
                  {ruleWindowFields.map((field, index) => (
                    <div
                      className="grid grid-cols-1 gap-2 rounded border border-ql-border-zone p-2 md:grid-cols-5"
                      key={field.id}
                    >
                      <FormField
                        error={ruleForm.formState.errors.windows?.[index]?.timezone?.message}
                        htmlFor={`rule-window-${index}-timezone`}
                        label="IANA 时区"
                      >
                        <input
                          className={INPUT_CLASS}
                          id={`rule-window-${index}-timezone`}
                          {...ruleForm.register(`windows.${index}.timezone`)}
                        />
                      </FormField>
                      <FormField
                        error={ruleForm.formState.errors.windows?.[index]?.days_of_week?.message}
                        htmlFor={`rule-window-${index}-days`}
                        label="星期"
                      >
                        <WeekdayPicker
                          value={ruleForm.watch(`windows.${index}.days_of_week`) ?? ""}
                          onChange={(next) =>
                            ruleForm.setValue(`windows.${index}.days_of_week`, next, { shouldValidate: true })
                          }
                        />
                      </FormField>
                      <FormField
                        error={ruleForm.formState.errors.windows?.[index]?.start_time?.message}
                        htmlFor={`rule-window-${index}-start`}
                        label="开始（含）"
                      >
                        <input
                          className={INPUT_CLASS}
                          id={`rule-window-${index}-start`}
                          type="time"
                          {...ruleForm.register(`windows.${index}.start_time`)}
                        />
                      </FormField>
                      <FormField
                        error={ruleForm.formState.errors.windows?.[index]?.end_time?.message}
                        htmlFor={`rule-window-${index}-end`}
                        label="结束（不含）"
                      >
                        <input
                          className={INPUT_CLASS}
                          id={`rule-window-${index}-end`}
                          type="time"
                          {...ruleForm.register(`windows.${index}.end_time`)}
                        />
                      </FormField>
                      <div className="flex items-end">
                        <button data-write-action
                          className="h-9 rounded px-2 text-[12px] text-ql-danger hover:bg-ql-danger-soft"
                          onClick={() => removeRuleWindow(index)}
                          type="button"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <FormField
              error={ruleForm.formState.errors.multiplier?.message}
              htmlFor="rule-multiplier"
              label="有效倍率（API 倍率模式 / 套餐扣减）"
            >
              <input className={INPUT_CLASS} id="rule-multiplier" {...ruleForm.register("multiplier")} />
            </FormField>
            <FormField
              error={ruleForm.formState.errors.cache_hit_price?.message}
              htmlFor="rule-cache-hit"
              label={`缓存命中输入单价（${ruleForm.watch("currency") ?? "CNY"}/百万 Token）`}
            >
              <input className={INPUT_CLASS} id="rule-cache-hit" placeholder="例如: 0.5" {...ruleForm.register("cache_hit_price")} />
              {ruleForm.watch("cache_hit_price") ? (
                <span className="mt-1 block text-[11px] font-mono text-ql-fg-tertiary">
                  换算单价：{toPerToken(ruleForm.watch("cache_hit_price"))} {ruleForm.watch("currency") ?? "CNY"}/Token
                </span>
              ) : null}
            </FormField>
            <FormField
              error={ruleForm.formState.errors.cache_miss_price?.message}
              htmlFor="rule-cache-miss"
              label={`未命中输入单价（${ruleForm.watch("currency") ?? "CNY"}/百万 Token）`}
            >
              <input className={INPUT_CLASS} id="rule-cache-miss" placeholder="例如: 1.0" {...ruleForm.register("cache_miss_price")} />
              {ruleForm.watch("cache_miss_price") ? (
                <span className="mt-1 block text-[11px] font-mono text-ql-fg-tertiary">
                  换算单价：{toPerToken(ruleForm.watch("cache_miss_price"))} {ruleForm.watch("currency") ?? "CNY"}/Token
                </span>
              ) : null}
            </FormField>
            <FormField
              error={ruleForm.formState.errors.output_price?.message}
              htmlFor="rule-output"
              label={`输出单价（${ruleForm.watch("currency") ?? "CNY"}/百万 Token）`}
            >
              <input className={INPUT_CLASS} id="rule-output" placeholder="例如: 2.0" {...ruleForm.register("output_price")} />
              {ruleForm.watch("output_price") ? (
                <span className="mt-1 block text-[11px] font-mono text-ql-fg-tertiary">
                  换算单价：{toPerToken(ruleForm.watch("output_price"))} {ruleForm.watch("currency") ?? "CNY"}/Token
                </span>
              ) : null}
            </FormField>
            <FormField
              error={ruleForm.formState.errors.priority?.message}
              htmlFor="rule-priority"
              label="计价优先级（小值优先）"
            >
              <input className={INPUT_CLASS} id="rule-priority" type="number" {...ruleForm.register("priority")} />
            </FormField>
            <PricingPreview values={ruleForm.watch()} />
            <div className="md:col-span-4">
              {model.queuedRules.map((rule, index) => <div key={index} className="mb-2 rounded border p-2 text-xs">
                {rule.rule_version} · {rule.upstream_model} · {rule.currency} · 命中 {rule.cache_hit_price || "—"} / 未命中 {rule.cache_miss_price || "—"} / 输出 {rule.output_price || "—"} ({rule.currency}/百万 Token) · 倍率 {rule.multiplier || "—"}
                <span className="block">{rule.windows.length ? rule.windows.map((window) => `${window.timezone} ${window.days_of_week || "每天"} ${window.start_time}–${window.end_time}`).join("；") : "全天"} · {rule.effective_from}</span>
                <button data-write-action type="button" className="ml-3 text-ql-action" onClick={() => {
                  const parsed = BillingRuleSchema.safeParse(ruleForm.getValues());
                  if (!parsed.success) { void ruleForm.trigger(); return; }
                  const current = parsed.data; ruleForm.reset(rule);
                  model.setQueuedRules(model.queuedRules.map((item, position) => position === index ? current : item));
                }}>编辑</button>
                <button type="button" className="ml-3 text-ql-danger" onClick={() => model.setQueuedRules(model.queuedRules.filter((_, position) => position !== index))}>移除</button>
              </div>)}
              <button type="button" className="text-ql-action" onClick={ruleForm.handleSubmit((values) => {
                model.setQueuedRules([...model.queuedRules, values]);
                ruleForm.setValue("rule_version", `${values.rule_version.slice(0, 50)}-next`);
              })}>加入规则集并配置下一时段</button>
            </div>
            <div className="md:col-span-4 flex justify-end gap-2">
              <button type="button" disabled={createRule.isPending}
                className="h-9 rounded-lg border border-ql-border px-4 text-[13px] disabled:opacity-60"
                onClick={() => {
                  setShowRuleForm(false);
                  ruleForm.reset({ rule_type: "API_PRICE", rule_version: "v1", provider_resource_id: "",
                    upstream_model: "", effective_from: localDateTimeValue(), effective_to: "", windows: [],
                    multiplier: "", pricing_mode: "ABSOLUTE", currency: "CNY", cache_hit_price: "",
                    cache_miss_price: "", output_price: "", priority: 100 });
                  model.routeForm.reset();
                  model.setSelectedRuleRouteId(""); model.setQueuedRules([]); model.setSourceRuleIds([]);
                  model.setReplaceExisting(false); model.setSubmissionId(crypto.randomUUID()); createRule.reset();
                }}>取消</button>
              <button data-write-action
                className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
                disabled={createRule.isPending}
                type="submit"
              >
                保存并启用
              </button>
            </div>
          </form>
        ) : null}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-ql-fg-secondary">厂商：</span>
              <select
                aria-label="筛选厂商"
                className="h-8 rounded-md border border-ql-border bg-ql-surface px-2 text-[12px] text-ql-fg focus:border-ql-action focus:outline-none"
                value={filterProvider}
                onChange={(e) => {
                  setFilterProvider(e.target.value);
                  setFilterModel("all");
                }}
              >
                <option key="all" value="all">全部厂商</option>
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-ql-fg-secondary">模型：</span>
              <select
                aria-label="筛选模型"
                className="h-8 rounded-md border border-ql-border bg-ql-surface px-2 text-[12px] text-ql-fg focus:border-ql-action focus:outline-none"
                value={filterModel}
                onChange={(e) => setFilterModel(e.target.value)}
              >
                <option key="all" value="all">全部模型</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-ql-fg-secondary">状态：</span>
              <select
                aria-label="筛选状态"
                className="h-8 rounded-md border border-ql-border bg-ql-surface px-2 text-[12px] text-ql-fg focus:border-ql-action focus:outline-none"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option key="all" value="all">全部状态</option>
                <option value="ACTIVE">生效中</option>
                <option value="PENDING">待生效</option>
                <option value="DISABLED">停用</option>
                <option value="EXPIRED">已到期</option>
                {model.showArchived ? <option value="ARCHIVED">已归档</option> : null}
              </select>
            </div>

            {isFiltered ? (
              <button
                type="button"
                onClick={resetFilters}
                className="h-8 rounded-md px-2.5 text-[12px] font-medium text-ql-action hover:bg-ql-action-soft"
              >
                重置筛选
              </button>
            ) : null}

            <div className="hidden h-5 w-px bg-ql-border-zone xl:block" />

            <ModelDisableAction model={model} inline />
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div data-testid="rule-count-summary" className="text-[12px] text-ql-fg-tertiary">
              {isFiltered ? (
                <span>显示 <strong className="font-mono text-ql-fg">{filteredRules.length}</strong> / 共 {rules.length} 条规则</span>
              ) : (
                <span>共 <strong className="font-mono text-ql-fg">{rules.length}</strong> 条规则</span>
              )}
            </div>

            <div className="flex items-center rounded-md border border-ql-border bg-ql-surface p-0.5 text-[12px]">
              <button
                type="button"
                aria-label="卡片聚合视图"
                className={`flex items-center gap-1 rounded px-2 py-1 font-medium transition-colors ${
                  viewMode === "card"
                    ? "bg-ql-action text-white"
                    : "text-ql-fg-secondary hover:text-ql-fg"
                }`}
                onClick={() => setViewMode("card")}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                <span>卡片聚合</span>
              </button>
              <button
                type="button"
                aria-label="明细表格视图"
                className={`flex items-center gap-1 rounded px-2 py-1 font-medium transition-colors ${
                  viewMode === "table"
                    ? "bg-ql-action text-white"
                    : "text-ql-fg-secondary hover:text-ql-fg"
                }`}
                onClick={() => setViewMode("table")}
              >
                <List className="h-3.5 w-3.5" />
                <span>明细列表</span>
              </button>
            </div>
          </div>
        </div>
        <p className="mb-3 text-[11px] text-ql-fg-tertiary">
          价格、倍率、时间窗和优先级属于规则版本，不可原地改写；变更时请新建
          rule_version，并用生效/失效时间完成切换。
        </p>
        <QueryGate
          emptyDescription="先登记厂商资源，再创建用于账本结算的计价规则模板。"
          emptyIcon={Gauge}
          emptyTitle="尚未配置计价规则"
          error={rulesQuery.error}
          isEmpty={rules.length === 0}
          isLoading={rulesQuery.isLoading}
          onRetry={() => void rulesQuery.refetch()}
        >
          {filteredRules.length === 0 ? (
            <div className="py-12 text-center text-[13px] text-ql-fg-tertiary">
              未找到符合筛选条件的计价规则
              {isFiltered ? (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="ml-2 text-ql-action underline hover:no-underline"
                >
                  清除筛选
                </button>
              ) : null}
            </div>
          ) : viewMode === "card" ? (
            <div className="space-y-4">
              {filteredGroups.map((group) => (
                <ModelRuleCard
                  key={group.id}
                  group={group}
                  onUpdateRule={(rule, patch) => updateRule.mutate({ rule, patch })}
                  onArchiveRule={(rule, archive) =>
                    archiveConfig.mutate({ kind: "rule", item: rule, archive })
                  }
                  onSetArchiveTarget={(target) => setArchiveTarget(target)}
                  onAddPeakWindow={handleAddPeakWindow}
                  onConfigureBaseRule={handleConfigureBaseRule}
                  onAdjustPricing={handleAdjustPricing}
                  isUpdating={updateRule.isPending || archiveConfig.isPending}
                />
              ))}
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-ql-border text-ql-fg-tertiary">
                  <th className="p-2 font-medium">版本</th>
                  <th className="p-2 font-medium">类型</th>
                  <th className="p-2 font-medium">上游模型</th>
                  <th className="p-2 font-medium">时段 [开始,结束)</th>
                  <th className="p-2 text-right font-medium">单价 / 倍率</th>
                  <th className="p-2 font-medium">状态</th>
                  <th className="p-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredRules.map((rule) => (
                  <tr className="border-b border-ql-border-zone last:border-b-0 hover:bg-ql-surface-subtle" key={rule.id}>
                    <td className="p-2 font-mono">{rule.rule_version}<span className="block text-ql-fg-tertiary">
                      {new Date(rule.effective_from).toLocaleString("zh-CN")} ～ {rule.effective_to ? new Date(rule.effective_to).toLocaleString("zh-CN") : "长期"}
                    </span></td>
                    <td className="p-2">{rule.rule_type}</td>
                    <td className="p-2">
                      <span className="font-medium text-ql-fg">{rule.upstream_model ?? "全部"}</span>
                      {rule.provider_resource_id && resourceMap.get(rule.provider_resource_id) ? (
                        <span className="block text-[11px] text-ql-fg-tertiary">
                          {resourceMap.get(rule.provider_resource_id)?.name}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2 font-mono">
                      {editableWindows(rule).length > 0
                        ? editableWindows(rule)
                            .map((window) =>
                              `${formatDaysOfWeek(parseDaysOfWeek(window.days_of_week))} ${window.timezone} ${window.start_time}–${window.end_time}`)
                            .join("；")
                        : "基础规则（全天）"}
                    </td>
                    <td className="p-2 text-right font-mono">
                      {rule.rule_type === "API_PRICE"
                        ? `${rule.currency}/百万 Token：命中 ${toPerMillion(rule.cache_hit_price) || "—"} / 未命中 ${toPerMillion(rule.cache_miss_price) || "—"} / 输出 ${toPerMillion(rule.output_price) || "—"}${rule.pricing_mode === "MULTIPLIER" ? ` × ${rule.multiplier}` : "（绝对价）"}`
                        : `×${rule.multiplier ?? "—"}`}
                    </td>
                    <td className="p-2">
                      <StatusTag tone={rule.enabled ? "neutral" : "warning"}>
                        {rule.archived_at ? "已归档" : !rule.enabled ? "停用" : new Date(rule.effective_from).getTime() > Date.now()
                          ? "待生效" : rule.effective_to && new Date(rule.effective_to).getTime() <= Date.now() ? "已到期" : "生效中"}
                      </StatusTag>
                    </td>
                    <td className="p-2 text-right whitespace-nowrap">
                      {rule.archived_at ? (
                        <button className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                          onClick={() => archiveConfig.mutate({ kind: "rule", item: rule, archive: false })}
                          type="button">取消归档</button>
                      ) : <>
                        <button data-write-action className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                          onClick={() => updateRule.mutate({ rule, patch: { enabled: !rule.enabled } })}
                          type="button">{rule.enabled ? "停用" : "启用"}</button>
                        {!rule.enabled ? <button className="rounded px-2 py-1 text-ql-fg-secondary hover:bg-ql-surface-muted"
                          onClick={() => setArchiveTarget({ kind: "rule", item: rule })}
                          type="button">归档</button> : null}
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryGate>
      </ManagementSection>


  </>;
}
