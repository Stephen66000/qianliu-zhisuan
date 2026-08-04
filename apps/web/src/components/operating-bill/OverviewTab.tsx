import {
  BadgeCheck,
  Banknote,
  Boxes,
  CircleDollarSign,
  Gauge,
  Users,
  WalletCards,
  type LucideIcon,
} from "lucide-react";

import { StatusTag } from "../dashboard/StatusTag";
import { BillCard, Meter, SectionHeading } from "./BillShared";

const metrics: Array<{
  label: string;
  value: string;
  note: string;
  icon: LucideIcon;
  accent?: boolean;
}> = [
  {
    label: "总投入",
    value: "¥1,800.00",
    note: "API 消耗 + 固定套餐费用",
    icon: CircleDollarSign,
  },
  {
    label: "API 消耗",
    value: "¥1,000.00",
    note: "按厂商账单口径",
    icon: Banknote,
  },
  {
    label: "套餐费用",
    value: "¥800.00",
    note: "当月应计固定费用",
    icon: Boxes,
  },
  {
    label: "期末余额",
    value: "¥3,260.00",
    note: "可用 API 预付资产",
    icon: WalletCards,
  },
  {
    label: "综合利用率",
    value: "68.7%",
    note: "套餐权益加权利用率",
    icon: Gauge,
  },
  {
    label: "活跃主体",
    value: "16 / 20",
    note: "4 人本月无有效使用",
    icon: Users,
  },
  {
    label: "人工确认价值",
    value: "¥100,000",
    note: "另有 2 项非金额价值",
    icon: BadgeCheck,
    accent: true,
  },
];

const providerRows = [
  {
    provider: "DeepSeek",
    type: "API",
    cost: "¥1,000.00",
    share: "55.6%",
    usage: "38.4M Token",
    state: "正常",
  },
  {
    provider: "智谱",
    type: "Coding Plan",
    cost: "¥500.00",
    share: "27.8%",
    usage: "100% 额度",
    state: "提前耗尽",
  },
  {
    provider: "Kimi",
    type: "Coding Plan",
    cost: "¥300.00",
    share: "16.6%",
    usage: "41% 额度",
    state: "未用满",
  },
];

export function OverviewTab() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, note, icon: Icon, accent }) => (
          <article
            className={`rounded-xl border p-4 ${
              accent
                ? "border-ql-action/30 bg-ql-surface-brand-soft"
                : "border-ql-border-zone bg-ql-surface"
            }`}
            key={label}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] font-medium text-ql-fg-secondary">
                {label}
              </span>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ql-surface-subtle text-ql-action">
                <Icon aria-hidden className="h-4 w-4" strokeWidth={1.75} />
              </span>
            </div>
            <strong
              className={`mt-3 block text-[24px] leading-8 ${accent ? "text-ql-accent-text" : "text-ql-fg"}`}
            >
              {value}
            </strong>
            <p className="mt-1 text-[11px] leading-[18px] text-ql-fg-tertiary">
              {note}
            </p>
          </article>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(19rem,0.8fr)]">
        <BillCard className="overflow-hidden">
          <SectionHeading
            description="当月确认成本，不把充值金额重复算作费用"
            title="厂商投入构成"
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-[13px]">
              <thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[12px] text-ql-fg-tertiary">
                <tr>
                  <th className="px-4 py-2 font-medium">厂商</th>
                  <th className="px-4 py-2 font-medium">采购形态</th>
                  <th className="px-4 py-2 text-right font-medium">月度成本</th>
                  <th className="px-4 py-2 text-right font-medium">投入占比</th>
                  <th className="px-4 py-2 font-medium">使用情况</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {providerRows.map((row) => (
                  <tr
                    className="border-b border-ql-border-zone last:border-0"
                    key={row.provider}
                  >
                    <td className="px-4 py-3 font-medium text-ql-fg">
                      {row.provider}
                    </td>
                    <td className="px-4 py-3 text-ql-fg-secondary">
                      {row.type}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">
                      {row.cost}
                    </td>
                    <td className="px-4 py-3 text-right text-ql-fg-secondary tabular-nums">
                      {row.share}
                    </td>
                    <td className="px-4 py-3 text-ql-fg-secondary">
                      {row.usage}
                    </td>
                    <td className="px-4 py-3">
                      <StatusTag
                        tone={
                          row.state === "提前耗尽"
                            ? "danger"
                            : row.state === "未用满"
                              ? "warning"
                              : "success"
                        }
                      >
                        {row.state}
                      </StatusTag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </BillCard>

        <BillCard>
          <SectionHeading
            description="由业务负责人确认，系统不替企业编造价值"
            title="本月价值结论"
          />
          <div className="space-y-4 px-4 pb-4">
            <div className="rounded-xl bg-ql-surface-brand-soft p-4">
              <p className="text-[12px] text-ql-fg-secondary">已确认金额价值</p>
              <p className="mt-1 text-[26px] font-semibold leading-9 text-ql-accent-text">
                ¥100,000
              </p>
              <p className="mt-1 text-[12px] text-ql-fg-secondary">
                来自“智能客服 V2 按期上线”
              </p>
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[12px]">
                <span className="text-ql-fg-secondary">价值事项确认进度</span>
                <span className="font-medium text-ql-fg">3 / 5</span>
              </div>
              <Meter value={60} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-ql-border-zone p-3">
                <p className="text-[11px] text-ql-fg-tertiary">非金额价值</p>
                <p className="mt-1 text-[18px] font-semibold text-ql-fg">
                  2 项
                </p>
              </div>
              <div className="rounded-lg border border-ql-border-zone p-3">
                <p className="text-[11px] text-ql-fg-tertiary">待确认</p>
                <p className="mt-1 text-[18px] font-semibold text-ql-warning">
                  2 项
                </p>
              </div>
            </div>
            <p className="rounded-lg bg-ql-warning-soft px-3 py-2 text-[12px] leading-5 text-ql-warning">
              还有 7% 的费用未归属项目，建议结账前补齐。
            </p>
          </div>
        </BillCard>
      </div>
    </div>
  );
}
