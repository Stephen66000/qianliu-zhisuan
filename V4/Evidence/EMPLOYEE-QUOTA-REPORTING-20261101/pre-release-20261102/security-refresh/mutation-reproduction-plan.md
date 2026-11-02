# Canonical mutation reproduction and CI scheduling

No repository script, CI timeout, test timeout, threshold or target is changed by this proposal.

## Resource report is session-independent

Required candidate test files:

- `stryker.resource-pool.config.json` (new, presently untracked because no commit/stage was authorized)
- `vitest.resource-pool.mutation.config.ts` (new, same status)
- Existing `apps/gateway/src/__tests-integration__/w11-resource-pool.test.ts`, including the explicit default 11-minute lease boundary/fencing case.

From the repository root, canonical local command:

```sh
PATH="/Users/mac/Projects/仟流智算/.local-runtime/node-v22.23.4-darwin-arm64/bin:$PATH" corepack pnpm@11.11.0 exec stryker run stryker.resource-pool.config.json --concurrency 1
```

The config writes `packages/database/reports/mutation/pool039043-resource.json`; no custom driver is required. Core9.6.1 `process/1-prepare-executor.js` always appends the built-in reporter plugin URL, whose reporters/index.js declares progress-append-only. Only Vitest is an additional configured plugin. This agent did not set NODE_OPTIONS (read-only environment check found it unset). CI must use its installed Linux Node22.23.4 rather than the macOS binary path; pin/verify the same version/ICU/tz and lock before execution.

## Minimal root-script gap closure

The existing root quality:mutation expands to 11 generating configurations. Its disposition gate additionally consumes three reports which that command does not generate. Add these unchanged canonical configurations before the final gate:

```sh
corepack pnpm@11.11.0 --dir apps/gateway exec stryker run stryker.pool040.config.json --concurrency 1
corepack pnpm@11.11.0 --dir packages/database exec stryker run stryker.pool039043-integration.config.json --concurrency 1
corepack pnpm@11.11.0 exec stryker run stryker.resource-pool.config.json --concurrency 1
```

That gives 14 configuration runs refreshing every report read by the current 9-report disposition gate. For the explicitly requested complete 16-business-report acceptance also execute:

```sh
corepack pnpm@11.11.0 --dir packages/domain exec stryker run stryker.provider-finance.json --concurrency 1
corepack pnpm@11.11.0 --dir packages/provider-adapters exec stryker run stryker.pool048.config.json --concurrency 1
```

Extra reports retain their original Stryker thresholds; adding them does not impose a new global zero-debt policy. Fail a generator or missing/not-refreshed native report before running disposition. Do not accept an old untracked report left by a prior run. Preserve raw failure logs; no source denominator or mutant scope is removed.

## CI budget is orchestration, not a business timeout

The existing single quality job is 40 minutes, while observed local execution already includes DB043 full47m15s, integration33m04s, Gateway0439m03s, plus the preserved three real 300-second provider cases (~15m) and coverage/full regression. A 40-minute budget cannot represent the same full evidence chain.

Minimal option: raise only the CI job orchestration budget to 240 minutes and keep the sequential canonical command set. More maintainable option: split stable CPU mutation, DB043, DBintegration, Gateway PG, coverage and functional/capacity jobs with isolated runners; each PG scope still workers/concurrency1 and all original test/score/time thresholds retained. Run capacity only in an isolated load window. The final aggregation job requires all fresh artifacts for the same source/lock/runtime and then runs the unchanged disposition semantics. Do not trigger hosted CI or incur new paid runner usage without the existing user authorization boundary.

## Diagnostic-only files, not release/business cases

The following agent-created reproduction fixtures/configs are not canonical business suite generators and must not be auto-discovered as required mutation jobs or counted as business acceptance:

- `packages/database/mutation-fixtures/source-resolution.case.ts`
- `packages/database/mutation-pg-observer.setup.ts`
- `packages/database/stryker.resolution-probe.config.json`
- `packages/database/stryker.pg-resolution-probe.config.json`
- `packages/database/stryker.pg-mixed-probe.config.json`
- `packages/database/stryker.pg-full-probe.config.json`
- `packages/database/stryker.pg-coverage-scan.config.json`
- `packages/database/vitest.resolution-probe.mutation.config.ts`
- `packages/database/vitest.pg-resolution-probe.mutation.config.ts`
- `packages/database/vitest.pg-mixed-probe.mutation.config.ts`
- `packages/database/vitest.pg-full-probe.mutation.config.ts`

Their raw logs/reports remain evidence. The fixture is outside src and lacks the *.test.ts suffix, so normal DB business collection excludes it; the isolated probe config explicitly collects its one diagnostic test. The ordinary business count decreases by one diagnostic PASS, not by adding a skip. No user file is deleted or moved by this proposal.
