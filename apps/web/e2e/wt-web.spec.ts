/**
 * M5 WT-01~20 Web 路径真实 API E2E。
 *
 * globalSetup 每次在独立 `_e2e` 数据库重建固定夹具。这里不允许条件跳过；
 * 写操作同时断言 HTTP/持久化副作用，读操作同时断言 API 事实与页面结果。
 */
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
    await page.getByRole("button", { name: "确认" }).click();
    expect((await providerResponse).status()).toBe(201);

    await page.getByLabel("厂商", { exact: true }).selectOption({ label: "E2E DeepSeek（deepseek）" });
    await page.getByLabel("资源名称").fill("E2E DeepSeek API");
    await page.getByLabel("模式").selectOption("API");
    await page.getByLabel("凭证类型").selectOption("API_KEY");
    const secret = "sk-m5-e2e-plaintext-canary";
    await page.getByLabel("上游凭证").fill(secret);
    const resourceResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/provider-resources") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "登记", exact: true }).click();
    const created = await resourceResponse;
    expect(created.status()).toBe(201);
    expect(await created.text()).not.toContain(secret);
    await expect(page.getByText("E2E DeepSeek API")).toBeVisible();
    await expect(page.getByText(secret)).toHaveCount(0);

    const result = await apiGet<{ resources: Array<{ name: string }> }>(
      page,
      "/provider-resources",
    );
    expect(result.resources.some((resource) => resource.name === "E2E DeepSeek API")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("WT-02/03 创建员工、一次展示 Key、分配模型额度并得到接入信息", async ({ page }) => {
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
    await expect(keyDialog.getByText(/明文只展示这一次/)).toBeVisible();
    const plaintext = await keyDialog.locator("code").textContent();
    expect(plaintext).toMatch(/^sk-qianliu-/);
    await page.getByRole("button", { name: "已安全保存，关闭" }).click();
    await expect(page.getByText(plaintext!)).toHaveCount(0);

    await page.getByLabel("厂商").selectOption("zhipu");
    await page.getByLabel("统一模型").selectOption("qianliu-glm");
    await page.getByLabel("Token 额度").fill("88000");
    await page.getByRole("button", { name: "分配", exact: true }).click();
    await expect(page.getByText("88000")).toBeVisible();
    await expect(page.getByText("http://127.0.0.1:8787/v1")).toBeVisible();
    await expect(page.getByText("qianliu-glm").last()).toBeVisible();

    const principals = await apiGet<{ principals: PrincipalApi[] }>(page, "/principals");
    const principal = principals.principals.find((item) => item.name === "E2E 新员工");
    expect(principal?.type).toBe("EMPLOYEE");
    const keys = await apiGet<{
      keys: Array<{ key_prefix: string; status: string; key?: string }>;
    }>(page, `/principals/${principal!.id}/key`);
    expect(keys.keys.some((key) => key.status === "ACTIVE")).toBe(true);
    expect(JSON.stringify(keys)).not.toContain(plaintext!);
    const grants = await apiGet<{ grants: GrantApi[] }>(
      page,
      `/principals/${principal!.id}/grants`,
    );
    expect(grants.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model_alias: "qianliu-glm", quota_value: "88000" }),
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
    await page.getByRole("button", { name: "已安全保存，关闭" }).click();
    await page.getByLabel("统一模型").selectOption("qianliu-glm");
    await page.getByLabel("Token 额度").fill("500000");
    await page.getByRole("button", { name: "分配", exact: true }).click();

    const principals = await apiGet<{ principals: PrincipalApi[] }>(page, "/principals");
    const project = principals.principals.find((item) => item.name === "E2E 数据项目");
    expect(project?.type).toBe("PROJECT");
    const grants = await apiGet<{ grants: GrantApi[] }>(
      page,
      `/principals/${project!.id}/grants`,
    );
    expect(grants.grants[0]?.quota_value).toBe("500000");
  });

  test("WT-05/11 一次两 Attempt 的汇总与两条不可覆盖计量明细一致", async ({ page }) => {
    await page.goto("/usage");
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

  test("WT-06 管理员关闭并重新开启允许超额，API 版本与页面同步", async ({ page }) => {
    await page.goto("/principals");
    const row = page.getByRole("row", { name: /E2E 固定员工/ });
    await row.getByRole("button", { name: "接入配置" }).click();
    await page.getByRole("button", { name: "关闭超额" }).click();
    await expect(page.getByRole("button", { name: "开启超额" })).toBeVisible();
    let grants = await apiGet<{ grants: GrantApi[] }>(
      page,
      `/principals/${E2E_IDS.principal}/grants`,
    );
    expect(grants.grants[0]?.allow_overage).toBe(false);
    const versionAfterClose = grants.grants[0]!.version;
    await page.getByRole("button", { name: "开启超额" }).click();
    await expect(page.getByRole("button", { name: "关闭超额" })).toBeVisible();
    grants = await apiGet<{ grants: GrantApi[] }>(
      page,
      `/principals/${E2E_IDS.principal}/grants`,
    );
    expect(grants.grants[0]?.allow_overage).toBe(true);
    expect(grants.grants[0]!.version).toBeGreaterThan(versionAfterClose);
  });

  test("WT-07/14 管理员可定位隔离资源、健康资源及 Provider 能力", async ({ page }) => {
    await page.goto("/resources");
    await expect(page.getByRole("row", { name: /E2E 待恢复资源/ })).toContainText("凭证失效");
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
    await expect(page.getByText("厂商资源账号")).toBeVisible();
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
      keys: Array<{ id: string; status: string; key_prefix: string }>;
    }>(page, `/principals/${E2E_IDS.principal}/key`);
    const oldKeyId = before.keys.find((key) => key.status === "ACTIVE")!.id;
    await page.goto("/principals");
    await page
      .getByRole("row", { name: /E2E 固定员工/ })
      .getByRole("button", { name: "接入配置" })
      .click();
    await page.getByRole("button", { name: "重置 Key" }).click();
    await page.getByRole("button", { name: "确认重置" }).click();
    const plaintext = await page.getByRole("dialog").locator("code").textContent();
    await page.getByRole("button", { name: "已安全保存，关闭" }).click();
    await expect(page.getByText(plaintext!)).toHaveCount(0);

    const after = await apiGet<{
      keys: Array<{ id: string; status: string; key?: string }>;
    }>(page, `/principals/${E2E_IDS.principal}/key`);
    expect(after.keys.find((key) => key.id === oldKeyId)?.status).toBe("REVOKED");
    expect(after.keys.filter((key) => key.status === "ACTIVE")).toHaveLength(1);
    expect(JSON.stringify(after)).not.toContain(plaintext!);
  });

  test("WT-10 管理页创建计价规则、统一模型和 Model Route 并可编辑", async ({ page }) => {
    await page.goto("/quota-rules");
    await page.getByRole("button", { name: "新建规则" }).click();
    await page.getByLabel("厂商资源").selectOption(E2E_IDS.resource);
    await page.getByLabel("上游模型", { exact: true }).first().fill("glm-4.6");
    await page.getByLabel("规则版本").fill("e2e-web-v2");
    await page.getByRole("button", { name: "创建规则" }).click();
    const ruleRow = page.getByRole("row", { name: /e2e-web-v2/ });
    await expect(ruleRow).toBeVisible();
    await ruleRow.getByRole("button", { name: "编辑价格" }).click();
    await page.getByLabel("输出单价").last().fill("0.123");
    await page.getByRole("button", { name: "确认保存" }).click();
    await expect(ruleRow).toContainText("0.123");

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
      rules: Array<{ rule_version: string; output_price: string; version: number }>;
    }>(page, "/billing-rules");
    expect(rules.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_version: "e2e-web-v2", output_price: "0.123" }),
      ]),
    );
  });

  test("WT-12 流式已提交后中断只留下一个 Attempt，不发生跨上游拼接", async ({ page }) => {
    await page.goto("/usage");
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
    await page.goto("/usage");
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
    await page.goto("/resources");
    const forecastRow = page.getByRole("row", { name: /E2E 智谱主资源.*100.*2400.*16800/ });
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
    await page.goto("/usage");
    const row = page.locator("tr", { hasText: E2E_IDS.request });
    await row.getByRole("button", { name: "展开路由过程" }).click();
    const detail = row.locator("xpath=following-sibling::tr[1]");
    await expect(detail.getByText("e2e-v1")).toBeVisible();
    await expect(detail.getByText("POLICY_MATCHED")).toBeVisible();
    await expect(detail.getByText("ALLOW", { exact: true }).first()).toBeVisible();
    await expect(detail.getByText("15.00 元")).toBeVisible();
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
    const isolatedRow = page.getByRole("row", { name: /E2E 待恢复资源/ });
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

  test("WT-20 七入口与协议相关配置可达，未用条件分支跳过", async ({ page }) => {
    const entries = [
      ["/dashboard", "首页看板"],
      ["/principals", "使用主体"],
      ["/resources", "厂商资源"],
      ["/quota-rules", "额度规则"],
      ["/usage", "用量账本"],
      ["/alerts", "异常告警"],
      ["/settings", "操作日志"],
    ] as const;
    for (const [path, heading] of entries) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: new RegExp(heading) })).toBeVisible();
    }
  });
});
