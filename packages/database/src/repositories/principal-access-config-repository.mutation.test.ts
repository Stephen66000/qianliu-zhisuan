import { describe, expect, it, vi } from "vitest";

const models = [
  {
    unified_model_id: "model-a", display_name: "Alpha A", alias: "alpha-a",
    provider_code: "alpha", provider_name: "Alpha", provider_resource_id: "resource-a",
    resource_name: "Alpha resource", mode: "API", model_status: "ACTIVE",
    route_enabled: true, ready: true, unavailable_reasons: [] as string[],
  },
  {
    unified_model_id: "model-b", display_name: "Beta B", alias: "beta-b",
    provider_code: "beta", provider_name: "Beta", provider_resource_id: "resource-b",
    resource_name: "Beta resource", mode: "API", model_status: "ACTIVE",
    route_enabled: true, ready: true, unavailable_reasons: [] as string[],
  },
  {
    unified_model_id: "model-c", display_name: "Alpha C", alias: "alpha-c",
    provider_code: "alpha", provider_name: "Alpha", provider_resource_id: "resource-c",
    resource_name: "Alpha resource", mode: "API", model_status: "ACTIVE",
    route_enabled: true, ready: true, unavailable_reasons: [] as string[],
  },
  {
    unified_model_id: "model-d", display_name: "Epsilon D", alias: "epsilon-d",
    provider_code: "epsilon", provider_name: "Epsilon", provider_resource_id: "resource-d",
    resource_name: "Epsilon resource", mode: "API", model_status: "ACTIVE",
    route_enabled: true, ready: true, unavailable_reasons: [] as string[],
  },
  {
    unified_model_id: "model-g", display_name: "Gamma G", alias: "gamma-g",
    provider_code: "gamma", provider_name: "Gamma", provider_resource_id: "resource-g",
    resource_name: "Gamma resource", mode: "API", model_status: "ACTIVE",
    route_enabled: true, ready: true, unavailable_reasons: [] as string[],
  },
  {
    unified_model_id: "model-delta", display_name: "Delta D", alias: "delta-d",
    provider_code: "delta", provider_name: "Delta", provider_resource_id: "resource-delta",
    resource_name: "Delta resource", mode: "API", model_status: "ACTIVE",
    route_enabled: true, ready: true, unavailable_reasons: [] as string[],
  },
];

vi.mock("./employee-model-rule-repository.js", () => ({
  EmployeeModelRuleRepository: class {
    async catalog() { return { models }; }
    async refreshKeyModels() { return undefined; }
  },
}));
vi.mock("./employee-model-rule-lock-context.js", () => ({
  captureManualBaseline: vi.fn(async () => undefined),
}));
vi.mock("./principal-single-rule.js", () => ({
  ensureSingleRule: vi.fn(async () => "version-1"),
}));
vi.mock("./principal-access-locks.js", () => ({
  lockActivePrincipalKeys: vi.fn(async () => new Map([["principal-a", { id: "key-a" }]])),
  lockActiveProviderPools: vi.fn(async () => new Map([
    ["principal-a:alpha", { id: "grant-alpha" }],
    ["principal-a:gamma", { id: "grant-gamma" }],
    ["principal-a:epsilon", { id: "grant-epsilon" }],
  ])),
}));

import { PrincipalAccessConfigRepository } from "./principal-access-config-repository.js";
import { lockActivePrincipalKeys, lockActiveProviderPools } from "./principal-access-locks.js";

function requireQueryToken(value: unknown): void {
  if (typeof value === "string" && value.length === 0) throw new Error("empty query token");
  if (Array.isArray(value) && value.length === 0) throw new Error("empty select list");
  if (Array.isArray(value)) value.forEach(requireQueryToken);
}

