import { describe, expect, it } from "vitest";
import { normalizeDraftItem, projectActivationCandidate, type ActivationProjectionInput } from "../index.js";

const RESOURCE = "11111111-1111-4111-8111-111111111111";
const CUTOVER = "2026-08-31T16:00:00.000Z";
const SNAPSHOT = "2026-10-15T00:00:00.000Z";

function input(): ActivationProjectionInput {
  return {
    enterpriseId: "77777777-7777-4777-8777-777777777777", snapshotAt: SNAPSHOT,
    resources: [{ resourceId: RESOURCE, mode: "API", providerId: "provider", providerCode: "api",
      providerName: "合成厂商", resourceName: "合成API资源", status: "ACTIVE",
      hasPostCutoverLedgerLine: false, hasCrossingSnapshot: false, hasPostCutoverPurchase: false }],
    accounts: [{ resourceId: RESOURCE, currency: "CNY", sources: ["ADMIN_DECLARED"] }],
    financeEvents: [], periods: [], legacyPurchases: [], ledgerLines: [], usageEvents: [], accountComponents: [],
    monthlyGaps: [{ month: "2026-09", gaps: [] }, { month: "2026-10", gaps: [] }],
    strictWritesEnabled: false, usageRepairBaseline: [], usageRepairTargets: [],
    draft: normalizeDraftItem({ schema_version: "1", api_opening_balances: [{ resource_id: RESOURCE,
      account_currency: "CNY", account_amount: "100", occurred_at: CUTOVER,
      description: "合成期初", evidence_ref: "evidence://synthetic/opening", source_record_id: null }],
    historical_api_recharges: [], historical_api_costs: [], coding_plan_purchases: [], coding_plan_carryovers: [],
    legacy_purchase_resolutions: [] }, RESOURCE),
  };
}

function historicalCost(costAmount: string, occurredAt: string): ActivationProjectionInput {
  const fixture = input();
  // The public projection must fail closed even if a persisted normalized candidate is malformed.
  fixture.draft.historicalApiCosts = [{ resourceId: RESOURCE, accountCurrency: "CNY", costAmount,
    accountAmount: String(-Number(costAmount)), occurredAt, description: "合成历史API消耗",
    evidenceRef: "evidence://synthetic/cost", recordIdempotencyKey: "synthetic-historical-cost" }];
  return fixture;
}

describe("pre-release historical API cost activation contract", () => {
  it.each([CUTOVER, SNAPSHOT, "2026-09-15T00:00:00.000Z"])("accepts a positive cost at an inclusive verified boundary: %s", (at) => {
    const result = projectActivationCandidate(historicalCost("1", at));
    expect(result.decision).toBe("GO_CANDIDATE");
    expect(result.gaps).toEqual([]);
  });

  it.each(["0", "-1"])("rejects a nonpositive persisted cost instead of creating a credit: %s", (amount) => {
    const result = projectActivationCandidate(historicalCost(amount, "2026-09-15T00:00:00.000Z"));
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "HISTORICAL_COST_AMOUNT_INVALID",
      category: "USAGE", resourceId: RESOURCE, accountCurrency: "CNY", detail: amount }));
  });

  it.each(["2026-08-31T15:59:59.999Z", "2026-10-15T00:00:00.001Z"])("rejects cost outside the proven cutover/snapshot window: %s", (at) => {
    const result = projectActivationCandidate(historicalCost("1", at));
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "HISTORICAL_COST_TIME_INVALID",
      category: "USAGE", resourceId: RESOURCE, accountCurrency: "CNY", detail: at }));
  });

  it("cannot post an API historical cost against a Coding Plan resource", () => {
    const fixture = historicalCost("1", "2026-09-15T00:00:00.000Z");
    fixture.resources[0]!.mode = "CODING_PLAN";
    const result = projectActivationCandidate(fixture);
    expect(result.decision).toBe("NO_GO");
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "RESOURCE_MODE_MISMATCH",
      category: "USAGE", resourceId: RESOURCE, accountCurrency: "CNY" }));
  });
});
