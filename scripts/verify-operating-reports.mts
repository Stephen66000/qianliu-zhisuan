import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createKysely,
  migrateToLatest,
  ProviderFinanceRepository,
  ProviderFinanceCutoverRepository,
  savePrincipalAccounting,
} from "../packages/database/src/index.ts";
import { ensureRequestAttributionSnapshot } from "../packages/database/src/repositories/request-attribution-writer.ts";
import { startPostgresContainer } from "../packages/testing/src/index.ts";
import {
  createAnalysisFixture,
  seedAnalysisUsage,
} from "../packages/database/src/__tests-integration__/fixtures/operating-analysis.ts";
import { buildControlApi } from "../apps/control-api/src/server.ts";
import { hashPassword } from "../apps/control-api/src/auth/password.ts";
import { chromium } from "../apps/web/node_modules/@playwright/test/index.mjs";
import { createServer as createViteServer } from "../apps/web/node_modules/vite/dist/node/index.js";

const projectRoot = path.resolve();
const evidence = path.resolve("V4/Evidence/OPERATING-BILL-20260906/browser");
await mkdir(evidence, { recursive: true });
const frontPort = await new Promise<number>((resolve) => {
  const server = createNetServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    server.close(() => resolve(address.port));
  });
});
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.WEB_ORIGIN = `http://127.0.0.1:${frontPort}`;
process.env.FEATURE_DEPARTMENT_COST = "true";
process.env.FEATURE_PROCUREMENT_REVIEW = "true";
process.env.PROVIDER_FINANCE_MODE = "ACTIVE";
const pg = await startPostgresContainer("operating_browser");
const db = createKysely(pg.connectionString);
let app: ReturnType<typeof buildControlApi> | undefined,
  vite: Awaited<ReturnType<typeof createViteServer>> | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await migrateToLatest(db);
  const t = await createAnalysisFixture(db);
  const password = "Operating-Test-Only-2026!";
  await db
    .updateTable("admin_user")
    .set({
      username: "operating-browser-owner",
      display_name: "隔离验收管理员",
      password_hash: await hashPassword(password),
      must_change_password: false,
    })
    .where("id", "=", t.adminId)
    .execute();
  await savePrincipalAccounting(db, {
    enterpriseId: t.enterpriseId,
    adminId: t.adminId,
    principalId: t.a,
    departmentName: "研发部",
    expectedVersion: 0,
  });
  await savePrincipalAccounting(db, {
    enterpriseId: t.enterpriseId,
    adminId: t.adminId,
    principalId: t.b,
    departmentName: "经营部",
    expectedVersion: 0,
  });
  await savePrincipalAccounting(db, {
    enterpriseId: t.enterpriseId,
    adminId: t.adminId,
    principalId: t.project,
    ownerPrincipalId: t.a,
    expectedVersion: 0,
  });
  const finance = new ProviderFinanceRepository(db);
  await finance.recordOpeningBalance({
    enterpriseId: t.enterpriseId,
    adminId: t.adminId,
    resourceId: t.resources.get("deepseek")!,
    accountCurrency: "CNY",
    accountAmount: "100",
    occurredAt: new Date("2026-09-01T00:00:00+08:00"),
    idempotencyKey: randomUUID(),
  });
  await finance.recordRecharge({
    enterpriseId: t.enterpriseId,
    adminId: t.adminId,
    resourceId: t.resources.get("deepseek")!,
    accountCurrency: "CNY",
    accountAmount: "120",
    cashPaidCny: "100",
    occurredAt: new Date("2026-09-02T00:00:00+08:00"),
    idempotencyKey: randomUUID(),
  });
  const periods = new Map<string, string>();
  for (const [code, amount] of [
    ["kimi", "199"],
    ["zhipu", "99"],
  ]) {
    const period = await finance.recordSubscription({
      enterpriseId: t.enterpriseId,
      adminId: t.adminId,
      resourceId: t.resources.get(code!)!,
      accountCurrency: "CNY",
      accountAmount: amount!,
      cashPaidCny: amount!,
      occurredAt: new Date("2026-09-01T00:00:00+08:00"),
      kind: "PURCHASE",
      productName: code!,
      periodStart: new Date("2026-09-01T00:00:00+08:00"),
      periodEndExclusive: new Date("2026-10-01T00:00:00+08:00"),
      idempotencyKey: randomUUID(),
    });
    periods.set(code!, period.periodId);
  }
  await new ProviderFinanceCutoverRepository(db).activateStrictWrites(
    t.enterpriseId,
    t.adminId,
    "2026-09",
  );
  const settle = async (
    principal: string,
    code: string,
    tokens: bigint,
    cost = "0",
  ) => {
    const request = await seedAnalysisUsage(
      t,
      principal,
      code,
      tokens,
      new Date(),
      cost,
      "PROVIDER_REPORTED",
      periods.get(code) ?? null,
    );
    await db
      .transaction()
      .execute((trx) =>
        ensureRequestAttributionSnapshot(trx, t.enterpriseId, request),
      );
  };
  await settle(t.a, "kimi", 140000000n);
  await settle(t.b, "zhipu", 40000000n);
  await settle(t.project, "deepseek", 20000000n, "1.20");
  app = buildControlApi(db);
  const backend = await app.listen({ host: "127.0.0.1", port: 0 });
  process.env.CONTROL_API_ORIGIN = backend;
  process.chdir(path.join(projectRoot, "apps/web"));
  vite = await createViteServer({
    root: path.join(projectRoot, "apps/web"),
    configFile: path.join(projectRoot, "apps/web/vite.config.ts"),
    server: { host: "127.0.0.1", port: frontPort, strictPort: true },
    logLevel: "error",
  });
  await vite.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let reads = 0;
  page.on("response", (response) => {
    if (response.url().includes("/analysis") && response.status() === 200)
      reads++;
  });
  await page.clock.install();
  const origin = `http://127.0.0.1:${frontPort}`;
  await page.goto(origin + "/login");
  await page.getByLabel("用户名").fill("operating-browser-owner");
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/dashboard");
  await page.goto(origin + "/operating-bill?month=2026-09");
  await page
    .locator('.bill-five-stats strong[aria-label="200000000 Token"]')
    .waitFor();
  await page.screenshot({
    path: path.join(evidence, "overview.png"),
    fullPage: true,
  });
  const beforeReads = reads;
  await settle(t.a, "deepseek", 1000000n, "1.10");
  await page.clock.fastForward(31000);
  await page
    .locator('.bill-five-stats strong[aria-label="201000000 Token"]')
    .waitFor();
  if (reads <= beforeReads)
    throw new Error("30 second refresh did not read server");
  for (const [tab, heading] of [
    ["plans", "Kimi 月度 Token"],
    ["procurement", "年度采购实付"],
  ]) {
    await page.goto(origin + `/operating-bill?month=2026-09&tab=${tab}`);
    await page.getByRole("heading", { name: heading!, exact: true }).waitFor();
    await page.screenshot({
      path: path.join(evidence, tab + ".png"),
      fullPage: true,
    });
  }
  await page.goto(origin + "/operating-bill/departments?month=2026-09");
  await page.getByRole("heading", { name: "部门账", exact: true }).waitFor();
  await page.getByRole("cell", { name: "研发部", exact: true }).waitFor();
  await page
    .locator("th")
    .filter({ hasText: /^Kimi 订阅金额$/ })
    .scrollIntoViewIfNeeded();
  await page
    .locator("th")
    .filter({ hasText: /^Kimi 订阅金额$/ })
    .waitFor();
  await page.screenshot({
    path: path.join(evidence, "departments.png"),
    fullPage: true,
  });
  await page.goto(origin + "/principals");
  await page.getByRole("button", { name: "新建主体", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("新增验收同事");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "员工必须指定部门" })
    .waitFor();
  await page.getByLabel("所属部门", { exact: true }).fill("经营部");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("cell", { name: "新增验收同事", exact: true }).waitFor();
  await page.goto(origin + "/operating-bill?month=2026-09");
  await page
    .locator('.bill-five-stats strong[aria-label="67000000.00 Token"]')
    .waitFor();
  const fitted = await page
    .locator(".bill-five-stats [data-fit]")
    .evaluateAll((elements) =>
      elements.every((el) => el.scrollWidth <= el.clientWidth),
    );
  if (!fitted) throw new Error("Card text overflow");
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(
    path.join(evidence, "receipt.json"),
    JSON.stringify(
      {
        source: "isolated PostgreSQL + actual Control API + actual Web",
        login: true,
        analysisReads: reads,
        refresh30Seconds: true,
        companyTokensAfter: "201000000",
        registeredEmployeeCountAfter: 3,
        perCapitaAfter: "67000000.00",
        requiredDepartmentValidated: true,
        departmentAndOwnerLinked: true,
        cardTextFits: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Browser acceptance passed: real login, DB/API reports, 30s refresh, department report and required department / updated headcount.",
  );
} catch (error) {
  console.error(error);
  const failed = browser?.contexts()[0]?.pages()[0];
  if (failed) {
    await writeFile(
      path.join(evidence, "failure.txt"),
      failed.url() + "\n" + (await failed.locator("body").innerText()),
    );
    await failed.screenshot({
      path: path.join(evidence, "failure.png"),
      fullPage: true,
    });
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite?.close();
  await app?.close();
  await db.destroy();
  await pg.stop();
}
