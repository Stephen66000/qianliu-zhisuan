import { formatCount } from "../lib/format";
import type { AnalysisPayment } from "../api/operating-analysis";
import { Link } from "react-router-dom";

import { type OperatingBill } from "../api/operating-bills";
import {
  BillCard,
  SectionHeading,
} from "../components/operating-bill/BillShared";
import { StatusTag } from "../components/dashboard/StatusTag";
import { groupCurrencyAmounts, type CurrencyAmount } from "../lib/currency";
import { Cell, currencyFacts, currencyMoney, money, Num, Table } from "./OperatingBillShared";
import { BillStat } from "../components/operating-bill/BillStat";
import { MonthlyPayments } from "../components/operating-bill/MonthlyPayments";

export function OperatingBillOverview({
  bill,
  planUtilization,
  payments,
  monthTokens,
}: {
  bill: OperatingBill;
  planUtilization?: string | null;
  payments?: AnalysisPayment[];
  monthTokens?: string | null;
}) {
  const apiSpends = compatibleProviderAmounts(
    bill.summary.apiSpends, bill.providers, "API", "apiCost", "apiSpendCurrency",
    bill.summary.apiCost, bill.summary.endingBalanceCurrency,
  );
  const packageCosts = compatibleProviderAmounts(
    bill.summary.packageCosts, bill.providers, "CODING_PLAN", "packageCost",
    "packageCostCurrency", bill.summary.packageCost, null,
  );
  const totalSpends = compatibleTotalAmounts(bill);
  const allocatedQuota = bill.summary.totalAllocatedQuota;
  const allocatedQuotaNum = allocatedQuota ? Number(allocatedQuota) : 0;
  const usedTokensNum = monthTokens ? Number(monthTokens) : 0;
  const usageRate = allocatedQuotaNum > 0 && monthTokens !== null && monthTokens !== undefined
    ? `${((usedTokensNum / allocatedQuotaNum) * 100).toFixed(1)}%`
    : "—";
  const remainingQuota = allocatedQuotaNum > 0 && monthTokens !== null && monthTokens !== undefined
    ? formatCount(String(Math.max(0, allocatedQuotaNum - usedTokensNum)))
    : "不限";

  const metrics = [
    ["本月分配额度", allocatedQuotaNum > 0 ? formatCount(allocatedQuota!) : "不限"],
    ["本月token使用量", monthTokens === null || monthTokens === undefined ? "—" : formatCount(monthTokens)],
    ["token使用率", usageRate],
    ["本月剩余额度", remainingQuota],
    [
      "期初余额",
      currencyFacts(bill.summary.openingBalances, bill.summary.openingBalance ?? null, bill.summary.endingBalanceCurrency),
    ],
    [
      "本月充值",
      currencyFacts(
        bill.summary.rechargeAmounts,
        bill.summary.monthlyRecharge ?? null,
        bill.summary.endingBalanceCurrency,
      ),
    ],
    [
      "期末余额",
      currencyFacts(bill.summary.endingBalances, bill.summary.endingBalance, bill.summary.endingBalanceCurrency),
    ],
    ["API 花费", currencyFacts(apiSpends, null)],
    [
      "套餐费用",
      currencyFacts(
        packageCosts,
        bill.summary.packageCost !== null &&
          Number(bill.summary.packageCost) === 0
          ? "0"
          : null,
        "CNY",
      ),
    ],
    ["本月总花费", currencyFacts(totalSpends, null)],
    [
      "套餐综合利用率",
      (planUtilization === undefined
        ? bill.summary.planUtilization
        : planUtilization) !== null
        ? `${planUtilization === undefined ? bill.summary.planUtilization : planUtilization}%`
        : "—",
    ],
    ["活跃主体", String(bill.summary.activePrincipalCount)],
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value]) => (
          <BillStat key={label} label={label!} value={value!} />
        ))}
      </div>
      {bill.providers.some(
        (row) => row.mode === "API" && row.openingBalance === null,
      ) ? (
        <p
          role="alert"
          className="rounded-lg bg-ql-warning-soft p-3 text-[13px] text-ql-warning"
        >
          期初余额未登记，请前往{" "}
          <Link className="underline" to="/resources">
            厂商资源
          </Link>{" "}
          补充资金记录。
        </p>
      ) : null}
      {bill.gaps.some(gap=>gap.code==='API_COST_UNKNOWN')?<p role="alert" className="rounded-lg bg-ql-warning-soft p-3 text-[13px] text-ql-warning">存在尚未计价的 API 请求，当前金额仅包含已确认部分。<Link className="underline" to="/usage">核查用量</Link></p>:null}
      <BillCard className="overflow-hidden">
        <SectionHeading title="厂商投入构成" />
        <Table
          headers={[
            "厂商 / 资源",
            "采购形态",
            "API 花费",
            "套餐费用",
            "月度花费",
            "使用主体",
            "状态",
          ]}
        >
          {bill.providers.map((row) => (
            <tr
              className="border-b border-ql-border-zone"
              key={row.providerResourceId}
            >
              <Cell>
                {row.providerName}
                <span className="block text-[11px] text-ql-fg-tertiary">
                  {row.resourceName}
                </span>
              </Cell>
              <Cell>{row.mode === "API" ? "API" : "Coding Plan"}</Cell>
              <Num>
                {row.apiCost === null ? (row.apiSpendReason ?? "—") : currencyMoney(row.apiCost, row.apiSpendCurrency ?? row.currency)}
              </Num>
              <Num>
                {currencyMoney(
                  row.packageCost,
                  row.packageCostCurrency ?? row.currency,
                )}
              </Num>
              <Num>
                {currencyMoney(row.totalCost, row.apiSpendCurrency ?? row.packageCostCurrency ?? row.currency)}
              </Num>
              <Num>{row.activePrincipalCount}</Num>
              <Cell>
                <StatusTag
                  tone={row.status === "ACTIVE" ? "success" : "warning"}
                >
                  {row.status}
                </StatusTag>
              </Cell>
            </tr>
          ))}
        </Table>
      </BillCard>
      <MonthlyPayments bill={bill} payments={payments} />
    </div>
  );
}

