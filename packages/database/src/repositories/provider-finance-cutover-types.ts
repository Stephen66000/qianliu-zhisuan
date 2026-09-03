export interface FinanceOpeningCandidate {
  enterpriseId: string;
  providerId: string;
  providerName: string;
  resourceId: string;
  resourceName: string;
  currency: string | null;
  amount: string | null;
  snapshotId: string | null;
  snapshotAt: string | null;
  status: "CONFIRMED" | "CANDIDATE" | "MISSING";
}

export interface FinancePurchaseCandidate {
  id: string;
  resourceId: string;
  resourceMode: "API" | "CODING_PLAN";
  purchaseType: string;
  amount: string;
  currency: string;
  purchasedAt: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  evidenceRef: string | null;
  alreadyMigrated: boolean;
  gaps: string[];
}

export interface FinanceCarryoverCandidate {
  resourceId: string;
  resourceName: string;
  productName: string | null;
  periodStart: string;
  periodEndExclusive: string;
  snapshotId: string;
  alreadyPrepared: boolean;
}

export interface FinancePreflightReport {
  enterpriseId: string;
  cutover: string;
  generatedAt: string;
  openingCandidates: FinanceOpeningCandidate[];
  purchaseCandidates: FinancePurchaseCandidate[];
  carryoverCandidates: FinanceCarryoverCandidate[];
  usage: {
    apiRows: number;
    codingPlanRows: number;
    unclassifiedApiRows: number;
    missingApiCurrencyRows: number;
    conflictingApiCurrencyRows: number;
    missingSettlementTimeRows: number;
    missingSubscriptionPeriodRows: number;
  };
  ready: boolean;
  blockers: Array<{ code: string; count: number }>;
}

export interface FinanceUsageBackfillReport {
  enterpriseId: string;
  mode: "DRY_RUN" | "APPLY";
  cutover: string;
  eligible: {
    settlementTime: number;
    pricedApi: number;
    confirmedZeroApi: number;
    unknownApi: number;
    codingPlanStatus: number;
    codingPlanPeriod: number;
  };
  changed: {
    settlementTime: number;
    apiCostCurrency: number;
    apiCostStatus: number;
    subscriptionPeriod: number;
  };
  nonTargetHashMismatches: number;
  remainingGaps: Array<{ code: string; count: number }>;
}

export interface FinanceConservationReport {
  enterpriseId: string;
  month: string;
  checkedAt: string;
  counts: {
    openingEvents: number;
    rechargeEvents: number;
    subscriptionEvents: number;
    apiUsageRows: number;
    pricedApiRows: number;
    confirmedZeroApiRows: number;
    unknownApiRows: number;
    codingPlanUsageRows: number;
    attributedCodingPlanRows: number;
    tokenFactMismatches: number;
  };
  balances: Array<{
    resourceId: string;
    currency: string;
    state: string;
    balance: string | null;
    formulaMatches: boolean | null;
  }>;
  monthlyComplete: boolean;
  passed: boolean;
  failures: Array<{ code: string; count: number }>;
}

export interface LegacyApiCostResolutionInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string;
  accountCurrency: "CNY" | "USD";
  windowStart: Date;
  windowEndInclusive: Date;
  providerBalanceSnapshotId: string;
  evidenceRef: string;
  idempotencyKey: string;
}

export interface LegacyApiCostResolutionView {
  id: string;
  adjustmentEventId: string;
  providerResourceId: string;
  accountCurrency: "CNY" | "USD";
  windowStart: string;
  windowEndInclusive: string;
  providerConfirmedBalance: string;
  localBalanceBeforeAdjustment: string;
  knownApiCost: string;
  missingApiCost: string;
  unknownLineCount: string;
  replayed: boolean;
}
