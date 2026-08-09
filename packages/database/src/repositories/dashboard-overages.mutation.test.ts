import { describe, expect, it } from "vitest";
import { listDashboardOverages } from "./dashboard-overages.js";

function requireToken(value: unknown): void {
  if (typeof value === "string" && value.length === 0) throw new Error("empty query token");
  if (Array.isArray(value) && value.length === 0) throw new Error("empty select list");
  if (Array.isArray(value)) value.forEach(requireToken);
}

class OverageQuery {
  constructor(private readonly rows: unknown[]) {}
  innerJoin(table: unknown, left: unknown, right: unknown) {
    requireToken(table); requireToken(left); requireToken(right); return this;
  }
  where(column: unknown, operator: unknown, value: unknown) {
    requireToken(column); requireToken(operator); requireToken(value); return this;
  }
  orderBy(column: unknown, direction: unknown) {
    requireToken(column); requireToken(direction); return this;
  }
  select(columns: unknown) { requireToken(columns); return this; }
  execute() { return Promise.resolve(this.rows); }
}

const row = (quota: bigint, used: bigint, overage: bigint) => ({
  principal_id: "principal", principal_name: "A", principal_type: "EMPLOYEE",
  provider: "alpha", model_alias: "*", quota_value: quota,
  used_value: used, overage_value: overage,
});

describe("dashboard overage query mutation contract", () => {
  it("filters the enterprise query and computes a positive overage ratio", async () => {
    const db = {
      selectFrom(table: unknown) {
        requireToken(table);
        return new OverageQuery([row(100n, 120n, 20n)]);
      },
    };
    await expect(listDashboardOverages(db as never, "enterprise")).resolves.toEqual([{
      principalId: "principal", principalName: "A", principalType: "EMPLOYEE",
      provider: "alpha", modelAlias: "*", quotaValue: "100", usedValue: "120",
      overageValue: "20", overageRatio: "0.2",
    }]);
  });

  it("returns a zero ratio when the grant quota is zero", async () => {
    const db = { selectFrom: () => new OverageQuery([row(0n, 2n, 2n)]) };
    await expect(listDashboardOverages(db as never, "enterprise"))
      .resolves.toEqual([expect.objectContaining({ overageRatio: "0" })]);
  });
});
