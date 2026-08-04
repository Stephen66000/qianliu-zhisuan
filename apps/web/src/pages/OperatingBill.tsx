import { BadgeCheck, CalendarDays, FileLock2, Gauge, LayoutDashboard, Search, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  type OperatingBill,
  useAssignOperatingBillProject,
  useCloseOperatingBill,
  useConfirmOperatingBillValue,
  useCreateOperatingBillValue,
  useImportOperatingBillSnapshots,
  useOperatingBill,
  useReopenOperatingBill,
} from "../api/operating-bills";
import { usePrincipals } from "../api/hooks";
import { BillCard, buttonPrimary, buttonSecondary, inputClass, Meter, SectionHeading } from "../components/operating-bill/BillShared";
import { StatusTag } from "../components/dashboard/StatusTag";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { MoneyAmountInput, validateMoneyAmount } from "../components/writes/MoneyAmountInput";
import { formatCount, formatMoney } from "../lib/format";

const tabs = [
  { id: "overview", label: "月度总览", icon: LayoutDashboard },
  { id: "subjects", label: "员工／项目账", icon: UsersRound },
  { id: "plans", label: "套餐利用分析", icon: Gauge },
  { id: "value", label: "价值确认", icon: BadgeCheck },
  { id: "closing", label: "结账管理", icon: FileLock2 },
] as const;
type TabId = (typeof tabs)[number]["id"];

function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}
function isTabId(value: string | null): value is TabId { return tabs.some((tab) => tab.id === value); }
function integer(value: string): string { return formatCount(value); }
function money(value: string | null): string { return value === null ? "—" : `¥${formatMoney(value)}`; }
function sumDecimal(values: string[]): string {
  const scale = 8;
  const sum = values.reduce((total, value) => {
    const match = /^(\d+)(?:\.(\d*))?$/.exec(value);
    if (!match) return total;
    return total + BigInt(match[1]!) * 10n ** BigInt(scale) + BigInt((match[2] ?? "").padEnd(scale, "0").slice(0, scale));
  }, 0n);
  const divisor = 10n ** BigInt(scale);
  return `${sum / divisor}.${String(sum % divisor).padStart(scale, "0")}`;
}

export function OperatingBillPage() {
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : currentMonth();
  const requestedTab = params.get("tab");
  const activeTab: TabId = isTabId(requestedTab) ? requestedTab : "overview";
  const query = useOperatingBill(month);
  useRedirectOnUnauthorized(query.error);
  const setParam = (key: string, value: string) => { const next = new URLSearchParams(params); if (key === "tab" && value === "overview") next.delete(key); else next.set(key, value); setParams(next, { replace: true }); };

  return <div className="flex flex-col gap-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="flex items-center gap-2"><h1 className="text-[28px] font-bold leading-9 text-ql-fg">经营账单</h1>{query.data ? <StatusTag tone={query.data.status === "CLOSED" ? "success" : "warning"}>{query.data.status === "CLOSED" ? `已结账 v${query.data.version}` : "待结账"}</StatusTag> : null}</div><p className="mt-1 text-[13px] text-ql-fg-tertiary">回答三个问题：买了什么、谁在用、产生了什么价值</p></div>
      <label className="flex h-9 items-center gap-2 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px]"><CalendarDays className="h-4 w-4 text-ql-action" /><input aria-label="账单月份" className="bg-transparent outline-none" max={currentMonth()} onChange={(e) => setParam("month", e.target.value)} type="month" value={month} /><span className="text-[11px] text-ql-fg-tertiary">北京时间自然月</span></label>
    </header>
    <nav aria-label="经营账单页签" className="overflow-x-auto rounded-xl border border-ql-border-zone bg-ql-surface p-1.5"><div className="flex min-w-max gap-1">{tabs.map(({ id, label, icon: Icon }) => <button aria-selected={activeTab === id} className={`flex h-9 items-center gap-2 rounded-lg px-3.5 text-[13px] font-medium ${activeTab === id ? "bg-ql-surface-brand-soft text-ql-action" : "text-ql-fg-secondary hover:bg-ql-surface-subtle"}`} key={id} onClick={() => setParam("tab", id)} role="tab" type="button"><Icon className="h-4 w-4" />{label}</button>)}</div></nav>
    {query.isLoading ? <LoadingState label="正在汇总月度经营账单…" rows={5} /> : query.error || !query.data ? <ErrorState message={query.error?.message ?? "经营账单加载失败"} onRetry={() => void query.refetch()} /> : <BillTab bill={query.data} tab={activeTab} />}
  </div>;
}

