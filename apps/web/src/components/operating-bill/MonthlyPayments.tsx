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
      <SectionHeading title="本月买了什么" />
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
              <Cell>{labels[item.eventType]}</Cell>
              <Cell>{item.description ?? "—"}</Cell>
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
