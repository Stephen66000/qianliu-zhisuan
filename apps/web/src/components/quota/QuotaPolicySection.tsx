import { Gauge } from "lucide-react";
import { ManagementSection } from "./ManagementSection";
import { QueryGate } from "../states/QueryGate";
import { StatusTag } from "../dashboard/StatusTag";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { PrincipalScopeField, principalScopeText } from "./PrincipalScopeField";
import { WeekdayPicker, formatDaysOfWeek } from "./WeekdayPicker";
import { formatLifecycle } from "../../pages/quota-rule-contract";
import type { QuotaRulesPageModel } from "../../pages/quota-rules-page-model";

export function QuotaPolicySection({ model }: { model: QuotaRulesPageModel }) {
  const { models, resources, showPolicyForm, setShowPolicyForm, editingPolicy, setEditingPolicy, policyForm, selectedPolicyAction, principalScopeMode, selectedPrincipalIds, principals, principalSearch, setPrincipalSearch, createPolicy, policies, editPolicy, setPolicyActionTarget, transitionPolicy, principalById, policiesQuery } = model;
  return <>
      <ManagementSection
        actionLabel="新建调度策略"
        hint="选择已配置计价的模型与资源，校验并发布后参与调度。"
        onAction={() => {
          setEditingPolicy(null);
          policyForm.reset();
          setShowPolicyForm((value) => !value);
        }}
        title="调度策略"
      >
        {showPolicyForm ? (
          <form
            className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-4 md:grid-cols-4"
            onSubmit={policyForm.handleSubmit((values) => createPolicy.mutate(values))}
          >
            <FormField
              error={policyForm.formState.errors.policy_version?.message}
              htmlFor="policy-version"
              label="策略版本"
            >
              <input className={INPUT_CLASS} id="policy-version" {...policyForm.register("policy_version")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.priority?.message}
              htmlFor="policy-priority"
              label="优先级（小值优先）"
            >
              <input className={INPUT_CLASS} id="policy-priority" type="number" {...policyForm.register("priority")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_unified_model?.message}
              htmlFor="policy-model"
              label="统一模型"
            >
              <select className={INPUT_CLASS} id="policy-model" {...policyForm.register("match_unified_model")}>
                <option value="">不限模型</option>
                {models.filter((model) => !model.archived_at).map((item) => (
                  <option key={item.id} value={item.alias} disabled={!model.readyRoutes.some((route) => route.alias === item.alias)}>
                    {item.display_name}（{item.alias}）{model.readyRoutes.some((route) => route.alias === item.alias) ? "" : " · 路由或计价未就绪"}</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_provider_resource_id?.message}
              htmlFor="policy-resource"
              label="厂商资源"
            >
              <select
                className={INPUT_CLASS}
                id="policy-resource"
                {...policyForm.register("match_provider_resource_id")}
              >
                <option value="">不限资源</option>
                {resources.map((resource) => (
                  <option key={resource.id} value={resource.id} disabled={!model.readyRoutes.some((route) => route.provider_resource_id === resource.id
                    && (!policyForm.watch("match_unified_model") || route.alias === policyForm.watch("match_unified_model")))}>{resource.name}</option>
                ))}
              </select>
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_resource_mode?.message}
              htmlFor="policy-mode"
              label="资源模式"
            >
              <select className={INPUT_CLASS} id="policy-mode" {...policyForm.register("match_resource_mode")}>
                <option value="">不限模式</option>
                <option value="API">API</option>
                <option value="CODING_PLAN">套餐</option>
              </select>
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_timezone?.message}
              htmlFor="policy-timezone"
              label="IANA 时区"
            >
              <input className={INPUT_CLASS} id="policy-timezone" {...policyForm.register("match_timezone")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_days_of_week?.message}
              htmlFor="policy-days"
              label="星期"
            >
              <WeekdayPicker
                value={policyForm.watch("match_days_of_week") ?? ""}
                onChange={(next) => policyForm.setValue("match_days_of_week", next, { shouldValidate: true })}
              />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_start_time?.message}
              htmlFor="policy-start"
              label="开始（含）"
            >
              <input className={INPUT_CLASS} id="policy-start" type="time" {...policyForm.register("match_start_time")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_end_time?.message}
              htmlFor="policy-end"
              label="结束（不含）"
            >
              <input className={INPUT_CLASS} id="policy-end" type="time" {...policyForm.register("match_end_time")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.action?.message}
              htmlFor="policy-action"
              label="动作"
            >
              <select className={INPUT_CLASS} id="policy-action" {...policyForm.register("action")}>
                <option value="REJECT">REJECT（硬拒绝）</option>
                <option value="SWITCH">SWITCH（切换）</option>
                <option value="RATE_LIMIT">RATE_LIMIT（限流）</option>
                <option value="ALLOW">ALLOW（允许）</option>
                <option value="ALLOW_OVERAGE">ALLOW_OVERAGE（允许超额）</option>
              </select>
            </FormField>
            {selectedPolicyAction === "SWITCH" ? (
              <FormField
                error={policyForm.formState.errors.switch_equivalent_group?.message}
                hint="至少两个资源 ID，用英文逗号分隔"
                htmlFor="policy-switch-group"
                label="等价资源组"
              >
                <input className={INPUT_CLASS} id="policy-switch-group" {...policyForm.register("switch_equivalent_group")} />
              </FormField>
            ) : null}
            {selectedPolicyAction === "RATE_LIMIT" ? (
              <FormField
                error={policyForm.formState.errors.rate_limit_per_minute?.message}
                htmlFor="policy-rate-limit"
                label="每分钟请求数"
              >
                <input
                  className={INPUT_CLASS}
                  id="policy-rate-limit"
                  inputMode="numeric"
                  {...policyForm.register("rate_limit_per_minute")}
                />
              </FormField>
            ) : null}
            <FormField
              error={policyForm.formState.errors.match_price_multiplier_min?.message}
              htmlFor="policy-price-multiplier"
              label="最低价格倍率（可空）"
            >
              <input className={INPUT_CLASS} id="policy-price-multiplier" {...policyForm.register("match_price_multiplier_min")} />
            </FormField>
            <FormField
              error={policyForm.formState.errors.match_remaining_quota_ratio_max?.message}
              htmlFor="policy-quota-ratio"
              label="最大剩余额度比例（可空）"
            >
              <input className={INPUT_CLASS} id="policy-quota-ratio" {...policyForm.register("match_remaining_quota_ratio_max")} />
            </FormField>
            <PrincipalScopeField
              error={policyForm.formState.errors.match_principal_scope?.message}
              mode={principalScopeMode}
              onModeChange={(mode) => {
                policyForm.setValue("match_principal_scope_mode", mode, { shouldValidate: true });
                policyForm.setValue("match_principal_scope", [], { shouldValidate: true });
              }}
              onSearch={setPrincipalSearch}
              onSelectedIdsChange={(ids) =>
                policyForm.setValue("match_principal_scope", ids, { shouldValidate: true })
              }
              principals={principals}
              search={principalSearch}
              selectedIds={selectedPrincipalIds}
            />
            <label className="flex items-center gap-2 self-end pb-2 text-[12px] text-ql-fg">
              <input type="checkbox" {...policyForm.register("match_forecast_exhaust_risk")} />
              仅预计耗尽时命中
            </label>
            <FormField
              error={policyForm.formState.errors.description?.message}
              htmlFor="policy-description"
              label="说明"
            >
              <input className={INPUT_CLASS} id="policy-description" {...policyForm.register("description")} />
            </FormField>
            <div className="md:col-span-4 flex justify-end gap-2">
              <button type="button" disabled={createPolicy.isPending}
                className="h-9 rounded-lg border border-ql-border px-4 text-[13px] disabled:opacity-60"
                onClick={() => {
                  setShowPolicyForm(false); setEditingPolicy(null); policyForm.reset();
                  setPrincipalSearch(""); createPolicy.reset();
                }}>取消</button>
              <button
                className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
                disabled={createPolicy.isPending}
                type="submit"
              >
                {editingPolicy ? "保存草稿" : "创建草稿"}
              </button>
            </div>
          </form>
        ) : null}
        <p className="mb-3 text-[11px] leading-5 text-ql-fg-tertiary">
          生命周期：草稿 → 校验通过 → 发布 → 停用。只有已发布策略进入 Gateway 热路径；
          调度先于计价执行，REJECT 不进入上游、Attempt、Usage 或计量。调度优先级与计价优先级分别只在各自体系内比较。
        </p>
        <QueryGate
          emptyDescription="创建策略草稿，校验引用后再发布；未发布策略不会影响请求。"
          emptyIcon={Gauge}
          emptyTitle="尚未配置调度策略"
          error={policiesQuery.error}
          isEmpty={policies.length === 0}
          isLoading={policiesQuery.isLoading}
          onRetry={() => void policiesQuery.refetch()}
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-ql-border text-ql-fg-tertiary">
                  <th className="p-2 font-medium">版本</th>
                  <th className="p-2 font-medium">模型 / 资源</th>
                  <th className="p-2 font-medium">时段</th>
                  <th className="p-2 font-medium">动作</th>
                  <th className="p-2 font-medium">主体范围</th>
                  <th className="p-2 text-right font-medium">优先级</th>
                  <th className="p-2 font-medium">状态</th>
                  <th className="p-2 font-medium">时间线 / 操作人</th>
                  <th className="p-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr className="border-b border-ql-border-zone last:border-b-0" key={policy.id}>
                    <td className="p-2 font-mono">{policy.policyVersion}</td>
                    <td className="p-2">
                      {policy.matchUnifiedModel ?? "全部模型"}
                      <span className="block text-ql-fg-tertiary">
                        {resources.find((resource) => resource.id === policy.matchProviderResourceId)?.name
                          ?? (policy.matchProviderResourceId ? "指定资源" : "全部资源")}
                      </span>
                    </td>
                    <td className="p-2 font-mono">
                      {policy.matchTimezone && policy.matchStartTime && policy.matchEndTime
                        ? `${formatDaysOfWeek(policy.matchDaysOfWeek)} ${policy.matchTimezone} ${policy.matchStartTime}–${policy.matchEndTime}`
                        : "全天"}
                    </td>
                    <td className="p-2 font-mono">{policy.action}</td>
                    <td className="p-2">
                      {principalScopeText(policy.matchPrincipalScope, principalById)}
                    </td>
                    <td className="p-2 text-right">{policy.priority}</td>
                    <td className="p-2">
                      <StatusTag tone={policy.status === "PUBLISHED" ? "neutral" : "warning"}>
                        {policy.archivedAt ? "已存档" : policy.status}
                      </StatusTag>
                    </td>
                    <td className="min-w-64 p-2 text-[11px] leading-5 text-ql-fg-tertiary">
                      <span className="block">创建 {formatLifecycle(policy.createdAt, policy.createdByAdminId)}</span>
                      {policy.validatedAt ? <span className="block">校验 {formatLifecycle(policy.validatedAt, policy.validatedByAdminId)}</span> : null}
                      {policy.publishedAt ? <span className="block">发布 {formatLifecycle(policy.publishedAt, policy.publishedByAdminId)}</span> : null}
                      {policy.effectiveAt ? <span className="block">生效 {formatLifecycle(policy.effectiveAt, policy.publishedByAdminId)}</span> : null}
                      {policy.retiredAt ? <span className="block">停用 {formatLifecycle(policy.retiredAt, policy.retiredByAdminId)}</span> : null}
                    </td>
                    <td className="p-2 text-right">
                      {policy.status === "DRAFT" ? (
                        <>
                          <button
                            className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                            onClick={() => editPolicy(policy)}
                            type="button"
                          >
                            编辑
                          </button>
                          <button
                            className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                            onClick={() => transitionPolicy.mutate({ policy, action: "validate" })}
                            type="button"
                          >
                            校验
                          </button>
                        </>
                      ) : null}
                      {policy.status === "VALIDATED" ? (
                        <button
                          className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                          onClick={() => setPolicyActionTarget({ policy, action: "publish" })}
                          type="button"
                        >
                          发布
                        </button>
                      ) : null}
                      {policy.status === "PUBLISHED" ? (
                        <button
                          className="rounded px-2 py-1 text-ql-danger hover:bg-ql-danger-soft"
                          onClick={() => setPolicyActionTarget({ policy, action: "retire" })}
                          type="button"
                        >
                          停用
                        </button>
                      ) : null}
                      {policy.status === "RETIRED" ? (
                        <>
                          {!policy.archivedAt ? <button type="button" className="rounded px-2 py-1 text-ql-action"
                            onClick={() => setPolicyActionTarget({ policy, action: "archive" })}>存档</button> : null}
                          <button
                            className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                            onClick={() => setPolicyActionTarget({ policy, action: "restore" })}
                            type="button"
                          >
                            恢复原配置
                          </button>
                          <button
                            className="rounded px-2 py-1 text-ql-action hover:bg-ql-action-soft"
                            onClick={() => transitionPolicy.mutate({ policy, action: "copy" })}
                            type="button"
                          >
                            复制为新版本
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryGate>
      </ManagementSection>


  </>;
}
