import type { OperatingAnalysis } from "../../api/operating-analysis";
import { formatDecimal } from "../../lib/format";
import { Cell, Num, Table } from "../../pages/OperatingBillShared";
import { BillCard, SectionHeading } from "./BillShared";
import { BillStat } from "./BillStat";

export const analysisTokens = (value: string | null) =>
  value === null ? "—" : formatDecimal(value, 2);
export const analysisPercent = (value: string | null, signed = false) =>
  value === null
    ? "—"
    : `${signed && Number(value) > 0 ? "+" : ""}${formatDecimal(value, 2)}%`;
export function OperatingTrends({ data }: { data: OperatingAnalysis }) {
  const s = data.summary,
    months = data.months.slice(0, Number(data.month.slice(5))),
    recent = months.slice(-3);
  return (
    <div className="operating-report space-y-4">
      <h2 className="text-[16px] font-semibold">AI 使用趋势</h2>
      <div className="bill-five-stats">
        <BillStat label="公司当月使用 Token" value={s.companyTokens} tokens />
        <BillStat
          label="公司月均 Token"
          value={s.ytdAverageTokens}
          tokens
        />
        <BillStat
          label="公司月均环比"
          value={analysisPercent(s.ytdAverageChange, true)}
        />
        <BillStat label="本月人均 Token" value={s.perCapitaTokens} tokens />
        <BillStat
          label="本月人均环比"
          value={analysisPercent(s.perCapitaChange, true)}
        />
      </div>
      <BillCard>
        <SectionHeading title="近三个月" />
        <div className="grid gap-6 px-4 pb-4 lg:grid-cols-3">
          {(
            [
              ["公司总 Token", "totalTokens"],
              ["公司人均 Token", "perCapitaTokens"],
              ["项目 Token", "projectTokens"],
            ] as const
          ).map(([title, key]) => {
            const maximum = Math.max(
              1,
              ...recent.map((row) => Number(row[key] ?? 0)),
            );
            return (
              <div key={key}>
                <h3 className="mb-3 text-[13px] font-medium">{title}</h3>
                {recent.map((row) => (
                  <div
                    key={row.month}
                    className="mb-2 grid grid-cols-[32px_1fr] items-center gap-2 text-[12px]"
                  >
                    <span>{Number(row.month.slice(5))} 月</span>
                    <div>
                      <span className="block text-right tabular-nums">
                        {analysisTokens(row[key])}
                      </span>
                      <div className="h-2 bg-ql-surface-subtle">
                        <div
                          className="h-2 bg-ql-action"
                          style={{
                            width: `${(Number(row[key] ?? 0) / maximum) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </BillCard>
      <BillCard>
        <SectionHeading title="月度明细" />
        <Table
          headers={[
            "月份",
            "公司总 Token",
            "员工 Token",
            "项目 Token",
            "系统员工人数",
            "使用人数",
            "本月人均 Token",
          ]}
        >
          {months.map((row) => (
            <tr className="border-b border-ql-border-zone" key={row.month}>
              <Cell>{row.month}</Cell>
              <Num>{analysisTokens(row.totalTokens)}</Num>
              <Num>{analysisTokens(row.employeeTokens)}</Num>
              <Num>{analysisTokens(row.projectTokens)}</Num>
              <Num>{row.employeeCount ?? "—"}</Num>
              <Num>{row.activeEmployees ?? "—"}</Num>
              <Num>{analysisTokens(row.perCapitaTokens)}</Num>
            </tr>
          ))}
        </Table>
      </BillCard>
    </div>
  );
}
