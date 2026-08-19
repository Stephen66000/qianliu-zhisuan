import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";

import { type OperatingBill, useCloseOperatingBill, useConfirmOperatingBillResource, useConfirmOperatingBillValue, useCreateOperatingBillValue, useOperatingBill, useReopenOperatingBill } from "../api/operating-bills";
import { BillCard, buttonPrimary, buttonSecondary, inputClass, Meter, SectionHeading } from "../components/operating-bill/BillShared";
import { operatingBillMonth, OperatingBillShell, type OperatingBillSection } from "../components/operating-bill/OperatingBillShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { MoneyAmountInput, validateMoneyAmount } from "../components/writes/MoneyAmountInput";
import { useProcurementReview, useSaveProcurementNote } from "../api/v2-hooks";
import { useFeatureFlags } from "../feature-flags";
import { OperatingBillOverview } from "./OperatingBillOverview";
import { Cell, currencyFacts, currencyMoney, money, Num, Table } from "./OperatingBillShared";

export { parseSnapshotCsv } from "./OperatingBillOverview";

type TabId = Exclude<OperatingBillSection, "employees" | "projects">;
function isTabId(value: string | null): value is TabId {
  return value === "overview" || value === "plans" || value === "procurement" || value === "reconciliation" || value === "value" || value === "closing";
}

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
  return (
    <OperatingBillShell active={activeTab} month={month} status={query.data?.status} version={query.data?.version}>
      {query.isLoading ? <LoadingState label="正在汇总月度经营账单…" rows={5} /> : query.error || !query.data ? <ErrorState message={query.error?.message ?? "经营账单加载失败"} onRetry={() => void query.refetch()} /> : <BillTab bill={query.data} tab={activeTab} />}
    </OperatingBillShell>
  );
}

function BillTab({ bill, tab }: { bill: OperatingBill; tab: TabId }) {
  if (tab === "overview") return <OperatingBillOverview bill={bill} />;
  if (tab === "plans") return <Plans bill={bill} />;
  if (tab === "procurement") return <Procurement bill={bill} />;
  if (tab === "reconciliation") return <ComingSoon />;
  if (tab === "value") return <Values bill={bill} />;
  return <Closing bill={bill} />;
}

