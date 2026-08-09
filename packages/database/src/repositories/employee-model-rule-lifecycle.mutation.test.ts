import { describe, expect, it } from "vitest";
import {
  disableEmployeeRuleVersion,
  refreshEmployeeKeyModels,
} from "./employee-model-rule-lifecycle.js";

type Filter = { column: unknown; operator?: unknown; value?: unknown };
type Expression = { kind: string; values?: unknown[]; value?: unknown };

function requireToken(value: unknown): void {
  if (typeof value === "string" && value.length === 0) throw new Error("empty query token");
  if (Array.isArray(value) && value.length === 0) throw new Error("empty select list");
  if (Array.isArray(value)) value.forEach(requireToken);
}

class LifecycleQuery {
  private selected: unknown;
  private readonly filters: Filter[] = [];
  constructor(private readonly trx: LifecycleTransaction, private readonly table: string) {}
  select(value: unknown) { requireToken(value); this.selected = value; return this; }
  innerJoin(table: string, join?: unknown, right?: unknown) {
    requireToken(table); requireToken(right);
    if (typeof join === "string") requireToken(join);
    if (typeof join === "function") {
      let joined = false;
      join({ onRef: (left: unknown, operator: unknown, reference: unknown) => {
        requireToken(left); requireToken(operator); requireToken(reference); joined = true;
      } });
      if (!joined) throw new Error("join predicate missing");
    }
    return this;
  }
  where(column: unknown, operator?: unknown, value?: unknown) {
    if (typeof column === "function") {
      const expression = column(this.trx.expressionBuilder());
      this.filters.push({ column: "$expression", value: expression });
      this.trx.filters.push({ table: this.table, column: "$expression", value: expression });
      return this;
    }
    requireToken(column); requireToken(operator); requireToken(value);
    this.filters.push({ column, operator, value });
    this.trx.filters.push({ table: this.table, column, operator, value });
    return this;
  }
  whereRef(left: unknown, operator: unknown, right: unknown) {
    requireToken(left); requireToken(operator); requireToken(right);
    this.trx.refs.push({ table: this.table, left, operator, right });
    return this;
  }
  distinct() { this.trx.distinctTables.push(this.table); return this; }
  forUpdate() { this.trx.lockedTables.push(this.table); return this; }
  execute() { return Promise.resolve(this.trx.result(this.table, this.selected, this.filters, "all")); }
  executeTakeFirst() { return Promise.resolve(this.trx.result(this.table, this.selected, this.filters, "first")); }
}

class LifecycleUpdate {
  private row: unknown;
  private readonly filters: Filter[] = [];
  constructor(private readonly trx: LifecycleTransaction, private readonly table: string) {}
  set(row: unknown) { this.row = row; return this; }
  where(column: unknown, operator?: unknown, value?: unknown) {
    requireToken(column); requireToken(operator); requireToken(value);
    this.filters.push({ column, operator, value });
    return this;
  }
  execute() {
    this.trx.updates.push({ table: this.table, row: this.row, filters: this.filters });
    return Promise.resolve({ numUpdatedRows: 1n });
  }
}

class LifecycleInsert {
  private row: unknown;
  constructor(private readonly trx: LifecycleTransaction, private readonly table: string) {}
  values(row: unknown) { this.row = row; return this; }
  onConflict(callback: (oc: { doNothing: () => void }) => void) {
    callback({ doNothing: () => this.trx.conflicts.push(this.table) });
    return this;
  }
  execute() {
    this.trx.inserts.push({ table: this.table, row: this.row });
    return Promise.resolve({ numInsertedOrUpdatedRows: 1n });
  }
}

