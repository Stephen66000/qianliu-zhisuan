import { describe, expect, it } from "vitest";
import { companyMonthlyMetrics } from "../company-monthly-metrics.js";
import { generateCompanyWeeklySvg } from "../templates/company-weekly-svg.js";
import { renderSvgToPng } from "../render-png.js";

describe("user-confirmed monthly metrics and original layout", () => {
  it("uses real Token usage for 123.2% and keeps a negative monthly remainder", () => {
    expect(companyMonthlyMetrics("2200000000", "2709467730", "22607")).toEqual({
      allocatedTokens:"2200000000",usedTokens:"2709467730",remainingTokens:"-509467730",
      allocation:"22.0 亿",usageRate:"123.2%",remaining:"-5.1 亿",requestsWan:"2.3 万",
    });
  });
  it("formats balances and request rounding without quota-counter data", () => {
    expect(companyMonthlyMetrics("100000", "75000", "1499")).toMatchObject({usageRate:"75.0%",remaining:"2.5 万",requestsWan:"0.1 万"});
    expect(companyMonthlyMetrics("100000", "100000", "1500")).toMatchObject({usageRate:"100.0%",remaining:"0.0 万",requestsWan:"0.2 万"});
    expect(companyMonthlyMetrics("0", "0", "0")).toMatchObject({usageRate:"0.0%",remaining:"0.0 万"});
    expect(() => companyMonthlyMetrics(null,"100","1")).toThrow("MONTHLY_ALLOCATION_NOT_PROVABLE");
    expect(() => companyMonthlyMetrics("0","100","1")).toThrow("MONTHLY_USAGE_RATE_UNDEFINED");
  });
  it("renders six numeric KPIs and the approved tables at 1080x1520", async () => {
    const kpi=companyMonthlyMetrics("2200000000","2709467730","22607");
    const svg=generateCompanyWeeklySvg({enterpriseName:"仟流科技",reportMonth:"2026 年 10 月",dateRange:"2026 年 10 月 · 10.1 - 10.31",
      monthQuotaTotal:kpi.allocation,monthTokenUsageRate:kpi.usageRate,monthConsumedTokens:"27.1 亿",monthQuotaRemaining:kpi.remaining,
      totalRequests:kpi.requestsWan,totalTokens:"27.1 亿",dailyAvgTokens:"8740.2 万 /天",totalEmployees:4,totalModels:4,
      quotaRows:[{provider:"SHOULD_NOT_APPEAR",basis:"unused",detail:"历史余额待核账"}],
      topUsers:[{rank:1,name:"曹磊",department:"技术部",requests:"15,323",tokens:"19.4 亿",dailyTokens:"6265.9 万 /天",share:"71.7%"}],
      topModels:[{model:"deepseek-flash",tokens:"20.2 亿",dailyTokens:"6518.3 万 /天",requests:"16,188",share:"74.6%"},
        {model:"GLM 5.3 Flash",tokens:"4.5 亿",dailyTokens:"1441.9 万 /天",requests:"4,379",share:"16.5%"},
        {model:"GLM 5.3",tokens:"2.4 亿",dailyTokens:"779.5 万 /天",requests:"1,963",share:"8.9%"}]});
    const visible=svg.replace(/<!--[\s\S]*?-->/g, "");
    const groups=[...visible.matchAll(/<g transform="translate\([^"]+\)">([\s\S]*?)<\/g>/g)].map(m=>m[1]!);
    expect(groups).toHaveLength(6);
    const values=groups.map(g=>g.replace(/<[^>]+>/g, " ").replace(/\s+/g," ").trim());
    expect(values).toEqual(["单月分配额度 22.0 亿","当月Token使用率 123.2 %","月末剩余额度 -5.1 亿","全月总请求次数 2.3 万","全月Token使用量 27.1 亿","团队日均使用量 8740.2 万 /天"]);
    expect(visible).toContain('>成员</text>');expect(visible).toContain('>所属团队</text>');
    expect(visible).toContain('>本月热门 3 个模型</text>');expect(visible).not.toContain('成员 / 所属团队');
    expect(visible).not.toContain("Asia/Shanghai");expect(visible).not.toContain("历史余额待核账");expect(visible).not.toContain("厂商额度");
    const png=await renderSvgToPng(svg,{fitWidth:1080});expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([1080,1520]);
  });
});
