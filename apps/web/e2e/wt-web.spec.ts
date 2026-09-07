/**
 * M5 WT-01~20 Web 路径真实 API E2E。
 *
 * globalSetup 每次在独立 `_e2e` 数据库重建固定夹具。这里不允许条件跳过；
 * 写操作同时断言 HTTP/持久化副作用，读操作同时断言 API 事实与页面结果。
 */
import { readFile } from "node:fs/promises";

import { test, expect, login, apiGet, E2E_IDS } from "./fixtures";

interface PrincipalApi {
  id: string;
  name: string;
  type: "EMPLOYEE" | "PROJECT";
  status: string;
}

interface GrantApi {
  id: string;
  principal_id: string;
  model_alias: string;
  quota_value: string;
  allow_overage: boolean;
  status: string;
  version: number;
}

test.describe.serial("M5 WT-01~20 真实 Web 闭环", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("WT-01 从管理页创建厂商并登记资源，凭证明文不回显", async ({ page }) => {
    await page.goto("/resources");
    await page.getByRole("button", { name: "登记资源" }).click();
    await page.getByRole("button", { name: "新建厂商" }).click();
    await page.getByLabel("厂商代码").selectOption("deepseek");
    await page.getByLabel("显示名称").fill("E2E DeepSeek");
    const providerResponse = page.waitForResponse(
      (response) => response.url().endsWith("/providers") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "确认", exact: true }).click();
    expect((await providerResponse).status()).toBe(201);

    await expect(page.getByLabel("厂商", { exact: true })
      .getByRole("option", { name: "E2E DeepSeek（deepseek）" })).toHaveCount(1);
    await page.getByLabel("厂商", { exact: true }).selectOption({ label: "智谱 E2E（zhipu）" });
    await expect(page.getByLabel("厂商", { exact: true }).locator("option:checked"))
      .toHaveText("智谱 E2E（zhipu）");
    await page.getByLabel("资源名称").fill("E2E 智谱 Plan");
    await page.getByLabel("模式").selectOption("CODING_PLAN");
    await page.getByLabel("凭证类型").selectOption("API_KEY");
    const secret = "sk-m5-e2e-plaintext-canary";
    await page.getByLabel("上游凭证").fill(secret);
    await page.getByLabel("厂商总额度").fill("100000");
    await page.getByLabel("生效时间").fill("2026-08-01T00:00");
    await page.getByRole("button", { name: "检测可用模型" }).click();
    await expect(page.getByText("glm-5.2", { exact: true })).toBeVisible();
    const resourceResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/provider-resources/onboard") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "确认接入" }).click();
    const created = await resourceResponse;
    expect(created.status()).toBe(201);
    expect(await created.text()).not.toContain(secret);
    await expect(page.getByRole("row", { name: /E2E 智谱 Plan/ })).toBeVisible();
    await expect(page.getByText(secret)).toHaveCount(0);

    const result = await apiGet<{ resources: Array<{ name: string }> }>(
      page,
      "/provider-resources",
    );
    expect(result.resources.some((resource) => resource.name === "E2E 智谱 Plan")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("POOL-010 Web 只录套餐规则，系统计算额度并保留历史配置", async ({ page }) => {
    await page.goto("/resources");
    const resourceRow = page.getByRole("row", {
      name: /E2E 待恢复资源.*更新套餐配置/,
    });
    await resourceRow.getByRole("button", { name: "更新套餐配置" }).click();
    await page.getByLabel("厂商总额度").fill("100000");
    await expect(page.getByLabel("厂商总额度")).toHaveValue("100,000");
    await expect(page.getByLabel("厂商已用额度")).toHaveCount(0);
    await expect(page.getByLabel("厂商剩余额度")).toHaveCount(0);
    await page.getByLabel("原生单位").fill("TOKEN");
    await page.getByLabel("套餐名称").fill("E2E 团队版");
    await page.getByLabel("套餐费用").fill("299.4");
    await page.getByLabel("套餐生效时间").fill("2026-07-01T00:00");
    await expect(page.getByLabel("套餐费用")).toHaveValue("299.40");
    await expect(page.getByLabel("重置周期").getByRole("option", { name: "每季" }))
      .toHaveAttribute("value", "QUARTERLY");
    await expect(page.getByLabel("重置周期").getByRole("option", { name: "每年" }))
      .toHaveAttribute("value", "YEARLY");
    await page.getByLabel("重置周期").selectOption("QUARTERLY");
    await page.getByLabel("重置日期").fill("2026-08-01T00:00");
    const firstPatch = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/provider-resources/${E2E_IDS.isolatedResource}`) &&
        response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "追加快照" }).click();
    expect((await firstPatch).status()).toBe(200);

    await resourceRow.getByRole("button", { name: "更新套餐配置" }).click();
    await expect(page.getByText("v1 · ADMIN")).toBeVisible();
    await expect(page.getByLabel("重置周期")).toHaveValue("QUARTERLY");
    await expect(page.getByText(/每季 ·/)).toBeVisible();
    await expect(page.getByText(/CNY 299\.40/)).toBeVisible();
    await page.getByLabel("套餐费用").fill("399.001");
    await page.getByRole("button", { name: "追加快照" }).click();
    await expect(page.getByRole("alert")).toContainText("套餐费用：请输入非负金额，最多保留两位小数");
    await page.getByLabel("套餐费用").fill("399");
    const secondPatch = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/provider-resources/${E2E_IDS.isolatedResource}`) &&
        response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "追加快照" }).click();
    expect((await secondPatch).status()).toBe(200);

    await resourceRow.getByRole("button", { name: "更新套餐配置" }).click();
    await expect(page.getByText("v2 · ADMIN")).toBeVisible();
    await expect(page.getByText("v1 · ADMIN")).toBeVisible();
    await expect(page.getByText("系统已用额度")).toBeVisible();
    await expect(page.getByText("系统剩余额度")).toBeVisible();
    await expect(page.getByText("下一次重置日期")).toBeVisible();

    const history = await apiGet<{
      snapshots: Array<{
        version: number;
        total_quota: string;
        used_quota: string | null;
        remaining_quota: string | null;
        package_cost: string;
        usage_calculation: string;
      }>;
    }>(page, `/provider-resources/${E2E_IDS.isolatedResource}/operating-snapshots`);
    expect(history.snapshots.slice(0, 2).map((snapshot) => snapshot.version)).toEqual([2, 1]);
    expect(history.snapshots[0]).toMatchObject({
      total_quota: "100000.00000000",
      used_quota: null,
      remaining_quota: null,
      package_cost: "399.00000000",
      usage_calculation: "SYSTEM_LEDGER",
    });
    expect(history.snapshots[1]).toMatchObject({
      total_quota: "100000.00000000",
      used_quota: null,
      remaining_quota: null,
      package_cost: "299.40000000",
      usage_calculation: "SYSTEM_LEDGER",
    });

    await page.goto("/resources?tab=usage-overview");
    await expect(page.getByText("厂商总额度", { exact: true })).toBeVisible();
    await expect(page.getByText("已分配给主体", { exact: true })).toBeVisible();
    await expect(page.getByText(/200,000 TOKEN/)).toBeVisible();
  });

  test("POOL-042 用量总览展示 DeepSeek 余额、账本 Token、速度和模型明细", async ({ page }) => {
    await page.goto("/resources?tab=usage-overview");
    const providerSection = page.getByRole("heading", { name: "厂商总体使用情况" })
      .locator("xpath=ancestor::section[1]");
    const row = providerSection.getByRole("row", { name: /DeepSeek Token E2E.*API/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("CNY 1,000.00");
    await expect(row).toContainText("8.00");
    await expect(row).toContainText("430");
    await expect(row).toContainText("17.92 Token/小时");
    await expect(page.getByText("ql-deepseek-v4-flash")).toBeVisible();
    await expect(page.getByText("ql-deepseek-v4-pro")).toBeVisible();
    await expect(page.getByText("按模型查看")).toHaveCount(0);

    const overview = await apiGet<{
      providerSummaries: Array<{
        providerCode: string; monthlyTotalTokens: string | null;
      }>;
      modelDetails: Array<{ modelAlias: string; resourceId: string }>;
    }>(page, "/provider-resources/usage-overview");
    expect(overview.providerSummaries.find((item) => item.providerCode === "pool042-deepseek"))
      .toMatchObject({ monthlyTotalTokens: "430" });
    expect(overview.modelDetails.map((item) => item.modelAlias)).toEqual(
      expect.arrayContaining(["ql-deepseek-v4-flash", "ql-deepseek-v4-pro"]),
    );
  });

  test("WT-02/03 创建员工、一次展示 Key、分配模型额度并得到接入信息", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/principals");
    await page.getByRole("button", { name: "新建主体" }).click();
    await page.getByLabel("名称").fill("E2E 新员工");
    await page.getByLabel("部门/标签（可选）").fill("产品部");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const row = page.getByRole("row", { name: /E2E 新员工/ });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "接入配置" }).click();

    const keyResponse = page.waitForResponse(
      (response) =>
        /\/principals\/[^/]+\/key$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "生成 Key" }).click();
    expect((await keyResponse).status()).toBe(201);
    const keyDialog = page.getByRole("dialog");
    await expect(keyDialog.getByText(/明文仅保留在当前页面内存/)).toBeVisible();
    const plaintext = await keyDialog.locator("code").textContent();
    expect(plaintext).toMatch(/^sk-qianliu-/);
    await page.getByRole("button", { name: "继续配置" }).click();
    await expect(page.getByText(plaintext!)).toBeVisible();

    const zhipuProvider = page.getByRole("button", { name: "智谱 E2E 开通" });
    await zhipuProvider.locator('input[type="checkbox"]').check();
    await page.getByLabel("Token 额度").fill("88000");
    await expect(page.getByLabel("Token 额度")).toHaveValue("88,000");
    const accessConfigResponse = page.waitForResponse(
      (response) =>
        /\/principals\/[^/]+\/access-configuration$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "保存并生效" }).click();
    expect((await accessConfigResponse).status()).toBe(200);
    await expect(page.getByText("已保存")).toBeVisible();
    await expect(page.getByText(/88,000/).first()).toBeVisible();
    await expect(page.getByText("http://127.0.0.1:8787/v1")).toBeVisible();
    await expect(page.getByText("qianliu-glm").last()).toBeVisible();
    await page.getByRole("button", { name: "复制接入信息" }).click();
    await expect(page.getByRole("status")).toHaveText("复制成功");
    const copiedConnectionInfo = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedConnectionInfo).toContain("Base URL: http://127.0.0.1:8787/v1");
    expect(copiedConnectionInfo).toContain(`API Key: ${plaintext}`);
    expect(copiedConnectionInfo).toContain("Models: qianliu-glm");
    expect(copiedConnectionInfo).not.toContain("••••");
    await page.getByRole("button", { name: "清除一次性 Key" }).click();
    await expect(page.getByText(plaintext!)).toHaveCount(0);

    const principals = await apiGet<{ principals: PrincipalApi[] }>(page, "/principals");
    const principal = principals.principals.find((item) => item.name === "E2E 新员工");
    expect(principal?.type).toBe("EMPLOYEE");
    const keys = await apiGet<{
      keys: Array<{
        key_prefix: string;
        status: string;
        key?: string;
        allowed_model_ids: string[];
      }>;
    }>(page, `/principals/${principal!.id}/key`);
    expect(
      keys.keys.some(
        (key) =>
          key.status === "ACTIVE" &&
          key.allowed_model_ids.includes(E2E_IDS.model),
      ),
    ).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(plaintext!);
    const grants = await apiGet<{ grants: GrantApi[] }>(
      page,
      `/principals/${principal!.id}/grants`,
    );
    expect(grants.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "zhipu",
          model_alias: "*",
          pool_model_alias: "*",
          quota_value: "88000",
        }),
      ]),
    );
  });

  test("WT-04 项目主体按同样顺序完成 Key 与资源分配", async ({ page }) => {
    await page.goto("/principals");
    await page.getByRole("button", { name: "新建主体" }).click();
    await page.getByLabel("类型").selectOption("PROJECT");
    await page.getByLabel("名称").fill("E2E 数据项目");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const row = page.getByRole("row", { name: /E2E 数据项目/ });
    await row.getByRole("button", { name: "接入配置" }).click();
    await page.getByRole("button", { name: "生成 Key" }).click();
    await page.getByRole("button", { name: "继续配置" }).click();
    const zhipuProvider = page.getByRole("button", { name: "智谱 E2E 开通" });
    await zhipuProvider.locator('input[type="checkbox"]').check();
    await page.getByLabel("Token 额度").fill("500000");
    await page.getByRole("button", { name: "保存并生效" }).click();
    await expect(page.getByText("已保存")).toBeVisible();

    const principals = await apiGet<{ principals: PrincipalApi[] }>(page, "/principals");
    const project = principals.principals.find((item) => item.name === "E2E 数据项目");
    expect(project?.type).toBe("PROJECT");
    const keys = await apiGet<{
      keys: Array<{ status: string; allowed_model_ids: string[] }>;
    }>(page, `/principals/${project!.id}/key`);
    expect(
      keys.keys.some(
        (key) =>
          key.status === "ACTIVE" &&
          key.allowed_model_ids.includes(E2E_IDS.model),
      ),
    ).toBe(true);
    const grants = await apiGet<{ grants: GrantApi[] }>(
      page,
      `/principals/${project!.id}/grants`,
    );
    expect(grants.grants[0]?.quota_value).toBe("500000");
  });

  test("用量账本默认进入概览，显式切换后能查请求明细", async ({ page }) => {
    await page.goto("/usage");
    await expect(page.getByRole("heading", { name: "消耗排名" })).toBeVisible();
    await expect(page.getByLabel("用量主体类型")).toHaveValue("EMPLOYEE");
    await expect(page.getByLabel("状态", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "请求明细", exact: true }).click();
    await expect(page.locator("tbody tr", { hasText: E2E_IDS.request })).toHaveCount(1);
  });

  test("WT-05/11 一次两 Attempt 的汇总与两条不可覆盖计量明细一致", async ({ page }) => {
    await page.goto("/usage?tab=details");
    const row = page.locator("tr", { hasText: E2E_IDS.request });
    await expect(row).toContainText("200");
    await expect(row).toContainText("100");
    await expect(row).toContainText("20");
    await expect(row).toContainText("320");
    await expect(row).toContainText("125.00");
    await row.getByRole("button", { name: "展开路由过程" }).click();
    const detail = row.locator("xpath=following-sibling::tr[1]");
    await expect(detail.getByText("Attempt 数").locator("..")).toContainText("2");
    await expect(detail.getByText("#1")).toBeVisible();
    await expect(detail.getByText("#2")).toBeVisible();
    await expect(detail.getByText(/输入 40 · 输出 10 · 缓存 5/)).toBeVisible();
    await expect(detail.getByText(/输入 160 · 输出 90 · 缓存 15/)).toBeVisible();

    const attempts = await apiGet<{
      attempts: Array<{ attemptNo: number; metering: Array<{ inputTokens: string }> }>;
      ledgerLines: Array<{ inputTokens: string; outputTokens: string }>;
    }>(page, `/gateway-requests/${E2E_IDS.request}/attempts`);
    expect(attempts.attempts).toHaveLength(2);
    expect(attempts.ledgerLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputTokens: "40", outputTokens: "10" }),
        expect.objectContaining({ inputTokens: "160", outputTokens: "90" }),
      ]),
    );
  });

  test("POOL-012 用量组合筛选可由 URL 复现，显示最终资源并可一键清除", async ({ page }) => {
    const query = new URLSearchParams({
      search: E2E_IDS.request.slice(0, 18),
      principal_id: E2E_IDS.principal,
      client_id: "m5-playwright",
      unified_model: "qianliu-glm",
      status: "SUCCEEDED",
      overage_only: "true",
    });
    await page.goto(`/usage?${query}`);
    await page.getByLabel("厂商筛选").selectOption({ label: "智谱 E2E" });
    await page.getByLabel("厂商资源").selectOption({ label: "E2E 智谱主资源" });

    await expect(page.getByLabel("搜索主体、姓名或项目")).toHaveValue(
      E2E_IDS.request.slice(0, 18),
    );
    await expect(page.getByLabel("主体", { exact: true })).toHaveValue(E2E_IDS.principal);
    await expect(page.getByLabel("厂商筛选")).not.toHaveValue("");
    await expect(page.getByLabel("厂商资源")).toHaveValue(E2E_IDS.resource);
    await expect(page.getByLabel("只看超额")).toBeChecked();
    const row = page.locator("tbody tr", { hasText: E2E_IDS.request });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("E2E 智谱主资源");
    await expect(page.getByText(/共 1 条/)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("只看超额")).toBeChecked();
    await expect(page.locator("tbody tr", { hasText: E2E_IDS.request })).toHaveCount(1);

    await page.getByRole("button", { name: "清除筛选" }).click();
    await expect(page).toHaveURL(/\/usage\?tab=details$/);
    await expect(page.getByLabel("只看超额")).not.toBeChecked();
    await expect(page.locator("tbody tr", { hasText: E2E_IDS.streamRequest })).toHaveCount(1);
  });

  test("WT-06 管理员关闭并重新开启允许超额，API 版本与页面同步", async ({ page }) => {
    await page.goto("/principals");
    const row = page.getByRole("row", { name: /E2E 固定员工/ });
    await row.getByRole("button", { name: "接入配置" }).click();
    const accessPanel = page.getByRole("region", { name: "接入配置" });
    const zhipuProvider = accessPanel.getByRole("button", { name: /智谱 E2E.*开通/ });
    await zhipuProvider.locator('input[type="checkbox"]').check();
    await accessPanel.getByLabel("Token 额度").fill("100000");
    let saveResponse = page.waitForResponse(
      (response) =>
        /\/principals\/[^/]+\/access-configuration$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "PUT",
    );
    await accessPanel.getByRole("button", { name: "保存并生效" }).click();
    expect((await saveResponse).status()).toBe(200);
    let grants = await apiGet<{ grants: GrantApi[] }>(
      page,
      `/principals/${E2E_IDS.principal}/grants`,
    );
    const managedGrantAfterClose = grants.grants.find((grant) => grant.model_alias === "*");
    expect(managedGrantAfterClose?.allow_overage).toBe(false);
    const versionAfterClose = managedGrantAfterClose!.version;
    await accessPanel.getByRole("button", { name: /智谱 E2E.*开通/ }).click();
    await accessPanel.getByLabel("允许超额").check();
    saveResponse = page.waitForResponse(
      (response) =>
        /\/principals\/[^/]+\/access-configuration$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "PUT",
    );
    await accessPanel.getByRole("button", { name: "保存并生效" }).click();
    expect((await saveResponse).status()).toBe(200);
    grants = await apiGet<{ grants: GrantApi[] }>(
      page,
      `/principals/${E2E_IDS.principal}/grants`,
    );
    const managedGrantAfterOpen = grants.grants.find((grant) => grant.model_alias === "*");
    expect(managedGrantAfterOpen?.allow_overage).toBe(true);
    expect(managedGrantAfterOpen!.version).toBeGreaterThan(versionAfterClose);
  });

  test("WT-07/14 管理员可定位隔离资源、健康资源及 Provider 能力", async ({ page }) => {
    await page.goto("/resources");
    await expect(page.getByRole("row", {
      name: /E2E 待恢复资源.*更新套餐配置/,
    })).toContainText("凭证失效");
    const healthyRow = page.getByRole("row", { name: /E2E 智谱主资源.*正常/ });
    await expect(healthyRow).toContainText("正常");
    await expect(healthyRow).toContainText("glm-4.6");
    const providers = await apiGet<{
      providers: Array<{ code: string; supported_protocols: string[] }>;
    }>(page, "/providers");
    expect(providers.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "zhipu",
          supported_protocols: expect.arrayContaining(["chat", "messages"]),
        }),
      ]),
    );
  });

  test("WT-08 首页异常可进入告警处置，写入 operation_log", async ({ page }) => {
    await expect(page.getByText("厂商接入账号")).toBeVisible();
    await expect(page.getByText("最早耗尽资源")).toBeVisible();
    await page.goto("/alerts");
    await expect(page.getByText("凭证失效：E2E 待恢复资源")).toBeVisible();
    const alertCard = page.locator("div.rounded-xl", {
      hasText: "凭证失效：E2E 待恢复资源",
    });
    const dispositionResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/alerts/disposition") &&
        response.request().method() === "POST",
    );
    await alertCard.getByRole("button", { name: "标记已处理" }).click();
    expect((await dispositionResponse).status()).toBe(200);
    const logs = await apiGet<{
      logs: Array<{ action: string; change_summary: Record<string, unknown> }>;
    }>(page, "/operation-logs?limit=100");
    expect(logs.logs.some((log) => log.action === "alert.disposition")).toBe(true);
  });

  test("WT-09 重置 Key 后旧 Key 撤销且新明文仍只展示一次", async ({ page }) => {
    const before = await apiGet<{
      keys: Array<{
        id: string;
        status: string;
        key_prefix: string;
        allowed_model_ids: string[];
      }>;
    }>(page, `/principals/${E2E_IDS.principal}/key`);
    const oldKey = before.keys.find((key) => key.status === "ACTIVE")!;
    await page.goto("/principals");
    await page
      .getByRole("row", { name: /E2E 固定员工/ })
      .getByRole("button", { name: "接入配置" })
      .click();
    await page.getByRole("button", { name: "重置 Key" }).click();
    await page.getByRole("button", { name: "确认重置" }).click();
    const plaintext = await page.getByRole("dialog").locator("code").textContent();
    await page.getByRole("button", { name: "继续配置" }).click();
    await page.getByRole("button", { name: "清除一次性 Key" }).click();
    await expect(page.getByText(plaintext!)).toHaveCount(0);

    const after = await apiGet<{
      keys: Array<{
        id: string;
        status: string;
        key?: string;
        allowed_model_ids: string[];
      }>;
    }>(page, `/principals/${E2E_IDS.principal}/key`);
    expect(after.keys.find((key) => key.id === oldKey.id)?.status).toBe("REVOKED");
    expect(after.keys.filter((key) => key.status === "ACTIVE")).toHaveLength(1);
    expect(
      [...(after.keys.find((key) => key.status === "ACTIVE")?.allowed_model_ids ?? [])].sort(),
    ).toEqual([...oldKey.allowed_model_ids].sort());
    expect(JSON.stringify(after)).not.toContain(plaintext!);
  });

  test("WT-10 管理页创建多窗口版本化计价规则、统一模型和 Model Route", async ({ page }) => {
    await page.goto("/quota-rules");
    await page.getByRole("button", { name: "新建规则" }).click();
    await page.getByLabel("启用 Model Route").selectOption({ label: "E2E 智谱主资源 · glm-4.6" });
    await page.getByLabel("规则版本").fill("e2e-web-v2");
    await page.getByLabel("输出单价").fill("0.123");
    await page.getByRole("button", { name: "添加窗口" }).click();
    await page.getByRole("button", { name: "添加窗口" }).click();
    await page.getByLabel("开始（含）").nth(1).fill("14:00");
    await page.getByLabel("结束（不含）").nth(1).fill("18:00");
    await page.getByRole("button", { name: "创建规则" }).click();
    const ruleRow = page.getByRole("row", { name: /e2e-web-v2/ });
    await expect(ruleRow).toBeVisible();
    await expect(ruleRow).toContainText("0.123");
    await expect(ruleRow).toContainText("09:00–12:00");
    await expect(ruleRow).toContainText("14:00–18:00");

    await page.getByRole("button", { name: "新建统一模型" }).click();
    await page.getByLabel("模型别名").fill("qianliu-e2e-web");
    await page.getByLabel("显示名称").fill("仟流 E2E Web");
    await page.getByRole("button", { name: "创建模型" }).click();
    const modelRow = page.getByRole("row", { name: /qianliu-e2e-web/ });
    await expect(modelRow).toBeVisible();
    await modelRow.getByRole("button", { name: "管理路由" }).click();
    await page.getByRole("button", { name: "新建路由" }).click();
    await page.getByLabel("厂商资源").last().selectOption(E2E_IDS.resource);
    await page.getByLabel("上游模型").last().fill("glm-4.6");
    await page.getByLabel("优先级").last().fill("30");
    await page.getByLabel("权重").fill("3");
    await page.getByRole("button", { name: "创建路由" }).click();
    await expect(page.getByRole("row", { name: /glm-4.6.*30.*3/ })).toBeVisible();

    const models = await apiGet<{
      models: Array<{ id: string; alias: string; version: number }>;
    }>(page, "/unified-models");
    const model = models.models.find((item) => item.alias === "qianliu-e2e-web");
    const routes = await apiGet<{
      routes: Array<{ priority: number; weight: number; enabled: boolean }>;
    }>(page, `/unified-models/${model!.id}/routes`);
    expect(routes.routes).toEqual(
      expect.arrayContaining([expect.objectContaining({ priority: 30, weight: 3, enabled: true })]),
    );
    const rules = await apiGet<{
      rules: Array<{
        rule_version: string;
        output_price: string;
        version: number;
        time_windows: Array<{ start_time: string; end_time: string }>;
      }>;
    }>(page, "/billing-rules");
    expect(rules.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_version: "e2e-web-v2",
          output_price: "0.123",
          time_windows: [
            expect.objectContaining({ start_time: "09:00", end_time: "12:00" }),
            expect.objectContaining({ start_time: "14:00", end_time: "18:00" }),
          ],
        }),
      ]),
    );
  });

  test("WT-12 流式已提交后中断只留下一个 Attempt，不发生跨上游拼接", async ({ page }) => {
    await page.goto("/usage?tab=details");
    const row = page.locator("tr", { hasText: E2E_IDS.streamRequest });
    await expect(row).toContainText("失败");
    await row.getByRole("button", { name: "展开路由过程" }).click();
    const detail = row.locator("xpath=following-sibling::tr[1]");
    await expect(detail.getByText("流式已提交")).toBeVisible();
    await expect(detail.getByText("STREAM_INTERRUPTED")).toBeVisible();
    const attempts = await apiGet<{
      attempts: Array<{ responseCommitted: boolean; errorClassification: string }>;
    }>(page, `/gateway-requests/${E2E_IDS.streamRequest}/attempts`);
    expect(attempts.attempts).toHaveLength(1);
    expect(attempts.attempts[0]).toEqual(
      expect.objectContaining({
        responseCommitted: true,
        errorClassification: "STREAM_INTERRUPTED",
      }),
    );
  });

  test("WT-13/18 路由明细展示完整评分因子且不含会话正文", async ({ page }) => {
    await page.goto("/usage?tab=details");
    const row = page.locator("tr", { hasText: E2E_IDS.request });
    await row.getByRole("button", { name: "展开路由过程" }).click();
    const detail = row.locator("xpath=following-sibling::tr[1]");
    for (const factor of [
      "static_priority",
      "load",
      "error_rate",
      "latency_ms",
      "quota_remaining",
      "reset_at",
      "cost",
      "affinity",
    ]) {
      await expect(detail.getByText(new RegExp(factor)).first()).toBeVisible();
    }
    const candidates = await apiGet<{ candidates: Array<{ scoreFactors: unknown }> }>(
      page,
      `/gateway-requests/${E2E_IDS.request}/route-candidates`,
    );
    const serialized = JSON.stringify(candidates);
    expect(serialized).toContain("affinity");
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("prompt");
  });

  test("WT-15 页面展示速度、耗尽、恢复、覆盖时长与可信度", async ({ page }) => {
    await page.goto("/resources?tab=supply-health");
    const forecastRow = page.locator("#supply-forecasts")
      .getByRole("row", { name: /E2E 智谱主资源.*100.*2400.*16800/ });
    await expect(forecastRow).toContainText("12h");
    await expect(forecastRow).toContainText("HIGH");
    const forecasts = await apiGet<{
      forecasts: Array<{ provider_resource_id: string; coverage_hours: string; confidence: string }>;
    }>(page, "/supply-forecasts");
    expect(forecasts.forecasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_resource_id: E2E_IDS.resource,
          coverage_hours: "12",
          confidence: "HIGH",
        }),
      ]),
    );
  });

  test("WT-16/17 调度页解释输入、命中策略、动作、反事实和实际节省", async ({ page }) => {
    await page.goto("/usage?tab=details");
    const row = page.locator("tr", { hasText: E2E_IDS.request });
    await row.getByRole("button", { name: "展开路由过程" }).click();
    const detail = row.locator("xpath=following-sibling::tr[1]");
    await expect(detail.getByText("e2e-v1", { exact: true }).first()).toBeVisible();
    await expect(detail.getByText("POLICY_MATCHED")).toBeVisible();
    await expect(detail.getByText("ALLOW", { exact: true }).first()).toBeVisible();
    await expect(detail.getByText("15.00 元")).toBeVisible();
    await detail.getByText("技术详情（调度输入快照）", { exact: true }).click();
    await expect(detail.getByText(/selectedResourceId/)).toBeVisible();
    const decision = await apiGet<{
      decision: {
        counterfactualCost: string;
        actualCost: string;
        dispatchSaving: string;
        savingCalculable: boolean;
      };
    }>(page, `/gateway-requests/${E2E_IDS.request}/dispatch-decision`);
    expect(decision.decision).toEqual(
      expect.objectContaining({
        counterfactualCost: "140",
        actualCost: "125",
        dispatchSaving: "15",
        savingCalculable: true,
      }),
    );
  });

  test("WT-19 隔离资源经二次确认受控恢复，其他健康资源不受影响", async ({ page }) => {
    await page.goto("/resources");
    const isolatedRow = page.getByRole("row", {
      name: /E2E 待恢复资源.*更新套餐配置/,
    });
    await isolatedRow.getByRole("button", { name: "恢复" }).click();
    await expect(page.getByRole("dialog")).toContainText("不轮换凭证");
    const recoverResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/provider-resources/${E2E_IDS.isolatedResource}/recover`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "确认恢复" }).click();
    expect((await recoverResponse).status()).toBe(200);
    await expect(isolatedRow).toContainText("降级");
    await expect(page.getByRole("row", { name: /E2E 智谱主资源.*正常/ })).toContainText("正常");
    const resources = await apiGet<{
      resources: Array<{ id: string; status: string }>;
    }>(page, "/provider-resources");
    expect(resources.resources.find((resource) => resource.id === E2E_IDS.isolatedResource)?.status).toBe(
      "DEGRADED",
    );
    expect(resources.resources.find((resource) => resource.id === E2E_IDS.resource)?.status).toBe(
      "ACTIVE",
    );
  });

  test("POOL-011 页面按真实依赖顺序展示并阻止无前置配置", async ({ page }) => {
    await page.goto("/quota-rules");
    const headings = {
      model: page.getByRole("heading", { name: "统一模型" }),
      route: page.getByRole("heading", { name: "Model Route" }),
      rule: page.getByRole("heading", { name: "计价规则模板" }),
      dispatch: page.getByRole("heading", { name: "调度策略" }),
    };
    const boxes = await Promise.all([
      headings.model.boundingBox(),
      headings.route.boundingBox(),
      headings.rule.boundingBox(),
      headings.dispatch.boundingBox(),
    ]);
    expect(boxes.every(Boolean)).toBe(true);
    expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
    expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
    expect(boxes[2]!.y).toBeLessThan(boxes[3]!.y);
    await expect(page.getByText(/第 1 步：先定义/)).toBeVisible();
    await expect(page.getByText(/第 2 步：为统一模型绑定/)).toBeVisible();
    await expect(page.getByRole("button", { name: "新建路由" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "新建规则" })).toBeEnabled();
  });

  test("POOL-009 Web 完成主体编辑、安全删除与历史归档", async ({ page }) => {
    await page.goto("/principals");
    await page.getByRole("button", { name: "新建主体" }).click();
    await page.getByLabel("名称").fill("POOL009 E2E 可清理");
    await page.getByLabel("部门/标签（可选）").fill("临时验收");
    await page.getByRole("button", { name: "创建", exact: true }).click();

    let transientRow = page.getByRole("row", { name: /POOL009 E2E 可清理/ });
    await transientRow.getByRole("button", { name: "编辑" }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "编辑主体" })).toBeVisible();
    await dialog.getByLabel("名称").fill("POOL009 E2E 已编辑");
    await dialog.getByLabel("部门/标签（可选）").fill("待删除");
    await dialog.getByRole("button", { name: "保存修改" }).click();
    transientRow = page.getByRole("row", { name: /POOL009 E2E 已编辑.*待删除/ });
    await expect(transientRow).toBeVisible();
    await transientRow.getByRole("button", { name: "清理" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "删除主体" })).toBeVisible();
    await expect(dialog).toContainText("没有请求、Usage 或账本历史");
    await dialog.getByRole("button", { name: "确认删除" }).click();
    await expect(transientRow).toHaveCount(0);

    let historicalRow = page.getByRole("row", { name: /E2E 固定员工/ });
    await historicalRow.getByRole("button", { name: "编辑" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "编辑主体" })).toBeVisible();
    await dialog.getByLabel("名称").fill("E2E 固定员工已归档");
    await dialog.getByLabel("部门/标签（可选）").fill("历史保留");
    await dialog.getByRole("button", { name: "保存修改" }).click();
    historicalRow = page.getByRole("row", { name: /E2E 固定员工已归档/ });
    await historicalRow.getByRole("button", { name: "清理" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "归档主体" })).toBeVisible();
    await expect(dialog).toContainText(/已有 .* 条请求/);
    await expect(dialog).toContainText("历史数据继续保留");
    await dialog.getByRole("button", { name: "确认归档" }).click();
    await expect(historicalRow).toHaveCount(0);

    await page.getByLabel("显示范围").selectOption("archived");
    await expect(page.getByRole("row", { name: /E2E 固定员工已归档.*历史保留.*已归档/ })).toBeVisible();
    await page.goto("/usage?search=E2E%20固定员工已归档");
    await expect(page.locator("tbody tr", { hasText: E2E_IDS.request })).toHaveCount(1);
  });

  test("WT-20 九个主入口可达，批量授权收入使用主体", async ({ page }) => {
    const entries = [
      ["/dashboard", "首页看板"],
      ["/principals", "使用主体"],
      ["/resources", "厂商资源"],
      ["/quota-rules", "额度规则"],
      ["/usage", "用量账本"],
      ["/operating-bill", "经营账单"],
      ["/runtime-assurance", "运行保障"],
      ["/admins", "管理员管理"],
      ["/settings", "系统设置"],
    ] as const;
    for (const [path, heading] of entries) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    await page.goto("/employee-model-rules");
    await expect(page).toHaveURL(/\/principals\?tab=batch-authorization/);
    await expect(page.getByRole("heading", { name: "使用主体", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "批量模型授权", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "返回首页看板" })).toHaveAttribute("href", "/dashboard");
  });

  test("WT-21 厂商资源可原地从 Plan 修改为 Z Plan，凭证与资源 ID 不变", async ({ page }) => {
    await page.goto("/resources");
    const before = await apiGet<{
      resources: Array<{
        id: string;
        name: string;
        credential_fingerprint: string;
      }>;
    }>(page, "/provider-resources");
    const targetBefore = before.resources.find((resource) => resource.name === "E2E 智谱 Plan");
    expect(targetBefore).toBeDefined();

    const row = page.getByRole("row", { name: /E2E 智谱 Plan/ });
    await row.getByRole("button", { name: "编辑" }).click();
    await page.getByLabel("资源名称").last().fill("E2E 智谱 Z Plan");
    await expect(page.getByLabel("上游模型")).toHaveCount(0);
    await page.getByLabel("并发上限").fill("8");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByRole("row", { name: /E2E 智谱 Z Plan/ })).toBeVisible();

    const after = await apiGet<{
      resources: Array<{
        id: string;
        name: string;
        credential_fingerprint: string;
        upstream_models: string[];
        concurrency_limit: number;
      }>;
    }>(page, "/provider-resources");
    expect(after.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: targetBefore!.id,
          name: "E2E 智谱 Z Plan",
          credential_fingerprint: targetBefore!.credential_fingerprint,
          upstream_models: ["glm-5.2", "glm-4.7", "glm-4.6"],
          concurrency_limit: 8,
        }),
      ]),
    );
  });

  test("WT-22 调度策略经草稿、校验、确认发布、停用完整闭环", async ({ page }) => {
    await page.goto("/quota-rules");
    await page.getByRole("button", { name: "新建调度策略" }).click();
    await page.getByLabel("策略版本").fill("e2e-zhipu-peak-v1");
    await page.locator("#policy-model").selectOption("qianliu-glm");
    await page.locator("#policy-resource").selectOption(E2E_IDS.resource);
    await page.locator("#policy-mode").selectOption("CODING_PLAN");
    await page.locator("#policy-start").fill("14:00");
    await page.locator("#policy-end").fill("18:00");
    await page.locator("#policy-action").selectOption("REJECT");
    await page.getByRole("button", { name: "创建草稿" }).click();

    const policyRow = page.getByRole("row", { name: /e2e-zhipu-peak-v1/ });
    await expect(policyRow).toContainText("DRAFT");
    await policyRow.getByRole("button", { name: "校验" }).click();
    await expect(policyRow).toContainText("VALIDATED");
    await policyRow.getByRole("button", { name: "发布" }).click();
    await page.getByRole("button", { name: "确认发布" }).click();
    await expect(policyRow).toContainText("PUBLISHED");
    await policyRow.getByRole("button", { name: "停用" }).click();
    await page.getByRole("button", { name: "确认停用" }).click();
    await expect(policyRow).toContainText("RETIRED");
    await policyRow.getByRole("button", { name: "复制为新版本" }).click();
    await expect(page.getByRole("row", { name: /e2e-zhipu-peak-v2.*DRAFT/ })).toBeVisible();
    await policyRow.getByRole("button", { name: "恢复原配置" }).click();
    await expect(page.getByRole("dialog")).toContainText("历史版本继续保持 RETIRED");
    await page.getByRole("button", { name: "确认恢复并发布" }).click();
    await expect(page.getByRole("row", { name: /e2e-zhipu-peak-v3.*PUBLISHED/ })).toBeVisible();
    await expect(policyRow).toContainText("RETIRED");

    const policies = await apiGet<{
      policies: Array<{ policyVersion: string; action: string; status: string }>;
    }>(page, "/dispatch-policies");
    expect(policies.policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policyVersion: "e2e-zhipu-peak-v1",
          action: "REJECT",
          status: "RETIRED",
        }),
      ]),
    );
  });

  test("POOL-016 调度策略按名称选择主体并可编辑草稿为全部主体", async ({ page }) => {
    await page.goto("/quota-rules");
    await page.getByRole("button", { name: "新建调度策略" }).click();
    await page.getByLabel("策略版本").fill("pool016-selected-v1");
    await page.getByLabel("指定主体").click();
    await page.getByLabel("搜索主体").fill("E2E 新员工");
    await page.getByLabel(/E2E 新员工/).check();
    await page.getByLabel("搜索主体").fill("");
    await page.getByLabel(/E2E 数据项目/).check();
    await page.getByRole("button", { name: "创建草稿" }).click();

    const row = page.getByRole("row", { name: /pool016-selected-v1/ });
    await expect(row).toContainText("E2E 新员工");
    await expect(row).toContainText("E2E 数据项目");
    await row.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByLabel("指定主体")).toBeChecked();
    await page.getByLabel("全部主体").click();
    const patchResponse = page.waitForResponse(
      (response) => /\/dispatch-policies\/[0-9a-f-]+$/.test(new URL(response.url()).pathname)
        && response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "保存草稿" }).click();
    expect((await patchResponse).status()).toBe(200);
    await expect(row).toContainText("全部主体");

    const policies = await apiGet<{
      policies: Array<{ policyVersion: string; matchPrincipalScope: string[] | null }>;
    }>(page, "/dispatch-policies");
    expect(policies.policies.find((policy) => policy.policyVersion === "pool016-selected-v1"))
      .toMatchObject({ matchPrincipalScope: null });

    const historicalCreated = await page.evaluate(async (principalId) => {
      const response = await fetch("/api/dispatch-policies", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          match_principal_scope: [principalId],
          action: "REJECT",
          policy_version: "pool016-history-v1",
          priority: 120,
          description: "历史主体只读回显",
        }),
      });
      return { status: response.status, body: await response.text() };
    }, E2E_IDS.principal);
    expect(historicalCreated.status, historicalCreated.body).toBe(201);
    await page.reload();
    const historicalRow = page.getByRole("row", { name: /pool016-history-v1/ });
    await expect(historicalRow).toContainText("E2E 固定员工已归档");
    await historicalRow.getByRole("button", { name: "编辑" }).click();
    const historicalCheckbox = page.getByLabel(/E2E 固定员工已归档/);
    await expect(historicalCheckbox).toBeChecked();
    await expect(historicalCheckbox).toBeDisabled();
    await expect(page.getByText(/已停用\/归档，仅历史回显/)).toBeVisible();
  });

  test("RA-WT-18 运行保障五区可达，旧 /alerts 链接跳转异常中心", async ({ page }) => {
    await page.goto("/runtime-assurance");
    await expect(page.getByRole("heading", { name: "运行保障" })).toBeVisible();
    for (const tab of ["运行态势", "可用性规则", "熔断事件", "异常中心", "通知与人员"]) {
      await expect(page.getByRole("tab", { name: tab })).toBeVisible();
    }
    await page.goto("/alerts");
    await expect(page).toHaveURL(/\/runtime-assurance\?tab=alerts$/);
    await expect(page.getByText("凭证失效：E2E 待恢复资源")).toBeVisible();
    if (process.env.RA_EVIDENCE_SCREENSHOT) {
      await page.screenshot({ fullPage: true, path: process.env.RA_EVIDENCE_SCREENSHOT });
    }
  });

  test("POOL-025 月度经营账单真实读写、价值确认与结账冻结闭环", async ({ page }) => {
    await page.goto("/operating-bill?month=2026-07");
    await expect(page.getByRole("heading", { name: "经营账单" })).toBeVisible();
    for (const tab of ["月度总览", "员工账", "项目账", "套餐利用分析", "价值确认", "结账管理"]) {
      await expect(page.getByRole("link", { name: tab })).toBeVisible();
    }
    await expect(page.getByText("原型演示数据")).toHaveCount(0);

    await page.getByRole("link", { name: "价值确认" }).click();
    await page.getByPlaceholder("价值事项").fill("E2E 客户项目按期验收");
    await page.getByPlaceholder("金额").fill("100000");
    await page.getByPlaceholder("证据引用").fill("E2E-POOL-025-验收单");
    await page.getByRole("button", { name: "保存待确认" }).click();
    const valueRow = page.getByRole("row", { name: /E2E 客户项目按期验收/ });
    await expect(valueRow).toBeVisible();
    await valueRow.getByRole("button", { name: "确认" }).click();
    await expect(valueRow).toContainText("已确认");

    await page.getByRole("link", { name: "结账管理" }).click();
    const confirmationSelectors = page.getByRole("combobox", { name: /确认状态/ });
    await expect(confirmationSelectors.first()).toBeVisible();
    const confirmationCount = await confirmationSelectors.count();
    for (let index = 0; index < confirmationCount; index += 1) {
      const selector = confirmationSelectors.nth(index);
      await selector.selectOption("CONFIRMED");
      const confirmationResponse = page.waitForResponse((response) =>
        response.url().includes("/resource-confirmations/") && response.request().method() === "PUT");
      await selector.locator("xpath=ancestor::tr").getByRole("button", { name: "保存确认" }).click();
      expect((await confirmationResponse).status()).toBe(200);
    }
    const note = page.getByLabel("结账说明");
    await note.fill("E2E 授权结账；测试夹具中缺失的厂商历史事实已作为例外冻结");
    await page.getByRole("button", { name: "确认结账并冻结" }).click();
    await expect(page.getByText("已结账 v1")).toBeVisible();

    const frozen = await apiGet<{ status: string; version: number; values: Array<{ status: string }> }>(page, "/operating-bills/2026-07");
    expect(frozen).toMatchObject({ status: "CLOSED", version: 1 });
    expect(frozen.values).toEqual(expect.arrayContaining([expect.objectContaining({ status: "CONFIRMED" })]));
  });

  test("POOL-043 员工账按厂商／模型下钻请求，项目账为独立入口", async ({ page }) => {
    await page.goto("/operating-bill/employees?month=2026-08");
    await expect(page.getByRole("heading", { name: "经营账单" })).toBeVisible();
    await expect(page.getByRole("link", { name: "员工账" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "项目账" })).toBeVisible();

    await page.getByLabel("搜索员工").fill("于滔");
    const employeeRow = page.getByRole("row", { name: /于滔/ });
    await expect(employeeRow).toContainText("DeepSeek");
    await employeeRow.getByRole("link", { name: "于滔" }).click();
    await expect(page).toHaveURL(/\/operating-bill\/employees\/[0-9a-f-]+\?month=2026-08/);
    await expect(page.getByRole("heading", { name: "于滔" })).toBeVisible();

    await page.getByRole("button", { name: /DeepSeek/ }).click();
    const flashRow = page.getByRole("row", { name: /ql-deepseek-v4-flash/ });
    const proRow = page.getByRole("row", { name: /ql-deepseek-v4-pro/ });
    await expect(flashRow).toBeVisible();
    await expect(proRow).toBeVisible();
    await flashRow.getByRole("button", { name: "查看请求明细" }).click();

    const requestRow = page.locator("tbody tr", { hasText: "ql-deepseek-v4-flash" }).last();
    await expect(requestRow).toContainText("180");
    await expect(requestRow).toContainText("150 / 30 / 20");
    await expect(requestRow).toContainText("¥3.20");
    await expect(requestRow).toContainText("成功");
    await expect(requestRow).toContainText("精确用量");
    await expect(requestRow).toContainText("2026-08-08 09:00:00");

    await page.goto("/operating-bill/projects?month=2026-08");
    await expect(page.getByRole("link", { name: "项目账" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText(/项目账 · 哪个项目产生了多少成本/)).toBeVisible();
    await expect(page.getByRole("row", { name: /未归属项目/ })).toBeVisible();
    const projectsBefore = await apiGet<{
      rows: Array<{ subjectId: string | null; totals: { requestCount: number } }>;
    }>(page, "/operating-bills/2026-08/projects");
    const unassignedBefore = projectsBefore.rows.find((row) => row.subjectId === null)?.totals.requestCount;
    expect(unassignedBefore).toBeGreaterThan(0);
    await page.getByLabel("待归属请求 ID").fill(E2E_IDS.pool043FlashRequest);
    await page.getByLabel("归属项目").selectOption(E2E_IDS.pool043Project);
    const assignmentResponse = page.waitForResponse((response) =>
      response.url().endsWith("/operating-bills/2026-08/project-assignments")
      && response.request().method() === "POST");
    await page.getByRole("button", { name: "保存归属" }).click();
    expect((await assignmentResponse).status()).toBe(204);
    await expect(page.getByRole("row", { name: /POOL-043 星河项目/ })).toContainText("1 次");
    await expect(page.getByRole("row", { name: /未归属项目/ }))
      .toContainText(`${unassignedBefore! - 1} 次`);

    const projectAccounts = await apiGet<{
      rows: Array<{ subjectId: string | null; totals: { requestCount: number } }>;
    }>(page, "/operating-bills/2026-08/projects");
    expect(projectAccounts.rows.find((row) => row.subjectId === E2E_IDS.pool043Project)?.totals.requestCount)
      .toBe(1);
    expect(projectAccounts.rows.find((row) => row.subjectId === null)?.totals.requestCount)
      .toBe(unassignedBefore! - 1);
    const logs = await apiGet<{
      logs: Array<{ action: string; target_id: string | null; result: string }>;
    }>(page, "/operation-logs?limit=100");
    expect(logs.logs).toEqual(expect.arrayContaining([expect.objectContaining({
      action: "operating_bill.project.assign",
      target_id: E2E_IDS.pool043FlashRequest,
      result: "SUCCESS",
    })]));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/operating-bill/employees?month=2026-08");
    await expect(page.getByLabel("主导航")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("POOL-015 管理员创建、重置、强制首次改密和会话切换闭环", async ({ page }) => {
    await page.goto("/admins");
    await page.getByLabel("管理员用户名").fill("e2e-ops");
    await page.getByLabel("管理员显示名称").fill("运维验收管理员");
    await page.getByLabel("管理员初始密码").fill("E2e-Initial-Admin!2026");
    await page.getByRole("button", { name: "创建管理员" }).click();
    await expect(page.getByText("E2e-Initial-Admin!2026")).toBeVisible();

    const row = page.getByRole("row", { name: /e2e-ops/ });
    await expect(row.getByLabel("e2e-ops 显示名称")).toHaveValue("运维验收管理员");
    await row.getByRole("button", { name: "重置密码" }).click();
    await page.getByLabel("重置后的新密码").fill("E2e-Reset-Admin!2026");
    await page.getByRole("button", { name: "确认重置" }).click();
    await expect(page.getByText("E2e-Reset-Admin!2026")).toBeVisible();

    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("用户名").fill("e2e-ops");
    await page.getByLabel("密码").fill("E2e-Reset-Admin!2026");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page).toHaveURL(/\/change-password$/);
    await page.getByLabel("当前密码").fill("E2e-Reset-Admin!2026");
    await page.getByLabel("新密码", { exact: true }).fill("E2e-Final-Admin!2026");
    await page.getByLabel("确认新密码").fill("E2e-Final-Admin!2026");
    await page.getByRole("button", { name: "确认修改并重新登录" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel("用户名").fill("e2e-ops");
    await page.getByLabel("密码").fill("E2e-Final-Admin!2026");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText("运维验收管理员")).toBeVisible();
  });

  test("POOL-029 员工使用规则校验、发布、历史与停用形成真实 Web 闭环", async ({ page }) => {
    const suffix = Date.now();
    const principalName = `POOL-029 E2E 员工 ${suffix}`;
    const ruleName = `POOL-029 E2E 规则 ${suffix}`;
    await page.goto("/principals");
    await page.getByRole("button", { name: "新建主体" }).click();
    await page.getByLabel("名称").fill(principalName);
    await page.getByLabel("部门/标签（可选）").fill("模型授权验收");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const principalRow = page.getByRole("row", { name: new RegExp(principalName) });
    await principalRow.getByRole("button", { name: "接入配置" }).click();
    const keyResponse = page.waitForResponse((response) =>
      /\/principals\/[^/]+\/key$/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST");
    await page.getByRole("button", { name: "生成 Key" }).click();
    expect((await keyResponse).status()).toBe(201);
    await page.getByRole("button", { name: "继续配置" }).click();

    await page.goto("/employee-model-rules");
    await expect(page).toHaveURL(/\/principals\?tab=batch-authorization/);
    await expect(page.getByRole("heading", { name: "批量模型授权", exact: true })).toBeVisible();
    await page.getByLabel("规则名称").fill(ruleName);
    await page.getByLabel("Token 额度").fill("660000");
    await page.getByLabel(new RegExp(principalName)).check();
    await page.getByLabel(/仟流 GLM · E2E 智谱主资源/).check();
    const createResponse = page.waitForResponse((response) =>
      response.url().endsWith("/employee-model-rules") && response.request().method() === "POST");
    await page.getByRole("button", { name: "创建草稿" }).click();
    expect((await createResponse).status()).toBe(201);

    const ruleRow = page.getByRole("row", { name: new RegExp(ruleName) });
    const validateResponse = page.waitForResponse((response) =>
      response.url().endsWith("/validate") && response.request().method() === "POST");
    await ruleRow.getByRole("button", { name: "校验" }).click();
    expect((await validateResponse).status()).toBe(200);
    await expect(ruleRow).toContainText("新增 1 / 保留 0 / 撤销 0");
    const publishResponse = page.waitForResponse((response) =>
      response.url().endsWith("/publish") && response.request().method() === "POST");
    await ruleRow.getByRole("button", { name: "发布" }).click();
    expect((await publishResponse).status()).toBe(200);
    await expect(ruleRow).toContainText("PUBLISHED");

    const principals = await apiGet<{ principals: PrincipalApi[] }>(page, "/principals");
    const principal = principals.principals.find((item) => item.name === principalName);
    expect(principal).toBeDefined();
    const keys = await apiGet<{ keys: Array<{ allowed_model_ids: string[]; status: string }> }>(page, `/principals/${principal!.id}/key`);
    expect(keys.keys.find((key) => key.status === "ACTIVE")?.allowed_model_ids).toContain(E2E_IDS.model);
    const grants = await apiGet<{ grants: Array<GrantApi & { authorization_rule_version_id?: string | null }> }>(page, `/principals/${principal!.id}/grants`);
    expect(grants.grants).toEqual(expect.arrayContaining([expect.objectContaining({
      provider: "zhipu",
      model_alias: "*",
      pool_model_alias: "*",
      quota_value: "660000",
      status: "ACTIVE",
      authorization_rule_version_id: expect.any(String),
    })]));

    await ruleRow.getByRole("button", { name: "历史" }).click();
    await expect(page.getByRole("region", { name: "规则版本历史" })).toContainText("v1");
    const disableResponse = page.waitForResponse((response) =>
      response.url().endsWith("/disable") && response.request().method() === "POST");
    await ruleRow.getByRole("button", { name: "停用" }).click();
    expect((await disableResponse).status()).toBe(200);
    await expect(ruleRow).toContainText("DISABLED");
    const revokedKeys = await apiGet<{ keys: Array<{ allowed_model_ids: string[]; status: string }> }>(page, `/principals/${principal!.id}/key`);
    const catalogAfterDisable = await apiGet<{
      models: Array<{
        unified_model_id: string;
        provider_code: string;
        ready: boolean;
      }>;
    }>(page, "/employee-model-rules/catalog");
    const expectedPoolModels = catalogAfterDisable.models
      .filter((model) => model.provider_code === "zhipu" && model.ready
        && model.unified_model_id !== E2E_IDS.model)
      .map((model) => model.unified_model_id)
      .sort();
    expect([
      ...(revokedKeys.keys.find((key) => key.status === "ACTIVE")?.allowed_model_ids ?? []),
    ].sort()).toEqual(expectedPoolModels);
  });

  test("W20-02~09 七项 2.0 增量从真实页面与 API 可达", async ({ page }) => {
    await page.goto("/principals");
    await page.getByRole("button", { name: "组织通讯录" }).click();
    await expect(page.getByRole("heading", { name: "接口单向同步" })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载模板" }).click();
    const template = await downloadPromise;
    expect(template.suggestedFilename()).toBe("仟流智算-通讯录导入模板-v1.xlsx");
    const templatePath = await template.path();
    expect(templatePath).not.toBeNull();
    const uploadResponse = page.waitForResponse((response) =>
      response.url().endsWith("/directory-excel-imports")
      && response.request().method() === "POST");
    await page.locator('input[type="file"]').setInputFiles({
      buffer: await readFile(templatePath!),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name: template.suggestedFilename(),
    });
    expect((await uploadResponse).status()).toBe(202);
    await expect(page.getByRole("heading", { name: "最近处理结果" })).toBeVisible();
    await expect(page.getByText("示例员工", { exact: true })).toBeVisible();

    await page.goto("/usage?tab=overview&period=MONTH&subject_type=EMPLOYEE");
    await expect(page.getByLabel("用量主体类型")).toHaveValue("EMPLOYEE");
    await expect(page.getByRole("button", { name: "本月", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "消耗排名" })).toBeVisible();
    await expect(page.getByRole("link", { name: "查看请求明细" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByLabel("用量主体类型")).toHaveValue("EMPLOYEE");
    await expect(page.getByRole("button", { name: "本月", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.goto("/quota-rules");
    await page.getByRole("button", { name: "部门预算 · 2.0" }).click();
    await expect(page.getByRole("heading", { name: /部门预算/ })).toBeVisible();
    await page.getByLabel("部门预算月份").fill("2026-08");
    const departmentRow = page.getByRole("row", { name: /E2E 研发部/ });
    await departmentRow.getByLabel("E2E 研发部月度预算").fill("500");
    await departmentRow.getByLabel("E2E 研发部警戒线").fill("0.75");
    const budgetResponse = page.waitForResponse((response) =>
      response.url().includes("/department-budgets/")
      && response.url().endsWith("/2026-08")
      && response.request().method() === "PUT");
    await departmentRow.getByRole("button", { name: "保存" }).click();
    const savedBudgetResponse = await budgetResponse;
    expect(savedBudgetResponse.status()).toBe(201);
    expect(await savedBudgetResponse.json()).toMatchObject({
      budget: {
        departmentName: "E2E 研发部",
        amount: "500.00000000",
        warningThreshold: "0.75000000",
        version: 1,
      },
      replayed: false,
    });
    await expect(departmentRow.getByLabel("E2E 研发部月度预算")).toHaveValue("500.00000000");
    await expect(departmentRow.getByLabel("E2E 研发部警戒线")).toHaveValue("0.75000000");
    const savedBudget = await apiGet<{
      budget: { amount: string; warningThreshold: string; version: number };
    }>(page, `${new URL(savedBudgetResponse.url()).pathname.replace(/^\/api/, "")}`);
    expect(savedBudget.budget).toMatchObject({
      amount: "500.00000000", warningThreshold: "0.75000000", version: 1,
    });

    await page.goto("/resources");
    await expect(page.getByRole("heading", { name: "资源利用事实" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "利用率" })).toBeVisible();
    await page.getByLabel("资源利用月份").fill("2026-08");
    const utilizationRow = page.locator("#resource-utilization")
      .getByRole("row", { name: /E2E 智谱主资源/ });
    await expect(utilizationRow).not.toContainText("账本明细");
    await expect(page.getByRole("columnheader", { name: "耗尽 / 恢复 / 速度" })).toHaveCount(0);
    await page.getByRole("tab", { name: "用量总览" }).click();
    await expect(page.getByRole("heading", { name: "厂商总体使用情况" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "模型使用明细" })).toBeVisible();

    await page.goto("/operating-bill/departments?month=2026-08");
    await expect(page.getByRole("heading", { name: "部门成本与预算" })).toBeVisible();
    await expect(page.getByText("归集守恒", { exact: true })).toBeVisible();

    await page.goto("/operating-bill?month=2026-08&tab=procurement");
    await expect(page.getByRole("heading", { name: "采购利用复盘" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "采购复盘备注（人工填写）" })).toBeVisible();
    const reviewNote = `E2E 采购复盘 ${Date.now()}`;
    await page.getByLabel("采购复盘备注").fill(reviewNote);
    const noteResponse = page.waitForResponse((response) =>
      response.url().endsWith("/procurement-reviews/2026-08/note")
      && response.request().method() === "PUT");
    await page.getByRole("button", { name: "保存备注" }).click();
    const savedNoteResponse = await noteResponse;
    expect(savedNoteResponse.status()).toBe(200);
    expect(await savedNoteResponse.json()).toMatchObject({ note: reviewNote, version: 1 });
    await expect(page.getByLabel("采购复盘备注")).toHaveValue(reviewNote);
    await expect(page.getByText("当前版本 v1", { exact: false })).toBeVisible();
    const savedReview = await apiGet<{
      note: { text: string; version: number; updatedAt: string; updatedBy: string | null };
    }>(page, "/procurement-reviews/2026-08");
    expect(savedReview.note).toEqual({
      text: reviewNote,
      version: 1,
      updatedAt: expect.any(String),
      updatedBy: "管理员",
    });

    await page.goto("/operating-bill?month=2026-08&tab=reconciliation");
    await expect(page.getByText("Coming Soon", { exact: true })).toBeVisible();
    await expect(page.getByText("不调用未注册 API", { exact: false })).toBeVisible();
  });
});
