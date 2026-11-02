import { describe, expect, it } from "vitest";
import { listDashboardOverages } from "./dashboard-overages.js";

function requireToken(value: unknown): void {
  if (typeof value === "string" && value.length === 0) throw new Error("empty query token");
  if (Array.isArray(value) && value.length === 0) throw new Error("empty select list");
  if (Array.isArray(value)) value.forEach(requireToken);
}

class OverageQuery {
  constructor(private readonly rows: unknown[], readonly filters: unknown[][] = []) {}
  innerJoin(table: unknown, left: unknown, right: unknown) {
    requireToken(table); requireToken(left); requireToken(right);
    if (typeof left === "function") {
      const join = { onRef: (...values: unknown[]) => { values.forEach(requireToken); return join; },
        on: (...values: unknown[]) => { values.forEach(requireToken); return join; } };
      left(join);
    }
    return this;
  }
  where(column: unknown, operator: unknown, value: unknown) {
    requireToken(column); requireToken(operator); requireToken(value);
    this.filters.push([column, operator, value]); return this;
  }
  whereRef(left: unknown, operator: unknown, right: unknown) {
    [left, operator, right].forEach(requireToken); return this;
  }
  orderBy(column: unknown, direction: unknown) {
    requireToken(column); requireToken(direction); return this;
  }
  select(columns: unknown) { requireToken(columns); return this; }
  execute() { return Promise.resolve(this.rows); }
  executeTakeFirstOrThrow() { return Promise.resolve(this.rows[0]); }
}

function database(input: { activation?: Date | null; legacy: unknown[]; monthly?: unknown[] }) {
  const queries = new Map<string, OverageQuery>();
  return {
    queries,
    selectFrom(table: string) {
      requireToken(table);
      const rows = table === "enterprise" ? [{ employee_quota_monthly_from: input.activation ?? null }]
        : table === "principal_quota_period" ? input.monthly ?? [] : input.legacy;
      const query = new OverageQuery(rows);
      queries.set(table, query);
      return query;
    },
  };
}

const row = (quota: bigint, used: bigint, overage: bigint) => ({
  principal_id: "principal", principal_name: "A", principal_type: "EMPLOYEE",
  provider: "alpha", model_alias: "*", quota_value: quota,
  used_value: used, overage_value: overage,
});

describe("dashboard overage query mutation contract", () => {
  it("filters the enterprise query and computes a positive overage ratio", async () => {
    const db = database({ legacy: [row(100n, 120n, 20n)] });
    await expect(listDashboardOverages(db as never, "enterprise")).resolves.toEqual([{
      principalId: "principal", principalName: "A", principalType: "EMPLOYEE",
      provider: "alpha", modelAlias: "*", quotaValue: "100", usedValue: "120",
      overageValue: "20", overageRatio: "0.2",
    }]);
  });

  it("returns a zero ratio when the grant quota is zero", async () => {
    const db = database({ legacy: [row(0n, 2n, 2n)] });
    await expect(listDashboardOverages(db as never, "enterprise"))
      .resolves.toEqual([expect.objectContaining({ overageRatio: "0" })]);
  });

  it("switches only employee overages to the current monthly account and preserves project counters", async () => {
    const now = new Date("2026-12-01T00:00:00+08:00");
    const db = database({ activation: now,
      legacy: [{ ...row(50n, 60n, 10n), principal_id: "project", principal_type: "PROJECT" }],
      monthly: [{ ...row(100n, 140n, 40n), principal_id: "employee" }],
    });
    const result = await listDashboardOverages(db as never, "enterprise", now);
    expect(result.map((item) => [item.principalId, item.principalType, item.overageValue])).toEqual([
      ["employee", "EMPLOYEE", "40"], ["project", "PROJECT", "10"],
    ]);
    expect(db.queries.get("quota_counter")!.filters).toContainEqual(["principal.type", "=", "PROJECT"]);
    expect(db.queries.get("principal_quota_period")!.filters).toEqual(expect.arrayContaining([
      ["principal_quota_period.enterprise_id", "=", "enterprise"], ["principal.type", "=", "EMPLOYEE"],
      ["period_start", "<=", now], ["period_end", ">", now],
    ]));
  });

  it("does not switch early and orders equal overages deterministically", async () => {
    const now = new Date("2026-11-30T23:59:59+08:00");
    const db = database({ activation: new Date("2026-12-01T00:00:00+08:00"), legacy: [
      { ...row(100n, 120n, 20n), principal_id: "z" },
      { ...row(100n, 110n, 10n), principal_id: "c" },
      { ...row(100n, 120n, 20n), principal_id: "a" },
    ], monthly: [row(1n, 9999n, 9998n)] });
    const result = await listDashboardOverages(db as never, "enterprise", now);
    expect(result.map((item) => item.principalId)).toEqual(["a", "z", "c"]);
    expect(db.queries.has("principal_quota_period")).toBe(false);
    expect(db.queries.get("quota_counter")!.filters).not.toContainEqual(["principal.type", "=", "PROJECT"]);
  });
});
