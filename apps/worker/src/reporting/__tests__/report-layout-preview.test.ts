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
    const companyData = { enterpriseName: "合成预览企业", reportTimezone: "Asia/Shanghai",
      dateRange: "10.26 - 11.1", monthQuotaTotal: "22.0 亿", monthTokenUsageRate: "123.2%", monthQuotaRemaining: "-5.1 亿",
      totalRequests: "22,607 次", totalTokens: "27.1 亿", dailyAvgTokens: "8740.2 万 /天", totalEmployees: 7, totalModels: 4,
      quotaRows, quotaAsOf: "截至10月31日", topUsers: Array.from({ length: 7 }, (_, index) => ({ rank: index + 1,
        name: index === 0 ? "欧阳测试特别长姓名成员" : `合成成员${index + 1}`, department: "跨部门人工智能产品研发与创新团队", requests: "3,229 次",
        tokens: "3.9 亿", dailyTokens: "1257.1 万 /天", share: "14.3%" })),
      topModels: [ { model: "DeepSeek V3", tokens: "15.0 亿", dailyTokens: "4838.7 万 /天", requests: "12,500 次", share: "55.4%" },
        { model: "GLM 5.3 Flash", tokens: "8.0 亿", dailyTokens: "2580.6 万 /天", requests: "6,500 次", share: "29.5%" },
        { model: "GLM 5.3", tokens: "3.0 亿", dailyTokens: "967.7 万 /天", requests: "2,000 次", share: "11.1%" } ] };
    const svg = generateCompanyWeeklySvg(companyData);
    const monthly = generateCompanyWeeklySvg({ ...companyData, reportMonth: "2026 年 10 月",
      monthQuotaTotal: "22.0 亿", monthTokenUsageRate: "123.2%", monthConsumedTokens: "27.1 亿", monthQuotaRemaining: "-5.1 亿", totalRequests: "2.3 万" });
    const personal = generatePersonalWeeklySvg({ userName: "欧阳测试特别长姓名成员", dateRange: "月度小结 2026 年 10 月", quote: "功不求疾，但求有恒",
      metrics: [ { label: "总请求次数", value: "3,229 次" }, { label: "月消耗 Token 总量", value: "3.9 亿" },
        { label: "日均使用量", value: "1257.1 万 /天" }, { label: "最晚请求时间", value: "10月31日 23:59" },
        { label: "额度截至10月31日", value: "1项超额，1项待核" }, ...quotaRows.map(row => ({ label: `${row.provider} · ${row.basis}`, value: row.detail })) ] });
    expect(svg).toContain("共 4 个，展示 Top3"); expect(svg).toContain(">GLM 5.3 Flash</text>"); expect(svg).toContain(">GLM 5.3</text>");
    expect(svg).toContain(">欧阳测…</text>");
    expect(svg).toContain(">跨部门人工…</text>");
    expect(svg).toContain(">所属团队</text>");
    for (const row of quotaRows) {
      expect(svg).not.toContain(row.detail);
      expect(personal).toContain(`${row.provider} · ${row.basis}`);
    }
    expect(svg).not.toContain("月末剩余额度</text>"); expect(svg).not.toContain("18.1");
    expect(monthly).toContain("Token使用量月报"); expect(monthly).toContain("月末剩余额度</text>"); expect(monthly).toContain("-5.1");
    expect(monthly).not.toContain("余额待核 / 暂定");
    for (const content of [svg, personal]) {
      const png = await renderSvgToPng(content, { fitWidth: 1080 });
      expect(png.readUInt32BE(16)).toBe(1080);
      expect(png.readUInt32BE(20)).toBeGreaterThan(1520);
    }
  });
});
