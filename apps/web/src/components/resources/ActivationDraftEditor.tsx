/**
 * 初始化草稿编辑器（WP05 任务 5.2；PFU-02、PFU-05、PFH-01～PFH-03）。
 *
 * 覆盖五类事实：API 期初余额、历史 API 充值、Coding Plan 购买/续费、跨切换周期、
 * 旧购买记录关闭。约定：
 *  - 期初时点固定为资金切换时点，**只读不可编辑**（计划 v1.2 §4.2）；
 *  - 金额空值与 `0` 严格区分：留空显示「未填写」且不自动补 0（PFU-05）；
 *  - 说明与证据引用对所有资金事实必填（PFH-06）；
 *  - `UNKNOWN_COST` 不是本编辑器可以关闭的对象，只能走既有的历史费用处置闭环（PFH-02）。
 */
import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { formatDateTimeFull } from "../../lib/format";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { MoneyAmountInput } from "../writes/MoneyAmountInput";
import {
  ACTIVATION_DESCRIPTION_MAX_LENGTH, ACTIVATION_EVIDENCE_MAX_LENGTH,
  DRAFT_SECTION_LABELS, newRecordIdempotencyKey,
  type ActivationDraftState, type CarryoverRowState, type DraftIssue, type DraftSection,
  type FinanceCurrencyCode, type LegacyRowState, type OpeningRowState,
  type PurchaseRowState, type RechargeRowState,
} from "./activation-draft-model";

export interface ResourceOption { id: string; mode: "API" | "CODING_PLAN"; label: string }

export interface LegacySuggestion { legacyRecordId: string; resourceId: string }

interface EditorProps {
  state: ActivationDraftState;
  onChange: (next: ActivationDraftState) => void;
  resourceOptions: ResourceOption[];
  issues: DraftIssue[];
  readOnly: boolean;
  cutoverAt: string | null;
  requiredAccounts: Array<{ resource_id: string; currency: FinanceCurrencyCode }>;
  legacySuggestions: LegacySuggestion[];
}

function errorFor(issues: DraftIssue[], section: DraftSection, rowId: string, field: string): string | undefined {
  return issues.find((issue) => issue.section === section && issue.rowId === rowId
    && (issue.field === field || issue.field === "rows"))?.message;
}

function updateRow<TRow extends { id: string }>(
  rows: TRow[], id: string, patch: Partial<TRow>,
): TRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

function CurrencySelect({ id, value, onChange, disabled }: {
  id: string; value: FinanceCurrencyCode; disabled: boolean;
  onChange: (value: FinanceCurrencyCode) => void;
}) {
  return (
    <select className={INPUT_CLASS} disabled={disabled} id={id}
      onChange={(event) => onChange(event.target.value as FinanceCurrencyCode)} value={value}>
      <option value="CNY">CNY</option>
      <option value="USD">USD</option>
    </select>
  );
}

/**
 * 账户金额输入（原币，最多 8 位小数）。
 *
 * 不复用 `MoneyAmountInput`：后者面向**人民币实付**的 2 位小数口径，会对 8 位小数金额
 * 做无意义（但非破坏性）的显示分支。这里保持「原样字符串」，不引入任何隐式取整，
 * 避免把「未填写」误变成 `0` 或把 `0` 误当成空（PFU-05）。
 */
