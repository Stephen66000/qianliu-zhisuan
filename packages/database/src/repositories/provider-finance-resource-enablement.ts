import { sql, type Kysely } from "kysely";
import {
  balanceAmount,
  balanceFormulaMatches,
  isBalanceNegative,
  type ActivationCurrency,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import { loadActivationScope } from "./provider-finance-activation-facts.js";
import { loadBalanceFactTotals, toBalanceComponents } from "./provider-finance-balance-facts.js";
import { PROVIDER_FINANCE_CUTOVER, type FinanceCurrency } from "./provider-finance-types.js";
import { ProviderFinanceActivationError } from "./provider-finance-activation-types.js";

/**
 * 激活后的**资源级资金启用服务**（计划 v1.2 §6.3-3 / §7 领域层第 5 项；PFH-07）。
 *
 * 为什么必须有这一层：企业激活后新建的 API 资源由 0078 触发器种入 `PENDING`，
 * Gateway 调度门禁（`resource-pool-repository` 排除 PENDING）会**永久**拦截它。
 * 如果没有生产可达的「资源级守恒检查 → READY 提升」路径，新资源登记完期初仍不可调度，
 * 闭环就是断的。
 *
 * 守恒检查口径与候选投影**同源**，不另写一套：
 *  - 必要币种 = `loadActivationScope` 按资源切分出的账户币种（与候选预检同一 SQL）；
 *  - 每币种必须已登记 `API_OPENING_BALANCE`（说明与证据由写入侧 schema 强制必填）；
 *  - 余额用共享公式复算，并与生产口径独立复算的余额比对（`balanceFormulaMatches`），
 *    同时要求非负（`isBalanceNegative`）。
 */

export type ResourceEnablementBlockerCode =
  | "REQUIRED_CURRENCY_UNRESOLVED"
  | "MISSING_OPENING_BALANCE"
  | "BALANCE_FORMULA_MISMATCH"
  | "NEGATIVE_BALANCE";

export interface ResourceEnablementBlocker {
  code: ResourceEnablementBlockerCode;
  currency: ActivationCurrency | null;
  detail: string | null;
}

export interface ResourceBalanceEvidence {
  currency: ActivationCurrency;
  hasOpeningBalance: boolean;
  formulaMatches: boolean;
  negative: boolean;
  /** 窗口化分量按共享公式复算出的余额。 */
  computedBalance: string;
  /** 生产口径（资金事件不设下界）独立复算出的余额，用于交叉校验。 */
  reportedBalance: string;
}

export interface ResourceEnablementAssessment {
  resourceId: string;
  requiredCurrencies: ActivationCurrency[];
  openingCurrencies: ActivationCurrency[];
  balances: ResourceBalanceEvidence[];
  blockers: ResourceEnablementBlocker[];
  ready: boolean;
}

/**
 * 纯判定：由「必要币种 / 已登记期初币种 / 每币种余额证据」得出阻断项。
 * 与数据库解耦，便于负路径单测；`ready` 仅当阻断项为空。
 */
export function evaluateResourceEnablementDecision(input: {
  requiredCurrencies: readonly ActivationCurrency[];
  openingCurrencies: readonly ActivationCurrency[];
  balances: readonly ResourceBalanceEvidence[];
}): ResourceEnablementBlocker[] {
  const blockers: ResourceEnablementBlocker[] = [];
  const required = [...new Set(input.requiredCurrencies)].sort();
  if (required.length === 0) {
    // 无任何事实币种 ⇒ 尚未登记必要币种期初，绝不能直接放行到可调度状态。
    blockers.push({
      code: "REQUIRED_CURRENCY_UNRESOLVED", currency: null,
      detail: "该资源尚未登记任何必要币种账户期初，无法完成资源级守恒检查",
    });
    return blockers;
  }
  const openings = new Set(input.openingCurrencies);
  for (const currency of required) {
    if (!openings.has(currency)) {
      blockers.push({
        code: "MISSING_OPENING_BALANCE", currency,
        detail: "必要币种账户缺少期初余额",
      });
      continue;
    }
    const balance = input.balances.find((row) => row.currency === currency);
    if (balance === undefined) continue;
    if (!balance.formulaMatches) {
      blockers.push({
        code: "BALANCE_FORMULA_MISMATCH", currency,
        detail: `重算 ${balance.computedBalance} ≠ 已落库 ${balance.reportedBalance}`,
      });
    }
    if (balance.negative) {
      blockers.push({ code: "NEGATIVE_BALANCE", currency, detail: balance.computedBalance });
    }
  }
  return blockers;
}

/**
 * 装载资源级守恒证据并给出判定。**只读**：不写任何状态；READY 提升由调用方在
 * 通过判定后用 `markResourceFinanceReady`（带 `expectedVersion`）执行。
 */
export async function assessResourceFinanceEnablement(
  db: Kysely<Database>,
  input: { enterpriseId: string; resourceId: string; now?: Date },
): Promise<ResourceEnablementAssessment> {
  const now = input.now ?? new Date();
  const scope = await loadActivationScope(db, {
    enterpriseId: input.enterpriseId, snapshotAt: now.toISOString(),
  });
  const resource = scope.resources.find((row) => row.resourceId === input.resourceId);
  if (!resource) {
    throw new ProviderFinanceActivationError("RESOURCE_FINANCE_NOT_READY",
      "该资源不属于本企业或已删除，无法进行资源级资金启用");
  }
  if (resource.mode !== "API") {
    throw new ProviderFinanceActivationError("INVALID_REQUEST",
      "只有 API 资源使用资源级资金启用流程");
  }

  const requiredCurrencies = scope.accounts
    .filter((account) => account.resourceId === input.resourceId)
    .map((account) => account.currency)
    .sort();

  const openingRows = await sql<{ currency: string }>`
    SELECT DISTINCT account_currency AS currency FROM provider_finance_event
     WHERE enterprise_id=${input.enterpriseId}::uuid
       AND provider_resource_id=${input.resourceId}::uuid
       AND event_type='API_OPENING_BALANCE'
     ORDER BY account_currency`.execute(db);
  const openingCurrencies = openingRows.rows.map((row) => row.currency as ActivationCurrency);

  const balances: ResourceBalanceEvidence[] = [];
  for (const currency of requiredCurrencies) {
    const window = {
      enterpriseId: input.enterpriseId, resourceId: input.resourceId,
      currency: currency as FinanceCurrency,
      eventsFrom: PROVIDER_FINANCE_CUTOVER, eventsTo: now,
      ledgerFrom: PROVIDER_FINANCE_CUTOVER, ledgerTo: now,
    };
    const [windowed, production] = await Promise.all([
      loadBalanceFactTotals(db, window),
      loadBalanceFactTotals(db, { ...window, eventsFrom: null }),
    ]);
    const components = toBalanceComponents(windowed);
    const computedBalance = balanceAmount(components);
    const reportedBalance = balanceAmount(toBalanceComponents(production));
    balances.push({
      currency,
      hasOpeningBalance: openingCurrencies.includes(currency),
      formulaMatches: balanceFormulaMatches(components, reportedBalance),
      negative: isBalanceNegative(components),
      computedBalance, reportedBalance,
    });
  }

  const blockers = evaluateResourceEnablementDecision({
    requiredCurrencies, openingCurrencies, balances,
  });
  return {
    resourceId: input.resourceId, requiredCurrencies, openingCurrencies, balances, blockers,
    ready: blockers.length === 0,
  };
}
