import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessContext } from "../../permissions";
import { CredentialProbeAction } from "./CredentialProbeAction";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../api/client", () => mocks);
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue({ probes: [] }); });
function view(roleCode: "SUPER_ADMIN" | "CUSTOM" = "SUPER_ADMIN") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AccessContext.Provider value={{ roleCode }}>
    <CredentialProbeAction resourceId="resource-test" isolated />
  </AccessContext.Provider></QueryClientProvider>);
}
describe("credential probe action", () => {
  it("I1: a previous recovery must not claim the newly isolated resource is available", async () => {
    mocks.get.mockResolvedValue({ probes: [{ id: "old", status: "RECOVERED", upstreamModel: "k3-256k",
      credentialVersion: 1, httpStatus: 200, startedAt: "2026-09-09T01:00:00Z", retryAt: "2026-09-09T01:05:00Z" }] });
    view();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("历史验证通过；当前资源已再次隔离"));
    expect(screen.getByRole("status")).not.toHaveTextContent("已解除隔离");
  });
  it("requires quota consent and displays failed verification without claiming recovery", async () => {
    mocks.post.mockResolvedValue({ probe: { id: "p", status: "FAILED", upstreamModel: "k3-256k",
      credentialVersion: 1, httpStatus: 401, startedAt: "2026-09-10T01:00:00Z", retryAt: "2026-09-10T01:05:00Z" } });
    view();
    expect(screen.getByRole("button", { name: "验证当前凭证并恢复" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "验证当前凭证并恢复" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("验证失败，保持隔离"));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]?.[1]).toMatchObject({ confirm_quota_consumption: true });
  });
  it("view-only roles cannot invoke recovery", () => {
    view("CUSTOM");
    expect(screen.queryByRole("button", { name: "验证当前凭证并恢复" })).not.toBeInTheDocument();
  });
});
