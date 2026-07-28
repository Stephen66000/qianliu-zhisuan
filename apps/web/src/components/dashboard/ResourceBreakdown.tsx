/**
 * W18 资源摘要（按厂商+模式分组）—— PRD §10.2 资源摘要。
 *
 * 展示列：厂商 / 模式 / 账号数 / 总额度 / 已用额度 / 剩余展示（后端未给剩余，前端不重算，
 * 总额度与已用均为 null 时显示"—"，API 模式无额度概念）。
 * 状态：后端当前恒 HEALTHY（W20 细化），按颜色纪律用中性灰，不给蓝绿。
 */
import type { ResourceBreakdownItem } from "../../api/types";
import { formatCount, formatDateTimeShort, formatMoney, formatRatePerHour } from "../../lib/format";
import { StatusTag } from "./StatusTag";

interface ResourceBreakdownProps {
  items: ResourceBreakdownItem[];
}

const MODE_LABEL: Record<ResourceBreakdownItem["mode"], string> = {
  API: "API",
  CODING_PLAN: "套餐",
};

export function ResourceBreakdown({ items }: ResourceBreakdownProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
            <th className="py-2 pr-4 font-medium">厂商</th>
            <th className="py-2 pr-4 font-medium">模式</th>
            <th className="py-2 pr-4 text-right font-medium">账号数</th>
            <th className="py-2 pr-4 text-right font-medium">总额度</th>
            <th className="py-2 pr-4 text-right font-medium">已用额度</th>
            <th className="py-2 pr-4 text-right font-medium">本月费用（元）</th>
            <th className="py-2 pr-4 text-right font-medium">消耗速度</th>
            <th className="py-2 pr-4 font-medium">预计耗尽</th>
            <th className="py-2 font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle"
              key={`${item.providerCode}-${item.mode}`}
            >
              <td className="py-2.5 pr-4 font-medium">{item.providerName}</td>
              <td className="py-2.5 pr-4 text-ql-fg-secondary">{MODE_LABEL[item.mode]}</td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.accountCount}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.totalQuota === null ? "—" : formatCount(item.totalQuota)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.usedQuota === null ? "—" : formatCount(item.usedQuota)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {formatMoney(item.monthlyCost)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.currentRate24h === null ? "—" : formatRatePerHour(item.currentRate24h)}
              </td>
              <td className="py-2.5 pr-4 text-ql-fg-secondary">
                {item.forecastExhaustAt === null ? "—" : formatDateTimeShort(item.forecastExhaustAt)}
              </td>
              <td className="py-2.5">
                <StatusTag tone="neutral">正常</StatusTag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
