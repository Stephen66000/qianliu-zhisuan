/**
 * W18 首页看板单测 —— 八项指标 / 三态 / 数据源 gap（null 不伪造）/ 空企业。
 *
 * 只 mock useDashboard hook；组件渲染断言。
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardSummary } from "../api/types";
import { DashboardPage } from "./Dashboard";

const useDashboardMock = vi.fn();

vi.mock("../api/hooks", () => ({
  useDashboard: () => useDashboardMock(),
}));

function emptySummary(): DashboardSummary {
  return {
    resourceAccountCount: 0,
    activeEmployeeCount: 0,
    currentInUseCount: 0,
    monthlyPackagePayment: null,
    monthlyApiCost: "0",
    monthlyRechargeAmount: null,
    earliestExhaustion: null,
    monthlyDispatchSaving: "0",
    resourceBreakdown: [],
    overageList: [],
  };
}

function seededSummary(): DashboardSummary {
  return {
    ...emptySummary(),
    resourceAccountCount: 2,
    activeEmployeeCount: 5,
    currentInUseCount: 3,
    monthlyApiCost: "12.50000000",
    monthlyDispatchSaving: "1.50000000",
    earliestExhaustion: {
      resourceId: "r1",
      resourceName: "智谱 GLM 套餐",
      providerCode: "zhipu",
      forecastExhaustAt: "2026-07-30T12:00:00.000Z",
      nextRecoverAt: "2026-08-01T00:00:00.000Z",
      confidence: "MEDIUM",
      notCalculableReason: null,
    },
    resourceBreakdown: [
      {
        providerCode: "zhipu",
        providerName: "智谱",
        mode: "CODING_PLAN",
        accountCount: 2,
        totalQuota: "100000",
        usedQuota: "50000",
        monthlyCost: "12.50000000",
        currentRate24h: "2400.5",
        forecastExhaustAt: "2026-07-30T12:00:00.000Z",
        status: "HEALTHY",
      },
    ],
    overageList: [
      {
        principalId: "p1",
        principalName: "张三",
        principalType: "EMPLOYEE",
        provider: "zhipu",
        modelAlias: "glm-4.6",
        quotaValue: "100000",
        usedValue: "105000",
        overageValue: "5000",
        overageRatio: "0.0500",
      },
    ],
  };
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe("W18 首页看板", () => {
  beforeEach(() => {
    useDashboardMock.mockReset();
  });

  it("加载中渲染骨架屏", () => {
    useDashboardMock.mockReturnValue({
      isLoading: true,
      error: null,
      data: undefined,
      refetch: vi.fn(),
    });
    const { container } = renderDashboard();
    expect(container.querySelectorAll(".ql-skeleton").length).toBeGreaterThan(0);
  });

  it("错误态展示原因与重试", () => {
    const refetch = vi.fn();
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: new Error("无法连接到服务，请检查网络后重试"),
      data: undefined,
      refetch,
    });
    renderDashboard();
    expect(screen.getByRole("alert")).toHaveTextContent("无法连接到服务");
    screen.getByRole("button", { name: /重试/ }).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("空企业：计数为 0、费用 0.00、无资源空状态（PRD §10.4）", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: emptySummary(),
      refetch: vi.fn(),
    });
    renderDashboard();
    expect(screen.getByText("厂商资源账号")).toBeInTheDocument();
    expect(screen.getByText("尚未登记厂商资源")).toBeInTheDocument();
    expect(screen.getByText(/无法产生模型和路由候选/)).toBeInTheDocument();
    // 调度节省为 "0" → 展示 0.00，不伪造（API 费用同为 0.00，允许出现多处）
    expect(screen.getByText("本月调度节省（元）")).toBeInTheDocument();
    expect(screen.getAllByText("0.00").length).toBeGreaterThan(0);
  });

  it("数据源 gap：套餐支付/充值为 null → 空状态文案，不伪造数字", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: emptySummary(),
      refetch: vi.fn(),
    });
    renderDashboard();
    const gaps = screen.getAllByText("数据源待接入");
    expect(gaps).toHaveLength(2);
  });

  it("有数据：八项指标 + 资源摘要 + 超额 + 最早耗尽核心区", () => {
    useDashboardMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: seededSummary(),
      refetch: vi.fn(),
    });
    renderDashboard();
    // 指标（费用在指标卡与资源摘要中都会出现，用 getAllByText）
    expect(screen.getByText("本账期活跃人数")).toBeInTheDocument();
    expect(screen.getByText("当前正在使用 3 人")).toBeInTheDocument();
    expect(screen.getAllByText("12.50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.50").length).toBeGreaterThan(0);
    // 核心区：最早耗尽（字体三级：资源名 15px 600）；资源名同时出现在指标卡与核心区，允许多处
    expect(screen.getByText("当下关注")).toBeInTheDocument();
    expect(screen.getAllByText("智谱 GLM 套餐").length).toBeGreaterThan(0);
    expect(screen.getByText(/预计 .* 耗尽/)).toBeInTheDocument();
    expect(screen.getByText(/可信度中/)).toBeInTheDocument();
    // 超额列表：比例 "0.0500" → "5.00%"
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("5.00%")).toBeInTheDocument();
    // 资源摘要
    expect(screen.getByText("智谱")).toBeInTheDocument();
    expect(screen.getAllByText("100,000").length).toBeGreaterThan(0);
  });
});
