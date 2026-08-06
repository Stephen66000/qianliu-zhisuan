import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCreateEmployeeModelRule,
  useCreateEmployeeModelRuleVersion,
  useDisableEmployeeModelRule,
  useEmployeeModelRules,
  useEmployeeRuleCatalog,
  usePublishEmployeeModelRule,
  useUpdateEmployeeModelRule,
  useValidateEmployeeModelRule,
  type EmployeeModelRulePayload,
} from "./employee-model-rules";

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("./client", () => client);

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>;
}

const payload: EmployeeModelRulePayload = {
  name: "规则", employee_scope: "SELECTED", principal_ids: ["p1"], model_scope: "SELECTED",
  model_targets: [{ unified_model_id: "m1", provider_resource_id: "r1" }], quota_value: "100",
  allow_overage: false, valid_from: "2026-08-01T00:00:00Z", valid_until: null,
};

describe("员工使用规则 API hooks", () => {
  beforeEach(() => {
    client.get.mockReset().mockResolvedValue({ principals: [], models: [], rules: [] });
    client.post.mockReset().mockResolvedValue({});
    client.patch.mockReset().mockResolvedValue({});
  });

  it("查询目录与规则列表使用固定查询键", async () => {
    const catalog = renderHook(() => useEmployeeRuleCatalog(), { wrapper });
    const rules = renderHook(() => useEmployeeModelRules(), { wrapper });
    await waitFor(() => expect(catalog.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(rules.result.current.isSuccess).toBe(true));
    expect(client.get).toHaveBeenCalledWith("/employee-model-rules/catalog", expect.any(AbortSignal));
    expect(client.get).toHaveBeenCalledWith("/employee-model-rules", expect.any(AbortSignal));
  });

  it("六类写操作映射正确请求并在成功后失效缓存", async () => {
    const hooks = renderHook(() => ({
      create: useCreateEmployeeModelRule(), update: useUpdateEmployeeModelRule(),
      validate: useValidateEmployeeModelRule(), publish: usePublishEmployeeModelRule(),
      disable: useDisableEmployeeModelRule(), next: useCreateEmployeeModelRuleVersion(),
    }), { wrapper });
    await act(async () => {
      await hooks.result.current.create.mutateAsync(payload);
      await hooks.result.current.update.mutateAsync({ versionId: "v1", expectedLockVersion: 2, rule: payload });
      await hooks.result.current.validate.mutateAsync("v1");
      await hooks.result.current.publish.mutateAsync({ versionId: "v1", expectedLockVersion: 3, idempotencyKey: "idem-0001", quotaMode: "ADD" });
      await hooks.result.current.disable.mutateAsync("v1");
      await hooks.result.current.next.mutateAsync("rule1");
    });
    expect(client.post).toHaveBeenCalledWith("/employee-model-rules", payload);
    expect(client.patch).toHaveBeenCalledWith("/employee-model-rules/versions/v1", {
      expected_lock_version: 2, rule: payload,
    });
    expect(client.post).toHaveBeenCalledWith("/employee-model-rules/versions/v1/validate");
    expect(client.post).toHaveBeenCalledWith("/employee-model-rules/versions/v1/publish", {
      expected_lock_version: 3, idempotency_key: "idem-0001", quota_mode: "ADD",
    });
    expect(client.post).toHaveBeenCalledWith("/employee-model-rules/versions/v1/disable");
    expect(client.post).toHaveBeenCalledWith("/employee-model-rules/rule1/versions");
  });
});
