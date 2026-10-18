import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import type { Provider, ProviderResourceItem } from "../../api/types";
import { ProviderFinancePanel } from "./ProviderFinancePanel";

const mocks = vi.hoisted(() => ({ record: vi.fn(), confirm: vi.fn(), resetRecord: vi.fn(), resetConfirm: vi.fn() }));
vi.mock("./SubscriptionAutoRenewal", () => ({ SubscriptionAutoRenewal: () => null }));
vi.mock("../../api/provider-finance", () => ({
  currentShanghaiMonth: () => "2026-10",
  useProviderFinanceSummary: () => ({ data: null, isLoading: false }),
  useProviderFinanceBalance: () => ({}),
  useProviderFinanceEvents: () => ({ data: { items: [] } }),
  useProviderSubscriptionPeriods: () => ({ data: { periods: [] } }),
  useRecordProviderFinance: () => ({ mutate: mocks.record, reset: mocks.resetRecord }),
  useConfirmProviderFinanceDuplicate: () => ({ mutate: mocks.confirm, reset: mocks.resetConfirm }),
}));
const resources = [{ id: "api", provider_id: "provider", name: "验收API", mode: "API" }] as ProviderResourceItem[];
const providers = [{ id: "provider", name: "验收厂商" }] as Provider[];
const candidate = { candidateId: "candidate-A", confirmationToken: "token-A", requestHash: "hash-A" };
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function open(mode: "ACTIVE" | "DARK" = "ACTIVE") {
  const view = render(<ProviderFinancePanel resources={resources} providers={providers} mode={mode} />);
  fireEvent.click(screen.getByRole("button", { name: "充值／订阅" }));
  for (const [label, value] of [["充值金额", "12"], ["人民币实付", "12"], ["说明", "隔离资金事实"], ["证据引用", "receipt-A"]]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  return view;
}
function submit() { fireEvent.click(screen.getByRole("button", { name: "入账确认" })); }
function requireDuplicate() {
  submit();
  const callbacks = mocks.record.mock.calls.at(-1)![1];
  act(() => { callbacks.onError(new ApiError(409, { error: "duplicate_confirmation_required", message: "疑似重复", detail: candidate }, "")); callbacks.onSettled(); });
}
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); });

it("普通提交在回调返回前阻止连击，失败结束后复用原请求键重试", () => {
  open(); submit(); submit();
  expect(mocks.record).toHaveBeenCalledTimes(1);
  const first = mocks.record.mock.calls[0]!;
  expect(first[0].payload.idempotency_key).toMatch(uuid);
  act(() => { first[1].onError(new Error("网络中断")); first[1].onSettled(); });
  submit(); expect(mocks.record).toHaveBeenCalledTimes(2);
  expect(mocks.record.mock.calls[1]![0]).toEqual(first[0]);
});
it("普通提交成功清空表单、解除历史选择锁，重新登记生成新请求键", () => {
  open(); submit(); const first = mocks.record.mock.calls[0]!;
  act(() => { first[1].onSuccess(); first[1].onSettled(); });
  expect(screen.queryByRole("region", { name: "充值登记" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("历史记录资源")).not.toBeDisabled();
  expect(mocks.resetRecord).toHaveBeenCalledOnce(); expect(mocks.resetConfirm).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "充值／订阅" }));
  expect(screen.getByLabelText("充值金额")).toHaveValue("");
  for (const [label, value] of [["充值金额", "12"], ["人民币实付", "12"], ["说明", "新事实"], ["证据引用", "receipt-B"]]) fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  submit(); expect(mocks.record.mock.calls[1]![0].payload.idempotency_key).not.toEqual(first[0].payload.idempotency_key);
});
it.each([
  new Error("非API错误"),
  new ApiError(400, { error: "invalid_request", message: "参数错误", detail: candidate }, "错误"),
  ...[null, "wrong", {}, { ...candidate, candidateId: 3 }, { ...candidate, confirmationToken: null }, { ...candidate, requestHash: false }].map(detail => new ApiError(409, { error: "duplicate_confirmation_required", message: "不完整响应", detail }, "错误")),
])("不完整或非重复响应不生成确认候选 %#", error => {
  open(); submit(); const callbacks = mocks.record.mock.calls[0]![1];
  act(() => { callbacks.onError(error); callbacks.onSettled(); });
  expect(screen.queryByRole("button", { name: "确认重复入账" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("充值金额")).not.toBeDisabled();
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it("取消重复候选不写入，再打开只能普通登记，旧候选不能复用", () => {
  open(); requireDuplicate();
  expect(mocks.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.resetConfirm).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "充值／订阅" }));
  expect(screen.getByRole("button", { name: "入账确认" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认重复入账" })).not.toBeInTheDocument();
});
it("重复确认保留候选/令牌/哈希，失败解锁重试使用同键；成功只关闭一次", () => {
  open(); requireDuplicate();
  const button = screen.getByRole("button", { name: "确认重复入账" });
  expect(screen.getByLabelText("历史记录资源")).toBeDisabled();
  fireEvent.click(button); fireEvent.click(button);
  expect(mocks.confirm).toHaveBeenCalledOnce();
  const first = mocks.confirm.mock.calls[0]!;
  expect(first[0]).toEqual({ ...candidate, idempotencyKey: expect.stringMatching(uuid) });
  act(() => first[1].onSettled());
  fireEvent.click(button); expect(mocks.confirm).toHaveBeenCalledTimes(2);
  expect(mocks.confirm.mock.calls[1]![0]).toEqual(first[0]);
  act(() => { mocks.confirm.mock.calls[1]![1].onSuccess(); mocks.confirm.mock.calls[1]![1].onSettled(); });
  expect(screen.queryByRole("region", { name: "充值登记" })).not.toBeInTheDocument();
  expect(mocks.resetRecord).toHaveBeenCalledOnce(); expect(mocks.resetConfirm).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "充值／订阅" }));
  expect(screen.getByRole("button", { name: "入账确认" })).toBeInTheDocument();
});
it("只读模式不能从普通登记进入资金写入", () => {
  open("DARK"); expect(screen.getByRole("button", { name: "入账确认" })).toBeDisabled(); submit(); expect(mocks.record).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
});

it("候选生成后切换只读模式，确认入口仍被锁定；恢复操作权限后候选不串号", () => {
  const view = open(); requireDuplicate();
  view.rerender(<ProviderFinancePanel resources={resources} providers={providers} mode="DARK" />);
  const button = screen.getByRole("button", { name: "确认重复入账" });
  expect(button).toBeDisabled(); fireEvent.click(button); expect(mocks.confirm).not.toHaveBeenCalled();
  view.rerender(<ProviderFinancePanel resources={resources} providers={providers} mode="ACTIVE" />);
  fireEvent.click(button);
  expect(mocks.confirm).toHaveBeenCalledWith({ ...candidate, idempotencyKey: expect.stringMatching(uuid) }, expect.anything());
});
