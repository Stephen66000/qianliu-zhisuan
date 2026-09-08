import type { AnalysisPayment } from "../../api/operating-analysis";
import type { OperatingBill } from "../../api/operating-bills";
import { useOperatingBillPayments } from "../../api/operating-bill-payments";
import {
  Cell,
  currencyMoney,
  Num,
  Table,
} from "../../pages/OperatingBillShared";
import { accountTime } from "./AccountShared";
import { BillCard, SectionHeading } from "./BillShared";

const labels: Record<string, string> = {
  API_RECHARGE: "API 充值",
  CODING_PLAN_PURCHASE: "套餐采购",
  CODING_PLAN_RENEWAL: "套餐续费",
  REVERSAL: "实付冲销",
};

export function MonthlyPayments({
  bill,
  payments,
}: {
  bill: OperatingBill;
  payments?: AnalysisPayment[];
}) {
  const query = useOperatingBillPayments(
    bill.month,
    bill.providers.map((row) => row.providerResourceId),
    payments === undefined,
  );
  const resources = new Map(
    bill.providers.map((row) => [row.providerResourceId, row]),
  );
  return (
    <BillCard className="overflow-hidden">
      <SectionHeading title="本月采购" />
      <Table
        headers={[
          "付款时间",
          "厂商",
          "资源",
          "购买类型",
          "购买内容",
          "实付金额",
          "付款凭据",
        ]}
      >
        {(payments ?? (query.error ? [] : (query.data ?? []))).map((item) => {
          const resource = resources.get(item.providerResourceId);
          return (
            <tr className="border-b border-ql-border-zone" key={item.id}>
              <Cell>{accountTime(item.occurredAt)}</Cell>
              <Cell>
                {("providerName" in item
                  ? item.providerName
                  : resource?.providerName) ?? "—"}
              </Cell>
              <Cell>
                {("resourceName" in item
                  ? item.resourceName
                  : resource?.resourceName) ?? item.providerResourceId}
              </Cell>
              <Cell><span className="inline-flex items-baseline gap-2 whitespace-nowrap">{labels[item.eventType]}
                {item.eventType === "CODING_PLAN_RENEWAL" ? <span className="text-[11px] text-ql-fg-tertiary">{item.source === "ADMIN" || item.source === "MANUAL" || item.source === "IMPORT" ? "人工续订" : item.source === "PROVIDER_SYNC" || item.source === "SYSTEM_RENEWAL" ? "系统续订" : "历史续订"}</span> : null}
              </span></Cell>
              <Cell><span className="whitespace-nowrap">{item.description ?? ((item.eventType === "CODING_PLAN_RENEWAL" || item.eventType === "CODING_PLAN_PURCHASE") ? `${("providerName" in item ? item.providerName : resource?.providerName) ?? "套餐"} ${currencyMoney(item.cashPaidCny, "CNY")}` : "—")}</span></Cell>
              <Num>{currencyMoney(item.cashPaidCny, "CNY")}</Num>
              <Cell>{item.externalReference ?? "—"}</Cell>
            </tr>
          );
        })}
      </Table>
      {payments !== undefined ? (
        payments.length === 0 ? (
          <p className="p-6 text-center text-[13px]">
            本月暂无实付采购或充值记录
          </p>
        ) : null
      ) : query.isLoading ? (
        <p className="p-4 text-[13px]">正在读取实付流水…</p>
      ) : query.error ? (
        <p role="alert" className="p-4 text-[13px] text-ql-danger">
          {query.error.message}
        </p>
      ) : query.data?.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-ql-fg-secondary">
          本月暂无实付采购或充值记录
        </p>
      ) : null}
    </BillCard>
  );
}
