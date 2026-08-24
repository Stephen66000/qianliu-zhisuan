import { describe, expect, it } from "vitest";
import { resolvePoolQuota } from "./employee-model-rule-quota.js";
import {
  captureManualBaseline,
  lockRuleFamily,
  lockVersion,
  principalIdsForRuleFamily,
  providerCodesForRuleFamily,
  readRuleReference,
} from "./employee-model-rule-lock-context.js";
import { ensureSingleRule } from "./principal-single-rule.js";
import { lockActivePrincipalKeys, lockActiveProviderPools } from "./principal-access-locks.js";
import { computeAllowedModelIds, stableHash, stableProviderCodes } from "./principal-access-config-repository.js";

type QueryResult = unknown;

class MutationQuery {
  private selected: unknown;
  private filters: Array<{ column: unknown; operator?: string; value?: unknown }> = [];
  private mode: "first" | "all" = "first";

  constructor(private readonly trx: MutationTransaction, private readonly table: string) {}

  select(columns: unknown) { this.selected = columns; this.trx.queryOps.push(`${this.table}.select:${String(columns)}`); return this; }
  selectAll() { this.selected = "all"; return this; }
  where(column: unknown, operator?: string, value?: unknown) {
    if (typeof column === "function") {
      const expressionBuilder = Object.assign((...args: unknown[]) => args, {
        or: (items: unknown[]) => items,
        and: (items: unknown[]) => items,
      });
      column(expressionBuilder);
    }
    this.filters.push({ column, operator, value });
    this.trx.queryOps.push(`${this.table}.where:${String(column)}:${operator ?? ""}:${String(value ?? "")}`);
    return this;
  }
  whereRef() { return this; }
  orderBy(column?: unknown, direction?: unknown) {
    this.trx.queryOps.push(`${this.table}.orderBy:${String(column)}:${String(direction)}`);
    return this;
  }
  forUpdate() { this.trx.queryOps.push(`${this.table}.forUpdate`); return this; }
  distinct() { return this; }
  innerJoin() { return this; }
  leftJoin() { return this; }
  $if(condition: boolean, callback: (query: this) => this) { return condition ? callback(this) : this; }
  execute() { this.mode = "all"; return Promise.resolve(this.result()); }
  executeTakeFirst() { this.mode = "first"; return Promise.resolve(this.result()); }
  executeTakeFirstOrThrow() {
    this.mode = "first";
    const result = this.result();
    if (result === undefined) throw new Error(`missing fake row for ${this.table}`);
    return Promise.resolve(result);
  }

  private result(): QueryResult {
    return this.trx.result(this.table, this.selected, this.filters, this.mode);
  }
}

class MutationInsert {
  private row: unknown;
  constructor(private readonly trx: MutationTransaction, private readonly table: string) {}
  values(row: unknown) { this.row = row; return this; }
  returning(column: unknown) { this.trx.queryOps.push(`${this.table}.returning:${String(column)}`); return this; }
  returningAll() { return this; }
  onConflict(callback: (oc: { doNothing: () => void }) => void) {
    callback({ doNothing: () => this.trx.conflicts.push(`${this.table}:doNothing`) });
    return this;
  }
  execute() {
    this.trx.inserts.push({ table: this.table, row: this.row });
    return Promise.resolve({ numInsertedOrUpdatedRows: 1n });
  }
  executeTakeFirst() {
    this.trx.inserts.push({ table: this.table, row: this.row });
    return Promise.resolve(this.table === "employee_model_rule_version" ? { id: "new-version" } : undefined);
  }
  executeTakeFirstOrThrow() {
    this.trx.inserts.push({ table: this.table, row: this.row });
    return Promise.resolve({ id: "new-version" });
  }
}

class MutationUpdate {
  constructor(private readonly trx: MutationTransaction, private readonly table: string) {}
  set() { return this; }
  where() { return this; }
  returningAll() { return this; }
  execute() { this.trx.updates.push(this.table); return Promise.resolve({ numUpdatedRows: 1n }); }
  executeTakeFirst() { this.trx.updates.push(this.table); return Promise.resolve(undefined); }
}

