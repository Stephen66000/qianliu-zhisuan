import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useAssignOperatingBillProject,
  useCloseOperatingBill,
  useConfirmOperatingBillValue,
  useCreateOperatingBillValue,
  useImportOperatingBillSnapshots,
  useOperatingBill,
  useRecordOpeningBalance,
  useRecordResourcePurchase,
  useReopenOperatingBill,
} from "./operating-bills";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./client", () => http);

function wrapper(client: QueryClient) {
  return function Provider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const accountKeys = (month: string) => [
  ["operating-bill-employees", month, {}],
  ["operating-bill-projects", month, {}],
  ["operating-bill-employee", month, "employee-1", undefined],
  ["operating-bill-employee-requests", {
    month, principalId: "employee-1", unifiedModelId: "model-1",
    providerCode: "deepseek", limit: 20, offset: 0,
  }],
] as const;

function seedViews(client: QueryClient, month: string) {
  client.setQueryData(["operating-bill", month], { status: "DRAFT" });
  for (const key of accountKeys(month)) client.setQueryData(key, { status: "DRAFT" });
}

function expectAccountInvalidation(client: QueryClient, month: string, expected: boolean) {
  for (const key of accountKeys(month)) {
    expect(client.getQueryState(key)?.isInvalidated).toBe(expected);
  }
}

describe("POOL-043 经营账单 mutation 缓存一致性", () => {
  beforeEach(() => {
    http.get.mockReset().mockResolvedValue({ status: "DRAFT" });
    http.post.mockReset().mockResolvedValue({ status: "CLOSED" });
  });

  it("月度账单使用独立 query key 与真实端点", async () => {
    const client = queryClient();
    const hook = renderHook(() => useOperatingBill("2026-08"), { wrapper: wrapper(client) });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(http.get).toHaveBeenCalledWith("/operating-bills/2026-08", expect.any(AbortSignal));
  });

  it.each(["结账", "重开", "导入快照"] as const)("%s 后失效同月全部账户视图，不污染其他月份", async (action) => {
    const client = queryClient();
    seedViews(client, "2026-08");
    seedViews(client, "2026-07");
    let endpoint: string;
    if (action === "结账") {
      endpoint = "/operating-bills/2026-08/close";
      const hook = renderHook(() => useCloseOperatingBill("2026-08"), { wrapper: wrapper(client) });
      await act(async () => { await hook.result.current.mutateAsync({ allow_incomplete: true, note: "有缺口说明" }); });
    } else if (action === "重开") {
      endpoint = "/operating-bills/2026-08/reopen";
      const hook = renderHook(() => useReopenOperatingBill("2026-08"), { wrapper: wrapper(client) });
      await act(async () => { await hook.result.current.mutateAsync("重新归属"); });
    } else {
      endpoint = "/operating-bill-snapshot-imports";
      const hook = renderHook(() => useImportOperatingBillSnapshots("2026-08"), { wrapper: wrapper(client) });
      await act(async () => {
        await hook.result.current.mutateAsync([{ provider_resource_id: "resource-1", snapshot: {} }]);
      });
    }
    expect(http.post).toHaveBeenCalledWith(endpoint, expect.anything());
    expect(client.getQueryState(["operating-bill", "2026-08"])?.isInvalidated).toBe(true);
    expectAccountInvalidation(client, "2026-08", true);
    expectAccountInvalidation(client, "2026-07", false);
  });

  it("价值事项只失效旧账单，项目归属只失效旧账单和项目账", async () => {
    const client = queryClient();
    seedViews(client, "2026-08");
    const create = renderHook(() => useCreateOperatingBillValue("2026-08"), { wrapper: wrapper(client) });
    await act(async () => { await create.result.current.mutateAsync({ title: "价值" }); });
    expectAccountInvalidation(client, "2026-08", false);

    const confirm = renderHook(() => useConfirmOperatingBillValue("2026-08"), { wrapper: wrapper(client) });
    await act(async () => { await confirm.result.current.mutateAsync("value-1"); });
    expect(http.post).toHaveBeenCalledWith("/operating-bill-value-items/value-1/confirm");

    const assign = renderHook(() => useAssignOperatingBillProject("2026-08"), { wrapper: wrapper(client) });
    await act(async () => {
      await assign.result.current.mutateAsync({
        ai_request_id: "request-1", project_principal_id: "project-1", reason: null,
      });
    });
    expect(client.getQueryState(["operating-bill-projects", "2026-08", {}])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["operating-bill-employees", "2026-08", {}])?.isInvalidated).toBe(false);
  });

  it("补录期初余额后失效同月经营视图与首页", async () => {
    const client = queryClient();
    seedViews(client, "2026-08");
    client.setQueryData(["dashboard"], { monthlyApiCost: null });
    const hook = renderHook(() => useRecordOpeningBalance("2026-08"), {
      wrapper: wrapper(client),
    });
    const body = {
      provider_resource_id: "resource-1", amount: "100.00", currency: "CNY", reason: null,
    };
    await act(async () => { await hook.result.current.mutateAsync(body); });
    expect(http.post).toHaveBeenCalledWith("/operating-bills/2026-08/opening-balances", body);
    expect(client.getQueryState(["operating-bill", "2026-08"])?.isInvalidated).toBe(true);
    expectAccountInvalidation(client, "2026-08", true);
    expect(client.getQueryState(["dashboard"])?.isInvalidated).toBe(true);
  });

  it("确认充值写独立采购端点，并失效账单、首页与采购视图", async () => {
    const client = queryClient();
    seedViews(client, "2026-08");
    client.setQueryData(["dashboard"], { monthlyRechargeAmount: "0" });
    client.setQueryData(["resource-purchases", "2026-08"], { items: [] });
    const hook = renderHook(() => useRecordResourcePurchase("2026-08"), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await hook.result.current.mutateAsync({
        provider_resource_id: "resource-1", purchase_type: "API_RECHARGE",
        amount: "100.00", currency: "CNY", purchased_at: "2026-08-21T10:00:00+08:00",
        description: "DeepSeek 充值", evidence_ref: "operating_snapshot:snapshot-1",
      });
    });
    expect(http.post).toHaveBeenCalledWith("/provider-resources/resource-1/purchases", expect.objectContaining({
      purchase_type: "API_RECHARGE", amount: "100.00", currency: "CNY",
      purchased_at: "2026-08-21T10:00:00+08:00", description: "DeepSeek 充值",
      evidence_ref: "operating_snapshot:snapshot-1", idempotency_key: expect.any(String),
    }));
    expect(client.getQueryState(["operating-bill", "2026-08"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["dashboard"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["resource-purchases", "2026-08"])?.isInvalidated).toBe(true);
  });
});
