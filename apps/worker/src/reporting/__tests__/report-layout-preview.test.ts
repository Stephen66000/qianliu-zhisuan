import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateCompanyWeeklySvg } from "../templates/company-weekly-svg.js";
import { generatePersonalWeeklySvg } from "../templates/personal-weekly-svg.js";
import { renderSvgToPng } from "../render-png.js";

/** Synthetic layout stress fixture; amounts are illustrative, never production evidence. */
describe("1080px reporting layout previews", () => {
  it("keeps seven members, distinct Flash models and three quota units/states readable", async () => {
    const quotaRows = [
      { provider: "DeepSeek", basis: "实际 Token", detail: "分配 1.0 亿 · 已用 1.2 亿 · 超额 2000.0 万" },
      { provider: "智谱", basis: "套餐折算额度", detail: "分配 1.0 亿 · 已用 4000.0 万 · 可用 6000.0 万" },
      { provider: "Kimi", basis: "套餐折算额度", detail: "已证使用 0.0 万 · 预占 500.0 万 · 余额待核 / 暂定" },
    ];
    const svg = generateCompanyWeeklySvg({ enterpriseName: "合成预览企业", reportMonth: "2026 年 10 月", reportTimezone: "Asia/Shanghai",
      dateRange: "2026 年 10 月 · 10.1 - 10.31", monthQuotaTotal: "3个厂商池", monthConsumedTokens: "1项超额，1项待核", monthQuotaRemaining: "历史策略待核",
      totalRequests: "22,607 次", totalTokens: "27.1 亿", dailyAvgTokens: "8740.2 万 /天", totalEmployees: 7, totalModels: 4,
      quotaRows, quotaAsOf: "截至10月31日", topUsers: Array.from({ length: 7 }, (_, index) => ({ rank: index + 1,
        name: index === 0 ? "欧阳测试特别长姓名成员" : `合成成员${index + 1}`, department: "跨部门人工智能产品研发与创新团队", requests: "3,229 次",
        tokens: "3.9 亿", dailyTokens: "1257.1 万 /天", share: "14.3%" })),
      topModels: [ { model: "DeepSeek V3", tokens: "15.0 亿", dailyTokens: "4838.7 万 /天", requests: "12,500 次", share: "55.4%" },
        { model: "GLM 5.3 Flash", tokens: "8.0 亿", dailyTokens: "2580.6 万 /天", requests: "6,500 次", share: "29.5%" },
        { model: "GLM 5.3", tokens: "3.0 亿", dailyTokens: "967.7 万 /天", requests: "2,000 次", share: "11.1%" } ] });
    const personal = generatePersonalWeeklySvg({ userName: "欧阳测试特别长姓名成员", dateRange: "月度小结 2026 年 10 月", quote: "功不求疾，但求有恒",
      metrics: [ { label: "总请求次数", value: "3,229 次" }, { label: "月消耗 Token 总量", value: "3.9 亿" },
        { label: "日均使用量", value: "1257.1 万 /天" }, { label: "最晚请求时间", value: "10月31日 23:59" },
        { label: "额度截至10月31日", value: "1项超额，1项待核" }, ...quotaRows.map(row => ({ label: `${row.provider} · ${row.basis}`, value: row.detail })) ] });
    expect(svg).toContain("共 4 个，展示 Top3"); expect(svg).toContain(">GLM 5.3 Flash</text>"); expect(svg).toContain(">GLM 5.3</text>");
    expect(svg).not.toContain("月末剩余额度</text>"); expect(svg).not.toContain("18.1");
    const directory = fileURLToPath(new URL("../../../../../V4/Evidence/EMPLOYEE-QUOTA-REPORTING-20261101/reporting/", import.meta.url)); await mkdir(directory, { recursive: true });
    for (const [name, content] of [["synthetic-seven-member-three-provider", svg], ["synthetic-long-name-personal", personal]] as const) {
      const png = await renderSvgToPng(content, { fitWidth: 1080 }); expect(png.readUInt32BE(16)).toBe(1080); expect(png.readUInt32BE(20)).toBeGreaterThan(1520);
      await writeFile(resolve(directory, `${name}.svg`), content); await writeFile(resolve(directory, `${name}.png`), png);
    }
  });
});
