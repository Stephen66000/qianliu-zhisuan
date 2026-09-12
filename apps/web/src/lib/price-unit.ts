/**
 * API 定价单位转换工具 —— 百万 Token (1M) 与 单 Token 的无损互转。
 *
 * 依据：
 * - 厂商刊例价与人类认知统一为「元/百万 Token」或「美元/百万 Token」；
 * - 底层数据库与网关引擎保持「单 Token 单价」高精度；
 * - 纯十进制字符串/大整数逻辑，不依赖浮点运算，杜绝二进制精度损失。
 */

/**
 * 将单 Token 单价转换为百万 Token (1M Tokens) 单价。
 * 小数点向右移动 6 位。
 * 例如："0.000002" ➔ "2"，"0.0000005" ➔ "0.5"，"0.00000005" ➔ "0.05"，"0" ➔ "0"
 */
export function toPerMillion(perTokenPrice: string | null | undefined): string {
  if (perTokenPrice === null || perTokenPrice === undefined || perTokenPrice === "") {
    return "";
  }
  const trimmed = perTokenPrice.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  if (fracPart.length <= 6) {
    const shifted = `${intPart}${fracPart.padEnd(6, "0")}`.replace(/^0+/, "");
    return shifted || "0";
  }

  // fracPart.length > 6
  const shiftedInt = `${intPart}${fracPart.slice(0, 6)}`.replace(/^0+/, "") || "0";
  const shiftedFrac = fracPart.slice(6).replace(/0+$/, "");
  return shiftedFrac ? `${shiftedInt}.${shiftedFrac}` : shiftedInt;
}

/**
 * 将百万 Token 单价转换为单 Token 单价存入接口。
 * 小数点向左移动 6 位。
 * 例如："2" ➔ "0.000002"，"0.5" ➔ "0.0000005"，"0.05" ➔ "0.00000005"，"0" ➔ "0"
 */
export function toPerToken(perMillionPrice: string | null | undefined): string {
  if (perMillionPrice === null || perMillionPrice === undefined || perMillionPrice === "") {
    return "";
  }
  const trimmed = perMillionPrice.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  const cleanInt = intPart.replace(/^0+/, "");

  if (cleanInt.length > 6) {
    const shiftedInt = cleanInt.slice(0, cleanInt.length - 6);
    const shiftedFrac = `${cleanInt.slice(cleanInt.length - 6)}${fracPart}`.replace(/0+$/, "");
    return shiftedFrac ? `${shiftedInt}.${shiftedFrac}` : shiftedInt;
  }

  // cleanInt.length <= 6
  const leadingZeros = "0".repeat(6 - cleanInt.length);
  const shiftedFrac = `${leadingZeros}${cleanInt}${fracPart}`.replace(/0+$/, "");
  return shiftedFrac ? `0.${shiftedFrac}` : "0";
}

/**
 * 确保输出为标准单 Token 价格字符串：
 * 如果已经是单 Token 价格（如 "0.000001"），直接保留；
 * 如果是百万 Token 价格（如 "1" 或 "0.5"），自动转换为单 Token 价格。
 */
export function normalizeToPerToken(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^0\.0000\d+$/.test(trimmed)) {
    return trimmed;
  }
  return toPerToken(trimmed);
}

/**
 * 格式化展示百万 Token 单价。
 * 例如输入 perToken="0.000002", currency="CNY" ➔ "¥ 2.00 / 百万 Token"
 */
export function formatPricePerMillion(
  perTokenPrice: string | null | undefined,
  currency: string = "CNY",
  options?: { showUnit?: boolean; decimals?: number }
): string {
  if (perTokenPrice === null || perTokenPrice === undefined || perTokenPrice === "") {
    return "—";
  }
  const perMillion = toPerMillion(perTokenPrice);
  if (!perMillion || perMillion === "—") return "—";

  const symbol = currency === "USD" ? "$" : "¥";
  const num = Number(perMillion);
  const formattedNum = Number.isFinite(num)
    ? num.toLocaleString("zh-CN", {
        minimumFractionDigits: options?.decimals ?? 2,
        maximumFractionDigits: options?.decimals ?? 4,
      })
    : perMillion;

  if (options?.showUnit === false) {
    return `${symbol}${formattedNum}`;
  }
  return `${symbol}${formattedNum} / 百万 Token`;
}
