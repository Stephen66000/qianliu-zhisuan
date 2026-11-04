/**
 * WP4（simplify-api-cost-and-official-balance）S6 浏览器证据 spec——真实 API 联调，不 mock 页面。
 *
 * 覆盖验收 case（断言依据 acceptance-plan §3 夹具定义与 §7 人工验收路线）：
 * - ACE-01：资源页/用量页统一 "API费用估算" 命名（资源列表官方余额列、用量列表表头）；
 * - OAB-01/04/02：官方余额 110（组成 10+100 不相加）、FAILED 保鲜值 50＋同步失败、
 *   UNSUPPORTED "暂不支持官方余额同步"；
 * - OAB-03 手动刷新：无凭证资源 409 credential_missing（零真实上游）；
 * - AFR-01 场景1：套餐与订阅面板无 API 资金初始化/充值表单，历史资金记录只读区含来源标签；
 * - AFR-07：DRAFT 月无期初/充值/期末卡与待补提示＋"综合费用（含 API 估算）"；
 *   CLOSED 月"已关账版本（历史口径，只读）"横幅＋三卡保留；
 * - F01（AT-ACE-01 估算半开窗）：600/400/200 @ 1/0.1/2 元每百万 → 0.00104 CNY；
 * - AT-ACE-14：用量导出 CSV 表头 "API费用估算"。
 * 夹具：apps/control-api/src/cli/seed-e2e-wp4.ts（WP4_IDS 同源固定 UUID）。
 *
 * WP5 S3a-2 追加（test 8-16，编号续 WP4 既有 7 个 test；新截图经 WP5_SHOT_DIR 落盘，
 * 默认 apps/web/e2e-artifacts/wp5，运行后复制到 V4/Evidence/.../WP5-20261104/screenshots）：
 * - ACE-01/02/05（G1/G2/G7）：请求详情（RequestDrilldown）结算汇总命名、0.00104、
 *   1200 Token、attempt 按请求口径＝1；
 * - ACE-07（G6）：F02 已计价 1/2 元行＋UNKNOWN"未知"行＋指标卡"未知"不冒充总额
 *   ＋账单"存在尚未计价的 API 请求"警示（当月已计价部分 3.00104 CNY 精确值经 HTTP）；
 * - ACE-13/14（G9/G10）：账单 DRAFT 综合费用＝API 估算＋套餐费用，按币种分列；
 * - OAB-03（G11）：unsupported 资源用量与估算照常；OAB-04（G14）过期标记＋保鲜值 40；
 *   OAB-08（G15）从未成功"暂无官方数据"不显 0；OAB-09（G16）同账户两 Key 无 200 合计；
 * - ACE-04（G4b）：用量指标卡＋资源分解 API 行"价格依据待核实"角标；
 * - OAB-13/14（G19/G20）：供给预测可信度/覆盖说明与"不可计算"局限文案（不改组件）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, login, apiGet } from "./fixtures";
import { WP4_IDS } from "../../../apps/control-api/src/cli/seed-e2e-wp4.js";
import { IDS } from "../../../apps/control-api/src/cli/seed-e2e-ids.js";

const evidenceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "../../../V4/Evidence/API-COST-OFFICIAL-BALANCE/WP4-20261104",
);
const screenshot = (name: string) => path.join(evidenceDir, "screenshots", name);
// WP5 S3a-2：新截图输出目录（env 可覆盖；运行后由执行方复制到证据目录归档）。
const wp5ShotDir = process.env.WP5_SHOT_DIR
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../e2e-artifacts/wp5");
const wp5Shot = (name: string) => path.join(wp5ShotDir, name);

function shanghaiMonthOffset(offset: number): string {
  const shifted = new Date(Date.now() + 8 * 3_600_000);
  const target = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + offset, 1));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}`;
}
const currentMonth = shanghaiMonthOffset(0);
const closedMonth = shanghaiMonthOffset(-1);

const OK_ROW_LABEL = "DeepSeek 官方余额 E2E";
const FAILED_ROW_LABEL = "DeepSeek 官方余额 E2E（同步失败）";
const UNSUPPORTED_ROW_LABEL = "E2E 智谱主资源";
// S3a-2 新增行标签（与 seed-e2e-wp4.ts §1b 同源）。
const EXPIRED_ROW_LABEL = "DeepSeek 官方余额 E2E（数据过期）";
const NEVER_ROW_LABEL = "DeepSeek 官方余额 E2E（从未成功）";
const PAIR_A_ROW_LABEL = "DeepSeek 官方余额 E2E（同账户 A）";
const PAIR_B_ROW_LABEL = "DeepSeek 官方余额 E2E（同账户 B）";

test.describe("WP4 API费用估算与官方余额", () => {
  test("ACE-01/OAB-01/OAB-04/OAB-02：资源列表官方余额三态", async ({ page }, testInfo) => {
    await login(page);
    await page.goto("/resources");
    // 注：ResourceTable 的 th 未带 scope="col"，无障碍角色为 cell——按表头文本断言。
    await expect(page.locator("thead th", { hasText: "官方余额 / 订阅" })).toBeVisible();

    // OAB-01：官方余额 110 元可见＋最近成功时间；组成 10+100 不相加（不出现 220）。
    const okRow = page.getByRole("row").filter({ has: page.getByText(OK_ROW_LABEL, { exact: true }) });
    await expect(okRow).toHaveCount(1);
    await expect(okRow.getByText("官方余额 ¥110.00")).toBeVisible();
    await expect(okRow.getByText(/最近成功 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)).toBeVisible();
    await expect(okRow).not.toContainText("220");
    await expect(okRow).not.toContainText("同步失败");
    // ACE-01：受支持资源有刷新入口；UNSUPPORTED 资源没有。
    await expect(okRow.getByRole("button", { name: "刷新余额" })).toBeVisible();

    // OAB-04：FAILED 保鲜值——上次成功 50 保留＋"同步失败"标记（不显示 0）。
    const failedRow = page.getByRole("row").filter({ has: page.getByText(FAILED_ROW_LABEL, { exact: true }) });
    await expect(failedRow).toHaveCount(1);
    await expect(failedRow.getByText("官方余额 ¥50.00")).toBeVisible();
    // exact：资源名含"（同步失败）"子串，状态标签按全等匹配。
    await expect(failedRow.getByText("同步失败", { exact: true })).toBeVisible();

    // OAB-02：UNSUPPORTED 资源显示"暂不支持官方余额同步"。
    const unsupportedRow = page.getByRole("row").filter({ has: page.getByText(UNSUPPORTED_ROW_LABEL, { exact: true }) });
    await expect(unsupportedRow).toHaveCount(1);
    await expect(unsupportedRow.getByText("暂不支持官方余额同步")).toBeVisible();
    await expect(unsupportedRow.getByRole("button", { name: "刷新余额" })).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath("resources-full.png"), fullPage: true });
    mkdirSync(path.dirname(screenshot("wp4-official-balance-ok.png")), { recursive: true });
    await okRow.screenshot({ path: screenshot("wp4-official-balance-ok.png") });
    await failedRow.screenshot({ path: screenshot("wp4-official-balance-failed.png") });
    await unsupportedRow.screenshot({ path: screenshot("wp4-official-balance-unsupported.png") });
    await page.screenshot({ path: screenshot("wp4-resources-official-balance-full.png"), fullPage: true });

    // C2 API 事实与页面一致（官方余额结构逐资源断言）。
    const list = await apiGet<{ resources: Array<{
      id: string; official_balance: {
        supported: boolean; status: string; total_balance: string | null;
        currency: string | null; composition: { granted: string | null; topped: string | null } | null;
        available: boolean | null;
      };
    }> }>(page, "/provider-resources");
    const ok = list.resources.find((r) => r.id === WP4_IDS.okResource);
    const failed = list.resources.find((r) => r.id === WP4_IDS.failedResource);
    const unsupported = list.resources.find((r) => r.id === IDS.resource);
    expect(ok?.official_balance).toMatchObject({ supported: true, status: "OK", total_balance: "110.00000000",
      currency: "CNY", composition: { granted: "10.00000000", topped: "100.00000000" }, available: true });
    expect(failed?.official_balance).toMatchObject({ supported: true, status: "FAILED", total_balance: "50.00000000",
      last_attempt_failed: true });
    expect(unsupported?.official_balance).toMatchObject({ supported: false, status: "UNSUPPORTED", total_balance: null });
  });

  test("OAB-03 手动刷新：无凭证资源 409 credential_missing（零真实上游）", async ({ page }, testInfo) => {
    await login(page);
    await page.goto("/resources");
    const okRow = page.getByRole("row").filter({ has: page.getByText(OK_ROW_LABEL, { exact: true }) });
    const refreshResponses: Array<{ status: number; body: string }> = [];
    page.on("response", (response) => {
      if (response.url().includes("/official-balance/refresh")) {
        void response.text().then((body) => refreshResponses.push({ status: response.status(), body }));
      }
    });
    await okRow.getByRole("button", { name: "刷新余额" }).click();
    await expect(okRow.getByText("资源没有可用凭证，无法刷新官方余额")).toBeVisible({ timeout: 10_000 });
    expect(refreshResponses).toHaveLength(1);
    expect(refreshResponses[0]!.status).toBe(409);
    expect(JSON.parse(refreshResponses[0]!.body)).toMatchObject({ error: "credential_missing" });
    await page.screenshot({ path: screenshot("wp4-refresh-credential-missing.png"), fullPage: true });
  });

  test("AFR-01 场景1：套餐与订阅面板无 API 资金表单，历史资金记录只读含来源", async ({ page }, testInfo) => {
    await login(page);
    await page.goto("/resources");
    await page.getByRole("tab", { name: "套餐与订阅" }).click();
    await expect(page.getByRole("heading", { name: "套餐与订阅" })).toBeVisible();

    // AFR-01：API 资金初始化/充值表单整体退出。
    await expect(page.getByText("充值与订阅")).toHaveCount(0);
    await expect(page.getByText("充值金额")).toHaveCount(0);
    await expect(page.getByText("充值时间")).toHaveCount(0);
    await expect(page.getByText("当前 API 余额")).toHaveCount(0);
    await expect(page.getByText("API 经营成本")).toHaveCount(0);

    // 历史资金记录（旧口径，只读）区：含来源标签（ADMIN → 管理员登记）。
    await page.getByLabel("历史记录资源").selectOption({ label: `DeepSeek WP4 E2E · ${OK_ROW_LABEL}` });
    await expect(page.getByText("历史资金记录（旧口径，只读）")).toBeVisible();
    const historyTable = page.getByRole("table").filter({ has: page.locator("th", { hasText: "来源" }) });
    await expect(historyTable.locator("th", { hasText: "来源" })).toBeVisible();
    const legacyRow = historyTable.getByRole("row").filter({ has: page.getByText("API 充值") });
    await expect(legacyRow).toHaveCount(1);
    await expect(legacyRow.getByText("管理员登记")).toBeVisible();
    // 退役说明在位，无任何写入口（区块只读）。
    await expect(page.getByText(/API 资金管理已退役：本区块仅作历史查阅/)).toBeVisible();
    await expect(historyTable.getByRole("button")).toHaveCount(0);
    await page.screenshot({ path: screenshot("wp4-plan-subscription-panel.png"), fullPage: true });
  });

  test("ACE-01/F01：用量页估算命名与半开窗估算 0.00104", async ({ page }, testInfo) => {
    await login(page);
    // 用量概览（指标卡/排名表头）与请求明细（明细表头）均出现 "API费用估算"（ACE-01）。
    await page.goto("/usage");
    await expect(page.getByText("API费用估算").first()).toBeVisible({ timeout: 15_000 });
    await page.goto("/usage?tab=details");
    await expect(page.locator("thead th", { hasText: "API费用估算" })).toBeVisible();

    // F01 半开窗夹具：API 事实精确 0.00104（页面渲染经 formatMoney 取整为 ¥0.00，
    // 精确值以 API 事实断言；页面断言行存在与列命名）。
    const details = await apiGet<{ records: Array<{ requestId: string; totalApiCost: string | null }>; total: number }>(
      page, "/usage?limit=200");
    const f01 = details.records.find((record) => record.requestId === WP4_IDS.f01Request);
    expect(f01?.totalApiCost).toBe("0.00104");
    const f01Row = page.getByRole("row").filter({ has: page.getByText(WP4_IDS.f01Request) });
    await expect(f01Row).toHaveCount(1);
    await expect(f01Row.getByText("¥0.00")).toBeVisible();
    await page.screenshot({ path: screenshot("wp4-usage-estimation-column.png"), fullPage: true });
  });

  test("AFR-07：DRAFT 现行月无待补提示，有综合费用（含 API 估算）", async ({ page }, testInfo) => {
    await login(page);
    await page.goto(`/operating-bill?month=${currentMonth}`);
    await expect(page.getByText("综合费用（含 API 估算）")).toBeVisible();
    await expect(page.getByText("API费用估算").first()).toBeVisible();
    // AFR-07：待补/期初/充值/期末三卡与旧标签全部退出（现行视图）。
    await expect(page.getByText(/期初余额未登记/)).toHaveCount(0);
    await expect(page.getByText("本月总花费")).toHaveCount(0);
    await expect(page.getByText("期初余额", { exact: true })).toHaveCount(0);
    await expect(page.getByText("本月充值", { exact: true })).toHaveCount(0);
    await expect(page.getByText("期末余额", { exact: true })).toHaveCount(0);
    await expect(page.getByText("已关账版本", { exact: false })).toHaveCount(0);
    await page.screenshot({ path: screenshot("wp4-bill-draft-current-month.png"), fullPage: true });
  });

  test("AFR-07/AFR-06：CLOSED 月已关账横幅＋期初/充值/期末三卡保留", async ({ page }, testInfo) => {
    await login(page);
    await page.goto(`/operating-bill?month=${closedMonth}`);
    await expect(page.getByRole("status")).toContainText("已关账版本（历史口径，只读）");
    await expect(page.getByRole("status")).toContainText("· v1");
    // 旧口径三卡与原标签保留（冻结快照事实）。
    await expect(page.getByText("期初余额", { exact: true })).toBeVisible();
    await expect(page.getByText("本月充值", { exact: true })).toBeVisible();
    await expect(page.getByText("期末余额", { exact: true })).toBeVisible();
    await expect(page.getByText("¥1,000.00")).toBeVisible();
    await expect(page.getByText("¥100.00")).toBeVisible();
    await expect(page.getByText("¥1,004.00")).toBeVisible();
    await expect(page.getByText("本月总花费")).toBeVisible();
    await expect(page.locator("thead th", { hasText: "API 花费" })).toBeVisible();
    await expect(page.getByText("综合费用（含 API 估算）")).toHaveCount(0);
    await page.screenshot({ path: screenshot("wp4-bill-closed-banner.png"), fullPage: true });
  });

  test("AT-ACE-14：用量导出 CSV 含 API费用估算 表头", async ({ page }, testInfo) => {
    await login(page);
    const exported = await page.evaluate(async () => {
      const response = await fetch("/api/usage/export", { credentials: "same-origin" });
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type"),
        disposition: response.headers.get("content-disposition"),
        body: await response.text(),
      };
    });
    expect(exported.ok).toBe(true);
    expect(exported.contentType).toContain("text/csv");
    expect(exported.disposition).toContain("attachment");
    // WP4-S4：导出列名与页面一致（API费用估算）；F01 行金额落列。
    expect(exported.body).toContain("API费用估算");
    expect(exported.body).toContain("0.00104");
    expect(exported.body).not.toContain("API费用,");
    // CSV 响应头证据（文本归档）。
    writeFileSync(screenshot("wp4-usage-export-csv-headers.txt"), [
      `status: ${exported.status}`,
      `content-type: ${exported.contentType}`,
      `content-disposition: ${exported.disposition}`,
      `body-head:`,
      ...exported.body.split("\r\n").slice(0, 4),
    ].join("\n"), "utf8");
  });

  // ── WP5 S3a-2 新增（test 8-16）────────────────────────────────────

  test("ACE-01/02/05 请求详情：结算汇总 API费用估算 0.00104、1200 Token、attempt 按请求口径", async ({ page }) => {
    await login(page);
    await page.goto("/usage?tab=details");
    const f01Row = page.getByRole("row").filter({ has: page.getByText(WP4_IDS.f01Request) });
    await expect(f01Row).toHaveCount(1);
    await f01Row.getByRole("button", { name: "展开路由过程" }).click();
    const drilldown = page.getByRole("row").filter({ has: page.getByText("结算汇总") });
    await expect(drilldown).toHaveCount(1);
    // ACE-01（G1）：详情页结算汇总出现统一命名 "API费用估算"。
    await expect(drilldown.getByText("API费用估算", { exact: true })).toBeVisible();
    // ACE-02（G2）＋D-1（走查裁定 2026-11-04，依据 acceptance-plan §3 金额精度条款
    // "小额非零估算应能从详情查明"）：结算级 API费用估算显示精确金额 0.00104
    // （无币种处置投影 → apiCostCurrency=null 中性无符号展示，S2B/R8 定案）；
    // 不再两位舍入为中性 "0.00"（用量列表页两位舍入展示不变）。
    await expect(drilldown.getByText("0.00104", { exact: true })).toBeVisible();
    // ACE-02（G2）：token 语义——页面字段口径为"输入/缓存/输出"三个独立字段：
    // 输入 600＋缓存 400（输入侧含缓存＝1000）＋输出 200 → 真实 1200 Token
    // （acceptance §3 F01："真实 Token 1200、缓存不重复计数"）。
    const fieldValue = (label: string) =>
      drilldown.getByText(label, { exact: true }).locator("xpath=following-sibling::span");
    await expect(fieldValue("输入 Token")).toHaveText("600");
    await expect(fieldValue("缓存 Token")).toHaveText("400");
    await expect(fieldValue("输出 Token")).toHaveText("200");
    // ACE-05/ACE-09（G7）：attempt 数按请求口径＝1（一请求两表口径一致）。
    await expect(fieldValue("Attempt 数")).toHaveText("1");
    // D-1：计价决策"单价（缓存/输入/输出）"三列＝F01 规则单价 0.1/1/2 元每百万
    //（账本行无 billing_rule_snapshot → /attempts 路由层回退 billing_rule 透出）。
    await expect(fieldValue("单价（缓存/输入/输出）")).toHaveText("0.1 / 1 / 2");
    // 行级计量明细：快照币种回退 ¥0.00＋UNVERIFIED 规则角标（ACE-04 逐请求级）。
    await expect(drilldown.getByText(/估算 ¥0\.00（价格依据待核实）/).first()).toBeVisible();
    // C2 HTTP：结算级事实（8 位金额、币种 null＝中性展示、attempt=1）。
    const detail = await apiGet<{ settlement: {
      totalApiCost: string | null; apiCostStatus: string | null;
      apiCostCurrency: string | null; attemptCount: number; status: string;
    } | null }>(page, `/gateway-requests/${WP4_IDS.f01Request}`);
    expect(detail.settlement).toMatchObject({
      totalApiCost: "0.00104", apiCostStatus: "PRICED_USAGE",
      apiCostCurrency: null, attemptCount: 1, status: "SETTLED",
    });
    mkdirSync(wp5ShotDir, { recursive: true });
    await page.screenshot({ path: wp5Shot("wp5-drilldown-f01.png"), fullPage: true });
  });

  test("ACE-07 用量页：已计价 1/2 元行与'未知'缺口行；指标卡'未知'＋价格依据待核实角标", async ({ page }) => {
    await login(page);
    // G4b/G6：用量总览指标卡——窗口含 UNKNOWN_COST 行 → apiCost=null 显示"未知"
    // （不把已计价部分冒充完整总额）；F01 规则 0093 默认 UNVERIFIED → "价格依据待核实"角标。
    await page.goto("/usage");
    const costCard = page.getByRole("article").filter({ has: page.getByText("API费用估算", { exact: true }) });
    await expect(costCard).toHaveCount(1);
    await expect(costCard.getByText("未知", { exact: true })).toBeVisible();
    await expect(costCard.getByText("价格依据待核实")).toBeVisible();
    // 明细行级（G6/AT-ACE-07）：已计价 1 元、2 元照常展示；无价格行显示"未知"缺口说明。
    await page.goto("/usage?tab=details");
    const f02aRow = page.getByRole("row").filter({ has: page.getByText(WP4_IDS.f02aRequest) });
    await expect(f02aRow).toHaveCount(1);
    await expect(f02aRow.getByText("¥1.00")).toBeVisible();
    const f02bRow = page.getByRole("row").filter({ has: page.getByText(WP4_IDS.f02bRequest) });
    await expect(f02bRow).toHaveCount(1);
    await expect(f02bRow.getByText("¥2.00")).toBeVisible();
    const f02uRow = page.getByRole("row").filter({ has: page.getByText(WP4_IDS.f02uRequest) });
    await expect(f02uRow).toHaveCount(1);
    // 行内有两个 exact "未知"（客户端识别列的 agentFamily="UNKNOWN" 显示与费用列），
    // DOM 序费用列靠后 → .last() 取 API费用估算 单元格。
    await expect(f02uRow.getByText("未知", { exact: true }).last()).toBeVisible();
    await expect(f02uRow).not.toContainText("¥0.00");
    // 口径：当月已计价部分合计＝F01 0.00104＋F02 1＋2＝3.00104 CNY（同月叠加口径，
    // 既有种子其余 CNY 行无币种不入估算 amounts），精确 8 位值经下一条 test 的账单
    // HTTP apiSpends 断言；此处按行与指标卡展示浏览器证据。
    mkdirSync(wp5ShotDir, { recursive: true });
    await page.screenshot({ path: wp5Shot("wp5-usage-unknown-cost-rows.png"), fullPage: true });
  });

  test("ACE-07/13/14 账单 DRAFT：待计价说明＋综合费用（含 API 估算）＝CNY 3.00104＋USD 0.5 分列", async ({ page }) => {
    await login(page);
    await page.goto(`/operating-bill?month=${currentMonth}`);
    // G6（ACE-07）：存在 UNKNOWN 账本行 → 完整性警示＋"（含待计价）"标签，不称完整总费用。
    await expect(page.getByText("存在尚未计价的 API 请求，当前金额仅包含已确认部分。")).toBeVisible();
    await expect(page.getByText("API费用估算（含待计价）")).toBeVisible();
    // G9（ACE-13）：综合费用＝当月 API 估算＋套餐费用，期望字面值（seed 常量）：
    //   API 估算 CNY＝0.00104+1+2＝3.00104、USD＝0.5，当月套餐费用 0（无购买事件）
    //   → 页面两位显示精度 "¥3.00 / USD 0.50"；8 位精确值经下方 HTTP 断言。
    const totalStat = page.getByRole("article").filter({ has: page.getByText("综合费用（含 API 估算）") });
    await expect(totalStat).toHaveCount(1);
    await expect(totalStat).toContainText("¥3.00 / USD 0.50");
    // 套餐费用卡＝0（当月无套餐购买事件，G9 套餐分量）。
    const packageStat = page.getByRole("article").filter({ has: page.getByText("套餐费用", { exact: true }) });
    await expect(packageStat).toContainText("¥0.00");
    // G10（ACE-14）：USD 金额行带"USD"标识且与人民币分列（资源分解行的"币种不一致"
    // 原因同理——不生成无汇率依据的单一总金额）。
    await expect(page.getByText("USD 0.50").first()).toBeVisible();
    await expect(page.getByText("¥3.50", { exact: true })).toHaveCount(0);
    // HTTP：同源估算精确字面值（8 位）——apiSpends 分币种，无跨币种合并字段。
    const bill = await apiGet<{ status: string; summary: {
      apiSpends?: Array<{ currency: string; amount: string }>;
      totalSpends?: Array<{ currency: string; amount: string }>;
      apiCost: string | null; apiSpendStatus?: string; apiSpendReason?: string | null;
      packageCost: string | null;
    }; gaps: Array<{ code: string }> }>(page, `/operating-bills/${currentMonth}`);
    expect(bill.status).toBe("DRAFT");
    const expectedSpends = [
      { currency: "CNY", amount: "3.00104000" },
      { currency: "USD", amount: "0.50000000" },
    ];
    expect(bill.summary.apiSpends).toEqual(expectedSpends);
    // 综合费用 totalSpends＝apiSpends＋套餐 0 → 与 apiSpends 相同分列（G9 数值口径）。
    expect(bill.summary.totalSpends).toEqual(expectedSpends);
    expect(bill.summary.packageCost).toBe("0.00000000");
    expect(bill.summary.apiCost).toBeNull(); // 混币不合并为单一总额（G10）
    expect(bill.summary.apiSpendStatus).toBe("INCOMPLETE");
    expect(bill.summary.apiSpendReason).toBe("PRICE_MISSING:1、CURRENCY_MISSING:5");
    expect(bill.gaps.some((gap) => gap.code === "API_COST_UNKNOWN")).toBe(true);
    mkdirSync(wp5ShotDir, { recursive: true });
    await page.screenshot({ path: wp5Shot("wp5-bill-draft-partial-pricing.png"), fullPage: true });
  });

  test("OAB-03 unsupported 资源：Token 用量与费用估算照常统计", async ({ page }) => {
    await login(page);
    await page.goto("/usage?tab=details");
    // catalog zhipu 资源（/resources 页显示"暂不支持官方余额同步"，test1 已断言）
    // 当月有用量行：输入 200／输出 100 Token、估算 ¥125.00 照常统计（OAB-03 后半句）。
    const zhipuRow = page.getByRole("row").filter({ has: page.getByText(IDS.request) });
    await expect(zhipuRow).toHaveCount(1);
    await expect(zhipuRow.getByText("E2E 智谱主资源")).toBeVisible();
    await expect(zhipuRow.getByText("¥125.00")).toBeVisible();
    await expect(zhipuRow.getByText("200", { exact: true })).toBeVisible();
    await expect(zhipuRow.getByText("100", { exact: true })).toBeVisible();
    mkdirSync(wp5ShotDir, { recursive: true });
    await page.screenshot({ path: wp5Shot("wp5-usage-unsupported-tokens.png"), fullPage: true });
  });

  test("OAB-04 过期：资源列表过期标记＋保鲜值 40", async ({ page }) => {
    await login(page);
    await page.goto("/resources");
    const expiredRow = page.getByRole("row").filter({ has: page.getByText(EXPIRED_ROW_LABEL, { exact: true }) });
    await expect(expiredRow).toHaveCount(1);
    // 快照 40（collected_at 早于 P2=30 分钟阈值 2 小时）→ EXPIRED 主状态"数据过期"，
    // 保鲜值 40 照常展示（不置 0、不隐藏）。
    await expect(expiredRow.getByText("官方余额 ¥40.00")).toBeVisible();
    await expect(expiredRow.getByText("数据过期", { exact: true })).toBeVisible();
    mkdirSync(wp5ShotDir, { recursive: true });
    await expiredRow.screenshot({ path: wp5Shot("wp5-official-balance-expired.png") });
    await page.screenshot({ path: wp5Shot("wp5-resources-expired-full.png"), fullPage: true });
    // C2 API：status EXPIRED＋expired=true＋余额 40（8 位）。
    const list = await apiGet<{ resources: Array<{ id: string; official_balance: {
      status: string; expired: boolean; total_balance: string | null;
    } | null }> }>(page, "/provider-resources");
    const expired = list.resources.find((r) => r.id === WP4_IDS.expiredResource);
    expect(expired?.official_balance).toMatchObject({ status: "EXPIRED", expired: true,
      total_balance: "40.00000000" });
  });

  test("OAB-08 从未成功：暂无官方数据＋失败标记与原因，不显示 0 元", async ({ page }) => {
    await login(page);
    await page.goto("/resources");
    const neverRow = page.getByRole("row").filter({ has: page.getByText(NEVER_ROW_LABEL, { exact: true }) });
    await expect(neverRow).toHaveCount(1);
    // 无快照＋FAILED attempt → "暂无官方数据"（不冒充 0 元）＋"同步失败"标记。
    await expect(neverRow.getByText("暂无官方数据")).toBeVisible();
    await expect(neverRow.getByText("同步失败", { exact: true })).toBeVisible();
    await expect(neverRow).not.toContainText("¥0");
    mkdirSync(wp5ShotDir, { recursive: true });
    await neverRow.screenshot({ path: wp5Shot("wp5-official-balance-never-success.png") });
    // C2 API：余额 null＋失败原因（401）留痕于 last_attempt.reason。
    const list = await apiGet<{ resources: Array<{ id: string; official_balance: {
      status: string; total_balance: string | null; last_attempt_failed: boolean;
      last_attempt: { outcome: string; reason: string } | null;
    } | null }> }>(page, "/provider-resources");
    const never = list.resources.find((r) => r.id === WP4_IDS.neverResource);
    expect(never?.official_balance).toMatchObject({ status: "FAILED", total_balance: null,
      last_attempt_failed: true, last_attempt: { outcome: "FAILED" } });
    expect(never?.official_balance?.last_attempt?.reason).toContain("401");
  });

  test("OAB-09 同账户两 Key：两行各 100，无 200 合计", async ({ page }) => {
    await login(page);
    await page.goto("/resources");
    // 同账户数据层表达＝同 provider_id（states 集成夹具 :173）下两个资源各查得 100。
    const pairARow = page.getByRole("row").filter({ has: page.getByText(PAIR_A_ROW_LABEL, { exact: true }) });
    const pairBRow = page.getByRole("row").filter({ has: page.getByText(PAIR_B_ROW_LABEL, { exact: true }) });
    await expect(pairARow).toHaveCount(1);
    await expect(pairBRow).toHaveCount(1);
    await expect(pairARow.getByText("官方余额 ¥100.00")).toBeVisible();
    await expect(pairBRow.getByText("官方余额 ¥100.00")).toBeVisible();
    // 各行独立展示自身余额；页面不出现任何 200 合计（产品无账户合计字段）。
    await expect(pairARow).not.toContainText("200");
    await expect(pairBRow).not.toContainText("200");
    await expect(page.getByText("¥200.00")).toHaveCount(0);
    mkdirSync(wp5ShotDir, { recursive: true });
    await page.screenshot({ path: wp5Shot("wp5-official-balance-same-account-pair.png"), fullPage: true });
    const list = await apiGet<{ resources: Array<{ id: string; official_balance: {
      status: string; total_balance: string | null } | null }> }>(page, "/provider-resources");
    const byId = new Map(list.resources.map((r) => [r.id, r.official_balance]));
    expect(byId.get(WP4_IDS.pairAResource)).toMatchObject({ status: "OK", total_balance: "100.00000000" });
    expect(byId.get(WP4_IDS.pairBResource)).toMatchObject({ status: "OK", total_balance: "100.00000000" });
  });

  test("ACE-04 资源分解 API 行：价格依据待核实角标＋混币分列原因", async ({ page }) => {
    await login(page);
    await page.goto("/resources?tab=usage-overview");
    // "厂商总体使用情况"资源分解（按 provider+mode 分组，估算按该组资源范围同源调用）
    // ——DeepSeek WP4 E2E API 组内含 USD 行 → 金额按币种分列不合并（monthlyCost=null
    // ＋"币种不一致"原因，G10 的分解层表达），并叠加 G4b 聚合角标。
    const breakdownRow = page.getByRole("row").filter({ has: page.getByText("DeepSeek WP4 E2E", { exact: true }) });
    await expect(breakdownRow).toHaveCount(1);
    await expect(breakdownRow.getByText("API费用估算不可计算（币种不一致：CNY、USD）")).toBeVisible();
    await expect(breakdownRow.getByText("价格依据待核实")).toBeVisible();
    mkdirSync(wp5ShotDir, { recursive: true });
    await page.screenshot({ path: wp5Shot("wp5-breakdown-price-basis-badge.png"), fullPage: true });
  });

  test("OAB-13/14 供给预测：可信度/覆盖说明与'不可计算'局限文案", async ({ page }) => {
    await login(page);
    await page.goto("/resources?tab=supply-health");
    await expect(page.getByRole("heading", { name: "供给预测" })).toBeVisible();
    // G19（OAB-13）调查结论落点之一：供给预测表（数据端点 GET /supply-forecasts，每资源
    // 最新一条）自带可信度/覆盖时长列——预测以"可信度 HIGH＋覆盖 12h"表达局限属性，
    // 预计耗尽附时间；另有 quota-windows tab 的"○ 供给预测（算法估算）"口径图例。
    const zhipuForecastRow = page.getByRole("row").filter({ has: page.getByText("E2E 智谱主资源") });
    await expect(zhipuForecastRow).toHaveCount(1);
    await expect(zhipuForecastRow.getByText("HIGH")).toBeVisible();
    await expect(zhipuForecastRow.getByText("12h")).toBeVisible();
    // G20（OAB-14）：过期资源行 forecast_exhaust_at 为空 → 显示"不可计算"局限文案
    // （not_calculable_reason），不展示无时效说明的确定耗尽时间。
    const expiredForecastRow = page.getByRole("row").filter({
      has: page.getByText(EXPIRED_ROW_LABEL, { exact: true }) });
    await expect(expiredForecastRow).toHaveCount(1);
    await expect(expiredForecastRow.getByText("官方余额数据过期，暂不可计算（OAB-14 合成夹具）")).toBeVisible();
    mkdirSync(wp5ShotDir, { recursive: true });
    await page.screenshot({ path: wp5Shot("wp5-supply-forecast-not-calculable.png"), fullPage: true });
    // 口径说明图例（G19 第二落点）：供给预测标注为"算法估算"。
    await page.goto("/resources?tab=quota-windows");
    await expect(page.getByText("○ 供给预测（算法估算）")).toBeVisible();
    await page.screenshot({ path: wp5Shot("wp5-quota-window-forecast-legend.png"), fullPage: true });
  });
});
