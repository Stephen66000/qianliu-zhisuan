import type { ProviderSubscriptionPeriod } from "../../api/provider-finance-types";
import { formatMoney, formatShanghaiDate } from "../../lib/format";

export function SubscriptionHistory({ periods }: { periods: ProviderSubscriptionPeriod[] }) {
  return <section aria-label="已登记订阅" className="mt-4">
    <h3 className="text-[14px] font-semibold">已登记订阅</h3>
    {periods.length ? <div className="overflow-x-auto"><table className="mt-2 w-full text-left text-[12px]">
      <thead><tr><th>订阅产品</th><th>服务周期</th><th>订阅金额</th><th>状态</th></tr></thead>
      <tbody>{periods.map((period) => <tr key={period.id} className="border-b border-ql-border-zone">
        <td className="py-2">{period.product_name}</td>
        <td>{formatShanghaiDate(period.period_start)} ～ {formatShanghaiDate(new Date(new Date(period.period_end_exclusive).getTime() - 86400000).toISOString())}</td>
        <td>{period.fixed_fee_amount === null ? "未登记金额" : `${period.fixed_fee_currency ?? ""} ${formatMoney(period.fixed_fee_amount)}`}</td>
        <td>{{ ACTIVE: "生效中", UPCOMING: "待生效", EXPIRED: "已到期", REVERSED: "已冲销" }[period.current_status]}</td>
      </tr>)}</tbody>
    </table></div> : <p className="py-3 text-[12px] text-ql-fg-tertiary">暂无已登记订阅</p>}
  </section>;
}
