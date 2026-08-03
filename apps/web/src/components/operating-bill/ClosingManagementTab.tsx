import {
  CheckCircle2,
  Clock3,
  FileLock2,
  History,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import { StatusTag } from "../dashboard/StatusTag";
import { ConfirmDialog } from "../writes/ConfirmDialog";
import {
  BillCard,
  buttonPrimary,
  buttonSecondary,
  SectionHeading,
} from "./BillShared";

export type ClosingStatus = "待结账" | "已结账";

const checks = [
  {
    label: "厂商费用完整",
    detail: "3 / 3 家厂商已取得账单口径",
    complete: true,
  },
  { label: "使用主体完整", detail: "16 / 16 名活跃员工已归属", complete: true },
  {
    label: "项目归属完整",
    detail: "93%，仍有 ¥235.00 未归属",
    complete: false,
  },
  {
    label: "价值事项确认",
    detail: "3 / 5 项已由业务负责人确认",
    complete: false,
  },
];

export function ClosingManagementTab({
  status,
  onStatusChange,
}: {
  status: ClosingStatus;
  onStatusChange: (status: ClosingStatus) => void;
}) {
  const [dialog, setDialog] = useState<"close" | "reopen" | null>(null);

  const confirm = () => {
    onStatusChange(dialog === "close" ? "已结账" : "待结账");
    setDialog(null);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
      <div className="space-y-4">
        <BillCard>
          <SectionHeading
            action={
              <StatusTag tone={status === "已结账" ? "success" : "warning"}>
                {status}
              </StatusTag>
            }
            description="2026 年 7 月 · 自然月账期"
            title="本期结账"
          />
          <div className="px-4 pb-4">
            <div
              className={`flex items-start gap-3 rounded-xl p-4 ${status === "已结账" ? "bg-ql-success-soft" : "bg-ql-warning-soft"}`}
            >
              {status === "已结账" ? (
                <FileLock2 className="mt-0.5 h-5 w-5 shrink-0 text-ql-success" />
              ) : (
                <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-ql-warning" />
              )}
              <div>
                <p
                  className={`text-[13px] font-medium ${status === "已结账" ? "text-ql-success" : "text-ql-warning"}`}
                >
                  {status === "已结账"
                    ? "本期口径已冻结"
                    : "本期仍可补充和修改"}
                </p>
                <p className="mt-1 text-[12px] leading-5 text-ql-fg-secondary">
                  {status === "已结账"
                    ? "后续价格、规则或归属变化不会改写本期账单；如需修正，请重开并生成新版本。"
                    : "结账将冻结费用、归属、利用率和价值确认快照，生成可复核的 v1 版本。"}
                </p>
              </div>
            </div>

            <div className="mt-4 divide-y divide-ql-border-zone rounded-xl border border-ql-border-zone">
              {checks.map((item) => (
                <div
                  className="flex items-start justify-between gap-4 px-4 py-3"
                  key={item.label}
                >
                  <div className="flex items-start gap-2.5">
                    {item.complete ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ql-success" />
                    ) : (
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-ql-warning" />
                    )}
                    <div>
                      <p className="text-[13px] font-medium text-ql-fg">
                        {item.label}
                      </p>
                      <p className="mt-0.5 text-[12px] text-ql-fg-tertiary">
                        {item.detail}
                      </p>
                    </div>
                  </div>
                  <StatusTag tone={item.complete ? "success" : "warning"}>
                    {item.complete ? "通过" : "有缺口"}
                  </StatusTag>
                </div>
              ))}
            </div>

            <div className="mt-4 flex justify-end">
              {status === "待结账" ? (
                <button
                  className={buttonPrimary}
                  onClick={() => setDialog("close")}
                  type="button"
                >
                  <ShieldCheck className="h-4 w-4" />
                  确认结账
                </button>
              ) : (
                <button
                  className={buttonSecondary}
                  onClick={() => setDialog("reopen")}
                  type="button"
                >
                  <RotateCcw className="h-4 w-4" />
                  重开账期
                </button>
              )}
            </div>
          </div>
        </BillCard>
      </div>

      <BillCard className="self-start overflow-hidden">
        <SectionHeading
          description="每次结账或重开都保留操作人、时间和原因"
          title="历史版本与操作记录"
        />
        <div className="border-t border-ql-border-zone">
          <TimelineItem
            description="冻结 6 月费用、归属与价值确认口径"
            meta="2026-07-02 10:26 · 陈总"
            title="2026 年 6 月账单 · v1"
          />
          <TimelineItem
            description="项目归属修正：销售助手 → 智能客服 V2"
            meta="2026-06-04 15:12 · 李娜"
            title="重开 2026 年 5 月账单"
            warning
          />
          <TimelineItem
            description="完成修正后再次冻结，保留原 v1 快照"
            meta="2026-06-04 15:36 · 陈总"
            title="2026 年 5 月账单 · v2"
          />
          {status === "已结账" ? (
            <TimelineItem
              description="冻结本期口径，原型生成 v1 快照"
              meta="刚刚 · 当前管理员"
              title="2026 年 7 月账单 · v1"
            />
          ) : null}
        </div>
      </BillCard>

      <ConfirmDialog
        confirmLabel={dialog === "close" ? "确认结账" : "确认重开"}
        danger={dialog === "reopen"}
        impact={
          dialog === "close"
            ? "将冻结 2026 年 7 月费用、归属、利用率与价值确认口径；现有两项缺口会一并写入结账说明。"
            : "将解除 2026 年 7 月账单冻结。后续修改会生成新版本，原版本仍保留用于审计。"
        }
        onCancel={() => setDialog(null)}
        onConfirm={confirm}
        open={dialog !== null}
        title={dialog === "close" ? "确认完成本期结账？" : "确认重开本期账单？"}
      />
    </div>
  );
}

function TimelineItem({
  title,
  description,
  meta,
  warning = false,
}: {
  title: string;
  description: string;
  meta: string;
  warning?: boolean;
}) {
  return (
    <div className="flex gap-3 border-b border-ql-border-zone px-4 py-3 last:border-0">
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${warning ? "bg-ql-warning-soft text-ql-warning" : "bg-ql-surface-brand-soft text-ql-action"}`}
      >
        <History aria-hidden className="h-3.5 w-3.5" />
      </span>
      <div>
        <p className="text-[13px] font-medium text-ql-fg">{title}</p>
        <p className="mt-0.5 text-[12px] leading-5 text-ql-fg-secondary">
          {description}
        </p>
        <p className="mt-1 text-[11px] text-ql-fg-tertiary">{meta}</p>
      </div>
    </div>
  );
}