class ConfigQuery {
  private selected: unknown;
  constructor(private readonly trx: ConfigTransaction, private readonly table: string) {}
  select(columns: unknown) {
    requireQueryToken(columns);
    if (Array.isArray(columns)) {
      for (const column of columns) {
        if (typeof column === "object" && column !== null && "toOperationNode" in column) {
          const node = (column as { toOperationNode: () => unknown }).toOperationNode();
          const serialized = JSON.stringify(node);
          if (!serialized.includes("COALESCE(quota_counter.used_value, 0)")) {
            throw new Error("quota counter projection missing");
          }
          if (serialized.includes('"name":""')) throw new Error("projection alias missing");
        }
      }
    }
    this.selected = columns; this.trx.selects.push({ table: this.table, columns }); return this;
  }
  selectAll() { this.selected = "all"; return this; }
  leftJoin(table: unknown, left: unknown, right: unknown) {
    requireQueryToken(table); requireQueryToken(left); requireQueryToken(right); return this;
  }
  innerJoin(table: unknown, left: unknown, right: unknown) {
    requireQueryToken(table); requireQueryToken(left); requireQueryToken(right); return this;
  }
  where(column: unknown, operator?: unknown, value?: unknown) {
    requireQueryToken(column); requireQueryToken(operator); requireQueryToken(value);
    this.trx.wheres.push({ table: this.table, column, operator, value });
    return this;
  }
  forUpdate() { return this; }
  execute() {
    if (this.table === "principal_grant") return Promise.resolve(this.trx.currentPools);
    if (this.table === "employee_model_rule_version" && this.selected === "id") return Promise.resolve([{ id: "old-version" }]);
    if (this.table === "principal_provider_disabled_model") {
      return Promise.resolve([{ provider: "alpha", unified_model_id: "model-c" }]);
    }
    if (this.table === "principal_model_manual_authorization") {
      return Promise.resolve([{ unified_model_id: "manual-model" }]);
    }
    return Promise.resolve([]);
  }
  executeTakeFirst() {
    if (this.table === "principal") return Promise.resolve({
      id: "principal-a", name: "A", status: "ACTIVE", department_label: "R&D", archived_at: null,
    });
    if (this.table === "principal_key") return Promise.resolve({
      id: "key-a", key_prefix: "sk-ql", status: "ACTIVE",
      created_at: new Date("2026-08-09T00:00:00.000Z"), allowed_model_ids: ["model-a"],
    });
    if (this.table === "principal_access_idempotency") return Promise.resolve(undefined);
    if (this.table === "principal_access_config_state") {
      return Promise.resolve(this.trx.stateExists ? { config_version: this.trx.configVersion } : undefined);
    }
    return Promise.resolve(undefined);
  }
  executeTakeFirstOrThrow() {
    if (this.table === "principal_access_config_state") return Promise.resolve({ config_version: 1 });
    if (this.table === "employee_model_rule_version") return Promise.resolve({ id: "version-1", rule_id: "rule-1" });
    return Promise.resolve({ id: "row" });
  }
}

class ConfigInsert {
  constructor(private readonly trx: ConfigTransaction, private readonly table: string) {}
  values(row: unknown) { this.trx.inserts.push({ table: this.table, row }); return this; }
  onConflict(callback: (oc: { doNothing: () => void }) => void) {
    callback({ doNothing: () => this.trx.conflicts.push(this.table) });
    return this;
  }
  returning() { return this; }
  execute() { return Promise.resolve({}); }
  executeTakeFirstOrThrow() { return Promise.resolve({ id: "grant-beta" }); }
}

class ConfigUpdate {
  constructor(private readonly trx: ConfigTransaction, private readonly table: string) {}
  set(row: unknown) { this.trx.updates.push({ table: this.table, row }); return this; }
  where() { return this; }
  execute() { return Promise.resolve({ numUpdatedRows: 1n }); }
}

class ConfigDelete {
  constructor(private readonly trx: ConfigTransaction, private readonly table: string) {}
  where(column: unknown, operator?: unknown, value?: unknown) {
    this.trx.deleteWheres.push({ table: this.table, column, operator, value });
    return this;
  }
  execute() { this.trx.deletes.push(this.table); return Promise.resolve({ numDeletedRows: 1n }); }
  executeTakeFirst() { this.trx.deletes.push(this.table); return Promise.resolve({ numDeletedRows: 1n }); }
}

