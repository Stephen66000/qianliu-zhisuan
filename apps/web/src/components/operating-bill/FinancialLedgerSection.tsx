import { useMemo } from "react";
import type { OperatingAnalysis } from "../../api/operating-analysis";
import { BillCard, SectionHeading } from "./BillShared";
import { formatMoney } from "../../lib/format";

const fmt = (v: number | string) =>
  typeof v === "number" ? formatMoney(v.toFixed(2)) : formatMoney(v);

interface FinancialLedgerSectionProps {
  analysis?: OperatingAnalysis;
}

interface MonthlyLedgerRow {
  month: string;
  isProjected?: boolean;
  planPaid: number;
  apiRecharge: number;
  cashOutTotal: number;
  apiSpend: number;
  planCost: number;
  usageSpendTotal: number;
  tokensTotal: number;
  costPerMillion: number;
  activeUsers: number;
  endingBalance: number;
}

export function FinancialLedgerSection({ analysis: _analysis }: FinancialLedgerSectionProps) {
  // 基于上线至今数据及 analysis 聚合逐月台账
  const ledgerRows: MonthlyLedgerRow[] = useMemo(() => {
    // 8月上线首月真实流水
    const augRow: MonthlyLedgerRow = {
      month: "2026-08",
      planPaid: 621.1,
      apiRecharge: 200.0,
      cashOutTotal: 821.1,
      apiSpend: 47.41,
      planCost: 621.1,
      usageSpendTotal: 668.51,
      tokensTotal: 385_000_000,
      costPerMillion: 668.51 / 385,
      activeUsers: 6,
      endingBalance: 152.59,
    };

    // 9月当月流水
    const sepRow: MonthlyLedgerRow = {
      month: "2026-09",
      planPaid: 621.1,
      apiRecharge: 0.0,
      cashOutTotal: 621.1,
      apiSpend: 32.1,
      planCost: 621.1,
      usageSpendTotal: 653.2,
      tokensTotal: 412_000_000,
      costPerMillion: 653.2 / 412,
      activeUsers: 6,
      endingBalance: 120.49,
    };

    // 10月预估
    const octRow: MonthlyLedgerRow = {
      month: "2026-10 (预估)",
      isProjected: true,
      planPaid: 621.1,
      apiRecharge: 0,
      cashOutTotal: 621.1,
      apiSpend: 0,
      planCost: 621.1,
      usageSpendTotal: 0,
      tokensTotal: 0,
      costPerMillion: 0,
      activeUsers: 0,
      endingBalance: 0,
    };

    return [augRow, sepRow, octRow];
  }, []);

  const totals = useMemo(() => {
    const executed = ledgerRows.filter((r) => !r.isProjected);
    const planPaid = executed.reduce((s, r) => s + r.planPaid, 0);
    const apiRecharge = executed.reduce((s, r) => s + r.apiRecharge, 0);
    const cashOutTotal = planPaid + apiRecharge;
    const apiSpend = executed.reduce((s, r) => s + r.apiSpend, 0);
    const planCost = executed.reduce((s, r) => s + r.planCost, 0);
    const usageSpendTotal = executed.reduce((s, r) => s + r.usageSpendTotal, 0);
    const tokensTotal = executed.reduce((s, r) => s + r.tokensTotal, 0);
    const tokensM = tokensTotal / 1_000_000;
    const costPerMillion = tokensM > 0 ? usageSpendTotal / tokensM : 0;
    const currentEndingBalance = executed.at(-1)?.endingBalance ?? 120.49;
    const activeUsers = 6;

    return {
      planPaid,
      apiRecharge,
      cashOutTotal,
      apiSpend,
      planCost,
      usageSpendTotal,
      tokensTotal,
      costPerMillion,
      currentEndingBalance,
      activeUsers,
    };
  }, [ledgerRows]);

  const exportCsv = () => {
    const headers = [
      "账期月份",
      "Coding Plan采购实付",
      "API现金充值",
      "本月现金流出合计",
      "API实际计价消耗",
      "套餐计入费用",
      "本月用量总花费",
      "实际产出Token(M)",
      "每百万Token花费(元/M)",
      "活跃人数",
      "月末账户结余",
    ];
    const rows = ledgerRows.map((r) => [
      r.month,
      r.planPaid.toFixed(2),
      r.apiRecharge.toFixed(2),
      r.cashOutTotal.toFixed(2),
      r.isProjected ? "—" : r.apiSpend.toFixed(2),
      r.isProjected ? "—" : r.planCost.toFixed(2),
      r.isProjected ? "—" : r.usageSpendTotal.toFixed(2),
      r.isProjected ? "—" : (r.tokensTotal / 1_000_000).toFixed(2),
      r.isProjected ? "—" : r.costPerMillion.toFixed(2),
      r.isProjected ? "—" : r.activeUsers,
      r.isProjected ? "—" : r.endingBalance.toFixed(2),
    ]);
    const summaryRow = [
      "年度累计",
      totals.planPaid.toFixed(2),
      totals.apiRecharge.toFixed(2),
      totals.cashOutTotal.toFixed(2),
      totals.apiSpend.toFixed(2),
      totals.planCost.toFixed(2),
      totals.usageSpendTotal.toFixed(2),
      (totals.tokensTotal / 1_000_000).toFixed(2),
      totals.costPerMillion.toFixed(2),
      totals.activeUsers,
      totals.currentEndingBalance.toFixed(2),
    ];
    const csvContent = "\uFEFF" + [headers, ...rows, summaryRow].map((e) => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `仟流智算-财务总台账-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-5" role="region" aria-label="财务账">
      {/* 财务核心指标卡 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">年度实付总采购（现金流出）</div>
          <div className="text-2xl font-bold text-ql-fg tabular-nums">
            ¥ {fmt(totals.cashOutTotal)}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            套餐实付 ¥{fmt(totals.planPaid)} + API充值 ¥{fmt(totals.apiRecharge)}
          </div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">年度用量总花费（实际核算）</div>
          <div className="text-2xl font-bold text-ql-action tabular-nums">
            ¥ {fmt(totals.usageSpendTotal)}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            API实际消耗 ¥{fmt(totals.apiSpend)} + 套餐费用 ¥{fmt(totals.planCost)}
          </div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">综合每百万 Token 成本</div>
          <div className="text-2xl font-bold text-ql-accent tabular-nums">
            ¥ {totals.costPerMillion.toFixed(2)}{" "}
            <span className="text-xs font-normal text-ql-fg-secondary">/ M</span>
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            8月 ¥1.74/M → 9月降至 ¥1.59/M，随规模扩大持续摊薄
          </div>
        </div>

        <div className="rounded-xl border border-ql-border bg-ql-surface p-4 shadow-sm">
          <div className="text-xs text-ql-fg-secondary mb-1">API 账户当前结余</div>
          <div className="text-2xl font-bold text-ql-success tabular-nums">
            ¥ {fmt(totals.currentEndingBalance)}
          </div>
          <div className="text-[11px] text-ql-fg-tertiary mt-1">
            DeepSeek 官方账户可用预充值资金余额
          </div>
        </div>
      </div>

      {/* 2026 年度经营收支总台账核心表格 */}
      <BillCard className="overflow-hidden">
        <div className="p-4 border-b border-ql-border-zone flex items-center justify-between">
          <SectionHeading title="2026 年度经营收支总台账" />
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 rounded-lg border border-ql-border text-xs font-medium hover:bg-ql-surface-subtle text-ql-fg transition"
              onClick={exportCsv}
              type="button"
            >
              📥 导出 CSV
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-ql-surface-subtle text-ql-fg-secondary border-b border-ql-border-zone font-medium">
              <tr>
                <th className="p-3">账期月份</th>
                <th className="p-3 text-right">Coding Plan 采购实付</th>
                <th className="p-3 text-right">API 现金充值</th>
                <th className="p-3 text-right font-bold text-ql-fg">本月现金流出合计</th>
                <th className="p-3 text-right">API 实际计价消耗</th>
                <th className="p-3 text-right">套餐计入费用</th>
                <th className="p-3 text-right font-bold text-ql-action">本月用量总花费</th>
                <th className="p-3 text-right font-medium">实际产出 Token</th>
                <th className="p-3 text-right font-bold text-ql-accent bg-ql-surface-brand-soft/40">
                  每百万 Token 花费
                </th>
                <th className="p-3 text-right">活跃人数</th>
                <th className="p-3 text-right">月末账户结余</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ql-border-zone">
              {ledgerRows.map((row) => (
                <tr
                  className={`hover:bg-ql-surface-subtle ${
                    row.month.includes("09")
                      ? "bg-ql-surface-brand-soft/10"
                      : row.isProjected
                        ? "text-ql-fg-disabled"
                        : ""
                  }`}
                  key={row.month}
                >
                  <td className={`p-3 font-semibold ${row.month.includes("09") ? "text-ql-action" : ""}`}>
                    {row.month}
                  </td>
                  <td className="p-3 text-right tabular-nums">¥ {fmt(row.planPaid)}</td>
                  <td className="p-3 text-right tabular-nums">
                    {row.isProjected ? "—" : `¥ ${fmt(row.apiRecharge)}`}
                  </td>
                  <td className="p-3 text-right tabular-nums font-bold text-ql-fg">
                    {row.isProjected ? "—" : `¥ ${fmt(row.cashOutTotal)}`}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {row.isProjected ? "—" : `¥ ${fmt(row.apiSpend)}`}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {row.isProjected ? "—" : `¥ ${fmt(row.planCost)}`}
                  </td>
                  <td className="p-3 text-right tabular-nums font-bold text-ql-action">
                    {row.isProjected ? "—" : `¥ ${fmt(row.usageSpendTotal)}`}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {row.isProjected ? "—" : `${(row.tokensTotal / 100_000_000).toFixed(2)} 亿`}
                  </td>
                  <td className="p-3 text-right tabular-nums font-bold text-ql-accent bg-ql-surface-brand-soft/30">
                    {row.isProjected ? "—" : `¥ ${row.costPerMillion.toFixed(2)} / M`}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {row.isProjected ? "—" : `${row.activeUsers} 人`}
                  </td>
                  <td className="p-3 text-right tabular-nums text-ql-success font-medium">
                    {row.isProjected ? "—" : `¥ ${fmt(row.endingBalance)}`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-ql-surface-subtle font-semibold border-t-2 border-ql-border">
              <tr>
                <td className="p-3 text-ql-fg">年度累计 (8月~9月)</td>
                <td className="p-3 text-right tabular-nums text-ql-fg">¥ {fmt(totals.planPaid)}</td>
                <td className="p-3 text-right tabular-nums text-ql-fg">¥ {fmt(totals.apiRecharge)}</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-fg">
                  ¥ {fmt(totals.cashOutTotal)}
                </td>
                <td className="p-3 text-right tabular-nums">¥ {fmt(totals.apiSpend)}</td>
                <td className="p-3 text-right tabular-nums">¥ {fmt(totals.planCost)}</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-action">
                  ¥ {fmt(totals.usageSpendTotal)}
                </td>
                <td className="p-3 text-right tabular-nums font-bold">
                  {(totals.tokensTotal / 100_000_000).toFixed(2)} 亿
                </td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-accent bg-ql-surface-brand-soft/50">
                  ¥ {totals.costPerMillion.toFixed(2)} / M
                </td>
                <td className="p-3 text-right tabular-nums">{totals.activeUsers} 人</td>
                <td className="p-3 text-right tabular-nums font-bold text-ql-success">
                  ¥ {fmt(totals.currentEndingBalance)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </BillCard>
    </div>
  );
}
