import {
  AlertTriangle,
  BatteryFull,
  BatteryLow,
  CircleOff,
  PackageOpen,
} from "lucide-react";

import { StatusTag } from "../dashboard/StatusTag";
import { BillCard, Meter, SectionHeading } from "./BillShared";
import { planRows } from "./prototype-data";

const summaries = [
  {
    label: "已用满",
    value: "2",
    note: "其中 1 项提前耗尽",
    icon: BatteryFull,
    tone: "text-ql-success",
  },
  {
    label: "未用满",
    value: "1",
    note: "剩余 59% 权益",
    icon: BatteryLow,
    tone: "text-ql-warning",
  },
  {
    label: "无人使用",
    value: "1",
    note: "建议停购或转配",
    icon: CircleOff,
    tone: "text-ql-danger",
  },
  {
    label: "闲置权益",
    value: "¥376",
    note: "按采购价格折算",
    icon: PackageOpen,
    tone: "text-ql-warning",
  },
];

function toneForStatus(status: string): "success" | "warning" | "danger" {
  if (status === "已用满") return "success";
  if (status === "提前耗尽" || status === "无人使用") return "danger";
  return "warning";
}

export function PlanAnalysisTab() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaries.map(({ label, value, note, icon: Icon, tone }) => (
          <article
            className="rounded-xl border border-ql-border-zone bg-ql-surface p-4"
            key={label}
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[12px] font-medium text-ql-fg-secondary">
                  {label}
                </p>
                <p className="mt-2 text-[24px] font-semibold leading-8 text-ql-fg">
                  {value}
                </p>
              </div>
              <Icon
                aria-hidden
                className={`h-5 w-5 ${tone}`}
                strokeWidth={1.75}
              />
            </div>
            <p className="mt-1 text-[11px] text-ql-fg-tertiary">{note}</p>
          </article>
        ))}
      </div>

      <BillCard className="overflow-hidden">
        <SectionHeading
          description="套餐利用率按各自有效期、重置周期和原生额度计算"
          title="套餐明细"
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] text-left text-[13px]">
            <thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[12px] text-ql-fg-tertiary">
              <tr>
                <th className="px-4 py-2 font-medium">套餐资源</th>
                <th className="px-4 py-2 font-medium">归属</th>
                <th className="px-4 py-2 font-medium">已用 / 总额度</th>
                <th className="w-48 px-4 py-2 font-medium">利用率</th>
                <th className="px-4 py-2 text-right font-medium">套餐费用</th>
                <th className="px-4 py-2 font-medium">判断</th>
                <th className="px-4 py-2 font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              {planRows.map((row) => (
                <tr
                  className="border-b border-ql-border-zone last:border-0"
                  key={row.name}
                >
                  <td className="px-4 py-3 font-medium text-ql-fg">
                    {row.name}
                  </td>
                  <td className="px-4 py-3 text-ql-fg-secondary">
                    {row.owner}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-ql-fg-secondary">
                    {row.used}
                  </td>
                  <td className="px-4 py-3">
                    <div className="mb-1.5 flex justify-between text-[11px] text-ql-fg-secondary">
                      <span>{row.utilization}%</span>
                    </div>
                    <Meter
                      danger={row.status === "提前耗尽"}
                      value={row.utilization}
                    />
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    ¥{row.cost}
                  </td>
                  <td className="px-4 py-3">
                    <StatusTag tone={toneForStatus(row.status)}>
                      {row.status}
                    </StatusTag>
                  </td>
                  <td className="px-4 py-3 text-ql-fg-secondary">
                    {row.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </BillCard>

      <div className="flex items-start gap-3 rounded-xl border border-ql-warning/25 bg-ql-warning-soft p-4">
        <AlertTriangle
          aria-hidden
          className="mt-0.5 h-5 w-5 shrink-0 text-ql-warning"
        />
        <div>
          <p className="text-[13px] font-medium text-ql-warning">
            下月采购建议
          </p>
          <p className="mt-1 text-[12px] leading-5 text-ql-fg-secondary">
            智谱套餐提前耗尽，建议增加 20% 额度或将低优先级任务切至 Kimi；Claude
            席位整月无人使用，建议停购。预计可净节省 ¥99/月。
          </p>
        </div>
      </div>
    </div>
  );
}
