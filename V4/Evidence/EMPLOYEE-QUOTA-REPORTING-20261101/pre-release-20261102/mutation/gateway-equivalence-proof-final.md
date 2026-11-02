# Gateway043 two-survivor equivalence review

Current report: `apps/gateway/reports/mutation/pool043.json`, generated 2026-11-02 13:39 after the approved API final-authorization pricing correction. The actual run used 52 tests and all retained/expanded mutation targets. It records 89 Killed, 2 Survived and 1 NoCoverage (96.74%). This document does not register a disposition or change thresholds.

## Mutant 46: overwritten initial quality value

`pipeline-attempt-execution.ts:60`: `let persistedQuality = "UNKNOWN"` → empty string.

Before its first possible read, the function awaits `persistAttemptUsageEvidence`, passing a nonoptional callback which unconditionally assigns `persistedRaw` and `persistedQuality`. Both normal returns of the evidence helper (monthly atomic accounting or legacy ledger persistence) execute this same callback after persistence and before returning. If persistence, conversion or callback setup throws, the await rejects and execution exits before `recordAttemptQuotaSettlement` reads the variable. Consequently the initial value is never observable on any returning execution path. It is a strict dead-store mutation under the fixed evidence-helper contract, not a missing test for legitimate unknown usage. Real UNKNOWN consumption remains covered by API and Coding Plan PG cases.

## Mutant 61: always-true resource configuration guard

`pipeline-attempt-execution.ts:93`: `if (resourceConfig)` → `if (true)`.

Admissible execution domain: the private pipeline context and state built by `createRealPipeline` → `preparePipelineContext` → `createExecutionState` → `runPipelineAttempts`. This is not claimed for a caller fabricating an arbitrary internal PipelineContext.

1. Admission builds `candidateByInvocationKey` from every `imageCompatibleCandidate`.
2. It forms `runtimeAllowedCandidates` exclusively by filtering that same set, and forms eligible inputs by copying the same resourceId/providerCode/upstreamModel identity fields.
3. Initial state takes `context.eligible`; scoring preserves each input. Dispatch switching and forced rechecks select an existing item from `state.lastScored`, and revoked-route handling only filters the existing set. No production path appends a candidate from outside admission's map or clears the map.
4. Preparation looks up `resourceConfig` with the identical `invocationCandidateKey` identity fields. An admitted winner therefore always has a defined mapped row. A database configuration change cannot remove an existing in-memory map entry; the separate final authorization gate handles revocation before invoking upstream.

Thus this predicate is true on every admitted READY attempt. Original and mutated code append exactly the same deferred resource effect, with identical resource/probe/version data. The opposite mutation, removing the resource effect, is now killed by the existing real CP-window block/EXHAUSTED regression. No guard was removed in production to improve score.

The source dependency hashes are recorded in `gateway-equivalence-source-hashes.json`. Re-review if context assembly, candidate identity, selection/switch behavior, map mutation, or evidence callback control flow changes. This is a structural invariant proof for the actual internal runtime, not a blanket waiver for malformed synthetic contexts.

## Existing one NoCoverage entry

The report retains current-model-authorization mutant 15 (allowed-model fallback array) as a separate NoCoverage entry. It is not hidden or called killed. Root must retain/review its existing disposition rather than treating these two proofs as an allowance for unrelated uncovered mutants.