function AccountAmountInput({ id, value, disabled, onChange }: {
  id: string; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  return (
    <input className={INPUT_CLASS} disabled={disabled} id={id} inputMode="decimal"
      onChange={(event) => onChange(event.target.value.replaceAll(",", ""))} value={value} />
  );
}

function ResourceSelect({ id, value, options, disabled, label = "厂商资源", onChange }: {
  id: string; value: string; options: ResourceOption[]; disabled: boolean; label?: string;
  onChange: (value: string) => void;
}) {
  return (
    <FormField htmlFor={id} label={label}>
      <select className={INPUT_CLASS} disabled={disabled} id={id}
        onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">请选择</option>
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </FormField>
  );
}

function DraftSectionCard({ title, description, count, readOnly, addLabel, onAdd, children, testId }: {
  title: string; description: string; count: number; readOnly: boolean;
  addLabel: string; onAdd: () => void; children: ReactNode; testId: string;
}) {
  return (
    <section className="mt-4 rounded-xl border border-ql-border-zone bg-ql-surface p-4" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[14px] font-semibold text-ql-fg">{title}<span className="ml-2 text-[12px] font-normal text-ql-fg-tertiary">已填写 {count} 行</span></h4>
          <p className="mt-1 text-[12px] text-ql-fg-tertiary">{description}</p>
        </div>
        {readOnly ? null : (
          <button className="flex h-9 items-center gap-1.5 rounded-lg border border-ql-border px-3 text-[13px]" data-write-action onClick={onAdd} type="button">
            <Plus aria-hidden className="h-3.5 w-3.5" />{addLabel}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function RowShell({ title, readOnly, onRemove, children }: {
  title: string; readOnly: boolean; onRemove: () => void; children: ReactNode;
}) {
  return (
    <div className="mt-3 rounded-lg border border-ql-border bg-ql-surface-subtle p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-ql-fg-secondary">{title}</p>
        {readOnly ? null : (
          <button aria-label={`删除 ${title}`} className="rounded p-1 text-ql-fg-tertiary hover:text-ql-danger" onClick={onRemove} type="button">
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="mt-2 grid gap-3 md:grid-cols-2">{children}</div>
    </div>
  );
}

function OpeningRowFields({ row, index, issues, readOnly, cutoverAt, resourceOptions, onPatch, onRemove }: {
  row: OpeningRowState; index: number; issues: DraftIssue[]; readOnly: boolean;
  cutoverAt: string | null; resourceOptions: ResourceOption[];
  onPatch: (patch: Partial<OpeningRowState>) => void; onRemove: () => void;
}) {
  const rowId = `opening-${index}`;
  const amountEmpty = row.accountAmount.trim() === "";
  return (
    <RowShell
      onRemove={onRemove} readOnly={readOnly}
      title={`期初行 ${index + 1}`}
    >
      <ResourceSelect disabled={readOnly} id={`${rowId}-resource`} onChange={(value) => onPatch({ resourceId: value })}
        options={resourceOptions} value={row.resourceId} />
      <FormField htmlFor={`${rowId}-currency`} label="币种">
        <CurrencySelect disabled={readOnly} id={`${rowId}-currency`} onChange={(value) => onPatch({ accountCurrency: value })} value={row.accountCurrency} />
      </FormField>
      <FormField
        error={errorFor(issues, "apiOpeningBalances", row.id, "accountAmount")}
        hint={amountEmpty ? "未填写（空值与 0 不同，如需零值请显式填写 0）" : "非负，最多八位小数"}
        htmlFor={`${rowId}-amount`} label="期初余额"
      >
        <AccountAmountInput disabled={readOnly} id={`${rowId}-amount`} onChange={(value) => onPatch({ accountAmount: value })} value={row.accountAmount} />
      </FormField>
      <FormField hint={cutoverAt ? formatDateTimeFull(cutoverAt) : "待读取切换时点"} htmlFor={`${rowId}-cutover`} label="期初时点（固定）">
        <input className={INPUT_CLASS} disabled id={`${rowId}-cutover`} readOnly value={cutoverAt ? formatDateTimeFull(cutoverAt) : ""} />
      </FormField>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "apiOpeningBalances", row.id, "description")}
          hint={`必填，最多 ${ACTIVATION_DESCRIPTION_MAX_LENGTH} 字`} htmlFor={`${rowId}-description`} label="事实说明">
          <textarea className={`${INPUT_CLASS} min-h-16 w-full py-2`} disabled={readOnly} id={`${rowId}-description`}
            onChange={(event) => onPatch({ description: event.target.value })} value={row.description} />
        </FormField>
      </div>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "apiOpeningBalances", row.id, "evidenceRef")}
          hint={`必填，最多 ${ACTIVATION_EVIDENCE_MAX_LENGTH} 字`} htmlFor={`${rowId}-evidence`} label="证据引用">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-evidence`}
            onChange={(event) => onPatch({ evidenceRef: event.target.value })} value={row.evidenceRef} />
        </FormField>
      </div>
    </RowShell>
  );
}

function RechargeRowFields({ row, index, issues, readOnly, resourceOptions, onPatch, onRemove }: {
  row: RechargeRowState; index: number; issues: DraftIssue[]; readOnly: boolean;
  resourceOptions: ResourceOption[]; onPatch: (patch: Partial<RechargeRowState>) => void;
  onRemove: () => void;
}) {
  const rowId = `recharge-${index}`;
  return (
    <RowShell onRemove={onRemove} readOnly={readOnly} title={`历史充值 ${index + 1}`}>
      <ResourceSelect disabled={readOnly} id={`${rowId}-resource`} onChange={(value) => onPatch({ resourceId: value })}
        options={resourceOptions} value={row.resourceId} />
      <FormField htmlFor={`${rowId}-currency`} label="币种">
        <CurrencySelect disabled={readOnly} id={`${rowId}-currency`} onChange={(value) => onPatch({ accountCurrency: value })} value={row.accountCurrency} />
      </FormField>
      <FormField error={errorFor(issues, "historicalApiRecharges", row.id, "accountAmount")} hint="非负，最多八位小数"
        htmlFor={`${rowId}-amount`} label="到账金额">
        <MoneyAmountInput disabled={readOnly} id={`${rowId}-amount`} onChange={(value) => onPatch({ accountAmount: value })} value={row.accountAmount} />
      </FormField>
      <FormField error={errorFor(issues, "historicalApiRecharges", row.id, "cashPaidCny")} hint="必须大于 0，最多两位小数"
        htmlFor={`${rowId}-cash`} label="人民币实付">
        <MoneyAmountInput disabled={readOnly} id={`${rowId}-cash`} onChange={(value) => onPatch({ cashPaidCny: value })} value={row.cashPaidCny} />
      </FormField>
      <FormField error={errorFor(issues, "historicalApiRecharges", row.id, "occurredAt")} htmlFor={`${rowId}-occurred`} label="充值时间">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-occurred`} onChange={(event) => onPatch({ occurredAtLocal: event.target.value })} type="datetime-local" value={row.occurredAtLocal} />
      </FormField>
      <FormField error={errorFor(issues, "historicalApiRecharges", row.id, "externalReference")} hint="厂商订单号，必填"
        htmlFor={`${rowId}-reference`} label="外部引用">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-reference`} onChange={(event) => onPatch({ externalReference: event.target.value })} value={row.externalReference} />
      </FormField>
      <FormField error={errorFor(issues, "historicalApiRecharges", row.id, "sourceRecordId")} hint="对应旧购买记录 ID"
        htmlFor={`${rowId}-source`} label="来源旧记录">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-source`} onChange={(event) => onPatch({ sourceRecordId: event.target.value })} value={row.sourceRecordId} />
      </FormField>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "historicalApiRecharges", row.id, "description")} htmlFor={`${rowId}-description`} label="事实说明">
          <textarea className={`${INPUT_CLASS} min-h-16 w-full py-2`} disabled={readOnly} id={`${rowId}-description`} onChange={(event) => onPatch({ description: event.target.value })} value={row.description} />
        </FormField>
      </div>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "historicalApiRecharges", row.id, "evidenceRef")} htmlFor={`${rowId}-evidence`} label="证据引用">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-evidence`} onChange={(event) => onPatch({ evidenceRef: event.target.value })} value={row.evidenceRef} />
        </FormField>
      </div>
    </RowShell>
  );
}

function PurchaseRowFields({ row, index, issues, readOnly, resourceOptions, onPatch, onRemove }: {
  row: PurchaseRowState; index: number; issues: DraftIssue[]; readOnly: boolean;
  resourceOptions: ResourceOption[]; onPatch: (patch: Partial<PurchaseRowState>) => void;
  onRemove: () => void;
}) {
  const rowId = `purchase-${index}`;
  return (
    <RowShell onRemove={onRemove} readOnly={readOnly} title={`Coding Plan ${index + 1}`}>
      <ResourceSelect disabled={readOnly} id={`${rowId}-resource`} onChange={(value) => onPatch({ resourceId: value })} options={resourceOptions} value={row.resourceId} />
      <FormField htmlFor={`${rowId}-kind`} label="登记类型">
        <select className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-kind`} onChange={(event) => onPatch({ kind: event.target.value as PurchaseRowState["kind"] })} value={row.kind}>
          <option value="PURCHASE">首次购买</option><option value="RENEWAL">续费</option>
        </select>
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "productName")} htmlFor={`${rowId}-product`} label="产品名称">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-product`} onChange={(event) => onPatch({ productName: event.target.value })} value={row.productName} />
      </FormField>
      <FormField htmlFor={`${rowId}-currency`} label="币种">
        <CurrencySelect disabled={readOnly} id={`${rowId}-currency`} onChange={(value) => onPatch({ accountCurrency: value })} value={row.accountCurrency} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "accountAmount")} hint="原币金额，最多八位小数" htmlFor={`${rowId}-amount`} label="订阅金额">
        <MoneyAmountInput disabled={readOnly} id={`${rowId}-amount`} onChange={(value) => onPatch({ accountAmount: value })} value={row.accountAmount} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "cashPaidCny")} hint="必须大于 0" htmlFor={`${rowId}-cash`} label="人民币实付">
        <MoneyAmountInput disabled={readOnly} id={`${rowId}-cash`} onChange={(value) => onPatch({ cashPaidCny: value })} value={row.cashPaidCny} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "servicePeriodStart")} hint="页面为包含结束日的上海自然日" htmlFor={`${rowId}-start`} label="服务开始日">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-start`} onChange={(event) => onPatch({ servicePeriodStart: event.target.value })} type="date" value={row.servicePeriodStart} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "servicePeriodEnd")} hint="留空按“下个月同日前一日”" htmlFor={`${rowId}-end`} label="服务结束日（可选）">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-end`} onChange={(event) => onPatch({ servicePeriodEnd: event.target.value })} type="date" value={row.servicePeriodEnd} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "occurredAt")} hint="必须等于服务开始日" htmlFor={`${rowId}-occurred`} label="扣费时间">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-occurred`} onChange={(event) => onPatch({ occurredAtLocal: event.target.value })} type="datetime-local" value={row.occurredAtLocal} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "externalReference")} htmlFor={`${rowId}-reference`} label="外部引用">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-reference`} onChange={(event) => onPatch({ externalReference: event.target.value })} value={row.externalReference} />
      </FormField>
      <label className="flex items-center gap-2 text-[13px]" htmlFor={`${rowId}-renew`}>
        <input checked={row.autoRenew} disabled={readOnly} id={`${rowId}-renew`} onChange={(event) => onPatch({ autoRenew: event.target.checked })} type="checkbox" />自动续订
      </label>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "description")} htmlFor={`${rowId}-description`} label="事实说明">
          <textarea className={`${INPUT_CLASS} min-h-16 w-full py-2`} disabled={readOnly} id={`${rowId}-description`} onChange={(event) => onPatch({ description: event.target.value })} value={row.description} />
        </FormField>
      </div>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "codingPlanPurchases", row.id, "evidenceRef")} htmlFor={`${rowId}-evidence`} label="证据引用">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-evidence`} onChange={(event) => onPatch({ evidenceRef: event.target.value })} value={row.evidenceRef} />
        </FormField>
      </div>
    </RowShell>
  );
}

