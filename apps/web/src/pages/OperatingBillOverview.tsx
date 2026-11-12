import { formatTokens } from "../lib/format";
import type { AnalysisPayment } from "../api/operating-analysis";
import { Link } from "react-router-dom";

import { type OperatingBill } from "../api/operating-bills";
import {
  BillCard,
  SectionHeading,
} from "../components/operating-bill/BillShared";
import { StatusTag } from "../components/dashboard/StatusTag";
import { groupCurrencyAmounts, type CurrencyAmount } from "../lib/currency";
import { resourceStatusLabel } from "../lib/resource-status";
import { Cell, currencyFacts, currencyMoney, Num, Table } from "./OperatingBillShared";
import { BalanceQualityNotice } from "../components/operating-bill/BalanceQualityNotice";
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
    ? formatTokens(String(Math.max(0, allocatedQuotaNum - usedTokensNum)))
    : "不限";

  // WP4-S4（总指挥裁定）：历史/现行分流维度＝bill.status。CLOSED＝已关账历史版本
  // （保留期初/充值/期末等旧口径三卡与原标签，数据源零变化，AFR-06）；DRAFT＝现行
  // 新口径（AFR-07 退役三卡与待补提示；ACE-01/07 估算命名＋综合费用含 API 估算标注）。
  const closed = bill.status === "CLOSED";
  const provisionalBalance = bill.summary.endingBalance === null
    && (bill.summary.provisionalEndingBalances?.length ?? 0) > 0;
  const hasUnknownApiCost = bill.gaps.some((gap) => gap.code === "API_COST_UNKNOWN");
  const requiresUsageReview = bill.gaps.some((gap) => !closed && gap.code === "API_COST_UNKNOWN" && gap.requiresUsageReview !== false);
  const metrics: string[][] = [
    ["本月分配额度", allocatedQuotaNum > 0 ? formatTokens(allocatedQuota!) : "不限"],
    ["本月token使用量", monthTokens === null || monthTokens === undefined ? "—" : formatTokens(monthTokens)],
    ["token使用率", usageRate],
    ["本月剩余额度", remainingQuota],
    ...(closed ? [
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
        provisionalBalance ? "期末余额（暂算）" : "期末余额",
        provisionalBalance
          ? currencyFacts(bill.summary.provisionalEndingBalances, null)
          : currencyFacts(bill.summary.endingBalances, bill.summary.endingBalance, bill.summary.endingBalanceCurrency),
      ],
      ["API 花费", currencyFacts(apiSpends, null)],
    ] : [
      // ACE-01/AFR-07：现行月 API 金额＝估算口径命名；gaps 含 API_COST_UNKNOWN 时附完整性提示。
      [
        hasUnknownApiCost ? "API费用估算（含待计价）" : "API费用估算",
        currencyFacts(apiSpends, null),
      ],
    ]),
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
    // ACE-07：综合费用＝套餐计入费用＋API 费用估算（按币种），标注含 API 估算口径；
    // CLOSED 历史版本保留原"本月总花费"标签（旧口径，不冒充估算）。
    [closed ? "本月总花费" : "综合费用（含 API 估算）", currencyFacts(totalSpends, null)],
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
      {/* WP4-S4（AFR-07／WP2 遗留③）：API_OPENING_BALANCE_MISSING/OPENING_BALANCE_MISSING
          已随后端停产（monthly-operating-cost.ts 改产 BRIDGE_UNAVAILABLE 且不产缺口），
          "期初余额未登记→补充资金记录"提示整段退役；现行视图不据此阻断费用估算。 */}
      <BalanceQualityNotice gaps={bill.gaps} provisionalBalance={provisionalBalance} />
      {requiresUsageReview ? <p role="alert" className="rounded-lg bg-ql-warning-soft p-3 text-[13px] text-ql-warning">存在尚未计价的 API 请求，当前金额仅包含已确认部分。<Link className="underline" to="/usage">核查用量</Link></p>:null}
      <BillCard className="overflow-hidden">
        <SectionHeading title="厂商投入构成" />
        <Table
          headers={[
            "厂商 / 资源",
            "采购形态",
            // CLOSED 历史版本保留原列名（冻结值可能为旧资金口径，AFR-06 不改名冒充估算）；
            // DRAFT 现行月数据源为同源估算（WP1 合同 §3），按 ACE-01 统一命名。
            closed ? "API 花费" : "API费用估算",
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
                <span className="block text-[13px] text-ql-fg-tertiary">
                  {row.resourceName}
                </span>
              </Cell>
              <Cell>{row.mode === "API" ? "API" : "Coding Plan"}</Cell>
              <Num>
                {row.apiCost === null
                  ? (row.apiSpendStatus === "BRIDGE_UNAVAILABLE"
                    // WP4-S4（WP1 合同 §5④）：桥接不可算属历史资金口径事实，
                    // 用中性说明，不与估算缺口文案混格。
                    ? "桥接不可核算（历史资金口径）"
                    : row.apiSpendReason ?? "—")
                  : currencyMoney(row.apiCost, row.apiSpendCurrency ?? row.currency)}
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
                  {resourceStatusLabel(row.status, row.mode)}
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
