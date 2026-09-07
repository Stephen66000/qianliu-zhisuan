import { Decimal } from "decimal.js";
import type {
  OperatingBillAccountTotals,
  OperatingBillUsageQuality,
} from "./operating-bill-account-types.js";

const PreciseDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export interface OperatingBillAccountFact {
  requestId: string;
  sourcePrincipalId: string;
  sourcePrincipalName: string;
  sourcePrincipalType: "EMPLOYEE" | "PROJECT";
  projectId: string | null;
  projectName: string | null;
  projectOwnerPersonId: string | null;
  projectOwnerName: string | null;
  projectDepartmentId: string | null;
  projectDepartmentName: string | null;
  providerCode: string;
  providerName: string;
  unifiedModelId: string | null;
  currentAlias: string | null;
  historicalAlias: string;
  requestStatus: string;
  usedAt: Date;
  activeDates: string[];
  qualities: string[];
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  reasoningTokens: string;
  deductedQuota: string | null;
  apiCost: string | null;
  knownApiCost?: string | null;
  packageAllocatedCost: string | null;
}

interface AccountAccumulator {
  input: Decimal;
  output: Decimal;
  cache: Decimal;
  reasoning: Decimal;
  deducted: Decimal;
  apiCost: Decimal;
  packageCost: Decimal;
  deductedKnown: boolean;
  apiCostKnown: boolean;
  packageCostKnown: boolean;
  qualities: Set<string>;
  activeDates: Set<string>;
  requestIds: Set<string>;
  lastUsedAt: Date | null;
}

export interface OperatingBillAccountSummaryInput {
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  reasoningTokens: string;
  deductedQuota: string | null;
  apiCost: string | null;
  knownApiCost?: string | null;
  packageAllocatedCost: string | null;
  qualities: Iterable<string>;
  activeDays: number;
  requestCount: number;
  lastUsedAt: Date | null;
}

function decimal(value: string | null): Decimal {
  return new PreciseDecimal(value ?? 0);
}

export function newAccountAccumulator(): AccountAccumulator {
  return {
    input: decimal("0"), output: decimal("0"), cache: decimal("0"), reasoning: decimal("0"),
    deducted: decimal("0"), apiCost: decimal("0"), packageCost: decimal("0"),
    deductedKnown: true, apiCostKnown: true, packageCostKnown: true,
    qualities: new Set(), activeDates: new Set(), requestIds: new Set(), lastUsedAt: null,
  };
}

export function addAccountFact(target: AccountAccumulator, fact: OperatingBillAccountFact): void {
  target.input = target.input.plus(fact.inputTokens);
  target.output = target.output.plus(fact.outputTokens);
  target.cache = target.cache.plus(fact.cacheTokens);
  target.reasoning = target.reasoning.plus(fact.reasoningTokens);
  target.deducted = target.deducted.plus(fact.deductedQuota ?? 0);
  target.apiCost = target.apiCost.plus(fact.knownApiCost ?? fact.apiCost ?? 0);
  target.packageCost = target.packageCost.plus(fact.packageAllocatedCost ?? 0);
  target.deductedKnown = target.deductedKnown && fact.deductedQuota !== null;
  target.apiCostKnown = target.apiCostKnown && fact.apiCost !== null;
  target.packageCostKnown = target.packageCostKnown && fact.packageAllocatedCost !== null;
  for (const quality of fact.qualities) target.qualities.add(quality);
  for (const activeDate of fact.activeDates) target.activeDates.add(activeDate);
  target.requestIds.add(fact.requestId);
  if (!target.lastUsedAt || fact.usedAt > target.lastUsedAt) target.lastUsedAt = fact.usedAt;
}

export function summarizeUsageQuality(qualities: Iterable<string>): OperatingBillUsageQuality {
  const normalized = new Set([...qualities].map((quality) => quality.toUpperCase()));
  if (normalized.size === 0 || (normalized.size === 1 && normalized.has("UNKNOWN"))) return "UNKNOWN";
  if (normalized.size === 1 && normalized.has("PROVIDER_REPORTED")) return "EXACT";
  if (normalized.size === 1 && normalized.has("UPSTREAM_REPORTED")) return "EXACT";
  if (normalized.size === 1 && normalized.has("ESTIMATED")) return "ESTIMATED";
  if (normalized.size === 1 && normalized.has("ACCOUNT_AGGREGATED")) return "ACCOUNT_AGGREGATED";
  return "MIXED";
}

