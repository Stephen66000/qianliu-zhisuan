import { useEffect, useState } from "react";

import {
  type OperatingBill,
  useImportOperatingBillSnapshots,
  useRecordOpeningBalance,
} from "../api/operating-bills";
import { BillCard, buttonPrimary, buttonSecondary, inputClass, SectionHeading } from "../components/operating-bill/BillShared";
import { StatusTag } from "../components/dashboard/StatusTag";
import { MoneyAmountInput, validateMoneyAmount } from "../components/writes/MoneyAmountInput";
import { useAllPurchases } from "../api/v2-hooks";
import { useFeatureFlags } from "../feature-flags";
import { groupCurrencyAmounts, type CurrencyAmount } from "../lib/currency";
import { Cell, currencyFacts, currencyMoney, money, Num, Table } from "./OperatingBillShared";
import { RechargeEntry } from "./OperatingBillRechargeEntry";

export function OperatingBillOverview({ bill }: { bill: OperatingBill }) {
  const featureFlags = useFeatureFlags();
  const importer = useImportOperatingBillSnapshots(bill.month);
  const [importMessage, setImportMessage] = useState("");
  const showPurchases = featureFlags.FEATURE_DEPARTMENT_COST;
  const purchases = useAllPurchases(
    bill.month,
    bill.providers.map((row) => row.providerResourceId),
    showPurchases,
  );
  const apiSpends = compatibleProviderAmounts(
    bill.summary.apiSpends, bill.providers, "API", "apiCost", "apiSpendCurrency",
    bill.summary.apiCost, bill.summary.endingBalanceCurrency,
  );
  const packageCosts = compatibleProviderAmounts(
    bill.summary.packageCosts, bill.providers, "CODING_PLAN", "packageCost",
    "packageCostCurrency", bill.summary.packageCost, null,
  );
  const totalSpends = compatibleTotalAmounts(bill);
  const metrics = [
    ["期初余额", currencyFacts(bill.summary.openingBalances, bill.summary.openingBalance ?? null, bill.summary.endingBalanceCurrency), bill.summary.openingBalance === null ? amountGapNote(bill.summary.openingBalances, "待补期初余额") : "月初有效快照或上月期末承接"],
    ["本月充值", currencyFacts(bill.summary.rechargeAmounts, bill.summary.monthlyRecharge ?? null), "本账期 API 充值现金；按币种独立展示"],
    ["期末余额", currencyFacts(bill.summary.endingBalances, bill.summary.endingBalance, bill.summary.endingBalanceCurrency), bill.summary.endingBalance === null ? amountGapNote(bill.summary.endingBalances, "待补期末余额") : "API 预付余额"],
    ["API 花费", currencyFacts(apiSpends, null), bill.summary.apiSpendReason ?? "期初余额 + 本月充值 - 期末余额"],
    ["套餐费用", currencyFacts(packageCosts, null), "当月固定套餐成本；按币种独立展示"],
    ["本月总花费", currencyFacts(totalSpends, null), bill.summary.totalCost === null ? (bill.summary.apiSpendReason ?? (bill.summary.packageCost === null ? "待补套餐费用" : "不可跨币种合计；已知项保留")) : "API 花费 + 固定套餐费用"],
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
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value, note]) => (
          <article className="rounded-xl border border-ql-border-zone bg-ql-surface p-4" key={label}>
            <p className="text-[12px] text-ql-fg-secondary">{label}</p>
            <strong className="mt-2 block text-[24px] text-ql-fg">{value}</strong>
            <p className="mt-1 text-[11px] text-ql-fg-tertiary">{note}</p>
          </article>
        ))}
      </div>
      <RechargeEntry bill={bill} />
      <OpeningBalanceEntry bill={bill} />
      <BillCard className="overflow-hidden">
        <SectionHeading
          description="API 花费使用余额桥接；账本 API 计价仅作为核对证据"
          title="厂商投入构成"
          action={
            bill.status === "DRAFT" ? (
              <label className={buttonSecondary}>
                导入账单 CSV
                <input
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importCsv(file);
                    e.target.value = "";
                  }}
                  type="file"
                />
              </label>
            ) : undefined
          }
        />
        {importMessage ? <p className={`mx-4 mb-3 text-[12px] ${importer.error ? "text-ql-danger" : "text-ql-success"}`}>{importMessage}</p> : null}
        <p className="mx-4 mb-3 text-[11px] text-ql-fg-tertiary">CSV 表头：provider_resource_id、collected_at，以及对应的余额／费用或套餐额度字段；导入来源固定留痕为 BILL_RECONCILIATION。</p>
        <Table headers={["厂商 / 资源", "采购形态", "API 花费", "套餐费用", "月度花费", "使用情况", "状态"]}>
          {bill.providers.map((row) => (
            <tr className="border-b border-ql-border-zone" key={row.providerResourceId}>
              <Cell>
                {row.providerName}
                <span className="block text-[11px] text-ql-fg-tertiary">{row.resourceName}</span>
              </Cell>
              <Cell>{row.mode === "API" ? "API" : "Coding Plan"}</Cell>
              <Num>
                {row.apiCost === null ? (row.apiSpendReason ?? "—") : currencyMoney(row.apiCost, row.apiSpendCurrency ?? row.currency)}
                {row.mode === "API" && row.ledgerApiCost !== undefined ? <span className="block text-[11px] font-normal text-ql-fg-tertiary">账本 API 计价（核对证据） {currencyMoney(row.ledgerApiCost, row.currency)}</span> : null}
              </Num>
              <Num>{currencyMoney(row.packageCost, row.packageCostCurrency ?? row.currency)}</Num>
              <Num>{currencyMoney(row.totalCost, row.apiSpendCurrency ?? row.packageCostCurrency ?? row.currency)}</Num>
              <Cell>{row.mode === "API" ? `${row.activePrincipalCount} 个活跃主体` : `${row.usedQuota ?? "—"} / ${row.totalQuota ?? "—"} ${row.quotaUnit ?? ""}`}</Cell>
              <Cell>
                <StatusTag tone={row.status === "ACTIVE" ? "success" : "warning"}>{row.status}</StatusTag>
              </Cell>
            </tr>
          ))}
        </Table>
      </BillCard>
      {showPurchases ? (
        <BillCard className="overflow-hidden">
          <SectionHeading title="本月买了什么" description="采购／充值现金口径，与本月 API 花费和套餐费用分别展示" />
          <Table headers={["时间", "资源", "类型", "说明", "现金支出", "币种", "登记人"]}>
            {(purchases.data?.items ?? []).map((item) => {
              const resource = bill.providers.find((row) => row.providerResourceId === item.providerResourceId);
              return (
                <tr className="border-b border-ql-border-zone" key={item.id}>
                  <Cell>{new Date(item.purchasedAt).toLocaleString("zh-CN")}</Cell>
                  <Cell>{resource?.resourceName ?? item.providerResourceId}</Cell>
                  <Cell>{item.purchaseType === "API_RECHARGE" ? "API 充值" : "套餐采购"}</Cell>
                  <Cell>{item.description ?? item.evidenceRef ?? "—"}</Cell>
                  <Num>{currencyMoney(item.amount, item.currency)}</Num>
                  <Cell>{item.currency}</Cell>
                  <Cell>{item.createdBy}</Cell>
                </tr>
              );
            })}
          </Table>
          {purchases.isLoading ? <p className="p-4 text-[12px] text-ql-fg-tertiary">正在读取采购记录…</p> : purchases.error ? <p className="p-4 text-[12px] text-ql-danger">{purchases.error.message}</p> : (purchases.data?.items.length ?? 0) === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">本月暂无采购或充值记录</p> : null}
        </BillCard>
      ) : null}
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
    const hasApiRows = bill.providers.some((provider) => provider.mode === "API");
    const hasPlanRows = bill.providers.some((provider) => provider.mode === "CODING_PLAN");
    const isNonZero = (value: string | null) => value !== null && !/^0+(?:\.0+)?$/.test(value);
    if ((isNonZero(bill.summary.apiCost) && !hasApiRows)
      || (isNonZero(bill.summary.packageCost) && !hasPlanRows)) return [];
    const projected = bill.providers.map((provider) => ({
      amount: provider.mode === "API" ? provider.apiCost : provider.packageCost,
      currency: provider.mode === "API"
        ? provider.apiSpendCurrency ?? provider.currency
        : provider.packageCostCurrency ?? provider.currency,
    }));
    if (!projected.every((fact): fact is CurrencyAmount =>
      fact.amount !== null && fact.currency !== null)) return [];
    return groupCurrencyAmounts(projected);
  }
  return [];
}

