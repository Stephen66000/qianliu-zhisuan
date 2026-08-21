import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OperatingBill, OperatingBillProvider } from "../api/operating-bills";
import { RechargeEntry } from "./OperatingBillRechargeEntry";

const mutate = vi.fn();
let mutationState = { mutate, isPending: false, error: null as Error | null };
vi.mock("../api/operating-bills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/operating-bills")>()),
  useRecordResourcePurchase: () => mutationState,
}));

function provider(id: string, currency: string, amount: string): OperatingBillProvider {
  return {
    providerResourceId: id, providerCode: "deepseek", providerName: "DeepSeek",
    resourceName: id, mode: "API", currency, apiCost: null, packageCost: "0",
    totalCost: null, endingBalance: "100", totalQuota: null, usedQuota: null,
    remainingQuota: null, quotaUnit: null, utilization: null, activePrincipalCount: 0,
    status: "ACTIVE", planAssessment: null, idleEntitlementCost: null,
    assessmentBasis: null, operatingSnapshotId: `snapshot-${id}`,
    snapshotRechargeAmount: amount,
  };
}

function bill(overrides: Partial<OperatingBill> = {}): OperatingBill {
  return {
    month: "2026-08", timezone: "Asia/Shanghai", status: "DRAFT", version: 0,
    generatedAt: "2026-08-21T00:00:00Z", closedAt: null, closedBy: null, closeNote: null,
    summary: {
      totalCost: null, apiCost: null, packageCost: "0", endingBalance: "100",
      endingBalanceCurrency: "CNY", planUtilization: null, activePrincipalCount: 0,
      confirmedValueAmount: "0", confirmedNonMonetaryCount: 0, unallocatedCost: "0",
    },
    providers: [provider("api-cny", "CNY", "100")], subjects: [], values: [], gaps: [],
    versions: [], events: [], ...overrides,
  };
}

describe("经营账单显式充值登记", () => {
  beforeEach(() => {
    mutate.mockReset();
    mutationState = { mutate, isPending: false, error: null };
  });

  it("无 API 资源或已结账时不提供写入入口", () => {
    const { rerender } = render(<RechargeEntry bill={bill({ providers: [] })} />);
    expect(screen.queryByRole("heading", { name: "登记本月充值" })).toBeNull();
    rerender(<RechargeEntry bill={bill({ status: "CLOSED" })} />);
    expect(screen.queryByRole("heading", { name: "登记本月充值" })).toBeNull();
  });

  it("切换资源同步预填金额、币种和快照证据", async () => {
    const user = userEvent.setup();
    render(<RechargeEntry bill={bill({ providers: [
      provider("api-cny", "CNY", "100"), provider("api-usd", "USD", "25"),
    ] })} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "充值资源" }), "api-usd");
    expect(screen.getByPlaceholderText("充值金额")).toHaveValue("25.00");
    expect(screen.getByRole("textbox", { name: "充值币种" })).toHaveValue("USD");
    await user.click(screen.getByRole("button", { name: "确认充值并重算" }));
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      provider_resource_id: "api-usd", amount: "25.00", currency: "USD",
      evidence_ref: "operating_snapshot:snapshot-api-usd",
    }), expect.objectContaining({ onSuccess: expect.any(Function) }));
  });

  it("拒绝非法金额和空充值时间，并展示接口错误", async () => {
    const user = userEvent.setup();
    const view = render(<RechargeEntry bill={bill()} />);
    await user.clear(screen.getByPlaceholderText("充值金额"));
    await user.type(screen.getByPlaceholderText("充值金额"), "1.234");
    await user.click(screen.getByRole("button", { name: "确认充值并重算" }));
    expect(screen.getByRole("alert")).toHaveTextContent("最多保留两位小数");
    expect(mutate).not.toHaveBeenCalled();

    await user.clear(screen.getByPlaceholderText("充值金额"));
    await user.type(screen.getByPlaceholderText("充值金额"), "10");
    await user.clear(screen.getByLabelText("充值时间"));
    await user.click(screen.getByRole("button", { name: "确认充值并重算" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写充值时间");

    mutationState = { mutate, isPending: false, error: new Error("账期已结账") };
    view.rerender(<RechargeEntry bill={bill()} />);
    expect(screen.getByText("账期已结账")).toBeInTheDocument();
  });
});
