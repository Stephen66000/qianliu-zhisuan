import { useMemo } from "react";
import type { OperatingAnalysis } from "../../api/operating-analysis";
import { BillCard, SectionHeading } from "./BillShared";
import { formatMoney } from "../../lib/format";

const DECIMAL_SCALE = 100_000_000n;

function decimalAtoms(value: string): bigint | null {
  const match = /^([+-]?)(\d+)(?:\.(\d{0,8}))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[3] ?? "").padEnd(8, "0");
  const atoms = BigInt(match[2]!) * DECIMAL_SCALE + BigInt(fraction || "0");
  return match[1] === "-" ? -atoms : atoms;
}

function decimalText(atoms: bigint): string {
  const negative = atoms < 0n;
  const absolute = negative ? -atoms : atoms;
  const integer = absolute / DECIMAL_SCALE;
  const fraction = String(absolute % DECIMAL_SCALE).padStart(8, "0");
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}

/** Display-only aggregation of already-authoritative response fields. */
function sumKnown(values: Array<string | null>): string | null {
  if (values.some((value) => value === null)) return null;
  let total = 0n;
  for (const value of values) {
    const atoms = decimalAtoms(value!);
    if (atoms === null) return null;
    total += atoms;
  }
  return decimalText(total);
}

function isNonZero(value: string | null): boolean {
  const atoms = value === null ? null : decimalAtoms(value);
  return atoms !== null && atoms !== 0n;
}

function costPerMillion(spend: string | null, tokens: string | null): string | null {
  if (spend === null || tokens === null) return null;
  const spendNumber = Number(spend);
  const tokenNumber = Number(tokens);
  if (!Number.isFinite(spendNumber) || !Number.isFinite(tokenNumber) || tokenNumber <= 0) return null;
  return (spendNumber * 1_000_000 / tokenNumber).toFixed(2);
}

function money(value: string | null): string {
  return value === null ? "—" : `¥ ${formatMoney(value)}`;
}

function apiMoney(value: string | null, currency: string | null, multiCurrency: boolean): string {
  if (multiCurrency) return "多币种（不合并）";
  if (value === null || currency === null) return "—";
  return currency === "CNY" ? money(value) : `${currency} ${formatMoney(value)}`;
}

function tokenBillions(value: string | null): string {
  if (value === null) return "—";
  const tokens = Number(value);
  return Number.isFinite(tokens) ? `${(tokens / 100_000_000).toFixed(2)} 亿` : value;
}

function shanghaiTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(value));
}

interface MonthlyLedgerRow {
  month: string;
  planPaid: string | null;
  apiRecharge: string | null;
  cashOutTotal: string | null;
  apiSpend: string | null;
  planCost: string | null;
  usageSpendTotal: string | null;
  tokensTotal: string | null;
  costPerMillion: string | null;
  activeUsers: number | null;
  endingBalance: string | null;
  apiCurrency: string | null;
  multiCurrency: boolean;
}

export interface FinancialLedgerModel {
  year: string;
  rows: MonthlyLedgerRow[];
  periodLabel: string;
  totals: Omit<MonthlyLedgerRow, "month">;
  officialBalances: NonNullable<OperatingAnalysis["officialApiBalances"]>;
}

