import { describe, expect, it } from "vitest";
import { renderSvgToPng } from "../render-png.js";
import { generatePersonalWeeklySvg, type PersonalWeeklyReportData } from "../templates/personal-weekly-svg.js";
import { generateCompanyWeeklySvg, type CompanyWeeklyReportData } from "../templates/company-weekly-svg.js";
import { generateIncentiveTop1Svg, type IncentiveTop1ReportData } from "../templates/incentive-top1-svg.js";
import { generateIncentiveOver50Svg, type IncentiveOver50ReportData } from "../templates/incentive-over50-svg.js";
import { generateDailyTokenReportSvg, type DailyTokenReportData } from "../templates/daily-token-report-svg.js";

function assertValidPng(pngBuffer: Buffer): void {
  expect(pngBuffer).toBeInstanceOf(Buffer);
  expect(pngBuffer.length).toBeGreaterThan(2000);
  // PNG magic number: 0x89 0x50 0x4E 0x47
  expect(pngBuffer[0]).toBe(0x89);
  expect(pngBuffer[1]).toBe(0x50);
  expect(pngBuffer[2]).toBe(0x4e);
  expect(pngBuffer[3]).toBe(0x47);
}

describe("SVG Templates & PNG Rendering Pipeline", () => {
  it("场景一：generatePersonalWeeklySvg (个人周报小结)", () => {
    const data: PersonalWeeklyReportData = {
      userName: "张三",
      dateRange: "一周小结 9.7-9.11",
      quote: "功不求疾，但求有恒",
      metrics: [
        { label: "总请求次数", value: "75", unit: "次" },
        { label: "周消耗 Token 总量", value: "32.9", unit: "万" },
        { label: "日均使用量", value: "4.7", unit: "万 /天" },
        { label: "最晚请求时间", value: "周四深夜 23:15" },
      ],
    };

    const svg = generatePersonalWeeklySvg(data);

    // 校验画布与卡片
    expect(svg).toContain('viewBox="47 65 446 635"');
    expect(svg).toContain('width="540"');
    expect(svg).toContain('fill="#FFFFFF"'); // 纯白底色
    expect(svg).not.toContain('fill="#EEF2F6"');
    expect(svg).toContain("张三");
    expect(svg).toContain("一周小结 9.7-9.11");
    expect(svg).toContain("功不求疾，但求有恒");
    expect(svg).toContain("总请求次数");
    expect(svg).toContain("32.9 万");
    expect(svg).toContain("仟流智算");
    expect(svg).toContain("Qianliu IC");

    // 严禁包含 Emoji
    expect(svg).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

    // 渲染 PNG 并验证
    const png = renderSvgToPng(svg);
    assertValidPng(png);
  });

  it("场景一：generatePersonalWeeklySvg 支持 5 项指标自适应收缩", () => {
    const data: PersonalWeeklyReportData = {
      userName: "李四",
      dateRange: "一周小结 9.7-9.11",
      metrics: [
        { label: "总请求次数", value: "120", unit: "次" },
        { label: "周消耗 Token 总量", value: "85.2", unit: "万" },
        { label: "日均使用量", value: "12.2", unit: "万 /天" },
        { label: "最晚请求时间", value: "周五 21:30" },
        { label: "核心主力模型", value: "DeepSeek V3" },
      ],
    };

    const svg = generatePersonalWeeklySvg(data);
    expect(svg).toContain("核心主力模型");
    expect(svg).toContain("DeepSeek V3");

    const png = renderSvgToPng(svg);
    assertValidPng(png);
  });

  it("场景二：generateCompanyWeeklySvg (全员用量看板)", () => {
    const data: CompanyWeeklyReportData = {
      enterpriseName: "仟流智算创新科技",
      dateRange: "9.7 - 9.13",
      monthQuotaTotal: "500.0 万",
      monthConsumedTokens: "128.5 万",
      monthQuotaRemaining: "371.5 万",
      totalRequests: "10,450 次",
      totalTokens: "384.3 万",
      dailyAvgTokens: "54.9 万 /天",
      topUsers: [
        {
          rank: 1,
          name: "张三",
          department: "算法研发部",
          requests: "1,250",
          tokens: "128.0 万",
          dailyTokens: "18.3 万 /天",
          share: "33.3%",
        },
        {
          rank: 2,
          name: "李四",
          department: "平台工程部",
          requests: "980",
          tokens: "95.5 万",
          dailyTokens: "13.6 万 /天",
          share: "24.8%",
        },
      ],
      topModels: [
        {
          model: "DeepSeek V3",
          tokens: "235.0 万",
          dailyTokens: "33.6 万 /天",
          requests: "6,800",
          share: "61.2%",
        },
        {
          model: "GLM 5.3",
          tokens: "110.0 万",
          dailyTokens: "15.7 万 /天",
          requests: "2,500",
          share: "28.6%",
        },
      ],
    };

    const svg = generateCompanyWeeklySvg(data);

    expect(svg).toContain("仟流智算创新科技 · 全员用量周报");
    expect(svg).toContain("9.7 - 9.13");
    expect(svg).toContain("本月总 Token");
    expect(svg).toContain("Token 消耗总量");
    expect(svg).toContain("剩余 Token 总量");
    expect(svg).toContain("500.0");
    expect(svg).toContain("128.5");
    expect(svg).toContain("371.5");
    expect(svg).toContain("10,450");
    expect(svg).toContain("384.3");
    expect(svg).toContain("54.9");
    expect(svg).toContain("全员使用量");
    expect(svg).toContain("使用模型");
    expect(svg).toContain("DeepSeek V3");

    // 严禁包含 Emoji
    expect(svg).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

    const png = renderSvgToPng(svg);
    assertValidPng(png);
  });

  it("场景三(a)：generateIncentiveTop1Svg (登顶第 1 名流动红旗)", () => {
    const data: IncentiveTop1ReportData = {
      userName: "张三",
      periodLabel: "登顶周榜首 · 9.7-9.13 (第37周)",
      weeklyTokens: "128.0 万",
      teamShare: "33.3%",
      exceededPercent: "超越全员 99% 同事",
      topModel: "DeepSeek V3",
    };

    const svg = generateIncentiveTop1Svg(data);

    expect(svg).toContain("登顶周榜首");
    expect(svg).toContain("独行快，众行远；引领者无畏");
    expect(svg).toContain("第 1 名");
    expect(svg).toContain("#D97706"); // 暖金点睛色
    expect(svg).toContain("128.0 万");
    expect(svg).toContain("33.3%");
    expect(svg).toContain("使用模型");
    expect(svg).toContain("DeepSeek V3");
    expect(svg).not.toContain("主力协同模型");
    expect(svg).not.toContain("高频深度推理与代码");

    expect(svg).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

    const png = renderSvgToPng(svg);
    assertValidPng(png);
  });

  it("场景三(b)：generateIncentiveOver50Svg (超越 50% 员工成长卡)", () => {
    const data: IncentiveOver50ReportData = {
      userName: "李四",
      monthTitle: "9月份使用 Token 数量",
      quote: "已经超过了 50% 的同事",
      performanceText: "领跑半数成员",
      performanceSub: "位列团队前 50%",
      monthlyTokens: "68.5 万",
      totalRequests: "1,620 次",
      topModel: "DeepSeek V3 + GLM 5.3",
    };

    const svg = generateIncentiveOver50Svg(data);

    expect(svg).toContain("9月份使用 Token 数量");
    expect(svg).toContain("已经超过了 50% 的同事");
    expect(svg).toContain("领跑半数成员");
    expect(svg).toContain("68.5 万");
    expect(svg).toContain("1,620 次");
    expect(svg).toContain("DeepSeek V3 + GLM 5.3");
    expect(svg).not.toContain("深度推理与综合协作");

    expect(svg).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

    const png = renderSvgToPng(svg);
    assertValidPng(png);
  });

  it("场景四：generateDailyTokenReportSvg (全员 Token 消费日报纯白竖版)", () => {
    const data: DailyTokenReportData = {
      enterpriseName: "河南仟流科技",
      reportDate: "9.13 (昨日全天)",
      totalRequests: "245",
      totalTokens: "4,207.8 万",
      activeEmployees: 1,
      totalEmployees: 4,
      topUsers: [
        {
          rank: 1,
          name: "李佳",
          department: "总经理办公室",
          requests: "245",
          tokens: "4,207.8 万",
          share: "100.0%",
        },
      ],
      topModels: [
        {
          model: "智谱 GLM-5.3",
          tokens: "2,131.2 万",
          requests: "79",
          share: "50.6%",
        },
        {
          model: "月之暗面 Kimi K3",
          tokens: "2,076.6 万",
          requests: "166",
          share: "49.4%",
        },
      ],
    };

    const svg = generateDailyTokenReportSvg(data);

    expect(svg).toContain("河南仟流科技 · Token日报");
    expect(svg).toContain("9.13 (昨日全天)");
    expect(svg).toContain("河南仟流科技");
    expect(svg).toContain("4,207.8");
    expect(svg).toContain("万");
    expect(svg).toContain("245");
    expect(svg).toContain("李佳");
    expect(svg).toContain("总经理办公室");
    expect(svg).toContain("100.0%");
    expect(svg).toContain("智谱 GLM-5.3");
    expect(svg).toContain("50.6%");
    expect(svg).toContain("仟流智算");
    expect(svg).toContain("Qianliu IC");

    // 严禁包含 Emoji
    expect(svg).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

    const png = renderSvgToPng(svg);
    assertValidPng(png);
  });
});
