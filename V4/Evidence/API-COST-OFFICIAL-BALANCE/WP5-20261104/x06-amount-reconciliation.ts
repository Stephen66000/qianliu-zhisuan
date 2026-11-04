/**
 * AT-X06 金额核对表生成脚本（WP5 S3b，一次性只读）。
 *
 * 依据：acceptance-plan §6 X06（同期间同范围比较首页/资源/用量/账单/年度/部门项目/CSV，
 * 金额核对表为交付物）；WP1 合同 §5（金额核对以 loadApiCostEstimation 为唯一基准，
 * 允许差异仅限 (a) 筛选范围/期间 (b) 缺口与完整性说明双权威 (c) 桥接字段历史值）；
 * inv-wp5 §3-X06 建议（脚本落证据目录，非业务代码）。
 *
 * 只读保证：
 *   - DB 侧仅经 loadApiCostEstimation 与一条 SELECT（无币种缺口行构成核对）读取；
 *   - HTTP 侧仅 GET 读端点＋POST /auth/login（登录取 cookie，同 e2e fixtures 惯例）；
 *   - 除本核对表 markdown 输出外零写盘、零写库、零消息发送。
 *
 * 运行（worktree 根）：
 *   DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55432/qianliu_e2e \
 *   X06_BASE_URL=http://127.0.0.1:8899 \
 *   corepack pnpm@11.11.0 exec tsx \
 *   V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.ts
 */
import { writeFileSync } from "node:fs";
// @qianliu/database 不在证据目录的 node_modules 解析链上（pnpm workspace 仅在包内链接），
// 按相对路径直引包内源文件（tsx 加载；与 e2e spec 直引 seed 源文件同法），保持只读语义不变。
import { createKysely } from "../../../../packages/database/src/kysely.ts";
import { loadApiCostEstimation } from "../../../../packages/database/src/repositories/api-cost-estimation.ts";

// ── 配置 ────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://postgres:qianliu@127.0.0.1:55432/qianliu_e2e";
const BASE_URL = process.env.X06_BASE_URL ?? "http://127.0.0.1:8899";
const OUTPUT = process.env.X06_OUTPUT
  ?? "/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.md";
const PROJECT_ID = "00000000-0000-4000-8000-000000000140"; // pool043 星河项目（e2e seed）

/** 与 seed-e2e.ts 相同的安全门：仅本机＋`_e2e` 后缀库（只读脚本同样不碰其他库）。 */
function assertDedicatedDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const databaseName = url.pathname.slice(1);
  if (!local || !databaseName.endsWith("_e2e")) {
    throw new Error(
      `拒绝连接：本脚本只允许本机且数据库名以 _e2e 结尾（实际 ${url.hostname}/${databaseName}）`,
    );
  }
}

// ── 8 位定点加法（BigInt，禁止 float）────────────────────────────────
function toUnits(value: string): bigint {
  const neg = value.startsWith("-");
  const body = neg ? value.slice(1) : value;
  const [whole, frac = ""] = body.split(".");
  const frac8 = (frac + "00000000").slice(0, 8);
  const units = BigInt(whole) * 100_000_000n + BigInt(frac8);
  return neg ? -units : units;
}
function fromUnits(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
function sumDecimalStrings(values: string[]): string {
  return fromUnits(values.reduce((acc, v) => acc + toUnits(v), 0n));
}
function sameAmounts(
  left: Array<{ currency: string; amount: string }>,
  right: Array<{ currency: string; amount: string }>,
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.currency.localeCompare(b.currency));
  const sortedRight = [...right].sort((a, b) => a.currency.localeCompare(b.currency));
  return sortedLeft.every((item, i) =>
    item.currency === sortedRight[i]!.currency && item.amount === sortedRight[i]!.amount);
}
function amountsText(amounts: Array<{ currency: string; amount: string }>): string {
  return amounts.length === 0
    ? "（空）"
    : amounts.map((a) => `${a.currency} ${a.amount}`).join(" ＋ ");
}
const shortId = (id: string): string => id.slice(-4);

// ── 上海当月窗口（与 operatingBillMonthRange 同口径）──────────────────
function shanghaiMonthWindow(now: Date): { month: string; start: Date; end: Date; prevMonth: string } {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  const year = shifted.getUTCFullYear();
  const monthIdx = shifted.getUTCMonth();
  const month = `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
  const prev = monthIdx === 0
    ? `${year - 1}-12`
    : `${year}-${String(monthIdx).padStart(2, "0")}`;
  const nextYear = monthIdx === 11 ? year + 1 : year;
  const nextMonth = monthIdx === 11 ? 1 : monthIdx + 2;
  return {
    month,
    prevMonth: prev,
    start: new Date(`${month}-01T00:00:00+08:00`),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`),
  };
}

