import { beforeEach, describe, expect, it, vi } from "vitest";

// 只替换门禁判定；仓储交互（getBill）走真实调用路径，验证门禁确实阻断了聚合。
const gate = vi.hoisted(() => ({ isEnterpriseQuiescent: vi.fn() }));
vi.mock("@qianliu/database", () => ({ isEnterpriseQuiescent: gate.isEnterpriseQuiescent }));

import { generateOperatingBillGuarded, runOperatingBillTask } from "./runner.js";

const NOW = new Date("2026-09-22T02:00:00.000Z");
const ENTERPRISE = "enterprise-1";
const MONTH = "2026-08";

function billFixture() {
  return {
    month: MONTH, timezone: "Asia/Shanghai", status: "DRAFT", version: 3,
    summary: { totalCost: "12.34000000" }, gaps: [{ code: "INCOMPLETE" }],
    generatedAt: "2026-09-22T01:59:00.000Z",
  };
}

function fakeRepository() {
  return { getBill: vi.fn().mockResolvedValue(billFixture()) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POOL-025 月账 Worker（PFA-09 静默门禁唯一入口）", () => {
  it("非静默企业：按企业与自然月调用唯一聚合实现并返回结果", async () => {
    gate.isEnterpriseQuiescent.mockResolvedValue(false);
    const repository = fakeRepository();
    const outcome = await generateOperatingBillGuarded({
      db: {} as never, repository: repository as never, enterpriseId: ENTERPRISE, month: MONTH, now: NOW,
    });
    expect(outcome.status).toBe("GENERATED");
    expect(repository.getBill).toHaveBeenCalledOnce();
    expect(repository.getBill).toHaveBeenCalledWith(ENTERPRISE, MONTH);
    expect(gate.isEnterpriseQuiescent).toHaveBeenCalledWith({}, ENTERPRISE, NOW);
  });

  it("静默企业：整企业跳过，聚合器不被调用（不写任何事实）", async () => {
    gate.isEnterpriseQuiescent.mockResolvedValue(true);
    const repository = fakeRepository();
    const outcome = await generateOperatingBillGuarded({
      db: {} as never, repository: repository as never, enterpriseId: ENTERPRISE, month: MONTH, now: NOW,
    });
    expect(outcome).toEqual({ status: "SKIPPED_QUIESCENT" });
    expect(repository.getBill).not.toHaveBeenCalled();
  });
});

describe("月账命令行任务的唯一实现", () => {
  it("非静默：输出 operating_bill_generated 事件并包含账单字段", async () => {
    gate.isEnterpriseQuiescent.mockResolvedValue(false);
    const repository = fakeRepository();
    const lines: string[] = [];
    const status = await runOperatingBillTask({
      db: {} as never, repository: repository as never, enterpriseId: ENTERPRISE, month: MONTH,
      now: NOW, log: (line) => lines.push(line),
    });
    expect(status).toBe("GENERATED");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "operating_bill_generated", enterprise_id: ENTERPRISE, month: MONTH,
      status: "DRAFT", version: 3, total_cost: "12.34000000", gap_count: 1,
    });
  });

  it("静默：输出 operating_bill_skipped_quiescent 事件，且不产生 GENERATED 事件", async () => {
    gate.isEnterpriseQuiescent.mockResolvedValue(true);
    const repository = fakeRepository();
    const lines: string[] = [];
    const status = await runOperatingBillTask({
      db: {} as never, repository: repository as never, enterpriseId: ENTERPRISE, month: MONTH,
      now: NOW, log: (line) => lines.push(line),
    });
    expect(status).toBe("SKIPPED_QUIESCENT");
    expect(repository.getBill).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: "operating_bill_skipped_quiescent",
      enterprise_id: ENTERPRISE, month: MONTH, reason: "enterprise_quiescent",
    });
  });
});
