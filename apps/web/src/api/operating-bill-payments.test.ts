import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadOperatingBillPayments } from "./operating-bill-payments";
import type { ProviderFinanceEvent } from "./provider-finance-types";

const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client", () => client);
const event = (
  id: string,
  eventType: ProviderFinanceEvent["eventType"],
  cashPaidCny: string | null,
): ProviderFinanceEvent => ({
  id,
  eventType,
  cashPaidCny,
  providerResourceId: "r1",
  accountAmount: "100",
  accountCurrency: "CNY",
  occurredAt: "2026-09-01T00:00:00.000Z",
  externalReference: null,
  description: null,
  source: "ADMIN",
  createdAt: "2026-09-01T00:00:00.000Z",
});

describe("经营账单实付流水", () => {
  beforeEach(() => {
    client.get.mockReset();
  });

  it("仅读取实付采购、充值和冲销，排除期初、赠送和金额未知", async () => {
    const items = [
      event("recharge", "API_RECHARGE", "80"),
      event("plan", "CODING_PLAN_PURCHASE", "199"),
      event("renewal", "CODING_PLAN_RENEWAL", "99"),
      event("refund", "REVERSAL", "-20"),
      event("opening", "API_OPENING_BALANCE", "1000"),
      event("free", "API_RECHARGE", "0"),
      event("unknown", "API_RECHARGE", null),
      event("correction", "API_BALANCE_RECONCILIATION", "50"),
    ];
    client.get.mockResolvedValue({ items, total: items.length });
    const result = await loadOperatingBillPayments("2026-09", ["r1", "r1"]);
    expect(result.map((row) => row.id).sort()).toEqual([
      "plan",
      "recharge",
      "refund",
      "renewal",
    ]);
    expect(result.find((row) => row.id === "refund")?.cashPaidCny).toBe("-20");
    expect(client.get).toHaveBeenCalledTimes(1);
    const url = new URL(client.get.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/provider-resources/r1/finance/events");
    expect(url.searchParams.get("from")).toBe("2026-08-31T16:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-09-30T16:00:00.000Z");
  });

  it("超过 100 条也读取后续页，不漏掉尾页付款", async () => {
    client.get
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, i) =>
          event(String(i), "API_OPENING_BALANCE", null),
        ),
        total: 101,
      })
      .mockResolvedValueOnce({
        items: [event("last", "CODING_PLAN_RENEWAL", "199")],
        total: 101,
      });
    expect(await loadOperatingBillPayments("2026-09", ["r1"])).toEqual([
      event("last", "CODING_PLAN_RENEWAL", "199"),
    ]);
    expect(client.get.mock.calls[1]![0]).toContain("offset=100");
  });

  it("页数据缺失或请求失败时报告错误，不显示部分金额为完整报表", async () => {
    client.get.mockResolvedValue({ items: [], total: 1 });
    await expect(loadOperatingBillPayments("2026-09", ["r1"])).rejects.toThrow(
      "未读取完整",
    );
    client.get.mockRejectedValue(new Error("连接失败"));
    await expect(loadOperatingBillPayments("2026-09", ["r1"])).rejects.toThrow(
      "连接失败",
    );
  });
});
