/**
 * 资金账本初始化：余额投影段（PFH-05）。
 *
 * 由 provider-finance-activation-projection.ts 按「余额投影」分段下沉而来。
 *
 * 工程约束：余额公式的唯一实现在 provider-finance-balance-components.ts。
 * 本模块只用 `addBalanceComponents` / `balanceFormulaMatches` 组装虚拟事实，
 * **不得**自行书写 `.plus/.minus` 链或冲销正负号。
 */
import {
  type ActivationCurrency,
  type ActivationGap,
  type ProjectedAccountBalance,
} from "./provider-finance-activation.js";
import {
  addBalanceComponents,
  balanceAmount,
  balanceFormulaMatches,
  emptyBalanceComponents,
  isBalanceNegative,
  money,
  Money,
} from "./provider-finance-balance-components.js";
import {
  accountKey,
  compareStrings,
  gap,
  type ActivationProjectionInput,
  type ActivationScopeAccountInput,
} from "./provider-finance-activation-inputs.js";
import type { UsageRepairPlan } from "./provider-finance-activation-draft.js";

/** 用量修复对 `usageDebits` 分量的确定性增量（按账户），符号仍由共享公式决定。 */
export function computeUsageDebitDeltas(
  input: ActivationProjectionInput, plan: UsageRepairPlan,
): Map<string, string> {
  const deltas = new Map<string, string>();
  const add = (key: string, amount: string) => {
    deltas.set(key, money(new Money(deltas.get(key) ?? 0).plus(amount)));
  };
  for (const line of input.ledgerLines) {
    if (line.resourceMode !== "API" || line.apiCost === null) continue;
    const repaired = plan.repairByLine.get(line.id);
    const statusBefore = line.apiCostStatus;
    const currencyBefore = line.apiCostCurrency;
    const statusAfter = repaired?.apiCostStatus ?? statusBefore;
    const currencyAfter = repaired ? repaired.apiCostCurrency : currencyBefore;
    const counted = (status: string | null, currency: ActivationCurrency | null): string | null =>
      status === "PRICED_USAGE" && currency !== null ? line.apiCost : null;
    const before = counted(statusBefore, currencyBefore);
    const after = counted(statusAfter, currencyAfter);
    if (before === after) continue;
    if (before !== null && currencyBefore !== null) {
      add(accountKey(line.resourceId, currencyBefore), new Money(before).negated().toString());
    }
    if (after !== null && currencyAfter !== null) add(accountKey(line.resourceId, currencyAfter), after);
  }
  return deltas;
}

/** 余额投影与守恒（PFH-05，复用共享聚合语义）。 */
export function projectAccountBalances(
  input: ActivationProjectionInput,
  plan: UsageRepairPlan,
  scopeAccounts: Map<string, ActivationScopeAccountInput>,
  gaps: ActivationGap[],
): ProjectedAccountBalance[] {
  const accounts: ProjectedAccountBalance[] = [];
  const virtualOpenings = new Map<string, string>();
  for (const opening of input.draft.apiOpeningBalances) {
    const key = accountKey(opening.resourceId, opening.accountCurrency);
    virtualOpenings.set(key, money(new Money(virtualOpenings.get(key) ?? 0).plus(opening.accountAmount)));
  }
  const virtualRecharges = new Map<string, string>();
  for (const recharge of input.draft.historicalApiRecharges) {
    const key = accountKey(recharge.resourceId, recharge.accountCurrency);
    virtualRecharges.set(key, money(new Money(virtualRecharges.get(key) ?? 0).plus(recharge.accountAmount)));
  }
  const usageDebitDeltas = computeUsageDebitDeltas(input, plan);
  const realComponents = new Map(input.accountComponents.map((row) => [accountKey(row.resourceId, row.currency), row]));
  const accountKeys = [...new Set([...realComponents.keys(), ...scopeAccounts.keys()])].sort(compareStrings);
  for (const key of accountKeys) {
    const account = scopeAccounts.get(key);
    if (!account) continue;
    const [resourceId, currency] = key.split(":") as [string, ActivationCurrency];
    const real = realComponents.get(key);
    const base = real?.components ?? emptyBalanceComponents();
    const components = addBalanceComponents(base, {
      openingBalance: virtualOpenings.get(key) ?? null,
      recharges: virtualRecharges.get(key) ?? null,
      usageDebits: usageDebitDeltas.get(key) ?? null,
    });
    // 非平凡校验：数据库独立算出的余额必须等于用共享公式重算的结果。
    const formulaMatches = real === undefined || real.reportedBalance === null
      ? true
      : balanceFormulaMatches(real.components, real.reportedBalance);
    accounts.push({ resourceId, currency, ...components, balance: balanceAmount(components), formulaMatches });
    // 失败关闭：数据库独立算出的余额必须等于用共享公式重算的结果；不一致即缺口，不得返回 GO_CANDIDATE。
    if (!formulaMatches && real !== undefined && real.reportedBalance !== null) {
      gaps.push(gap("BALANCE_FORMULA_MISMATCH", "BALANCE",
        "账户余额与共享公式重算结果不一致，必须先完成对账",
        {
          resourceId, accountCurrency: currency,
          detail: `重算 ${balanceAmount(real.components)} ≠ 已落库 ${real.reportedBalance}`,
        }));
    }
    if (isBalanceNegative(components)) {
      gaps.push(gap("NEGATIVE_BALANCE", "BALANCE", "投影余额为负，必须先完成对账",
        { resourceId, accountCurrency: currency, detail: balanceAmount(components) }));
    }
  }
  accounts.sort((left, right) => compareStrings(left.resourceId, right.resourceId)
    || compareStrings(left.currency, right.currency));
  return accounts;
}
