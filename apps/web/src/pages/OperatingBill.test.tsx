import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatingBill } from "../api/operating-bills";
import { OperatingBillPage, parseSnapshotCsv } from "./OperatingBill";
import { money } from "./OperatingBillShared";

import { analysisFixture } from "../__tests__/operating-analysis-fixture";

const mutate = vi.fn();
const importSnapshots = vi.fn();
const confirmResource = vi.fn();
const closeBill = vi.fn();
const reopenBill = vi.fn();
const createValue = vi.fn();
const confirmValue = vi.fn();
const recordOpeningBalance = vi.fn();
const recordRecharge = vi.fn();
const bill: OperatingBill = {
  month: "2026-08", timezone: "Asia/Shanghai", status: "DRAFT", version: 0,
  generatedAt: "2026-08-03T00:00:00Z", closedAt: null, closedBy: null, closeNote: null,
  summary: { totalCost: "312.34", apiCost: "12.34", packageCost: "300", endingBalance: "87.66", endingBalanceCurrency: "CNY", planUtilization: "50", activePrincipalCount: 1, confirmedValueAmount: "0", confirmedNonMonetaryCount: 0, unallocatedCost: "0" },
  providers: [{ providerResourceId: "r1", providerCode: "zhipu", providerName: "智谱", resourceName: "Z Plan", mode: "CODING_PLAN", currency: "CNY", apiCost: "0", packageCost: "300", totalCost: "300", endingBalance: null, totalQuota: "10000", usedQuota: "5000", remainingQuota: "5000", quotaUnit: "TOKEN", utilization: "50", activePrincipalCount: 1, status: "ACTIVE", planAssessment: "UNDERUSED", idleEntitlementCost: "150", assessmentBasis: "按未使用比例折算，不代表退款" }],
  subjects: [{ principalId: "p1", principalName: "员工甲", principalType: "EMPLOYEE", providers: ["智谱"], inputTokens: "100", outputTokens: "20", cacheTokens: "0", reasoningTokens: "0", totalTokens: "120", deductedQuota: "120", apiCost: "12.34", packageAllocatedCost: "300", totalAllocatedCost: "312.34", activeDays: 2, requestCount: 3 }],
  values: [], gaps: [], versions: [], events: [],
};

let currentBill = bill;

