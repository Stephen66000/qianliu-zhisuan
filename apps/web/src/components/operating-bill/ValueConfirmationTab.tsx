import { BadgeCheck, Check, Clock3, Plus, Target, X } from "lucide-react";
import { useState } from "react";

import { StatusTag } from "../dashboard/StatusTag";
import {
  BillCard,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  SectionHeading,
} from "./BillShared";
import { initialValueItems, type ValueItem } from "./prototype-data";

const emptyDraft = {
  item: "",
  subject: "",
  value: "",
  evidence: "",
  owner: "",
};

export function ValueConfirmationTab() {
  const [items, setItems] = useState<ValueItem[]>(initialValueItems);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const confirmed = items.filter((item) => item.status === "已确认").length;

  const addItem = () => {
    if (!draft.item.trim() || !draft.value.trim() || !draft.owner.trim())
      return;
    setItems((current) => [
      ...current,
      {
        id: Date.now(),
        item: draft.item,
        subject: draft.subject || "未关联项目",
        value: draft.value,
        evidence: draft.evidence || "待补充",
        owner: draft.owner,
        status: "待确认",
      },
    ]);
    setDraft(emptyDraft);
    setOpen(false);
  };

  const confirmItem = (id: number) => {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, status: "已确认" } : item,
      ),
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ValueMetric
          icon={Target}
          label="已确认金额价值"
          note="人工填写并留存依据"
          value="¥100,000"
        />
        <ValueMetric
          icon={BadgeCheck}
          label="已确认事项"
          note={`共 ${items.length} 项价值记录`}
          value={`${confirmed} 项`}
        />
        <ValueMetric
          icon={Clock3}
          label="待确认"
          note="结账后仍可补录到新版本"
          value={`${items.length - confirmed} 项`}
          warning
        />
        <ValueMetric
          icon={Check}
          label="非金额指标"
          note="周期、质量、人力等"
          value="2 项"
        />
      </div>

      <BillCard className="overflow-hidden">
        <SectionHeading
          action={
            <button
              className={buttonPrimary}
              onClick={() => setOpen(true)}
              type="button"
            >
              <Plus className="h-4 w-4" />
              新增价值事项
            </button>
          }
          description="价值由业务负责人判断；系统负责关联成本、保存依据和确认记录"
          title="价值事项"
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[58rem] text-left text-[13px]">
            <thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[12px] text-ql-fg-tertiary">
              <tr>
                <th className="px-4 py-2 font-medium">价值事项</th>
                <th className="px-4 py-2 font-medium">关联项目</th>
                <th className="px-4 py-2 font-medium">金额 / 非金额指标</th>
                <th className="px-4 py-2 font-medium">依据</th>
                <th className="px-4 py-2 font-medium">确认人</th>
                <th className="px-4 py-2 font-medium">状态</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  className="border-b border-ql-border-zone last:border-0"
                  key={item.id}
                >
                  <td className="px-4 py-3 font-medium text-ql-fg">
                    {item.item}
                  </td>
                  <td className="px-4 py-3 text-ql-fg-secondary">
                    {item.subject}
                  </td>
                  <td className="px-4 py-3 font-medium text-ql-accent-text">
                    {item.value}
                  </td>
                  <td className="max-w-56 px-4 py-3 text-ql-fg-secondary">
                    {item.evidence}
                  </td>
                  <td className="px-4 py-3 text-ql-fg-secondary">
                    {item.owner}
                  </td>
                  <td className="px-4 py-3">
                    <StatusTag
                      tone={item.status === "已确认" ? "success" : "warning"}
                    >
                      {item.status}
                    </StatusTag>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {item.status === "待确认" ? (
                      <button
                        className="font-medium text-ql-action hover:text-ql-action-hover"
                        onClick={() => confirmItem(item.id)}
                        type="button"
                      >
                        确认
                      </button>
                    ) : (
                      <span className="text-ql-fg-tertiary">已留痕</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </BillCard>

      {open ? (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ql-canvas/70 p-4"
          role="dialog"
        >
          <div className="w-full max-w-2xl rounded-2xl border border-ql-border bg-ql-surface-raised p-6 shadow-ql-raised">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[18px] font-semibold text-ql-fg">
                  新增价值事项
                </h2>
                <p className="mt-1 text-[12px] text-ql-fg-tertiary">
                  先记录事实与依据，再由确认人完成判断。
                </p>
              </div>
              <button
                aria-label="关闭"
                className="rounded-lg p-1.5 text-ql-fg-tertiary hover:bg-ql-surface-subtle"
                onClick={() => setOpen(false)}
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <DraftField
                label="价值事项 *"
                onChange={(value) => setDraft({ ...draft, item: value })}
                placeholder="如：客户项目按期验收"
                value={draft.item}
              />
              <DraftField
                label="关联项目"
                onChange={(value) => setDraft({ ...draft, subject: value })}
                placeholder="如：智能客服 V2"
                value={draft.subject}
              />
              <DraftField
                label="金额或非金额指标 *"
                onChange={(value) => setDraft({ ...draft, value })}
                placeholder="如：¥100,000 或 5 天→1 天"
                value={draft.value}
              />
              <DraftField
                label="确认人 *"
                onChange={(value) => setDraft({ ...draft, owner: value })}
                placeholder="业务负责人姓名"
                value={draft.owner}
              />
              <div className="sm:col-span-2">
                <DraftField
                  label="判断依据"
                  onChange={(value) => setDraft({ ...draft, evidence: value })}
                  placeholder="验收单、工时记录、业务数据等"
                  value={draft.evidence}
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                className={buttonSecondary}
                onClick={() => setOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className={buttonPrimary}
                disabled={!draft.item || !draft.value || !draft.owner}
                onClick={addItem}
                type="button"
              >
                保存为待确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ValueMetric({
  icon: Icon,
  label,
  value,
  note,
  warning = false,
}: {
  icon: typeof Target;
  label: string;
  value: string;
  note: string;
  warning?: boolean;
}) {
  return (
    <article className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-ql-fg-secondary">
          {label}
        </span>
        <Icon
          aria-hidden
          className={`h-5 w-5 ${warning ? "text-ql-warning" : "text-ql-action"}`}
          strokeWidth={1.75}
        />
      </div>
      <p
        className={`mt-3 text-[24px] font-semibold leading-8 ${warning ? "text-ql-warning" : "text-ql-fg"}`}
      >
        {value}
      </p>
      <p className="mt-1 text-[11px] text-ql-fg-tertiary">{note}</p>
    </article>
  );
}

function DraftField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="mb-1 block text-[12px] font-medium text-ql-fg-secondary">
        {label}
      </span>
      <input
        className={`${inputClass} w-full`}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}
