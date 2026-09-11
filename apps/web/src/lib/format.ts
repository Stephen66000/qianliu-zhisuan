/**
 * W18 金额/数值展示格式化 —— 只做展示层格式化，不做账本计算。
 *
 * 硬约束（详细开发计划行 146）：前端不重算金额/额度/节省，后端给什么展示什么；
 * 这里仅做"字符串十进制 → 人类可读文本"的展示转换（千分位、小数位、单位），
 * 不做任何加总/比较/换算。
 */

/** 金额展示：十进制字符串 → "12.50"（两位小数 + 千分位）。null 由调用方按空状态处理。 */
export function formatMoney(value: string): string {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value);
  if (!match) return value;
  const sign = match[1] === "-" ? "-" : "";
  const fraction = match[3] ?? "";
  const hundredths = BigInt(match[2]!) * 100n + BigInt((fraction + "00").slice(0, 2));
  const rounded = (fraction[2] ?? "0") >= "5" ? hundredths + 1n : hundredths;
  const integer = rounded / 100n;
  const decimals = String(rounded % 100n).padStart(2, "0");
  const displaySign = sign && rounded !== 0n ? sign : "";
  return `${displaySign}${integer.toLocaleString("zh-CN")}.${decimals}`;
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

/** 十进制展示：最多两位小数、半入舍入、去尾零并保留大整数精度。 */
export function formatDecimal(value: string, maximumFractionDigits = 2): string {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value);
  if (!match || maximumFractionDigits < 0 || !Number.isInteger(maximumFractionDigits)) return value;
  const sign = match[1] === "-" ? "-" : "";
  const fraction = match[3] ?? "";
  const scale = 10n ** BigInt(maximumFractionDigits);
  let scaled = BigInt(match[2]!) * scale
    + BigInt((fraction + "0".repeat(maximumFractionDigits)).slice(0, maximumFractionDigits) || "0");
  if ((fraction[maximumFractionDigits] ?? "0") >= "5") scaled += 1n;
  const integer = scaled / scale;
  const decimals = maximumFractionDigits === 0 ? ""
    : String(scaled % scale).padStart(maximumFractionDigits, "0").replace(/0+$/, "");
  const displaySign = sign && scaled !== 0n ? sign : "";
  return `${displaySign}${integer.toLocaleString("zh-CN")}${decimals ? `.${decimals}` : ""}`;
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

/** ISO 时间按上海时区转换为自然日，避免 UTC 日期截断提前一天。 */
export function formatShanghaiDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const shifted = new Date(date.getTime() + 8 * 3600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
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
  return `${formatDecimal(rate)}/h`;
}

/** 手机号脱敏：13812345678 → 138****5678 */
export function maskMobile(mobile: string | null | undefined): string {
  if (!mobile) return "";
  const cleaned = mobile.trim();
  if (cleaned.length === 11) {
    return `${cleaned.slice(0, 3)}****${cleaned.slice(7)}`;
  }
  if (cleaned.length > 7) {
    return `${cleaned.slice(0, 3)}****${cleaned.slice(-4)}`;
  }
  if (cleaned.length > 3) {
    return `${cleaned.slice(0, 2)}***${cleaned.slice(-1)}`;
  }
  return cleaned;
}

/** 企微 UserID 脱敏：stephen6600 → st****00，短字符保留首尾 */
export function maskUserId(userId: string | null | undefined): string {
  if (!userId) return "";
  const cleaned = userId.trim();
  if (cleaned.length <= 2) return cleaned;
  if (cleaned.length <= 4) return `${cleaned[0]}**${cleaned.slice(-1)}`;
  return `${cleaned.slice(0, 2)}****${cleaned.slice(-2)}`;
}
