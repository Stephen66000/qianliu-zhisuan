# Gateway employee monthly quota implementation evidence

Scope: `apps/gateway/**` only. No production migration, deployment, historical write, resend, commit or push was performed by this work package.

## Behavior

- API and Coding Plan attempt preparation call `EmployeeQuotaRepository.reserveEmployeeQuota`; monthly mode freezes period/usage/basis. Legacy API retains no internal quota settlement; legacy Coding Plan/PROJECT retain the existing `reserveQuota` path.
- Coding Plan concurrency leases remain Coding Plan only. Monthly API exhaustion uses the employee quota period end, not a provider Coding Plan reset window.
- Monthly Coding Plan estimate and actual use the same pre-reservation frozen billing rule and pricing time. API actual uses persisted raw input + output; cache is not added twice. API financial `deducted_quota` remains null.
- `persistAttemptUsageAccountingIfAbsent` atomically writes measured monthly attempt evidence, quota actual and reservation release, plus Coding Plan lease release. A failed consumed attempt is accounted before failover. Final publication carries the same original monthly references and is idempotent.
- Pre-upstream dispatch rejection, grant/key revocation and attempt creation failure release the original reservation. Unknown upstream usage retains UNKNOWN and the conservative reservation.
- Attempt reservation uses the injected clock independently per attempt. Old-month completion settles the old period, and a new-month failover attempt reserves the new month.

## Checks

- `unit.log`: 31 tests passed across attempt usage settlement, revoked attempt mutation, and dispatch guard evidence.
- `integration-final.log`: 32 tests passed: monthly 15, legacy quota-dispatch boundaries 11, existing Coding Plan quota-window 6. Real isolated PostgreSQL 17 image pinned to repository digest; Vitest maxWorkers=1.
- `monthly-integration-final.log`: final monthly suite 17/17 passed, adding underestimated actual overage / next-request blocking for API and Coding Plan. The final distinct PG coverage is 34 tests (17 monthly + 11 legacy + 6 CP-window).
- Monthly suite includes API 1200 / Coding Plan 600 at 0.5, frozen multiplier change, allowOverage on/off, upstream-before rejection zero consumption, consumed failures, unknown conservative hold, revoke after bind, Key raw quota vs Coding Plan quota, PROJECT legacy, API no CP lease, cross-month failover, duplicate HTTP idempotency, and real transaction fault injection using a PostgreSQL trigger. Trigger failure asserts no usage_event/ledger_line partial commit while reservation remains conservative.
- `typecheck.log`: passed (`tsc -p tsconfig.json --noEmit`).
- `lint.log`: passed (`eslint src --max-warnings=0`), without suppression.
- `git diff --check -- apps/gateway`: passed.

Earlier `integration.log` records a fixture defect (legacy model grant instead of monthly provider-pool grant) and original HTTP idempotency behavior (409, no repeated call). `monthly-integration.log` records the successful corrected intermediate 12-test suite. These intermediate logs are retained as evidence; final results are listed above.

## Boundary

These are engineering checks in isolated local PostgreSQL. Production rollout, real month-boundary acceptance, account activation date, historical reconciliation/write and real report delivery remain outside this work package. Existing unknown API billing deductions and allow_overage were not backfilled or changed.
