import { SubscriptionAutoRenewal } from "./SubscriptionAutoRenewal";
import { useEffect, useMemo, useState } from "react";
import { CircleDollarSign, Plus } from "lucide-react";

import type {
  FinanceCurrency,
  Provider,
  ProviderFinanceEvent,
  ProviderResourceItem,
  ProviderFinanceMode,
} from "../../api/types";
import {
  currentShanghaiMonth,
  useProviderFinanceBalance,
  useConfirmProviderFinanceDuplicate,
  useProviderFinanceEvents,
  useProviderFinanceSummary,
  useProviderSubscriptionPeriods,
  useRecordProviderFinance,
} from "../../api/provider-finance";
import { ApiError } from "../../api/client";
import { formatCount, formatDateTimeFull, formatMoney, formatShanghaiDate } from "../../lib/format";
import { FormField, INPUT_CLASS } from "../writes/FormField";
import { MoneyAmountInput, validateMoneyAmount } from "../writes/MoneyAmountInput";
import { QueryGate } from "../states/QueryGate";

type EntryKind = "API" | "CODING_PLAN";

function localShanghaiNow(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16);
}

function eventLabel(type: ProviderFinanceEvent["eventType"]): string {
  const labels: Record<ProviderFinanceEvent["eventType"], string> = {
    API_OPENING_BALANCE: "API 期初余额",
    API_OPENING_BALANCE_CORRECTION: "期初更正",
    API_RECHARGE: "API 充值",
    API_BALANCE_RECONCILIATION: "余额对账",
    API_LEGACY_COST_ADJUSTMENT: "历史 API 成本封口",
    CODING_PLAN_PURCHASE: "Coding Plan 购买",
    CODING_PLAN_RENEWAL: "Coding Plan 续费",
    REVERSAL: "冲销",
  };
  return labels[type];
}

function shanghaiIso(localValue: string): string {
  return new Date(`${localValue}:00+08:00`).toISOString();
}

