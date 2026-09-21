/**
 * Canonical provider code（WP02，修复 RISK-1）。
 *
 * 预置厂商 code 与生产历史数据可能为 `Kimi`/`DeepSeek`/`Zhipu`，
 * 而 Adapter 内多个分支严格比较小写字面量。所有进入 Adapter/Parser/
 * Endpoint Policy 的 providerCode 必须先经此规范化，禁止在各函数内
 * 零散调用 toLowerCase()。
 */
const CANONICAL_CODES = new Set([
  "deepseek", "zhipu", "kimi", "qwen", "minimax", "openai", "siliconflow",
]);

export type CanonicalProviderCode =
  | "deepseek" | "zhipu" | "kimi" | "qwen" | "minimax" | "openai" | "siliconflow"
  | (string & {});

/** 去空白 + 小写。未知厂商 code 规范化为小写后原样返回（自定义厂商仍可用）。 */
export function canonicalProviderCode(input: string | null | undefined): CanonicalProviderCode {
  const normalized = (input ?? "").trim().toLowerCase();
  return normalized;
}

export function isKnownCanonicalProviderCode(input: string | null | undefined): boolean {
  return CANONICAL_CODES.has(canonicalProviderCode(input));
}