class LifecycleTransaction {
  keyExists = true;
  assignments: Array<{
    principal_id: string;
    grant_id: string;
    unified_model_id: string;
    provider_resource_id: string;
  }> = [];
  readonly filters: Array<Filter & { table: string }> = [];
  readonly refs: Array<{ table: string; left: unknown; operator: unknown; right: unknown }> = [];
  readonly distinctTables: string[] = [];
  readonly lockedTables: string[] = [];
  readonly conflicts: string[] = [];
  readonly updates: Array<{ table: string; row: unknown; filters: Filter[] }> = [];
  readonly inserts: Array<{ table: string; row: unknown }> = [];
  readonly expressions: Expression[] = [];
  expressionBuilder() {
    const record = (expression: Expression): Expression => {
      this.expressions.push(expression);
      return expression;
    };
    const builder = Object.assign(
      (column: unknown, operator: unknown, value: unknown) => {
        requireToken(column); requireToken(operator); requireToken(value);
        return record({ kind: "comparison", values: [column, operator, value] });
      },
      {
        and: (values: unknown[]) => record({ kind: "and", values }),
        or: (values: unknown[]) => record({ kind: "or", values }),
        exists: (value: unknown) => record({ kind: "exists", value }),
        ref: (value: unknown) => {
          requireToken(value);
          return record({ kind: "ref", value });
        },
        selectFrom: (table: string) => this.selectFrom(table),
      },
    );
    return builder;
  }
  selectFrom(table: string) { requireToken(table); return new LifecycleQuery(this, table); }
  updateTable(table: string) { requireToken(table); return new LifecycleUpdate(this, table); }
  insertInto(table: string) { requireToken(table); return new LifecycleInsert(this, table); }
  result(table: string, selected: unknown, filters: Filter[], mode: "all" | "first") {
    if (table === "principal_key") return this.keyExists ? { id: "key" } : undefined;
    if (table === "principal_model_manual_authorization") {
      return [{ unified_model_id: "manual" }, { unified_model_id: "shared" }];
    }
    if (table === "principal_provider_disabled_model") return [{ unified_model_id: "blocked" }];
    if (table === "principal_grant") {
      return [{ unified_model_id: "pool" }, { unified_model_id: "blocked" }, { unified_model_id: "shared" }];
    }
    if (table === "employee_model_rule_assignment" && Array.isArray(selected)) return this.assignments;
    if (table === "employee_model_rule_assignment" && selected === "employee_model_rule_assignment.unified_model_id") {
      return [{ unified_model_id: "managed" }, { unified_model_id: "shared" }];
    }
    if (table === "employee_model_rule_assignment" && selected === "id") {
      const model = filters.find((filter) => filter.column === "unified_model_id")?.value;
      return model === "model-maintained" ? { id: "other-assignment" } : undefined;
    }
    if (table === "model_route") {
      const resource = filters.find((filter) => filter.column === "model_route.provider_resource_id")?.value;
      if (resource === "resource-alpha") return { code: "alpha" };
      if (resource === "resource-beta") return { code: "beta" };
      return undefined;
    }
    return mode === "all" ? [] : undefined;
  }
}