class ConfigTransaction {
  configVersion = 1;
  stateExists = true;
  readonly currentPools = [
    { id: "grant-alpha", provider: "alpha", quota_value: 10n, used_value: 10n, allow_overage: false, valid_until: null, authorization_rule_version_id: null },
    { id: "grant-gamma", provider: "gamma", quota_value: 3n, used_value: 0n, allow_overage: false, valid_until: null, authorization_rule_version_id: "old-version" },
    { id: "grant-delta", provider: "delta", quota_value: 2n, used_value: 0n, allow_overage: false, valid_until: null, authorization_rule_version_id: "batch-version" },
    { id: "grant-epsilon", provider: "epsilon", quota_value: 1n, used_value: 0n, allow_overage: false, valid_until: null, authorization_rule_version_id: null },
  ];
  readonly inserts: Array<{ table: string; row: unknown }> = [];
  readonly updates: Array<{ table: string; row: unknown }> = [];
  readonly selects: Array<{ table: string; columns: unknown }> = [];
  readonly wheres: Array<{ table: string; column: unknown; operator?: unknown; value?: unknown }> = [];
  readonly deleteWheres: Array<{ table: string; column: unknown; operator?: unknown; value?: unknown }> = [];
  readonly deletes: string[] = [];
  readonly conflicts: string[] = [];
  selectFrom(table: string) { requireQueryToken(table); return new ConfigQuery(this, table); }
  insertInto(table: string) { requireQueryToken(table); return new ConfigInsert(this, table); }
  updateTable(table: string) { requireQueryToken(table); return new ConfigUpdate(this, table); }
  deleteFrom(table: string) { requireQueryToken(table); return new ConfigDelete(this, table); }
}

const input = {
  enterpriseId: "enterprise", principalId: "principal-a", adminUserId: "admin", expectedVersion: 1,
  idempotencyKey: "request-1",
  pools: [
    { provider_code: "alpha", quota_value: 11n, allow_overage: true, valid_until: null, enabled_model_ids: ["model-a"] },
    { provider_code: "beta", quota_value: 12n, allow_overage: false, valid_until: null, enabled_model_ids: ["model-b"] },
    { provider_code: "epsilon", quota_value: 0n, allow_overage: false, valid_until: null, enabled_model_ids: [] },
  ],
};

