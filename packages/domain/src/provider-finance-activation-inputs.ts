/**
 * 资金账本初始化：候选投影的输入事实契约、缺口构造原语与共享小工具（纯类型 + 纯函数）。
 *
 * 对应 OpenSpec：PFA-01、PFA-02。
 * 本模块由 provider-finance-activation-projection.ts 按「输入契约」分段下沉而来：
 * 该文件已超出质量门禁单文件上限，按 草稿规范化 / 守恒检查 / 余额投影 / 输入契约 四段拆分。
 * 迁移后 `provider-finance-activation-projection.ts` 显式再导出原有公开符号，
 * 包对外导出面保持不变。
 *
 * 工程约束：本模块无数据库访问、无时钟读取、无随机数。
 */
import type {
  ActivationCurrency,
  ActivationDecision,
  ActivationGap,
  ActivationGapCategory,
  ActivationGapCode,
  ActivationResourceMode,
  NormalizedActivationCandidate,
  ProjectedFinanceSummary,
  UsageRepairBaselineRow,
  UsageRepairSummary,
} from "./provider-finance-activation.js";
import type { BalanceComponents } from "./provider-finance-balance-components.js";

// ===== 输入事实契约（由数据库只读事务提供） =====

export type RequiredCurrencySource =
  | "CUTOVER_SNAPSHOT" | "FINANCE_EVENT" | "PRICED_USAGE" | "HISTORICAL_RECHARGE" | "ADMIN_DECLARED";

export interface ActivationScopeResourceInput {
  resourceId: string;
  mode: ActivationResourceMode;
  providerId: string;
  providerCode: string;
  providerName: string;
  resourceName: string;
  status: string;
  hasPostCutoverLedgerLine: boolean;
  hasCrossingSnapshot: boolean;
  hasPostCutoverPurchase: boolean;
}

export interface ActivationScopeAccountInput {
  resourceId: string;
  currency: ActivationCurrency;
  sources: RequiredCurrencySource[];
}

export interface FinanceFactRow {
  id: string;
  resourceId: string;
  eventType: string;
  currency: ActivationCurrency;
  accountAmount: string;
  cashPaidCny: string | null;
  occurredAt: string;
}

export interface PeriodFactRow {
  id: string;
  resourceId: string;
  productName: string;
  periodStart: string;
  periodEndExclusive: string;
  reversedByEventId: string | null;
}

export interface LegacyPurchaseFactRow {
  id: string;
  resourceId: string;
  purchaseType: "API_RECHARGE" | "PACKAGE_PURCHASE";
  amount: string;
  currency: string;
  purchasedAt: string;
  alreadyMigratedEventId: string | null;
}

export interface LedgerLineFactRow {
  id: string;
  resourceId: string;
  resourceMode: ActivationResourceMode;
  rawInputTokens: string;
  rawOutputTokens: string;
  rawCacheTokens: string;
  rawReasoningTokens: string;
  apiCost: string | null;
  apiCostCurrency: ActivationCurrency | null;
  apiCostStatus: string | null;
  legacyCostResolved: boolean;
  subscriptionPeriodId: string | null;
  settledAt: string | null;
  createdAt: string;
  billingRuleSnapshotCurrency: string | null;
  billingRuleId: string | null;
  /** 运营消费口径；false 表示失败审计且无消费、无已提交响应，不计入经营账单。 */
  operatingConsumption: boolean;
  /** CONFIRMED_ZERO_NO_UPSTREAM 修复资格（与既有回填规则一致）。 */
  zeroConfirmedEligible: boolean;
  usageEventId: string;
}

export interface UsageEventFactRow {
  id: string;
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  reasoningTokens: string;
}

export interface AccountComponentsFactRow {
  resourceId: string;
  currency: ActivationCurrency;
  components: BalanceComponents;
  /**
   * 数据库侧独立算出的余额（`loadCurrentBalanceSnapshot().balance`）。
   * 用于非平凡地校验「分量 ↔ 余额」一致，而不是把公式套两遍。
   */
  reportedBalance: string | null;
}

export interface MonthlyGapFactRow {
  month: string;
  gaps: Array<{ code: string; count: number }>;
}