function BillTab({ bill, tab }: { bill: OperatingBill; tab: TabId }) {
  if (tab === "overview") return <Overview bill={bill} />;
  if (tab === "subjects") return <Subjects bill={bill} />;
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

function Subjects({ bill }: { bill: OperatingBill }) {
  const [type, setType] = useState<"EMPLOYEE" | "PROJECT">("EMPLOYEE"); const [keyword, setKeyword] = useState("");
  const [requestId, setRequestId] = useState(""); const [projectId, setProjectId] = useState("");
  const principals = usePrincipals(); const assign = useAssignOperatingBillProject(bill.month);
  const rows = useMemo(() => bill.subjects.filter((row) => row.principalType === type && `${row.principalName}${row.providers.join("")}`.toLowerCase().includes(keyword.trim().toLowerCase())), [bill.subjects, keyword, type]);
  const totalTokens = rows.reduce((sum, row) => sum + BigInt(row.totalTokens), 0n);
  const totalQuota = rows.reduce((sum, row) => sum + BigInt(row.deductedQuota), 0n);
  const totalCost = sumDecimal(rows.map((row) => row.totalAllocatedCost));
  return <div className="space-y-4">{type === "PROJECT" && bill.status === "DRAFT" ? <BillCard><SectionHeading title="请求归属项目" description="把员工请求归入项目；未设置的成本继续独立列为“未归属项目”"/><div className="grid gap-3 px-4 pb-4 md:grid-cols-[1fr_1fr_auto]"><input aria-label="待归属请求 ID" className={inputClass} onChange={e => setRequestId(e.target.value)} placeholder="请求 UUID（可从用量账本复制）" value={requestId}/><select aria-label="归属项目" className={inputClass} onChange={e => setProjectId(e.target.value)} value={projectId}><option value="">选择项目</option>{(principals.data?.principals ?? []).filter(p => p.type === "PROJECT" && p.status === "ACTIVE").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className={buttonPrimary} disabled={!requestId || !projectId || assign.isPending} onClick={() => assign.mutate({ ai_request_id: requestId, project_principal_id: projectId, reason: "经营账单项目归属" }, { onSuccess: () => setRequestId("") })}>保存归属</button>{assign.error ? <p className="text-[12px] text-ql-danger md:col-span-3">{assign.error.message}</p> : null}</div></BillCard> : null}<BillCard className="overflow-hidden"><SectionHeading title={type === "EMPLOYEE" ? "员工汇总账" : "项目汇总账"} description="API 按实际成本归集；套餐按使用占比分摊，不改变厂商账单" action={<div className="flex gap-2"><div className="flex rounded-lg border border-ql-border p-1">{(["EMPLOYEE", "PROJECT"] as const).map(v => <button className={`h-7 rounded-md px-3 text-[12px] ${type === v ? "bg-ql-surface-brand-soft text-ql-action" : "text-ql-fg-secondary"}`} key={v} onClick={() => setType(v)}>{v === "EMPLOYEE" ? "按员工" : "按项目"}</button>)}</div><label className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-ql-fg-tertiary"/><input aria-label="搜索主体或厂商" className={`${inputClass} w-56 pl-9`} onChange={e => setKeyword(e.target.value)} placeholder="搜索名称或厂商" value={keyword}/></label></div>}/><Table headers={[type === "EMPLOYEE" ? "员工" : "项目", "使用厂商", "Token", "额度扣减", "API 成本", "套餐分摊", "归集成本", "活跃 / 请求", "明细"]}>{rows.map(row => <tr className="border-b border-ql-border-zone" key={row.principalId}><Cell>{row.principalName}</Cell><Cell>{row.providers.join("、") || "—"}</Cell><Num>{integer(row.totalTokens)}</Num><Num>{integer(row.deductedQuota)}</Num><Num>{money(row.apiCost)}</Num><Num>{money(row.packageAllocatedCost)}</Num><Num>{money(row.totalAllocatedCost)}</Num><Cell>{row.activeDays} 天 / {row.requestCount} 次</Cell><Cell>{row.principalId.startsWith("__") ? "—" : <Link className="text-ql-action" to={`/usage?${type === "PROJECT" ? "project_id" : "principal_id"}=${row.principalId}`}>查看请求</Link>}</Cell></tr>)}<tr className="bg-ql-surface-subtle font-medium"><Cell>合计</Cell><Cell>{rows.length} 个主体</Cell><Num>{integer(String(totalTokens))}</Num><Num>{integer(String(totalQuota))}</Num><Cell>—</Cell><Cell>—</Cell><Num>{money(totalCost)}</Num><Cell>—</Cell><Cell>—</Cell></tr></Table></BillCard></div>;
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