describe("POOL-039 employee rule lifecycle mutation contract", () => {
  it("recomputes the Key whitelist from manual, managed and provider-pool models", async () => {
    const trx = new LifecycleTransaction();
    await refreshEmployeeKeyModels(trx as never, "enterprise", "principal-a");
    const keyUpdate = trx.updates.find((update) => update.table === "principal_key");
    expect(keyUpdate?.row).toEqual({
      allowed_model_ids: JSON.stringify(["managed", "manual", "pool", "shared"]),
    });
    expect(keyUpdate?.filters).toEqual([
      { column: "enterprise_id", operator: "=", value: "enterprise" },
      { column: "principal_id", operator: "=", value: "principal-a" },
      { column: "status", operator: "=", value: "ACTIVE" },
    ]);
    expect(trx.lockedTables).toContain("principal_key");
    expect(trx.distinctTables).toContain("principal_grant");
    expect(trx.refs).toContainEqual({
      table: "principal_grant", left: "provider.code", operator: "=", right: "principal_grant.provider",
    });
    expect(trx.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "principal_grant", column: "unified_model.status", operator: "=", value: "ACTIVE",
      }),
      expect.objectContaining({
        table: "principal_grant", column: "model_route.enabled", operator: "=", value: true,
      }),
      expect.objectContaining({
        table: "principal_grant", column: "provider_resource.status", operator: "in",
        value: ["ACTIVE", "DEGRADED"],
      }),
      expect.objectContaining({
        table: "principal_grant", column: "provider.status", operator: "=", value: "ACTIVE",
      }),
      expect.objectContaining({
        table: "billing_rule", column: "billing_rule.enabled", operator: "=", value: true,
      }),
      expect.objectContaining({
        table: "billing_rule", column: "billing_rule.effective_from", operator: "<=", value: expect.any(Date),
      }),
    ]));
    expect(trx.expressions.filter((expression) => expression.kind === "comparison"))
      .toEqual(expect.arrayContaining([
        { kind: "comparison", values: ["billing_rule.effective_to", "is", null] },
        { kind: "comparison", values: ["billing_rule.effective_to", ">", expect.any(Date)] },
        { kind: "comparison", values: ["billing_rule.provider_resource_id", "is", null] },
        { kind: "comparison", values: ["billing_rule.provider_resource_id", "=", expect.objectContaining({
          kind: "ref", value: "model_route.provider_resource_id",
        })] },
        { kind: "comparison", values: ["billing_rule.upstream_model", "is", null] },
        { kind: "comparison", values: ["billing_rule.upstream_model", "=", expect.objectContaining({
          kind: "ref", value: "model_route.upstream_model",
        })] },
        { kind: "comparison", values: ["provider_resource.mode", "=", "API"] },
        { kind: "comparison", values: ["billing_rule.rule_type", "=", "API_PRICE"] },
        { kind: "comparison", values: ["billing_rule.cache_hit_price", "is not", null] },
        { kind: "comparison", values: ["billing_rule.cache_miss_price", "is not", null] },
        { kind: "comparison", values: ["billing_rule.output_price", "is not", null] },
        { kind: "comparison", values: ["provider_resource.mode", "=", "CODING_PLAN"] },
        { kind: "comparison", values: ["billing_rule.rule_type", "in", ["TIME_WINDOW", "MODEL_TIER"]] },
        { kind: "comparison", values: ["billing_rule.multiplier", "is not", null] },
      ]));
    expect(trx.expressions.filter((expression) => expression.kind === "or")).toHaveLength(5);
    expect(trx.expressions.filter((expression) => expression.kind === "and")).toHaveLength(2);
    expect(trx.expressions.filter((expression) => expression.kind === "exists")).toHaveLength(1);
  });

  it("does not update a missing ACTIVE Key", async () => {
    const trx = new LifecycleTransaction();
    trx.keyExists = false;
    await refreshEmployeeKeyModels(trx as never, "enterprise", "principal-a");
    expect(trx.updates).toHaveLength(0);
  });

  it("disables assignments, preserves shared models and refreshes principals in stable order", async () => {
    const trx = new LifecycleTransaction();
    trx.assignments = [
      { principal_id: "principal-b", grant_id: "grant-b", unified_model_id: "model-alpha", provider_resource_id: "resource-alpha" },
      { principal_id: "principal-a", grant_id: "grant-a", unified_model_id: "model-maintained", provider_resource_id: "resource-beta" },
      { principal_id: "principal-a", grant_id: "grant-a", unified_model_id: "model-no-route", provider_resource_id: "resource-missing" },
      { principal_id: "principal-b", grant_id: "grant-b", unified_model_id: "model-alpha", provider_resource_id: "resource-alpha" },
    ];
    await expect(disableEmployeeRuleVersion(trx as never, "enterprise", "version-1"))
      .resolves.toEqual(["principal-b", "principal-a"]);
    expect(trx.updates).toContainEqual(expect.objectContaining({
      table: "employee_model_rule_assignment",
      row: expect.objectContaining({ status: "DISABLED", disabled_at: expect.any(Date) }),
    }));
    expect(trx.updates).toContainEqual(expect.objectContaining({
      table: "employee_model_rule_version",
      row: expect.objectContaining({ status: "DISABLED", disabled_at: expect.any(Date), updated_at: expect.any(Date) }),
      filters: [{ column: "id", operator: "=", value: "version-1" }],
    }));
    expect(trx.inserts).toEqual([{
      table: "principal_provider_disabled_model",
      row: expect.objectContaining({
        enterprise_id: "enterprise", principal_id: "principal-b", provider: "alpha",
        unified_model_id: "model-alpha", disable_rule_version_id: "version-1",
      }),
    }]);
    expect(trx.inserts.some((insert) =>
      (insert.row as { unified_model_id?: string }).unified_model_id === "model-maintained"))
      .toBe(false);
    expect(new Set(trx.filters
      .filter((filter) => filter.table === "model_route" && filter.column === "model_route.unified_model_id")
      .map((filter) => filter.value)))
      .toEqual(new Set(["model-alpha", "model-no-route"]));
    expect(trx.conflicts).toEqual(["principal_provider_disabled_model"]);
    const refreshedPrincipals = trx.filters
      .filter((filter) => filter.table === "principal_key" && filter.column === "principal_id")
      .map((filter) => filter.value);
    expect(refreshedPrincipals).toEqual(["principal-a", "principal-b"]);
  });

  it("still disables an empty rule version without touching assignments or Keys", async () => {
    const trx = new LifecycleTransaction();
    await expect(disableEmployeeRuleVersion(trx as never, "enterprise", "version-empty"))
      .resolves.toEqual([]);
    expect(trx.updates).toEqual([expect.objectContaining({ table: "employee_model_rule_version" })]);
    expect(trx.inserts).toHaveLength(0);
  });
});
