/**
 * 资金余额聚合语义（唯一实现点）。
 *
 * 对应 OpenSpec PFH-05 Scenario: Balance projection reuses the ledger implementation。
 * 计划 v1.2 §9/WP02 与 design §6 明确要求：
 *   「余额投影必须抽取并复用既有 provider-finance-balances.ts 聚合语义，
 *     不得另写一套冲销符号公式」。
 *
 * 因此本模块是全仓**唯一**的余额公式与金额标度定义：
 * - `Money` / `money` 从此处定义，数据库层 `provider-finance-core.ts` 直接再导出；
 * - `sumBalanceComponents` 是唯一的公式实现，资金余额查询
 *   （provider-finance-balances.ts）、切换守恒报告的公式校验
 *   （provider-finance-cutover-repository.ts）与候选假设投影共用它。
 *
 * 冲销与历史成本调整的正负号由资金事件的 `account_amount` 本身携带
 * （REVERSAL 事件写入时即取负，见 provider-finance-events.ts），
 * 因此本模块对这两个分量按原符号相加，**任何调用方都不得再次取反**。
 *
 * 本模块是纯函数，无数据库访问、无时钟读取、无随机数。
 */
import { Decimal } from "decimal.js";

/** 资金金额计算精度。与既有实现完全一致：precision 48、ROUND_HALF_UP。 */
export const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

/** 金额统一输出为八位小数字符串。 */
export function money(value: Decimal.Value): string {
  return new Money(value).toDecimalPlaces(8).toFixed(8);
}

/** 余额分量键：顺序即公式书写顺序，是唯一的键集合来源。 */
export const BALANCE_COMPONENT_KEYS = [
  "openingBalance",
  "openingCorrections",
  "recharges",
  "balanceReconciliations",
  "legacyCostAdjustments",
  "reversals",
  "usageDebits",
] as const;

export type BalanceComponentKey = (typeof BALANCE_COMPONENT_KEYS)[number];

/**
 * 公式加项：
 * 当前余额 = 期初余额 + 期初更正 + 充值 + 对账调整 + 历史成本调整 + 冲销 - API 用量扣费
 * （计划 v1.2 §4.3）
 */
export const BALANCE_POSITIVE_COMPONENT_KEYS = [
  "openingBalance",
  "openingCorrections",
  "recharges",
  "balanceReconciliations",
  "legacyCostAdjustments",
  "reversals",
] as const satisfies readonly BalanceComponentKey[];

/** 公式减项：只有 API 用量扣费。 */
export const BALANCE_NEGATIVE_COMPONENT_KEYS = [
  "usageDebits",
] as const satisfies readonly BalanceComponentKey[];

export type BalanceComponents = Record<BalanceComponentKey, string>;

/** 全零分量：`0` 是显式填写的事实，不得与「缺失」混用。 */
export function emptyBalanceComponents(): BalanceComponents {
  return {
    openingBalance: "0.00000000",
    openingCorrections: "0.00000000",
    recharges: "0.00000000",
    balanceReconciliations: "0.00000000",
    legacyCostAdjustments: "0.00000000",
    reversals: "0.00000000",
    usageDebits: "0.00000000",
  };
}

export function normalizeBalanceComponents(
  components: Partial<BalanceComponents> | null | undefined,
): BalanceComponents {
  const base = emptyBalanceComponents();
  if (!components) return base;
  for (const key of BALANCE_COMPONENT_KEYS) {
    const value = components[key];
    if (value !== undefined && value !== null) base[key] = value;
  }
  return base;
}

/**
 * 唯一余额公式实现。
 * 调用方不得复制其中的 `.plus/.minus` 顺序或自行取反 —— 需要其他实现时改这里。
 */
export function sumBalanceComponents(components: BalanceComponents): InstanceType<typeof Money> {
  let total = new Money(0);
  for (const key of BALANCE_POSITIVE_COMPONENT_KEYS) total = total.plus(components[key]);
  for (const key of BALANCE_NEGATIVE_COMPONENT_KEYS) total = total.minus(components[key]);
  return total;
}

/** 余额金额（八位小数字符串）。 */
export function balanceAmount(components: BalanceComponents): string {
  return money(sumBalanceComponents(components));
}

/** 逐分量相加：候选虚拟事实叠加在真实事实之上时使用，仍走同一公式。 */
export function addBalanceComponents(
  base: BalanceComponents,
  delta: Partial<Record<BalanceComponentKey, string | null | undefined>>,
): BalanceComponents {
  const result = normalizeBalanceComponents(base);
  for (const key of BALANCE_COMPONENT_KEYS) {
    const value = delta[key];
    if (value === undefined || value === null) continue;
    result[key] = money(new Money(result[key]).plus(value));
  }
  return result;
}

export function isBalanceNegative(components: BalanceComponents): boolean {
  return sumBalanceComponents(components).lt(0);
}

/** 公式自校验：给定余额必须等于公式结果（守恒检查复用，不新写算式）。 */
export function balanceFormulaMatches(components: BalanceComponents, balance: string): boolean {
  return balanceAmount(components) === money(balance);
}
