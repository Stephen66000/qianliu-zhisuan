import { Decimal } from "decimal.js";

import type { OperatingBillGap } from "./operating-bill-types.js";

const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export function addKnownCost(
  totals: Map<string, Decimal | null>,
  resourceId: string,
  value: string | null,
): void {
  const previous = totals.get(resourceId);
  if (value === null || previous === null) {
    totals.set(resourceId, null);
    return;
  }
  totals.set(resourceId, (previous ?? new MoneyDecimal(0)).plus(value));
}

export function sumKnownCosts(totals: Map<string, Decimal | null>): Decimal | null {
  const values = [...totals.values()];
  const known = values.filter((value): value is Decimal => value !== null);
  if (known.length !== values.length) return null;
  return known.reduce((sum, value) => sum.plus(value), new MoneyDecimal(0));
}

export function unknownApiCostGaps(
  totals: Map<string, Decimal | null>,
  resources: Map<string, { resource_name: string }>,
): OperatingBillGap[] {
  return [...totals].flatMap(([resourceId, cost]) => cost === null ? [{
    code: "API_COST_UNKNOWN",
    message: `${resources.get(resourceId)?.resource_name ?? resourceId} 存在未知账本 API 计价`,
    providerResourceId: resourceId,
  }] : []);
}

export function addSubjectApiCost(
  target: { api: Decimal; apiKnown: boolean },
  value: string | null,
): void {
  if (value === null) {
    target.apiKnown = false;
  } else {
    target.api = target.api.plus(value);
  }
}

function amount(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

export function knownAmount(value: Decimal, known: boolean): string | null {
  return known ? amount(value) : null;
}

export function nullableAmount(value: Decimal | null): string | null {
  return value === null ? null : amount(value);
}

export function nullableTotal(apiCost: Decimal | null, packageCost: Decimal): string | null {
  return apiCost === null ? null : amount(apiCost.plus(packageCost));
}

/** Map 缺项表示本月无调用（精确 0）；显式 null 表示存在调用但费用未知。 */
export function resourceCost(
  totals: Map<string, Decimal | null>,
  resourceId: string,
): Decimal | null {
  return totals.has(resourceId) ? totals.get(resourceId)! : new MoneyDecimal(0);
}
