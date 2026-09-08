import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ADMINS_QUERY_KEY, useCleanupAdmin } from "./admins";

const http = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));
vi.mock("./client", () => http);

function wrapper(client: QueryClient) {
  return function Provider({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe("管理员 API hooks", () => {
  beforeEach(() => http.del.mockReset().mockResolvedValue(undefined));

  it("清理管理员使用 DELETE 并失效管理员列表", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(ADMINS_QUERY_KEY, {
      admins: [{ id: "admin-disabled" }],
    });
    const hook = renderHook(() => useCleanupAdmin(), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await hook.result.current.mutateAsync({ id: "admin-disabled" });
    });
    expect(http.del).toHaveBeenCalledWith("/admins/admin-disabled");
    expect(client.getQueryState(ADMINS_QUERY_KEY)?.isInvalidated).toBe(true);
  });
});
