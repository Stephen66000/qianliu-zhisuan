import { SyncModelsPanel } from "./ResourceModelDiscovery";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { IntegerAmountInput } from "../writes/IntegerAmountInput";
import { MoneyAmountInput } from "../writes/MoneyAmountInput";
import { formatCount, formatDateTimeFull, formatMoney } from "../../lib/format";
import { MONEY_OPERATING_KEYS, RESET_CYCLE_LABELS, operatingFieldsForMode, operatingMoneyError, planDraftError } from "./resource-form-contract";
import type { ResourcesPageModel } from "../../pages/resources-page-model";

function ReadOnlyMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2">
      <p className="text-[11px] text-ql-fg-tertiary">{label}</p>
      <p className="mt-1 font-mono text-[13px] text-ql-fg">{value}</p>
    </div>
  );
}

export function ResourceDialogs({ model }: { model: ResourcesPageModel }) {
  const { editTarget, setEditTarget, syncTarget, setSyncTarget, operatingTarget, setOperatingTarget, operatingDraft, setOperatingDraft, operatingValidationError, setOperatingValidationError, operatingHistory, operatingMutation, editMutation, editRegister, handleEditSubmit, editReset, editErrors } = model;
  return <>
      {editTarget ? (
        <form
          className="mb-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={handleEditSubmit((values) =>
            editMutation.mutate({ target: editTarget, values })
          )}
        >
          <div className="mb-3">
            <h2 className="text-[14px] font-semibold text-ql-fg">编辑厂商资源</h2>
            <p className="mt-1 text-[12px] text-ql-fg-tertiary">
              厂商、模式和凭证类型不可原地修改；凭证轮换使用独立恢复流程。
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField error={editErrors.name?.message} htmlFor="edit-resource-name" label="资源名称">
              <input className={INPUT_CLASS} id="edit-resource-name" {...editRegister("name")} />
            </FormField>
            <FormField
              error={editErrors.concurrency_limit?.message}
              hint="该资源允许同时访问上游的请求数，例如 5；超出后短暂等待"
              htmlFor="edit-resource-concurrency"
              label="并发上限"
            >
              <input
                className={INPUT_CLASS}
                id="edit-resource-concurrency"
                inputMode="numeric"
                {...editRegister("concurrency_limit")}
              />
            </FormField>
          </div>
          {editMutation.error ? (
            <p className="mt-3 text-[13px] text-ql-danger" role="alert">
              {editMutation.error.message}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[13px]"
              onClick={() => {
                setEditTarget(null);
                editReset();
              }}
              type="button"
            >
              取消
            </button>
            <button
              className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
              disabled={editMutation.isPending}
              type="submit"
            >
              {editMutation.isPending ? "保存中…" : "保存修改"}
            </button>
          </div>
        </form>
      ) : null}

      {syncTarget ? <SyncModelsPanel onClose={() => setSyncTarget(null)} target={syncTarget} /> : null}

      {operatingTarget ? (
        <form
          className="mb-5 rounded-xl border border-ql-border bg-ql-surface-subtle p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const validationError = operatingMoneyError(operatingDraft) ??
              (operatingTarget.mode === "CODING_PLAN" ? planDraftError(operatingDraft) : null);
            if (validationError) {
              setOperatingValidationError(validationError);
              return;
            }
            setOperatingValidationError("");
            operatingMutation.mutate(operatingTarget);
          }}
        >
          <h2 className="text-[14px] font-semibold text-ql-fg">
            更新「{operatingTarget.name}」经营数据
          </h2>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">
            只需维护当前订阅额度和重置规则；系统根据当前周期账本自动统计已用、剩余与下一重置日期。
            保存后立即作为当前订阅周期配置，历史修改记录和旧账本继续保留。
          </p>
          {operatingTarget.mode === "CODING_PLAN" ? (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ReadOnlyMetric
                label="系统已用额度"
                value={operatingTarget.operating_snapshot?.used_quota
                  ? formatCount(operatingTarget.operating_snapshot.used_quota)
                  : "未知"}
              />
              <ReadOnlyMetric
                label="系统剩余额度"
                value={operatingTarget.operating_snapshot?.remaining_quota
                  ? formatCount(operatingTarget.operating_snapshot.remaining_quota)
                  : "未知"}
              />
              <ReadOnlyMetric
                label="下一次重置日期"
                value={operatingTarget.operating_snapshot?.next_reset_at
                  ? formatDateTimeFull(operatingTarget.operating_snapshot.next_reset_at)
                  : "不重置"}
              />
            </div>
          ) : null}
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {operatingFieldsForMode(operatingTarget.mode)
              .filter(([key]) => key !== "reset_anchor_at" || operatingDraft.reset_cycle !== "NONE")
              .map(([key, label, type]) => (
                <FormField htmlFor={`operating-${key}`} key={key} label={label}>
                  {type === "select" ? (
                    <select
                      className={INPUT_CLASS}
                      id={`operating-${key}`}
                      onChange={(event) =>
                        setOperatingDraft((current) => ({ ...current, [key]: event.target.value }))
                      }
                      value={operatingDraft[key] ?? "NONE"}
                    >
                      <option value="NONE">不重置</option>
                      <option value="DAILY">每日</option>
                      <option value="WEEKLY">每周</option>
                      <option value="MONTHLY">每月</option>
                      <option value="QUARTERLY">每季</option>
                      <option value="YEARLY">每年</option>
                    </select>
                  ) : key === "total_quota" ? (
                    <IntegerAmountInput
                      id={`operating-${key}`}
                      onChange={(rawValue) =>
                        setOperatingDraft((current) => ({ ...current, [key]: rawValue }))
                      }
                      value={operatingDraft[key] ?? ""}
                    />
                  ) : MONEY_OPERATING_KEYS.has(key) ? (
                    <MoneyAmountInput
                      id={`operating-${key}`}
                      onChange={(rawValue) =>
                        setOperatingDraft((current) => ({ ...current, [key]: rawValue }))
                      }
                      value={operatingDraft[key] ?? ""}
                    />
                  ) : (
                    <input
                      className={INPUT_CLASS}
                      id={`operating-${key}`}
                      onChange={(event) =>
                        setOperatingDraft((current) => ({ ...current, [key]: event.target.value }))
                      }
                      type={type}
                      value={operatingDraft[key] ?? ""}
                    />
                  )}
                </FormField>
              ))}
          </div>
          {operatingHistory.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <h3 className="mb-2 text-[13px] font-semibold text-ql-fg">历史修改记录（倒序）</h3>
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-ql-border text-ql-fg-tertiary">
                    <th className="p-2">版本/来源</th>
                    <th className="p-2">购买/金额配置</th>
                    <th className="p-2">周期配置</th>
                    <th className="p-2">保存时间</th>
                  </tr>
                </thead>
                <tbody>
                  {operatingHistory.map((snapshot) => (
                    <tr className="border-b border-ql-border-zone" key={snapshot.id}>
                      <td className="p-2">v{snapshot.version} · {snapshot.source}</td>
                      <td className="p-2">
                        {operatingTarget.mode === "CODING_PLAN"
                          ? `总 ${snapshot.total_quota ? formatCount(snapshot.total_quota) : "未知"} ${snapshot.quota_unit ?? ""} · ${snapshot.package_name ?? "未命名套餐"} · ${snapshot.currency ?? ""} ${snapshot.package_cost === null ? "费用未知" : formatMoney(snapshot.package_cost)}`
                          : `充值 ${snapshot.currency ?? ""} ${snapshot.recharge_amount === null ? "未知" : formatMoney(snapshot.recharge_amount)} · 余额 ${snapshot.current_balance === null ? "未知" : formatMoney(snapshot.current_balance)} · 本期费用 ${snapshot.current_period_cost === null ? "未知" : formatMoney(snapshot.current_period_cost)}`}
                      </td>
                      <td className="p-2">
                        {operatingTarget.mode === "CODING_PLAN"
                          ? `${RESET_CYCLE_LABELS[snapshot.reset_cycle ?? "NONE"] ?? snapshot.reset_cycle} · ${snapshot.reset_anchor_at ? formatDateTimeFull(snapshot.reset_anchor_at) : "无重置日期"}`
                          : `${snapshot.cost_period_start ? formatDateTimeFull(snapshot.cost_period_start) : "—"} ～ ${snapshot.cost_period_end ? formatDateTimeFull(snapshot.cost_period_end) : "—"}`}
                      </td>
                      <td className="p-2">{formatDateTimeFull(snapshot.collected_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {operatingValidationError ? (
            <p className="mt-3 text-[13px] text-ql-danger" role="alert">
              {operatingValidationError}
            </p>
          ) : operatingMutation.error ? (
            <p className="mt-3 text-[13px] text-ql-danger" role="alert">
              {operatingMutation.error.message}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="h-9 rounded-lg border border-ql-border bg-ql-surface px-4 text-[13px]"
              onClick={() => setOperatingTarget(null)}
              type="button"
            >
              取消
            </button>
            <button
              className="h-9 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white disabled:opacity-60"
              disabled={operatingMutation.isPending}
              type="submit"
            >
              {operatingMutation.isPending ? "保存中…" : "保存额度配置"}
            </button>
          </div>
        </form>
      ) : null}

  </>;
}