/** 候选写入的虚拟周期：`draft:` 前缀的合成 id 供投影内部归属使用。 */
export interface VirtualPeriod {
  /** 合成 id：`draft:<record_idempotency_key>`。 */
  id: string;
  resourceId: string;
}

export interface ActivationProjectionInput {
  enterpriseId: string;
  snapshotAt: string;
  cutoverAt?: string;
  resources: ActivationScopeResourceInput[];
  accounts: ActivationScopeAccountInput[];
  financeEvents: FinanceFactRow[];
  periods: PeriodFactRow[];
  legacyPurchases: LegacyPurchaseFactRow[];
  ledgerLines: LedgerLineFactRow[];
  usageEvents: UsageEventFactRow[];
  accountComponents: AccountComponentsFactRow[];
  monthlyGaps: MonthlyGapFactRow[];
  strictWritesEnabled: boolean;
  draft: NormalizedActivationCandidate;
  /** 候选固定修复行集（预检确定，与完整水位分开建模）。 */
  usageRepairBaseline: UsageRepairBaselineRow[];
  /** 候选固定修复行集的目标字段预期值，供激活时逐行校验。 */
  usageRepairTargets: UsageRepairTarget[];
}

export interface UsageRepairTarget {
  ledgerLineId: string;
  settledAt: string | null;
  apiCostCurrency: ActivationCurrency | null;
  apiCostStatus: string | null;
  /** 既可为已存在的周期 id，也可为 `draft:<key>` 虚拟周期 id（激活事务内解析）。 */
  subscriptionPeriodId: string | null;
}

export interface ActivationProjectionResult {
  decision: ActivationDecision;
  gaps: ActivationGap[];
  projected: ProjectedFinanceSummary;
  usageRepairs: UsageRepairSummary;
  scopeSummary: {
    apiResources: number;
    codingPlanResources: number;
    requiredAccounts: number;
    legacyRecords: number;
    months: string[];
  };
  /** 固定修复行集：排序后的 ledger_line 主键 + 允许字段 + 逐行非目标基准哈希（PFH-04）。 */
  usageRepairBaseline: UsageRepairBaselineRow[];
  /** 参与守卫的用量修复目标（与 usageRepairBaseline 同源、同序）。 */
  usageRepairTargets: UsageRepairTarget[];
}

// ===== 缺口构造 =====

export interface GapContext {
  resourceId?: string | null;
  accountCurrency?: ActivationCurrency | null;
  legacyRecordId?: string | null;
  ledgerLineId?: string | null;
  month?: string | null;
  detail?: string | null;
}

export function gap(
  code: ActivationGapCode, category: ActivationGapCategory, message: string, context: GapContext = {},
): ActivationGap {
  return {
    code,
    category,
    message,
    resourceId: context.resourceId ?? null,
    accountCurrency: context.accountCurrency ?? null,
    legacyRecordId: context.legacyRecordId ?? null,
    ledgerLineId: context.ledgerLineId ?? null,
    month: context.month ?? null,
    detail: context.detail ?? null,
  };
}

// ===== 小工具 =====

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function instantOf(value: string): number {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) throw new Error(`不是合法时间：${value}`);
  return time;
}

export function isWithin(instant: string, startIso: string, endExclusiveIso: string): boolean {
  const time = instantOf(instant);
  return time >= instantOf(startIso) && time < instantOf(endExclusiveIso);
}

/** 时间口径与既有账本一致：优先 settled_at，缺失时退回 created_at。 */
export function ledgerEffectiveAt(line: LedgerLineFactRow): string {
  return line.settledAt ?? line.createdAt;
}

export function hasTokens(line: LedgerLineFactRow): boolean {
  return Number(line.rawInputTokens) > 0 || Number(line.rawOutputTokens) > 0
    || Number(line.rawCacheTokens) > 0 || Number(line.rawReasoningTokens) > 0;
}

export function accountKey(resourceId: string, currency: string): string {
  return `${resourceId}:${currency}`;
}

export function isSameShanghaiDay(instant: string, day: string): boolean {
  return new Date(instantOf(instant) + 8 * 3600_000).toISOString().slice(0, 10) === day;
}
