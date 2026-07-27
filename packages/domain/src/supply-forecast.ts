/**
 * 供给预测（W15）—— 多窗口消耗速度、耗尽/恢复/覆盖、可信度（纯函数，确定性）。
 *
 * 依据：TRD §9.2 行 634-640；WT-15（消耗速度、预计耗尽、下一恢复、覆盖时长、预测依据和可信度）。
 *   - forecast_exhaust_at 不晚于资源失效时间（行 637）；
 *   - 余额未知时不生成伪精确日期（行 637）；
 *   - next_recover_at 来自厂商周期配置，不从历史规律无标记猜测（行 638）；
 *   - 数据不足不伪精确：数据点/窗口不足 → LOW 或 NOT_CALCULABLE（工程规则 §7 不伪精确）。
 *
 * 输入是 usage_event 聚合（各窗口 token 消耗 + 数据点数）+ 资源余额/周期配置；
 * 输出是预测快照（落 supply_forecast 表）。时钟注入，可回放。
 */

/** 算法版本（自然月偏差反向校准；W15 冻结 v1）。 */
export const FORECAST_ALGORITHM_VERSION = "w15-v1" as const;

/** 可信度分级。 */
export const FORECAST_CONFIDENCE = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  NOT_CALCULABLE: "NOT_CALCULABLE",
} as const;

export type ForecastConfidence = (typeof FORECAST_CONFIDENCE)[keyof typeof FORECAST_CONFIDENCE];

/** 窗口定义（小时）。 */
export const FORECAST_WINDOWS = { h1: 1, h24: 24, d7: 168 } as const;

/** 单个窗口的消耗数据。 */
export interface WindowUsage {
  /** 窗口内 token 总消耗。 */
  tokens: number;
  /** 窗口内 usage_event 数据点数。 */
  dataPoints: number;
  /** 窗口实际覆盖时长（小时；数据不足时小于窗口长度）。 */
  coveredHours: number;
}

export interface ForecastInput {
  rate1h: WindowUsage;
  rate24h: WindowUsage;
  rate7d: WindowUsage;
  /** 当前剩余额度（token；未知 = null）。 */
  remainingQuota: number | null;
  /** 资源失效时间（epoch ms；forecast_exhaust_at 不得晚于此）。 */
  resourceExpiresAt: number | null;
  /** 厂商周期下一重置/恢复时间（epoch ms；来自周期配置，不猜测）。 */
  nextResetAt: number | null;
  /** 当前时间（epoch ms，注入）。 */
  now: number;
}

export interface ForecastResult {
  /** 多窗口消耗速度（token/小时；数据不足窗口为 null）。 */
  rate1h: number | null;
  rate24h: number | null;
  rate7d: number | null;
  /** 加权综合速度（token/小时；用于耗尽预测）。 */
  blendedRate: number | null;
  /** 预计耗尽（epoch ms；余额未知或速度为 0 → null）。 */
  forecastExhaustAt: number | null;
  /** 下一恢复/重置（epoch ms；来自周期配置）。 */
  nextRecoverAt: number | null;
  /** 覆盖时长（小时；余额/速度）。 */
  coverageHours: number | null;
  /** 可信度。 */
  confidence: ForecastConfidence;
  /** 不可计算原因（NOT_CALCULABLE 时）。 */
  notCalculableReason: string | null;
  /** 数据点总数。 */
  dataPoints: number;
}

/** 窗口速度（token/小时）；覆盖不足窗口 1/4 视为数据不足返回 null。 */
function windowRate(w: WindowUsage, windowHours: number): number | null {
  if (w.dataPoints === 0 || w.coveredHours < windowHours / 4) return null;
  return w.tokens / Math.max(w.coveredHours, 1);
}

/** 数据点是否足够给出可信预测。 */
function enoughData(dataPoints: number): boolean {
  return dataPoints >= 10; // W15 阈值：≥10 个 usage_event 才给 HIGH/MEDIUM
}

/**
 * 计算供给预测。
 * 综合速度：优先 1h（最近），否则 24h，否则 7d；多窗口可用时加权（1h 0.5/24h 0.3/7d 0.2）。
 */
export function computeForecast(input: ForecastInput): ForecastResult {
  const rate1h = windowRate(input.rate1h, FORECAST_WINDOWS.h1);
  const rate24h = windowRate(input.rate24h, FORECAST_WINDOWS.h24);
  const rate7d = windowRate(input.rate7d, FORECAST_WINDOWS.d7);
  const dataPoints = input.rate1h.dataPoints + input.rate24h.dataPoints + input.rate7d.dataPoints;

  // 综合速度（在场窗口加权）
  let blendedRate: number | null = null;
  const parts: Array<{ r: number; w: number }> = [];
  if (rate1h !== null) parts.push({ r: rate1h, w: 0.5 });
  if (rate24h !== null) parts.push({ r: rate24h, w: 0.3 });
  if (rate7d !== null) parts.push({ r: rate7d, w: 0.2 });
  if (parts.length > 0) {
    const wSum = parts.reduce((s, p) => s + p.w, 0);
    blendedRate = parts.reduce((s, p) => s + p.r * p.w, 0) / wSum;
  }

  // 下一恢复/重置（来自周期配置）
  const nextRecoverAt = input.nextResetAt;

  // 耗尽预测：余额未知 → 不生成伪精确日期；速度为 0/null → 不可计算
  let forecastExhaustAt: number | null = null;
  let coverageHours: number | null = null;
  let confidence: ForecastConfidence;
  let notCalculableReason: string | null = null;

  if (input.remainingQuota === null) {
    confidence = FORECAST_CONFIDENCE.NOT_CALCULABLE;
    notCalculableReason = "remaining_quota_unknown";
  } else if (blendedRate === null || blendedRate <= 0) {
    // 余额已知但无消耗速度（无数据或无消耗）→ 可预测"不会耗尽"但不给日期
    confidence = enoughData(dataPoints) ? FORECAST_CONFIDENCE.MEDIUM : FORECAST_CONFIDENCE.LOW;
    notCalculableReason = "no_consumption_rate";
  } else {
    coverageHours = input.remainingQuota / blendedRate;
    // 时间戳取整毫秒（避免浮点小数）
    const exhaustAt = Math.round(input.now + coverageHours * 3600_000);
    // 不晚于资源失效时间
    forecastExhaustAt =
      input.resourceExpiresAt !== null ? Math.min(exhaustAt, input.resourceExpiresAt) : exhaustAt;
    // 可信度：数据点 + 窗口覆盖
    if (!enoughData(dataPoints)) {
      confidence = FORECAST_CONFIDENCE.LOW;
    } else if (rate1h !== null && rate24h !== null) {
      confidence = FORECAST_CONFIDENCE.HIGH;
    } else {
      confidence = FORECAST_CONFIDENCE.MEDIUM;
    }
  }

  return {
    rate1h,
    rate24h,
    rate7d,
    blendedRate,
    forecastExhaustAt,
    nextRecoverAt,
    coverageHours,
    confidence,
    notCalculableReason,
    dataPoints,
  };
}
