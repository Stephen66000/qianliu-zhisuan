/**
 * 仟流智算企业微信报表与卡片格式化通用工具函数
 * 遵循《仟流视觉法则 1.2》与《个人/全员周报规范》标准
 */

/**
 * 格式化普通计数值（如请求次数、人次），采用千分位隔开。
 */
export function formatNumber(num: number | string | bigint): string {
  const n = typeof num === "bigint" ? Number(num) : typeof num === "string" ? Number(num) : num;
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("zh-CN");
}

/**
 * Token 统一计量换算（最高优先级强制规范）：
 * 1. 全盘彻底杜绝千分位长纯数字；
 * 2. 所有 Token 消耗量一律保留 1 位小数，四舍五入；
 * 3. < 1 亿（100,000,000）：以“万”为单位（如 32.9 万、4.7 万 /天）；
 * 4. >= 1 亿：升格为“亿”为单位（如 1.3 亿、2.5 亿）；
 * 5. 请求次数保留“次”。
 */
export function formatTokenVolume(
  tokens: number | string | bigint,
  options?: { isDailyAvg?: boolean; showTokensWord?: boolean },
): string {
  const n = typeof tokens === "bigint" ? Number(tokens) : typeof tokens === "string" ? Number(tokens) : tokens;
  const isDaily = options?.isDailyAvg ?? false;
  const suffix = options?.showTokensWord ? " Tokens" : "";

  if (!Number.isFinite(n) || n <= 0) {
    const unit = isDaily ? "万 /天" : "万";
    return `0.0 ${unit}${suffix}`;
  }

  if (n >= 100_000_000) {
    const val = (n / 100_000_000).toFixed(1);
    const unit = isDaily ? "亿 /天" : "亿";
    return `${val} ${unit}${suffix}`;
  }

  const val = (n / 10_000).toFixed(1);
  const unit = isDaily ? "万 /天" : "万";
  return `${val} ${unit}${suffix}`;
}

/**
 * 格式化百分比比例（如 "0.3333" -> "33.3%", 0.25 -> "25.0%"）
 */
export function formatPercentage(share: string | number): string {
  if (typeof share === "string" && share.includes("%")) return share;
  const num = typeof share === "string" ? parseFloat(share) : share;
  if (!Number.isFinite(num) || num <= 0) return "0.0%";
  return `${(num * 100).toFixed(1)}%`;
}

/**
 * 格式化常见的大模型名称为官方标准展示名称
 */
export function formatModelName(rawName: string): string {
  let clean = rawName.trim();
  if (clean.toLowerCase().startsWith("ql-")) {
    clean = clean.slice(3).trim();
  }
  const lower = clean.toLowerCase();
  if (lower.includes("deepseek-v3") || lower === "deepseek-chat") return "DeepSeek V3";
  if (lower.includes("deepseek-r1") || lower.includes("deepseek-reasoner")) return "DeepSeek R1";
  if (lower.includes("deepseek")) return "DeepSeek V3";
  if (lower.includes("claude-3-5-sonnet") || lower.includes("claude-3.5-sonnet")) return "Claude 3.5 Sonnet";
  if (lower.includes("claude-3-7-sonnet") || lower.includes("claude-3.7-sonnet")) return "Claude 3.7 Sonnet";
  if (lower.includes("gpt-4o-mini")) return "GPT-4o mini";
  if (lower.includes("gpt-4o")) return "GPT-4o";
  if (lower.includes("glm-5") || lower.includes("glm 5")) return "GLM 5.3";
  if (lower.includes("glm-4") || lower.includes("glm 4")) return "GLM-4";
  if (lower.includes("qwen-max")) return "Qwen Max";
  if (lower.includes("qwen-plus")) return "Qwen Plus";
  if (lower === "k3" || lower.startsWith("k3")) return "K3";
  if (lower.includes("kimi") || lower.includes("moonshot")) return "Kimi Chat";
  return clean;
}

/**
 * XML / SVG 字符转义，防止 & < > " ' 破坏 SVG 标签结构
 */
export function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 格式化时间区间为精简文本，如 "9.7 - 9.13"
 */
export function formatDateRange(
  from: Date | string,
  to: Date | string,
  timezone: string = "Asia/Shanghai",
): string {
  try {
    const fromDate = typeof from === "string" ? new Date(from) : from;
    const toDate = typeof to === "string" ? new Date(to) : to;

    const fromParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "numeric",
      day: "numeric",
    }).formatToParts(fromDate);

    const toParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "numeric",
      day: "numeric",
    }).formatToParts(toDate);

    const fromM = fromParts.find((p) => p.type === "month")?.value;
    const fromD = fromParts.find((p) => p.type === "day")?.value;
    const toM = toParts.find((p) => p.type === "month")?.value;
    const toD = toParts.find((p) => p.type === "day")?.value;

    return `${fromM}.${fromD} - ${toM}.${toD}`;
  } catch {
    const f = String(from).slice(5, 10).replace("-", ".");
    const t = String(to).slice(5, 10).replace("-", ".");
    return `${f} - ${t}`;
  }
}

/**
 * 格式化最晚物理请求时间（如 "周四深夜 23:15"、"周三 18:42"、"周二清晨 06:30"）
 */
export function formatLatestRequestTime(date: Date, timezone: string = "Asia/Shanghai"): string {
  const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const weekdayIndex = new Date(date.toLocaleString("en-US", { timeZone: timezone })).getDay();
  const weekday = weekdayNames[weekdayIndex] ?? "周内";

  let period = "";
  if (hour >= 0 && hour < 6) period = "凌晨";
  else if (hour >= 6 && hour < 9) period = "清晨";
  else if (hour >= 9 && hour < 12) period = "上午";
  else if (hour >= 12 && hour < 14) period = "中午";
  else if (hour >= 14 && hour < 18) period = "下午";
  else if (hour >= 18 && hour < 22) period = "晚上";
  else period = "深夜";

  const hh = String(hour).padStart(2, "0");
  return `${weekday}${period} ${hh}:${minute}`;
}