function integer(value: Decimal): string {
  return value.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0);
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

export function finishAccountTotals(target: AccountAccumulator): OperatingBillAccountTotals {
  if (target.requestIds.size === 0) {
    return {
      inputTokens: "0", outputTokens: "0", cacheTokens: "0", reasoningTokens: "0",
      totalTokens: "0", deductedQuota: "0", apiCost: "0.00000000",
      packageAllocatedCost: "0.00000000", totalAllocatedCost: "0.00000000",
      activeDays: 0, requestCount: 0, lastUsedAt: null, usageQuality: "EXACT",
    };
  }
  const usageQuality = summarizeUsageQuality(target.qualities);
  const tokensKnown = usageQuality !== "UNKNOWN" || target.input.plus(target.output).gt(0);
  const apiCost = target.apiCostKnown ? money(target.apiCost) : null;
  const packageCost = target.packageCostKnown ? money(target.packageCost) : null;
  return {
    inputTokens: tokensKnown ? integer(target.input) : null,
    outputTokens: tokensKnown ? integer(target.output) : null,
    cacheTokens: tokensKnown ? integer(target.cache) : null,
    reasoningTokens: tokensKnown ? integer(target.reasoning) : null,
    totalTokens: tokensKnown ? integer(target.input.plus(target.output)) : null,
    deductedQuota: target.deductedKnown ? integer(target.deducted) : null,
    apiCost,
    knownApiCost: money(target.apiCost),
    packageAllocatedCost: packageCost,
    totalAllocatedCost: apiCost !== null && packageCost !== null
      ? money(target.apiCost.plus(target.packageCost)) : null,
    activeDays: target.activeDates.size,
    requestCount: target.requestIds.size,
    lastUsedAt: target.lastUsedAt?.toISOString() ?? null,
    usageQuality,
  };
}

/** 将 PostgreSQL 已聚合行标准化为账户口径，避免总览为了复用 Node 聚合而拉取整月明细。 */
export function finishAccountSummary(input: OperatingBillAccountSummaryInput): OperatingBillAccountTotals {
  if (input.requestCount === 0) return finishAccountTotals(newAccountAccumulator());
  const usageQuality = summarizeUsageQuality(input.qualities);
  const inputTokens = decimal(input.inputTokens);
  const outputTokens = decimal(input.outputTokens);
  const tokensKnown = usageQuality !== "UNKNOWN" || inputTokens.plus(outputTokens).gt(0);
  const apiCost = input.apiCost === null ? null : money(decimal(input.apiCost));
  const packageCost = input.packageAllocatedCost === null ? null : money(decimal(input.packageAllocatedCost));
  return {
    inputTokens: tokensKnown ? integer(inputTokens) : null,
    outputTokens: tokensKnown ? integer(outputTokens) : null,
    cacheTokens: tokensKnown ? integer(decimal(input.cacheTokens)) : null,
    reasoningTokens: tokensKnown ? integer(decimal(input.reasoningTokens)) : null,
    totalTokens: tokensKnown ? integer(inputTokens.plus(outputTokens)) : null,
    deductedQuota: input.deductedQuota === null ? null : integer(decimal(input.deductedQuota)),
    apiCost,
    knownApiCost: input.knownApiCost === null || input.knownApiCost === undefined ? apiCost : money(decimal(input.knownApiCost)),
    packageAllocatedCost: packageCost,
    totalAllocatedCost: apiCost !== null && packageCost !== null
      ? money(decimal(apiCost).plus(packageCost)) : null,
    activeDays: input.activeDays,
    requestCount: input.requestCount,
    lastUsedAt: input.lastUsedAt?.toISOString() ?? null,
    usageQuality,
  };
}

export function usageShare(part: OperatingBillAccountTotals, whole: OperatingBillAccountTotals): string | null {
  if (part.totalTokens === null || whole.totalTokens === null) return null;
  const wholeTokens = decimal(whole.totalTokens);
  if (wholeTokens.isZero() || wholeTokens.isNegative()) return null;
  return decimal(part.totalTokens).div(wholeTokens).mul(100).toDecimalPlaces(2).toFixed(2);
}
