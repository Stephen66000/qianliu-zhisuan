import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";

import { useDepartmentBill, useSaveDepartmentBudget } from "../../api/v2-hooks";
import type { DepartmentBill } from "../../api/v2-types";
import { formatCount, formatMoney } from "../../lib/format";
import { StatusTag } from "../dashboard/StatusTag";
import { QueryGate } from "../states/QueryGate";
import { INPUT_CLASS } from "../writes/FormField";

const STATUS = {
  NOT_SET: { label: "未设置", tone: "neutral" },
  NORMAL: { label: "正常", tone: "success" },
  WARNING: { label: "已预警", tone: "warning" },
  OVER_BUDGET: { label: "超预算", tone: "danger" },
} as const;

function shanghaiMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  }).format(new Date()).slice(0, 7);
}

export function DepartmentBudgetPanel() {
  const [month, setMonth] = useState(shanghaiMonth);
  const query = useDepartmentBill(month);
  const rows = (query.data?.rows ?? []).filter((row) => !row.isUnassigned);
  return <section className="mb-5 rounded-xl border border-ql-border-zone bg-ql-surface p-4">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-[15px] font-semibold text-ql-fg">部门预算 <span className="ml-1 text-[11px] font-normal text-ql-action">2.0</span></h2>
        <p className="mt-1 text-[12px] text-ql-fg-tertiary">金额预算只用于经营预警，不替代主体 Token 硬额度，也不阻断调用。</p></div>
      <label className="text-[12px] text-ql-fg-secondary">预算月份
        <input aria-label="部门预算月份" className={`${INPUT_CLASS} ml-2 w-40`} onChange={(event) => setMonth(event.target.value)} type="month" value={month}/>
      </label>
    </div>
    <QueryGate emptyDescription="先通过通讯录同步或 Excel 导入建立部门。" emptyIcon={Building2} emptyTitle="暂无部门" error={query.error} isEmpty={rows.length === 0} isLoading={query.isLoading} onRetry={() => void query.refetch()}>
      <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-[12px]">
        <thead><tr className="border-b border-ql-border text-ql-fg-tertiary"><th className="p-2">部门</th><th>月度预算</th><th>归集成本</th><th>实际 Token</th><th>预算使用率</th><th>警戒线</th><th>状态</th><th className="pr-2 text-right">操作</th></tr></thead>
        <tbody>{rows.map((row) => <BudgetRow billStatus={query.data!.status} key={row.departmentId} month={month} row={row}/>)}</tbody>
      </table></div>
    </QueryGate>
  </section>;
}

function BudgetRow({ billStatus, month, row }: {
  billStatus: DepartmentBill["status"];
  month: string;
  row: DepartmentBill["rows"][number];
}) {
  const save = useSaveDepartmentBudget(month);
  const [amount, setAmount] = useState(row.budget?.amount ?? "");
  const [warning, setWarning] = useState(row.budget?.warningThreshold ?? "0.8");
  useEffect(() => {
    setAmount(row.budget?.amount ?? "");
    setWarning(row.budget?.warningThreshold ?? "0.8");
  }, [row.budget?.amount, row.budget?.warningThreshold]);
  const state = STATUS[row.budgetStatus];
  const valid = /^\d+(?:\.\d{1,8})?$/.test(amount)
    && /^\d+(?:\.\d{1,8})?$/.test(warning)
    && Number(warning) > 0 && Number(warning) <= 1;
  return <tr className="border-b border-ql-border-zone last:border-b-0">
    <td className="p-2 font-medium">{row.departmentName}</td>
    <td><input aria-label={`${row.departmentName}月度预算`} className={`${INPUT_CLASS} w-32`} disabled={billStatus === "CLOSED"} min="0" onChange={(event) => setAmount(event.target.value)} placeholder="未设置" step="0.01" type="number" value={amount}/></td>
    <td>{row.totalCost === null ? "—" : `¥${formatMoney(row.totalCost)}`}</td>
    <td className="font-mono">{formatCount(row.actualTokens)}</td>
    <td>{row.budgetUsageRate === null ? "—" : `${(Number(row.budgetUsageRate) * 100).toFixed(1)}%`}</td>
    <td><input aria-label={`${row.departmentName}警戒线`} className={`${INPUT_CLASS} w-24`} disabled={billStatus === "CLOSED"} max="1" min="0.00000001" onChange={(event) => setWarning(event.target.value)} step="0.01" type="number" value={warning}/></td>
    <td><StatusTag tone={state.tone}>{state.label}</StatusTag></td>
    <td className="pr-2 text-right"><button data-write-action className="rounded-lg border border-ql-border px-3 py-2 text-ql-action disabled:opacity-50" disabled={!row.departmentId || !valid || billStatus === "CLOSED" || save.isPending} onClick={() => {
      if (!row.departmentId) return;
      void save.mutateAsync({
        departmentId: row.departmentId, amount, currency: row.budget?.currency ?? "CNY",
        warning_threshold: warning, expected_version: row.budget?.version ?? 0,
      });
    }} type="button">{billStatus === "CLOSED" ? "已结账" : save.isPending ? "保存中" : "保存"}</button>{save.error ? <p className="mt-1 text-[11px] text-ql-danger">{save.error.message}</p> : null}</td>
  </tr>;
}
