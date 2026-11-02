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
  it("renders six numeric KPIs and the approved tables with expanded section spacing", async () => {
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
    expect(values).toEqual(["当月分配额度 22.0 亿","当月Token使用率 123.2 %","月末剩余额度 -5.1 亿","当月总请求次数 2.3 万","当月Token使用量 27.1 亿","团队日均使用量 8740.2 万 /天"]);
    expect(visible).toContain('>成员</text>');expect(visible).toContain('>所属团队</text>');
    expect(visible).toContain('>本月热门 3 个模型</text>');expect(visible).not.toContain('成员 / 所属团队');
    expect(visible).toContain("Token使用量月报");expect(visible).toContain("2026年10月");expect(visible).toContain(">人员使用量</text>");expect(visible).toContain(">使用4人</text>");
    expect(visible).not.toContain("10.1 - 10.31");
    expect(visible).not.toContain("使用率＝");expect(visible).not.toContain("北京时间完整自然月");
    expect(visible).not.toContain("Asia/Shanghai");expect(visible).not.toContain("历史余额待核账");expect(visible).not.toContain("厂商额度");
    const matrix=visible.match(/matrix\(([^)]+)\)/)![1]!.split(" ").map(Number);
    expect(87*matrix[0]!+matrix[4]!).toBeCloseTo(60.9); // Each original 87px margin is reduced by 30%.
    expect(453*matrix[0]!+matrix[4]!).toBeCloseTo(479.1);
    const yFor=(text:string)=>Number(visible.match(new RegExp(`<text x="87" y="([^"]+)"[^>]*>${text}</text>`))![1]);
    const baselineGap=(760/matrix[0]!-112-(178+60+108+38))/3;
    expect((yFor("人员使用量")-56-178-14)/baselineGap).toBeCloseTo(1.5);
    expect((yFor("使用模型")-yFor("人员使用量")-60)/baselineGap).toBeCloseTo(1.5);
    const fontFor=(text:string)=>Number(visible.match(new RegExp(`<text[^>]*font-size="([^"]+)"[^>]*>${text}</text>`))![1]);
    expect(fontFor("曹磊")*matrix[0]!*2).toBeCloseTo(10.5*matrix[0]!*2-2);
    expect(fontFor("deepseek-flash")*matrix[0]!*2).toBeCloseTo(10.5*matrix[0]!*2-2);
    expect(fontFor("人员使用量")).toBe(13);expect(fontFor("成员")).toBe(10);
    const imageTag=visible.match(/<image\b[^>]+\/>/)![0];
    const attribute=(key:string)=>Number(imageTag.match(new RegExp(`\\b${key}="([^"]+)"`))![1]);
    expect(attribute("x")+attribute("width")).toBeCloseTo(479.1);
    // The bitmap compositor reads absolute image coordinates, outside the scaled text group.
    expect(visible.indexOf(imageTag)).toBeGreaterThan(visible.lastIndexOf("</g>"));
    const png=await renderSvgToPng(svg,{fitWidth:1080});expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([1080,1650]);
  });
});