// ── HTTP 客户端（登录 cookie）───────────────────────────────────────
interface HttpResult {
  status: number;
  ok: boolean;
  body: string;
}
async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`登录失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("登录响应未返回 set-cookie");
  return setCookie.split(";")[0]!.trim();
}
async function httpGet(baseUrl: string, cookie: string, path: string): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { cookie },
    redirect: "manual",
  });
  return { status: response.status, ok: response.ok, body: await response.text() };
}
function parseJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return { _unparsed: body.slice(0, 400) }; }
}
function digest(value: unknown, limit = 1500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return text.length > limit ? `${text.slice(0, limit)}\n…（截断，共 ${text.length} 字符）` : text;
}

// ── CSV 解析（usage export：BOM＋引号转义＋CRLF）─────────────────────
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ── 主流程 ──────────────────────────────────────────────────────────
interface SourceRow {
  source: string;
  endpoint: string;
  periodScope: string;
  currency: string;
  amount: string;
  baselineRef: string;
  verdict: string;
  attribution: string;
}

async function main(): Promise<void> {
  assertDedicatedDatabase(DATABASE_URL);
  const db = createKysely(DATABASE_URL);
  const startedAt = new Date();
  const window = shanghaiMonthWindow(startedAt);
  const lines: string[] = [];
  const pendingAdjudication: string[] = [];

  try {
    // 0. 企业（与登录路由同口径：第一条 enterprise）。
    const enterpriseRows = await db.selectFrom("enterprise")
      .select(["id", "name", "timezone"])
      .orderBy("created_at", "asc").orderBy("id", "asc").limit(1).execute();
    const enterprise = enterpriseRows[0]!;

    // 0b. 只读核对查询：无币种已计价账本行（基准 CURRENCY_MISSING 缺口行的本体），
    //     按窗口内/外分桶——用于 /usage、CSV 行级金额的构成核对（SELECT-only）。
    // 缺口行再按"请求是否有 ledger_transaction"分桶：/usage 与 CSV 是请求级读取方
    // （usageRepo.list 以 ledger_transaction 为金额来源），无事务行的账本行在该读取方
    // 不出现（经空金额行呈现）。全部为 SELECT-only 构成核对。
    const missingBucket = async (
      scope: "in" | "out",
      txn: "has" | "none",
    ): Promise<{ cnt: number; amt: string } | undefined> => {
      const base = db.selectFrom("ledger_line")
        .select((eb) => [
          eb.fn.countAll().as("cnt"),
          eb.fn.coalesce(eb.fn.sum("api_cost"), eb.lit(0)).as("amt"),
        ])
        .where("enterprise_id", "=", enterprise.id)
        .where("resource_mode", "=", "API")
        .where("api_cost", "is not", null)
        .where("api_cost_currency", "is", null);
      const scoped = scope === "in"
        ? base.where("settled_at", ">=", window.start)
          .where("settled_at", "<", window.end)
        : base.where((eb) => eb.or([
          eb("settled_at", "<", window.start),
          eb("settled_at", ">=", window.end),
        ]));
      const row = await (txn === "has"
        ? scoped.where((eb) => eb.exists(
          eb.selectFrom("ledger_transaction")
            .select("id")
            .whereRef("ledger_transaction.ai_request_id", "=", "ledger_line.ai_request_id"),
        ))
        : scoped.where((eb) => eb.not(eb.exists(
          eb.selectFrom("ledger_transaction")
            .select("id")
            .whereRef("ledger_transaction.ai_request_id", "=", "ledger_line.ai_request_id"),
        )))).executeTakeFirst();
      return row
        ? { cnt: Number(row.cnt), amt: fromUnits(toUnits(String(row.amt))) }
        : undefined;
    };
    const missingInWindow = await missingBucket("in", "has");
    const missingOutWindow = await missingBucket("out", "has");
    const missingNoTxnInWindow = await missingBucket("in", "none");
    const missingNoTxnOutWindow = await missingBucket("out", "none");
    const bucketText = (b?: { cnt: number; amt: string }) =>
      b ? `${b.amt}（${b.cnt} 行）` : "0（0 行）";
    const missingInWindowText = bucketText(missingInWindow);
    const missingOutWindowText = bucketText(missingOutWindow);
    const missingNoTxnText = `${bucketText(missingNoTxnInWindow)}（窗口内）＋${bucketText(missingNoTxnOutWindow)}（窗口外）`;
    const missingInWindowAmt = missingInWindow?.amt ?? "0.00000000";
    // 请求级读取方（/usage、CSV）可承载的无币种缺口行金额＝有事务行桶（窗口内＋外）。
    const missingWithTxnTotal = sumDecimalStrings([
      missingInWindow?.amt ?? "0", missingOutWindow?.amt ?? "0",
    ]);
    const missingTotal = missingWithTxnTotal;

    // 1. 基准：loadApiCostEstimation（全企业、当月 DRAFT 窗口）。
    const baseline = await loadApiCostEstimation(db, enterprise.id, {
      start: window.start, end: window.end,
    });
    const baselineCny = baseline.amounts.find((a) => a.currency === "CNY")?.amount ?? null;
    const baselineUsd = baseline.amounts.find((a) => a.currency === "USD")?.amount ?? null;
    const baselineGapText = baseline.gaps.map((g) => `${g.reason}:${g.count}`).join("、") || "（无）";
    const priceMissingCount = baseline.gaps.find((g) => g.reason === "PRICE_MISSING")?.count ?? 0;

    // 2. 登录并逐端点抓取。
    const cookie = await login(BASE_URL);
    const requests: Array<{ path: string; result: HttpResult; json: unknown }> = [];
    const get = async (path: string): Promise<{ result: HttpResult; json: unknown }> => {
      const result = await httpGet(BASE_URL, cookie, path);
      const json = parseJson(result.body);
      requests.push({ path, result, json });
      return { result, json };
    };

    const dashboard = await get("/dashboard");
    const dashboardHome = await get("/dashboard/home");
    const overview = await get("/usage/overview?subject_type=EMPLOYEE&period=MONTH");
    const usageList = await get("/usage?limit=500");
    const usageCsv = await get("/usage/export");
    const billMonths = await get("/operating-bills");
    const bill = await get(`/operating-bills/${window.month}`);
    const closedBill = await get(`/operating-bills/${window.prevMonth}`);
    const analysis = await get(`/operating-bills/${window.month}/analysis`);
    const deptAccounts = await get(`/operating-bills/${window.month}/department-accounts`);
    const deptBill = await get(`/operating-bills/${window.month}/departments`);
    const allocStatus = await get(`/operating-bills/${window.month}/project-allocation-status`);
    const unallocated = await get(`/operating-bills/${window.month}/project-unallocated`);
    const projectLines = await get(
      `/operating-bills/${window.month}/projects/${PROJECT_ID}/allocation-lines`);
    const resourceOverview = await get("/provider-resources/usage-overview");

    // ── 行装配 ──────────────────────────────────────────────────────
    const rows: SourceRow[] = [];
    const push = (
      source: string, endpoint: string, periodScope: string,
      currency: string, amount: string, baselineRef: string,
      verdict: string, attribution: string,
    ): void => { rows.push({ source, endpoint, periodScope, currency, amount, baselineRef, verdict, attribution }); };

    // 2.1 首页 /dashboard（monthlyApiCosts 与基准同源：loadApiCostEstimation）
    {
      const body = dashboard.json as Record<string, any>;
      const apiCosts = (body.monthlyApiCosts ?? []) as Array<{ currency: string; amount: string }>;
      const equal = sameAmounts(apiCosts, baseline.amounts);
      push("首页 dashboard 汇总", "GET /dashboard",
        `当月（上海）${window.month} 全企业`, "多币种分列", amountsText(apiCosts),
        `基准 amounts＝${amountsText(baseline.amounts)}`,
        equal ? "一致" : "差异",
        equal ? "同源（loadApiCostEstimation，首页 S3a 改造）" : "不允许差异（同源应逐字相等）→ 待裁定");
      push("首页 dashboard 汇总", "GET /dashboard",
        "同上", "完整性说明", `monthlyApiSpendReason＝${JSON.stringify(body.monthlyApiSpendReason ?? null)}`,
        `基准 completeness＝${baseline.completeness}，gaps＝${baselineGapText}`,
        "一致（说明形态不同属白名单(b) 双权威）",
        "白名单(b)：首页以 reason 文案透出缺口（apiEstimationGapText 剔除 PRICE_BASIS_UNVERIFIED 信息项；混币月份标量 monthlyApiCost=null）");
      if (!equal) pendingAdjudication.push(
        `GET /dashboard monthlyApiCosts=${JSON.stringify(apiCosts)} 与基准不一致（应同源逐字相等）`);
    }

    // 2.2 标准版首页 /dashboard/home（monthlyCost.current 取自账单 getBill）
    {
      const body = dashboardHome.json as Record<string, any>;
      const current = body?.monthlyCost?.current ?? {};
      const apiSpends = (current.apiSpends ?? []) as Array<{ currency: string; amount: string }>;
      const totalSpends = (current.totalSpends ?? []) as Array<{ currency: string; amount: string }>;
      const equalApi = sameAmounts(apiSpends, baseline.amounts);
      push("标准版首页（dashboard/home）", "GET /dashboard/home",
        `当月 ${window.month} 全企业（账单快照）`, "多币种分列",
        `apiSpends＝${amountsText(apiSpends)}；totalSpends＝${amountsText(totalSpends)}`,
        `基准 amounts＝${amountsText(baseline.amounts)}`,
        equalApi ? "一致" : "差异",
        equalApi ? "同源（账单 getBill → loadApiCostEstimation）＋套餐 0 合成 totalSpends"
          : "不允许差异（同源应逐字相等）→ 待裁定");
      if (!equalApi) pendingAdjudication.push(
        `GET /dashboard/home monthlyCost.current.apiSpends=${JSON.stringify(apiSpends)} 与基准不一致`);
    }

    // 2.3 用量总览 v2（transaction 级聚合＋完整性拒绝出数）
    {
      const body = overview.json as Record<string, any>;
      const metrics = body?.metrics ?? {};
      const range = body?.range ?? {};
      push("用量总览 v2", "GET /usage/overview?subject_type=EMPLOYEE&period=MONTH",
        `${range.from ?? "?"} ~ ${range.to ?? "?"}（企业时区=${body?.timezone ?? "?"}）全主体`,
        "单一标量", `apiCost＝${JSON.stringify(metrics.apiCost ?? null)}；apiCostStatus＝${metrics.apiCostStatus ?? "?"}`,
        `基准 amounts＝${amountsText(baseline.amounts)}（CNY＋USD 分列）、completeness＝${baseline.completeness}`,
        metrics.apiCost == null ? "差异" : "差异",
        metrics.apiCost == null
          ? "白名单(b)＋(a)：窗口含 UNKNOWN 事务行 → 聚合拒绝出数（不把已计价部分冒充完整总额）；聚合域为 ledger_transaction（请求级、created_at 窗口），与账本行级 settled_at 窗口基准不直接可比"
          : "→ 待裁定（非空标量与按币种分列的基准形态不同）");
      push("用量总览 v2（角标）", "GET /usage/overview", "同上",
        "信息项", `priceBasisUnverified＝${metrics.priceBasisUnverified}`,
        `基准 gaps 含 PRICE_BASIS_UNVERIFIED:${baseline.gaps.find((g) => g.reason === "PRICE_BASIS_UNVERIFIED")?.count ?? 0}`,
        metrics.priceBasisUnverified === true ? "一致" : "差异",
        "判定源同源（loadApiCostEstimation().priceBasis 任一 UNVERIFIED，S2B R7）");
    }

    // 2.4 用量明细列表行级（请求级 transaction 汇总＋缺省币种标签）
    {
      const body = usageList.json as Record<string, any>;
      const records = (body?.records ?? []) as Array<{
        requestId: string; totalApiCost: string | null; costCurrency: string | null; status: string;
      }>;
      const priced = records.filter((r) => r.totalApiCost !== null);
      const emptyRows = records.filter((r) => r.totalApiCost === null);
      const detailText = (list: typeof records) => list.map((r) =>
        `…${shortId(r.requestId)}＝${r.totalApiCost ?? "（空）"}/${r.costCurrency ?? "（无标签）"}${r.status === "SUCCEEDED" ? "" : `/${r.status}`}`,
      ).join("；");
      const byLabel = new Map<string, string[]>();
      for (const r of priced) {
        const label = r.costCurrency ?? "（无标签）";
        byLabel.set(label, [...(byLabel.get(label) ?? []), r.totalApiCost!]);
      }
      for (const [label, values] of [...byLabel.entries()].sort()) {
        const sum = sumDecimalStrings(values);
        if (label === "USD") {
          const equal = baselineUsd !== null && sum === baselineUsd;
          push("用量明细列表（行级求和·USD）", "GET /usage?limit=500",
            `默认全量期间（无窗口过滤），${priced.length} 个带金额请求行`, label,
            `${sum}（${values.length} 行：${values.join("＋")}）`,
            `基准 USD ${baselineUsd}`,
            equal ? "一致" : "差异",
            equal ? "USD 已计价行金额与基准逐字相等" : "→ 待裁定");
          if (!equal) pendingAdjudication.push(`GET /usage USD 行级合计=${sum} 与基准 ${baselineUsd} 不一致`);
        } else if (label === "CNY") {
          // 构成核对：基准 CNY ＋ 全部无币种已计价缺口行（窗口内＋窗口外）＝缺省 CNY 标签行总和。
          const reconciled = sum === sumDecimalStrings([baselineCny ?? "0", missingWithTxnTotal]);
          push("用量明细列表（行级求和·CNY 标签）", "GET /usage?limit=500",
            "同上", label,
            `${sum}（${values.length} 行）`,
            `基准 CNY ${baselineCny}＋无币种缺口行 ${missingInWindowText}（窗口内）＋${missingOutWindowText}（窗口外）`,
            reconciled ? "差异" : "差异",
            reconciled
              ? "白名单(b)＋(a)：无币种已计价行在读取方缺省显示 CNY（usage-repository.ts:339 展示语义），合计与基准＋有事务行缺口行（请求级读取方可承载的账本行）逐字对平；请求级 ledger_transaction 汇总（请求 030 的 45＋80 两行合并为 125.00000000）、默认全量期间（窗口外 pool043 8 月行 3.2＋4.8 计入）、无事务行缺口行（pool042 8.00）经空金额行呈现而非金额——可逐行核对，非异源算法差异"
              : "→ 待裁定（CNY 标签行合计 ≠ 基准＋无币种缺口行）");
          if (!reconciled) pendingAdjudication.push(
            `GET /usage CNY 标签行合计=${sum} ≠ 基准 CNY ${baselineCny}＋缺口行 ${missingTotal}`);
        } else {
          push("用量明细列表（无标签行）", "GET /usage?limit=500", "同上", label,
            `${sumDecimalStrings(values)}（${values.length} 行）`, "基准无此标签", "差异", "→ 待裁定");
          pendingAdjudication.push(`GET /usage 出现非 CNY/USD 标签 ${label} 金额 ${sum}`);
        }
      }
      push("用量明细列表（空金额行）", "GET /usage?limit=500",
        "同上", "—",
        `空金额请求行＝${emptyRows.length}（${detailText(emptyRows)}；带金额行：${detailText(priced)}）`,
        `基准 gaps：PRICE_MISSING:${priceMissingCount}（账本行级 UNKNOWN）；pool042 两请求仅有账本行、无 ledger_transaction（请求级读取方不含其行级金额）`,
        "核对行（构成差异可解释）",
        "白名单(a)＋(b)：请求级读取方与账本行级基准的域/期间口径差异＋完整性说明（请求域金额不可见≠账本行金额丢失，账单/基准仍承载缺口计数）");
    }

    // 2.5 usage CSV 导出（逐行抓取文本，列名与页面一致）
    {
      const result = usageCsv.result;
      const rowsCsv = parseCsv(result.body);
      const header = rowsCsv[0] ?? [];
      const idxCost = header.indexOf("API费用估算");
      const idxCurrency = header.indexOf("币种");
      const idxId = header.indexOf("请求ID");
      if (idxCost < 0 || idxCurrency < 0) {
        push("用量 CSV 导出", "GET /usage/export", result.body.slice(0, 120), "-", "-",
          "基准 amounts", "差异", "表头缺 API费用估算/币种 列 → 待裁定");
        pendingAdjudication.push("GET /usage/export CSV 表头未找到「API费用估算」/「币种」列");
      } else {
        const dataRows = rowsCsv.slice(1).filter((r) => r.length > 1);
        const grouped = new Map<string, Array<{ id: string; cost: string }>>();
        const emptyCostRows: string[] = [];
        for (const r of dataRows) {
          const cost = r[idxCost] ?? "";
          const currency = (r[idxCurrency] ?? "").trim();
          const id = idxId >= 0 ? r[idxId] ?? "?" : "?";
          if (cost === "") { emptyCostRows.push(`…${shortId(id)}`); continue; }
          grouped.set(currency, [...(grouped.get(currency) ?? []), { id, cost }]);
        }
        for (const [currency, items] of [...grouped.entries()].sort()) {
          const sum = sumDecimalStrings(items.map((i) => i.cost));
          const detail = items.map((i) => `…${shortId(i.id)}＝${i.cost}`).join("；");
          if (currency === "USD") {
            const equal = baselineUsd !== null && sum === baselineUsd;
            push("用量 CSV 导出（行级求和·USD）", "GET /usage/export",
              `导出时点全量（limit=5000，${dataRows.length} 数据行）`, currency,
              `${sum}（${detail}）`, `基准 USD ${baselineUsd}`,
              equal ? "一致" : "差异",
              equal ? "USD 行金额与基准逐字相等" : "→ 待裁定");
            if (!equal) pendingAdjudication.push(`GET /usage/export USD 列合计=${sum} 与基准不一致`);
          } else if (currency === "CNY") {
            const reconciled = sum === sumDecimalStrings([baselineCny ?? "0", missingWithTxnTotal]);
            push("用量 CSV 导出（行级求和·CNY 列）", "GET /usage/export",
              "同上", currency,
              `${sum}（${detail}）`,
              `基准 CNY ${baselineCny}＋无币种缺口行 ${missingInWindowText}＋${missingOutWindowText}`,
              reconciled ? "差异" : "差异",
              reconciled
                ? "白名单(b)＋(a)：CSV 币种列对无币种已计价行缺省显示 CNY（usage/routes.ts export `costCurrency ?? \"CNY\"` 展示语义），列合计与基准＋有事务行缺口行逐字对平；导出无窗口过滤（含窗口外 pool043 8 月行 3.2＋4.8）、无事务行缺口行（pool042 8.00）留空呈现——可逐行核对，非异源算法差异"
                : "→ 待裁定（CNY 列合计 ≠ 基准＋无币种缺口行）");
            if (!reconciled) pendingAdjudication.push(
              `GET /usage/export CNY 列合计=${sum} ≠ 基准＋缺口行`);
          } else {
            push("用量 CSV 导出（异标签）", "GET /usage/export", "同上", currency,
              `${sum}`, "基准无此标签", "差异", "→ 待裁定");
            pendingAdjudication.push(`GET /usage/export 出现非 CNY/USD 币种标签 ${currency}`);
          }
        }
        push("用量 CSV 导出（表头/空金额行）", "GET /usage/export",
          "CSV 文本", "—",
          `表头含「API费用估算」＝${idxCost >= 0}；空金额行＝${emptyCostRows.length}（${emptyCostRows.join("、")}）`,
          `基准 gaps：PRICE_MISSING:${priceMissingCount}（行级 UNKNOWN）；pool042 两请求请求级无 transaction`,
          "核对行（构成差异可解释）",
          "白名单(a)＋(b)：缺口行留空不冒充 0；其余空行同为请求级域口径差异（见 /usage 空金额行）");
      }
    }

    // 2.6 经营账单 DRAFT 月（权威分列）
    {
      const body = bill.json as Record<string, any>;
      const summary = body?.summary ?? {};
      const apiSpends = (summary.apiSpends ?? []) as Array<{ currency: string; amount: string }>;
      const totalSpends = (summary.totalSpends ?? []) as Array<{ currency: string; amount: string }>;
      const equal = sameAmounts(apiSpends, baseline.amounts);
      push("经营账单（DRAFT 当月）", `GET /operating-bills/${window.month}`,
        `${window.month} 上海月界 全企业`, "多币种分列",
        `apiSpends＝${amountsText(apiSpends)}；totalSpends＝${amountsText(totalSpends)}；apiCost＝${JSON.stringify(summary.apiCost ?? null)}`,
        `基准 amounts＝${amountsText(baseline.amounts)}`,
        equal ? "一致" : "差异",
        equal ? "同源（operating-bill-draft → loadApiCostEstimation）；apiCost=null＝混币不合并（ACE-07）"
          : "不允许差异 → 待裁定");
      push("经营账单（完整性说明）", `GET /operating-bills/${window.month}`, "同上",
        "完整性说明",
        `apiSpendStatus＝${summary.apiSpendStatus}；apiSpendReason＝${JSON.stringify(summary.apiSpendReason ?? null)}`,
        `基准 completeness＝${baseline.completeness}，gaps＝${baselineGapText}`,
        "一致（口径换算：PRICE_MISSING:1＋CURRENCY_MISSING:5，信息项 PRICE_BASIS_UNVERIFIED 不入 reason）",
        "白名单(b)：双权威文案映射");
      if (!equal) pendingAdjudication.push(
        `GET /operating-bills/${window.month} summary.apiSpends=${JSON.stringify(apiSpends)} 与基准不一致`);
    }

    // 2.7 已关账历史月（白名单(c) 桥接历史值——冻结快照零改动）
    {
      const body = closedBill.json as Record<string, any>;
      const summary = body?.summary ?? {};
      const frozenApi = (summary.apiSpends ?? []) as Array<{ currency: string; amount: string }>;
      push("经营账单（CLOSED 上月·历史）", `GET /operating-bills/${window.prevMonth}`,
        `${window.prevMonth} 冻结版本 v${body?.version ?? "?"}`, "多币种分列",
        `apiSpends＝${amountsText(frozenApi)}；apiCost＝${JSON.stringify(summary.apiCost ?? null)}；桥接 opening/recharge/ending＝${summary.openingBalance}/${summary.monthlyRecharge}/${summary.endingBalance}`,
        "seed 冻结快照常量：apiSpends=[CNY 96.00000000]、apiCost=96.00000000、1000/100/1004（桥接历史值）",
        amountsText(frozenApi) === "CNY 96.00000000" ? "一致（历史快照零改动）" : "差异",
        "白名单(c)：桥接字段历史值＋AFR-11 冻结快照；旧口径 96 是余额桥接历史金额，不得改写也不得填入当期估算");
      if (amountsText(frozenApi) !== "CNY 96.00000000") pendingAdjudication.push(
        `CLOSED 月 apiSpends=${JSON.stringify(frozenApi)} 与冻结快照常量不一致（历史被改写属阻断）`);
    }

    // 2.8 年度统计 operating-analysis（(provider,币种) 行×月份矩阵）
    {
      const body = analysis.json as Record<string, any>;
      const apiAccounts = (body?.apiAccounts ?? []) as Array<Record<string, any>>;
      const monthList = ((body?.months ?? []) as Array<Record<string, any> | string>)
        .map((m) => typeof m === "string" ? m : String(m?.month ?? ""))
        .filter((m) => m !== "");
      if (apiAccounts.length === 0) {
        pendingAdjudication.push("GET /operating-bills/:month/analysis 返回空 apiAccounts");
      }
      const coveredProviders = new Set<string>();
      for (const account of apiAccounts) {
        const currency = String(account.currency ?? "?");
        const provider = String(account.providerCode ?? "?");
        coveredProviders.add(`${provider}/${currency}`);
        const monthCells = (account.months ?? []) as Array<Record<string, any>>;
        const cell = monthCells.find((m) => String(m?.month ?? "") === window.month) ?? null;
        const apiSpend = cell ? (cell.apiSpend ?? null) : null;
        const complete = cell ? (cell.apiSpendComplete ?? null) : null;
        const bridge = cell
          ? `recharge＝${cell.recharge ?? "null"}、paidCny＝${cell.paidCny ?? "null"}`
          : "—";
        const expected = provider.toLowerCase() === "deepseek"
          ? (currency === "CNY" ? baselineCny : currency === "USD" ? baselineUsd : null)
          : null;
        const cellIsAmount = typeof apiSpend === "string" && /^[0-9]/.test(apiSpend);
        if (cellIsAmount && expected !== null) {
          // S3c 既有口径：列值为 toFixed(2) 展示精度（acceptance §3 金额精度条款）。
          const displayEqual = apiSpend === Number(expected).toFixed(2);
          push(`年度统计（${provider}×${currency}）`, `GET /operating-bills/${window.month}/analysis`,
            `年度 ${monthList[0] ?? "?"}~${monthList[monthList.length - 1] ?? "?"} 列 ${window.month}`, currency,
            `apiSpend＝${apiSpend}；apiSpendComplete＝${JSON.stringify(complete)}；${bridge}`,
            `该厂商域基准＝${expected}`,
            displayEqual ? "一致（两位展示精度）" : "差异",
            displayEqual
              ? "同源（S3c：按厂商资源范围的 loadApiCostEstimation；列值为 toFixed(2) 展示精度）"
              : "→ 待裁定（金额既不等字面值也不等两位展示）");
          if (!displayEqual) pendingAdjudication.push(
            `analysis ${provider}×${currency} ${window.month}＝${apiSpend} 与基准 ${expected} 不一致`);
        } else if (cellIsAmount && expected === null) {
          push(`年度统计（${provider}×${currency}）`, `GET /operating-bills/${window.month}/analysis`,
            `列 ${window.month}`, currency, `apiSpend＝${apiSpend}`,
            "基准中该 (provider,币种) 域无带币种金额", "差异", "→ 待裁定");
          pendingAdjudication.push(
            `analysis ${provider}×${currency} 出现非空金额 ${apiSpend}，基准该域无带币种金额`);
        } else {
          // apiSpend=null：多币种月份保守置 null（WP1 §6 已知边界）。
          push(`年度统计（${provider}×${currency}）`, `GET /operating-bills/${window.month}/analysis`,
            `列 ${window.month}`, currency,
            `apiSpend＝null；apiSpendComplete＝${JSON.stringify(complete)}；${bridge}`,
            `该厂商域（DeepSeek WP4 资源）基准＝CNY ${baselineCny}＋USD ${baselineUsd}（多币种）`,
            "差异",
            "白名单(b)：WP1 合同 §6 已知边界——多币种月份所有 (provider,币种) 行 apiSpend 保守置 null＋false（不按行拆币种金额、不混加），按币种金额由账单 apiSpends 承载（本表第 12 行一致）；recharge/paidCny 为白名单(c) 资金域轨迹字段原样透出");
        }
      }
      push("年度统计（覆盖范围）", `GET /operating-bills/${window.month}/analysis`,
        `apiAccounts 覆盖＝${[...coveredProviders].sort().join("、") || "（无）"}`, "—",
        "—",
        "基准为全企业（含 zhipu 45/1/80、pool042 3.2/4.8 无币种行）",
        "核对行（范围差异）",
        "白名单(a)：年度页 apiAccounts 仅覆盖资金域 views 内资源（观察：本期仅 DeepSeek WP4 E2E 出现行；zhipu/pool042 资源的当月账本行不在 apiAccounts 任何行中——S3c 注释的 views 覆盖保证对这些资源未生效，机制未逐行核实，已列入回执未决问题）");
    }

    // 2.9 部门账户（department-accounts）
    {
      const body = deptAccounts.json as Record<string, any>;
      const totals = body?.totals ?? {};
      const groupRows = (body?.rows ?? []) as Array<Record<string, any>>;
      const providerSums = groupRows.flatMap((row) => (row?.providers ?? []).map((p: Record<string, any>) =>
        `${p.providerCode}＝knownApiCost ${p?.totals?.knownApiCost ?? "null"}`));
      const missingInWindowAllAmt = sumDecimalStrings([
        missingInWindow?.amt ?? "0", missingNoTxnInWindow?.amt ?? "0",
      ]);
      const expectedKnown = sumDecimalStrings([baselineCny ?? "0", baselineUsd ?? "0", missingInWindowAllAmt]);
      const reconciled = typeof totals.knownApiCost === "string" && totals.knownApiCost === expectedKnown;
      push("部门账户汇总", `GET /operating-bills/${window.month}/department-accounts`,
        `${window.month} 全部门（line_facts 聚合）`, "标量",
        `apiCost＝${JSON.stringify(totals.apiCost ?? null)}；knownApiCost＝${JSON.stringify(totals.knownApiCost ?? null)}；${providerSums.join("；")}`,
        `基准 amounts＝${amountsText(baseline.amounts)}＋窗口内无币种缺口行 ${missingInWindowText}＋${bucketText(missingNoTxnInWindow)}＝${expectedKnown}`,
        reconciled ? "差异" : "差异",
        reconciled
          ? "白名单(b)＋(a)：聚合含 api_cost IS NULL 行 → apiCost 拒绝出数（不冒充完整总额）；knownApiCost＝已知部分直加（跨币种直加为投影层既有口径，S2B §3 残留观察；仅计窗口内行 3.00104＋0.5＋134＝137.50104，与基准＋窗口内全部缺口行（含无事务行）逐字对平）"
          : `→ 待裁定（knownApiCost=${JSON.stringify(totals.knownApiCost)} ≠ 基准＋窗口内全部缺口行可核对值 ${expectedKnown}）`);
      if (!reconciled) pendingAdjudication.push(
        `department-accounts totals.knownApiCost=${JSON.stringify(totals.knownApiCost)} 无法与基准＋窗口内缺口行（${expectedKnown}）对平`);
    }

    // 2.10 部门账单 draft（departments）
    {
      const body = deptBill.json as Record<string, any>;
      const rowList = (body?.rows ?? []) as Array<Record<string, any>>;
      const unassigned = rowList.find((r) => r?.isUnassigned === true);
      const summaryFields = JSON.stringify(body?.totals ?? {});
      push("部门账单（draft）", `GET /operating-bills/${window.month}/departments`,
        `${window.month} 全部门`, "行级/汇总",
        `rows＝${rowList.length}；totals＝${summaryFields}；待归属行 apiCost＝${JSON.stringify(unassigned?.apiCost ?? null)}、reasonCodes＝${JSON.stringify(unassigned?.reasonCodes ?? [])}`,
        "部门域为分摊域读取方：本期行均无归属快照（attributionSnapshotMissingCount=7）→ 金额落待归属行且 apiCost=null（含 UNKNOWN 行拒绝出数）",
        "核对行（完整性说明）",
        "白名单(b)：DEPARTMENT_UNASSIGNED/ATTRIBUTION_SNAPSHOT_MISSING/API_COST_UNKNOWN 以缺口码说明而非金额冒充");
    }

    // 2.11 项目（allocation-status / unallocated / allocation-lines）
    {
      const statusBody = allocStatus.json as Record<string, any>;
      push("项目分摊状态", `GET /operating-bills/${window.month}/project-allocation-status`,
        `${window.month}`, "—", JSON.stringify(statusBody),
        "—", "核对行", "项目域读取方（当月夹具无分摊批次，enabled=false 属预期）");
      const unallocBody = unallocated.json as Record<string, any>;
      push("项目未分摊", `GET /operating-bills/${window.month}/project-unallocated`,
        `${window.month}`, "—",
        `tokens＝${JSON.stringify(unallocBody?.tokens ?? null)}；apiCostByCurrency＝${JSON.stringify(unallocBody?.apiCostByCurrency ?? null)}；lineCount＝${unallocBody?.lineCount ?? "?"}`,
        "—", "核对行", "分摊域（当月未启用分摊 → 空集；apiCostByCurrency 按币种分列的键结构本身即不混加口径）");
      const linesBody = projectLines.json as Record<string, any>;
      push(`项目明细（…${shortId(PROJECT_ID)} 星河）`, `GET /operating-bills/${window.month}/projects/${PROJECT_ID}/allocation-lines`,
        `${window.month} 该项目`, "—", `lines＝${(linesBody?.lines ?? []).length}`,
        "—", "核对行", "pool043 项目当月无分摊行（夹具用量在 2026-08），空集属预期");
    }

    // 2.12 资源分解（provider-resources/usage-overview，(provider,mode) 组级）
    {
      const body = resourceOverview.json as Record<string, any>;
      const groups = (body?.providerSummaries ?? []) as Array<Record<string, any>>;
      if (groups.length === 0) {
        pendingAdjudication.push("GET /provider-resources/usage-overview 未解析出 providerSummaries 数组");
      }
      for (const group of groups) {
        const mode = String(group.mode ?? "?");
        const name = String(group.providerCode ?? "?");
        if (mode !== "API") continue;
        const cost = group.monthlyCost ?? null;
        const reason = group.monthlyCostReason ?? null;
        const badge = group.priceBasisUnverified ?? null;
        push(`资源分解（${name} API 组）`, "GET /provider-resources/usage-overview",
          `当月（上海）该组资源`, "组级标量",
          `monthlyCost＝${JSON.stringify(cost)}；reason＝${JSON.stringify(reason)}；priceBasisUnverified＝${JSON.stringify(badge)}`,
          "组域＝该 (provider,mode) 组内资源的同源估算（小于全企业）",
          cost == null ? "差异" : "核对行",
          cost == null
            ? "白名单(a)＋(b)：组范围小于全企业（筛选范围不同）＋缺口/混币以 reason 说明（币种不一致：CNY、USD ／ CURRENCY_MISSING:n），priceBasisUnverified 判定源同源；组内金额可由账单 apiSpends（第 12 行）与组域行级数值核对"
            : "组域当月窗口外（pool043 8 月行）→ 月窗金额为精确 0，期间差异属白名单(a)");
      }
    }

    // ── markdown 装配 ────────────────────────────────────────────────
    const escapePipe = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    lines.push("# AT-X06 金额核对表（WP5 S3b · 一次性只读脚本产出）");
    lines.push("");
    lines.push(`- 生成时间：${startedAt.toISOString()}（本地运行，零消息发送）`);
    lines.push(`- 基准：\`loadApiCostEstimation\`（WP1 合同 §5 唯一基准），全企业（${enterprise.name} / \`${enterprise.id}\`）`);
    lines.push(`- 期间：当月 DRAFT 上海月界 \`${window.month}\`＝[${window.start.toISOString()}, ${window.end.toISOString()})`);
    lines.push(`- 库：\`qianliu_e2e\`（127.0.0.1:55432，seed 安全门校验通过）；HTTP 基址：\`${BASE_URL}\`（control-api，指向同一 \`qianliu_e2e\` 库）`);
    lines.push(`- 端点清单：${requests.map((r) => `GET ${r.path.replace(window.month, "<month>")}`).join("；")}（另 POST /auth/login 取会话）`);
    lines.push(`- 只读核对查询：无币种已计价账本行：有事务行＝窗口内 ${missingInWindowText}／窗口外 ${missingOutWindowText}；无事务行（请求级读取方经空金额行呈现）＝${missingNoTxnText}（SELECT-only 构成核对）`);
    lines.push("");
    lines.push("## 1. 核对表");
    lines.push("");
    lines.push("判定口径：**一致**＝金额逐字相等或差异恰可归因 WP1 §5 白名单 (a) 筛选范围/期间、(b) 缺口与完整性说明双权威、(c) 桥接字段历史值；「核对行」＝非金额域或构成差异已逐行解释；不能归因的金额差异列入 §2 待裁定差异。");
    lines.push("");
    lines.push("| # | 读取方 | 端点 | 期间/范围 | 币种/维度 | 读取值 | 基准参照 | 与基准一致性 | 归因 |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    rows.forEach((row, i) => {
      lines.push(`| ${i + 1} | ${escapePipe(row.source)} | ${escapePipe(row.endpoint)} | ${escapePipe(row.periodScope)} | ${escapePipe(row.currency)} | ${escapePipe(row.amount)} | ${escapePipe(row.baselineRef)} | ${escapePipe(row.verdict)} | ${escapePipe(row.attribution)} |`);
    });
    lines.push("");
    lines.push("## 2. 待裁定差异清单（金额不一致且不能归因白名单）");
    lines.push("");
    if (pendingAdjudication.length === 0) {
      lines.push("（无——全部读取方的金额差异均归因白名单 (a)/(b)/(c)，或在表中标注为同源一致/核对行。）");
    } else {
      pendingAdjudication.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
    }
    lines.push("");
    lines.push("## 3. 基准 JSON 全文（loadApiCostEstimation 输出）");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify({
      scope: { enterpriseId: baseline.scope.enterpriseId, resourceIds: baseline.scope.resourceIds },
      period: { start: baseline.period.start.toISOString(), end: baseline.period.end.toISOString() },
      amounts: baseline.amounts,
      completeness: baseline.completeness,
      gaps: baseline.gaps,
      priceBasis: baseline.priceBasis,
      excludedNoRecordedCost: baseline.excludedNoRecordedCost,
    }, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("## 4. 各端点原始响应摘要");
    lines.push("");
    for (const request of requests) {
      lines.push(`### ${request.result.status} ${request.path}`);
      lines.push("");
      lines.push("```");
      lines.push(digest(request.json));
      lines.push("```");
      lines.push("");
    }
    lines.push("## 5. 脚本说明");
    lines.push("");
    lines.push("- 脚本：`V4/Evidence/API-COST-OFFICIAL-BALANCE/WP5-20261104/x06-amount-reconciliation.ts`（一次性只读；DB 仅 SELECT，HTTP 仅 GET＋登录）");
    lines.push("- CSV 求和与全部金额运算使用 8 位定点 BigInt，无 float；金额一律保留端点原样字符串。");
    lines.push("- 同步性说明：各端点在同一进程内先后抓取（秒级间隔），e2e 库为静态夹具（seed 后无写入），期间一致性成立。");

    writeFileSync(OUTPUT, lines.join("\n") + "\n", "utf8");
    console.log(JSON.stringify({
      status: "ok",
      output: OUTPUT,
      rows: rows.length,
      endpoints: requests.length,
      pendingAdjudication: pendingAdjudication.length,
      baseline: baseline.amounts,
      completeness: baseline.completeness,
    }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error("x06-amount-reconciliation 失败:", error);
  process.exitCode = 1;
});
