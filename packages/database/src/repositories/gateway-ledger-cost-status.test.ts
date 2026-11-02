import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { CreateLedgerTransactionInput, LedgerLine } from "./gateway-ledger-types.js";
import { resolveTransactionCostStatus } from "./gateway-ledger-settlement.js";

type CostFact = Pick<LedgerLine, "resource_mode" | "api_cost_status">;
const api = (api_cost_status: CostFact["api_cost_status"]): CostFact => ({ resource_mode: "API", api_cost_status });
const plan = (api_cost_status: CostFact["api_cost_status"] = "NOT_APPLICABLE"): CostFact => ({ resource_mode: "CODING_PLAN", api_cost_status });
const scope: CreateLedgerTransactionInput = {
  enterprise_id: "tenant", principal_id: "employee", ai_request_id: "request",
  total_input_tokens: 100n, total_output_tokens: 20n, total_cache_tokens: 0n,
  total_deducted_quota: 0n, total_api_cost: null, usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
};
function frozenDb(facts: CostFact[]): Kysely<Database> {
  const query = { select: () => query, where: () => query, execute: async () => facts };
  return { selectFrom: () => query } as unknown as Kysely<Database>;
}

describe("frozen transaction monetary-status precedence", () => {
  it.each([
    ["historical migration gap dominates even known/unknown peers", [api("PRICED_USAGE"), api("NOT_MIGRATED"), api("UNKNOWN_COST")], null, "NOT_MIGRATED"],
    ["unknown API attempt keeps a mixed request unknown", [api("PRICED_USAGE"), plan(), api("UNKNOWN_COST")], null, "UNKNOWN_COST"],
    ["all modern Plan facts are not API charges", [plan(), plan()], null, "NOT_APPLICABLE"],
    ["legacy Plan mode is not turned into an API charge", [plan(null), plan()], null, "NOT_APPLICABLE"],
    ["Plan plus priced API preserves API classification", [plan(), api("PRICED_USAGE")], "0.25", "PRICED_USAGE"],
    ["one Plan cannot hide a legacy API charge", [plan(), api(null)], "0.25", "PRICED_USAGE"],
    ["confirmed no-upstream zero is retained alongside Plan", [plan(), api("CONFIRMED_ZERO_NO_UPSTREAM")], "0", "CONFIRMED_ZERO_NO_UPSTREAM"],
    ["no lines plus unknown amount is not an empty Plan", [], null, "UNKNOWN_COST"],
    ["legacy known-zero aggregate is kept explicit", [api(null)], "0", "CONFIRMED_ZERO_NO_UPSTREAM"],
    ["a reported zero-price API remains priced usage, not a no-upstream claim", [api("PRICED_USAGE")], "0", "PRICED_USAGE"],
    ["a zero-price API plus Plan remains priced usage", [plan(), api("PRICED_USAGE")], "0", "PRICED_USAGE"],
    ["legacy unpriced API remains unknown", [api(null)], null, "UNKNOWN_COST"],
    ["legacy positive aggregate is a priced amount", [api(null)], "0.5", "PRICED_USAGE"],
  ] as Array<[string, CostFact[], string | null, string]>)('%s', async (_description, facts, amount, expected) => {
    expect(await resolveTransactionCostStatus(frozenDb(facts), { ...scope, total_api_cost: amount })).toBe(expected);
    expect(await resolveTransactionCostStatus(frozenDb([...facts].reverse()), { ...scope, total_api_cost: amount })).toBe(expected);
  });
});