function Plans({ bill }: { bill: OperatingBill }) {
  const plans = bill.providers.filter((row) => row.mode === "CODING_PLAN");
  const labels = {
    FULL: "已用满",
    UNDERUSED: "未用满",
    EXHAUSTED_EARLY: "提前耗尽",
    UNUSED: "无人使用",
  } as const;
  return (
    <BillCard className="overflow-hidden">
      <SectionHeading title="套餐利用分析" description="按经营快照中的套餐费用与原生额度计算；数据缺口不伪造" />
      <Table headers={["套餐资源", "厂商", "已用 / 总额度", "利用率", "固定费用", "闲置权益折算", "判断 / 依据"]}>
        {plans.map((row) => {
          const u = Number(row.utilization ?? 0);
          const label = row.planAssessment ? labels[row.planAssessment] : "数据不足";
          return (
            <tr className="border-b border-ql-border-zone" key={row.providerResourceId}>
              <Cell>{row.resourceName}</Cell>
              <Cell>{row.providerName}</Cell>
              <Cell>
                {row.usedQuota ?? "—"} / {row.totalQuota ?? "—"} {row.quotaUnit ?? ""}
              </Cell>
              <Cell>
                <span>{row.utilization ? `${row.utilization}%` : "—"}</span>
                {row.utilization ? (
                  <div className="mt-1 w-40">
                    <Meter danger={row.planAssessment === "EXHAUSTED_EARLY"} value={Math.min(100, u)} />
                  </div>
                ) : null}
              </Cell>
              <Num>{currencyMoney(row.packageCost, row.packageCostCurrency ?? row.currency)}</Num>
              <Num>{currencyMoney(row.idleEntitlementCost, row.packageCostCurrency ?? row.currency)}</Num>
              <Cell>
                <StatusTag tone={label === "已用满" ? "success" : label === "无人使用" || label === "提前耗尽" ? "danger" : "warning"}>{label}</StatusTag>
                <span className="mt-1 block max-w-80 text-[11px] text-ql-fg-tertiary">{row.assessmentBasis ?? "缺少原生额度快照"}</span>
              </Cell>
            </tr>
          );
        })}
      </Table>
      {plans.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">本期没有 Coding Plan 套餐资源</p> : null}
    </BillCard>
  );
}

function Procurement({ bill }: { bill: OperatingBill }) {
  const query = useProcurementReview(bill.month);
  const save = useSaveProcurementNote(bill.month);
  const [note, setNote] = useState("");
  if (query.isLoading) return <LoadingState label="正在生成采购复盘…" rows={5} />;
  if (query.error || !query.data) return <ErrorState message={query.error?.message ?? "采购复盘加载失败"} onRetry={() => void query.refetch()} />;
  const review = query.data;
  const value = note || review.note.text;
  return (
    <div className="space-y-4">
      <BillCard className="overflow-hidden">
        <SectionHeading title="采购利用复盘" description="只展示事实与依据，不自动采购、不把现金支出混入本月花费" />
        <div className="grid gap-3 border-b border-ql-border-zone p-4 sm:grid-cols-2 xl:grid-cols-4">
          <ReviewMetric label="本月采购金额" value={currencyFacts(review.summary.purchaseCashAmounts, null)} />
          <ReviewMetric label="API 花费" value={currencyFacts(review.summary.apiSpends, null)} />
          <ReviewMetric label="套餐费用" value={currencyFacts(review.summary.packageCosts, null)} />
          <ReviewMetric label="套餐成本加权利用" value={review.summary.planUtilization === null ? "—" : `${review.summary.planUtilization}%`} />
          <ReviewMetric label="需关注资源" value={String(review.resources.filter((row) => row.reviewLabel !== "维持").length)} />
        </div>
        <Table headers={["资源", "形态", "采购/充值现金", "真实使用", "本月花费", "利用率 / 口径", "耗尽 / 连续无调用", "建议标签", "确定性依据"]}>
          {review.resources.map((row) => (
            <tr className="border-b border-ql-border-zone align-top" key={row.resourceId}>
              <Cell>
                {row.providerName} · {row.resourceName}
              </Cell>
              <Cell>{row.mode === "API" ? "API" : "Coding Plan"}</Cell>
              <Num>{currencyFacts(row.purchaseCashAmounts, row.purchaseCashAmount, row.currency)}</Num>
              <Cell>
                {Number(row.realTokens).toLocaleString()} Token
                <span className="block text-[10px] text-ql-fg-tertiary">{row.requestCount} 个已结算请求</span>
              </Cell>
              <Num>
                {row.mode === "API" ? (row.apiCost === null ? (row.apiSpendReason ?? "—") : currencyMoney(row.apiCost, row.currency)) : currencyMoney(row.packageCost, row.currency)}
                {row.mode === "API" && row.ledgerApiCost !== undefined ? <span className="block text-[10px] font-normal text-ql-fg-tertiary">账本 API 计价（核对证据） {currencyMoney(row.ledgerApiCost, row.currency)}</span> : null}
              </Num>
              <Cell>
                {row.utilizationRate === null ? "— / 未设置" : `${(Number(row.utilizationRate) * 100).toFixed(1)}%`}
                <span className="block text-[10px] text-ql-fg-tertiary">{row.utilizationBasis ?? (row.mode === "API" ? "API_MONTHLY_BUDGET" : "厂商原生窗口")}</span>
              </Cell>
              <Cell>
                {row.forecastExhaustAt ? `预计耗尽 ${new Date(row.forecastExhaustAt).toLocaleString("zh-CN")}` : (row.forecastNotCalculableReason ?? "耗尽时间未知")}
                <span className="block text-[10px] text-ql-fg-tertiary">{row.continuousNoCallDays === null ? "无调用天数未知" : `连续 ${row.continuousNoCallDays} 天无调用`} · 闲置未判定</span>
              </Cell>
              <Cell>
                <StatusTag tone={row.reviewLabel === "维持" ? "success" : "warning"}>{row.reviewLabel}</StatusTag>
              </Cell>
              <Cell>{row.reviewReason}</Cell>
            </tr>
          ))}
        </Table>
        {review.resources.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">本月暂无资源事实</p> : null}
      </BillCard>
      <BillCard>
        <SectionHeading title="采购复盘备注（人工填写）" description={`当前版本 v${review.note.version}${review.note.updatedBy ? ` · ${review.note.updatedBy}` : ""}`} />
        <div className="px-4 pb-4">
          <textarea aria-label="采购复盘备注" className="min-h-28 w-full rounded-lg border border-ql-border bg-ql-surface p-3 text-[13px]" maxLength={4000} onChange={(event) => setNote(event.target.value)} placeholder="记录续购、降配或观察依据；系统不会自动执行采购" value={value} />
          {save.error ? <p className="mt-2 text-[12px] text-ql-danger">{save.error.message}</p> : null}
          <div className="mt-2 flex justify-end">
            <button aria-label="保存备注" className={buttonPrimary} disabled={save.isPending} onClick={() => save.mutate({ note: value, expected_version: review.note.version }, { onSuccess: () => setNote("") })} type="button">
              保存备注
            </button>
          </div>
        </div>
      </BillCard>
    </div>
  );
}

function ReviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-ql-fg-tertiary">{label}</p>
      <strong className="mt-1 block text-[18px]">{value}</strong>
    </div>
  );
}

