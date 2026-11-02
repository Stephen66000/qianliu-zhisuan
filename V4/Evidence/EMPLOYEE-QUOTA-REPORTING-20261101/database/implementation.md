# Database / domain implementation evidence

Scope: local source implementation only. No production migration, deployment, historical deduction, resend, commit or push was executed by this agent. User pre-existing deletion and unrelated untracked files were left intact. The read-only account usage check returned `ordinaryUsageAllowed=true` before implementation.

## Implemented contracts

- Additive migration `0092_employee_monthly_quota.js` follows the observed `0091` head. It adds nullable activation/basis fields, two monthly accounting tables, tenant-scoped foreign keys and per-request/Attempt uniqueness. `down` deliberately preserves all new facts/schema; `up` is idempotent for rollback/reapplication.
- Enterprise-local natural months and bigint balance functions are exported from domain. Period timezone/basis remain frozen. A timezone edit reuses the already-open enterprise month.
- `EmployeeQuotaRepository.reserveEmployeeQuota` returns `LEGACY` without monthly writes before activation and for project principals. Monthly API/Plan estimates are supplied in their final basis; the repository does not multiply them again. Request locking and one usage per request/Attempt prevent duplicate reservations. The original period survives cross-month retries.
- `bindEmployeeQuotaAttempt` verifies enterprise, request and Attempt number before persisting the upstream Attempt association.
- `settleEmployeeQuotaInTransaction` and `settleMonthlyQuotaItems` release reservations and persist actual values once, including failure consumption. Unknown usage retains its conservative reservation. The existing ledger terminal/rejection/per-Attempt accounting transactions call this branch; legacy counters remain separate.
- `ensureCurrentQuotaPeriod` and `adjustEmployeeQuotaPeriod` accept an existing transaction. The adjustment reads the updated grant template, preserves used/reserved values and returns typed before/after snapshots for the caller's operation log. Grant-before-period lock order matches reserve. The Control API integration and audit write are root-owned.
- `readQuotaPeriodsInTransaction` is read-only and supports a business cutoff. Consumption is selected by original reservation time, with settlement knowledge at fact-read time. Policy after cutoff is restored only from typed `principal_quota.change` before snapshots; missing proof is UNKNOWN. Both limit and overage policy are preserved in the period and its snapshot.
- `initializeCurrentQuotaPeriods` and the same request/query initializer create one current account per active employee/provider; old months are never initialized from today's authorization.
- Current Dashboard employee overages read the active monthly account, while project and pre-activation scopes retain legacy counters. Directory activation derives basis from frozen assignment resource modes, rejects ambiguous monthly pools, and initializes the monthly account in the existing transaction.
- `previewEmployeeQuotaReconciliation` requires explicit enterprise, nonempty employee range and period. It returns source ledger facts and current authorization/counter evidence with a deterministic hash, labeling historical grant attribution as UNKNOWN. It does not infer historic allocation from today's grants and has no apply/write branch.
- `UsageOverviewRepository.getOverviewSnapshot` is public for an existing repeatable-read report transaction; `ReportSnapshot.facts` accepts provenance metadata without changing delivery identity.
- Legacy `GrantRepository.create` explicitly rejects employee model-level grant creation once a monthly activation is configured, directing callers to provider-pool configuration. Projects/legacy enterprises retain their existing path.

## Validation

- Domain natural-month tests: 6 passed (Shanghai month boundary, year boundary, leap month, New York DST month, balance/overage).
- Isolated PostgreSQL integration: 19 passed across monthly-accounting (13) and directory activation (6) (legacy/future/project preservation, concurrent idempotence, cross-month settlement, overage allow/deny, UNKNOWN/release/replay, raw vs Plan basis, SET preservation, transaction rollback and enterprise isolation, disable/reactivate, read-only preview, data-preserving rollback, audited historical policy, timezone edits).
- Targeted lint: passed. Domain typecheck: passed.
- Database typecheck: passed after coordinated management/read-model integration.
- Gateway agent independently reported 32 passing real PostgreSQL pipeline/legacy/window tests using the monthly settlement integration, including transaction fault injection and revoked/failover handling. Its logs remain under the gateway evidence directory.

## Boundaries

Historical preview does not claim historical balances or grant versions have been recovered. No historical apply implementation or production backfill is included. Deployment, future activation, production route/basis preflight, actual first month boundary and natural report receipt remain separate authorized acceptance steps.

## Source size

The monthly implementation is split into a public facade (314 physical lines), period (217), read (126), settlement (136) and reconciliation (120). Directory published-rule inheritance is extracted into its own cohesive module. No size exception was added. The repository-wide source-size command still reports pre-existing oversized modules (recorded in source-size.log); usage-overview has only a private-to-public method visibility change and no line-count increase.
