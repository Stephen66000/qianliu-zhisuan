import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { ProviderFinancePanel } from "./ProviderFinancePanel";
import type { Provider, ProviderResourceItem } from "../../api/types";
const mutate = vi.fn(), events = vi.fn(), confirm = vi.fn();
vi.mock("./SubscriptionAutoRenewal", () => ({SubscriptionAutoRenewal: () => <span>续订控制</span>}));
vi.mock("../../api/provider-finance", () => ({
  currentShanghaiMonth: () => "2026-08",
  useProviderFinanceSummary: () => ({data:null,isLoading:false,refetch:vi.fn()}),
  useProviderFinanceBalance: () => ({}), useConfirmProviderFinanceDuplicate: () => ({ mutate: confirm, isPending: false }),
  useProviderFinanceEvents: (id:string) => { events(id); return {data:{items:[]}}; },
  useProviderSubscriptionPeriods: () => ({data:{periods:[{id:"p",product_name:"已登记Kimi",period_start:"2026-08-19T00:00:00+08:00",period_end_exclusive:"2026-09-19T00:00:00+08:00",current_status:"ACTIVE",fixed_fee_amount:"199",fixed_fee_currency:"CNY",token_usage:{true_tokens:"100"}}]}}),
  useRecordProviderFinance: () => ({mutate}),
}));
const resources = ["api","kimi","other"].map((id) => ({id,name:id,provider_id:id,mode:id === "api" ? "API":"CODING_PLAN"})) as ProviderResourceItem[];
const providers = resources.map((r) => ({id:r.id,name:r.name,code:r.id})) as Provider[];
beforeEach(() => {mutate.mockReset();events.mockClear();confirm.mockReset();});
it("history can select any Coding Plan without the API entry mode resetting it", async () => {
  const user=userEvent.setup();render(<ProviderFinancePanel resources={resources} providers={providers} mode="ACTIVE" />);
  await user.selectOptions(screen.getByLabelText("历史记录资源"),"kimi");
  expect(screen.getByLabelText("历史记录资源")).toHaveValue("kimi");
  expect(screen.getByRole("region",{name:"已登记订阅"})).toHaveTextContent("CNY 199.00");
  await user.selectOptions(screen.getByLabelText("历史记录资源"),"other");
  expect(screen.getByLabelText("历史记录资源")).toHaveValue("other");
  expect(events).toHaveBeenLastCalledWith("other");
  expect(screen.getByText("续订控制")).toBeInTheDocument();
});
it("new Coding Plan sends the actual unchecked renewal choice with the registration", async () => {
  const user=userEvent.setup();render(<ProviderFinancePanel resources={resources} providers={providers} mode="ACTIVE" />);
  await user.selectOptions(screen.getByLabelText("历史记录资源"),"other");
  await user.click(screen.getByRole("button",{name:"充值／订阅"}));
  expect(screen.getByRole("checkbox",{name:"自动续订"})).toBeChecked();
  await user.click(screen.getByRole("checkbox",{name:"自动续订"}));
  await user.type(screen.getByLabelText("订阅金额"),"99");
  await user.type(screen.getByLabelText("人民币实付"),"99");
  await user.type(screen.getByLabelText("服务周期开始日"),"2026-09-07");
  await user.type(screen.getByLabelText("说明"),"九月续费");
  await user.type(screen.getByLabelText("证据引用"),"invoice-2026-09");
  await user.click(screen.getByRole("button",{name:"入账确认"}));
  expect(mutate).toHaveBeenCalledWith({
    kind:"CODING_PLAN",
    payload:{
      kind:"RENEWAL",product_name:"other",auto_renew:false,service_period_start:"2026-09-07",
      account_currency:"CNY",account_amount:"99.00",cash_paid_cny:"99.00",
      occurred_at:expect.any(String),description:"九月续费",evidence_ref:"invoice-2026-09",
      idempotency_key:expect.any(String),
    },
  },expect.anything());
});
it("daily API recharge sends description and evidence and blocks submission without them", async () => {
  const user=userEvent.setup();render(<ProviderFinancePanel resources={resources} providers={providers} mode="ACTIVE" />);
  await user.click(screen.getByRole("button",{name:"充值／订阅"}));
  await user.type(screen.getByLabelText("充值金额"),"120");
  await user.type(screen.getByLabelText("人民币实付"),"120");
  await user.click(screen.getByRole("button",{name:"入账确认"}));
  expect(mutate).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("必须填写事实说明");
  await user.type(screen.getByLabelText("说明"),"九月 API 充值");
  await user.click(screen.getByRole("button",{name:"入账确认"}));
  expect(mutate).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("必须填写证据引用");
  await user.type(screen.getByLabelText("证据引用"),"receipt-2026-09");
  await user.click(screen.getByRole("button",{name:"入账确认"}));
  expect(mutate).toHaveBeenCalledWith({
    kind:"API",
    payload:{
      account_currency:"CNY",account_amount:"120.00",cash_paid_cny:"120.00",
      occurred_at:expect.any(String),description:"九月 API 充值",evidence_ref:"receipt-2026-09",
      idempotency_key:expect.any(String),
    },
  },expect.anything());
});

it("重复入账必须明确二次确认；连续点击和失败重试复用同一幂等键，取消不写入", async () => {
  const user = userEvent.setup();
  mutate.mockImplementation((_input, callbacks) => {
    callbacks.onError(new ApiError(409, { error: "duplicate_confirmation_required", message: "疑似重复", detail: {
      candidateId: "candidate", confirmationToken: "token", requestHash: "hash",
    } }, ""));
    callbacks.onSettled();
  });
  render(<ProviderFinancePanel resources={resources} providers={providers} mode="ACTIVE" />);
  await user.click(screen.getByRole("button", { name: "充值／订阅" }));
  await user.type(screen.getByLabelText("充值金额"), "12");
  await user.type(screen.getByLabelText("人民币实付"), "12");
  await user.type(screen.getByLabelText("说明"), "隔离验收");
  await user.type(screen.getByLabelText("证据引用"), "receipt-visual");
  await user.click(screen.getByRole("button", { name: "入账确认" }));
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByText(/确认后将额外写入一笔资金记录/)).toBeVisible();
  expect(screen.getByLabelText("充值金额")).toBeDisabled();
  expect(screen.getByLabelText("历史记录资源")).toBeDisabled();
  const duplicateButton = screen.getByRole("button", { name: "确认重复入账" });
  expect(duplicateButton).toHaveAttribute("aria-describedby", "duplicate-finance-warning");
  await user.dblClick(duplicateButton);
  expect(confirm).toHaveBeenCalledTimes(1);
  const first = confirm.mock.calls[0]!;
  expect(first[0]).toEqual({ candidateId: "candidate", confirmationToken: "token", requestHash: "hash", idempotencyKey: expect.any(String) });
  act(() => first[1].onSettled());
  await user.click(duplicateButton);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(confirm.mock.calls[1]![0]).toEqual(first[0]);
  act(() => confirm.mock.calls[1]![1].onSettled());
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("region", { name: "充值登记" })).not.toBeInTheDocument();
});
