import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { UnauthorizedError } from "./client";
import type * as ClientModule from "./client";
import { AUTH_QUERY_KEY, useAdminSession } from "./auth";
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("./client", async importOriginal => ({ ...await importOriginal<typeof ClientModule>(), ...http }));
describe("F01 会话失效", () => {
  it("后台检查收到401后清除旧会话数据，不再把失效账号视为已登录", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(AUTH_QUERY_KEY, { admin: { username: "old-admin" } });
    http.get.mockRejectedValue(new UnauthorizedError(null));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => { const session = useAdminSession(); return { data: session.data, refetch: session.refetch }; }, { wrapper });
    await act(async () => { await hook.result.current.refetch(); });
    expect(client.getQueryData(AUTH_QUERY_KEY)).toBeNull();
    await waitFor(() => expect(hook.result.current.data).toBeNull());
    hook.unmount(); client.clear();
  });
});
