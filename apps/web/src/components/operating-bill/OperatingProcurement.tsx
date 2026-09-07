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

export function OperatingProcurement({ data }: { data: OperatingAnalysis }) {
  const s = data.cashSummary;
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
                {row.mode === "API" ? "API 充值" : "Coding Plan"}
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
