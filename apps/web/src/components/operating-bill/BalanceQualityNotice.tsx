import { Link } from "react-router-dom";
import type { OperatingBill } from "../../api/operating-bills";

/** Registered funding and an unconfirmed month-end balance are different facts. */
export function BalanceQualityNotice({ gaps }: { gaps: OperatingBill["gaps"] }) {
  const opening = gaps.filter((gap) => gap.code === "API_MONTH_OPENING_COST_UNKNOWN");
  const accountKey = (gap: OperatingBill["gaps"][number]) =>
    `${gap.providerResourceId ?? ""}:${gap.field?.split(":").slice(1).join(":") ?? ""}`;
  const openingAccounts = new Set(opening.map(accountKey));
  const current = gaps.filter((gap) => gap.code === "API_BALANCE_COST_UNKNOWN"
    && !openingAccounts.has(accountKey(gap)));
  const notices = [...opening, ...current];
  const negative = gaps.filter((gap) => gap.code === "API_NEGATIVE_RECONCILIATION_REQUIRED");
  if (notices.length === 0 && negative.length === 0) return null;
  return <>
    {notices.length > 0 ? <div role="alert" className="rounded-lg bg-ql-warning-soft p-3 text-[13px] text-ql-warning">
      <p>{opening.length > 0
        ? "资金初始余额已登记；历史费用仍有待核实记录，本月期初结余暂无法确认。"
        : "账户费用仍有待核实记录，期末余额暂无法确认。"}</p>
      {notices.map((gap) => {
        const params = new URLSearchParams({ tab: "details" });
        if (gap.providerResourceId) params.set("provider_resource_id", gap.providerResourceId);
        // Omit a lower bound: a request may have started before its settlement window.
        if (gap.requestRangeTo) params.set("to", gap.requestRangeTo);
        return <p key={`${gap.code}:${gap.providerResourceId ?? ""}:${gap.field ?? ""}`} className="mt-1">
          {gap.message}{" "}
          <Link className="underline" to={`/usage?${params.toString()}`}>核查该资源历史用量</Link>
        </p>;
      })}
    </div> : null}
    {negative.length > 0 ? <div role="alert" className="rounded-lg bg-ql-warning-soft p-3 text-[13px] text-ql-warning">
      <p>内部账本出现负余额，期初或期末金额需要核对资金记录。</p>
      {negative.map((gap) => <p key={`${gap.providerResourceId ?? ""}:${gap.field ?? ""}`} className="mt-1">{gap.message}</p>)}
      <Link className="mt-1 inline-block underline" to="/resources">核对资金记录</Link>
    </div> : null}
  </>;
}
