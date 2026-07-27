/**
 * W15 单元测试：供给预测（supply-forecast）。
 *
 * 覆盖（TRD §9.2；WT-15）：
 *   - 多窗口速度：1h/24h/7d token/小时；覆盖不足窗口为 null
 *   - 综合速度：在场窗口加权
 *   - 预计耗尽：余额/速度；不晚于资源失效时间
 *   - 余额未知 → NOT_CALCULABLE（不伪精确日期）
 *   - 下一恢复：来自周期配置（不猜测）
 *   - 可信度：数据点不足 → LOW；1h+24h 可用且数据足 → HIGH
 *   - 覆盖时长
 */
import { describe, it, expect } from "vitest";
import { computeForecast, FORECAST_CONFIDENCE, type ForecastInput, type WindowUsage } from "../index.js";

const T0 = 1_800_000_000_000;
const H = 3600_000;

function w(tokens: number, dataPoints: number, coveredHours: number): WindowUsage {
  return { tokens, dataPoints, coveredHours };
}

function input(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    rate1h: w(1000, 10, 1),
    rate24h: w(12000, 50, 24),
    rate7d: w(70000, 200, 168),
    remainingQuota: 50000,
    resourceExpiresAt: null,
    nextResetAt: T0 + 24 * H,
    now: T0,
    ...overrides,
  };
}

describe("computeForecast 多窗口速度", () => {
  it("1h/24h/7d 速度计算", () => {
    const r = computeForecast(input());
    expect(r.rate1h).toBe(1000); // 1000/1h
    expect(r.rate24h).toBe(500); // 12000/24h
    expect(r.rate7d).toBeCloseTo(416.67, 1); // 70000/168h
  });

  it("覆盖不足窗口（<1/4）→ null", () => {
    const r = computeForecast(input({ rate1h: w(100, 5, 0.1) })); // 0.1h < 1h/4
    expect(r.rate1h).toBeNull();
  });

  it("无数据窗口 → null", () => {
    const r = computeForecast(input({ rate1h: w(0, 0, 1) }));
    expect(r.rate1h).toBeNull();
  });

  it("综合速度：在场窗口加权（1h 0.5/24h 0.3/7d 0.2）", () => {
    const r = computeForecast(input());
    // (1000*0.5 + 500*0.3 + 416.67*0.2) / 1.0 = 500+150+83.3 = 733.3
    expect(r.blendedRate).toBeCloseTo(733.33, 0);
  });

  it("只有 7d 可用时综合速度=7d", () => {
    const r = computeForecast(input({ rate1h: w(0, 0, 1), rate24h: w(0, 0, 24) }));
    expect(r.blendedRate).toBeCloseTo(416.67, 1);
  });
});

describe("computeForecast 耗尽预测", () => {
  it("预计耗尽 = now + 余额/速度；覆盖时长正确", () => {
    const r = computeForecast(input());
    // 50000 / 733.33 ≈ 68.18h
    expect(r.coverageHours).toBeCloseTo(68.18, 0);
    expect(r.forecastExhaustAt).toBe(Math.round(T0 + r.coverageHours! * H));
    expect(Number.isInteger(r.forecastExhaustAt)).toBe(true); // 时间戳整数毫秒
  });

  it("不晚于资源失效时间", () => {
    const expires = T0 + 10 * H; // 10h 后失效（远早于 68h 耗尽）
    const r = computeForecast(input({ resourceExpiresAt: expires }));
    expect(r.forecastExhaustAt).toBe(expires);
  });

  it("余额未知 → NOT_CALCULABLE，不生成伪精确日期", () => {
    const r = computeForecast(input({ remainingQuota: null }));
    expect(r.confidence).toBe(FORECAST_CONFIDENCE.NOT_CALCULABLE);
    expect(r.forecastExhaustAt).toBeNull();
    expect(r.coverageHours).toBeNull();
    expect(r.notCalculableReason).toBe("remaining_quota_unknown");
  });

  it("无消耗速度 → 不给耗尽日期（no_consumption_rate）", () => {
    const r = computeForecast(input({ rate1h: w(0, 0, 1), rate24h: w(0, 0, 24), rate7d: w(0, 0, 168) }));
    expect(r.forecastExhaustAt).toBeNull();
    expect(r.notCalculableReason).toBe("no_consumption_rate");
  });
});

describe("computeForecast 恢复与可信度", () => {
  it("下一恢复来自周期配置", () => {
    const r = computeForecast(input());
    expect(r.nextRecoverAt).toBe(T0 + 24 * H);
  });

  it("数据点不足 → LOW（不伪精确）", () => {
    const r = computeForecast(input({ rate1h: w(1000, 2, 1), rate24h: w(12000, 3, 24), rate7d: w(70000, 2, 168) }));
    expect(r.confidence).toBe(FORECAST_CONFIDENCE.LOW);
  });

  it("1h+24h 可用且数据足 → HIGH", () => {
    const r = computeForecast(input());
    expect(r.confidence).toBe(FORECAST_CONFIDENCE.HIGH);
  });

  it("只有 7d 可用且数据足 → MEDIUM", () => {
    const r = computeForecast(input({ rate1h: w(0, 0, 1), rate24h: w(0, 0, 24), rate7d: w(70000, 200, 168) }));
    expect(r.confidence).toBe(FORECAST_CONFIDENCE.MEDIUM);
  });

  it("数据点总数正确", () => {
    const r = computeForecast(input());
    expect(r.dataPoints).toBe(10 + 50 + 200);
  });
});
