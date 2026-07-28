/**
 * W18 金额/数值展示格式化 —— 只做展示层格式化，不做账本计算。
 *
 * 硬约束（详细开发计划行 146）：前端不重算金额/额度/节省，后端给什么展示什么；
 * 这里仅做"字符串十进制 → 人类可读文本"的展示转换（千分位、小数位、单位），
 * 不做任何加总/比较/换算。
 */

/** 金额展示：十进制字符串 → "12.50"（两位小数 + 千分位）。null 由调用方按空状态处理。 */
export function formatMoney(value: string): string {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return value;
  }
  return num.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 额度/token 展示：BigInt 文本 → 千分位（P2-03：超 MAX_SAFE_INTEGER 用 BigInt，不用 Number）。 */
export function formatCount(value: string): string {
  try {
    return BigInt(value).toLocaleString("zh-CN");
  } catch {
    // 非整数字符串（如小数额度），退化为 Number 格式化
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num).toLocaleString("zh-CN") : value;
  }
}

/** 超额比例：小数文本（"0.0500"）→ "5.00%"（展示层 ×100，仅格式转换）。 */
export function formatRatioAsPercent(ratio: string): string {
  const num = Number(ratio);
  if (!Number.isFinite(num)) {
    return ratio;
  }
  return `${(num * 100).toFixed(2)}%`;
}

/** ISO 时间 → "MM-dd HH:mm"（本地时区，仪表盘元信息用）。 */
export function formatDateTimeShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO 时间 → "YYYY-MM-dd HH:mm:ss"（账本表格用）。 */
export function formatDateTimeFull(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 耗时毫秒 → "1.2s" / "320ms"。null（进行中）由调用方处理。 */
export function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${ms}ms`;
}

/** 速率（十进制字符串/小时）→ 千分位 + "/h"。 */
export function formatRatePerHour(rate: string): string {
  const num = Number(rate);
  if (!Number.isFinite(num)) {
    return rate;
  }
  return `${Math.trunc(num).toLocaleString("zh-CN")}/h`;
}