// eslint-disable-next-line complexity -- API/Coding Plan and DARK/ACTIVE are mutually exclusive form states.
export function ProviderFinancePanel({
  resources,
  providers,
  mode,
}: {
  resources: ProviderResourceItem[];
  providers: Provider[];
  mode: Exclude<ProviderFinanceMode, "OFF">;
}) {
  const [month, setMonth] = useState(currentShanghaiMonth);
  const [entryOpen, setEntryOpen] = useState(false);
  const [kind, setKind] = useState<EntryKind>("API");
  const matching = useMemo(() => resources.filter((resource) =>
    kind === "API" ? resource.mode === "API" : resource.mode === "CODING_PLAN"), [kind, resources]);
  const [resourceId, setResourceId] = useState<string | null>(matching[0]?.id ?? null);
  const [currency, setCurrency] = useState<FinanceCurrency>("CNY");
  const [amount, setAmount] = useState("");
  const [cashPaidCny, setCashPaidCny] = useState("");
  const [occurredAt, setOccurredAt] = useState(localShanghaiNow);
  const [description, setDescription] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [subscriptionKind, setSubscriptionKind] = useState<"PURCHASE" | "RENEWAL">("RENEWAL");
  const [productName, setProductName] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [validationError, setValidationError] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [duplicate, setDuplicate] = useState<null | {
    candidateId: string; confirmationToken: string; requestHash: string;
  }>(null);

  useEffect(() => {
    if (!matching.some((resource) => resource.id === resourceId)) {
      setResourceId(matching[0]?.id ?? null);
    }
  }, [matching, resourceId]);
  const selected = resources.find((resource) => resource.id === resourceId) ?? null;
  useEffect(() => {
    if (selected?.mode === "CODING_PLAN") {
      setProductName(selected.operating_snapshot?.package_name ?? selected.name);
    }
  }, [selected]);

  const summary = useProviderFinanceSummary(month);
  const balance = useProviderFinanceBalance(resourceId, currency, selected?.mode === "API");
  const events = useProviderFinanceEvents(resourceId, month);
  const periods = useProviderSubscriptionPeriods(resourceId, selected?.mode === "CODING_PLAN");
  const mutation = useRecordProviderFinance(resourceId);
  const confirmDuplicate = useConfirmProviderFinanceDuplicate();
  const providerName = (resource: ProviderResourceItem) =>
    providers.find((provider) => provider.id === resource.provider_id)?.name ?? "未知厂商";

  const resetEntry = () => {
    setAmount(""); setCashPaidCny(""); setDescription(""); setExternalReference("");
    setPeriodStart(""); setPeriodEnd(""); setOccurredAt(localShanghaiNow());
    setValidationError(""); setIdempotencyKey(crypto.randomUUID());
    setDuplicate(null);
  };
  const submit = () => {
    const moneyError = validateMoneyAmount(amount, true)
      ?? validateMoneyAmount(cashPaidCny, true);
    if (!resourceId || moneyError || !occurredAt) {
      setValidationError(!resourceId ? "请选择厂商产品" : moneyError ?? "请填写充值时间");
      return;
    }
    if (kind === "CODING_PLAN" && (!productName.trim() || !periodStart)) {
      setValidationError("Coding Plan 必须填写产品名称和服务周期开始日");
      return;
    }
    setValidationError("");
    mutation.mutate({ kind, payload: {
      ...(kind === "CODING_PLAN" ? {
        kind: subscriptionKind,
        product_name: productName.trim(),
        service_period_start: periodStart,
        ...(periodEnd ? { service_period_end: periodEnd } : {}),
      } : {}),
      account_currency: currency,
      account_amount: amount,
      cash_paid_cny: cashPaidCny,
      occurred_at: shanghaiIso(occurredAt),
      ...(externalReference.trim() ? { external_reference: externalReference.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      idempotency_key: idempotencyKey,
    } }, { onSuccess: () => { resetEntry(); setEntryOpen(false); },
      onError: (error) => {
        if (!(error instanceof ApiError) || error.code !== "duplicate_confirmation_required"
          || !error.detail || typeof error.detail !== "object") return;
        const detail = error.detail as Record<string, unknown>;
        if (typeof detail.candidateId === "string" && typeof detail.confirmationToken === "string"
          && typeof detail.requestHash === "string") setDuplicate({
          candidateId: detail.candidateId, confirmationToken: detail.confirmationToken,
          requestHash: detail.requestHash,
        });
      } });
  };

  const summaryValue = summary.data;
  return (
    <div aria-labelledby="resource-tab-finance" id="resource-tab-panel-finance" role="tabpanel">
      <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ql-fg">充值与订阅</h2>
            <p className="mt-1 text-[12px] text-ql-fg-tertiary">
              API 余额与 Coding Plan 费用只认本模块资金账本；历史默认显示所选自然月。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input aria-label="资金历史月份" className={INPUT_CLASS} onChange={(event) => setMonth(event.target.value)} type="month" value={month} />
            <button className="flex h-10 items-center gap-1.5 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white hover:bg-ql-action-hover" onClick={() => setEntryOpen((open) => !open)} type="button">
              <Plus aria-hidden className="h-4 w-4" />充值
            </button>
          </div>
        </div>
        {mode === "DARK" ? (
          <p className="mt-3 rounded-lg border border-ql-warning/30 bg-ql-warning-soft px-3 py-2 text-[12px] text-ql-warning">
            当前为只读验收模式：可以查看和测试表单，入账确认暂未开放。
          </p>
        ) : null}
        <QueryGate emptyDescription="资金摘要将在账本可用后显示。" emptyIcon={CircleDollarSign} emptyTitle="暂无资金摘要" error={summary.error} isEmpty={!summaryValue} isLoading={summary.isLoading} onRetry={() => void summary.refetch()}>
          {summaryValue ? <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <FinanceMetric label="人民币实付" value={`¥${formatMoney(summaryValue.cashOutflowCny)}`} />
            <FinanceMetric label="API 经营成本" value={`¥${formatMoney(summaryValue.apiOperatingCosts.find((item) => item.currency === "CNY")?.amount ?? "0")}`} />
            <FinanceMetric label="Coding Plan 支出" value={`¥${formatMoney(summaryValue.codingPlanFixedCostCny)}`} />
            <FinanceMetric label="经营成本合计" value={`¥${formatMoney(summaryValue.operatingCostCny)}`} />
            <FinanceMetric label="当前 API 余额" value={summaryValue.currentApiBalancesComplete
              ? summaryValue.currentApiBalances.length === 0 ? "—" : summaryValue.currentApiBalances
                .map((item) => `${item.currency} ${formatMoney(item.amount)}`).join(" · ")
              : "余额不完整"} />
          </div> : null}
        </QueryGate>
      </section>

      {entryOpen ? <section className="mt-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4" aria-label="充值登记">
        <div className="mb-4 flex gap-2" role="group" aria-label="充值类型">
          <TypeButton active={kind === "API"} label="API 充值" onClick={() => setKind("API")} />
          <TypeButton active={kind === "CODING_PLAN"} label="Coding Plan" onClick={() => setKind("CODING_PLAN")} />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FormField htmlFor="finance-resource" label="厂商产品模型">
            <select className={INPUT_CLASS} id="finance-resource" onChange={(event) => setResourceId(event.target.value || null)} value={resourceId ?? ""}>
              <option value="">请选择</option>
              {matching.map((resource) => <option key={resource.id} value={resource.id}>{providerName(resource)} · {resource.name}</option>)}
            </select>
          </FormField>
          <FormField htmlFor="finance-currency" label="币种">
            <select className={INPUT_CLASS} id="finance-currency" onChange={(event) => setCurrency(event.target.value as FinanceCurrency)} value={currency}><option value="CNY">CNY</option><option value="USD">USD</option></select>
          </FormField>
          {kind === "API" ? <FinanceMetric label="当前余额" value={balance.isLoading ? "读取中…" : balance.data?.balance === null || balance.data?.balance === undefined ? balance.data?.state ?? "不可计算" : `${currency} ${formatMoney(balance.data.balance)}`} /> : <>
            <FormField htmlFor="finance-product" label="订阅产品"><input className={INPUT_CLASS} id="finance-product" onChange={(event) => setProductName(event.target.value)} value={productName} /></FormField>
            <FormField htmlFor="finance-subscription-kind" label="登记类型"><select className={INPUT_CLASS} id="finance-subscription-kind" onChange={(event) => setSubscriptionKind(event.target.value as "PURCHASE" | "RENEWAL")} value={subscriptionKind}><option value="PURCHASE">首次购买</option><option value="RENEWAL">续费</option></select></FormField>
            <FormField htmlFor="finance-period-start" label="服务周期开始日"><input className={INPUT_CLASS} id="finance-period-start" onChange={(event) => setPeriodStart(event.target.value)} type="date" value={periodStart} /></FormField>
            <FormField hint="留空时按下个月同日计算" htmlFor="finance-period-end" label="服务周期结束日（可选）"><input className={INPUT_CLASS} id="finance-period-end" onChange={(event) => setPeriodEnd(event.target.value)} type="date" value={periodEnd} /></FormField>
          </>}
          <FormField htmlFor="finance-amount" label={kind === "API" ? "充值金额" : "订阅金额"}><MoneyAmountInput id="finance-amount" onChange={setAmount} value={amount} /></FormField>
          <FormField htmlFor="finance-cash" label="人民币实付"><MoneyAmountInput id="finance-cash" onChange={setCashPaidCny} value={cashPaidCny} /></FormField>
          <FormField htmlFor="finance-occurred" label={kind === "API" ? "充值时间" : "扣费时间"}><input className={INPUT_CLASS} id="finance-occurred" onChange={(event) => setOccurredAt(event.target.value)} type="datetime-local" value={occurredAt} /></FormField>
          <FormField htmlFor="finance-reference" label="付款凭证号（可选）"><input className={INPUT_CLASS} id="finance-reference" onChange={(event) => setExternalReference(event.target.value)} value={externalReference} /></FormField>
          <div className="md:col-span-2"><FormField htmlFor="finance-description" label="说明"><textarea className={`${INPUT_CLASS} min-h-20 w-full py-2`} id="finance-description" onChange={(event) => setDescription(event.target.value)} value={description} /></FormField></div>
        </div>
        {kind === "CODING_PLAN" ? <p className="mt-3 text-[12px] text-ql-fg-secondary">登记后按原金额和周期自动续订，可在当前服务周期旁取消。</p> : null}
        {validationError || mutation.error || confirmDuplicate.error ? <p className="mt-3 text-[12px] text-ql-danger" role="alert">{validationError || mutation.error?.message || confirmDuplicate.error?.message}</p> : null}
        <div className="mt-4 flex justify-end gap-2"><button className="rounded-lg border border-ql-border px-4 py-2 text-[13px]" onClick={() => { resetEntry(); setEntryOpen(false); }} type="button">取消</button>{duplicate ? <button className="rounded-lg bg-ql-warning px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50" disabled={confirmDuplicate.isPending} onClick={() => confirmDuplicate.mutate({ ...duplicate, idempotencyKey: crypto.randomUUID() }, { onSuccess: () => { resetEntry(); setEntryOpen(false); } })} type="button">{confirmDuplicate.isPending ? "确认中…" : "确认重复入账"}</button> : <button className="rounded-lg bg-ql-action px-4 py-2 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={mode !== "ACTIVE" || mutation.isPending} onClick={submit} type="button">{mutation.isPending ? "入账中…" : "入账确认"}</button>}</div>
      </section> : null}

      <section className="mt-4 rounded-xl border border-ql-border-zone bg-ql-surface p-4">
        <div className="grid gap-3 md:grid-cols-2"><FormField htmlFor="finance-history-resource" label="历史记录资源"><select className={INPUT_CLASS} id="finance-history-resource" onChange={(event) => setResourceId(event.target.value || null)} value={resourceId ?? ""}><option value="">请选择</option>{resources.map((resource) => <option key={resource.id} value={resource.id}>{providerName(resource)} · {resource.name}</option>)}</select></FormField>{selected?.mode === "CODING_PLAN" ? <FinanceMetric label="当前服务周期" value={periods.data?.periods.find((period) => period.current_status === "ACTIVE") ? `${formatShanghaiDate(periods.data.periods.find((period) => period.current_status === "ACTIVE")!.period_start)} ～ ${formatShanghaiDate(periods.data.periods.find((period) => period.current_status === "ACTIVE")!.period_end_exclusive)} · ${formatCount(periods.data.periods.find((period) => period.current_status === "ACTIVE")!.token_usage.true_tokens)} Token` : "无有效周期"} /> : null}</div>
        {selected?.mode === "CODING_PLAN" && ["kimi", "zhipu"].includes(providers.find((provider) => provider.id === selected.provider_id)?.code ?? "") ? <SubscriptionAutoRenewal key={selected.id} resourceId={selected.id} writable={mode === "ACTIVE"} /> : null}
        <h3 className="mt-4 text-[14px] font-semibold text-ql-fg">{month} 资金记录</h3>
        {events.isLoading ? <p className="py-4 text-[12px] text-ql-fg-tertiary">读取中…</p> : events.error ? <p className="py-4 text-[12px] text-ql-danger">{events.error.message}</p> : events.data?.items.length ? <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[48rem] text-left text-[12px]"><thead><tr className="border-b border-ql-border text-ql-fg-tertiary"><th className="py-2">类型</th><th>原币金额</th><th>人民币实付</th><th>发生时间</th><th>说明</th></tr></thead><tbody>{events.data.items.map((event) => <tr className="border-b border-ql-border-zone" key={event.id}><td className="py-2 whitespace-nowrap">{eventLabel(event.eventType)}{event.eventType === "CODING_PLAN_RENEWAL" ? <span className="ml-2 whitespace-nowrap text-[11px] text-ql-fg-tertiary">{event.source === "SYSTEM_RENEWAL" ? "系统续订" : "人工续订"}</span> : null}</td><td>{event.accountCurrency} {formatMoney(event.accountAmount)}</td><td>{event.cashPaidCny === null ? "—" : `¥${formatMoney(event.cashPaidCny)}`}</td><td>{formatDateTimeFull(event.occurredAt)}</td><td>{event.description ?? "—"}</td></tr>)}</tbody></table></div> : <p className="py-4 text-[12px] text-ql-fg-tertiary">该月暂无资金记录</p>}
      </section>
    </div>
  );
}

function FinanceMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-ql-border bg-ql-surface px-3 py-2"><p className="text-[11px] text-ql-fg-tertiary">{label}</p><p className="mt-1 font-mono text-[14px] font-semibold text-ql-fg">{value}</p></div>;
}

function TypeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button aria-pressed={active} className={`rounded-lg px-4 py-2 text-[13px] ${active ? "bg-ql-action text-white" : "border border-ql-border bg-ql-surface text-ql-fg"}`} onClick={onClick} type="button">{label}</button>;
}
