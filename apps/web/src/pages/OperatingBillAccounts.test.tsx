import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OperatingBillEmployeeDetail,
  OperatingBillEmployeeRequests,
  OperatingBillEmployees,
  OperatingBillMetricTotals,
  OperatingBillProjects,
} from "../api/operating-bill-accounts";
import { OperatingBillEmployeeDetailPage } from "./OperatingBillEmployeeDetail";
import { OperatingBillEmployeesPage } from "./OperatingBillEmployees";
import { OperatingBillProjectsPage } from "./OperatingBillProjects";

const mocks = vi.hoisted(() => ({
  employees: vi.fn(),
  projects: vi.fn(),
  employee: vi.fn(),
  requests: vi.fn(),
  assign: vi.fn(),
  assignHook: vi.fn(),
  providers: vi.fn(),
  principals: vi.fn(),
}));

vi.mock("../api/operating-bill-accounts", async () => {
  const actual = await vi.importActual("../api/operating-bill-accounts");
  return {
    ...actual,
    useOperatingBillEmployees: mocks.employees,
    useOperatingBillProjects: mocks.projects,
    useOperatingBillEmployee: mocks.employee,
    useOperatingBillEmployeeRequests: mocks.requests,
  };
});

vi.mock("../api/hooks", () => ({
  useProviders: mocks.providers,
  usePrincipals: mocks.principals,
}));

vi.mock("../api/operating-bills", async () => {
  const actual = await vi.importActual("../api/operating-bills");
  return {
    ...actual,
    useAssignOperatingBillProject: mocks.assignHook,
  };
});

const exactTotals: OperatingBillMetricTotals = {
  inputTokens: "1000",
  outputTokens: "500",
  cacheTokens: "200",
  reasoningTokens: "50",
  totalTokens: "1500",
  deductedQuota: "1300",
  apiCost: "12.50000000",
  packageAllocatedCost: "30.00000000",
  totalAllocatedCost: "42.50000000",
  activeDays: 3,
  requestCount: 4,
  lastUsedAt: "2026-08-08T10:30:00.000Z",
  usageQuality: "EXACT",
};

const employees: OperatingBillEmployees = {
  status: "DRAFT",
  month: "2026-08",
  total: 1,
  limit: 25,
  offset: 0,
  totals: exactTotals,
  rows: [{
    subjectId: "employee-yutao",
    subjectName: "于滔",
    isUnassigned: false,
    projectOwner: null,
    projectDepartments: [],
    providers: [{ providerCode: "deepseek", providerName: "DeepSeek" }],
    totals: exactTotals,
  }],
};

const projects: OperatingBillProjects = {
  status: "DRAFT",
  month: "2026-08",
  total: 2,
  limit: 25,
  offset: 0,
  totals: exactTotals,
  rows: [
    {
      subjectId: "project-1",
      subjectName: "智算项目",
      isUnassigned: false,
      projectOwner: { personId: "person-yutao", personName: "于滔" },
      projectDepartments: [{ departmentId: "department-rd", departmentName: "研发中心" }],
      providers: [{ providerCode: "deepseek", providerName: "DeepSeek" }],
      totals: exactTotals,
    },
    {
      subjectId: null,
      subjectName: "未归属项目",
      isUnassigned: true,
      projectOwner: null,
      projectDepartments: [],
      providers: [{ providerCode: "deepseek", providerName: "DeepSeek" }],
      totals: exactTotals,
    },
  ],
};

const detail: OperatingBillEmployeeDetail = {
  status: "DRAFT",
  month: "2026-08",
  employee: { principalId: "employee-yutao", principalName: "于滔" },
  totals: exactTotals,
  providers: [{
    providerCode: "deepseek",
    providerName: "DeepSeek",
    totals: exactTotals,
    models: [
      {
        unifiedModelId: "model-flash",
        identityStatus: "RESOLVED",
        currentAlias: "ql-deepseek-v4-flash",
        historicalAliases: ["deepseek-v3.2"],
        totals: exactTotals,
        usageShare: "60.00",
      },
      {
        unifiedModelId: "model-pro",
        identityStatus: "RESOLVED",
        currentAlias: "ql-deepseek-v4-pro",
        historicalAliases: [],
        totals: { ...exactTotals, usageQuality: "ESTIMATED" },
        usageShare: "40.00",
      },
    ],
  }],
  gaps: [],
};

