import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";

import {
  type OperatingBill,
  useCloseOperatingBill,
  useConfirmOperatingBillValue,
  useCreateOperatingBillValue,
  useImportOperatingBillSnapshots,
  useOperatingBill,
  useReopenOperatingBill,
} from "../api/operating-bills";
import { BillCard, buttonPrimary, buttonSecondary, inputClass, Meter, SectionHeading } from "../components/operating-bill/BillShared";
import {
  operatingBillMonth,
  OperatingBillShell,
  type OperatingBillSection,
} from "../components/operating-bill/OperatingBillShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { MoneyAmountInput, validateMoneyAmount } from "../components/writes/MoneyAmountInput";
import { formatMoney } from "../lib/format";

type TabId = Exclude<OperatingBillSection, "employees" | "projects">;
function isTabId(value: string | null): value is TabId {
  return value === "overview" || value === "plans" || value === "value" || value === "closing";
}
function money(value: string | null): string { return value === null ? "—" : `¥${formatMoney(value)}`; }

export function OperatingBillPage() {
  const [params] = useSearchParams();
  const month = operatingBillMonth(params.get("month"));
  const requestedTab = params.get("tab");
  const activeTab: TabId = isTabId(requestedTab) ? requestedTab : "overview";
  const query = useOperatingBill(month);
  useRedirectOnUnauthorized(query.error);
  if (requestedTab === "subjects") {
    return <Navigate replace to={`/operating-bill/employees?month=${month}`} />;
  }
  return <OperatingBillShell active={activeTab} month={month} status={query.data?.status} version={query.data?.version}>
    {query.isLoading ? <LoadingState label="正在汇总月度经营账单…" rows={5} /> : query.error || !query.data ? <ErrorState message={query.error?.message ?? "经营账单加载失败"} onRetry={() => void query.refetch()} /> : <BillTab bill={query.data} tab={activeTab} />}
  </OperatingBillShell>;
}

function BillTab({ bill, tab }: { bill: OperatingBill; tab: TabId }) {
  if (tab === "overview") return <Overview bill={bill} />;
  if (tab === "plans") return <Plans bill={bill} />;
  if (tab === "value") return <Values bill={bill} />;
  return <Closing bill={bill} />;
}

function Overview({ bill }: { bill: OperatingBill }) {
  const importer = useImportOperatingBillSnapshots(bill.month);
  const [importMessage, setImportMessage] = useState("");
  const metrics = [
    ["总投入", money(bill.summary.totalCost), "API 实际消耗 + 固定套餐费用"],
    ["API 消耗", money(bill.summary.apiCost), "仅 API 模式调用成本"],
    ["套餐费用", money(bill.summary.packageCost), "当月固定套餐成本"],
    ["期末余额", money(bill.summary.endingBalance), bill.summary.endingBalanceCurrency ?? "API 预付余额"],
    ["套餐综合利用率", bill.summary.planUtilization ? `${bill.summary.planUtilization}%` : "—", "按套餐成本加权"],
    ["活跃主体", String(bill.summary.activePrincipalCount), "有有效账本记录"],
    ["已确认金额价值", money(bill.summary.confirmedValueAmount), `另有 ${bill.summary.confirmedNonMonetaryCount} 项非金额价值`],
  ];
  const importCsv = async (file: File) => {
    try {
      const rows = parseSnapshotCsv(await file.text());
      await importer.mutateAsync(rows);
      setImportMessage(`已导入 ${rows.length} 条厂商账单快照`);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "导入失败");
    }
  };
  return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, note]) => <article className="rounded-xl border border-ql-border-zone bg-ql-surface p-4" key={label}><p className="text-[12px] text-ql-fg-secondary">{label}</p><strong className="mt-2 block text-[24px] text-ql-fg">{value}</strong><p className="mt-1 text-[11px] text-ql-fg-tertiary">{note}</p></article>)}</div><BillCard className="overflow-hidden"><SectionHeading description="充值不是费用；API 与套餐按不同口径归集" title="厂商投入构成" action={bill.status === "DRAFT" ? <label className={buttonSecondary}>导入账单 CSV<input accept=".csv,text/csv" className="sr-only" onChange={e => { const file = e.target.files?.[0]; if (file) void importCsv(file); e.target.value = ""; }} type="file"/></label> : undefined}/>{importMessage ? <p className={`mx-4 mb-3 text-[12px] ${importer.error ? "text-ql-danger" : "text-ql-success"}`}>{importMessage}</p> : null}<p className="mx-4 mb-3 text-[11px] text-ql-fg-tertiary">CSV 表头：provider_resource_id、collected_at，以及对应的余额／费用或套餐额度字段；导入来源固定留痕为 BILL_RECONCILIATION。</p><Table headers={["厂商 / 资源", "采购形态", "API 成本", "套餐成本", "月度成本", "使用情况", "状态"]}>{bill.providers.map((row) => <tr className="border-b border-ql-border-zone" key={row.providerResourceId}><Cell>{row.providerName}<span className="block text-[11px] text-ql-fg-tertiary">{row.resourceName}</span></Cell><Cell>{row.mode === "API" ? "API" : "Coding Plan"}</Cell><Num>{money(row.apiCost)}</Num><Num>{money(row.packageCost)}</Num><Num>{money(row.totalCost)}</Num><Cell>{row.mode === "API" ? `${row.activePrincipalCount} 个活跃主体` : `${row.usedQuota ?? "—"} / ${row.totalQuota ?? "—"} ${row.quotaUnit ?? ""}`}</Cell><Cell><StatusTag tone={row.status === "ACTIVE" ? "success" : "warning"}>{row.status}</StatusTag></Cell></tr>)}</Table></BillCard></div>;
}

