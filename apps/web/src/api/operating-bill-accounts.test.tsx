import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useOperatingBillEmployee,
  useOperatingBillEmployeeRequests,
  useOperatingBillEmployees,
  useOperatingBillProjects,
} from "./operating-bill-accounts";

const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client", () => client);

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

describe("POOL-043 经营账单 API hooks", () => {
  beforeEach(() => client.get.mockReset().mockResolvedValue({ rows: [], items: [] }));

  it("员工账与项目账使用独立端点并透传厂商、主体搜索", async () => {
    const employees = renderHook(
      () => useOperatingBillEmployees("2026-08", { providerCode: "deepseek", search: "于滔" }),
      { wrapper },
    );
    const projects = renderHook(
      () => useOperatingBillProjects("2026-08", { providerCode: "deepseek", search: "智算" }),
      { wrapper },
    );
    await waitFor(() => expect(employees.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(projects.result.current.isSuccess).toBe(true));
    expect(client.get).toHaveBeenCalledWith(
      "/operating-bills/2026-08/employees?provider_code=deepseek&search=%E4%BA%8E%E6%BB%94",
      expect.any(AbortSignal),
    );
    expect(client.get).toHaveBeenCalledWith(
      "/operating-bills/2026-08/projects?provider_code=deepseek&search=%E6%99%BA%E7%AE%97",
      expect.any(AbortSignal),
    );
  });

  it("员工模型请求按稳定模型 ID、厂商和分页下钻", async () => {
    const employee = renderHook(
      () => useOperatingBillEmployee("2026-08", "employee/yutao", "deepseek"),
      { wrapper },
    );
    const requests = renderHook(
      () => useOperatingBillEmployeeRequests({
        month: "2026-08",
        principalId: "employee/yutao",
        unifiedModelId: "model/flash",
        providerCode: "deepseek",
        limit: 20,
        offset: 40,
      }),
      { wrapper },
    );
    await waitFor(() => expect(employee.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(requests.result.current.isSuccess).toBe(true));
    expect(client.get).toHaveBeenCalledWith(
      "/operating-bills/2026-08/employees/employee%2Fyutao?provider_code=deepseek",
      expect.any(AbortSignal),
    );
    expect(client.get).toHaveBeenCalledWith(
      "/operating-bills/2026-08/employees/employee%2Fyutao/models/model%2Fflash/requests?provider_code=deepseek&limit=20&offset=40",
      expect.any(AbortSignal),
    );
  });

  it("空筛选和无厂商详情不拼接空查询串", async () => {
    const employees = renderHook(
      () => useOperatingBillEmployees("2026-08", {}),
      { wrapper },
    );
    const employee = renderHook(
      () => useOperatingBillEmployee("2026-08", "employee-yutao"),
      { wrapper },
    );
    await waitFor(() => expect(employees.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(employee.result.current.isSuccess).toBe(true));
    expect(client.get).toHaveBeenCalledWith(
      "/operating-bills/2026-08/employees",
      expect.any(AbortSignal),
    );
    expect(client.get).toHaveBeenCalledWith(
      "/operating-bills/2026-08/employees/employee-yutao",
      expect.any(AbortSignal),
    );
  });
});