function ComingSoon() {
  return (
    <BillCard>
      <SectionHeading title="对账与导出" description="本轮开发计划不提供导出与对账执行后端" />
      <div className="p-8 text-center">
        <strong className="text-[18px] text-ql-fg">Coming Soon</strong>
        <p className="mt-2 text-[13px] text-ql-fg-tertiary">现有月度总览中的厂商账单 CSV 快照导入继续可用；本页不模拟成功、不调用未注册 API。</p>
      </div>
    </BillCard>
  );
}

function Values({ bill }: { bill: OperatingBill }) {
  const create = useCreateOperatingBillValue(bill.month);
  const confirm = useConfirmOperatingBillValue(bill.month);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"MONETARY" | "NON_MONETARY">("MONETARY");
  const [value, setValue] = useState("");
  const [evidence, setEvidence] = useState("");
  const [validationError, setValidationError] = useState("");
  const save = () => {
    if (!title.trim() || !value.trim()) return;
    const message = kind === "MONETARY" ? validateMoneyAmount(value, true) : null;
    if (message) {
      setValidationError(message);
      return;
    }
    setValidationError("");
    create.mutate(
      {
        title: title.trim(),
        value_type: kind,
        amount: kind === "MONETARY" ? value : null,
        metric_value: kind === "NON_MONETARY" ? value : null,
        evidence_ref: evidence || null,
      },
      {
        onSuccess: () => {
          setTitle("");
          setValue("");
          setEvidence("");
        },
      },
    );
  };
  return (
    <div className="space-y-4">
      <BillCard>
        <SectionHeading title="新增价值事项" description="业务负责人填写事实和依据；系统只负责留痕" />
        <div className="grid gap-3 px-4 pb-4 md:grid-cols-4">
          <input className={inputClass} onChange={(e) => setTitle(e.target.value)} placeholder="价值事项" value={title} />
          <select
            className={inputClass}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setValue("");
              setValidationError("");
            }}
            value={kind}
          >
            <option value="MONETARY">金额价值</option>
            <option value="NON_MONETARY">非金额指标</option>
          </select>
          {kind === "MONETARY" ? <MoneyAmountInput aria-invalid={Boolean(validationError)} className={inputClass} id="bill-value-amount" onChange={setValue} placeholder="金额" value={value} /> : <input className={inputClass} onChange={(e) => setValue(e.target.value)} placeholder="指标值" value={value} />}
          <input className={inputClass} onChange={(e) => setEvidence(e.target.value)} placeholder="证据引用" value={evidence} />
          <div className="md:col-span-4 flex items-center justify-end gap-3">
            {validationError ? (
              <span className="text-[12px] text-ql-danger" role="alert">
                {validationError}
              </span>
            ) : null}
            {create.error ? <span className="text-[12px] text-ql-danger">{create.error.message}</span> : null}
            <button className={buttonPrimary} disabled={bill.status === "CLOSED" || create.isPending} onClick={save}>
              保存待确认
            </button>
          </div>
        </div>
      </BillCard>
      <BillCard className="overflow-hidden">
        <SectionHeading title="价值确认" description={`已确认金额 ${money(bill.summary.confirmedValueAmount)}，非金额 ${bill.summary.confirmedNonMonetaryCount} 项`} />
        <Table headers={["事项", "关联主体", "金额 / 指标", "依据", "提交人", "状态", "操作"]}>
          {bill.values.map((item) => (
            <tr className="border-b border-ql-border-zone" key={item.id}>
              <Cell>{item.title}</Cell>
              <Cell>{item.related_principal_name ?? "未关联"}</Cell>
              <Cell>{item.value_type === "MONETARY" ? money(item.amount) : `${item.metric_value ?? "—"}${item.metric_unit ? ` ${item.metric_unit}` : ""}`}</Cell>
              <Cell>{item.evidence_ref ?? "—"}</Cell>
              <Cell>{item.submitted_by_name}</Cell>
              <Cell>
                <StatusTag tone={item.status === "CONFIRMED" ? "success" : "warning"}>{item.status === "CONFIRMED" ? "已确认" : "待确认"}</StatusTag>
              </Cell>
              <Cell>
                {item.status === "PENDING" && bill.status === "DRAFT" ? (
                  <button className="text-ql-action" disabled={confirm.isPending} onClick={() => confirm.mutate(item.id)}>
                    确认
                  </button>
                ) : (
                  "已留痕"
                )}
              </Cell>
            </tr>
          ))}
        </Table>
        {bill.values.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">尚无价值事项</p> : null}
      </BillCard>
    </div>
  );
}

