import { describe, expect, it } from "vitest";
import { nextSubscriptionEnd } from "./subscription-renewal-calendar.js";
const d = (s: string) => new Date(`${s}T00:00:00+08:00`);
describe("subscription calendar anchors", () => {
  it.each([
    ["2026-01-31", "2026-02-28", "2026-02-28", "2026-03-31"],
    ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"],
    ["2024-01-31", "2024-02-29", "2024-02-29", "2024-03-31"],
    ["2024-02-29", "2025-02-28", "2027-02-28", "2028-02-29"],
    ["2026-06-26", "2026-09-26", "2026-09-26", "2026-12-26"],
    ["2026-09-01", "2026-09-08", "2026-09-08", "2026-09-15"],
  ])("%s to %s renews from %s to %s", (start,end,next,expected) => {
    expect(nextSubscriptionEnd(d(start),d(end),d(next))).toEqual(d(expected));
  });
  it("rejects zero-length cycles", () => expect(() => nextSubscriptionEnd(d("2026-09-01"),d("2026-09-01"),d("2026-09-01"))).toThrow());
});