function CarryoverRowFields({ row, index, issues, readOnly, resourceOptions, onPatch, onRemove }: {
  row: CarryoverRowState; index: number; issues: DraftIssue[]; readOnly: boolean;
  resourceOptions: ResourceOption[]; onPatch: (patch: Partial<CarryoverRowState>) => void;
  onRemove: () => void;
}) {
  const rowId = `carryover-${index}`;
  return (
    <RowShell onRemove={onRemove} readOnly={readOnly} title={`跨切换周期 ${index + 1}`}>
      <ResourceSelect disabled={readOnly} id={`${rowId}-resource`} onChange={(value) => onPatch({ resourceId: value })} options={resourceOptions} value={row.resourceId} />
      <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "productName")} htmlFor={`${rowId}-product`} label="产品名称">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-product`} onChange={(event) => onPatch({ productName: event.target.value })} value={row.productName} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "periodStart")} htmlFor={`${rowId}-start`} label="周期开始日">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-start`} onChange={(event) => onPatch({ periodStart: event.target.value })} type="date" value={row.periodStart} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "periodEnd")} htmlFor={`${rowId}-end`} label="周期结束日">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-end`} onChange={(event) => onPatch({ periodEnd: event.target.value })} type="date" value={row.periodEnd} />
      </FormField>
      <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "snapshotId")} hint="跨切换快照 ID" htmlFor={`${rowId}-snapshot`} label="快照引用">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-snapshot`} onChange={(event) => onPatch({ snapshotId: event.target.value })} value={row.snapshotId} />
      </FormField>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "description")} htmlFor={`${rowId}-description`} label="事实说明">
          <textarea className={`${INPUT_CLASS} min-h-16 w-full py-2`} disabled={readOnly} id={`${rowId}-description`} onChange={(event) => onPatch({ description: event.target.value })} value={row.description} />
        </FormField>
      </div>
      <div className="md:col-span-2">
        <FormField error={errorFor(issues, "codingPlanCarryovers", row.id, "evidenceRef")} htmlFor={`${rowId}-evidence`} label="证据引用">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-evidence`} onChange={(event) => onPatch({ evidenceRef: event.target.value })} value={row.evidenceRef} />
        </FormField>
      </div>
    </RowShell>
  );
}

function LegacyRowFields({ row, index, issues, readOnly, resourceOptions, onPatch, onRemove }: {
  row: LegacyRowState; index: number; issues: DraftIssue[]; readOnly: boolean;
  resourceOptions: ResourceOption[]; onPatch: (patch: Partial<LegacyRowState>) => void;
  onRemove: () => void;
}) {
  const rowId = `legacy-${index}`;
  return (
    <RowShell onRemove={onRemove} readOnly={readOnly} title={`旧记录关闭 ${index + 1}`}>
      <FormField error={errorFor(issues, "legacyResolutions", row.id, "legacyRecordId")} hint="原旧购买记录引用" htmlFor={`${rowId}-record`} label="旧购买记录">
        <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-record`} onChange={(event) => onPatch({ legacyRecordId: event.target.value })} value={row.legacyRecordId} />
      </FormField>
      <ResourceSelect disabled={readOnly} id={`${rowId}-resource`} onChange={(value) => onPatch({ resourceId: value })} options={resourceOptions} value={row.resourceId} />
      <FormField htmlFor={`${rowId}-resolution`} label="关闭结果">
        <select className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-resolution`} onChange={(event) => onPatch({ resolution: event.target.value as LegacyRowState["resolution"] })} value={row.resolution}>
          <option value="MIGRATED">MIGRATED（迁移为资金事件）</option>
          <option value="ALREADY_REPRESENTED">ALREADY_REPRESENTED（已由既有事件表达）</option>
          <option value="REJECTED_WITH_EVIDENCE">REJECTED_WITH_EVIDENCE（有证据地拒绝）</option>
        </select>
      </FormField>
      {row.resolution === "MIGRATED" ? (
        <FormField error={errorFor(issues, "legacyResolutions", row.id, "migratedExternalReference")} hint="迁移后的外部订单引用" htmlFor={`${rowId}-migrated`} label="外部订单引用">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-migrated`} onChange={(event) => onPatch({ migratedExternalReference: event.target.value })} value={row.migratedExternalReference} />
        </FormField>
      ) : null}
      {row.resolution === "ALREADY_REPRESENTED" ? (
        <FormField error={errorFor(issues, "legacyResolutions", row.id, "financeEventId")} hint="必须引用同企业同资源的资金事件" htmlFor={`${rowId}-event`} label="资金事件 ID">
          <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-event`} onChange={(event) => onPatch({ financeEventId: event.target.value })} value={row.financeEventId} />
        </FormField>
      ) : null}
      {row.resolution === "REJECTED_WITH_EVIDENCE" ? (
        <>
          <FormField error={errorFor(issues, "legacyResolutions", row.id, "reason")} hint="必填：说明该记录为何不是实际资金事实" htmlFor={`${rowId}-reason`} label="拒绝原因">
            <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-reason`} onChange={(event) => onPatch({ reason: event.target.value })} value={row.reason} />
          </FormField>
          <FormField error={errorFor(issues, "legacyResolutions", row.id, "evidenceRef")} hint="必填" htmlFor={`${rowId}-evidence`} label="拒绝证据">
            <input className={INPUT_CLASS} disabled={readOnly} id={`${rowId}-evidence`} onChange={(event) => onPatch({ evidenceRef: event.target.value })} value={row.evidenceRef} />
          </FormField>
          <p className="text-[12px] text-ql-warning md:col-span-2">
            该决定只关闭这条旧购买记录；<code>UNKNOWN_COST</code> 用量缺口仍必须独立处理，不能借此关闭。
          </p>
        </>
      ) : null}
      {row.resolution === "MIGRATED" ? (
        <p className="text-[12px] text-ql-fg-tertiary md:col-span-2">
          MIGRATED 会写入 <code>API_RECHARGE</code> 事件，因此还需要在「历史 API 充值」中登记对应的到账金额、实付与证据。
        </p>
      ) : null}
    </RowShell>
  );
}

