/**
 * W18 超额列表 —— PRD §10.2：只显示谁 / 类型 / 分配多少 / 使用多少 / 超出多少 / 超出比例。
 *
 * 颜色纪律：超额属于"需要人处理"的信号，标签用 warning 橙（仪表盘补充 §3）；
 * 数字右对齐 tabular-nums（Web 规范 §10 表格）。
 */
import type { OverageItem } from "../../api/types";
import { formatCount, formatRatioAsPercent } from "../../lib/format";
import { StatusTag } from "./StatusTag";

interface OverageListProps {
  items: OverageItem[];
}

const PRINCIPAL_TYPE_LABEL: Record<string, string> = {
  EMPLOYEE: "员工",
  PROJECT: "项目",
};

export function OverageList({ items }: OverageListProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
            <th className="py-2 pr-4 font-medium">主体</th>
            <th className="py-2 pr-4 font-medium">类型</th>
            <th className="py-2 pr-4 font-medium">厂商 / 模型</th>
            <th className="py-2 pr-4 text-right font-medium">分配额度</th>
            <th className="py-2 pr-4 text-right font-medium">已用</th>
            <th className="py-2 pr-4 text-right font-medium">超出</th>
            <th className="py-2 text-right font-medium">超出比例</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle"
              key={`${item.principalId}-${item.provider}-${item.modelAlias}`}
            >
              <td className="py-2.5 pr-4 font-medium">{item.principalName}</td>
              <td className="py-2.5 pr-4 text-ql-fg-secondary">
                {PRINCIPAL_TYPE_LABEL[item.principalType] ?? item.principalType}
              </td>
              <td className="py-2.5 pr-4 text-ql-fg-secondary">
                {item.provider} / {item.modelAlias}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {formatCount(item.quotaValue)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {formatCount(item.usedValue)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {formatCount(item.overageValue)}
              </td>
              <td className="py-2.5 text-right">
                <StatusTag tone="warning">{formatRatioAsPercent(item.overageRatio)}</StatusTag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