vi.mock("../api/operating-analysis", () => ({
  useOperatingAnalysis: () => ({
    data: analysisFixture,
    isLoading: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("../api/operating-bill-payments", () => ({
  useOperatingBillPayments: () => ({ data: [], isLoading: false, error: null }),
}));

vi.mock("../api/operating-bills", async () => {
  const actual = await vi.importActual("../api/operating-bills");
  return {
    ...actual,
    useOperatingBill: () => ({ isLoading: false, error: null, data: currentBill, refetch: vi.fn() }),
    useRecordOpeningBalance: () => ({ mutate: recordOpeningBalance, isPending: false, error: null }),
    useRecordResourcePurchase: () => ({ mutate: recordRecharge, isPending: false, error: null }),
    useCreateOperatingBillValue: () => ({ mutate: createValue, isPending: false, error: null }),
    useConfirmOperatingBillValue: () => ({ mutate: confirmValue, isPending: false, error: null }),
    useConfirmOperatingBillResource: () => ({ mutate: confirmResource, isPending: false, error: null }),
    useCloseOperatingBill: () => ({ mutate: closeBill, isPending: false, error: null }),
    useReopenOperatingBill: () => ({ mutate: reopenBill, isPending: false, error: null }),
    useAssignOperatingBillProject: () => ({ mutate, isPending: false, error: null }),
    useImportOperatingBillSnapshots: () => ({ mutateAsync: importSnapshots, isPending: false, error: null }),
  };
});
vi.mock("../api/hooks", () => ({
  usePrincipals: () => ({ data: { principals: [] } }),
  useProviderResources: () => ({ data: { resources: [{
    id: "api-resource",
    operating_snapshot: { id: "snapshot-recharge-100", recharge_amount: "100", currency: "CNY" },
  }] } }),
}));
vi.mock("../api/v2-hooks", () => ({
  useAllPurchases: () => ({ data: { items: [], cashTotals: [] }, isLoading: false, error: null }),
  useProcurementReview: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useSaveProcurementNote: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

describe("POOL-025 经营账单", () => {
  it("DRAFT 现行月退役暂算余额卡，暂算说明仅随历史冻结缺口提示（WP4-S4 / AFR-07）", () => {
    currentBill = { ...bill, summary: { ...bill.summary, endingBalance: null,
      endingBalances: [], provisionalEndingBalances: [{ currency: "CNY", amount: "362.35721028" }] },
      gaps: [{ code: "API_BALANCE_COST_UNKNOWN", providerResourceId: "r1",
        message: "DeepSeek 有5条费用待核实" },
        { code: "API_COST_UNKNOWN", message: "本月有5条未计价请求" }] };
    render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
    // 断言迁移（WP4-S4 合同 2 / AFR-07）：现行月不再渲染"期末余额（暂算）"卡；
    // BalanceQualityNotice 仅在历史冻结快照携带旧质量码时可达（DRAFT 后端已停产）。
    expect(screen.queryByText("期末余额（暂算）")).toBeNull();
    expect(screen.queryByText("期末余额", { exact: true })).toBeNull();
    // 注入的旧质量码（现仅冻结快照可达）仍按 BalanceQualityNotice 既有分支渲染其消息。
    expect(screen.getByText(/DeepSeek 有5条费用待核实/)).toBeInTheDocument();
    expect(screen.getByText(/存在尚未计价的 API 请求/)).toBeInTheDocument();
  });
  it("失败且未返回计量的记录仍提示金额不完整，但不要求日常核查", () => {
    currentBill = { ...bill, gaps: [{ code: "API_COST_UNKNOWN", message: "失败请求未返回计量", requiresUsageReview: false }] };
    render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
    expect(screen.getByText("API费用估算（含待计价）")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "核查用量" })).toBeNull();
  });

  it("已知金额格式化与未知金额占位保持不同语义", () => {
    expect(money("12.34")).toBe("¥12.34");
    expect(money(null)).toBe("—");
  });

  beforeEach(() => {
    currentBill = bill;
    mutate.mockReset();
    importSnapshots.mockReset();
    importSnapshots.mockResolvedValue(undefined);
    confirmResource.mockReset();
    closeBill.mockReset();
    reopenBill.mockReset();
    createValue.mockReset();
    confirmValue.mockReset();
    recordOpeningBalance.mockReset();
    recordRecharge.mockReset();
  });

  it("展示真实成本口径并可切换经营账单页签", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    // 断言迁移（WP4-S4 合同 2 / ACE-07）：DRAFT 现行月"本月总花费"更名
    // "综合费用（含 API 估算）"，期初/充值/期末三卡退役（AFR-07）。
    const totalCard = screen.getAllByText("综合费用（含 API 估算）")
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(totalCard).toHaveTextContent("—");
    expect(screen.queryByText("本月总花费")).toBeNull();
    expect(screen.queryByText("期初余额")).toBeNull();
    expect(screen.queryByText("本月充值")).toBeNull();
    expect(screen.queryByText("期末余额")).toBeNull();
    expect(screen.getAllByText("API费用估算").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥12.34").length).toBeGreaterThan(0);
    expect(screen.getAllByText("¥300.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("期初余额 + 本月充值 - 期末余额")).toBeNull();
    await user.click(screen.getByRole("link", { name: /套餐利用率/ }));
    expect(
      screen.getByRole("heading", { name: "Kimi 月度 Token" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /结账管理/ })).toBeNull();
  });

  it("桥接不可核算（BRIDGE_UNAVAILABLE）显示中性说明，不产资金待补提示（WP4-S4 / AFR-07）", () => {
    // 夹具迁移（WP4-S4 合同 2）：OPENING_BALANCE_MISSING/"待补期初余额"已随后端停产
    // （monthly-operating-cost.ts 改产 BRIDGE_UNAVAILABLE：apiSpend 恒 null、reason null）。
    currentBill = {
      ...bill,
      summary: {
        ...bill.summary,
        totalCost: null,
        apiCost: null,
        ledgerApiCost: "12.34",
        openingBalance: null,
        monthlyRecharge: "100",
        apiSpendStatus: "BRIDGE_UNAVAILABLE",
        apiSpendReason: null,
        packageCost: "621.10",
        apiSpends: [], packageCosts: [{ currency: "CNY", amount: "621.10" }],
        totalSpends: [],
      },
      providers: [{
        ...bill.providers[0]!,
        providerResourceId: "api-resource",
        providerCode: "deepseek",
        providerName: "DeepSeek",
        resourceName: "API 账户",
        mode: "API",
        apiCost: null,
        ledgerApiCost: "12.34",
        openingBalance: null,
        rechargeAmount: "100",
        apiSpendStatus: "BRIDGE_UNAVAILABLE",
        apiSpendReason: null,
        packageCost: "0",
        totalCost: null,
        endingBalance: "87.66",
      }],
    };
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    // 中性说明（WP1 合同 §5④：桥接事实不与估算缺口文案混格）。
    expect(screen.getByText("桥接不可核算（历史资金口径）")).toBeInTheDocument();
    expect(screen.queryByText("待补期初余额")).toBeNull();
    expect(screen.queryByText("账本 API 计价（核对证据） ¥12.34")).toBeNull();
    // DRAFT 现行月：期初/充值/期末三卡退役；估算卡以中性"—"呈现。
    for (const label of ["API费用估算", "套餐费用", "综合费用（含 API 估算）"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("期初余额")).toBeNull();
    expect(screen.queryByText("本月充值")).toBeNull();
    expect(screen.queryByText("期末余额")).toBeNull();
    expect(screen.getAllByText("¥621.10").length).toBeGreaterThan(0);
    const totalCard = screen.getAllByText("综合费用（含 API 估算）")
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(totalCard).toHaveTextContent("—");
    expect(totalCard).not.toHaveTextContent("¥621.10");
    // AFR-07：不再渲染"期初余额未登记→补充资金记录"行动提示。
    expect(screen.queryByText(/期初余额未登记/)).toBeNull();
    expect(screen.queryByRole("link", { name: "厂商资源" })).toBeNull();
  });

  it("上月有期初但计价不完整时不误报未登记", () => {
    currentBill = {
      ...bill, month: "2026-10",
      providers: [{ ...bill.providers[0]!, mode: "API", openingBalance: null,
        apiSpendStatus: "INCOMPLETE", apiSpendReason: "INCOMPLETE_USAGE_COST" }],
      gaps: [{ code: "API_COST_UNKNOWN", message: "上月存在尚未计价请求" }],
    };
    render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
    expect(screen.queryByText(/期初余额未登记/)).toBeNull();
    expect(screen.getByText(/存在尚未计价的 API 请求/)).toBeInTheDocument();
  });

  it("关账历史版本零费用展示旧口径三卡，冻结质量码照旧提示（WP4-S4 / AFR-06）", () => {
    // 断言迁移（WP4-S4 合同 2）：API_MONTH_OPENING_COST_UNKNOWN/API_BALANCE_COST_UNKNOWN
    // 对现行期已停产，仅存于关账冻结快照——夹具改为 status CLOSED（历史口径保留，
    // 期初/充值/期末三卡与 BalanceQualityNotice 均为冻结事实渲染）。
    currentBill = {
      ...bill, month: "2026-10", status: "CLOSED",
      summary: { ...bill.summary, openingBalance: null, openingBalances: [],
        endingBalance: null, endingBalances: [], apiCost: "0.00000000", totalCost: "0.00000000",
        apiSpendStatus: "CALCULABLE", apiSpendReason: null, monthlyRecharge: "0.00000000",
        rechargeAmounts: [{ currency: "CNY", amount: "0.00000000" }],
        apiSpends: [{ currency: "CNY", amount: "0.00000000" }],
        totalSpends: [{ currency: "CNY", amount: "0.00000000" }] },
      providers: [{ ...bill.providers[0]!, mode: "API", providerName: "DeepSeek",
        resourceName: "DeepSeek", openingBalance: null, endingBalance: null,
        apiCost: "0.00000000", apiSpendStatus: "CALCULABLE", apiSpendReason: null }],
      gaps: [
        { code: "API_MONTH_OPENING_COST_UNKNOWN", providerResourceId: "r1",
          message: "DeepSeek：9 月 28—30 日有 4 笔 API 请求费用待核实",
          requestRangeTo: "2026-09-30T10:01:02.536Z" },
        { code: "API_BALANCE_COST_UNKNOWN", providerResourceId: "r1",
          message: "同一账户当前余额待核实" },
      ],
    };
    render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
    expect(screen.queryByText(/期初余额未登记/)).toBeNull();
    expect(screen.queryByText(/存在尚未计价的 API 请求，当前金额/)).toBeNull();
    expect(screen.getByText(/资金初始余额已登记；历史费用仍有待核实记录/)).toBeInTheDocument();
    expect(screen.getByText(/9 月 28—30 日有 4 笔/)).toBeInTheDocument();
    expect(screen.queryByText("同一账户当前余额待核实")).toBeNull();
    const detailLink = new URL(screen.getByRole("link", { name: "核查该资源历史用量" }).getAttribute("href")!, "https://test.local");
    expect(detailLink.searchParams.get("provider_resource_id")).toBe("r1");
    expect(detailLink.searchParams.get("to")).toBe("2026-09-30T10:01:02.536Z");
    expect(detailLink.searchParams.has("from")).toBe(false);
    for (const label of ["API 花费", "本月总花费", "本月充值"]) {
      const card = screen.getAllByText(label).map((node) => node.closest("article")).find(Boolean)!;
      expect(card).toHaveTextContent("¥0.00");
    }
    for (const label of ["期初余额", "期末余额"]) {
      const card = screen.getAllByText(label).map((node) => node.closest("article")).find(Boolean)!;
      expect(card).toHaveTextContent("—");
      expect(card).not.toHaveTextContent("¥0.00");
    }
  });

  it("同资源不同币种的资金缺口不会互相遮蔽", () => {
    currentBill = { ...bill, gaps: [
      { code: "API_MONTH_OPENING_COST_UNKNOWN", providerResourceId: "r1",
        field: "month_opening_balance:CNY", message: "人民币月初结余待核实" },
      { code: "API_BALANCE_COST_UNKNOWN", providerResourceId: "r1",
        field: "balance:USD", message: "美元期末余额待核实" },
    ] };
    render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
    expect(screen.getByText(/人民币月初结余待核实/)).toBeInTheDocument();
    expect(screen.getByText(/美元期末余额待核实/)).toBeInTheDocument();
  });

  it("已知本月费用与负余额核对提示分别展示", () => {
    currentBill = { ...bill,
      summary: { ...bill.summary, apiCost: "7", apiSpends: [{ currency: "CNY", amount: "7" }] },
      gaps: [{ code: "API_NEGATIVE_RECONCILIATION_REQUIRED", providerResourceId: "r1",
        message: "DeepSeek 内部账本计算为负余额，需要核对充值与消耗记录" }],
    };
    render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
    expect(screen.getByText(/内部账本出现负余额/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "核对资金记录" })).toHaveAttribute("href", "/resources");
    expect(screen.queryByText(/存在尚未计价的 API 请求/)).toBeNull();
  });

  it("历史停产缺口码（API_OPENING_BALANCE_MISSING）不再触发登记提示（WP4-S4 / AFR-07）", () => {
    // 断言迁移（WP4-S4 合同 2）：原断言"仍提示登记"——AFR-07 生效后现行视图
    // 退出"期初余额未登记→补充资金记录"提示，旧码即使出现也不渲染行动提示。
    currentBill = {
      ...bill,
      providers: [{ ...bill.providers[0]!, mode: "API", openingBalance: null,
        apiSpendStatus: "INCOMPLETE", apiSpendReason: "MISSING_OPENING_BALANCE" }],
      gaps: [{ code: "API_OPENING_BALANCE_MISSING", message: "未登记期初余额" }],
    };
    render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
    expect(screen.queryByText(/期初余额未登记/)).toBeNull();
    expect(screen.queryByRole("link", { name: "厂商资源" })).toBeNull();
  });

  it("POOL20-039/047：混币月估算卡分列币种，现行月无资金轨迹卡（WP4-S4）", () => {
    currentBill = {
      ...bill,
      summary: {
        ...bill.summary,
        openingBalance: null, monthlyRecharge: null, endingBalance: null,
        apiCost: "25", packageCost: null, totalCost: null,
        endingBalanceCurrency: null,
        openingBalances: [{ currency: "USD", amount: "100" }],
        rechargeAmounts: [{ currency: "CNY", amount: "20" }, { currency: "USD", amount: "5" }],
        endingBalances: [{ currency: "USD", amount: "80" }],
        apiSpends: [{ currency: "USD", amount: "25" }],
        packageCosts: [{ currency: "CNY", amount: "30" }],
        totalSpends: [],
        apiSpendReason: "不可跨币种合计",
      },
      providers: [],
    };
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const card = (label: string) => screen.getAllByText(label)
      .map((node) => node.closest("article")).find(Boolean)!;
    // 断言迁移（WP4-S4 合同 2 / ACE-07）：DRAFT 现行月退役期初/充值/期末三卡；
    // "API 花费"→"API费用估算"、"本月总花费"→"综合费用（含 API 估算）"；
    // 混币分列渲染保持（currencyFacts 逐币种展示，不合并）。
    expect(screen.queryByText("期初余额")).toBeNull();
    expect(screen.queryByText("本月充值")).toBeNull();
    expect(screen.queryByText("期末余额")).toBeNull();
    expect(card("API费用估算")).toHaveTextContent("USD 25.00");
    expect(card("套餐费用")).toHaveTextContent("¥30.00");
    expect(card("综合费用（含 API 估算）")).toHaveTextContent("—");
    expect(card("综合费用（含 API 估算）")).not.toHaveTextContent("¥30.00");
  });

  it("旧 CLOSED 无币种数组时按 provider 行分别恢复 API 与套餐币种", () => {
    const plan = { ...bill.providers[0]!, currency: "CNY", packageCostCurrency: undefined };
    const api = {
      ...bill.providers[0]!, providerResourceId: "legacy-api", providerCode: "legacy-api",
      providerName: "Legacy API", resourceName: "Legacy API", mode: "API" as const,
      currency: "USD", apiCost: "12.5", apiSpendCurrency: undefined,
      packageCost: "0", packageCostCurrency: undefined, totalCost: "12.5",
      endingBalance: "80", totalQuota: null, usedQuota: null, remainingQuota: null,
      quotaUnit: null, utilization: null, planAssessment: null,
      idleEntitlementCost: null, assessmentBasis: null,
    };
    currentBill = {
      ...bill, status: "CLOSED",
      summary: {
        ...bill.summary, apiCost: "12.5", packageCost: "300", totalCost: null,
        endingBalanceCurrency: "USD", apiSpends: undefined, packageCosts: undefined,
        totalSpends: undefined, apiSpendReason: "不可跨币种合计",
      },
      providers: [api, plan],
    };
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const card = (label: string) => screen.getAllByText(label)
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(card("API 花费")).toHaveTextContent("USD 12.50");
    expect(card("套餐费用")).toHaveTextContent("¥300.00");
    expect(card("本月总花费")).toHaveTextContent("¥300.00 / USD 12.50");
    expect(card("套餐费用")).not.toHaveTextContent("USD 300.00");
  });

  it("旧 plan-only CLOSED 无数组时从套餐 provider 保留 CNY 费用", () => {
    currentBill = {
      ...bill, status: "CLOSED",
      summary: {
        ...bill.summary, apiCost: "0", packageCost: "300", totalCost: "300",
        endingBalanceCurrency: null, apiSpends: undefined, packageCosts: undefined,
        totalSpends: undefined,
      },
      providers: [{ ...bill.providers[0]!, currency: "CNY", packageCostCurrency: undefined }],
    };
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const packageCard = screen.getAllByText("套餐费用")
      .map((node) => node.closest("article")).find(Boolean)!;
    expect(packageCard).toHaveTextContent("¥300.00");
  });

  it("月度总览移除充值登记和旧快照 CSV 入口", () => {
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.queryByText("登记本月充值")).toBeNull();
    expect(screen.queryByText("导入账单 CSV")).toBeNull();
    expect(recordRecharge).not.toHaveBeenCalled();
  });

  it("保留旧解析器，对账与导出入口已下线", () => {
    expect(parseSnapshotCsv("provider_resource_id,collected_at,current_balance\nr1,2026-08-18T00:00:00Z,88")).toEqual([{
      provider_resource_id: "r1",
      snapshot: { collected_at: "2026-08-18T00:00:00Z", current_balance: "88" },
    }]);
    expect(() => parseSnapshotCsv("provider_resource_id\nr1")).toThrow("CSV 缺少 provider_resource_id 或 collected_at 表头");
    render(
      <MemoryRouter initialEntries={["/operating-bill?month=2026-08"]}>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /对账与导出/ })).toBeNull();
  });

  it("旧结账地址回到月度总览，不能触发结账写入", () => {
    render(
      <MemoryRouter
        initialEntries={["/operating-bill?month=2026-08&tab=closing"]}
      >
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "厂商投入构成" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认结账并冻结" })).toBeNull();
    expect(closeBill).not.toHaveBeenCalled();
    expect(reopenBill).not.toHaveBeenCalled();
  });

  it("资金投影的零套餐费用显示零，缺失费用仍显示缺失", () => {
    currentBill = {
      ...bill,
      summary: { ...bill.summary, packageCost: "0", packageCosts: [] },
      providers: [{ ...bill.providers[0]!, packageCost: "0" }],
    };
    const view = render(
      <MemoryRouter>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    const card = () =>
      screen
        .getAllByText("套餐费用")
        .map((el) => el.closest("article"))
        .find(Boolean)!;
    expect(card()).toHaveTextContent("¥0.00");
    currentBill = {
      ...currentBill,
      summary: { ...currentBill.summary, packageCost: null },
      providers: [{ ...bill.providers[0]!, packageCost: null }],
    };
    view.rerender(
      <MemoryRouter>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(card()).toHaveTextContent("—");
    expect(card()).not.toHaveTextContent("¥0.00");
  });

  it("Coding Plan 使用主体展示人数，不再展示套餐 Token 额度", () => {
    render(
      <MemoryRouter>
        <OperatingBillPage />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("columnheader", { name: "使用主体" }),
    ).toBeInTheDocument();
    const row = screen.getByText("Z Plan").closest("tr")!;
    expect(row.children[5]).toHaveTextContent(/^1$/);
    expect(row).not.toHaveTextContent("5000 / 10000");
  });
});

it("monthly overview starts with the selected month's exact total tokens", () => {
  render(<MemoryRouter><OperatingBillPage /></MemoryRouter>);
  const card=screen.getByText("本月token使用量").closest("article");
  expect(card).toHaveTextContent("1 亿 Token");
});