function parseSnapshotCsv(text: string): Array<{ provider_resource_id: string; snapshot: Record<string, unknown> }> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const parseLine = (line: string) => {
    const values: string[] = []; let value = ""; let quoted = false;
    for (let i = 0; i < line.length; i += 1) { const char = line[i]!; if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i += 1; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { values.push(value.trim()); value = ""; } else value += char; }
    if (quoted) throw new Error("CSV 引号未闭合"); values.push(value.trim()); return values;
  };
  if (lines.length < 2) throw new Error("CSV 至少需要表头和一行数据");
  const headers = parseLine(lines[0]!);
  if (!headers.includes("provider_resource_id") || !headers.includes("collected_at")) throw new Error("CSV 缺少 provider_resource_id 或 collected_at 表头");
  return lines.slice(1).map((line, index) => {
    const values = parseLine(line); const record: Record<string, unknown> = {};
    headers.forEach((header, i) => { const cell = values[i]?.trim(); if (cell) record[header] = cell; });
    const providerResourceId = String(record.provider_resource_id ?? ""); delete record.provider_resource_id;
    if (!providerResourceId) throw new Error(`CSV 第 ${index + 2} 行缺少资源 ID`);
    return { provider_resource_id: providerResourceId, snapshot: record };
  });
}

function Plans({ bill }: { bill: OperatingBill }) {
  const plans = bill.providers.filter(row => row.mode === "CODING_PLAN");
  const labels = { FULL: "已用满", UNDERUSED: "未用满", EXHAUSTED_EARLY: "提前耗尽", UNUSED: "无人使用" } as const;
  return <BillCard className="overflow-hidden"><SectionHeading title="套餐利用分析" description="按经营快照中的套餐费用与原生额度计算；数据缺口不伪造"/><Table headers={["套餐资源", "厂商", "已用 / 总额度", "利用率", "固定费用", "闲置权益折算", "判断 / 依据"]}>{plans.map(row => { const u = Number(row.utilization ?? 0); const label = row.planAssessment ? labels[row.planAssessment] : "数据不足"; return <tr className="border-b border-ql-border-zone" key={row.providerResourceId}><Cell>{row.resourceName}</Cell><Cell>{row.providerName}</Cell><Cell>{row.usedQuota ?? "—"} / {row.totalQuota ?? "—"} {row.quotaUnit ?? ""}</Cell><Cell><span>{row.utilization ? `${row.utilization}%` : "—"}</span>{row.utilization ? <div className="mt-1 w-40"><Meter danger={row.planAssessment === "EXHAUSTED_EARLY"} value={Math.min(100, u)}/></div> : null}</Cell><Num>{money(row.packageCost)}</Num><Num>{money(row.idleEntitlementCost)}</Num><Cell><StatusTag tone={label === "已用满" ? "success" : label === "无人使用" || label === "提前耗尽" ? "danger" : "warning"}>{label}</StatusTag><span className="mt-1 block max-w-80 text-[11px] text-ql-fg-tertiary">{row.assessmentBasis ?? "缺少原生额度快照"}</span></Cell></tr>; })}</Table>{plans.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">本期没有 Coding Plan 套餐资源</p> : null}</BillCard>;
}

function Values({ bill }: { bill: OperatingBill }) {
  const create = useCreateOperatingBillValue(bill.month); const confirm = useConfirmOperatingBillValue(bill.month);
  const [title, setTitle] = useState(""); const [kind, setKind] = useState<"MONETARY" | "NON_MONETARY">("MONETARY"); const [value, setValue] = useState(""); const [evidence, setEvidence] = useState(""); const [validationError, setValidationError] = useState("");
  const save = () => { if (!title.trim() || !value.trim()) return; const message = kind === "MONETARY" ? validateMoneyAmount(value, true) : null; if (message) { setValidationError(message); return; } setValidationError(""); create.mutate({ title: title.trim(), value_type: kind, amount: kind === "MONETARY" ? value : null, metric_value: kind === "NON_MONETARY" ? value : null, evidence_ref: evidence || null }, { onSuccess: () => { setTitle(""); setValue(""); setEvidence(""); } }); };
  return <div className="space-y-4"><BillCard><SectionHeading title="新增价值事项" description="业务负责人填写事实和依据；系统只负责留痕"/><div className="grid gap-3 px-4 pb-4 md:grid-cols-4"><input className={inputClass} onChange={e => setTitle(e.target.value)} placeholder="价值事项" value={title}/><select className={inputClass} onChange={e => { setKind(e.target.value as typeof kind); setValue(""); setValidationError(""); }} value={kind}><option value="MONETARY">金额价值</option><option value="NON_MONETARY">非金额指标</option></select>{kind === "MONETARY" ? <MoneyAmountInput aria-invalid={Boolean(validationError)} className={inputClass} id="bill-value-amount" onChange={setValue} placeholder="金额" value={value}/> : <input className={inputClass} onChange={e => setValue(e.target.value)} placeholder="指标值" value={value}/>}<input className={inputClass} onChange={e => setEvidence(e.target.value)} placeholder="证据引用" value={evidence}/><div className="md:col-span-4 flex items-center justify-end gap-3">{validationError ? <span className="text-[12px] text-ql-danger" role="alert">{validationError}</span> : null}{create.error ? <span className="text-[12px] text-ql-danger">{create.error.message}</span> : null}<button className={buttonPrimary} disabled={bill.status === "CLOSED" || create.isPending} onClick={save}>保存待确认</button></div></div></BillCard><BillCard className="overflow-hidden"><SectionHeading title="价值确认" description={`已确认金额 ${money(bill.summary.confirmedValueAmount)}，非金额 ${bill.summary.confirmedNonMonetaryCount} 项`}/><Table headers={["事项", "关联主体", "金额 / 指标", "依据", "提交人", "状态", "操作"]}>{bill.values.map(item => <tr className="border-b border-ql-border-zone" key={item.id}><Cell>{item.title}</Cell><Cell>{item.related_principal_name ?? "未关联"}</Cell><Cell>{item.value_type === "MONETARY" ? money(item.amount) : `${item.metric_value ?? "—"}${item.metric_unit ? ` ${item.metric_unit}` : ""}`}</Cell><Cell>{item.evidence_ref ?? "—"}</Cell><Cell>{item.submitted_by_name}</Cell><Cell><StatusTag tone={item.status === "CONFIRMED" ? "success" : "warning"}>{item.status === "CONFIRMED" ? "已确认" : "待确认"}</StatusTag></Cell><Cell>{item.status === "PENDING" && bill.status === "DRAFT" ? <button className="text-ql-action" disabled={confirm.isPending} onClick={() => confirm.mutate(item.id)}>确认</button> : "已留痕"}</Cell></tr>)}</Table>{bill.values.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">尚无价值事项</p> : null}</BillCard></div>;
}

function Closing({ bill }: { bill: OperatingBill }) {
  const close = useCloseOperatingBill(bill.month); const reopen = useReopenOperatingBill(bill.month); const [note, setNote] = useState("");
  const act = () => bill.status === "DRAFT" ? close.mutate({ allow_incomplete: bill.gaps.length > 0, note: note.trim() || null }) : reopen.mutate(note.trim());
  const error = close.error ?? reopen.error;
  return <div className="grid gap-4 xl:grid-cols-2"><BillCard><SectionHeading title="本期结账" description={`${bill.month} · 北京时间自然月`} action={<StatusTag tone={bill.status === "CLOSED" ? "success" : "warning"}>{bill.status === "CLOSED" ? `已冻结 v${bill.version}` : "待结账"}</StatusTag>}/><div className="space-y-3 px-4 pb-4">{bill.gaps.length ? bill.gaps.map(gap => <div className="rounded-lg bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning" key={`${gap.code}-${gap.providerResourceId ?? "all"}`}>{gap.message}</div>) : <div className="rounded-lg bg-ql-success-soft px-3 py-2 text-[12px] text-ql-success">数据完整性检查通过</div>}<textarea aria-label={bill.status === "DRAFT" ? "结账说明" : "重开原因"} className="min-h-24 w-full rounded-lg border border-ql-border bg-ql-surface p-3 text-[13px]" onChange={e => setNote(e.target.value)} placeholder={bill.status === "DRAFT" ? (bill.gaps.length ? "存在缺口，必须填写带缺口结账说明" : "结账说明（可选）") : "重开原因（必填）"} value={note}/>{error ? <p className="text-[12px] text-ql-danger">{error.message}</p> : null}<div className="flex justify-end"><button className={bill.status === "DRAFT" ? buttonPrimary : buttonSecondary} disabled={(bill.status === "CLOSED" && !note.trim()) || close.isPending || reopen.isPending} onClick={act}>{bill.status === "DRAFT" ? "确认结账并冻结" : "重开账期"}</button></div></div></BillCard><BillCard className="overflow-hidden"><SectionHeading title="版本与操作记录" description="旧版本永久保留，重开后再次结账生成新版本"/><div className="divide-y divide-ql-border-zone">{bill.versions.map(v => <div className="p-4 text-[13px]" key={v.id}><p className="font-medium">账单 v{v.version} · {v.closedBy}</p><p className="mt-1 text-[12px] text-ql-fg-secondary">{new Date(v.closedAt).toLocaleString("zh-CN")} · {v.closeNote || "无说明"} · {v.exceptions.length} 个例外</p></div>)}{bill.events.map(e => <div className="p-4 text-[13px]" key={e.id}><p>{e.action} · {e.actor}</p><p className="mt-1 text-[12px] text-ql-fg-secondary">{new Date(e.createdAt).toLocaleString("zh-CN")} {e.reason ? `· ${e.reason}` : ""}</p></div>)}{bill.versions.length + bill.events.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">尚无结账或重开记录</p> : null}</div></BillCard></div>;
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) { return <div className="overflow-x-auto"><table className="w-full min-w-[52rem] text-left text-[13px]"><thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[12px] text-ql-fg-tertiary"><tr>{headers.map((h, i) => <th className={`px-4 py-2 font-medium ${i > 1 && ["成本", "费用", "Token", "扣减", "投入"].some(x => h.includes(x)) ? "text-right" : ""}`} key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function Cell({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3 text-ql-fg-secondary">{children}</td>; }
function Num({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3 text-right font-medium tabular-nums text-ql-fg">{children}</td>; }
