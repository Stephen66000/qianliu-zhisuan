import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBillingRulesMock, modelsMock, resourcesMock, routesMock, principalsMock, policiesMock, query } from "./quota-rules-test-fixture";
import { QuotaRulesPage } from "./QuotaRules.js";

describe("额度规则配置依赖顺序", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBillingRulesMock.mockReturnValue(query({ rules: [] }));
    modelsMock.mockReturnValue(query({ models: [] }));
    resourcesMock.mockReturnValue(query({ resources: [] }));
    routesMock.mockReturnValue(query({ routes: [] }));
    policiesMock.mockReturnValue(query({ policies: [] }));
    principalsMock.mockReturnValue(query({ principals: [] }));
  });

  it("计价和调度分为两个 Tab，移除重复创建和部门预算入口", () => {
    render(
      <MemoryRouter>
        <QuotaRulesPage />
      </MemoryRouter>,
    );

    const dependencyHeadings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent)
      .filter((text) =>
        ["计价", "调度策略"].includes(text ?? ""),
      );
    expect(dependencyHeadings).toEqual(["计价"]);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "新建路由" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建统一模型" })).not.toBeInTheDocument();
    expect(screen.queryByText("部门预算")).not.toBeInTheDocument();
  });

  it("空企业禁用依赖型创建并明确下一步", () => {
    render(
      <MemoryRouter>
        <QuotaRulesPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "新建规则" })).toBeDisabled();
    expect(screen.getByText(/请先到厂商资源登记资源并同步模型/)).toBeInTheDocument();
  });

  it("模型、资源和启用路由就绪后开放下一步", () => {
    modelsMock.mockReturnValue(query({
      models: [{
        id: "model-1",
        alias: "qianliu-test",
        display_name: "测试模型",
        status: "ACTIVE",
        version: 1,
      }],
    }));
    resourcesMock.mockReturnValue(query({
      resources: [{ id: "resource-1", name: "测试资源" }],
    }));
    routesMock.mockReturnValue(query({
      routes: [{
        id: "route-1",
        unified_model_id: "model-1",
        provider_resource_id: "resource-1",
        upstream_model: "upstream-test",
        priority: 100,
        weight: 1,
        enabled: true,
        version: 1,
      }],
    }));

    render(
      <MemoryRouter>
        <QuotaRulesPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "新建规则" })).toBeEnabled();
    expect(screen.getByText(/选择已同步模型和资源/)).toBeInTheDocument();
  });
});
