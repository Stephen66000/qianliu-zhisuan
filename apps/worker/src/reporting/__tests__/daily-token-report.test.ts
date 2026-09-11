import { describe, expect, it } from "vitest";
import {
  generateDailyReportSvg,
  renderSvgToPng,
  type DailyReportData,
} from "../daily-token-report.js";

describe("Daily Token Report Image Generator", () => {
  const mockReportData: DailyReportData = {
    enterpriseName: "仟流智算创新科技",
    reportDate: "2026-09-10",
    generatedAt: "09-11 09:00",
    totalTokens: 1250800,
    inputTokens: 850400,
    outputTokens: 400400,
    cacheTokens: 120000,
    requestCount: 342,
    activeEmployees: 15,
    topUsers: [
      { rank: 1, name: "张三", department: "算法研发部", tokens: 420000, share: "33.6%" },
      { rank: 2, name: "李四", department: "平台工程部", tokens: 280000, share: "22.4%" },
      { rank: 3, name: "王五", department: "数据智能组", tokens: 195000, share: "15.6%" },
      { rank: 4, name: "赵六", department: "前端研发部", tokens: 98000, share: "7.8%" },
    ],
    topModels: [
      { model: "deepseek-coder", tokens: 780000, requestCount: 210 },
      { model: "kimi-chat", tokens: 320000, requestCount: 88 },
      { model: "zhipu-glm4", tokens: 150800, requestCount: 44 },
    ],
  };

  it("generateDailyReportSvg: 正确生成包含标题、KPI、排行榜与模型分布的 SVG 字符串", () => {
    const svg = generateDailyReportSvg(mockReportData);

    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("仟流智算创新科技");
    expect(svg).toContain("2026-09-10");
    expect(svg).toContain("张三");
    expect(svg).toContain("算法研发部");
    expect(svg).toContain("deepseek-coder");
    expect(svg).toContain("1,250,800");
  });

  it("renderSvgToPng: 将 SVG 转换为有效的 PNG 格式 Buffer", () => {
    const svg = generateDailyReportSvg(mockReportData);
    const pngBuffer = renderSvgToPng(svg);

    expect(pngBuffer).toBeInstanceOf(Buffer);
    expect(pngBuffer.length).toBeGreaterThan(1000);

    // 校验 PNG 魔数标头 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    const isPng =
      pngBuffer[0] === 0x89 &&
      pngBuffer[1] === 0x50 && // 'P'
      pngBuffer[2] === 0x4e && // 'N'
      pngBuffer[3] === 0x47; // 'G'
    expect(isPng).toBe(true);
  });
});