export function buildFinancialLedgerModel(analysis: OperatingAnalysis): FinancialLedgerModel {
  const planPurchases = analysis.purchases.filter((item) => item.mode === "CODING_PLAN");
  const rows = analysis.months.flatMap((usage, index): MonthlyLedgerRow[] => {
    if (usage.month > analysis.month || usage.month > analysis.currentMonth) return [];
    const planPaid = sumKnown(planPurchases.map((item) => item.monthlyCash[index] ?? null));
    const accountMonths = analysis.apiAccounts.flatMap((account) => {
      const month = account.months.find((item) => item.month === usage.month);
      if (!month) return [];
      const hasFact = month.openingBalance !== null || month.endingBalance !== null
        || month.apiSpend !== null || isNonZero(month.recharge) || isNonZero(month.paidCny);
      return hasFact ? [{ ...month, currency: account.currency }] : [];
    });
    const currencies = [...new Set(accountMonths.map((item) => item.currency))];
    const multiCurrency = currencies.length > 1;
    const apiCurrency = currencies.length === 1 ? currencies[0]! : null;
    const apiRecharge = accountMonths.length > 0 && !multiCurrency
      ? sumKnown(accountMonths.map((item) => item.paidCny)) : null;
    const apiSpend = accountMonths.length > 0 && !multiCurrency
      ? sumKnown(accountMonths.map((item) => item.apiSpend)) : null;
    const endingBalance = accountMonths.length > 0 && !multiCurrency
      ? sumKnown(accountMonths.map((item) => item.endingBalance)) : null;
    const cashOutTotal = analysis.cashSummary.monthlyCash[index] ?? null;
    const hasFinancialFact = accountMonths.length > 0 || isNonZero(planPaid) || isNonZero(cashOutTotal);
    if (!hasFinancialFact) return [];
    const planCost = planPaid;
    const usageSpendTotal = sumKnown([apiSpend, planCost]);
    return [{
      month: usage.month, planPaid, apiRecharge, cashOutTotal, apiSpend, planCost,
      usageSpendTotal, tokensTotal: usage.totalTokens,
      costPerMillion: costPerMillion(usageSpendTotal, usage.totalTokens),
      activeUsers: usage.activeEmployees, endingBalance, apiCurrency, multiCurrency,
    }];
  });
  const latest = rows.at(-1);
  const multiCurrency = rows.some((row) => row.multiCurrency);
  const apiCurrency = multiCurrency ? null
    : [...new Set(rows.map((row) => row.apiCurrency).filter((value): value is string => value !== null))].at(0) ?? null;
  const usageSpendTotal = sumKnown(rows.map((row) => row.usageSpendTotal));
  const tokensTotal = sumKnown(rows.map((row) => row.tokensTotal));
  const totals = {
    planPaid: sumKnown(rows.map((row) => row.planPaid)),
    apiRecharge: multiCurrency ? null : sumKnown(rows.map((row) => row.apiRecharge)),
    cashOutTotal: analysis.cashSummary.yearCash,
    apiSpend: multiCurrency ? null : sumKnown(rows.map((row) => row.apiSpend)),
    planCost: sumKnown(rows.map((row) => row.planCost)),
    usageSpendTotal,
    tokensTotal,
    costPerMillion: costPerMillion(usageSpendTotal, tokensTotal),
    activeUsers: latest?.activeUsers ?? null,
    endingBalance: multiCurrency ? null : latest?.endingBalance ?? null,
    apiCurrency,
    multiCurrency,
  };
  const firstMonth = rows[0]?.month;
  const lastMonth = rows.at(-1)?.month;
  return {
    year: analysis.month.slice(0, 4), rows,
    periodLabel: firstMonth && lastMonth ? `${firstMonth}~${lastMonth}` : analysis.month,
    totals,
    officialBalances: [...(analysis.officialApiBalances ?? [])]
      .sort((left, right) => right.syncedAt.localeCompare(left.syncedAt)),
  };
}

