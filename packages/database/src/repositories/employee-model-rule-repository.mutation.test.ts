import { describe, expect, it, vi } from "vitest";

vi.mock("./employee-model-rule-lock-context.js", () => ({
  captureManualBaseline: vi.fn(),
  lockRuleFamily: vi.fn(async () => ({
    reference: { rule_id: "rule-1", employee_scope: "SELECTED", principal_ids: ["principal-a"] },
    principals: ["principal-a"],
  })),
  lockVersion: vi.fn(async () => ({
    id: "version-1", rule_id: "rule-1", status: "PUBLISHED", lock_version: 2,
    model_scope: "SELECTED", model_targets: [], pool_quotas: [], quota_value: 1n,
    publish_idempotency_key: "key-1", publish_request_hash: null,
    validation_snapshot: { ready: true },
  })),
  providerCodesForRuleFamily: vi.fn(async () => ["alpha"]),
}));
vi.mock("./principal-access-locks.js", () => ({
  lockActiveProviderPools: vi.fn(async () => new Map()),
}));
vi.mock("./employee-model-rule-validation.js", () => ({
  validateEmployeeModelRule: vi.fn(async () => ({
    ready: true, principal_ids: ["principal-a"], principal_count: 1,
    model_targets: [], model_count: 0, assignment_count: 0, issues: [],
  })),
}));
vi.mock("./employee-model-rule-lifecycle.js", () => ({
  disableEmployeeRuleVersion: vi.fn(async () => []),
  refreshEmployeeKeyModels: vi.fn(async () => undefined),
}));

import { EmployeeModelRuleRepository, publishRequestHash } from "./employee-model-rule-repository.js";
import type { EmployeeModelRuleError } from "./employee-model-rule-repository.js";
import { lockActiveProviderPools } from "./principal-access-locks.js";
import { lockRuleFamily, lockVersion } from "./employee-model-rule-lock-context.js";
import { validateEmployeeModelRule } from "./employee-model-rule-validation.js";

function requireQueryToken(value: unknown): void {
  if (typeof value === "string" && value.length === 0) throw new Error("empty query token");
}

class PublishQuery {
  private selected: unknown;
  private filters: Array<[unknown, unknown, unknown]> = [];
  constructor(private readonly trx: PublishTransaction, private readonly table: string) {}
  select(columns: unknown) { requireQueryToken(columns); this.selected = columns; return this; }
  selectAll() { return this; }
  innerJoin() { return this; }
  where(column: unknown, operator?: unknown, value?: unknown) {
    requireQueryToken(column); requireQueryToken(operator); requireQueryToken(value);
    this.filters.push([column, operator, value]);
    this.trx.queryOps.push(`${this.table}.where:${String(column)}:${String(operator)}:${String(value)}`);
    return this;
  }
  forUpdate() { return this; }
  executeTakeFirst() {
    if (this.table === "employee_model_rule_version" && this.selected === "rule_id"
      && this.filters.some(([column, operator, value]) => column === "enterprise_id" && operator === "=" && value === "enterprise")
      && this.filters.some(([column, operator, value]) => column === "id" && operator === "=" && value === "version-1")) {
      return Promise.resolve(this.trx.missingReference ? undefined : { rule_id: "rule-1" });
    }
    if (this.table === "principal_grant") return Promise.resolve(this.trx.poolGrant);
    return Promise.resolve(undefined);
  }
  executeTakeFirstOrThrow() {
    if (this.table === "model_route") return Promise.resolve({ alias: "alpha-alias", code: "alpha" });
    return Promise.resolve({ count: "2" });
  }
  execute() { return Promise.resolve([]); }
}