const requests: OperatingBillEmployeeRequests = {
  status: "DRAFT",
  month: "2026-08",
  employee: detail.employee,
  model: { unifiedModelId: "model-flash", currentAlias: "ql-deepseek-v4-flash" },
  total: 1,
  limit: 20,
  offset: 0,
  items: [{
    requestId: "req-deepseek-flash-001",
    modelAliasAtRequest: "deepseek-v3.2",
    currentAlias: "ql-deepseek-v4-flash",
    tokens: {
      inputTokens: "1000",
      outputTokens: "500",
      cacheTokens: "200",
      reasoningTokens: "50",
      totalTokens: "1500",
    },
    costs: {
      deductedQuota: "1300",
      apiCost: "12.50000000",
      packageAllocatedCost: "30.00000000",
      totalAllocatedCost: "42.50000000",
    },
    status: "SUCCEEDED",
    usedAt: "2026-08-08T10:30:00.000Z",
    usageQuality: "EXACT",
  }],
};

function queryResult<T>(data: T) {
  return { data, isLoading: false, error: null, refetch: vi.fn() };
}

function renderEmployeeDetail(entry = "/operating-bill/employees/employee-yutao?month=2026-08") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<OperatingBillEmployeeDetailPage />} path="/operating-bill/employees/:principalId" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("POOL-043 经营账单员工账／项目账", () => {
  beforeEach(() => {
    mocks.employees.mockReset().mockReturnValue(queryResult(employees));
    mocks.projects.mockReset().mockReturnValue(queryResult(projects));
    mocks.employee.mockReset().mockReturnValue(queryResult(detail));
    mocks.requests.mockReset().mockReturnValue(queryResult(requests));
    mocks.assign.mockReset();
    mocks.assignHook.mockReset().mockReturnValue({
      mutate: mocks.assign,
      isPending: false,
      error: null,
    });
    mocks.providers.mockReset().mockReturnValue({
      error: null,
      isLoading: false,
      refetch: vi.fn(),
      data: { providers: [{ code: "deepseek", name: "DeepSeek" }] },
    });
    mocks.principals.mockReset().mockReturnValue({
      error: null,
      isLoading: false,
      refetch: vi.fn(),
      data: {
        principals: [
          { id: "project-1", name: "智算项目", type: "PROJECT", status: "ACTIVE" },
          { id: "employee-1", name: "员工", type: "EMPLOYEE", status: "ACTIVE" },
          { id: "project-off", name: "停用项目", type: "PROJECT", status: "ARCHIVED" },
        ],
      },
    });
  });

  it("员工账直接消费后端合计并保留月份、厂商和员工搜索", async () => {
    const user = userEvent.setup();
    mocks.employees.mockImplementation((_: string, input: { offset: number }) => queryResult({
      ...employees,
      total: 26,
      offset: input.offset,
    }));
    render(<MemoryRouter initialEntries={["/operating-bill/employees?month=2026-08"]}><OperatingBillEmployeesPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "员工账" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "项目账" })).toHaveAttribute("href", "/operating-bill/projects?month=2026-08");
    const row = screen.getByRole("row", { name: /于滔/ });
    expect(within(row).getByText("1,500")).toBeInTheDocument();
    expect(within(row).getByText("¥12.50")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "于滔" })).toHaveAttribute(
      "href",
      "/operating-bill/employees/employee-yutao?month=2026-08",
    );
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(mocks.employees).toHaveBeenLastCalledWith("2026-08", expect.objectContaining({ offset: 25 }));
    await user.click(screen.getByRole("button", { name: "上一页" }));
    expect(mocks.employees).toHaveBeenLastCalledWith("2026-08", expect.objectContaining({ offset: 0 }));
    await user.selectOptions(screen.getByLabelText("厂商"), "deepseek");
    await user.type(screen.getByLabelText("搜索员工"), "于滔");
    expect(mocks.employees).toHaveBeenLastCalledWith("2026-08", {
      limit: 25,
      offset: 0,
      providerCode: "deepseek",
      search: "于滔",
    });
  });

  it("员工详情按厂商展开模型 alias，再进入真实请求明细", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/operating-bill/employees/employee-yutao?month=2026-08"]}>
        <Routes>
          <Route element={<OperatingBillEmployeeDetailPage />} path="/operating-bill/employees/:principalId" />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "于滔" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    expect(screen.getByText("ql-deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.getByText("ql-deepseek-v4-pro")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v3.2")).toBeInTheDocument();
    expect(screen.getByText("60.00%")).toBeInTheDocument();
    expect(screen.getByText("约 40.00%")).toBeInTheDocument();
    const flashRow = screen.getByRole("row", { name: /ql-deepseek-v4-flash/ });
    await user.click(within(flashRow).getByRole("button", { name: "查看请求明细" }));
    expect(await screen.findByText("req-deepseek-flash-001")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "req-deepseek-flash-001" })).toBeNull();
    expect(screen.getByText("历史：deepseek-v3.2")).toBeInTheDocument();
    expect(mocks.requests).toHaveBeenCalledWith({
      month: "2026-08",
      principalId: "employee-yutao",
      unifiedModelId: "model-flash",
      providerCode: "deepseek",
      limit: 20,
      offset: 0,
    });
  });

  it("项目账为独立入口，明确列示项目与未归属项目", () => {
    render(<MemoryRouter initialEntries={["/operating-bill/projects?month=2026-08"]}><OperatingBillProjectsPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "项目账" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("哪个项目产生了多少成本", { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText("智算项目").length).toBeGreaterThan(0);
    const project = screen.getByRole("row", { name: /智算项目/ });
    expect(within(project).getByText("于滔")).toBeInTheDocument();
    expect(within(project).getByText("研发中心")).toBeInTheDocument();
    const unassigned = screen.getByRole("row", { name: /未归属项目/ });
    expect(within(unassigned).getByText("未归属")).toBeInTheDocument();
    expect(within(unassigned).queryByRole("link", { name: "查看请求" })).toBeNull();
  });

  it("UNKNOWN 用量不伪装为精确 Token，并提供空态", () => {
    mocks.employees.mockReturnValueOnce(queryResult({
      ...employees,
      totals: { ...exactTotals, inputTokens: null, outputTokens: null, cacheTokens: null, totalTokens: null, usageQuality: "UNKNOWN" },
      rows: [],
    }));
    render(<MemoryRouter initialEntries={["/operating-bill/employees?month=2026-08"]}><OperatingBillEmployeesPage /></MemoryRouter>);
    expect(screen.getAllByText("未知").length).toBeGreaterThan(0);
    expect(screen.getByText("没有员工账单记录")).toBeInTheDocument();
  });

  it("员工账覆盖加载态、错误态与重试", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.employees.mockReturnValueOnce({ data: undefined, isLoading: true, error: null, refetch });
    const view = render(
      <MemoryRouter initialEntries={["/operating-bill/employees?month=2026-08"]}>
        <OperatingBillEmployeesPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("正在汇总员工月度账单…")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索员工")).toBeInTheDocument();
    await user.type(screen.getByLabelText("搜索员工"), "于滔");
    expect(screen.getByLabelText("搜索员工")).toHaveValue("于滔");
    view.unmount();

    mocks.employees.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new Error("员工账网络失败"),
      refetch,
    });
    render(
      <MemoryRouter initialEntries={["/operating-bill/employees?month=2026-08"]}>
        <OperatingBillEmployeesPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("员工账网络失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("员工账可清除厂商和搜索，未知主体与空厂商不生成错误链接", async () => {
    const user = userEvent.setup();
    mocks.employees.mockReturnValue(queryResult({
      ...employees,
      rows: [{
        subjectId: null,
        subjectName: "历史未知员工",
        isUnassigned: false,
        projectOwner: null,
        projectDepartments: [],
        providers: [],
        totals: {
          ...exactTotals,
          apiCost: null,
          packageAllocatedCost: null,
          totalAllocatedCost: null,
          lastUsedAt: null,
          usageQuality: "MIXED",
        },
      }],
    }));
    render(
      <MemoryRouter initialEntries={["/operating-bill/employees?month=2026-08&provider_code=deepseek&search=历史"]}>
        <OperatingBillEmployeesPage />
      </MemoryRouter>,
    );
    const row = screen.getByRole("row", { name: /历史未知员工/ });
    expect(within(row).queryByRole("link", { name: "历史未知员工" })).toBeNull();
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(row).getAllByText("未知").length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByLabelText("厂商"), "");
    await user.clear(screen.getByLabelText("搜索员工"));
    expect(mocks.employees).toHaveBeenLastCalledWith("2026-08", {
      limit: 25,
      offset: 0,
      providerCode: undefined,
      search: undefined,
    });
  });

  it("员工详情覆盖加载态、错误态与重试", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.employee.mockReturnValueOnce({ data: undefined, isLoading: true, error: null, refetch });
    const view = renderEmployeeDetail();
    expect(screen.getByLabelText("正在加载员工账详情…")).toBeInTheDocument();
    view.unmount();

    mocks.employee.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new Error("详情读取失败"),
      refetch,
    });
    renderEmployeeDetail();
    expect(screen.getByText("详情读取失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("员工详情可筛选并清除厂商，展示空厂商和历史模型身份缺口", async () => {
    const user = userEvent.setup();
    mocks.employee.mockReturnValue(queryResult({
      ...detail,
      providers: [],
      gaps: [{ code: "MODEL_ID_UNRESOLVED", historicalAlias: "deepseek-legacy" }],
    }));
    renderEmployeeDetail();
    expect(screen.getByText("没有厂商明细")).toBeInTheDocument();
    expect(screen.getByText(/deepseek-legacy/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("详情厂商"), "deepseek");
    expect(mocks.employee).toHaveBeenLastCalledWith("2026-08", "employee-yutao", "deepseek");
    await user.selectOptions(screen.getByLabelText("详情厂商"), "");
    expect(mocks.employee).toHaveBeenLastCalledWith("2026-08", "employee-yutao", undefined);
  });

  it("员工详情展示空模型和 unresolved 历史 alias，并支持收起厂商", async () => {
    const user = userEvent.setup();
    const unresolved = {
      ...detail,
      providers: [
        { ...detail.providers[0]!, providerCode: "empty", providerName: "空模型厂商", models: [] },
        {
          ...detail.providers[0]!,
          models: [
            {
              unifiedModelId: null,
              identityStatus: "UNRESOLVED" as const,
              currentAlias: null,
              historicalAliases: ["deepseek-legacy"],
              totals: { ...exactTotals, usageQuality: "ACCOUNT_AGGREGATED" as const },
              usageShare: null,
            },
            {
              unifiedModelId: null,
              identityStatus: "UNRESOLVED" as const,
              currentAlias: null,
              historicalAliases: [],
              totals: exactTotals,
              usageShare: null,
            },
          ],
        },
      ],
    };
    mocks.employee.mockReturnValue(queryResult(unresolved));
    renderEmployeeDetail();
    await user.click(screen.getByRole("button", { name: /空模型厂商/ }));
    expect(screen.getByText("没有模型明细")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /空模型厂商/ }));
    expect(screen.queryByText("没有模型明细")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^DeepSeek/ }));
    expect(screen.getAllByText("deepseek-legacy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("未解析模型")).toHaveLength(2);
    expect(screen.getAllByText("模型身份未解析")).toHaveLength(2);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("请求明细覆盖加载态", async () => {
    const user = userEvent.setup();
    mocks.requests.mockReturnValue({ data: undefined, isLoading: true, error: null, refetch: vi.fn() });
    renderEmployeeDetail();
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    const flashRow = screen.getByRole("row", { name: /ql-deepseek-v4-flash/ });
    await user.click(within(flashRow).getByRole("button", { name: "查看请求明细" }));
    expect(screen.getByText("正在加载真实请求证据…")).toBeInTheDocument();
  });

  it("请求明细覆盖错误重试与空态", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.requests.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new Error("请求证据失败"),
      refetch,
    });
    const view = renderEmployeeDetail();
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    await user.click(within(screen.getByRole("row", { name: /ql-deepseek-v4-flash/ }))
      .getByRole("button", { name: "查看请求明细" }));
    expect(screen.getByText("请求证据失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    view.unmount();

    mocks.requests.mockReturnValue(queryResult({ ...requests, items: [], total: 0 }));
    renderEmployeeDetail();
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    await user.click(within(screen.getByRole("row", { name: /ql-deepseek-v4-flash/ }))
      .getByRole("button", { name: "查看请求明细" }));
    expect(screen.getByText("没有请求明细")).toBeInTheDocument();
  });

  it("请求明细空页仍可返回上一页，员工搜索条件可返回复现", async () => {
    const user = userEvent.setup();
    mocks.requests.mockImplementation((input: { offset: number }) => queryResult({
      ...requests,
      total: 21,
      offset: input.offset,
      items: input.offset === 0 ? requests.items : [],
    }));
    renderEmployeeDetail("/operating-bill/employees/employee-yutao?month=2026-08&search=%E4%BA%8E%E6%BB%94");
    expect(screen.getByRole("link", { name: "返回员工账" })).toHaveAttribute(
      "href",
      "/operating-bill/employees?month=2026-08&search=%E4%BA%8E%E6%BB%94",
    );
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    await user.click(within(screen.getByRole("row", { name: /ql-deepseek-v4-flash/ }))
      .getByRole("button", { name: "查看请求明细" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("没有请求明细")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回上一页" }));
    expect(mocks.requests).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it("同一稳定模型跨厂商时独立维护展开状态", async () => {
    const user = userEvent.setup();
    mocks.employee.mockReturnValue(queryResult({
      ...detail,
      providers: [
        detail.providers[0]!,
        { ...detail.providers[0]!, providerCode: "ark", providerName: "火山方舟" },
      ],
    }));
    renderEmployeeDetail();
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    await user.click(screen.getByRole("button", { name: /火山方舟/ }));
    const flashRows = screen.getAllByRole("row", { name: /ql-deepseek-v4-flash/ });
    await user.click(within(flashRows[0]!).getByRole("button", { name: "查看请求明细" }));
    expect(within(flashRows[1]!).getByRole("button", { name: "查看请求明细" })).toHaveAttribute("aria-expanded", "false");
  });

  it("请求明细支持翻页、收起和完整状态／alias 口径", async () => {
    const user = userEvent.setup();
    const statuses = ["FAILED", "RUNNING", "CANCELLED", "CUSTOM"];
    mocks.requests.mockImplementation((input: { offset: number }) => queryResult({
      ...requests,
      total: 45,
      offset: input.offset,
      items: statuses.map((status, index) => ({
        ...requests.items[0]!,
        requestId: `request-${input.offset}-${index}`,
        currentAlias: index === 0 ? null : "ql-deepseek-v4-flash",
        modelAliasAtRequest: index === 1 ? "ql-deepseek-v4-flash" : "deepseek-v3.2",
        status,
        usageQuality: index === 2 ? "UNKNOWN" as const : "MIXED" as const,
        tokens: index === 2
          ? { inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null, totalTokens: null }
          : requests.items[0]!.tokens,
      })),
    }));
    renderEmployeeDetail();
    await user.click(screen.getByRole("button", { name: /DeepSeek/ }));
    const flashRow = screen.getByRole("row", { name: /ql-deepseek-v4-flash/ });
    await user.click(within(flashRow).getByRole("button", { name: "查看请求明细" }));
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
    expect(screen.getByText("CUSTOM")).toBeInTheDocument();
    expect(screen.getByText("当前 alias 未解析")).toBeInTheDocument();
    expect(screen.getAllByText("用量未知").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(mocks.requests).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 }));
    await user.click(screen.getByRole("button", { name: "上一页" }));
    expect(mocks.requests).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
    await user.click(within(flashRow).getByRole("button", { name: "收起请求明细" }));
    expect(screen.queryByText("CUSTOM")).toBeNull();
  });

  it("项目账覆盖加载态、错误态与重试", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.projects.mockReturnValueOnce({ data: undefined, isLoading: true, error: null, refetch });
    const view = render(
      <MemoryRouter initialEntries={["/operating-bill/projects?month=2026-08"]}>
        <OperatingBillProjectsPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("正在汇总项目月度账单…")).toBeInTheDocument();
    view.unmount();

    mocks.projects.mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new Error("项目账网络失败"),
      refetch,
    });
    render(
      <MemoryRouter initialEntries={["/operating-bill/projects?month=2026-08"]}>
        <OperatingBillProjectsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("项目账网络失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("项目账支持筛选清除、空态和 CLOSED 只读状态", async () => {
    const user = userEvent.setup();
    mocks.projects.mockReturnValue(queryResult({ ...projects, status: "CLOSED", rows: [] }));
    mocks.providers.mockReturnValue({ error: null, isLoading: false, refetch: vi.fn(), data: undefined });
    render(
      <MemoryRouter initialEntries={["/operating-bill/projects?month=2026-08&provider_code=deepseek&search=星河"]}>
        <OperatingBillProjectsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("没有项目账单记录")).toBeInTheDocument();
    expect(screen.queryByText("请求归属项目")).toBeNull();
    await user.selectOptions(screen.getByLabelText("厂商"), "");
    await user.clear(screen.getByLabelText("搜索项目"));
    expect(mocks.projects).toHaveBeenLastCalledWith("2026-08", {
      limit: 25,
      offset: 0,
      providerCode: undefined,
      search: undefined,
    });
  });

  it("项目归属表单提交真实 mutation，并在成功后清空和刷新", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mocks.projects.mockReturnValue({ ...queryResult(projects), refetch });
    mocks.assign.mockImplementation((_: unknown, options: { onSuccess: () => void }) => options.onSuccess());
    render(
      <MemoryRouter initialEntries={["/operating-bill/projects?month=2026-08"]}>
        <OperatingBillProjectsPage />
      </MemoryRouter>,
    );
    const submit = screen.getByRole("button", { name: "保存归属" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("待归属请求 ID"), "request-043");
    await user.selectOptions(screen.getByLabelText("归属项目"), "project-1");
    await user.click(submit);
    expect(mocks.assign).toHaveBeenCalledWith(
      {
        ai_request_id: "request-043",
        project_principal_id: "project-1",
        reason: "经营账单项目归属",
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByLabelText("待归属请求 ID")).toHaveValue("");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("项目归属展示 mutation 错误与 pending 禁用状态", () => {
    mocks.assignHook.mockReturnValue({
      mutate: mocks.assign,
      isPending: true,
      error: new Error("归属冲突"),
    });
    mocks.principals.mockReturnValue({ data: undefined });
    render(
      <MemoryRouter initialEntries={["/operating-bill/projects?month=2026-08"]}>
        <OperatingBillProjectsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("归属冲突")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存归属" })).toBeDisabled();
    expect(screen.getByLabelText("归属项目").querySelectorAll("option")).toHaveLength(1);
  });
});
