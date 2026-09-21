/**
 * 归集数值基础：一律 BigInt 定点（禁浮点），金额沿用源 decimal 的标度。
 * 尾差分配使用确定性最大余数法；平局按目标键字典序，未分配键固定排最后。
 */
export interface ScaledDecimal {
  units: bigint;
  scale: number;
}

export const UNALLOCATED_TARGET_KEY = "ZZZ-UNALLOCATED";

export function parseDecimal(text: string): ScaledDecimal {
  const trimmed = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error(`invalid decimal: ${text}`);
  const negative = trimmed.startsWith("-");
  const absolute = negative ? trimmed.slice(1) : trimmed;
  const dot = absolute.indexOf(".");
  const units = dot < 0
    ? BigInt(absolute)
    : BigInt(absolute.slice(0, dot) + absolute.slice(dot + 1));
  return { units: negative ? -units : units, scale: dot < 0 ? 0 : absolute.length - dot - 1 };
}

export function formatScaled(value: ScaledDecimal): string {
  const sign = value.units < 0n ? "-" : "";
  const digits = value.units < 0n ? -value.units : value.units;
  const text = digits.toString().padStart(value.scale + 1, "0");
  if (value.scale === 0) return `${sign}${text}`;
  return `${sign}${text.slice(0, text.length - value.scale)}.${text.slice(text.length - value.scale)}`;
}

export interface WeightedTarget {
  key: string;
  bps: number;
}

/**
 * 按 bps 把 total（scale 精度下的整数单位）分配到各目标。
 * 精确值 = total × bps / 10000；先取整再按小数部分降序补齐尾差，
 * 保证 Σ分配 = total × Σbps / 10000（整数单位）且平局顺序确定。
 * 只对非零 bps 目标分配；负数总额按绝对值处理后回填符号。
 */
export function allocateByBps(total: bigint, targets: WeightedTarget[]): Map<string, bigint> {
  const result = new Map<string, bigint>();
  const active = targets.filter((target) => target.bps > 0);
  for (const target of targets) result.set(target.key, 0n);
  if (active.length === 0) return result;
  const negative = total < 0n;
  const amount = negative ? -total : total;
  const totalBps = active.reduce((sum, target) => sum + target.bps, 0);
  const exactTotal = (amount * BigInt(totalBps)) / 10000n;
  const floors = active.map((target) => {
    const numerator = amount * BigInt(target.bps);
    return { key: target.key, floor: numerator / 10000n, remainder: numerator % 10000n };
  });
  let leftover = exactTotal - floors.reduce((sum, item) => sum + item.floor, 0n);
  const ordered = [...floors].sort((left, right) =>
    right.remainder === left.remainder
      ? left.key.localeCompare(right.key)
      : Number(right.remainder - left.remainder));
  for (const item of ordered) {
    if (leftover <= 0n) break;
    item.floor += 1n;
    leftover -= 1n;
  }
  for (const item of floors) result.set(item.key, negative ? -item.floor : item.floor);
  return result;
}

/** Token 份额在 4 位小数下恒精确：units(±10⁴) = token × bps。 */
export function tokenShareUnits(tokens: bigint, bps: number): string {
  const negative = tokens < 0n;
  const units = (negative ? -tokens : tokens) * BigInt(bps);
  const text = units.toString().padStart(5, "0");
  const formatted = `${text.slice(0, text.length - 4)}.${text.slice(text.length - 4)}`;
  return negative && units !== 0n ? `-${formatted}` : formatted;
}