class PublishUpdate {
  constructor(private readonly trx: PublishTransaction, private readonly table: string) {}
  set(row: unknown) { this.trx.updateRows.push({ table: this.table, row }); return this; }
  where(column: unknown, operator?: unknown, value?: unknown) {
    this.trx.updateWheres.push({ table: this.table, column, operator, value });
    return this;
  }
  returningAll() { return this; }
  execute() { this.trx.updates.push(this.table); return Promise.resolve({ numUpdatedRows: 1n }); }
  executeTakeFirstOrThrow() {
    this.trx.updates.push(this.table);
    return Promise.resolve({ ...this.trx.version, status: "PUBLISHED" });
  }
}

class PublishInsert {
  constructor(private readonly trx: PublishTransaction, private readonly table: string) {}
  values() { return this; }
  onConflict() { return this; }
  returning() { return this; }
  execute() { this.trx.inserts.push(this.table); return Promise.resolve({}); }
  executeTakeFirst() { return Promise.resolve(undefined); }
  executeTakeFirstOrThrow() { return Promise.resolve({ id: "inserted" }); }
}

class PublishTransaction {
  readonly updates: string[] = [];
  readonly inserts: string[] = [];
  readonly queryOps: string[] = [];
  readonly compiledQueries: unknown[] = [];
  readonly updateRows: Array<{ table: string; row: unknown }> = [];
  readonly updateWheres: Array<{ table: string; column: unknown; operator?: unknown; value?: unknown }> = [];
  constructor(readonly missingReference = false, readonly poolGrant?: unknown, readonly versionOverride?: Record<string, unknown>) {}
  get version() {
    return {
    model_scope: "SELECTED", model_targets: [], pool_quotas: [], quota_value: 1n,
    publish_idempotency_key: "key-1", publish_request_hash: publishRequestHash("SET"),
    validation_snapshot: { ready: true }, id: "version-1", rule_id: "rule-1", status: "PUBLISHED", lock_version: 2,
    ...this.versionOverride,
  };
  }
  selectFrom(table: string) { requireQueryToken(table); return new PublishQuery(this, table); }
  updateTable(table: string) { requireQueryToken(table); return new PublishUpdate(this, table); }
  insertInto(table: string) { requireQueryToken(table); return new PublishInsert(this, table); }
  getExecutor() {
    return {
      withPlugins() { return this; },
      transformQuery(node: unknown) { return node; },
      compileQuery: (node: unknown) => { this.compiledQueries.push(node); return node; },
      executeQuery: async (query: unknown) => {
        if (!JSON.stringify(query).includes("pg_advisory_xact_lock")) {
          throw new Error("advisory lock SQL missing");
        }
        return { rows: [] };
      },
    };
  }
}