describe("POOL-039 principal access PUT mutation contract", () => {
  it("assembles the persisted access configuration with manual, single and batch pool sources", async () => {
    const db = new ConfigTransaction();
    db.configVersion = 7;
    const result = await new PrincipalAccessConfigRepository(db as never).read("enterprise", "principal-a");
    expect(result).toMatchObject({
      principal: { id: "principal-a", department_label: "R&D" },
      key: { key_prefix: "sk-ql", authorization_status: "AUTHORIZED" },
      summary: { total_quota: "16", provider_count: 4, model_count: 4 },
      manual_pending_takeover: ["manual-model"],
      config_version: 7,
    });
    expect(result.providers.find((provider) => provider.provider_code === "alpha")).toMatchObject({
      pool: { source: "MANUAL_PENDING", quota_value: "10", quota_used: "10", over_limit: false },
      models: [expect.objectContaining({ unified_model_id: "model-a", enabled: true }),
        expect.objectContaining({ unified_model_id: "model-c", enabled: false })],
    });
    expect(result.providers.find((provider) => provider.provider_code === "gamma")?.pool?.source)
      .toBe("MANAGED_SINGLE");
    expect(result.providers.find((provider) => provider.provider_code === "delta")?.pool?.source)
      .toBe("MANAGED_BATCH");
  });

  it("defaults a missing persisted config state to version one", async () => {
    const db = new ConfigTransaction();
    db.stateExists = false;
    await expect(new PrincipalAccessConfigRepository(db as never).read("enterprise", "principal-a"))
      .resolves.toMatchObject({ config_version: 1 });
  });

  it("locks the key, captures baseline, updates and creates pools in stable order, then publishes the single rule", async () => {
    const trx = new ConfigTransaction();
    const db = { transaction: () => ({ execute: (callback: (value: ConfigTransaction) => unknown) => callback(trx) }) };
    const repo = new PrincipalAccessConfigRepository(db as never);
    const result = await repo.put(input as never);
    expect(result).toMatchObject({ config_version: 2, changes: {
      pools_added: ["beta"], pools_updated: ["alpha"], pools_closed: ["epsilon", "gamma"],
    } });
    expect(trx.updates.some((row) => row.table === "principal_grant")).toBe(true);
    expect(trx.inserts.some((row) => row.table === "principal_grant")).toBe(true);
    expect(trx.inserts).toContainEqual({ table: "quota_counter", row: { grant_id: "grant-beta" } });
    expect(trx.inserts.some((row) => row.table === "principal_access_idempotency")).toBe(true);
    expect(trx.deletes).toContain("principal_provider_disabled_model");
    expect(trx.selects).toContainEqual({
      table: "principal_grant", columns: ["id", "provider", "quota_value", "authorization_rule_version_id"],
    });
    expect(trx.wheres).toContainEqual({ table: "principal_grant", column: "enterprise_id", operator: "=", value: "enterprise" });
    expect(trx.wheres).toContainEqual({ table: "principal_grant", column: "principal_id", operator: "=", value: "principal-a" });
    expect(trx.wheres).toContainEqual({ table: "principal_grant", column: "pool_model_alias", operator: "=", value: "*" });
    expect(trx.wheres).toContainEqual({ table: "principal_grant", column: "status", operator: "=", value: "ACTIVE" });
    expect(trx.updates).toContainEqual({ table: "principal_grant", row: expect.objectContaining({
      quota_value: 11n, allow_overage: true, valid_until: null, authorization_rule_version_id: "version-1",
    }) });
    expect(trx.updates).toContainEqual({ table: "principal_grant", row: expect.objectContaining({ status: "DISABLED" }) });
    expect(trx.inserts).toContainEqual({ table: "principal_grant", row: expect.objectContaining({
      enterprise_id: "enterprise", principal_id: "principal-a", provider: "beta",
      model_alias: "*", pool_model_alias: "*", quota_unit: "TOKEN", quota_value: 12n,
      allow_overage: false, status: "ACTIVE", authorization_rule_version_id: "version-1",
    }) });
    expect(lockActivePrincipalKeys).toHaveBeenCalledWith(trx, "enterprise", ["principal-a"]);
    expect(lockActiveProviderPools).toHaveBeenCalledWith(
      trx, "enterprise", ["principal-a"], ["alpha", "beta", "delta", "epsilon", "gamma"],
    );
    expect(trx.deleteWheres).toContainEqual({
      table: "principal_provider_disabled_model", column: "unified_model_id", operator: "in", value: ["model-a"],
    });
  });

  it("preserves a previously configured model when its resource becomes unavailable", async () => {
    const target = models.find((model) => model.unified_model_id === "model-a")!;
    const original = { ready: target.ready, unavailable_reasons: target.unavailable_reasons };
    target.ready = false;
    target.unavailable_reasons = ["厂商资源不可服务"];
    try {
      const trx = new ConfigTransaction();
      const db = { transaction: () => ({ execute: (callback: (value: ConfigTransaction) => unknown) => callback(trx) }) };
      await expect(new PrincipalAccessConfigRepository(db as never).put(input as never))
        .resolves.toMatchObject({ config_version: 2 });
    } finally {
      target.ready = original.ready;
      target.unavailable_reasons = original.unavailable_reasons;
    }
  });

  it("still rejects a newly selected unavailable model with a specific message", async () => {
    const target = models.find((model) => model.unified_model_id === "model-b")!;
    const original = { ready: target.ready, unavailable_reasons: target.unavailable_reasons };
    target.ready = false;
    target.unavailable_reasons = ["厂商资源不可服务"];
    try {
      const trx = new ConfigTransaction();
      const db = { transaction: () => ({ execute: (callback: (value: ConfigTransaction) => unknown) => callback(trx) }) };
      await expect(new PrincipalAccessConfigRepository(db as never).put(input as never))
        .rejects.toMatchObject({
          code: "NOT_READY",
          message: "型号 Beta B 未就绪：厂商资源不可服务",
        });
      // 版本行在同一事务中先锁定；真实数据库会随异常回滚。不得进入授权业务写入。
      expect(trx.inserts.filter((row) => row.table !== "principal_access_config_state")).toEqual([]);
      expect(trx.updates.every((row) => row.table === "principal_access_config_state")).toBe(true);
    } finally {
      target.ready = original.ready;
      target.unavailable_reasons = original.unavailable_reasons;
    }
  });

  it("rejects a PUT when the enterprise-scoped principal has no ACTIVE Key", async () => {
    vi.mocked(lockActivePrincipalKeys).mockResolvedValueOnce(new Map());
    const trx = new ConfigTransaction();
    const db = { transaction: () => ({ execute: (callback: (value: ConfigTransaction) => unknown) => callback(trx) }) };
    const repo = new PrincipalAccessConfigRepository(db as never);
    await expect(repo.put(input as never)).rejects.toMatchObject({ code: "INVALID_STATE", message: "主体尚无有效 Key" });
  });
});