function Closing({ bill }: { bill: OperatingBill }) {
  const close = useCloseOperatingBill(bill.month);
  const reopen = useReopenOperatingBill(bill.month);
  const [note, setNote] = useState("");
  const unconfirmedCount = bill.providers.filter((provider) => (provider.confirmation?.status ?? "PENDING") === "PENDING").length;
  const act = () =>
    bill.status === "DRAFT"
      ? close.mutate({
          allow_incomplete: bill.gaps.length > 0,
          note: note.trim() || null,
        })
      : reopen.mutate(note.trim());
  const error = close.error ?? reopen.error;
  return (
    <div className="space-y-4">
      <BillCard className="overflow-hidden">
        <SectionHeading title="本月采购与花费逐项确认" description="先核对采购/充值、套餐费用、API 花费、余额、服务周期、来源和快照，再执行结账" />
        <Table headers={["资源", "本月采购 / 充值", "套餐费用", "API 花费", "余额", "服务周期", "来源 / 快照", "确认"]}>
          {bill.providers.map((provider) => (
            <ResourceFactConfirmation bill={bill} provider={provider} key={provider.providerResourceId} />
          ))}
        </Table>
      </BillCard>
      <div className="grid gap-4 xl:grid-cols-2">
        <BillCard>
          <SectionHeading title="本期结账" description={`${bill.month} · 北京时间自然月`} action={<StatusTag tone={bill.status === "CLOSED" ? "success" : "warning"}>{bill.status === "CLOSED" ? `已冻结 v${bill.version}` : "待结账"}</StatusTag>} />
          <div className="space-y-3 px-4 pb-4">
            {unconfirmedCount > 0 ? <div className="rounded-lg bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning">还有 {unconfirmedCount} 项资源事实待负责人确认，确认前不能结账</div> : null}
            {bill.gaps.length ? (
              bill.gaps.map((gap) => (
                <div className="rounded-lg bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning" key={`${gap.code}-${gap.providerResourceId ?? "all"}-${gap.field ?? "all"}`}>
                  {gap.message}
                </div>
              ))
            ) : (
              <div className="rounded-lg bg-ql-success-soft px-3 py-2 text-[12px] text-ql-success">数据完整性检查通过</div>
            )}
            <textarea aria-label={bill.status === "DRAFT" ? "结账说明" : "重开原因"} className="min-h-24 w-full rounded-lg border border-ql-border bg-ql-surface p-3 text-[13px]" onChange={(e) => setNote(e.target.value)} placeholder={bill.status === "DRAFT" ? (bill.gaps.length ? "存在缺口，必须填写带缺口结账说明" : "结账说明（可选）") : "重开原因（必填）"} value={note} />
            {error ? <p className="text-[12px] text-ql-danger">{error.message}</p> : null}
            <div className="flex justify-end">
              <button className={bill.status === "DRAFT" ? buttonPrimary : buttonSecondary} disabled={(bill.status === "DRAFT" && unconfirmedCount > 0) || (bill.status === "CLOSED" && !note.trim()) || close.isPending || reopen.isPending} onClick={act}>
                {bill.status === "DRAFT" ? "确认结账并冻结" : "重开账期"}
              </button>
            </div>
          </div>
        </BillCard>
        <BillCard className="overflow-hidden">
          <SectionHeading title="版本与操作记录" description="旧版本永久保留，重开后再次结账生成新版本" />
          <div className="divide-y divide-ql-border-zone">
            {bill.versions.map((v) => (
              <div className="p-4 text-[13px]" key={v.id}>
                <p className="font-medium">
                  账单 v{v.version} · {v.closedBy}
                </p>
                <p className="mt-1 text-[12px] text-ql-fg-secondary">
                  {new Date(v.closedAt).toLocaleString("zh-CN")} · {v.closeNote || "无说明"} · {v.exceptions.length} 个例外
                </p>
              </div>
            ))}
            {bill.events.map((e) => (
              <div className="p-4 text-[13px]" key={e.id}>
                <p>
                  {e.action} · {e.actor}
                </p>
                <p className="mt-1 text-[12px] text-ql-fg-secondary">
                  {new Date(e.createdAt).toLocaleString("zh-CN")} {e.reason ? `· ${e.reason}` : ""}
                </p>
              </div>
            ))}
            {bill.versions.length + bill.events.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">尚无结账或重开记录</p> : null}
          </div>
        </BillCard>
      </div>
    </div>
  );
}

function providerPackageDisplay(provider: OperatingBill["providers"][number]) {
  return provider.mode === "CODING_PLAN" ? currencyMoney(provider.packageCost, provider.packageCostCurrency ?? provider.currency) : "不适用";
}
function providerApiDisplay(provider: OperatingBill["providers"][number]) {
  if (provider.mode !== "API") return "套餐内";
  return provider.apiCost === null ? provider.apiSpendReason ?? "—" : currencyMoney(provider.apiCost, provider.apiSpendCurrency ?? provider.currency);
}
function providerEndingDisplay(provider: OperatingBill["providers"][number]) { return provider.mode === "API" ? currencyMoney(provider.endingBalance, provider.endingBalanceCurrency ?? provider.currency) : "不适用"; }

function ResourceFactConfirmation({ bill, provider }: { bill: OperatingBill; provider: OperatingBill["providers"][number] }) {
  const mutation = useConfirmOperatingBillResource(bill.month, provider.providerResourceId);
  const [status, setStatus] = useState(provider.confirmation?.status ?? "PENDING");
  const [note, setNote] = useState(provider.confirmation?.note ?? "");
  const purchases = provider.purchases ?? [];
  const purchaseText = purchases.length ? purchases.map((item) => `${item.type === "API_RECHARGE" ? "充值" : "采购"} ${currencyMoney(item.amount, item.currency)}`).join("；") : "本月无记录";
  return (
    <tr className="border-b border-ql-border-zone">
      <Cell>
        {provider.resourceName}
        <span className="block text-[11px] text-ql-fg-tertiary">{provider.mode}</span>
      </Cell>
      <Cell>{purchaseText}</Cell>
      <Num>{providerPackageDisplay(provider)}</Num>
      <Num>{providerApiDisplay(provider)}</Num>
      <Num>{providerEndingDisplay(provider)}</Num>
      <Cell>{provider.servicePeriodStart || provider.servicePeriodEnd ? `${provider.servicePeriodStart ?? "未知"} ~ ${provider.servicePeriodEnd ?? "未知"}` : "未提供"}</Cell>
      <Cell>
        {provider.operatingSnapshotSource ?? "未知来源"}
        <span className="block text-[11px] text-ql-fg-tertiary">{provider.operatingSnapshotVersion ? `快照 v${provider.operatingSnapshotVersion} · ${provider.operatingSnapshotAt ?? "时间未知"}` : "缺少快照"}</span>
        <span className="block text-[11px] text-ql-fg-tertiary">请求 ${provider.requestRange?.count ?? 0} 条</span>
      </Cell>
      <Cell>
        <select aria-label={`${provider.resourceName} 确认状态`} className={inputClass} disabled={bill.status === "CLOSED" || mutation.isPending} onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
          <option value="PENDING">待补充</option>
          <option value="CONFIRMED">属实</option>
          <option value="ANOMALY">异常</option>
          <option value="NOT_APPLICABLE">不适用</option>
        </select>
        <input aria-label={`${provider.resourceName} 确认备注`} className={`${inputClass} mt-1`} onChange={(event) => setNote(event.target.value)} placeholder="备注" value={note} />
        <button className="mt-1 text-ql-action" disabled={bill.status === "CLOSED" || mutation.isPending || ((status === "ANOMALY" || status === "NOT_APPLICABLE") && !note.trim())} onClick={() => mutation.mutate({ status, note: note.trim() || null })}>
          保存确认
        </button>
        {provider.confirmation?.confirmedBy ? (
          <span className="block text-[11px] text-ql-fg-tertiary">
            {provider.confirmation.confirmedBy} · {provider.confirmation.confirmedAt ? new Date(provider.confirmation.confirmedAt).toLocaleString("zh-CN") : ""}
          </span>
        ) : null}
      </Cell>
    </tr>
  );
}