type CostProvider = OperatingBill["providers"][number];
function compatibleProviderAmounts(
  facts: CurrencyAmount[] | undefined,
  providers: CostProvider[],
  mode: "API" | "CODING_PLAN",
  amountField: "apiCost" | "packageCost",
  currencyField: "apiSpendCurrency" | "packageCostCurrency",
  fallbackAmount: string | null,
  fallbackCurrency: string | null,
): CurrencyAmount[] {
  if (Array.isArray(facts)) return facts;
  const rows = providers.filter((provider) => provider.mode === mode);
  if (rows.length > 0) {
    const projected = rows.map((provider) => ({
      amount: provider[amountField],
      currency: provider[currencyField] ?? provider.currency,
    }));
    if (!projected.every((fact): fact is CurrencyAmount =>
      fact.amount !== null && fact.currency !== null)) return [];
    return groupCurrencyAmounts(projected);
  }
  return fallbackAmount !== null && fallbackCurrency !== null
    ? [{ amount: fallbackAmount, currency: fallbackCurrency }] : [];
}

function compatibleTotalAmounts(bill: OperatingBill): CurrencyAmount[] {
  if (Array.isArray(bill.summary.totalSpends)) return bill.summary.totalSpends;
  if (bill.providers.length > 0) {
    const hasApiRows = bill.providers.some(
      (provider) => provider.mode === "API",
    );
    const hasPlanRows = bill.providers.some((provider) => provider.mode === "CODING_PLAN");
    const isNonZero = (value: string | null) => value !== null && !/^0+(?:\.0+)?$/.test(value);
    if ((isNonZero(bill.summary.apiCost) && !hasApiRows)
      || (isNonZero(bill.summary.packageCost) && !hasPlanRows)) return [];
    const projected = bill.providers.map((provider) => ({
      amount: provider.mode === "API" ? provider.apiCost : provider.packageCost,
      currency:
        provider.mode === "API"
          ? (provider.apiSpendCurrency ?? provider.currency)
          : (provider.packageCostCurrency ?? provider.currency),
    }));
    if (!projected.every((fact): fact is CurrencyAmount =>
      fact.amount !== null && fact.currency !== null)) return [];
    return groupCurrencyAmounts(projected);
  }
  return [];
}

/** CSV 快照解析器：只负责结构校验与字段保留，不推断厂商事实。 */
export function parseSnapshotCsv(text: string): Array<{ provider_resource_id: string; snapshot: Record<string, unknown> }> {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const parseLine = (line: string) => {
    const values: string[] = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]!;
      if (char === '"' && line[i + 1] === '"' && quoted) {
        value += '"';
        i += 1;
      } else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        values.push(value.trim());
        value = "";
      } else value += char;
    }
    if (quoted) throw new Error("CSV 引号未闭合");
    values.push(value.trim());
    return values;
  };
  if (lines.length < 2) throw new Error("CSV 至少需要表头和一行数据");
  const headers = parseLine(lines[0]!);
  if (!headers.includes("provider_resource_id") || !headers.includes("collected_at")) throw new Error("CSV 缺少 provider_resource_id 或 collected_at 表头");
  return lines.slice(1).map((line, index) => {
    const values = parseLine(line);
    const record: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      const cell = values[i]?.trim();
      if (cell) record[header] = cell;
    });
    const providerResourceId = String(record.provider_resource_id ?? "");
    delete record.provider_resource_id;
    if (!providerResourceId) throw new Error(`CSV 第 ${index + 2} 行缺少资源 ID`);
    return { provider_resource_id: providerResourceId, snapshot: record };
  });
}
