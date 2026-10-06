import type { LedgerLine } from "@qianliu/database";

export interface PricingEvidenceSummary {
  /** 单一币种下的 API 费用合计；混合币种或费用未知时为 null（F-020：不得跨币种相加）。 */
  actualCost: string | null;
  /** actualCost 的币种；actualCost 为 null 时亦为 null。 */
  actualCostCurrency: "CNY" | "USD" | null;
  /** 证据完整性：全部行均为已计价 API 且带规则 ID/版本（币种不一致不影响该判定）。 */
  complete: boolean;
  /** 已计价 API 行的币种不止一种时为 true：事务级总额不可计算（UNKNOWN_COST）。 */
  mixedApiCostCurrency: boolean;
  /** 存在费用未知的 API 行：事务级总额不可计算（UNKNOWN_COST）。 */
  unknownApiCost: boolean;
  items: Array<Record<string, unknown>>;
}

export function summarizePricingEvidence(lines: LedgerLine[]): PricingEvidenceSummary {
  const apiLines = lines.filter((line) => line.resource_mode === "API");
  const apiCosts = apiLines.flatMap((line) => line.api_cost === null ? [] : [line.api_cost]);
  const apiCostKnown = apiLines.length === apiCosts.length;
  // 币种去重语义与结算复核 SQL（COUNT(DISTINCT) FILTER）一致：忽略 NULL 币种——
  // 零消费占位行（api_cost=0、currency=null）不参与混合判定。
  const pricedCurrencies = [...new Set(
    apiLines.flatMap((line) =>
      line.api_cost === null || line.api_cost_currency === null ? [] : [line.api_cost_currency]),
  )];
  const mixedApiCostCurrency = pricedCurrencies.length > 1;
  const singleCurrency = mixedApiCostCurrency || pricedCurrencies.length === 0
    ? null
    : pricedCurrencies[0]!;
  return {
    actualCost: apiCostKnown && apiCosts.length > 0 && !mixedApiCostCurrency
      ? sumDecimal8(apiCosts)
      : null,
    actualCostCurrency: singleCurrency,
    complete: lines.length > 0 && lines.every((line) =>
      line.resource_mode === "API"
      && line.api_cost !== null
      && line.billing_rule_id !== null
      && line.rule_version !== null
    ),
    mixedApiCostCurrency,
    unknownApiCost: apiLines.length > 0 && !apiCostKnown,
    items: lines.map((line) => ({
      resourceId: line.provider_resource_id,
      billingRuleId: line.billing_rule_id,
      ruleVersion: line.rule_version,
      apiCost: line.api_cost,
      apiCostCurrency: line.api_cost_currency,
      billingRuleSnapshot: line.billing_rule_snapshot,
    })),
  };
}

function sumDecimal8(values: string[]): string {
  const total = values.reduce((sum, value) => {
    const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value);
    if (!match) throw new Error(`invalid_decimal8:${value}`);
    return sum + BigInt(match[1]!) * 100_000_000n
      + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  }, 0n);
  return `${total / 100_000_000n}.${(total % 100_000_000n).toString().padStart(8, "0")}`;
}
