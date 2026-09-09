import { useEffect, useState } from "react";

import { type OperatingBill, useRecordResourcePurchase } from "../api/operating-bills";
import {
  BillCard,
  buttonPrimary,
  inputClass,
  SectionHeading,
} from "../components/operating-bill/BillShared";
import {
  MoneyAmountInput,
  normalizeMoneyAmount,
  validateMoneyAmount,
} from "../components/writes/MoneyAmountInput";

function localDateTimeInput(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16);
}

export function RechargeEntry({ bill }: { bill: OperatingBill }) {
  const apiResources = bill.providers.filter((row) => row.mode === "API");
  const mutation = useRecordResourcePurchase(bill.month);
  const [resourceId, setResourceId] = useState(apiResources[0]?.providerResourceId ?? "");
  const selected = apiResources.find((row) => row.providerResourceId === resourceId)
    ?? apiResources[0];
  const selectedId = selected?.providerResourceId ?? "";
  const suggestedAmount = selected?.snapshotRechargeAmount ?? "";
  const suggestedCurrency = selected?.currency ?? "CNY";
  const snapshotId = selected?.operatingSnapshotId ?? null;
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(suggestedCurrency);
  const [purchasedAt, setPurchasedAt] = useState(localDateTimeInput(new Date()));
  const [description, setDescription] = useState("");
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    setResourceId(selectedId);
    setAmount(suggestedAmount);
    setCurrency(suggestedCurrency);
  }, [selectedId, suggestedAmount, suggestedCurrency]);

  if (bill.status !== "DRAFT" || apiResources.length === 0) return null;

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
    const parsedAt = new Date(purchasedAt);
    if (Number.isNaN(parsedAt.getTime())) {
      setValidationError("请填写充值时间");
      return;
    }
    setValidationError("");
    mutation.mutate({
      provider_resource_id: selected.providerResourceId,
      purchase_type: "API_RECHARGE",
      amount: normalizeMoneyAmount(amount),
      currency,
      purchased_at: parsedAt.toISOString(),
      description: description.trim() || null,
      evidence_ref: snapshotId ? `operating_snapshot:${snapshotId}` : null,
    }, {
      onSuccess: () => {
        setAmount("");
        setDescription("");
        setPurchasedAt(localDateTimeInput(new Date()));
      },
    });
  };

  return (
    <BillCard>
      <SectionHeading
        title="登记本月充值"
        description="确认后写入独立充值流水和审计记录；资源快照金额只预填，不会自动入账"
      />
      <div className="grid gap-3 px-4 pb-4 md:grid-cols-5">
        <select
          aria-label="充值资源"
          className={inputClass}
          disabled={mutation.isPending}
          onChange={(event) => setResourceId(event.target.value)}
          value={selectedId}
        >
          {apiResources.map((row) => (
            <option key={row.providerResourceId} value={row.providerResourceId}>
              {row.providerName} · {row.resourceName}
            </option>
          ))}
        </select>
        <MoneyAmountInput
          aria-invalid={Boolean(validationError)}
          className={inputClass}
          id="bill-recharge-amount"
          onChange={setAmount}
          placeholder="充值金额"
          value={amount}
        />
        <input
          aria-label="充值币种"
          className={inputClass}
          disabled={mutation.isPending}
          maxLength={8}
          onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          value={currency}
        />
        <input
          aria-label="充值时间"
          className={inputClass}
          disabled={mutation.isPending}
          onChange={(event) => setPurchasedAt(event.target.value)}
          type="datetime-local"
          value={purchasedAt}
        />
        <input
          aria-label="充值说明"
          className={inputClass}
          disabled={mutation.isPending}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="说明（可选）"
          value={description}
        />
        <div className="flex items-center justify-end gap-3 md:col-span-5">
          {validationError ? (
            <span className="text-[12px] text-ql-danger" role="alert">{validationError}</span>
          ) : null}
          {mutation.error ? (
            <span className="text-[12px] text-ql-danger">{mutation.error.message}</span>
          ) : null}
          <button data-write-action
            className={buttonPrimary}
            disabled={mutation.isPending}
            onClick={save}
            type="button"
          >
            {mutation.isPending ? "登记中…" : "确认充值并重算"}
          </button>
        </div>
      </div>
    </BillCard>
  );
}
