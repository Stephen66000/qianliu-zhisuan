import { useMemo, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { ApiError } from "../api/client";
import {
  useCreateEmployeeModelRule,
  useCreateEmployeeModelRuleVersion,
  useDisableEmployeeModelRule,
  useEmployeeModelRules,
  useEmployeeRuleCatalog,
  usePublishEmployeeModelRule,
  useUpdateEmployeeModelRule,
  useValidateEmployeeModelRule,
  type EmployeeModelRulePayload,
} from "../api/employee-model-rules";
import type {
  EmployeeModelRuleValidation,
  EmployeeModelRuleVersion,
  EmployeeModelTarget,
} from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { QueryGate } from "../components/states/QueryGate";
import { StatusTag } from "../components/dashboard/StatusTag";
import {
  formatIntegerAmountInput,
  IntegerAmountInput,
  normalizeIntegerAmountInput,
} from "../components/writes/IntegerAmountInput";

const INPUT = "h-10 w-full rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-sm focus:outline focus:outline-2 focus:outline-ql-action";
const BUTTON = "h-9 rounded-lg bg-ql-action px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50";

function localDateTime(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** POOL-035：厂商级额度草稿，quota_value 千分位字符串承载 bigint。 */
interface ProviderPoolDraft {
  quota_value: string;
  allow_overage: boolean;
  valid_until: string;
}

const initialForm = () => ({
  name: "",
  employeeScope: "SELECTED" as "SELECTED" | "ALL",
  principalIds: [] as string[],
  modelScope: "SELECTED" as "SELECTED" | "ALL",
  modelTargets: [] as EmployeeModelTarget[],
  quotaValue: "1000000",
  allowOverage: false,
  validFrom: localDateTime(new Date()),
  validUntil: "",
  /** POOL-035：按 provider_code 索引的厂商级额度；空对象表示回退版本级单值。 */
  poolQuotas: {} as Record<string, ProviderPoolDraft>,
});

function errorText(error: unknown): string | null {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;
}

function targetKey(target: EmployeeModelTarget): string {
  return `${target.unified_model_id}:${target.provider_resource_id}`;
}

function statusTone(status: EmployeeModelRuleVersion["status"]): "success" | "warning" | "neutral" {
  if (status === "PUBLISHED") return "success";
  if (status === "VALIDATED") return "warning";
  return "neutral";
}

/** POOL-035：额度摘要——有厂商级额度时按厂商展开，否则回退版本级单值。 */
function formatPoolQuotaSummary(
  rule: Pick<EmployeeModelRuleVersion, "quota_value" | "allow_overage" | "pool_quotas">,
  providerNameOf: (code: string) => string,
): string {
  const pools = rule.pool_quotas ?? [];
  if (pools.length > 0) {
    return pools.map((quota) =>
      `${providerNameOf(quota.provider_code)} ${formatIntegerAmountInput(quota.quota_value)} Token${quota.allow_overage ? "（可超额）" : ""}`,
    ).join(" / ");
  }
  return `${formatIntegerAmountInput(rule.quota_value)} Token${rule.allow_overage ? "（可超额）" : ""}`;
}

function PermissionChangeSummary({
  validation,
  providerNameOfResource,
}: {
  validation: EmployeeModelRuleValidation;
  /** POOL-035：按 provider_resource_id 反查厂商名，用于变更预览按厂商分组。 */
  providerNameOfResource: (resourceId: string) => string;
}) {
  const changes = validation.changes;
  if (!changes) return <>{validation.principal_count} 人 × {validation.model_count} 模型 = {validation.assignment_count} 项</>;
  const sections = [
    ["新增", changes.added],
    ["保留", changes.retained],
    ["撤销", changes.removed],
  ] as const;
  return <div>
    <span>{validation.principal_count} 人 × {validation.model_count} 模型 = {validation.assignment_count} 项</span>
    <details className="mt-1 text-xs text-ql-fg-tertiary">
      <summary className="cursor-pointer text-ql-action">新增 {changes.added.length} / 保留 {changes.retained.length} / 撤销 {changes.removed.length}</summary>
      <div className="mt-2 space-y-2">
        {sections.map(([label, items]) => {
          if (items.length === 0) return <div key={label}><strong>{label}</strong>：无</div>;
          // POOL-035：按厂商分组聚合，厂商标题后列该厂商的变更明细。
          const byProvider = new Map<string, typeof items>();
          for (const item of items) {
            const provider = providerNameOfResource(item.provider_resource_id);
            byProvider.set(provider, [...(byProvider.get(provider) ?? []), item]);
          }
          return <div key={label}><strong>{label}</strong>
            <div className="mt-1 space-y-1">{[...byProvider.entries()].map(([provider, providerItems]) => <div key={`${label}:${provider}`}>
              <span className="text-ql-fg-secondary">{provider}</span>
              <ul className="ml-4 list-disc">{providerItems.map((item) => <li key={`${label}:${item.principal_id}:${item.unified_model_id}:${item.provider_resource_id}`}>{item.principal_name} → {item.model_name}（{item.resource_name}）</li>)}</ul>
            </div>)}</div>
          </div>;
        })}
      </div>
    </details>
  </div>;
}

export function EmployeeModelRulesPage() {
  const catalog = useEmployeeRuleCatalog();
  const rules = useEmployeeModelRules();
  const createRule = useCreateEmployeeModelRule();
  const updateRule = useUpdateEmployeeModelRule();
  const validateRule = useValidateEmployeeModelRule();
  const publishRule = usePublishEmployeeModelRule();
  const disableRule = useDisableEmployeeModelRule();
  const createVersion = useCreateEmployeeModelRuleVersion();
  const [form, setForm] = useState(initialForm);
  const [editing, setEditing] = useState<EmployeeModelRuleVersion | null>(null);
  const [historyRuleId, setHistoryRuleId] = useState<string | null>(null);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  // POOL-033 §6：发布时显式选择池额度语义（SET=设为规则值 / ADD=锁内追加）。
  const [quotaMode, setQuotaMode] = useState<"SET" | "ADD">("SET");

  const employees = useMemo(() => (catalog.data?.principals ?? []).filter((item) =>
    `${item.name} ${item.department_label ?? ""}`.toLowerCase().includes(employeeSearch.toLowerCase())),
  [catalog.data?.principals, employeeSearch]);
  const models = useMemo(() => (catalog.data?.models ?? []).filter((item) =>
    `${item.provider_name} ${item.resource_name} ${item.display_name} ${item.alias} ${item.upstream_model}`
      .toLowerCase().includes(modelSearch.toLowerCase())), [catalog.data?.models, modelSearch]);
  const groupedModels = useMemo(() => {
    const grouped = new Map<string, typeof models>();
    for (const item of models) grouped.set(item.provider_name, [...(grouped.get(item.provider_name) ?? []), item]);
    return grouped;
  }, [models]);
  // POOL-035：当前规则涉及哪些厂商（按 provider_code 去重，保留展示名）。ALL 时取全部就绪模型厂商。
  const selectedProviders = useMemo(() => {
    const byResource = new Map((catalog.data?.models ?? []).map((item) => [item.provider_resource_id, item]));
    const sources = form.modelScope === "ALL"
      ? (catalog.data?.models ?? []).filter((item) => item.ready)
      : form.modelTargets.map((target) => byResource.get(target.provider_resource_id)).filter(Boolean);
    const seen = new Map<string, string>();
    for (const item of sources) seen.set(item!.provider_code, item!.provider_name);
    return [...seen.entries()].map(([code, name]) => ({ code, name }));
  }, [catalog.data?.models, form.modelScope, form.modelTargets]);
  // POOL-035：provider_code → 展示名（用于额度摘要）；catalog 缺失时回退大写 code。
  const providerNameOf = (code: string): string =>
    (catalog.data?.models ?? []).find((item) => item.provider_code === code)?.provider_name ?? code.toUpperCase();
  // POOL-035：provider_resource_id → 厂商展示名（用于变更预览按厂商分组）。
  const providerNameOfResource = (resourceId: string): string =>
    (catalog.data?.models ?? []).find((item) => item.provider_resource_id === resourceId)?.provider_name ?? "未知厂商";
  const latestRules = useMemo(() => {
    const latest = new Map<string, EmployeeModelRuleVersion>();
    for (const rule of rules.data?.rules ?? []) {
      const current = latest.get(rule.rule_id);
      if (!current || current.version < rule.version) latest.set(rule.rule_id, rule);
    }
    return [...latest.values()];
  }, [rules.data?.rules]);
  const historyVersions = useMemo(() => (rules.data?.rules ?? [])
    .filter((rule) => rule.rule_id === historyRuleId)
    .sort((left, right) => right.version - left.version), [historyRuleId, rules.data?.rules]);

  const mutationError = [createRule.error, updateRule.error, validateRule.error, publishRule.error,
    disableRule.error, createVersion.error].map(errorText).find(Boolean) ?? null;

  const toggleEmployee = (id: string) => setForm((old) => ({ ...old,
    principalIds: old.principalIds.includes(id) ? old.principalIds.filter((item) => item !== id) : [...old.principalIds, id],
  }));
  const toggleModel = (target: EmployeeModelTarget) => setForm((old) => ({ ...old,
    modelTargets: old.modelTargets.some((item) => targetKey(item) === targetKey(target))
      ? old.modelTargets.filter((item) => targetKey(item) !== targetKey(target))
      : [...old.modelTargets, target],
  }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const payload: EmployeeModelRulePayload = {
      name: form.name,
      employee_scope: form.employeeScope,
      principal_ids: form.employeeScope === "ALL" ? [] : form.principalIds,
      model_scope: form.modelScope,
      model_targets: form.modelScope === "ALL" ? [] : form.modelTargets,
      quota_value: form.quotaValue,
      allow_overage: form.allowOverage,
      valid_from: new Date(form.validFrom).toISOString(),
      valid_until: form.validUntil ? new Date(form.validUntil).toISOString() : null,
      // POOL-035：厂商级额度——千分位转纯数字，valid_until 转 ISO；空草稿对象发空数组（回退版本级）。
      pool_quotas: Object.entries(form.poolQuotas).map(([providerCode, draft]) => ({
        provider_code: providerCode,
        quota_value: normalizeIntegerAmountInput(draft.quota_value),
        allow_overage: draft.allow_overage,
        valid_until: draft.valid_until ? new Date(draft.valid_until).toISOString() : null,
      })),
    };
    const done = () => { setForm(initialForm()); setEditing(null); };
    if (editing) updateRule.mutate({ versionId: editing.id, expectedLockVersion: editing.lock_version, rule: payload }, { onSuccess: done });
    else createRule.mutate(payload, { onSuccess: done });
  };

  const edit = (rule: EmployeeModelRuleVersion) => {
    setEditing(rule);
    setForm({
      name: rule.name, employeeScope: rule.employee_scope, principalIds: rule.principal_ids,
      modelScope: rule.model_scope, modelTargets: rule.model_targets, quotaValue: rule.quota_value,
      allowOverage: rule.allow_overage, validFrom: localDateTime(new Date(rule.valid_from)),
      validUntil: rule.valid_until ? localDateTime(new Date(rule.valid_until)) : "",
      // POOL-035：回填厂商级额度；旧版本无 pool_quotas 时为空对象（回退版本级单值）。
      poolQuotas: Object.fromEntries((rule.pool_quotas ?? []).map((quota) => [quota.provider_code, {
        quota_value: normalizeIntegerAmountInput(quota.quota_value),
        allow_overage: quota.allow_overage,
        valid_until: quota.valid_until ? localDateTime(new Date(quota.valid_until)) : "",
      }])),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <PageShell title="批量模型授权" description="多名员工的模型授权辅助入口；集中选择员工、模型与额度，校验通过后显式发布，原子更新 Key 权限和 Grant。单名员工请在「使用主体」开通">
      {mutationError ? <p className="mb-4 rounded-lg bg-ql-danger-soft px-3 py-2 text-sm text-ql-danger" role="alert">{mutationError}</p> : null}
      <form className="mb-6 rounded-xl border border-ql-border p-5" onSubmit={submit}>
        <div className="mb-4 flex items-center justify-between">
          <div><h2 className="font-semibold">{editing ? `编辑 ${editing.name} v${editing.version}` : "新建批量授权规则"}</h2><p className="mt-1 text-xs text-ql-fg-tertiary">保存只形成草稿，不会扩大任何员工权限。</p></div>
          {editing ? <button className="text-sm text-ql-action" onClick={() => { setEditing(null); setForm(initialForm()); }} type="button">取消编辑</button> : null}
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <label className="text-sm">规则名称<input className={`${INPUT} mt-1`} onChange={(event) => setForm((old) => ({ ...old, name: event.target.value }))} required value={form.name} /></label>
          <label className="text-sm" htmlFor="employee-rule-quota">Token 额度<IntegerAmountInput className={`${INPUT} mt-1`} id="employee-rule-quota" onChange={(quotaValue) => setForm((old) => ({ ...old, quotaValue }))} value={form.quotaValue} /></label>
          <label className="text-sm">生效时间<input className={`${INPUT} mt-1`} onChange={(event) => setForm((old) => ({ ...old, validFrom: event.target.value }))} required type="datetime-local" value={form.validFrom} /></label>
          <label className="text-sm">失效时间（可选）<input className={`${INPUT} mt-1`} onChange={(event) => setForm((old) => ({ ...old, validUntil: event.target.value }))} type="datetime-local" value={form.validUntil} /></label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm"><input checked={form.allowOverage} onChange={(event) => setForm((old) => ({ ...old, allowOverage: event.target.checked }))} type="checkbox" />允许超额使用</label>

        {/* POOL-035：厂商级额度——勾选某厂商型号后展开该厂商额度输入；未填厂商回退上方版本级 Token 额度。 */}
        {selectedProviders.length > 0 ? (
          <div className="mt-4 rounded-xl border border-ql-border p-4">
            <legend className="px-2 text-sm font-semibold">厂商级池额度（可选）</legend>
            <p className="mb-3 mt-1 text-xs text-ql-fg-tertiary">为每个厂商单独设置池额度；未填或留空的厂商回退上方版本级 Token 额度。</p>
            <div className="space-y-3">
              {selectedProviders.map((provider) => {
                const draft = form.poolQuotas[provider.code];
                return (
                  <div className="grid items-end gap-3 rounded-lg border border-ql-border-zone p-3 md:grid-cols-12" key={provider.code}>
                    <div className="text-sm font-medium md:col-span-2">{provider.name}</div>
                    <label className="text-xs md:col-span-4">池额度<IntegerAmountInput className={`${INPUT} mt-1`} id={`pool-quota-${provider.code}`} onChange={(quotaValue) => setForm((old) => ({ ...old, poolQuotas: { ...old.poolQuotas, [provider.code]: { quota_value: quotaValue, allow_overage: draft?.allow_overage ?? false, valid_until: draft?.valid_until ?? "" } } }))} value={draft?.quota_value ?? ""} /></label>
                    <label className="flex items-center gap-2 text-xs md:col-span-2"><input checked={draft?.allow_overage ?? false} onChange={(event) => setForm((old) => ({ ...old, poolQuotas: { ...old.poolQuotas, [provider.code]: { quota_value: draft?.quota_value ?? "", allow_overage: event.target.checked, valid_until: draft?.valid_until ?? "" } } }))} type="checkbox" />允许超额</label>
                    <label className="text-xs md:col-span-4">池失效时间（可选）<input className={`${INPUT} mt-1`} aria-label={`${provider.name} 池失效时间`} onChange={(event) => setForm((old) => ({ ...old, poolQuotas: { ...old.poolQuotas, [provider.code]: { quota_value: draft?.quota_value ?? "", allow_overage: draft?.allow_overage ?? false, valid_until: event.target.value } } }))} type="datetime-local" value={draft?.valid_until ?? ""} /></label>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <fieldset className="rounded-xl border border-ql-border p-4">
            <legend className="px-2 text-sm font-semibold">员工范围</legend>
            <div className="mb-3 flex gap-4 text-sm"><label><input checked={form.employeeScope === "SELECTED"} onChange={() => setForm((old) => ({ ...old, employeeScope: "SELECTED" }))} type="radio" /> 指定员工</label><label><input checked={form.employeeScope === "ALL"} onChange={() => setForm((old) => ({ ...old, employeeScope: "ALL" }))} type="radio" /> 当前全部员工</label></div>
            <input className={INPUT} onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="搜索员工或部门" value={employeeSearch} />
            <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">
              {employees.map((employee) => <label className={`flex items-start gap-2 rounded-lg p-2 text-sm ${employee.ready ? "hover:bg-ql-surface-subtle" : "text-ql-fg-tertiary"}`} key={employee.id}>
                <input checked={form.employeeScope === "ALL" || form.principalIds.includes(employee.id)} disabled={form.employeeScope === "ALL" || !employee.ready} onChange={() => toggleEmployee(employee.id)} type="checkbox" />
                <span>{employee.name}{employee.department_label ? ` · ${employee.department_label}` : ""}{employee.unavailable_reason ? <small className="block text-ql-danger">{employee.unavailable_reason}</small> : null}</span>
              </label>)}
            </div>
          </fieldset>

          <fieldset className="rounded-xl border border-ql-border p-4">
            <legend className="px-2 text-sm font-semibold">模型范围</legend>
            <div className="mb-3 flex gap-4 text-sm"><label><input checked={form.modelScope === "SELECTED"} onChange={() => setForm((old) => ({ ...old, modelScope: "SELECTED" }))} type="radio" /> 指定模型</label><label><input checked={form.modelScope === "ALL"} onChange={() => setForm((old) => ({ ...old, modelScope: "ALL" }))} type="radio" /> 当前全部就绪模型</label></div>
            <input className={INPUT} onChange={(event) => setModelSearch(event.target.value)} placeholder="搜索厂商、资源或模型" value={modelSearch} />
            <div className="mt-3 max-h-56 space-y-3 overflow-y-auto">
              {[...groupedModels.entries()].map(([provider, items]) => <div key={provider}><h3 className="text-xs font-semibold text-ql-fg-tertiary">{provider}</h3>{items.map((model) => {
                const target = { unified_model_id: model.unified_model_id, provider_resource_id: model.provider_resource_id };
                return <label className={`mt-1 flex items-start gap-2 rounded-lg p-2 text-sm ${model.ready ? "hover:bg-ql-surface-subtle" : "text-ql-fg-tertiary"}`} key={targetKey(target)}>
                  <input checked={(form.modelScope === "ALL" && model.ready) || form.modelTargets.some((item) => targetKey(item) === targetKey(target))} disabled={form.modelScope === "ALL" || !model.ready} onChange={() => toggleModel(target)} type="checkbox" />
                  <span>{model.display_name} · {model.resource_name}<small className="block">{model.upstream_model} · {model.mode}</small>{model.unavailable_reasons.length ? <small className="block text-ql-danger">{model.unavailable_reasons.join("；")}</small> : null}</span>
                </label>;
              })}</div>)}
            </div>
          </fieldset>
        </div>
        <div className="mt-4 flex justify-end"><button className={BUTTON} disabled={createRule.isPending || updateRule.isPending} type="submit">{editing ? "保存草稿" : "创建草稿"}</button></div>
      </form>

      <QueryGate emptyDescription="先创建草稿，校验就绪后再发布。" emptyIcon={ShieldCheck} emptyTitle="暂无批量授权规则" error={rules.error ?? catalog.error} isEmpty={latestRules.length === 0} isLoading={rules.isLoading || catalog.isLoading} onRetry={() => { void rules.refetch(); void catalog.refetch(); }}>
        <div className="overflow-x-auto rounded-xl border border-ql-border">
          <table className="w-full text-left text-sm"><thead><tr className="border-b border-ql-border text-xs text-ql-fg-tertiary"><th className="p-3">规则/版本</th><th className="p-3">范围</th><th className="p-3">额度</th><th className="p-3">状态</th><th className="p-3">就绪结果</th><th className="p-3">操作</th></tr></thead>
            <tbody>{latestRules.map((rule) => <tr className="border-b border-ql-border-zone last:border-0" key={rule.id}>
              <td className="p-3 font-medium">{rule.name}<small className="block text-ql-fg-tertiary">v{rule.version}</small></td>
              <td className="p-3">{rule.employee_scope === "ALL" ? "当前全部员工" : `${rule.principal_ids.length} 名员工`} / {rule.model_scope === "ALL" ? "当前全部就绪模型" : `${rule.model_targets.length} 个模型`}</td>
              <td className="p-3">{formatPoolQuotaSummary(rule, providerNameOf)}</td>
              <td className="p-3"><StatusTag tone={statusTone(rule.status)}>{rule.status}</StatusTag></td>
              <td className="p-3">{rule.validation_snapshot ? rule.validation_snapshot.ready ? <PermissionChangeSummary validation={rule.validation_snapshot} providerNameOfResource={providerNameOfResource} /> : rule.validation_snapshot.issues.map((issue) => issue.message).join("；") : "尚未校验"}</td>
              <td className="p-3"><div className="flex flex-wrap gap-3 whitespace-nowrap">
                <button className="text-ql-action" onClick={() => setHistoryRuleId(rule.rule_id)} type="button">历史</button>
                {rule.status === "DRAFT" || rule.status === "VALIDATED" ? <button className="text-ql-action" onClick={() => edit(rule)} type="button">编辑</button> : null}
                {rule.status === "DRAFT" || rule.status === "VALIDATED" ? <button className="text-ql-action" onClick={() => validateRule.mutate(rule.id)} type="button">校验</button> : null}
                {rule.status === "VALIDATED" ? <span className="inline-flex items-center gap-2">
                  <select
                    aria-label="池额度方式"
                    className="text-ql-fg"
                    onChange={(event) => setQuotaMode(event.target.value as "SET" | "ADD")}
                    value={quotaMode}
                  >
                    <option value="SET">设置总额度</option>
                    <option value="ADD">追加额度</option>
                  </select>
                  <button className="text-ql-action" onClick={() => publishRule.mutate({ versionId: rule.id, expectedLockVersion: rule.lock_version, idempotencyKey: crypto.randomUUID(), quotaMode })} type="button">发布</button>
                </span> : null}
                {rule.status === "PUBLISHED" ? <><button className="text-ql-action" onClick={() => createVersion.mutate(rule.rule_id)} type="button">新建版本</button><button className="text-ql-danger" onClick={() => disableRule.mutate(rule.id)} type="button">停用</button></> : null}
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
        {historyRuleId ? <section className="mt-4 rounded-xl border border-ql-border p-4" aria-label="规则版本历史">
          <div className="flex items-center justify-between"><h2 className="font-semibold">规则版本历史</h2><button className="text-sm text-ql-action" onClick={() => setHistoryRuleId(null)} type="button">关闭</button></div>
          <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-ql-border text-xs text-ql-fg-tertiary"><th className="p-2">版本</th><th className="p-2">状态</th><th className="p-2">员工/模型范围</th><th className="p-2">额度</th><th className="p-2">发布时间</th><th className="p-2">停用时间</th></tr></thead><tbody>{historyVersions.map((version) => <tr className="border-b border-ql-border-zone last:border-0" key={version.id}><td className="p-2">v{version.version}</td><td className="p-2"><StatusTag tone={statusTone(version.status)}>{version.status}</StatusTag></td><td className="p-2">{version.employee_scope === "ALL" ? "当前全部员工" : `${version.principal_ids.length} 名员工`} / {version.model_scope === "ALL" ? "当前全部就绪模型" : `${version.model_targets.length} 个模型`}</td><td className="p-2">{formatPoolQuotaSummary(version, providerNameOf)}</td><td className="p-2">{version.published_at ? new Date(version.published_at).toLocaleString() : "—"}</td><td className="p-2">{version.disabled_at ? new Date(version.disabled_at).toLocaleString() : "—"}</td></tr>)}</tbody></table></div>
        </section> : null}
      </QueryGate>
    </PageShell>
  );
}