function amountGapNote(
  facts: Array<{ currency: string; amount: string }> | undefined,
  missing: string,
): string {
  return facts?.length ? "存在多币种或部分资源缺口；已知事实按币种保留" : missing;
}
function OpeningBalanceEntry({ bill }: { bill: OperatingBill }) {
  const resources = bill.providers.filter((row) => row.mode === "API" && row.openingBalance === null);
  const mutation = useRecordOpeningBalance(bill.month);
  const [resourceId, setResourceId] = useState(resources[0]?.providerResourceId ?? "");
  const selected = resources.find((row) => row.providerResourceId === resourceId) ?? resources[0];
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(selected?.currency ?? bill.summary.endingBalanceCurrency ?? "CNY");
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState("");
  useEffect(() => {
    if (resources.some((row) => row.providerResourceId === resourceId)) return;
    const next = resources[0];
    setResourceId(next?.providerResourceId ?? "");
    setCurrency(next?.currency ?? bill.summary.endingBalanceCurrency ?? "CNY");
    setAmount("");
    setReason("");
    setValidationError("");
  }, [bill.summary.endingBalanceCurrency, resourceId, resources]);
  if (bill.status !== "DRAFT" || resources.length === 0) return null;
  const save = () => {
    const message = validateMoneyAmount(amount, true);
    if (message) {
      setValidationError(message);
      return;
    }
    if (!selected) {
      setValidationError("请选择 API 资源");
      return;
    }
    setValidationError("");
    mutation.mutate(
      {
        provider_resource_id: selected.providerResourceId,
        amount,
        currency,
        reason: reason.trim() || null,
      },
      {
        onSuccess: () => {
          setAmount("");
          setReason("");
        },
      },
    );
  };
  return (
    <BillCard>
      <SectionHeading title="补录期初余额" description="仅补充当前账期的期初事实；不覆盖资源当前余额，保存后自动重算月度经营结果" />
      <div className="grid gap-3 px-4 pb-4 md:grid-cols-4">
        <select
          aria-label="期初余额资源"
          className={inputClass}
          disabled={mutation.isPending}
          onChange={(event) => {
            const next = resources.find((row) => row.providerResourceId === event.target.value);
            setResourceId(event.target.value);
            if (next?.currency) setCurrency(next.currency);
          }}
          value={resourceId}
        >
          {resources.map((row) => (
            <option key={row.providerResourceId} value={row.providerResourceId}>
              {row.providerName} · {row.resourceName}
            </option>
          ))}
        </select>
        <MoneyAmountInput aria-invalid={Boolean(validationError)} className={inputClass} disabled={mutation.isPending} id="opening-balance-amount" onChange={setAmount} placeholder="期初余额" value={amount} />
        <input aria-label="期初余额币种" className={inputClass} disabled={mutation.isPending} maxLength={8} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="CNY" value={currency} />
        <input aria-label="期初余额说明" className={inputClass} disabled={mutation.isPending} maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="补录依据（可选）" value={reason} />
        <div className="md:col-span-4 flex items-center justify-end gap-3">
          {validationError ? (
            <span className="text-[12px] text-ql-danger" role="alert">
              {validationError}
            </span>
          ) : null}
          {mutation.error ? <span className="text-[12px] text-ql-danger">{mutation.error.message}</span> : null}
          <button className={buttonPrimary} disabled={mutation.isPending} onClick={save} type="button">
            保存并重算
          </button>
        </div>
      </div>
    </BillCard>
  );
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