export function financialLedgerCsv(model: FinancialLedgerModel): string {
  const headers = ["账期月份", "Coding Plan采购实付", "API现金充值", "本月现金流出合计",
    "API实际计价消耗", "套餐计入费用", "本月用量总花费", "实际产出Token",
    "每百万Token花费(元/M)", "活跃人数", "月末账本余额", "余额币种"];
  const raw = (value: string | number | null) => value === null ? "" : String(value);
  const rows = model.rows.map((row) => [row.month, raw(row.planPaid), raw(row.apiRecharge),
    raw(row.cashOutTotal), raw(row.apiSpend), raw(row.planCost), raw(row.usageSpendTotal),
    raw(row.tokensTotal), raw(row.costPerMillion), raw(row.activeUsers), raw(row.endingBalance),
    row.multiCurrency ? "MULTI" : raw(row.apiCurrency)]);
  const total = ["年度累计", raw(model.totals.planPaid), raw(model.totals.apiRecharge),
    raw(model.totals.cashOutTotal), raw(model.totals.apiSpend), raw(model.totals.planCost),
    raw(model.totals.usageSpendTotal), raw(model.totals.tokensTotal),
    raw(model.totals.costPerMillion), raw(model.totals.activeUsers),
    raw(model.totals.endingBalance), model.totals.multiCurrency ? "MULTI" : raw(model.totals.apiCurrency)];
  return "\uFEFF" + [headers, ...rows, total].map((row) => row.join(",")).join("\n");
}

interface FinancialLedgerSectionProps { analysis: OperatingAnalysis }

