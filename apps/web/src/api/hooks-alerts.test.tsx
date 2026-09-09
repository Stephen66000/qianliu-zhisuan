import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { useAlerts } from "./hooks";
const get = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ get, post: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  get.mockReset();
});
function clientWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0 } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return { client, wrapper: Wrapper };
}
it("polls real query observers every 30 seconds only in the foreground, then stops on unmount", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  get.mockResolvedValue({ alerts: [], history: [] });
  const { client, wrapper } = clientWrapper(),
    hook = renderHook(() => useAlerts(true), { wrapper });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(get).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenLastCalledWith(
    "/alerts?history=true",
    expect.any(AbortSignal),
  );
  focusManager.setFocused(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(get).toHaveBeenCalledTimes(2);
  hook.unmount();
  client.clear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(get).toHaveBeenCalledTimes(2);
});
it("aborts an in-flight history request when its observer is removed", async () => {
  get.mockImplementation(() => new Promise(() => {}));
  const { client, wrapper } = clientWrapper(),
    hook = renderHook(() => useAlerts(), { wrapper });
  const signal = get.mock.calls[0]![1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  hook.unmount();
  expect(signal.aborted).toBe(true);
  client.clear();
});
