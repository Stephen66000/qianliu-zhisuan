import { describe, expect, it } from "vitest";
import { BudgetPutSchema, PurchasePostSchema, budgetState } from "./contracts.js";

describe("W20-06 预算口径", () => {
  it("覆盖缺失、零预算、警戒线和 100% 边界", () => {
    expect(budgetState("10", null, null)).toEqual({ rate: null, status: "NOT_SET" });
    expect(budgetState(null, "100", "0.8")).toEqual({ rate: null, status: "NOT_SET" });
    expect(budgetState("10", "100", null)).toEqual({ rate: null, status: "NOT_SET" });
    expect(budgetState("0", "100", "0.8")).toEqual({ rate: "0.00000000", status: "NORMAL" });
    expect(budgetState("10", "0", "0.8")).toEqual({ rate: null, status: "NOT_SET" });
    expect(budgetState("79.99999999", "100", "0.8")).toEqual({
      rate: "0.80000000", status: "NORMAL",
    });
    expect(budgetState("80", "100", "0.8")).toEqual({
      rate: "0.80000000", status: "WARNING",
    });
    expect(budgetState("100", "100", "0.8")).toEqual({
      rate: "1.00000000", status: "OVER_BUDGET",
    });
  });

  it("拒绝负数、超精度和不完整服务周期", () => {
    expect(BudgetPutSchema.safeParse({
      amount: "-1", currency: "CNY", warning_threshold: "0.8",
      expected_version: 0, idempotency_key: "budget-key-001",
    }).success).toBe(false);
    expect(BudgetPutSchema.safeParse({
      amount: "1.000000001", currency: "CNY", warning_threshold: "0.8",
      expected_version: 0, idempotency_key: "budget-key-002",
    }).success).toBe(false);
    expect(PurchasePostSchema.safeParse({
      purchase_type: "API_RECHARGE", amount: "1", currency: "CNY",
      purchased_at: "2026-08-01T00:00:00+08:00", service_period_start: "2026-08-01",
      idempotency_key: "purchase-key-001",
    }).success).toBe(false);
  });
});
