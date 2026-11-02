import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { FinalizeRejectedAttemptSettlementInput } from "./gateway-ledger-types.js";
import { finalizeRejectedAttemptSettlementAtomically } from "./gateway-ledger-terminal-rejection.js";

type Input = FinalizeRejectedAttemptSettlementInput;
function zeroRejection(mode: "API" | "CODING_PLAN" = "API"): Input {
  const request="51000000-0000-4000-8000-000000000001", enterprise="51000000-0000-4000-8000-000000000002";
  const attempt="51000000-0000-4000-8000-000000000003", resource="51000000-0000-4000-8000-000000000004";
  return {
    usage:{ai_request_id:request,enterprise_id:enterprise,upstream_attempt_id:attempt,provider_resource_id:resource,input_tokens:0n,output_tokens:0n,cache_tokens:0n,reasoning_tokens:0n,usage_quality:"UNKNOWN",upstream_usage_id:null,dedup_key:"pre-upstream-zero"},
    ledger_line:{ai_request_id:request,enterprise_id:enterprise,upstream_attempt_id:attempt,provider_resource_id:resource,principal_id:"51000000-0000-4000-8000-000000000005",resource_mode:mode,raw_input_tokens:0n,raw_output_tokens:0n,raw_cache_tokens:0n,raw_reasoning_tokens:0n,deducted_quota:null,api_cost:mode==="API"?"0.00000000":null,api_cost_currency:null,api_cost_status:mode==="API"?"CONFIRMED_ZERO_NO_UPSTREAM":"NOT_APPLICABLE",usage_quality:"UNKNOWN",billing_rule_id:null,rule_version:null,multiplier:null,billing_rule_snapshot:null},
    attempt_result:{http_status:403,response_committed:false,finished_at:new Date("2026-08-01T00:00:00Z"),error_classification:"DOWNSTREAM_AUTH_OR_QUOTA",error_code:"principal_quota_exhausted",switch_reason:null},
    error_classification:"DOWNSTREAM_AUTH_OR_QUOTA",error_code:"principal_quota_exhausted",
  };
}
const boundary = new Error("DATABASE_BOUNDARY_REACHED");
const unavailableDb = { transaction: () => { throw boundary; } } as unknown as Kysely<Database>;

describe("pre-upstream terminal fact contract before any database mutation", () => {
  it.each(["API", "CODING_PLAN"] as const)("accepts a complete %s no-consumption fact at the database boundary", async mode => {
    await expect(finalizeRejectedAttemptSettlementAtomically(unavailableDb, zeroRejection(mode))).rejects.toBe(boundary);
  });
  it("accepts omitted optional zero/nullable fields from legacy callers", async () => {
    const input=zeroRejection();
    input.usage.reasoning_tokens=undefined;input.usage.upstream_usage_id=undefined;
    input.ledger_line.raw_reasoning_tokens=undefined;input.ledger_line.deducted_quota=undefined;
    input.ledger_line.billing_rule_id=undefined;input.ledger_line.rule_version=undefined;
    input.ledger_line.multiplier=undefined;input.ledger_line.billing_rule_snapshot=undefined;
    await expect(finalizeRejectedAttemptSettlementAtomically(unavailableDb,input)).rejects.toBe(boundary);
    const plan=zeroRejection("CODING_PLAN");plan.ledger_line.api_cost=undefined;
    await expect(finalizeRejectedAttemptSettlementAtomically(unavailableDb,plan)).rejects.toBe(boundary);
  });
  const invalid: Array<[string,(input:Input)=>void]> = [
    ["upstream identity", i=>{i.usage.upstream_usage_id="claimed-upstream-id";}],
    ["zero is not a nullable Plan debit", i=>{i.ledger_line.deducted_quota=0n;}],
    ["positive Plan debit", i=>{i.ledger_line.deducted_quota=1n;}],
    ["billing rule reference", i=>{i.ledger_line.billing_rule_id="51000000-0000-4000-8000-000000000006";}],
    ["rule version", i=>{i.ledger_line.rule_version="v1";}],
    ["multiplier", i=>{i.ledger_line.multiplier="0.5";}],
    ["pricing snapshot", i=>{i.ledger_line.billing_rule_snapshot={schemaVersion:1};}],
    ["committed response", i=>{i.attempt_result.response_committed=true;}],
    ["switch reason", i=>{i.attempt_result.switch_reason="retry_next";}],
    ["classification identity", i=>{i.attempt_result.error_classification="UPSTREAM_ERROR";}],
    ["code identity", i=>{i.attempt_result.error_code="different_error";}],
    ["nonzero API charge", i=>{i.ledger_line.api_cost="0.01";}],
  ];
  it.each(invalid)("rejects invented %s with the stable fact-conflict identity before connecting", async (_label,mutate) => {
    const input=zeroRejection();mutate(input);
    await expect(finalizeRejectedAttemptSettlementAtomically(unavailableDb,input)).rejects.toThrow("terminal_rejection_fact_conflict");
  });
  it.each(["0", "0.01"])("Plan rejection does not accept an API amount %s", async amount => {
    const input=zeroRejection("CODING_PLAN");input.ledger_line.api_cost=amount;
    await expect(finalizeRejectedAttemptSettlementAtomically(unavailableDb,input)).rejects.toThrow("terminal_rejection_fact_conflict");
  });
});
