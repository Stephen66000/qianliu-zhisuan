/**
 * WP05 页面证据用「静态托管 + 桩 API」服务器（仅本地取证，不是产品代码）。
 *
 * 目的：在没有可部署后端的情况下，让 `apps/web/dist` 的真实构建产物在浏览器里
 * 渲染出 WP05 的四个关键界面状态，并据此截图作为页面证据。
 *
 * 说明：
 *  - 只服务本仓库自己的 `vite build` 产物；不连接任何真实服务、不写任何数据。
 *  - 场景由 `scenario.json` 驱动（每次请求即时读取），便于在一次会话内切换状态。
 *  - `/api/*` 一律返回桩数据，异常路径也记录到 stdout 以便排查。
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const DIST = process.argv[2];
const PORT = Number(process.argv[3] ?? 4180);
const SCENARIO_FILE = join(import.meta.dirname, "scenario.json");
const RESOURCE_API = "22222222-2222-4222-8222-222222222222";
const RESOURCE_PLAN = "33333333-3333-4333-8333-333333333333";
const PROVIDER = "11111111-1111-4111-8111-111111111111";
const CUTOVER = "2026-08-31T16:00:00.000Z";
const CANDIDATE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CANDIDATE_HASH = "f1c9a0f2e5b7d4a8c0e6f2b4d8a0c2e4f6b8d0a2c4e6f8b0d2a4c6e8f0b2d4a6";
const WATERMARK = "9b7d5f3a1c8e6b4d2f0a9c7e5b3d1f8a6c4e2b0d9f7a5c3e1b8d6f4a2c0e9b7d";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2",
};

async function scenario() {
  try {
    return JSON.parse(await readFile(SCENARIO_FILE, "utf8"));
  } catch {
    return { state: "unactivated", preview: "none" };
  }
}

function resources() {
  const base = {
    provider_id: PROVIDER, credential_type: "SUBSCRIPTION_SESSION",
    credential_fingerprint: "1234567890abcdef", credential_version: 1, status: "ACTIVE",
    consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
    credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
    credential_expires_at: null, resource_pool_id: null, upstream_models: [],
    version: 1, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
    operating_snapshot: null,
  };
  return [
    { ...base, id: RESOURCE_API, name: "Kimi API 主账号", mode: "API", concurrency_limit: 20,
      credential_type: "API_KEY", upstream_models: ["kimi-k2"] },
    { ...base, id: RESOURCE_PLAN, name: "Kimi 套餐", mode: "CODING_PLAN", concurrency_limit: 10 },
  ];
}

const QUIESCENCE = {
  status: "ACTIVE", active: true, started_at: "2026-09-22T02:55:00.000Z",
  expires_at: "2026-09-22T03:25:00.000Z", released_at: null, release_reason: null,
  remaining_seconds: 1_320, insufficient_for_activation: false,
  drain: {
    in_progress_requests: 0, open_attempts: 0, unpaired_usage_lines: 3,
    pending_ledger_transactions: 0, exonerated_usage_lines: 0, drained: false,
  },
};

function activationState(state) {
  const activated = state.state === "activated";
  const hasCandidate = state.state === "go" || state.state === "no_go";
  return {
    mode: "ACTIVE", cutover_at: CUTOVER, strict_writes_enabled: activated,
    scope_summary: hasCandidate
      ? {
        account_count: 2,
        required_accounts: [
          { resource_id: RESOURCE_API, currency: "CNY" },
          { resource_id: RESOURCE_PLAN, currency: "USD" },
        ],
        months_checked: ["2026-08", "2026-09"], token_conserved: true,
        coding_plan_usage_attributed: true, operating_bills_complete: true, usage_repair_rows: 3,
      }
      : null,
    quiescence: QUIESCENCE,
    latest_candidate: hasCandidate
      ? {
        candidate_id: CANDIDATE_ID, candidate_hash: CANDIDATE_HASH, fact_watermark_hash: WATERMARK,
        decision: state.state === "go" ? "GO_CANDIDATE" : "NO_GO", status: "PREVIEWED",
        created_at: "2026-09-22T03:04:00.000Z", expires_at: "2026-09-22T03:34:00.000Z",
        expired: false, created_by_admin_user_id: "admin-1",
        gap_summary: state.state === "go" ? [] : [{ code: "MISSING_OPENING_BALANCE", count: 1 }],
        activated_at: null, activated_by_admin_user_id: null,
      }
      : null,
    activation_receipt: activated
      ? {
        candidateId: CANDIDATE_ID, candidateHash: CANDIDATE_HASH, factWatermarkHash: WATERMARK,
        activatedAt: "2026-09-22T03:06:00.000Z", activatedByAdminUserId: "admin-1",
        factCounts: { openings: 2, recharges: 3, purchases: 2, carryovers: 1, legacyResolutions: 2, usageRepairs: 3 },
        monthsChecked: ["2026-08", "2026-09"], conservationPassed: true, conservationFailures: [],
      }
      : null,
    activated_at: activated ? "2026-09-22T03:06:00.000Z" : null,
    activated_by_admin_user_id: activated ? "admin-1" : null,
  };
}

function gap(code, category, message, resourceId = null, extra = {}) {
  return {
    code, category, message, resourceId, accountCurrency: null,
    legacyRecordId: null, ledgerLineId: null, month: null, detail: null, ...extra,
  };
}

function preview(state) {
  const go = state.preview === "go";
  return {
    candidate_id: CANDIDATE_ID, candidate_hash: CANDIDATE_HASH, fact_watermark_hash: WATERMARK,
    snapshot_at: "2026-09-22T03:04:00.000Z", preview_committed_at: "2026-09-22T03:04:01.000Z",
    expires_at: "2026-09-22T03:34:00.000Z",
    decision: go ? "GO_CANDIDATE" : "NO_GO",
    gaps: go
      ? [gap("UNKNOWN_COST", "USAGE", "存在未明确费用状态的 API 用量行", null,
        { ledgerLineId: "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70", month: "2026-08" })]
      : [
        gap("MISSING_OPENING_BALANCE", "OPENING_BALANCE", "缺少原始期初余额", RESOURCE_API, { accountCurrency: "CNY", month: "2026-08" }),
        gap("MISSING_RECHARGE_CASH_PAID", "RECHARGE", "历史充值缺少人民币实付", RESOURCE_API, { accountCurrency: "CNY", month: "2026-09" }),
        gap("INVALID_SERVICE_PERIOD", "PURCHASE", "扣费日期必须等于服务开始日", RESOURCE_PLAN, { accountCurrency: "USD" }),
        gap("LEGACY_RECORD_UNCLOSED", "LEGACY_RECORD", "旧购买记录没有唯一关闭结果", RESOURCE_PLAN,
          { legacyRecordId: "7f8a9b0c-1d2e-4f3a-8b4c-5d6e7f8a9b0c" }),
        gap("UNKNOWN_COST", "USAGE", "存在未明确费用状态的 API 用量行", null,
          { ledgerLineId: "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70", month: "2026-08" }),
      ],
    scope_summary: {
      apiResources: 1, codingPlanResources: 1, requiredAccounts: 2, legacyRecords: 1,
      months: ["2026-08", "2026-09"],
    },
    usage_repairs: { eligibleRows: 3, eligibleByField: { pricing_snapshot_id: 3 }, newRowsAfterPreview: 0, nonTargetHashMismatches: 0 },
    projected: {
      accounts: [
        { resourceId: RESOURCE_API, currency: "CNY", openingBalance: "500.00000000", openingCorrections: "0.00000000", recharges: "1200.00000000", usageDebits: "764.23000000", balanceReconciliations: "0.00000000", legacyCostAdjustments: "0.00000000", reversals: "0.00000000", balance: "935.77000000" },
        { resourceId: RESOURCE_PLAN, currency: "USD", openingBalance: "0.00000000", openingCorrections: "0.00000000", recharges: "0.00000000", usageDebits: "0.00000000", balanceReconciliations: "0.00000000", legacyCostAdjustments: "0.00000000", reversals: "0.00000000", balance: "0.00000000" },
      ],
      monthsChecked: ["2026-08", "2026-09"], tokenConserved: true,
      codingPlanUsageAttributed: true, operatingBillsComplete: true,
    },
  };
}

async function handleApi(path, method, state) {
  if (path === "/api/auth/me") {
    return { admin: {
      roleCode: "SUPER_ADMIN", roleName: "超级管理员", permissions: {},
      adminUserId: "admin-1", enterpriseId: "ent-7c1f4a92-5b3d-4e6a-9c8f-0d2e4f6a8b1c",
      username: "admin", displayName: "验收管理员", mustChangePassword: false,
    }, featureFlags: {
      FEATURE_DIRECTORY_IMPORT: true, FEATURE_USAGE_OVERVIEW_V2: true,
      FEATURE_DEPARTMENT_COST: true, FEATURE_RESOURCE_UTILIZATION_V2: true,
      FEATURE_PROCUREMENT_REVIEW: true,
    }, providerFinanceMode: "ACTIVE" };
  }
  if (path.startsWith("/api/provider-finance/activation-state")) return activationState(state);
  if (path.startsWith("/api/provider-resources/usage-overview")) {
    return { generatedAt: "2026-09-22T03:00:00.000Z", providerSummaries: [], modelDetails: [] };
  }
  if (path.startsWith("/api/provider-resources") && path.includes("/finance/events")) {
    return { items: [], total: 0 };
  }
  if (path.startsWith("/api/provider-resources") && path.includes("/subscription-periods")) {
    return { periods: [] };
  }
  if (path.startsWith("/api/provider-resources") && path.includes("/finance/balance")) {
    return { resourceId: RESOURCE_API, currency: "CNY", balance: "935.77000000", state: "OK" };
  }
  if (path.startsWith("/api/provider-resources")) return { resources: resources() };
  if (path.startsWith("/api/providers")) {
    return { providers: [{ id: PROVIDER, code: "Kimi", name: "Kimi", adapter_type: "kimi" }] };
  }
  if (path.startsWith("/api/provider-finance/summary")) {
    return { month: "2026-09", timezone: "Asia/Shanghai", cashOutflowCny: "0", apiRecharges: [],
      apiOperatingCosts: [], codingPlanOrders: [], codingPlanFixedCostCny: "0", operatingCostCny: "0",
      operatingCostByCurrency: [], currentApiBalances: [], currentApiBalancesComplete: true,
      complete: true, gaps: [] };
  }
  if (path.startsWith("/api/provider-finance/activation-preview") && method === "POST") {
    return preview(state);
  }
  if (path.startsWith("/api/provider-finance/activation-quiescence")) return { lease: null, quiescence: QUIESCENCE };
  return {};
}

async function serveStatic(path, response) {
  const relative = path === "/" ? "/index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "");
  let target = join(DIST, relative);
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, "index.html");
  } catch {
    target = join(DIST, "index.html"); // SPA 回退
  }
  const body = await readFile(target);
  response.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
  response.end(body);
}

createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    const state = await scenario();
    const payload = await handleApi(path, request.method, state);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
    return;
  }
  await serveStatic(path, response);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`evidence server ready: http://127.0.0.1:${PORT} (dist=${DIST})`);
});
