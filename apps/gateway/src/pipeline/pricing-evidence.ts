/**
 * 将逐 Attempt 账本行汇总成请求级价格证据。
 * 只要任一 API 行缺少成本或规则身份，`actualCost` 就保持未知，禁止把未知误算为零。
 */
import type { LedgerLine } from "@qianliu/database";

/** 返回请求实际成本、证据完整性和可审计的逐行规则快照。 */
export function summarizePricingEvidence(lines: LedgerLine[]): {
  actualCost: string | null;
  complete: boolean;
  items: Array<Record<string, unknown>>;
} {
  const apiLines = lines.filter((line) => line.resource_mode === "API");
  const apiCosts = apiLines.flatMap((line) => line.api_cost === null ? [] : [line.api_cost]);
  const apiCostKnown = apiLines.length === apiCosts.length;
  return {
    actualCost: apiCostKnown && apiCosts.length > 0 ? sumDecimal8(apiCosts) : null,
    complete: lines.length > 0 && lines.every((line) =>
      line.resource_mode === "API"
      && line.api_cost !== null
      && line.billing_rule_id !== null
      && line.rule_version !== null
    ),
    items: lines.map((line) => ({
      resourceId: line.provider_resource_id,
      billingRuleId: line.billing_rule_id,
      ruleVersion: line.rule_version,
      apiCost: line.api_cost,
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
