/**
 * 标准版首页展示模型（HOME-STANDARD-20260910 WP03）—— 纯展示层格式化。
 *
 * 硬约束：不重算计价/分摊/聚合；仅做"后端十进制文本 → 人类可读文本"的转换
 * （单位缩放、百分比、数量差、窗口描述）。同期比较的可比性规则（上期 0、
 * 未知、多币种不可比不输出正常百分比）在此处统一实现。
 */
import type { StandardHomeSummary, StandardHomeWindow } from "../../api/types";
import { currencyFacts, currencyMoney } from "../../lib/currency";

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** Token 数量级缩放：≥1 亿 → 亿；≥1 万 → 万；其余原值千分位。 */
export function formatTokenMagnitude(value: string): { value: string; unit: string } {
  const tokens = BigInt(value);
  if (tokens >= 100_000_000n) {
    return { value: magnitude(tokens, 100_000_000n), unit: "亿 Token" };
  }
  if (tokens >= 10_000n) {
    return { value: magnitude(tokens, 10_000n), unit: "万 Token" };
  }
  return { value: tokens.toLocaleString("zh-CN"), unit: "Token" };
}

function magnitude(tokens: bigint, scale: bigint): string {
  const units = (tokens * 100n) / scale;
  const whole = units / 100n;
  const fraction = units % 100n;
  return `${whole.toLocaleString("zh-CN")}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * 金额/Token 同期百分比：上期为 0、负值或任一侧不可解析时返回 null（不输出正常百分比）。
 * 仅展示层换算（÷ 上期 − 1），参与比较的事实由后端提供。
 * V14-C2 F-C：定点 BigInt 计算——金额/Token 十进制串可超过 2^53，Number 会失精度。
 */
export function periodChangePercent(current: string, previous: string): string | null {
  const scale = 8;
  const currentScaled = toScaledBigInt(current, scale);
  const previousScaled = toScaledBigInt(previous, scale);
  if (currentScaled === null || previousScaled === null || previousScaled <= 0n) return null;
  const delta = currentScaled - previousScaled;
  const magnitude = delta < 0n ? -delta : delta;
  const scaledTenths = magnitude * 1000n;
  let tenths = scaledTenths / previousScaled;
  if ((scaledTenths % previousScaled) * 2n >= previousScaled) tenths += 1n; // 十分位四舍五入（半入）
  const sign = delta > 0n ? "+" : delta < 0n ? "-" : "";
  return `${sign}${tenths / 10n}.${tenths % 10n}%`;
}

/** 十进制文本 → 定点 BigInt（右补零到 scale 位小数）；非法输入返回 null。 */
function toScaledBigInt(value: string, scale: number): bigint | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = (match[3] ?? "").padEnd(scale, "0").slice(0, scale);
  return sign * BigInt(match[2]! + fraction);
}

/** R01-F02：本期或同期任一用量不完整（含未知记录）时禁止正常百分比。 */
export function tokenPeriodComparable(
  current: { usageQuality: string; unknownCount: number },
  previous: { usageQuality: string; unknownCount: number },
): boolean {
  const complete = (period: { usageQuality: string; unknownCount: number }) =>
    period.usageQuality !== "UNKNOWN" && period.unknownCount === 0;
  return complete(current) && complete(previous);
}

/** 同期质量说明（保留已知量，同时说明分母不完整）。 */
export function previousTokenQualityNote(
  previous: { usageQuality: string; unknownCount: number },
): string | null {
  if (previous.usageQuality === "UNKNOWN" || previous.unknownCount > 0) return "上月同期含未知用量";
  if (previous.usageQuality === "ESTIMATED") return "上月同期含估算用量";
  return null;
}

/** R01-F01：资金完整性缺口码 → 老板可读说明（展示层映射，语义以权威 countFinanceGaps 为准）。 */
const COST_GAP_LABELS: Array<[string, string]> = [
  ["API_USAGE_COST_UNKNOWN", "存在未知 API 费用"],
  ["API_COST_CURRENCY_MISSING", "有费用缺少币种"],
  ["API_COST_CURRENCY_CONFLICT", "有费用币种与计价规则冲突"],
  ["OPENING_BALANCE_MISSING", "有账户缺少期初余额"],
  ["SUBSCRIPTION_PERIOD_MISSING", "有套餐用量缺少订阅周期"],
  ["CASH_PAID_CNY_MISSING", "有充值或套餐采购未登记现金支出"],
];

export function costGapLabel(reason: string): string {
  const labels = COST_GAP_LABELS
    .filter(([code]) => reason.includes(code))
    .map(([, label]) => label);
  return labels.length > 0 ? labels.join("、") : reason;
}

/** 数量差（员工/项目优先显示差值，不算百分比）。 */
export function countDelta(current: number, previous: number, unit: string): string {
  if (current > previous) return `较上月同期 增加 ${current - previous} ${unit}`;
  if (current < previous) return `较上月同期 减少 ${previous - current} ${unit}`;
  return "较上月同期 持平";
}

/** ISO 时刻 → "09-10 14:00"（北京时间）。 */
export function formatShanghaiDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/** 同期窗口脚注：上月 1 日至 X 日 HH:mm（北京时间）；截断时说明截止上月月末。 */
export function previousWindowLabel(window: StandardHomeWindow): string {
  const startDay = formatShanghaiDateTime(window.rangeStart).slice(0, 5);
  if (window.truncated) {
    return `上月 ${startDay} 日 00:00 至上月月末（上月无同一日，已截止月末，排他边界）`;
  }
  const end = formatShanghaiDateTime(window.rangeEndExclusive);
  return `上月 ${startDay} 日 00:00 至 ${end}（北京时间）`;
}

/** 概览区脚注：同期窗口 + 时区说明 + 员工/项目分别统计。 */
export function overviewFootnote(data: StandardHomeSummary): string {
  const tokenWindow = previousWindowLabel(data.tokenUsage.previous.window);
  const employeeTzNote = data.activeEmployees.timezone === "Asia/Shanghai"
    ? ""
    : `；员工按企业时区 ${data.activeEmployees.timezone} 统计`;
  return `同期比较：${tokenWindow}${employeeTzNote}；员工与项目分别去重统计，不可相加。`;
}

/** 金额同期：仅当本期与上期都为单一且相同币种、上期 > 0 时给百分比，否则 null。
 * 不变量：调用前已确认两数组长度均为 1（上方 length 判断），因此可用非空断言。 */
export function moneyChangePercent(
  current: Array<{ currency: string; amount: string }>,
  previous: Array<{ currency: string; amount: string }>,
): string | null {
  if (current.length !== 1 || previous.length !== 1) return null;
  if (current[0]!.currency !== previous[0]!.currency) return null;
  return periodChangePercent(current[0]!.amount, previous[0]!.amount);
}

/** Token 数据质量说明（上游实报 / 含估算 / 部分未知）。 */
export function tokenQualityLabel(
  quality: StandardHomeSummary["tokenUsage"]["current"]["usageQuality"],
  unknownCount: number,
): string {
  if (quality === "UNKNOWN" || unknownCount > 0) return "部分用量未知，合计不完整";
  if (quality === "ESTIMATED") return "含估算用量";
  return "上游实报";
}

export interface OverviewTokenCard {
  value: string;
  unit: string;
  delta: string;
  footnote: string;
  hint: string;
}

export interface OverviewCostCard {
  primary: string | null;
  additional: string[];
  emptyText: string | null;
  delta: string;
  footnote: string;
  hints: string[];
}

/** 概览四卡文案模型（R01-F01/F02 可比性规则集中于此，页面组件只渲染）。 */
export function buildOverviewCards(
  data: StandardHomeSummary,
): { token: OverviewTokenCard; cost: OverviewCostCard } {
  const token = data.tokenUsage;
  const tokenCurrent = formatTokenMagnitude(token.current.totalTokens);
  const tokenPrevious = formatTokenMagnitude(token.previous.totalTokens);
  const tokenComparable = tokenPeriodComparable(token.current, token.previous);
  const tokenPercent = tokenComparable
    ? periodChangePercent(token.current.totalTokens, token.previous.totalTokens)
    : null;
  const tokenDelta = tokenPercent
    ? `较上月同期 ${tokenPercent}`
    : !tokenComparable && Number(token.previous.totalTokens) > 0
      ? "本期或同期用量不完整，不计算百分比"
      : "上月同期为 0 或用量未知，不计算百分比";
  const previousTokenNote = previousTokenQualityNote(token.previous);

  const cost = data.monthlyCost;
  const costComplete = cost.current.incompleteReason === null
    && (!cost.previous || cost.previous.incompleteReason === null);
  const costAmounts = cost.current.totalSpends.map((fact) =>
    currencyMoney(fact.amount, fact.currency));
  const costPercent = costComplete
    ? moneyChangePercent(cost.current.totalSpends, cost.previous?.totalSpends ?? [])
    : null;
  // V14-C2 F-D：上期金额全为 0（含多币种）时明确"上月同期为 0"，与"多币种不可比"分开表述。
  const previousSpends = cost.previous?.totalSpends ?? [];
  const previousAllZero = previousSpends.length > 0
    && previousSpends.every((fact) => /^0+(?:\.0+)?$/.test(fact.amount));
  const costDelta = costPercent
    ? `较上月同期 ${costPercent}`
    : !costComplete
      ? "金额存在缺口，不计算百分比"
      : !cost.previous
        ? "上月同期暂无可比数据，不计算百分比"
        : previousAllZero
          ? "上月同期为 0，不计算百分比"
          : "上月同期无可比金额或多币种，不计算百分比";
  const costPreviousText = cost.previous
    ? cost.previous.totalSpends.length > 0
      ? `${currencyFacts(cost.previous.totalSpends, null)}${cost.previous.incompleteReason
        ? `（${costGapLabel(cost.previous.incompleteReason)}）` : ""}`
      : `不可完整计算${cost.previous.incompleteReason ? `（${costGapLabel(cost.previous.incompleteReason)}）` : ""}`
    : "暂无可比数据";
  const costHints: string[] = [];
  if (cost.current.incompleteReason) {
    costHints.push(`金额不完整：${costGapLabel(cost.current.incompleteReason)}，已展示已知部分`);
  }
  costHints.push(cost.previous?.basis === "FINANCE_READ_MODEL"
    ? "同期按资金账本口径聚合"
    : cost.previous?.basis === "BALANCE_BRIDGE"
      ? "同期按余额桥接口径聚合"
      : "经营账单口径；多币种分别展示，不换汇");

  return {
    token: {
      value: tokenCurrent.value,
      unit: tokenCurrent.unit,
      delta: tokenDelta,
      footnote: `上月同期 ${tokenPrevious.value} ${tokenPrevious.unit}${previousTokenNote ? `（${previousTokenNote}）` : ""}`,
      hint: `输入 + 输出合计，缓存不重复累加 · ${tokenQualityLabel(token.current.usageQuality, token.current.unknownCount)}`,
    },
    cost: {
      primary: costAmounts[0] ?? null,
      additional: costAmounts.slice(1),
      emptyText: costAmounts.length === 0
        ? cost.current.incompleteReason ?? "暂无可计算费用"
        : null,
      delta: costDelta,
      footnote: `上月同期 ${costPreviousText}`,
      hints: costHints,
    },
  };
}