describe("POOL-039 employee rule publication mutation contract", () => {
  it("publishes a distinct request hash for SET, ADD, and default mode", () => {
    expect(publishRequestHash(undefined)).toBe(publishRequestHash("SET"));
    expect(publishRequestHash("SET")).not.toBe(publishRequestHash("ADD"));
  });

  it("replays legacy/default SET and rejects the same key with ADD", async () => {
    const trx = new PublishTransaction();
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
    const repo = new EmployeeModelRuleRepository(db as never);
    const input = {
      enterpriseId: "enterprise", versionId: "version-1", expectedLockVersion: 1,
      idempotencyKey: "key-1", adminUserId: "admin",
    };
    await expect(repo.publish(input)).resolves.toMatchObject({ assignment_count: 2 });
    await expect(repo.publish({ ...input, quotaMode: "ADD" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    } satisfies Partial<EmployeeModelRuleError>);
    await expect(new EmployeeModelRuleRepository(db as never).disable("enterprise", "version-1", "admin"))
      .resolves.toBeDefined();
    vi.mocked(lockVersion).mockResolvedValueOnce({
      ...trx.version, publish_request_hash: "different-request",
    } as never);
    await expect(repo.publish(input)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT", message: "该发布幂等键对应的额度模式不同",
    } satisfies Partial<EmployeeModelRuleError>);
    vi.mocked(lockRuleFamily).mockResolvedValueOnce({ reference: undefined, principals: [] });
    await expect(repo.publish(input)).rejects.toMatchObject({
      code: "NOT_FOUND", message: "员工使用规则版本不存在",
    } satisfies Partial<EmployeeModelRuleError>);
    vi.mocked(lockRuleFamily).mockResolvedValueOnce({ reference: undefined, principals: [] });
    await expect(repo.disable("enterprise", "version-1", "admin")).rejects.toMatchObject({
      code: "NOT_FOUND", message: "员工使用规则版本不存在",
    } satisfies Partial<EmployeeModelRuleError>);
    await expect((repo as unknown as { lockRuleVersion: (trx: unknown, enterprise: string, version: string) => Promise<unknown> })
      .lockRuleVersion(new PublishTransaction(true), "enterprise", "version-1"))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "员工使用规则版本不存在" });
    vi.mocked(lockVersion).mockResolvedValueOnce(undefined as never);
    await expect((repo as unknown as { lockRuleVersion: (trx: unknown, enterprise: string, version: string) => Promise<unknown> })
      .lockRuleVersion(new PublishTransaction(), "enterprise", "version-1"))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: "员工使用规则版本不存在" });
    expect(lockRuleFamily).toHaveBeenCalled();
    expect(lockVersion).toHaveBeenCalled();
    expect(lockActiveProviderPools).toHaveBeenCalled();
    expect(trx.queryOps).toContain("employee_model_rule_version.where:enterprise_id:=:enterprise");
    expect(trx.queryOps).toContain("employee_model_rule_version.where:id:=:version-1");
    expect(trx.compiledQueries.some((query) => JSON.stringify(query).includes("pg_advisory_xact_lock"))).toBe(true);
    expect(trx.compiledQueries.some((query) => JSON.stringify(query).includes("enterprise:rule-1"))).toBe(true);
  });

  it("allows a historical null request hash to replay only as default SET", async () => {
    const trx = new PublishTransaction(false, undefined, { publish_request_hash: null });
    vi.mocked(lockVersion).mockResolvedValueOnce(trx.version as never);
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
    await expect(new EmployeeModelRuleRepository(db as never).publish({
      enterpriseId: "enterprise", versionId: "version-1", expectedLockVersion: 2,
      idempotencyKey: "key-1", adminUserId: "admin",
    })).resolves.toMatchObject({ assignment_count: 2 });
  });

  it("replays a published ADD request when its request hash matches", async () => {
    const trx = new PublishTransaction(false, undefined, { publish_request_hash: publishRequestHash("ADD") });
    vi.mocked(lockVersion).mockResolvedValueOnce(trx.version as never);
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
    await expect(new EmployeeModelRuleRepository(db as never).publish({
      enterpriseId: "enterprise", versionId: "version-1", expectedLockVersion: 2,
      idempotencyKey: "key-1", adminUserId: "admin", quotaMode: "ADD",
    })).resolves.toMatchObject({ assignment_count: 2 });
  });

  it("keeps disable idempotent for DISABLED and rejects a DRAFT version", async () => {
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(new PublishTransaction()) }) };
    const repo = new EmployeeModelRuleRepository(db as never);
    vi.mocked(lockVersion).mockResolvedValueOnce({ ...new PublishTransaction().version, status: "DISABLED" } as never);
    await expect(repo.disable("enterprise", "version-1", "admin"))
      .resolves.toMatchObject({ status: "DISABLED" });
    vi.mocked(lockVersion).mockResolvedValueOnce({ ...new PublishTransaction().version, status: "DRAFT" } as never);
    await expect(repo.disable("enterprise", "version-1", "admin")).rejects.toMatchObject({
      code: "INVALID_STATE", message: "只有已发布规则可以停用",
    } satisfies Partial<EmployeeModelRuleError>);
  });

  it("publishes a validated version through the locked provider pool and persists versioned grant state", async () => {
    const trx = new PublishTransaction(false, { id: "grant-alpha" }, {
      status: "VALIDATED", lock_version: 2, publish_idempotency_key: null,
      publish_request_hash: null,
      model_targets: [{ unified_model_id: "model-a", provider_resource_id: "resource-a" }],
      pool_quotas: [{ provider_code: "alpha", quota_value: "7", allow_overage: true, valid_until: null }],
    });
    vi.mocked(lockVersion).mockResolvedValueOnce(trx.version as never);
    vi.mocked(validateEmployeeModelRule).mockResolvedValueOnce({
      ready: true, principal_ids: ["principal-a"], principal_count: 1,
      model_targets: [{ unified_model_id: "model-a", provider_resource_id: "resource-a" }],
      model_count: 1, assignment_count: 1, issues: [],
    } as never);
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
    const repo = new EmployeeModelRuleRepository(db as never);
    repo.refreshKeyModels = vi.fn(async () => undefined);
    await expect(repo.publish({
      enterpriseId: "enterprise", versionId: "version-1", expectedLockVersion: 2,
      idempotencyKey: "new-key", adminUserId: "admin", quotaMode: "ADD",
    })).resolves.toMatchObject({ assignment_count: 1 });
    expect(trx.updateRows.some((row) => row.table === "principal_grant")).toBe(true);
    const grantUpdate = trx.updateRows.find((row) => row.table === "principal_grant");
    expect(grantUpdate?.row).toEqual(expect.objectContaining({ authorization_rule_version_id: "version-1" }));
    const grantSql = grantUpdate?.row as { quota_value: { toOperationNode: () => { sqlFragments: string[] } }; version: { toOperationNode: () => { sqlFragments: string[] } } };
    expect(grantSql.quota_value.toOperationNode().sqlFragments).toEqual(["quota_value + ", ""]);
    expect(grantSql.version.toOperationNode().sqlFragments).toEqual(["version + 1"]);
    expect(trx.updateWheres).toContainEqual({ table: "principal_grant", column: "id", operator: "=", value: "grant-alpha" });
    expect(trx.updates).toContain("employee_model_rule_version");
    const publishedUpdate = trx.updateRows.find((row) => row.table === "employee_model_rule_version");
    expect(publishedUpdate?.row).toEqual(expect.objectContaining({
      status: "PUBLISHED", publish_idempotency_key: "new-key", publish_request_hash: publishRequestHash("ADD"),
    }));
    expect(publishedUpdate?.row).toEqual(expect.objectContaining({ lock_version: expect.anything() }));
    expect(trx.updateWheres).toContainEqual({ table: "employee_model_rule_version", column: "id", operator: "=", value: "version-1" });
    expect(trx.inserts).toContain("employee_model_rule_assignment");
  });

  it("uses SET grant fields when the validated publish is not an ADD", async () => {
    const trx = new PublishTransaction(false, { id: "grant-alpha" }, {
      status: "VALIDATED", lock_version: 2, publish_idempotency_key: null,
      publish_request_hash: null, pool_quotas: [], quota_value: 7n, allow_overage: false, valid_until: null,
    });
    vi.mocked(lockVersion).mockResolvedValueOnce(trx.version as never);
    vi.mocked(validateEmployeeModelRule).mockResolvedValueOnce({
      ready: true, principal_ids: ["principal-a"], principal_count: 1,
      model_targets: [{ unified_model_id: "model-a", provider_resource_id: "resource-a" }],
      model_count: 1, assignment_count: 1, issues: [],
    } as never);
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
    const repo = new EmployeeModelRuleRepository(db as never);
    repo.refreshKeyModels = vi.fn(async () => undefined);
    await expect(repo.publish({
      enterpriseId: "enterprise", versionId: "version-1", expectedLockVersion: 2,
      idempotencyKey: "set-key", adminUserId: "admin",
    })).resolves.toMatchObject({ assignment_count: 1 });
    const grantUpdate = trx.updateRows.find((row) => row.table === "principal_grant");
    expect(grantUpdate?.row).toEqual(expect.objectContaining({
      quota_value: 7n, allow_overage: false, valid_until: null, authorization_rule_version_id: "version-1",
    }));
    expect(grantUpdate?.row).toEqual(expect.objectContaining({ version: expect.anything() }));
    expect((grantUpdate?.row as { version: { toOperationNode: () => { sqlFragments: string[] } } }).version.toOperationNode().sqlFragments)
      .toEqual(["version + 1"]);
    expect(trx.updateWheres).toContainEqual({ table: "principal_grant", column: "id", operator: "=", value: "grant-alpha" });
  });

  it("rejects ADD when neither provider quota nor version quota exists", async () => {
    const trx = new PublishTransaction(false, { id: "grant-alpha" }, {
      status: "VALIDATED", lock_version: 2, publish_idempotency_key: null,
      publish_request_hash: null, pool_quotas: [], quota_value: null,
    });
    vi.mocked(lockVersion).mockResolvedValueOnce(trx.version as never);
    vi.mocked(validateEmployeeModelRule).mockResolvedValueOnce({
      ready: true, principal_ids: ["principal-a"], principal_count: 1,
      model_targets: [{ unified_model_id: "model-a", provider_resource_id: "resource-a" }],
      model_count: 1, assignment_count: 1, issues: [],
    } as never);
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
    const repo = new EmployeeModelRuleRepository(db as never);
    await expect(repo.publish({
      enterpriseId: "enterprise", versionId: "version-1", expectedLockVersion: 2,
      idempotencyKey: "new-key", adminUserId: "admin", quotaMode: "ADD",
    })).rejects.toMatchObject({ code: "INVALID_STATE", message: "厂商 alpha 缺少可追加的额度" });
  });

  it("allows ADD when only the version quota is available or only the provider quota is available", async () => {
    for (const versionOverride of [
      { pool_quotas: [], quota_value: 5n },
      { pool_quotas: [{ provider_code: "alpha", quota_value: "5", allow_overage: false, valid_until: null }], quota_value: null },
    ]) {
      const trx = new PublishTransaction(false, { id: "grant-alpha" }, {
        status: "VALIDATED", lock_version: 2, publish_idempotency_key: null,
        publish_request_hash: null, ...versionOverride,
      });
      vi.mocked(lockVersion).mockResolvedValueOnce(trx.version as never);
      vi.mocked(validateEmployeeModelRule).mockResolvedValueOnce({
        ready: true, principal_ids: ["principal-a"], principal_count: 1,
        model_targets: [{ unified_model_id: "model-a", provider_resource_id: "resource-a" }],
        model_count: 1, assignment_count: 1, issues: [],
      } as never);
      const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
      const repo = new EmployeeModelRuleRepository(db as never);
      repo.refreshKeyModels = vi.fn(async () => undefined);
      await expect(repo.publish({
        enterpriseId: "enterprise", versionId: "version-1", expectedLockVersion: 2,
        idempotencyKey: "fallback-key", adminUserId: "admin", quotaMode: "ADD",
      })).resolves.toMatchObject({ assignment_count: 1 });
    }
  });

  it("returns NOT_FOUND when validation cannot lock its version", async () => {
    vi.mocked(lockVersion).mockResolvedValueOnce(undefined as never);
    const trx = new PublishTransaction();
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
    const repo = new EmployeeModelRuleRepository(db as never);
    await expect(repo.validate("enterprise", "version-1")).rejects.toMatchObject({
      code: "NOT_FOUND", message: "员工使用规则版本不存在",
    });

  });

  it("validates a locked draft version and writes the validation snapshot", async () => {
    vi.mocked(lockVersion).mockImplementationOnce(async () => ({
      id: "version-1", status: "DRAFT", lock_version: 1,
    }) as never);
    const trx = new PublishTransaction();
    const db = { transaction: () => ({ execute: (callback: (value: PublishTransaction) => unknown) => callback(trx) }) };
    const repo = new EmployeeModelRuleRepository(db as never);
    await expect(repo.validate("enterprise", "version-1")).resolves.toMatchObject({ ready: true });
    expect(trx.updates).toContain("employee_model_rule_version");
  });
});