class MutationTransaction {
  readonly calls: string[] = [];
  readonly queryOps: string[] = [];
  readonly conflicts: string[] = [];
  readonly inserts: Array<{ table: string; row: unknown }> = [];
  readonly updates: string[] = [];
  constructor(private readonly fixture: Record<string, QueryResult> = {}) {}
  selectFrom(table: string) { return new MutationQuery(this, table); }
  insertInto(table: string) { return new MutationInsert(this, table); }
  updateTable(table: string) { return new MutationUpdate(this, table); }
  result(table: string, selected: unknown, filters: Array<{ column: unknown; operator?: string; value?: unknown }>, mode: "first" | "all") {
    const key = `${table}:${typeof selected === "function" ? "callback" : String(selected)}`;
    const value = this.fixture[key] ?? this.fixture[table];
    if (typeof value === "function") return value(filters, mode);
    if (mode === "all") return value ?? [];
    return Array.isArray(value) ? value[0] : value;
  }
}

describe("POOL-039 repository incremental mutation contract", () => {
  it("resolves provider quota first and falls back to version quota", () => {
    const until = "2030-01-01T00:00:00.000Z";
    expect(resolvePoolQuota({
      pool_quotas: [{ provider_code: "zeta", quota_value: "42", allow_overage: true, valid_until: until }],
      quota_value: 7n, allow_overage: false, valid_until: null,
    }, "zeta")).toEqual({ quota_value: 42n, allow_overage: true, valid_until: new Date(until) });
    expect(resolvePoolQuota({
      pool_quotas: null, quota_value: 7n, allow_overage: false, valid_until: null,
    }, "alpha")).toEqual({ quota_value: 7n, allow_overage: false, valid_until: null });
    expect(resolvePoolQuota({
      pool_quotas: [
        { provider_code: "zeta", quota_value: "42", allow_overage: true, valid_until: until },
        { provider_code: "alpha", quota_value: "99", allow_overage: false, valid_until: null },
      ], quota_value: 7n, allow_overage: false, valid_until: null,
    }, "alpha")).toEqual({ quota_value: 99n, allow_overage: false, valid_until: null });
  });

  it("captures every unmanaged Key model missing from the current baseline", async () => {
    const trx = new MutationTransaction({
      "principal_model_manual_authorization:unified_model_id": [],
      "principal_key:allowed_model_ids": { allowed_model_ids: ["manual", "managed"] },
      "employee_model_rule_assignment:unified_model_id": [{ unified_model_id: "managed" }],
    });
    await captureManualBaseline(trx as never, "enterprise", "principal-a");
    expect(trx.inserts).toEqual([{
      table: "principal_model_manual_authorization",
      row: [{ enterprise_id: "enterprise", principal_id: "principal-a", unified_model_id: "manual" }],
    }]);
    expect(trx.queryOps).toContain("principal_model_manual_authorization.where:enterprise_id:=:enterprise");
    expect(trx.queryOps).toContain("principal_model_manual_authorization.where:principal_id:=:principal-a");
    expect(trx.queryOps).toContain("principal_key.where:status:=:ACTIVE");
    expect(trx.queryOps).toContain("employee_model_rule_assignment.where:status:=:ACTIVE");
    expect(trx.queryOps).toContain("principal_key.where:enterprise_id:=:enterprise");
    expect(trx.queryOps).toContain("principal_key.where:principal_id:=:principal-a");
    expect(trx.queryOps).toContain("employee_model_rule_assignment.where:enterprise_id:=:enterprise");
    expect(trx.queryOps).toContain("employee_model_rule_assignment.where:principal_id:=:principal-a");
    expect(trx.conflicts).toEqual(["principal_model_manual_authorization:doNothing"]);
  });

  it("merges models added after the first baseline capture", async () => {
    const trx = new MutationTransaction({
      "principal_model_manual_authorization:unified_model_id": [{ unified_model_id: "manual" }],
      "principal_key:allowed_model_ids": { allowed_model_ids: ["manual", "later"] },
      "employee_model_rule_assignment:unified_model_id": [],
    });
    await captureManualBaseline(trx as never, "enterprise", "principal-a");
    expect(trx.inserts).toEqual([{
      table: "principal_model_manual_authorization",
      row: [{ enterprise_id: "enterprise", principal_id: "principal-a", unified_model_id: "later" }],
    }]);
    expect(trx.queryOps.some((op) => op.startsWith("principal_key"))).toBe(true);
  });

  it("handles a null Key whitelist and does not insert an empty baseline", async () => {
    const trx = new MutationTransaction({
      "principal_model_manual_authorization:unified_model_id": [],
      "principal_key:allowed_model_ids": { allowed_model_ids: null },
      "employee_model_rule_assignment:unified_model_id": [],
    });
    await captureManualBaseline(trx as never, "enterprise", "principal-a");
    expect(trx.inserts).toHaveLength(0);
  });

  it("does not write when all Key models are already managed", async () => {
    const trx = new MutationTransaction({
      "principal_model_manual_authorization:unified_model_id": [],
      "principal_key:allowed_model_ids": { allowed_model_ids: ["managed"] },
      "employee_model_rule_assignment:unified_model_id": [{ unified_model_id: "managed" }],
    });
    await captureManualBaseline(trx as never, "enterprise", "principal-a");
    expect(trx.inserts).toHaveLength(0);
  });

  it("uses stable principal/provider order and preserves only existing lock rows", async () => {
    const trx = new MutationTransaction({
      principal_key: (filters: Array<{ column: unknown; value?: unknown }>) => {
        const principal = filters.find((f) => f.column === "principal_id")?.value as string;
        trx.calls.push(`key:${principal}`);
        return principal === "principal-b" ? undefined : { id: `key-${principal}` };
      },
      principal_grant: (filters: Array<{ column: unknown; value?: unknown }>) => {
        const principal = filters.find((f) => f.column === "principal_id")?.value as string;
        const provider = filters.find((f) => f.column === "provider")?.value as string;
        trx.calls.push(`pool:${principal}:${provider}`);
        return provider === "alpha" ? undefined : { id: `pool-${principal}-${provider}` };
      },
    });
    const keys = await lockActivePrincipalKeys(trx as never, "enterprise", ["principal-b", "principal-a"]);
    const pools = await lockActiveProviderPools(trx as never, "enterprise", ["principal-b", "principal-a"], ["zeta", "alpha"]);
    expect([...keys.keys()]).toEqual(["principal-a"]);
    expect([...pools.keys()]).toEqual(["principal-a:zeta", "principal-b:zeta"]);
    expect(trx.calls).toEqual([
      "key:principal-a", "key:principal-b",
      "pool:principal-a:alpha", "pool:principal-a:zeta",
      "pool:principal-b:alpha", "pool:principal-b:zeta",
    ]);
  });

  it("collects rule-family principals and provider codes in stable order", async () => {
    const trx = new MutationTransaction({
      principal: [{ id: "principal-b" }, { id: "principal-a" }],
      "employee_model_rule_version:id": [{ id: "published-version" }],
      "employee_model_rule_assignment:principal_id": [{ principal_id: "principal-c" }],
      "model_route:provider.code": [{ code: "zeta" }, { code: "alpha" }],
      "employee_model_rule_assignment:provider.code": [{ code: "alpha" }, { code: "beta" }],
    });
    const principals = await principalIdsForRuleFamily(trx as never, "enterprise", {
      rule_id: "rule-1", employee_scope: "ALL", principal_ids: [],
    });
    expect(principals).toEqual(["principal-a", "principal-b", "principal-c"]);
    const providers = await providerCodesForRuleFamily(trx as never, "enterprise", "rule-1", "ALL", []);
    expect(providers).toEqual(["alpha", "beta", "zeta"]);
    const selectedProviders = await providerCodesForRuleFamily(
      trx as never, "enterprise", "rule-1", "SELECTED",
      [{ unified_model_id: "model-1", provider_resource_id: "resource-1" }],
    );
    expect(selectedProviders).toEqual(["alpha", "beta", "zeta"]);
    expect(trx.queryOps.some((op) => op.includes("model_route.where:(eb)"))).toBe(true);
  });

  it("locks the referenced version and captures the baseline before returning", async () => {
    const trx = new MutationTransaction({
      "employee_model_rule_version:rule_id,employee_scope,principal_ids": {
        rule_id: "rule-1", employee_scope: "SELECTED", principal_ids: ["principal-a"],
      },
      principal_key: { id: "key-a" },
      "principal_model_manual_authorization:unified_model_id": [],
      "employee_model_rule_assignment:unified_model_id": [],
    });
    const locked: string[] = [];
    const result = await lockRuleFamily(trx as never, "enterprise", "version-1", async (_trx, _enterprise, principal) => {
      locked.push(principal);
    });
    expect(result.principals).toEqual(["principal-a"]);
    expect(locked).toEqual(["principal-a"]);
    const version = await lockVersion(trx as never, "enterprise", "version-1");
    expect(version).toBeUndefined();
    const reference = await readRuleReference(trx as never, "enterprise", "version-1");
    expect(reference).toEqual({
      rule_id: "rule-1", employee_scope: "SELECTED", principal_ids: ["principal-a"],
    });
    const missing = new MutationTransaction();
    await expect(lockRuleFamily(missing as never, "enterprise", "missing", async () => undefined))
      .resolves.toEqual({ reference: undefined, principals: [] });
  });

  it("reuses editable single rules and versions a published one", async () => {
    const draft = new MutationTransaction({
      "employee_model_rule_version:id,rule_id,version,status": { id: "draft", rule_id: "rule-1", version: 1, status: "DRAFT" },
    });
    const input = { enterpriseId: "enterprise", principalId: "principal-a", adminUserId: "admin" } as never;
    await expect(ensureSingleRule(draft as never, input)).resolves.toBe("draft");
    expect(draft.inserts).toHaveLength(0);

    const validated = new MutationTransaction({
      "employee_model_rule_version:id,rule_id,version,status": { id: "validated", rule_id: "rule-1", version: 2, status: "VALIDATED" },
    });
    await expect(ensureSingleRule(validated as never, input)).resolves.toBe("validated");
    expect(validated.inserts).toHaveLength(0);

    const published = new MutationTransaction({
      "employee_model_rule_version:id,rule_id,version,status": { id: "published", rule_id: "rule-1", version: 3, status: "PUBLISHED" },
    });
    await expect(ensureSingleRule(published as never, input)).resolves.toBe("new-version");
    expect(published.inserts[0]).toMatchObject({ table: "employee_model_rule_version" });
    expect(published.inserts[0]?.row).toMatchObject({
      enterprise_id: "enterprise", rule_id: "rule-1", version: 4,
      name: "接入配置-principal-a", employee_scope: "SELECTED",
      principal_ids: JSON.stringify(["principal-a"]), model_scope: "SELECTED",
      model_targets: JSON.stringify([]), quota_value: null, allow_overage: false,
      owner_principal_id: "principal-a", created_by_admin_user_id: "admin", status: "DRAFT",
    });
    expect(published.queryOps).toContain("employee_model_rule_version.returning:id");
    expect(published.queryOps).toContain("employee_model_rule_version.orderBy:version:desc");
    expect(published.queryOps).toContain("employee_model_rule_version.where:enterprise_id:=:enterprise");
    expect(published.queryOps).toContain("employee_model_rule_version.where:owner_principal_id:=:principal-a");

    const first = new MutationTransaction();
    await expect(ensureSingleRule(first as never, input)).resolves.toBe("new-version");
    expect(first.inserts[0]?.row).toMatchObject({ version: 1, owner_principal_id: "principal-a" });
  });

  it("hashes dates and request keys canonically, and computes the final whitelist", () => {
    expect(stableHash(null)).toBe("74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b");
    expect(stableHash(7)).toBe("7902699be42c8a8e46fbbb4501726517e86b22c56a189f7625a6da49081b2451");
    expect(stableHash({ b: 2, a: new Date("2030-01-01T00:00:00.000Z") }))
      .toBe(stableHash({ a: "2030-01-01T00:00:00.000Z", b: 2 }));
    expect(stableHash([1, 2, null])).toBe("a0fbc1c637076d2fa194b0c42d6c4f5e44e73449b877c0061ecb27a22e1ea983");
    expect(stableHash({ a: 1, b: 2 })).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    expect(stableProviderCodes(["zeta", "alpha"], ["beta", "alpha"]))
      .toEqual(["alpha", "beta", "zeta"]);
    const originalLocaleCompare = String.prototype.localeCompare;
    const locales: (string | undefined)[] = [];
    String.prototype.localeCompare = function (other: string, locale?: string | string[], options?: Intl.CollatorOptions) {
      locales.push(Array.isArray(locale) ? locale[0] : locale);
      return originalLocaleCompare.call(this, other, locale, options);
    };
    try {
      expect(stableProviderCodes(["Z", "a"], [])).toEqual(["a", "Z"]);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
    expect(locales).toContain("en");
    expect(computeAllowedModelIds({
      manualIds: ["manual"], managedAssignmentModelIds: ["managed"],
      poolModelIds: ["managed", "pool-open", "pool-disabled"], disabledModelIds: ["pool-disabled"],
    })).toEqual(["managed", "manual", "pool-open"]);
  });
});
