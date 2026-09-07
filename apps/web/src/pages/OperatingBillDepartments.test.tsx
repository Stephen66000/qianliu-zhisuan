import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OperatingBillDepartmentsPage,
  type DepartmentAccounts,
} from "./OperatingBillDepartments";
const mock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", async () => ({
  ...(await vi.importActual("../api/client")),
  ...mock,
}));
const totals = {
  inputTokens: "100",
  outputTokens: "20",
  cacheTokens: "10",
  reasoningTokens: "0",
  totalTokens: "120",
  deductedQuota: "0",
  apiCost: "5",
  packageAllocatedCost: "0",
  totalAllocatedCost: "5",
  activeDays: 2,
  requestCount: 3,
  lastUsedAt: "2026-08-02T00:00:00Z",
  usageQuality: "EXACT" as const,
};
const bill: DepartmentAccounts = {
  month: "2026-08",
  status: "DRAFT",
  totals,
  rows: [
    {
      subjectId: null,
      subjectName: "待归属",
      isUnassigned: true,
      projectOwner: null,
      projectDepartments: [],
      providers: [
        { providerCode: "deepseek", providerName: "DeepSeek", totals },
      ],
      totals,
    },
  ],
};
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={["/operating-bill/departments?month=2026-08"]}
      >
        <OperatingBillDepartmentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mock.get.mockReset().mockResolvedValue(bill);
});
describe("部门主体账", () => {
  it("沿用员工表格，待归属引导到使用主体", async () => {
    show();
    expect(
      await screen.findByRole("columnheader", { name: "DeepSeek API 消费" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "补齐历史归属" })).toHaveAttribute("href", "/principals");
    expect(
      screen.getByRole("columnheader", { name: "活跃天数" }),
    ).toBeInTheDocument();
  });
  it("没有待归属用量时不报警", async () => {
    mock.get.mockResolvedValue({ ...bill, rows: [] });
    show();
    expect(await screen.findByText("本月暂无部门用量")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
