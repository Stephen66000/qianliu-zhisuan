export default {
  "test": {
    "environment": "node",
    "include": [
      "packages/database/src/__tests-integration__/pool043-operating-bill-accounts.integration.test.ts",
      "packages/database/src/__tests-integration__/operating-analysis.integration.test.ts",
      "packages/database/src/__tests-integration__/provider-finance-repository.integration.test.ts",
      "apps/control-api/src/__tests-integration__/pool043-operating-bill-accounts.test.ts",
      "apps/control-api/src/__tests-integration__/w20-department-costs.test.ts"
    ],
    "fileParallelism": false,
    "testTimeout": 60000,
    "hookTimeout": 120000,
    "coverage": {
      "provider": "v8",
      "reporter": [
        "text",
        "json",
        "json-summary"
      ],
      "reportsDirectory": "/Users/mac/.codex/worktrees/operating-bill-0906/\u4edf\u6d41\u667a\u7b97/V4/Evidence/OPERATING-BILL-20260906/V14/backend-coverage",
      "include": [
        "apps/control-api/src/department-costs/routes.ts",
        "apps/control-api/src/operating-bills/analysis-route.ts",
        "apps/control-api/src/operating-bills/routes.ts",
        "apps/control-api/src/principals/accounting-route.ts",
        "apps/control-api/src/principals/routes.ts",
        "packages/database/src/repositories/operating-analysis-repository.ts",
        "packages/database/src/repositories/operating-analysis-usage.ts",
        "packages/database/src/repositories/operating-bill-account-frozen.ts",
        "packages/database/src/repositories/operating-bill-account-live.ts",
        "packages/database/src/repositories/operating-bill-account-month-lines.ts",
        "packages/database/src/repositories/operating-bill-finance-projection.ts",
        "packages/database/src/repositories/operating-bill-project-metadata.ts",
        "packages/database/src/repositories/operating-department-accounts.ts",
        "packages/database/src/repositories/principal-accounting.ts",
        "packages/database/src/repositories/principal-cleanup-preview.ts",
        "packages/database/src/repositories/principal-department-query.ts",
        "packages/database/src/repositories/principal-repository.ts",
        "packages/database/src/repositories/provider-finance-month-opening.ts",
        "packages/database/src/repositories/provider-finance-repository.ts",
        "packages/database/src/repositories/request-attribution-writer.ts"
      ],
      "thresholds": {
        "statements": 95,
        "branches": 85,
        "functions": 90,
        "lines": 95
      }
    }
  }
};
