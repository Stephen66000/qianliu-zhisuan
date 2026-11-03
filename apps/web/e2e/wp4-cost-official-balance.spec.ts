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
});
