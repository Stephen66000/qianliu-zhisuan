/** 草稿编辑器的输入与行容器；不持有草稿状态，不计算或提交资金事实。 */
import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ResourceOption } from "./ActivationDraftEditor";
import type { FinanceCurrencyCode } from "./activation-draft-model";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { Button } from "../ui/Button";


export function CurrencySelect({ id, value, onChange, disabled }: {
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
export function AccountAmountInput({ id, value, disabled, onChange }: {
  id: string; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  return (
    <input className={INPUT_CLASS} disabled={disabled} id={id} inputMode="decimal"
      onChange={(event) => onChange(event.target.value.replaceAll(",", ""))} value={value} />
  );
}


export function ResourceSelect({ id, value, options, disabled, label = "厂商资源", onChange }: {
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


export function DraftSectionCard({ title, description, count, readOnly, addLabel, onAdd, children, testId }: {
  title: string; description: string; count: number; readOnly: boolean;
  addLabel: string; onAdd: () => void; children: ReactNode; testId: string;
}) {
  return (
    <section className="mt-4 rounded-xl border border-ql-border-zone bg-ql-surface p-4" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[14px] font-semibold text-ql-fg">{title}<span className="ml-2 text-[13px] font-normal text-ql-fg-tertiary">已填写 {count} 行</span></h4>
          <p className="mt-1 text-[13px] text-ql-fg-tertiary">{description}</p>
        </div>
        {readOnly ? null : (
          <Button variant="secondary" data-write-action onClick={onAdd} type="button">
            <Plus aria-hidden className="h-3.5 w-3.5" />{addLabel}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}


export function RowShell({ title, readOnly, onRemove, children }: {
  title: string; readOnly: boolean; onRemove: () => void; children: ReactNode;
}) {
  return (
    <div className="mt-3 rounded-lg border border-ql-border bg-ql-surface-subtle p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-ql-fg-secondary">{title}</p>
        {readOnly ? null : (
          <Button variant="ghost" size="sm" aria-label={`删除 ${title}`}  onClick={onRemove} type="button">
            <Trash2 aria-hidden className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="mt-2 grid gap-3 md:grid-cols-2">{children}</div>
    </div>
  );
}
