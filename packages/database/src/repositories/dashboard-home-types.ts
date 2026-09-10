/**
 * 标准版首页聚合类型（HOME-STANDARD-20260910 WP02）。
 * 与 apps/web/src/api/reporting-types.ts 的 StandardHomeSummary 镜像。
 */
import type { OperatingBillSnapshot } from "./operating-bill-types.js";

export type CurrencyAmount = { currency: string; amount: string };

/** 展示分类：正常 / 局部异常 / 异常 / 待确认（依据最差资源状态与恢复证据，不在前端判定）。 */
export type ProviderStatusCategory = "NORMAL" | "PARTIAL_ABNORMAL" | "ABNORMAL" | "PENDING_CONFIRM";

export interface StandardHomeProviderRow {
  providerCode: string;
  providerName: string;
  resourceCount: number;
  modes: Array<{ mode: "API" | "CODING_PLAN"; count: number }>;
  worstStatus: string;
  statusLabel: string;
  statusCategory: ProviderStatusCategory;
  abnormalResourceCount: number;
  attention: string | null;
  syncFailed: boolean;
  syncStale: boolean;
  lastSyncAt: string | null;
}

export interface StandardHomeWindow {
  rangeStart: string;
  rangeEndExclusive: string;
  truncated: boolean;
}

export interface StandardHomeTokenUsage {
  rangeStart: string;
  rangeEndExclusive: string;
  current: {
    totalTokens: string;
    inputTokens: string;
    outputTokens: string;
    usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
    unknownCount: number;
  };
  /** 同期也携带质量/完整性（R01-F02）：分母不完整时前端禁止正常百分比。 */
  previous: {
    totalTokens: string;
    usageQuality: "EXACT" | "ESTIMATED" | "UNKNOWN";
    unknownCount: number;
    window: StandardHomeWindow;
  };
}

export interface StandardHomeMonthlyCost {
  month: string;
  billStatus: "DRAFT" | "CLOSED";
  current: {
    totalSpends: CurrencyAmount[];
    apiSpends: CurrencyAmount[];
    packageCosts: CurrencyAmount[];
    incompleteReason: string | null;
  };
  previous: {
    totalSpends: CurrencyAmount[];
    incompleteReason: string | null;
    basis: "FINANCE_READ_MODEL" | "BALANCE_BRIDGE";
    window: StandardHomeWindow;
  } | null;
}

export interface StandardHomeActiveEmployees {
  timezone: string;
  rangeStart: string;
  rangeEndExclusive: string;
  current: number;
  previous: { count: number; window: StandardHomeWindow };
}

export interface StandardHomeActiveProjects {
  rangeStart: string;
  rangeEndExclusive: string;
  current: number;
  previous: { count: number; window: StandardHomeWindow };
}

export interface StandardHomeResources {
  providerCount: number;
  resourceCount: number;
  attentionProviderCount: number;
  updatedAt: string | null;
  providers: StandardHomeProviderRow[];
}

export interface StandardHomeSummary {
  asOf: string;
  month: string;
  tokenUsage: StandardHomeTokenUsage;
  monthlyCost: StandardHomeMonthlyCost;
  activeEmployees: StandardHomeActiveEmployees;
  activeProjects: StandardHomeActiveProjects;
  resources: StandardHomeResources;
}

export interface StandardHomeOptions {
  enterpriseId: string;
  asOf: Date;
  /** 经营账单当前月快照（由路由层经 OperatingBillRepository.getBill 取得后传入，保证与月度总览同源）。 */
  bill: OperatingBillSnapshot;
  /** 资金读模型是否生效（决定上月同期费用口径）。 */
  financeRead: boolean;
}
