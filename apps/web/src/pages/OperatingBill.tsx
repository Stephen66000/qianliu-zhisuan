import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";

import {
  type OperatingBill,
  useCloseOperatingBill,
  useConfirmOperatingBillResource,
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
import { useAllPurchases, useProcurementReview, useSaveProcurementNote } from "../api/v2-hooks";
import type { ProcurementReview } from "../api/v2-types";
import { useFeatureFlags } from "../feature-flags";

type TabId = Exclude<OperatingBillSection, "employees" | "projects">;
function isTabId(value: string | null): value is TabId {
  return value === "overview" || value === "plans" || value === "procurement" || value === "reconciliation" || value === "value" || value === "closing";
}
function money(value: string | null): string { return value === null ? "—" : `¥${formatMoney(value)}`; }

export function OperatingBillPage() {
  const featureFlags = useFeatureFlags();
  const [params] = useSearchParams();
  const month = operatingBillMonth(params.get("month"));
  const requestedTab = params.get("tab");
  const activeTab: TabId = isTabId(requestedTab) ? requestedTab : "overview";
  const query = useOperatingBill(month);
  useRedirectOnUnauthorized(query.error);
  if (requestedTab === "subjects") {
    return <Navigate replace to={`/operating-bill/employees?month=${month}`} />;
  }
  if (requestedTab === "procurement" && !featureFlags.FEATURE_PROCUREMENT_REVIEW) {
    return <Navigate replace to={`/operating-bill?month=${month}`} />;
  }
  return <OperatingBillShell active={activeTab} month={month} status={query.data?.status} version={query.data?.version}>
    {query.isLoading ? <LoadingState label="正在汇总月度经营账单…" rows={5} /> : query.error || !query.data ? <ErrorState message={query.error?.message ?? "经营账单加载失败"} onRetry={() => void query.refetch()} /> : <BillTab bill={query.data} tab={activeTab} />}
  </OperatingBillShell>;
}

function BillTab({ bill, tab }: { bill: OperatingBill; tab: TabId }) {
  if (tab === "overview") return <Overview bill={bill} />;
  if (tab === "plans") return <Plans bill={bill} />;
  if (tab === "procurement") return <Procurement bill={bill} />;
  if (tab === "reconciliation") return <ComingSoon />;
  if (tab === "value") return <Values bill={bill} />;
  return <Closing bill={bill} />;
}

function Overview({ bill }: { bill: OperatingBill }) {
  const featureFlags = useFeatureFlags();
  const importer = useImportOperatingBillSnapshots(bill.month);
  const [importMessage, setImportMessage] = useState("");
  const showPurchases = featureFlags.FEATURE_DEPARTMENT_COST;
  const purchases = useAllPurchases(
    bill.month,
    bill.providers.map((row) => row.providerResourceId),
    showPurchases,
  );
  const metrics = [
    ["本月总花费", money(bill.summary.totalCost), "API 花费 + 固定套餐费用"],
    ["API 花费", money(bill.summary.apiCost), bill.summary.apiSpendReason ?? "期初余额 + 本月充值 - 期末余额"],
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
  return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value, note]) => <article className="rounded-xl border border-ql-border-zone bg-ql-surface p-4" key={label}><p className="text-[12px] text-ql-fg-secondary">{label}</p><strong className="mt-2 block text-[24px] text-ql-fg">{value}</strong><p className="mt-1 text-[11px] text-ql-fg-tertiary">{note}</p></article>)}</div><BillCard className="overflow-hidden"><SectionHeading description="API 花费使用余额桥接；账本 API 计价仅作为核对证据" title="厂商投入构成" action={bill.status === "DRAFT" ? <label className={buttonSecondary}>导入账单 CSV<input accept=".csv,text/csv" className="sr-only" onChange={e => { const file = e.target.files?.[0]; if (file) void importCsv(file); e.target.value = ""; }} type="file"/></label> : undefined}/>{importMessage ? <p className={`mx-4 mb-3 text-[12px] ${importer.error ? "text-ql-danger" : "text-ql-success"}`}>{importMessage}</p> : null}<p className="mx-4 mb-3 text-[11px] text-ql-fg-tertiary">CSV 表头：provider_resource_id、collected_at，以及对应的余额／费用或套餐额度字段；导入来源固定留痕为 BILL_RECONCILIATION。</p><Table headers={["厂商 / 资源", "采购形态", "API 花费", "套餐费用", "月度花费", "使用情况", "状态"]}>{bill.providers.map((row) => <tr className="border-b border-ql-border-zone" key={row.providerResourceId}><Cell>{row.providerName}<span className="block text-[11px] text-ql-fg-tertiary">{row.resourceName}</span></Cell><Cell>{row.mode === "API" ? "API" : "Coding Plan"}</Cell><Num>{row.apiCost === null ? row.apiSpendReason ?? "—" : money(row.apiCost)}{row.mode === "API" && row.ledgerApiCost !== undefined ? <span className="block text-[11px] font-normal text-ql-fg-tertiary">账本计价 {money(row.ledgerApiCost)}</span> : null}</Num><Num>{money(row.packageCost)}</Num><Num>{money(row.totalCost)}</Num><Cell>{row.mode === "API" ? `${row.activePrincipalCount} 个活跃主体` : `${row.usedQuota ?? "—"} / ${row.totalQuota ?? "—"} ${row.quotaUnit ?? ""}`}</Cell><Cell><StatusTag tone={row.status === "ACTIVE" ? "success" : "warning"}>{row.status}</StatusTag></Cell></tr>)}</Table></BillCard>{showPurchases ? <BillCard className="overflow-hidden"><SectionHeading title="本月买了什么" description="采购／充值现金口径，与本月 API 花费和套餐费用分别展示"/><Table headers={["时间", "资源", "类型", "说明", "现金支出", "币种", "登记人"]}>{(purchases.data?.items ?? []).map((item) => { const resource = bill.providers.find((row) => row.providerResourceId === item.providerResourceId); return <tr className="border-b border-ql-border-zone" key={item.id}><Cell>{new Date(item.purchasedAt).toLocaleString("zh-CN")}</Cell><Cell>{resource?.resourceName ?? item.providerResourceId}</Cell><Cell>{item.purchaseType === "API_RECHARGE" ? "API 充值" : "套餐采购"}</Cell><Cell>{item.description ?? item.evidenceRef ?? "—"}</Cell><Num>{money(item.amount)}</Num><Cell>{item.currency}</Cell><Cell>{item.createdBy}</Cell></tr>; })}</Table>{purchases.isLoading ? <p className="p-4 text-[12px] text-ql-fg-tertiary">正在读取采购记录…</p> : purchases.error ? <p className="p-4 text-[12px] text-ql-danger">{purchases.error.message}</p> : (purchases.data?.items.length ?? 0) === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">本月暂无采购或充值记录</p> : null}</BillCard> : null}</div>;
}

/** CSV 快照解析器：只负责结构校验与字段保留，不推断厂商事实。 */
export function parseSnapshotCsv(text: string): Array<{ provider_resource_id: string; snapshot: Record<string, unknown> }> {
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

function Procurement({ bill }: { bill: OperatingBill }) {
  const query = useProcurementReview(bill.month); const save = useSaveProcurementNote(bill.month); const [note, setNote] = useState("");
  if (query.isLoading) return <LoadingState label="正在生成采购复盘…" rows={5}/>;
  if (query.error || !query.data) return <ErrorState message={query.error?.message ?? "采购复盘加载失败"} onRetry={() => void query.refetch()}/>;
  const review = query.data; const value = note || review.note.text;
  return <div className="space-y-4">
    <BillCard className="overflow-hidden">
      <SectionHeading title="采购利用复盘" description="只展示事实与依据，不自动采购、不把现金支出混入本月成本"/>
      <div className="grid gap-3 border-b border-ql-border-zone p-4 sm:grid-cols-2 xl:grid-cols-4">
        <ReviewMetric label="本月采购金额" value={money(review.resources.reduce((sum, row) => sum + Number(row.purchaseCashAmount), 0).toFixed(8))}/>
        <ReviewMetric label="API 实际费用" value={money(review.resources.reduce((sum, row) => sum + Number(row.apiCost), 0).toFixed(8))}/>
        <ReviewMetric label="套餐平均利用" value={averagePlanUtilization(review.resources)}/>
        <ReviewMetric label="需关注资源" value={String(review.resources.filter((row) => row.reviewLabel !== "维持").length)}/>
      </div>
      <Table headers={["资源", "形态", "采购/充值现金", "真实使用", "本月成本", "利用率 / 口径", "耗尽 / 连续无调用", "建议标签", "确定性依据"]}>{review.resources.map((row) => <tr className="border-b border-ql-border-zone align-top" key={row.resourceId}>
        <Cell>{row.providerName} · {row.resourceName}</Cell>
        <Cell>{row.mode === "API" ? "API" : "Coding Plan"}</Cell>
        <Num>{money(row.purchaseCashAmount)}</Num>
        <Cell>{Number(row.realTokens).toLocaleString()} Token<span className="block text-[10px] text-ql-fg-tertiary">{row.requestCount} 个已结算请求</span></Cell>
        <Num>{money(row.mode === "API" ? row.apiCost : row.packageCost)}</Num>
        <Cell>{row.utilizationRate === null ? "— / 未设置" : `${(Number(row.utilizationRate) * 100).toFixed(1)}%`}<span className="block text-[10px] text-ql-fg-tertiary">{row.utilizationBasis ?? (row.mode === "API" ? "API_MONTHLY_BUDGET" : "厂商原生窗口")}</span></Cell>
        <Cell>{row.forecastExhaustAt ? `预计耗尽 ${new Date(row.forecastExhaustAt).toLocaleString("zh-CN")}` : row.forecastNotCalculableReason ?? "耗尽时间未知"}<span className="block text-[10px] text-ql-fg-tertiary">{row.continuousNoCallDays === null ? "无调用天数未知" : `连续 ${row.continuousNoCallDays} 天无调用`} · 闲置未判定</span></Cell>
        <Cell><StatusTag tone={row.reviewLabel === "维持" ? "success" : "warning"}>{row.reviewLabel}</StatusTag></Cell>
        <Cell>{row.reviewReason}</Cell>
      </tr>)}</Table>
      {review.resources.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">本月暂无资源事实</p> : null}
    </BillCard>
    <BillCard><SectionHeading title="采购复盘备注（人工填写）" description={`当前版本 v${review.note.version}${review.note.updatedBy ? ` · ${review.note.updatedBy}` : ""}`}/><div className="px-4 pb-4"><textarea aria-label="采购复盘备注" className="min-h-28 w-full rounded-lg border border-ql-border bg-ql-surface p-3 text-[13px]" maxLength={4000} onChange={(event) => setNote(event.target.value)} placeholder="记录续购、降配或观察依据；系统不会自动执行采购" value={value}/>{save.error ? <p className="mt-2 text-[12px] text-ql-danger">{save.error.message}</p> : null}<div className="mt-2 flex justify-end"><button aria-label="保存备注" className={buttonPrimary} disabled={save.isPending} onClick={() => save.mutate({ note: value, expected_version: review.note.version }, { onSuccess: () => setNote("") })} type="button">保存备注</button></div></div></BillCard>
  </div>;
}

function ReviewMetric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[11px] text-ql-fg-tertiary">{label}</p><strong className="mt-1 block text-[18px]">{value}</strong></div>;
}

function averagePlanUtilization(resources: ProcurementReview["resources"]): string {
  const values = resources.filter((row) => row.mode === "CODING_PLAN" && row.utilizationRate !== null).map((row) => Number(row.utilizationRate));
  return values.length === 0 ? "—" : `${(values.reduce((sum, value) => sum + value, 0) / values.length * 100).toFixed(1)}%`;
}

function ComingSoon() {
  return <BillCard><SectionHeading title="对账与导出" description="本轮开发计划不提供导出与对账执行后端"/><div className="p-8 text-center"><strong className="text-[18px] text-ql-fg">Coming Soon</strong><p className="mt-2 text-[13px] text-ql-fg-tertiary">现有月度总览中的厂商账单 CSV 快照导入继续可用；本页不模拟成功、不调用未注册 API。</p></div></BillCard>;
}

function Values({ bill }: { bill: OperatingBill }) {
  const create = useCreateOperatingBillValue(bill.month); const confirm = useConfirmOperatingBillValue(bill.month);
  const [title, setTitle] = useState(""); const [kind, setKind] = useState<"MONETARY" | "NON_MONETARY">("MONETARY"); const [value, setValue] = useState(""); const [evidence, setEvidence] = useState(""); const [validationError, setValidationError] = useState("");
  const save = () => { if (!title.trim() || !value.trim()) return; const message = kind === "MONETARY" ? validateMoneyAmount(value, true) : null; if (message) { setValidationError(message); return; } setValidationError(""); create.mutate({ title: title.trim(), value_type: kind, amount: kind === "MONETARY" ? value : null, metric_value: kind === "NON_MONETARY" ? value : null, evidence_ref: evidence || null }, { onSuccess: () => { setTitle(""); setValue(""); setEvidence(""); } }); };
  return <div className="space-y-4"><BillCard><SectionHeading title="新增价值事项" description="业务负责人填写事实和依据；系统只负责留痕"/><div className="grid gap-3 px-4 pb-4 md:grid-cols-4"><input className={inputClass} onChange={e => setTitle(e.target.value)} placeholder="价值事项" value={title}/><select className={inputClass} onChange={e => { setKind(e.target.value as typeof kind); setValue(""); setValidationError(""); }} value={kind}><option value="MONETARY">金额价值</option><option value="NON_MONETARY">非金额指标</option></select>{kind === "MONETARY" ? <MoneyAmountInput aria-invalid={Boolean(validationError)} className={inputClass} id="bill-value-amount" onChange={setValue} placeholder="金额" value={value}/> : <input className={inputClass} onChange={e => setValue(e.target.value)} placeholder="指标值" value={value}/>}<input className={inputClass} onChange={e => setEvidence(e.target.value)} placeholder="证据引用" value={evidence}/><div className="md:col-span-4 flex items-center justify-end gap-3">{validationError ? <span className="text-[12px] text-ql-danger" role="alert">{validationError}</span> : null}{create.error ? <span className="text-[12px] text-ql-danger">{create.error.message}</span> : null}<button className={buttonPrimary} disabled={bill.status === "CLOSED" || create.isPending} onClick={save}>保存待确认</button></div></div></BillCard><BillCard className="overflow-hidden"><SectionHeading title="价值确认" description={`已确认金额 ${money(bill.summary.confirmedValueAmount)}，非金额 ${bill.summary.confirmedNonMonetaryCount} 项`}/><Table headers={["事项", "关联主体", "金额 / 指标", "依据", "提交人", "状态", "操作"]}>{bill.values.map(item => <tr className="border-b border-ql-border-zone" key={item.id}><Cell>{item.title}</Cell><Cell>{item.related_principal_name ?? "未关联"}</Cell><Cell>{item.value_type === "MONETARY" ? money(item.amount) : `${item.metric_value ?? "—"}${item.metric_unit ? ` ${item.metric_unit}` : ""}`}</Cell><Cell>{item.evidence_ref ?? "—"}</Cell><Cell>{item.submitted_by_name}</Cell><Cell><StatusTag tone={item.status === "CONFIRMED" ? "success" : "warning"}>{item.status === "CONFIRMED" ? "已确认" : "待确认"}</StatusTag></Cell><Cell>{item.status === "PENDING" && bill.status === "DRAFT" ? <button className="text-ql-action" disabled={confirm.isPending} onClick={() => confirm.mutate(item.id)}>确认</button> : "已留痕"}</Cell></tr>)}</Table>{bill.values.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">尚无价值事项</p> : null}</BillCard></div>;
}

function Closing({ bill }: { bill: OperatingBill }) {
  const close = useCloseOperatingBill(bill.month); const reopen = useReopenOperatingBill(bill.month); const [note, setNote] = useState("");
  const unconfirmedCount = bill.providers.filter(provider => (provider.confirmation?.status ?? "PENDING") === "PENDING").length;
  const act = () => bill.status === "DRAFT" ? close.mutate({ allow_incomplete: bill.gaps.length > 0, note: note.trim() || null }) : reopen.mutate(note.trim());
  const error = close.error ?? reopen.error;
  return <div className="space-y-4"><BillCard className="overflow-hidden"><SectionHeading title="本月采购与花费逐项确认" description="先核对采购/充值、套餐费用、API 实际费用、余额、服务周期、来源和快照，再执行结账"/><Table headers={["资源", "本月采购 / 充值", "套餐费用", "API 实际费用", "余额", "服务周期", "来源 / 快照", "确认"]}>{bill.providers.map(provider => <ResourceFactConfirmation bill={bill} provider={provider} key={provider.providerResourceId}/>)}</Table></BillCard><div className="grid gap-4 xl:grid-cols-2"><BillCard><SectionHeading title="本期结账" description={`${bill.month} · 北京时间自然月`} action={<StatusTag tone={bill.status === "CLOSED" ? "success" : "warning"}>{bill.status === "CLOSED" ? `已冻结 v${bill.version}` : "待结账"}</StatusTag>}/><div className="space-y-3 px-4 pb-4">{unconfirmedCount > 0 ? <div className="rounded-lg bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning">还有 {unconfirmedCount} 项资源事实待负责人确认，确认前不能结账</div> : null}{bill.gaps.length ? bill.gaps.map(gap => <div className="rounded-lg bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning" key={`${gap.code}-${gap.providerResourceId ?? "all"}-${gap.field ?? "all"}`}>{gap.message}</div>) : <div className="rounded-lg bg-ql-success-soft px-3 py-2 text-[12px] text-ql-success">数据完整性检查通过</div>}<textarea aria-label={bill.status === "DRAFT" ? "结账说明" : "重开原因"} className="min-h-24 w-full rounded-lg border border-ql-border bg-ql-surface p-3 text-[13px]" onChange={e => setNote(e.target.value)} placeholder={bill.status === "DRAFT" ? (bill.gaps.length ? "存在缺口，必须填写带缺口结账说明" : "结账说明（可选）") : "重开原因（必填）"} value={note}/>{error ? <p className="text-[12px] text-ql-danger">{error.message}</p> : null}<div className="flex justify-end"><button className={bill.status === "DRAFT" ? buttonPrimary : buttonSecondary} disabled={(bill.status === "DRAFT" && unconfirmedCount > 0) || (bill.status === "CLOSED" && !note.trim()) || close.isPending || reopen.isPending} onClick={act}>{bill.status === "DRAFT" ? "确认结账并冻结" : "重开账期"}</button></div></div></BillCard><BillCard className="overflow-hidden"><SectionHeading title="版本与操作记录" description="旧版本永久保留，重开后再次结账生成新版本"/><div className="divide-y divide-ql-border-zone">{bill.versions.map(v => <div className="p-4 text-[13px]" key={v.id}><p className="font-medium">账单 v{v.version} · {v.closedBy}</p><p className="mt-1 text-[12px] text-ql-fg-secondary">{new Date(v.closedAt).toLocaleString("zh-CN")} · {v.closeNote || "无说明"} · {v.exceptions.length} 个例外</p></div>)}{bill.events.map(e => <div className="p-4 text-[13px]" key={e.id}><p>{e.action} · {e.actor}</p><p className="mt-1 text-[12px] text-ql-fg-secondary">{new Date(e.createdAt).toLocaleString("zh-CN")} {e.reason ? `· ${e.reason}` : ""}</p></div>)}{bill.versions.length + bill.events.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">尚无结账或重开记录</p> : null}</div></BillCard></div></div>;
}

function ResourceFactConfirmation({ bill, provider }: { bill: OperatingBill; provider: OperatingBill["providers"][number] }) {
  const mutation = useConfirmOperatingBillResource(bill.month, provider.providerResourceId);
  const [status, setStatus] = useState(provider.confirmation?.status ?? "PENDING");
  const [note, setNote] = useState(provider.confirmation?.note ?? "");
  const purchases = provider.purchases ?? [];
  const purchaseText = purchases.length ? purchases.map(item => `${item.type === "API_RECHARGE" ? "充值" : "采购"} ${item.currency} ${formatMoney(item.amount)}`).join("；") : "本月无记录";
  return <tr className="border-b border-ql-border-zone"><Cell>{provider.resourceName}<span className="block text-[11px] text-ql-fg-tertiary">{provider.mode}</span></Cell><Cell>{purchaseText}</Cell><Num>{provider.mode === "CODING_PLAN" ? money(provider.packageCost) : "不适用"}</Num><Num>{provider.mode === "API" ? (provider.apiCost === null ? provider.apiSpendReason ?? "—" : money(provider.apiCost)) : "套餐内"}</Num><Num>{provider.mode === "API" ? money(provider.endingBalance) : "不适用"}</Num><Cell>{provider.servicePeriodStart || provider.servicePeriodEnd ? `${provider.servicePeriodStart ?? "未知"} ~ ${provider.servicePeriodEnd ?? "未知"}` : "未提供"}</Cell><Cell>{provider.operatingSnapshotSource ?? "未知来源"}<span className="block text-[11px] text-ql-fg-tertiary">{provider.operatingSnapshotVersion ? `快照 v${provider.operatingSnapshotVersion} · ${provider.operatingSnapshotAt ?? "时间未知"}` : "缺少快照"}</span><span className="block text-[11px] text-ql-fg-tertiary">请求 ${provider.requestRange?.count ?? 0} 条</span></Cell><Cell><select aria-label={`${provider.resourceName} 确认状态`} className={inputClass} disabled={bill.status === "CLOSED" || mutation.isPending} onChange={event => setStatus(event.target.value as typeof status)} value={status}><option value="PENDING">待补充</option><option value="CONFIRMED">属实</option><option value="ANOMALY">异常</option><option value="NOT_APPLICABLE">不适用</option></select><input aria-label={`${provider.resourceName} 确认备注`} className={`${inputClass} mt-1`} onChange={event => setNote(event.target.value)} placeholder="备注" value={note}/><button className="mt-1 text-ql-action" disabled={bill.status === "CLOSED" || mutation.isPending || ((status === "ANOMALY" || status === "NOT_APPLICABLE") && !note.trim())} onClick={() => mutation.mutate({ status, note: note.trim() || null })}>保存确认</button>{provider.confirmation?.confirmedBy ? <span className="block text-[11px] text-ql-fg-tertiary">{provider.confirmation.confirmedBy} · {provider.confirmation.confirmedAt ? new Date(provider.confirmation.confirmedAt).toLocaleString("zh-CN") : ""}</span> : null}</Cell></tr>;
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) { return <div className="overflow-x-auto"><table className="w-full min-w-[52rem] text-left text-[13px]"><thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[12px] text-ql-fg-tertiary"><tr>{headers.map((h, i) => <th className={`px-4 py-2 font-medium ${i > 1 && ["成本", "费用", "Token", "扣减", "投入"].some(x => h.includes(x)) ? "text-right" : ""}`} key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function Cell({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3 text-ql-fg-secondary">{children}</td>; }
function Num({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3 text-right font-medium tabular-nums text-ql-fg">{children}</td>; }