export function FinancialLedgerSection({ analysis }: FinancialLedgerSectionProps) {
  const model = useMemo(() => buildFinancialLedgerModel(analysis), [analysis]);
  const { rows, totals } = model;
  const multipleOfficialAccounts = model.officialBalances.length > 1;
  const official = model.officialBalances.length === 1 ? model.officialBalances[0]! : null;
  const exportCsv = () => {
    const blob = new Blob([financialLedgerCsv(model)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `仟流智算-财务总台账-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-5" role="region" aria-label="财务账">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">年度实付总采购（现金流出）</div>
          <div className="text-2xl font-bold text-ql-fg tabular-nums">{money(totals.cashOutTotal)}</div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">真实资金事件，不从套餐周期反推付款</div>
        </div>
        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">年度用量总花费（实际核算）</div>
          <div className="text-2xl font-bold text-ql-action tabular-nums">{money(totals.usageSpendTotal)}</div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">API实际消耗 + 套餐计入费用</div>
        </div>
        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">综合每百万 Token 成本</div>
          <div className="text-2xl font-bold text-ql-accent tabular-nums">
            {totals.costPerMillion === null ? "—" : `¥ ${totals.costPerMillion}`} <span className="text-xs font-normal text-ql-fg-secondary">/ M</span>
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">仅在费用与 Token 均完整时展示</div>
        </div>
        <div className="rounded-xl border border-ql-success/40 bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">官方账户可用余额</div>
          <div className="text-2xl font-bold text-ql-success tabular-nums">
            {multipleOfficialAccounts ? "多账户（不合并）"
              : official ? `${official.currency} ${formatMoney(official.balance)}` : "—"}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            {multipleOfficialAccounts ? `共 ${model.officialBalances.length} 个资源，请按资源查看官方余额`
              : official ? `${official.providerName} 官方 API · 同步于 ${shanghaiTime(official.syncedAt)}` : "尚无厂商余额同步快照"}
          </div>
          <div className="text-[11px] text-ql-success mt-1">实际可用资金以厂商官方余额为准</div>
        </div>
        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">仟流内部账本余额</div>
          <div className="text-2xl font-bold text-ql-fg tabular-nums">
            {apiMoney(totals.endingBalance, totals.apiCurrency, totals.multiCurrency)}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">仅核算仟流登记充值与可归因消耗；不会覆盖官方余额</div>
        </div>
      </div>

      <BillCard className="overflow-hidden">
        <div className="p-4 border-b border-ql-border-zone flex items-center justify-between">
          <SectionHeading title={`${model.year} 年度经营收支总台账`} />
          <button className="px-3 py-1.5 rounded-lg border border-ql-border text-xs font-medium hover:bg-ql-surface-subtle text-ql-fg transition"
            onClick={exportCsv} type="button">📥 导出 CSV</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-ql-surface-subtle text-ql-fg-secondary border-b border-ql-border-zone font-medium">
              <tr><th className="p-3">账期月份</th><th className="p-3 text-right">Coding Plan 采购实付</th>
                <th className="p-3 text-right">API 现金充值</th><th className="p-3 text-right font-bold text-ql-fg">本月现金流出合计</th>
                <th className="p-3 text-right">API 实际计价消耗</th><th className="p-3 text-right">套餐计入费用</th>
                <th className="p-3 text-right font-bold text-ql-action">本月用量总花费</th><th className="p-3 text-right">实际产出 Token</th>
                <th className="p-3 text-right font-bold text-ql-accent bg-ql-surface-brand-soft/40">每百万 Token 花费</th>
                <th className="p-3 text-right">活跃人数</th><th className="p-3 text-right">月末账本余额</th></tr>
            </thead>
            <tbody className="divide-y divide-ql-border-zone">
              {rows.length === 0 ? <tr><td className="p-6 text-center text-ql-fg-secondary" colSpan={11}>当前年度尚无已登记资金事实</td></tr>
                : rows.map((row) => <tr className="hover:bg-ql-surface-subtle" key={row.month}>
                  <td className="p-3 font-semibold text-ql-action">{row.month}</td>
                  <td className="p-3 text-right tabular-nums">{money(row.planPaid)}</td>
                  <td className="p-3 text-right tabular-nums">{apiMoney(row.apiRecharge, row.apiCurrency, row.multiCurrency)}</td>
                  <td className="p-3 text-right tabular-nums font-bold text-ql-fg">{money(row.cashOutTotal)}</td>
                  <td className="p-3 text-right tabular-nums">{apiMoney(row.apiSpend, row.apiCurrency, row.multiCurrency)}</td>
                  <td className="p-3 text-right tabular-nums">{money(row.planCost)}</td>
                  <td className="p-3 text-right tabular-nums font-bold text-ql-action">{money(row.usageSpendTotal)}</td>
                  <td className="p-3 text-right tabular-nums">{tokenBillions(row.tokensTotal)}</td>
                  <td className="p-3 text-right tabular-nums font-bold text-ql-accent bg-ql-surface-brand-soft/30">{row.costPerMillion === null ? "—" : `¥ ${row.costPerMillion} / M`}</td>
                  <td className="p-3 text-right tabular-nums">{row.activeUsers === null ? "—" : `${row.activeUsers} 人`}</td>
                  <td className="p-3 text-right tabular-nums text-ql-success font-medium">{apiMoney(row.endingBalance, row.apiCurrency, row.multiCurrency)}</td>
                </tr>)}
            </tbody>
            <tfoot className="bg-ql-surface-subtle font-semibold border-t-2 border-ql-border">
              <tr><td className="p-3 text-ql-fg">年度累计（{model.periodLabel}）</td>
                <td className="p-3 text-right tabular-nums">{money(totals.planPaid)}</td>
                <td className="p-3 text-right tabular-nums">{apiMoney(totals.apiRecharge, totals.apiCurrency, totals.multiCurrency)}</td>
                <td className="p-3 text-right tabular-nums font-bold">{money(totals.cashOutTotal)}</td>
                <td className="p-3 text-right tabular-nums">{apiMoney(totals.apiSpend, totals.apiCurrency, totals.multiCurrency)}</td>
                <td className="p-3 text-right tabular-nums">{money(totals.planCost)}</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-action">{money(totals.usageSpendTotal)}</td>
                <td className="p-3 text-right tabular-nums">{tokenBillions(totals.tokensTotal)}</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-accent bg-ql-surface-brand-soft/50">{totals.costPerMillion === null ? "—" : `¥ ${totals.costPerMillion} / M`}</td>
                <td className="p-3 text-right tabular-nums">{totals.activeUsers === null ? "—" : `${totals.activeUsers} 人`}</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">{apiMoney(totals.endingBalance, totals.apiCurrency, totals.multiCurrency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </BillCard>
    </div>
  );
}