export function ActivationDraftEditor({
  state, onChange, resourceOptions, issues, readOnly, cutoverAt, requiredAccounts, legacySuggestions,
}: EditorProps) {
  const setSection = <TKey extends keyof ActivationDraftState>(key: TKey, rows: ActivationDraftState[TKey]) =>
    onChange({ ...state, [key]: rows });

  const patch = <TRow extends { id: string }>(key: keyof ActivationDraftState, id: string,
    change: Partial<TRow>) => {
    const rows = state[key] as unknown as TRow[];
    setSection(key, updateRow(rows, id, change) as unknown as ActivationDraftState[typeof key]);
  };

  const removeRow = <TRow extends { id: string }>(key: keyof ActivationDraftState, id: string) => {
    const rows = state[key] as unknown as TRow[];
    setSection(key, rows.filter((row) => row.id !== id) as unknown as ActivationDraftState[typeof key]);
  };

  const apiOptions = resourceOptions.filter((option) => option.mode === "API");
  const planOptions = resourceOptions.filter((option) => option.mode === "CODING_PLAN");
  const missingAccounts = requiredAccounts.filter((account) => !state.apiOpeningBalances.some(
    (row) => row.resourceId === account.resource_id && row.accountCurrency === account.currency));
  const unclosedSuggestions = legacySuggestions.filter((suggestion) => !state.legacyResolutions.some(
    (row) => row.legacyRecordId === suggestion.legacyRecordId));

  return (
    <div data-testid="activation-draft-editor">
      <DraftSectionCard
        addLabel="添加期初行" count={state.apiOpeningBalances.length}
        description="每个必要币种账户一条原始期初；期初时点固定为资金切换时点，写入后只能用更正事件修改。"
        onAdd={() => setSection("apiOpeningBalances", [...state.apiOpeningBalances, {
          id: newLocalRowIdFor("opening"), resourceId: "", accountCurrency: "CNY", accountAmount: "",
          description: "", evidenceRef: "", sourceRecordId: "",
        }])}
        readOnly={readOnly} testId="draft-section-openings" title={DRAFT_SECTION_LABELS.apiOpeningBalances}
      >
        {missingAccounts.length > 0 ? (
          <div className="mt-3 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning" data-testid="required-accounts-hint">
            激活范围内仍有 {missingAccounts.length} 个必要账户没有期初草稿行：
            {missingAccounts.map((account) => (
              <button
                className="ml-2 rounded border border-ql-warning px-2 py-0.5"
                key={`${account.resource_id}:${account.currency}`}
                onClick={() => setSection("apiOpeningBalances", [...state.apiOpeningBalances, {
                  id: newLocalRowIdFor("opening"), resourceId: account.resource_id,
                  accountCurrency: account.currency, accountAmount: "", description: "",
                  evidenceRef: "", sourceRecordId: "",
                }])}
                type="button"
              >
                补齐 {account.currency}
              </button>
            ))}
          </div>
        ) : null}
        {state.apiOpeningBalances.map((row, index) => (
          <OpeningRowFields
            cutoverAt={cutoverAt} index={index} issues={issues} key={row.id}
            onPatch={(change) => patch<OpeningRowState>("apiOpeningBalances", row.id, change)}
            onRemove={() => removeRow("apiOpeningBalances", row.id)}
            readOnly={readOnly} resourceOptions={apiOptions} row={row}
          />
        ))}
      </DraftSectionCard>

      <DraftSectionCard
        addLabel="添加历史充值" count={state.historicalApiRecharges.length}
        description="切换时点后的每条真实 API 充值：到账金额、人民币实付、时间、订单引用、说明与证据。"
        onAdd={() => setSection("historicalApiRecharges", [...state.historicalApiRecharges, {
          id: newLocalRowIdFor("recharge"), resourceId: "", accountCurrency: "CNY", accountAmount: "",
          cashPaidCny: "", occurredAtLocal: "", externalReference: "", description: "",
          evidenceRef: "", sourceRecordId: "", recordIdempotencyKey: newRecordIdempotencyKey(),
        }])}
        readOnly={readOnly} testId="draft-section-recharges" title={DRAFT_SECTION_LABELS.historicalApiRecharges}
      >
        {state.historicalApiRecharges.map((row, index) => (
          <RechargeRowFields
            index={index} issues={issues} key={row.id}
            onPatch={(change) => patch<RechargeRowState>("historicalApiRecharges", row.id, change)}
            onRemove={() => removeRow("historicalApiRecharges", row.id)}
            readOnly={readOnly} resourceOptions={apiOptions} row={row}
          />
        ))}
      </DraftSectionCard>

      <DraftSectionCard
        addLabel="添加购买/续费" count={state.codingPlanPurchases.length}
        description="Coding Plan 购买或续费：服务开始日/结束日为上海自然日（页面含结束日），扣费时间必须等于开始日。"
        onAdd={() => setSection("codingPlanPurchases", [...state.codingPlanPurchases, {
          id: newLocalRowIdFor("purchase"), resourceId: "", kind: "RENEWAL", productName: "",
          accountAmount: "", accountCurrency: "CNY", cashPaidCny: "", servicePeriodStart: "",
          servicePeriodEnd: "", occurredAtLocal: "", externalReference: "", autoRenew: true,
          description: "", evidenceRef: "", sourceRecordId: "", carryoverSnapshotId: "",
          recordIdempotencyKey: newRecordIdempotencyKey(),
        }])}
        readOnly={readOnly} testId="draft-section-purchases" title={DRAFT_SECTION_LABELS.codingPlanPurchases}
      >
        {state.codingPlanPurchases.map((row, index) => (
          <PurchaseRowFields
            index={index} issues={issues} key={row.id}
            onPatch={(change) => patch<PurchaseRowState>("codingPlanPurchases", row.id, change)}
            onRemove={() => removeRow("codingPlanPurchases", row.id)}
            readOnly={readOnly} resourceOptions={planOptions} row={row}
          />
        ))}
      </DraftSectionCard>

      <DraftSectionCard
        addLabel="添加跨切换周期" count={state.codingPlanCarryovers.length}
        description="覆盖切换时点的历史套餐周期：重叠周期只有在历史用量仍能唯一归属时才可存在。"
        onAdd={() => setSection("codingPlanCarryovers", [...state.codingPlanCarryovers, {
          id: newLocalRowIdFor("carryover"), resourceId: "", productName: "", periodStart: "",
          periodEnd: "", snapshotId: "", description: "", evidenceRef: "",
        }])}
        readOnly={readOnly} testId="draft-section-carryovers" title={DRAFT_SECTION_LABELS.codingPlanCarryovers}
      >
        {state.codingPlanCarryovers.map((row, index) => (
          <CarryoverRowFields
            index={index} issues={issues} key={row.id}
            onPatch={(change) => patch<CarryoverRowState>("codingPlanCarryovers", row.id, change)}
            onRemove={() => removeRow("codingPlanCarryovers", row.id)}
            readOnly={readOnly} resourceOptions={planOptions} row={row}
          />
        ))}
      </DraftSectionCard>

      <DraftSectionCard
        addLabel="添加旧记录关闭" count={state.legacyResolutions.length}
        description="切换时点后的每条旧购买记录必须有唯一关闭结果：MIGRATED、ALREADY_REPRESENTED 或 REJECTED_WITH_EVIDENCE。"
        onAdd={() => setSection("legacyResolutions", [...state.legacyResolutions, {
          id: newLocalRowIdFor("legacy"), legacyRecordId: "", resourceId: "", resolution: "MIGRATED",
          financeEventId: "", migratedExternalReference: "", reason: "", evidenceRef: "",
        }])}
        readOnly={readOnly} testId="draft-section-legacy" title={DRAFT_SECTION_LABELS.legacyResolutions}
      >
        {unclosedSuggestions.length > 0 ? (
          <div className="mt-3 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning" data-testid="legacy-suggestions">
            预检发现 {unclosedSuggestions.length} 条未关闭旧记录：
            {unclosedSuggestions.map((suggestion) => (
              <button
                className="ml-2 rounded border border-ql-warning px-2 py-0.5"
                key={suggestion.legacyRecordId}
                onClick={() => setSection("legacyResolutions", [...state.legacyResolutions, {
                  id: newLocalRowIdFor("legacy"), legacyRecordId: suggestion.legacyRecordId,
                  resourceId: suggestion.resourceId, resolution: "MIGRATED", financeEventId: "",
                  migratedExternalReference: "", reason: "", evidenceRef: "",
                }])}
                type="button"
              >
                补齐 {suggestion.legacyRecordId.slice(0, 8)}
              </button>
            ))}
          </div>
        ) : null}
        {state.legacyResolutions.map((row, index) => (
          <LegacyRowFields
            index={index} issues={issues} key={row.id}
            onPatch={(change) => patch<LegacyRowState>("legacyResolutions", row.id, change)}
            onRemove={() => removeRow("legacyResolutions", row.id)}
            readOnly={readOnly} resourceOptions={resourceOptions} row={row}
          />
        ))}
      </DraftSectionCard>
    </div>
  );
}

function newLocalRowIdFor(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
