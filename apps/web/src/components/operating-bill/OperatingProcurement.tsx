import type { OperatingAnalysis } from "../../api/operating-analysis";
import {
  Cell,
  currencyMoney,
  Num,
  Table,
} from "../../pages/OperatingBillShared";
import { BillCard, SectionHeading } from "./BillShared";
import { BillStat } from "./BillStat";
import { analysisPercent } from "./OperatingTrends";

export function OperatingProcurement({ data, status }: {
  data: OperatingAnalysis;
  /** 历史/现行分流维度（总指挥裁定）：CLOSED＝已关账历史版本，保留资金轨迹旧口径列；缺省按现行 DRAFT 处理。 */
  status?: "DRAFT" | "CLOSED";
}) {
  const s = data.cashSummary;
  const closed = status === "CLOSED";
  const utilization = (code: string, index: number) => {
    const plan = data.plans.find((row) => row.providerCode === code);
    return analysisPercent(plan?.months[index]?.utilization ?? null);
  };
  const subscriptionCost = (code: string, index: number) => {
    const purchase = data.purchases.find((row) => row.providerCode === code && row.mode === "CODING_PLAN");
    return purchase ? purchase.monthlyCash[index] ?? null : "0";
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <BillStat
          label="年度实付累计"
          value={currencyMoney(s.yearCash, "CNY")}
        />
        <BillStat
          label="月均采购实付"
          value={currencyMoney(s.averageCash, "CNY")}
        />
        <BillStat
          label="最高采购月份"
          value={
            s.highestMonths
              .map((month) => `${Number(month.slice(5))} 月`)
              .join("、") || "—"
          }
        />
      </div>
      <BillCard>
        <SectionHeading title="年度采购实付" />
        <Table
          headers={[
            "厂商 / 购买类型",
            ...Array.from({ length: 12 }, (_, i) => `${i + 1} 月`),
            "年度合计",
          ]}
        >
          {data.purchases.map((row) => (
            <tr
              className="border-b border-ql-border-zone"
              key={`${row.providerCode}:${row.mode}`}
            >
              <Cell>
                {row.providerName} ·{" "}
                {/* WP4-S4（对齐 S3 MonthlyPayments）：API 充值采购行为历史实付事实，加历史口径标注。 */}
                {row.mode === "API" ? "API 充值（历史）" : "Coding Plan"}
              </Cell>
              {row.monthlyCash.map((value, i) => (
                <Num key={i}>{currencyMoney(value, "CNY")}</Num>
              ))}
              <Num>{currencyMoney(row.yearCash, "CNY")}</Num>
            </tr>
          ))}
          <tr className="bg-ql-surface-subtle">
            <Cell>月度总计</Cell>
            {s.monthlyCash.map((value, i) => (
              <Num key={i}>{currencyMoney(value, "CNY")}</Num>
            ))}
            <Num>{currencyMoney(s.yearCash, "CNY")}</Num>
          </tr>
        </Table>
      </BillCard>
      {data.apiAccounts.map((account) => (
        <BillCard key={`${account.providerCode}:${account.currency}`}>
          <SectionHeading
            title={`${account.providerName} 采购与使用月度复盘（${account.currency}）`}
          />
          {closed ? (
            <Table
              headers={[
                "月份",
                "期初余额",
                "充值到账",
                "实付（人民币）",
                "API 消耗",
                "期末余额",
              ]}
            >
              {account.months
                .slice(0, Number(data.month.slice(5)))
                .map((row) => (
                  <tr className="border-b border-ql-border-zone" key={row.month}>
                    <Cell>{row.month}</Cell>
                    {[row.openingBalance, row.recharge].map((value, j) => (
                      <Num key={j}>{currencyMoney(value, account.currency)}</Num>
                    ))}
                    <Num>{currencyMoney(row.paidCny, "CNY")}</Num>
                    <Num>{currencyMoney(row.apiSpend, account.currency)}</Num>
                    <Num>
                      {currencyMoney(row.endingBalance, account.currency)}
                    </Num>
                  </tr>
                ))}
              <tr className="bg-ql-surface-subtle">
                <Cell>年度汇总</Cell>
                <Num>
                  {currencyMoney(account.totals.openingBalance, account.currency)}
                </Num>
                <Num>
                  {currencyMoney(account.totals.recharge, account.currency)}
                </Num>
                <Num>{currencyMoney(account.totals.paidCny, "CNY")}</Num>
                <Num>
                  {currencyMoney(account.totals.apiSpend, account.currency)}
                </Num>
                <Num>
                  {currencyMoney(account.totals.endingBalance, account.currency)}
                </Num>
              </tr>
            </Table>
          ) : (
            // WP4-S4（AFR-07／总指挥裁定）：现行月退役期初余额/充值到账/期末余额
            // 资金轨迹列；API 消耗列数据源为同源估算（operating-analysis-repository
            // S3c：apiSpend 由 loadApiCostEstimation 供给），按 ACE-01 改"API 费用估算"；
            // 实付（人民币）为现金实付事实（O1a 域），保留。
            <Table
              headers={[
                "月份",
                "实付（人民币）",
                "API 费用估算",
              ]}
            >
              {account.months
                .slice(0, Number(data.month.slice(5)))
                .map((row) => (
                  <tr className="border-b border-ql-border-zone" key={row.month}>
                    <Cell>{row.month}</Cell>
                    <Num>{currencyMoney(row.paidCny, "CNY")}</Num>
                    <Num>{currencyMoney(row.apiSpend, account.currency)}</Num>
                  </tr>
                ))}
              <tr className="bg-ql-surface-subtle">
                <Cell>年度汇总</Cell>
                <Num>{currencyMoney(account.totals.paidCny, "CNY")}</Num>
                <Num>
                  {currencyMoney(account.totals.apiSpend, account.currency)}
                </Num>
              </tr>
            </Table>
          )}
        </BillCard>
      ))}
      <BillCard>
        <SectionHeading title="套餐采购与峰值利用率" />
        <Table headers={["月份", "Kimi 订阅花费", "Kimi 峰值利用率", "智谱采购费用", "智谱峰值利用率"]}>
          {data.months.slice(0, Number(data.month.slice(5))).map((row, i) => (
            <tr className="border-b border-ql-border-zone" key={row.month}>
              <Cell>{row.month}</Cell>
              <Num>{currencyMoney(subscriptionCost("kimi", i), "CNY")}</Num>
              <Num>{utilization("kimi", i)}</Num>
              <Num>{currencyMoney(subscriptionCost("zhipu", i), "CNY")}</Num>
              <Num>{utilization("zhipu", i)}</Num>
            </tr>
          ))}
        </Table>
      </BillCard>
    </div>
  );
}
