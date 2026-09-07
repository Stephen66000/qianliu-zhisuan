import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageOverviewPanel } from "./UsageOverviewPanel";

const getMock = vi.fn();
vi.mock("../../api/client", () => ({ get: (...args: unknown[]) => getMock(...args) }));
vi.mock("./UsageSubjectPicker", () => ({ UsageSubjectPicker: () => <div /> }));
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-06T17:00:00.000Z")); // Shanghai September 7, UTC September 6.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  getMock.mockReset().mockImplementation(async (path: string) => {
    const p = new URL(path, "https://test.invalid").searchParams;
    return { period: p.get("period"), anchor: p.get("anchor"), timezone: "Asia/Shanghai",
      metrics: { activeSubjects: 0, requestCount: "0", realTokens: "0", apiCost: "0", deductedQuota: "0" },
      trend: [], ranking: [], range: { from: p.get("anchor"), to: p.get("anchor") },
      generatedAt: new Date().toISOString(), detailQuery: { subjectType: "EMPLOYEE", settledOnly: true, from: "", toExclusive: "" } };
  });
});
afterEach(() => { client.clear(); vi.useRealTimers(); });
function show(entry: string) {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><UsageOverviewPanel /></MemoryRouter></QueryClientProvider>);
}
function lastQuery() { return new URL(getMock.mock.calls.at(-1)![0], "https://test.invalid").searchParams; }

describe("POOL20-053 explicit range refresh with real Query cache", () => {
  it("calendar selects that day; shortcuts return to Shanghai today and keep the selected subject", async () => {
    const user = userEvent.setup();
    show("/usage?period=MONTH&anchor=2026-08-12T04:00:00.000Z&subject_id=selected-employee");
    await screen.findByRole("button", { name: "今日" });
    fireEvent.change(screen.getByLabelText("用量锚点"), { target: { value: "2026-09-01" } });
    await waitFor(() => expect(lastQuery().get("anchor")).toBe("2026-09-01T04:00:00.000Z"));
    expect(lastQuery().get("period")).toBe("TODAY");
    await user.click(await screen.findByRole("button", { name: "今日" }));
    await waitFor(() => expect(lastQuery().get("anchor")).toBe("2026-09-07T04:00:00.000Z"));
    expect(lastQuery().get("subject_id")).toBe("selected-employee");
    expect(screen.getByLabelText("用量锚点")).toHaveValue("2026-09-07");
  });
  it("repeated shortcuts and returning to a cached period issue fresh requests within 15 seconds", async () => {
    const user = userEvent.setup();
    show("/usage?period=TODAY&anchor=2026-09-07T04:00:00.000Z");
    await screen.findByRole("button", { name: "今日" });
    for (const name of ["今日", "今日", "本周", "本月", "本周", "本周"]) {
      const before = getMock.mock.calls.length;
      await user.click(await screen.findByRole("button", { name }));
      await waitFor(() => expect(getMock).toHaveBeenCalledTimes(before + 1));
      expect(lastQuery().get("anchor")).toBe("2026-09-07T04:00:00.000Z");
    }
  });
});
