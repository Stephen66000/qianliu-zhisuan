import { describe, expect, it } from "vitest";

import {
  assertDepartmentCostConserved,
  DepartmentCostNotConservedError,
} from "./department-cost-evidence.js";
import type { DepartmentBillView } from "./department-cost-types.js";

function view(status: DepartmentBillView["conservation"]["status"]): DepartmentBillView {
  return {
    month: "2026-10",
    timezone: "Asia/Shanghai",
    status: "DRAFT",
    version: 0,
    rows: [],
    totals: {
      inputTokens: "0", outputTokens: "0", actualTokens: "0",
      apiCost: "0.00000000", packageCost: "0.00000000",
      totalCost: "0.00000000", requestCount: 0,
    },
    conservation: {
      status,
      tokenDifference: status === "MISMATCH" ? "1" : "0",
      apiCostDifference: "0.00000000",
      packageCostDifference: "0.00000000",
      totalCostDifference: "0.00000000",
    },
    reasonCodes: [],
    generatedAt: "2026-10-31T16:00:00.000Z",
  };
}

describe("W20 部门关账守恒硬门禁", () => {
  it("守恒时允许继续，MISMATCH 时抛出不可绕过的专用错误", () => {
    expect(() => assertDepartmentCostConserved(view("BALANCED"))).not.toThrow();
    expect(() => assertDepartmentCostConserved(view("UNKNOWN"))).not.toThrow();
    try {
      assertDepartmentCostConserved(view("MISMATCH"));
      throw new Error("expected_department_conservation_error");
    } catch (error) {
      expect(error).toBeInstanceOf(DepartmentCostNotConservedError);
      expect((error as Error).message).toBe("department_cost_not_conserved");
      expect((error as DepartmentCostNotConservedError).conservation).toMatchObject({
        status: "MISMATCH", tokenDifference: "1",
      });
    }
  });
});
