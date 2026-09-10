/**
 * 标准版首页单测（HOME-STANDARD-20260910 WP03）—— 两分区 / 四卡真实字段 / 五跳转 / 三态。
 *
 * 只 mock useStandardHome hook；口径断言以后端契约字段为准，不复制聚合逻辑。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StandardHomeSummary } from "../api/types";
import { DISABLED_FEATURE_FLAGS, FeatureFlagsProvider } from "../feature-flags";
import { DashboardPage } from "./Dashboard";

const useStandardHomeMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useStandardHome: () => useStandardHomeMock(),
}));

type HomeWindow = StandardHomeSummary["tokenUsage"]["previous"]["window"];

function windowFixture(overrides: Partial<HomeWindow> = {}): HomeWindow {
  return {
    rangeStart: "2026-08-31T16:00:00.000Z",
    rangeEndExclusive: "2026-09-10T06:00:00.000Z",
    truncated: false,
    ...overrides,
  };
}

function seededHome(): StandardHomeSummary {
  const window = windowFixture();
  return {
    asOf: "2026-09-10T06:00:00.000Z",
    month: "2026-09",
    tokenUsage: {
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: {
        totalTokens: "1000000000", inputTokens: "600000000", outputTokens: "400000000",
        usageQuality: "EXACT", unknownCount: 0,
      },
      previous: { totalTokens: "833000000", usageQuality: "EXACT", unknownCount: 0, window },
    },
    monthlyCost: {
      month: "2026-09",
      billStatus: "DRAFT",
      current: {
        totalSpends: [{ currency: "CNY", amount: "12800.00000000" }],
        apiSpends: [{ currency: "CNY", amount: "9800.00000000" }],
        packageCosts: [{ currency: "CNY", amount: "3000.00000000" }],
        incompleteReason: null,
      },
      previous: {
        totalSpends: [{ currency: "CNY", amount: "11851.85000000" }],
        incompleteReason: null,
        basis: "BALANCE_BRIDGE",
        window,
      },
    },
    activeEmployees: {
      timezone: "Asia/Shanghai",
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: 28,
      previous: { count: 25, window },
    },
    activeProjects: {
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: 6,
      previous: { count: 5, window },
    },
    resources: {
      providerCount: 2,
      resourceCount: 3,
      attentionProviderCount: 1,
      updatedAt: "2026-09-10T05:05:00.000Z",
      providers: [
        {
          providerCode: "zhipu", providerName: "智谱", resourceCount: 1,
          modes: [{ mode: "CODING_PLAN", count: 1 }],
          worstStatus: "ACTIVE", statusLabel: "正常", statusCategory: "NORMAL",
          abnormalResourceCount: 0, attention: null, syncFailed: false, syncStale: false,
          lastSyncAt: "2026-09-10T05:05:00.000Z",
        },
        {
          providerCode: "openai", providerName: "OpenAI", resourceCount: 2,
          modes: [{ mode: "API", count: 2 }],
          worstStatus: "CREDENTIAL_INVALID", statusLabel: "凭证失效",
          statusCategory: "PARTIAL_ABNORMAL",
          abnormalResourceCount: 1,
          attention: "OpenAI API 备：凭证失效，需要更新凭证",
          syncFailed: false, syncStale: false,
          lastSyncAt: "2026-09-10T05:05:00.000Z",
        },
      ],
    },
  };
}

function emptyHome(): StandardHomeSummary {
  const window = windowFixture();
  return {
    ...seededHome(),
    tokenUsage: {
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: {
        totalTokens: "0", inputTokens: "0", outputTokens: "0",
        usageQuality: "EXACT", unknownCount: 0,
      },
      previous: { totalTokens: "0", usageQuality: "EXACT", unknownCount: 0, window },
    },
    monthlyCost: {
      month: "2026-09",
      billStatus: "DRAFT",
      current: {
        totalSpends: [], apiSpends: [], packageCosts: [],
        incompleteReason: "期初余额待补",
      },
      previous: null,
    },
    activeEmployees: {
      timezone: "Asia/Shanghai",
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: 0,
      previous: { count: 0, window },
    },
    activeProjects: {
      rangeStart: "2026-08-31T16:00:00.000Z",
      rangeEndExclusive: "2026-09-30T16:00:00.000Z",
      current: 0,
      previous: { count: 0, window },
    },
    resources: {
      providerCount: 0, resourceCount: 0, attentionProviderCount: 0, updatedAt: null, providers: [],
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="probe-location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(withProbe = false) {
  return render(
    <MemoryRouter>
      <DashboardPage />
      {withProbe ? <LocationProbe /> : null}
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("标准版首页（两分区）", () => {
  it("加载中显示骨架屏", () => {
    useStandardHomeMock.mockReturnValue({ isLoading: true, error: null, data: undefined });
    const { container } = renderPage();
    expect(container.querySelectorAll(".ql-skeleton").length).toBeGreaterThan(0);
  });

  it("加载失败显示错误与重试", async () => {
    const refetch = vi.fn();
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: new Error("网关超时"), data: undefined, refetch,
    });
    renderPage();
    expect(screen.getByText("网关超时")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it("分区顺序：本月概览在前，接入资源在后，页头展示账期与截止时点", () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: seededHome(), isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const zones = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(zones).toEqual(["本月概览", "接入资源"]);
    expect(screen.getByRole("heading", { name: "首页看板" })).toBeInTheDocument();
  });

  it("四张卡片展示真实字段与同期参照，且不再输出卡片内解释行", () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: seededHome(), isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const tokenCard = screen.getByTestId("home-token-card");
    expect(within(tokenCard).getByText("10.00")).toBeInTheDocument();
    expect(within(tokenCard).getByText("亿 Token")).toBeInTheDocument();
    expect(within(tokenCard).getByText(/较上月同期 \+20\.0%/)).toBeInTheDocument();
    expect(within(tokenCard).getByText("上月同期 8.33 亿 Token")).toBeInTheDocument();
    // 解释行已删除：不再出现"输入 + 输出合计，缓存不重复累加"等口径说明
    expect(tokenCard.textContent).not.toContain("输入 + 输出合计");
    expect(tokenCard.textContent).not.toContain("缓存不重复累加");
    expect(tokenCard.textContent).not.toContain("上游实报");

    const costCard = screen.getByTestId("home-cost-card");
    expect(within(costCard).getByText("¥12,800.00")).toBeInTheDocument();
    expect(within(costCard).getByText(/较上月同期 \+8\.0%/)).toBeInTheDocument();
    expect(within(costCard).getByText("上月同期 ¥11,851.85")).toBeInTheDocument();
    // 解释行已删除：不再出现"同期按…口径聚合"
    expect(costCard.textContent).not.toContain("口径聚合");

    const employeeCard = screen.getByTestId("home-employee-card");
    expect(within(employeeCard).getByText("28")).toBeInTheDocument();
    expect(within(employeeCard).getByText("较上月同期 增加 3 人")).toBeInTheDocument();
    expect(within(employeeCard).getByText("上月同期 25 人")).toBeInTheDocument();
    expect(employeeCard.textContent).not.toContain("不代表当前在线人数");

    const projectCard = screen.getByTestId("home-project-card");
    expect(within(projectCard).getByText("6")).toBeInTheDocument();
    expect(within(projectCard).getByText("较上月同期 增加 1 个")).toBeInTheDocument();
    expect(projectCard.textContent).not.toContain("未归属请求在项目账单独列示");
  });

  it("五个跳转指向计划第 3 节的目标路由", () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: seededHome(), isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByTestId("home-token-card").getAttribute("href"))
      .toBe("/resources?tab=usage-overview");
    expect(screen.getByTestId("home-cost-card").getAttribute("href"))
      .toBe("/operating-bill?month=2026-09");
    expect(screen.getByTestId("home-employee-card").getAttribute("href"))
      .toBe("/usage?tab=overview&subject_type=EMPLOYEE&period=MONTH");
    expect(screen.getByTestId("home-project-card").getAttribute("href"))
      .toBe("/operating-bill/projects?month=2026-09");
    expect(screen.getByRole("link", { name: "管理资源" }).getAttribute("href"))
      .toBe("/resources?tab=supply-health");
    expect(screen.getByRole("link", { name: "查看经营账单" }).getAttribute("href"))
      .toBe("/operating-bill?month=2026-09");
  });

  it("点击 Token 卡在应用内路由导航到厂商资源用量总览", async () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: seededHome(), isFetching: false, refetch: vi.fn(),
    });
    renderPage(true);
    await userEvent.click(screen.getByTestId("home-token-card"));
    expect(screen.getByTestId("probe-location").textContent)
      .toBe("/resources?tab=usage-overview");
  });

  it("同期窗口脚注写明区间与分别统计", () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: seededHome(), isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const footnote = screen.getByText(/同期比较：/);
    expect(footnote.textContent).toContain("09-01");
    expect(footnote.textContent).toContain("09-10 14:00");
    expect(footnote.textContent).toContain("员工与项目分别去重统计，不可相加");
  });

  it("上月无对应日（截断）时脚注说明截止上月月末", () => {
    const data = seededHome();
    data.tokenUsage.previous.window = windowFixture({
      rangeStart: "2026-01-31T16:00:00.000Z",
      rangeEndExclusive: "2026-02-28T16:00:00.000Z",
      truncated: true,
    });
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText(/同期比较：/).textContent).toContain("已截止月末");
  });

  it("上期为 0 或缺失时不输出正常增长百分比", () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: emptyHome(), isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const tokenCard = screen.getByTestId("home-token-card");
    expect(within(tokenCard).getByText(/不计算百分比/)).toBeInTheDocument();
    expect(within(tokenCard).queryByText(/较上月同期 \+\d/)).not.toBeInTheDocument();
    const costCard = screen.getByTestId("home-cost-card");
    expect(within(costCard).getByText("期初余额待补")).toBeInTheDocument();
    expect(within(costCard).getByText("上月同期 暂无可比数据")).toBeInTheDocument();
  });

  it("多币种费用分行展示（主币种大字 + 其余币种独立行）且不计算百分比", () => {
    const data = seededHome();
    data.monthlyCost.current.totalSpends = [
      { currency: "CNY", amount: "1200.00000000" },
      { currency: "USD", amount: "30.00000000" },
    ];
    data.monthlyCost.previous = null;
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const costCard = screen.getByTestId("home-cost-card");
    expect(within(costCard).getByText("¥1,200.00")).toBeInTheDocument();
    expect(within(costCard).getByText("USD 30.00")).toBeInTheDocument();
    // R01-F04：多币种金额不得拼成一行越出卡片
    expect(costCard.textContent).not.toContain("¥1,200.00 / USD 30.00");
    expect(within(costCard).getAllByTestId("home-cost-card-additional-value")).toHaveLength(1);
    expect(within(costCard).getByText(/不计算百分比/)).toBeInTheDocument();
  });

  it("R01-F01：本期费用存在缺口时保留已知金额、禁止百分比，缺口说明收敛进同期脚注", () => {
    const data = seededHome();
    data.monthlyCost.current.incompleteReason = "API_USAGE_COST_UNKNOWN:1";
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const costCard = screen.getByTestId("home-cost-card");
    const text = costCard.textContent ?? "";
    expect(text).not.toContain("+8.0%");
    expect(text).toContain("¥12,800.00");
    expect(within(costCard).getByText("金额存在缺口，不计算百分比")).toBeInTheDocument();
  });

  it("R01-F01：同期费用存在缺口时不输出百分比并说明缺口", () => {
    const data = seededHome();
    data.monthlyCost.previous!.incompleteReason = "CASH_PAID_CNY_MISSING:1";
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const costCard = screen.getByTestId("home-cost-card");
    const text = costCard.textContent ?? "";
    expect(text).not.toContain("+8.0%");
    expect(within(costCard).getByText("金额存在缺口，不计算百分比")).toBeInTheDocument();
  });

  it("R01-F02：本期 Token 含未知记录（即使质量为 EXACT）不输出百分比", () => {
    const data = seededHome();
    data.tokenUsage.current.unknownCount = 1;
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const tokenCard = screen.getByTestId("home-token-card");
    const text = tokenCard.textContent ?? "";
    expect(text).not.toContain("+20.0%");
    expect(text).toContain("10.00");
    expect(within(tokenCard).getByText("本期或同期用量不完整，不计算百分比")).toBeInTheDocument();
  });

  it("R01-F02：同期 Token 质量为 UNKNOWN 时不输出百分比并注明分母不完整", () => {
    const data = seededHome();
    data.tokenUsage.previous.usageQuality = "UNKNOWN";
    data.tokenUsage.previous.unknownCount = 2;
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const tokenCard = screen.getByTestId("home-token-card");
    const text = tokenCard.textContent ?? "";
    expect(text).not.toContain("+20.0%");
    expect(within(tokenCard).getByText("本期或同期用量不完整，不计算百分比")).toBeInTheDocument();
    expect(within(tokenCard).getByText(/上月同期 8\.33 亿 Token（上月同期含未知用量）/)).toBeInTheDocument();
  });

  it("R01 开关边界：用量概览开关关闭时员工卡降级到 /usage 默认页", () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: seededHome(), isFetching: false, refetch: vi.fn(),
    });
    render(
      <FeatureFlagsProvider value={DISABLED_FEATURE_FLAGS}>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </FeatureFlagsProvider>,
    );
    expect(screen.getByTestId("home-employee-card").getAttribute("href")).toBe("/usage");
  });

  it("R01-F03：同厂商部分资源同步过期时关注信息给出资源范围", () => {
    const data = seededHome();
    data.resources.providers[1]!.syncStale = true;
    data.resources.providers[1]!.attention
      = "其中 1 项资源经营数据同步超过 36 小时未成功；额度与余额情况需分别确认";
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText(/其中 1 项资源经营数据同步超过 36 小时未成功/)).toBeInTheDocument();
    expect(screen.getByText(/额度与余额情况需分别确认/)).toBeInTheDocument();
  });

  it("R01-F04：大金额主数值按长度自适应更小字号档位", () => {
    const data = seededHome();
    data.monthlyCost.current.totalSpends = [{ currency: "CNY", amount: "128000000.00000000" }];
    data.monthlyCost.previous = null;
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    const { container } = renderPage();
    const strong = container.querySelector('[data-testid="home-cost-card"] strong');
    expect(strong?.textContent).toBe("¥128,000,000.00");
    expect(strong?.className).toContain("text-[18px]");
    expect(strong?.className).not.toContain("xl:text-[32px]");
  });

  it("V14-C2 F-D：上期多币种全为 0 时明确显示上月同期为 0", () => {
    const data = seededHome();
    data.monthlyCost.previous = {
      totalSpends: [
        { currency: "CNY", amount: "0.00000000" },
        { currency: "USD", amount: "0.00" },
      ],
      incompleteReason: null,
      basis: "BALANCE_BRIDGE",
      window: windowFixture(),
    };
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data, isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    const costCard = screen.getByTestId("home-cost-card");
    expect(within(costCard).getByText("上月同期为 0，不计算百分比")).toBeInTheDocument();
    expect(costCard.textContent).not.toContain("+");
    expect(within(costCard).getByText(/¥0\.00 \/ USD 0\.00/)).toBeInTheDocument();
  });

  it("资源区完整展示厂商、形态数量、状态与关注信息", () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: seededHome(), isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByTestId("home-provider-meta").textContent).toBe("2 家厂商 · 3 项资源");
    expect(screen.getByTestId("home-provider-attention-count").textContent).toBe("1 家需关注");
    const rows = screen.getAllByTestId("home-provider-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText("OpenAI")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/API · 2 项资源/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("局部异常")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/凭证失效，需要更新凭证/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText("正常")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/资源状态更新于/).textContent)
      .toContain("调用状态与额度/余额同步状态分别判断");
    expect(screen.getByRole("link", { name: "查看OpenAI资源状态与处理入口" }))
      .toHaveAttribute("href", "/resources?tab=supply-health");
  });

  it("无资源时显示空状态引导", () => {
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: emptyHome(), isFetching: false, refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText("尚未接入厂商资源")).toBeInTheDocument();
  });

  it("刷新按钮触发重新拉取", async () => {
    const refetch = vi.fn();
    useStandardHomeMock.mockReturnValue({
      isLoading: false, error: null, data: seededHome(), isFetching: false, refetch,
    });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
