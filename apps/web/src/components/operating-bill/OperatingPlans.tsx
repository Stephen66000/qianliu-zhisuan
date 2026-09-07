import { useState } from "react";
import type { OperatingAnalysis } from "../../api/operating-analysis";
import { Cell, Num, Table } from "../../pages/OperatingBillShared";
import { BillCard, SectionHeading, buttonSecondary } from "./BillShared";
import { BillStat } from "./BillStat";
import { analysisPercent, analysisTokens } from "./OperatingTrends";

export function OperatingPlans({ data }: { data: OperatingAnalysis }) {
  const [code, setCode] = useState("kimi");
  const plan =
    data.plans.find((row) => row.providerCode === code) ?? data.plans[0];
  if (!plan)
    return (
      <BillCard>
        <SectionHeading title="套餐利用率" />
        <p className="p-6 text-center">暂无套餐使用记录</p>
      </BillCard>
    );
  const current = plan.months[Number(data.month.slice(5)) - 1]!;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {data.plans.map((row) => (
          <button
            key={row.providerCode}
            className={buttonSecondary}
            aria-pressed={plan.providerCode === row.providerCode}
            onClick={() => setCode(row.providerCode)}
          >
            {row.providerName}
          </button>
        ))}
      </div>
      {plan.historyIncomplete ? <p role="status" className="text-[13px] text-ql-warning">含未完整计量记录，峰值及利用率按已记录 Token 计算，仅作参考。</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <BillStat label="本月总 Token" value={current.totalTokens} approximate={current.usageIncomplete} tokens />
        <BillStat label="历史最高月 Token" value={plan.peakTokens} approximate={plan.historyIncomplete} tokens />
        <BillStat
          label="本月历史峰值利用率"
          value={analysisPercent(current.utilization, false, plan.historyIncomplete)}
        />
      </div>
      <BillCard>
        <SectionHeading title={`${plan.providerName} 月度 Token`} />
        <Table
          headers={[
            "月份",
            "输入 Token",
            "输出 Token",
            "总 Token",
            "历史峰值利用率",
          ]}
        >
          {plan.months.slice(0, Number(data.month.slice(5))).map((row) => (
            <tr className="border-b border-ql-border-zone" key={row.month}>
              <Cell>{row.month}{row.usageIncomplete ? <span className="ml-1 text-ql-warning">（不完整）</span> : null}</Cell>
              <Num>{analysisTokens(row.inputTokens, row.usageIncomplete)}</Num>
              <Num>{analysisTokens(row.outputTokens, row.usageIncomplete)}</Num>
              <Num>{analysisTokens(row.totalTokens, row.usageIncomplete)}</Num>
              <Num>{analysisPercent(row.utilization, false, plan.historyIncomplete)}</Num>
            </tr>
          ))}
        </Table>
      </BillCard>
    </div>
  );
}
