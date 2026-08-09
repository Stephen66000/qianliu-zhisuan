import { describe, expect, it } from "vitest";
import { lockActivePrincipalKeys, lockActiveProviderPools } from "./principal-access-locks.js";

class FakeQuery {
  private filters: Array<{ column: string; operator: string; value: string }> = [];
  private selected: string | "all" | undefined;
  constructor(
    private readonly table: string,
    private readonly calls: string[],
    private readonly missingKeys: Set<string>,
    private readonly missingPools: Set<string>,
  ) {}
  select(column: string) { this.selected = column; return this; }
  selectAll() { this.selected = "all"; return this; }
  where(column: string, operator: string, value: string) {
    this.filters.push({ column, operator, value });
    return this;
  }
  forUpdate() { return this; }
  async executeTakeFirst() {
    const principal = this.filters.find((filter) => filter.column === "principal_id")?.value;
    const provider = this.filters.find((filter) => filter.column === "provider")?.value;
    const matches = (expected: Array<{ column: string; value: string }>) => expected.every((filter) =>
      this.filters.some((actual) => actual.column === filter.column
        && actual.operator === "=" && actual.value === filter.value));
    if (this.table === "principal_key" && this.selected === "id"
      && !this.missingKeys.has(principal!)
      && matches([
        { column: "enterprise_id", value: "enterprise" },
        { column: "principal_id", value: principal! },
        { column: "status", value: "ACTIVE" },
      ])) {
      this.calls.push(`key:${principal}`);
      return { id: `key-${principal}` };
    }
    if (this.table !== "principal_grant" || this.selected !== "all"
      || this.missingPools.has(`${principal}:${provider}`)
      || !matches([
        { column: "enterprise_id", value: "enterprise" },
        { column: "principal_id", value: principal! },
        { column: "provider", value: provider! },
        { column: "pool_model_alias", value: "*" },
        { column: "status", value: "ACTIVE" },
      ])) return undefined;
    this.calls.push(`pool:${principal}:${provider}`);
    return { id: `pool-${principal}-${provider}`, provider, principal_id: principal };
  }
}

class FakeTransaction {
  readonly calls: string[] = [];
  constructor(
    readonly missingKeys = new Set<string>(),
    readonly missingPools = new Set<string>(),
  ) {}
  selectFrom(table: string) {
    return new FakeQuery(table, this.calls, this.missingKeys, this.missingPools);
  }
}

describe("POOL-039 主体接入锁顺序辅助函数", () => {
  it("主体 Key 去重并按稳定顺序加锁", async () => {
    const trx = new FakeTransaction();
    const locked = await lockActivePrincipalKeys(
      trx as never, "enterprise", ["principal-b", "principal-a", "principal-b"],
    );
    expect(trx.calls).toEqual(["key:principal-a", "key:principal-b"]);
    expect([...locked.entries()]).toEqual([
      ["principal-a", "key-principal-a"], ["principal-b", "key-principal-b"],
    ]);
  });

  it("主体与厂商池按双重稳定顺序加锁并返回行", async () => {
    const trx = new FakeTransaction();
    const locked = await lockActiveProviderPools(
      trx as never, "enterprise", ["principal-b", "principal-a"], ["zeta", "alpha", "zeta"],
    );
    expect(trx.calls).toEqual([
      "pool:principal-a:alpha", "pool:principal-a:zeta",
      "pool:principal-b:alpha", "pool:principal-b:zeta",
    ]);
    expect(locked.get("principal-a:alpha")).toMatchObject({ id: "pool-principal-a-alpha" });
    expect(locked.get("principal-b:zeta")).toMatchObject({ id: "pool-principal-b-zeta" });
  });

  it("缺失 Key 或池行时不伪造锁定结果", async () => {
    const trx = new FakeTransaction(
      new Set(["principal-b"]), new Set(["principal-a:alpha"]),
    );
    const keys = await lockActivePrincipalKeys(trx as never, "enterprise", ["principal-a", "principal-b"]);
    const pools = await lockActiveProviderPools(trx as never, "enterprise", ["principal-a"], ["alpha", "zeta"]);
    expect([...keys.keys()]).toEqual(["principal-a"]);
    expect([...pools.keys()]).toEqual(["principal-a:zeta"]);
  });
});
