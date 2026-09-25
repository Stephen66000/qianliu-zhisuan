import { type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { eventView, Money, money } from "./provider-finance-core.js";
import {
  PROVIDER_FINANCE_CUTOVER, ProviderFinanceError,
  type FinanceCurrency, type FinanceEventInput, type FinanceEventType, type FinanceEventView,
} from "./provider-finance-types.js";

/**
 * 资金写入原语（WP03 任务 3.1；design §7）。
 *
 * 唯一目的：让「日常表单写入」与「激活事务写入」共用同一段落库代码。
 *
 * 硬约束：
 * - 每个原语第一个参数都是调用方持有的 `Transaction<Database>`，**本模块从不开启事务**。
 *   激活协调器因此可以在一个 `SERIALIZABLE` 外层事务里直接调用它们，
 *   而不会出现「被调用方法自行提交」这种撕裂事务边界的写法。
 * - 现有日常公开方法（`ProviderFinanceEventRepository`、`renewDueSubscription`）
 *   在自己的事务里复用同一批原语；本模块之外不存在第二条资金事件/订阅周期写入路径。
 * - 本模块只做「落库 + 表级形状校验」，不负责幂等重放、重复候选、静默门禁与权限：
 *   那些属于调用方策略，激活与日常两条路径的策略本就不同。
 */

// ===== 形状校验（与 0059/0060 迁移 CHECK 约束一一对应，提前失败并给出可读原因） =====

const SHANGHAI_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** 订阅周期边界必须是上海自然日零点（0059 `provider_subscription_period_range_check`）。 */
export function assertShanghaiMidnight(value: Date, label: string): void {
  if ((value.getTime() + SHANGHAI_OFFSET_MS) % DAY_MS !== 0) {
    throw new ProviderFinanceError("INVALID_REQUEST", `${label}必须使用上海自然日零点边界`);
  }
}

export function shanghaiDayOf(value: Date): string {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 扣费时间必须落在服务开始日的上海自然日内（PFA/PFH-03）。 */
export function assertSameShanghaiDay(occurredAt: Date, periodStart: Date): void {
  if (shanghaiDayOf(occurredAt) !== shanghaiDayOf(periodStart)) {
    throw new ProviderFinanceError("INVALID_REQUEST", "扣费日期必须等于服务周期开始日");
  }
}

/** 迁移来源标记前缀：与读模型侧 `('legacy-purchase:' || resource_purchase_record.id)` 严格一致。 */
export const LEGACY_PURCHASE_MARKER_PREFIX = "legacy-purchase:";

/**
 * 由旧 `resource_purchase_record` 迁移而来的资金事件，其 `external_reference` 的唯一正确取值（纯函数）。
 *
 * 四处聚合读模型——`provider-finance-registered-history`、`operating-analysis-purchases`、
 * `provider-finance-activation-facts`、`provider-finance-cutover-repository`——都以
 * `event.external_reference = ('legacy-purchase:' || purchase.id::text)` 判定
 * 「该旧记录已被新账本承接」。因此迁移行必须写出该标记，否则同一笔付款会被新旧两套账本各计一次
 * （见 WP07 缺陷 D-1：199.00 被计成 398.00）。
 *
 * 非迁移行（无源记录，如日常 ADMIN 购买/续订）**不受影响**，继续携带其业务 `externalReference`。
 * 业务订单引用也不在此承载：它保留在候选草稿与关闭审计的 `change_summary.external_reference`。
 */
export function legacySourceMarker(
  sourceRecordId: string | null | undefined,
  businessExternalReference: string | null | undefined,
): string | null {
  const recordId = sourceRecordId?.trim();
  if (recordId) return `${LEGACY_PURCHASE_MARKER_PREFIX}${recordId}`;
  return businessExternalReference ?? null;
}

// ===== 底层：唯一的事件插入 =====

export interface FinanceEventInsert {
  enterpriseId: string;
  resourceId: string;
  adminId: string | null;
  eventType: FinanceEventType;
  accountAmount: string;
  accountCurrency: FinanceCurrency;
  /** null 表示该事件类型不携带人民币实付（期初、更正、对账、冲销）。 */
  cashPaidCny: string | null;
  occurredAt: Date;
  externalReference?: string | null;
  reversalOfEventId?: string | null;
  correctionOfEventId?: string | null;
  reconciliationCaseId?: string | null;
  legacyCostResolutionId?: string | null;
  description?: string | null;
  evidenceRef?: string | null;
  source: "ADMIN" | "MIGRATION" | "RECONCILIATION" | "SYSTEM_REVERSAL" | "SYSTEM_RENEWAL";
  idempotencyKey: string;
}

/**
 * 资金事件唯一插入原语。所有事件类型都从这里落库，
 * 避免「日常一条 INSERT、激活另一条 INSERT」造成字段或默认值漂移。
 */
export async function insertFinanceEventTx(
  trx: Transaction<Database>, input: FinanceEventInsert,
): Promise<FinanceEventView> {
  const row = await trx.insertInto("provider_finance_event").values({
    enterprise_id: input.enterpriseId,
    provider_resource_id: input.resourceId,
    event_type: input.eventType,
    account_amount: money(input.accountAmount),
    account_currency: input.accountCurrency,
    cash_paid_cny: input.cashPaidCny === null ? null : money(input.cashPaidCny),
    occurred_at: input.occurredAt,
    external_reference: input.externalReference ?? null,
    reversal_of_event_id: input.reversalOfEventId ?? null,
    correction_of_event_id: input.correctionOfEventId ?? null,
    reconciliation_case_id: input.reconciliationCaseId ?? null,
    legacy_cost_resolution_id: input.legacyCostResolutionId ?? null,
    description: input.description ?? null,
    evidence_ref: input.evidenceRef ?? null,
    source: input.source,
    idempotency_key: input.idempotencyKey,
    created_by_admin_user_id: input.adminId,
  }).returningAll().executeTakeFirstOrThrow();
  return eventView(row);
}

// ===== 3.1 六个原语 =====

export interface OpeningBalanceWriteInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string;
  accountAmount: string;
  accountCurrency: FinanceCurrency;
  description: string | null;
  evidenceRef: string | null;
  idempotencyKey: string;
  source?: "ADMIN" | "MIGRATION";
  externalReference?: string | null;
  /**
   * 期初生效时点：缺省为切换时点（历史初始化口径不变，PFH-01）；
   * 激活后资源级期初（F-P2-6）由调用方传入资源自身生效时点，并自行完成
   * 「不早于资源 created_at、不晚于当前、多币种同点」校验。
   */
  occurredAt?: Date;
}

/**
 * 期初余额：发生时间缺省为资金切换时点，且不得携带人民币实付（PFH-01）。
 * F-P2-6：激活后资源级期初可显式传入资源自身生效时点（历史初始化路径不传，口径不变）。
 *
 * 同一企业+资源+币种只能存在一条原始期初（0059 部分唯一索引），
 * 因此「金额不同的重复期初」由数据库直接拒绝，而不是靠应用层比对。
 */
export async function insertOpeningBalanceTx(
  trx: Transaction<Database>, input: OpeningBalanceWriteInput,
): Promise<FinanceEventView> {
  return insertFinanceEventTx(trx, {
    enterpriseId: input.enterpriseId, resourceId: input.resourceId, adminId: input.adminId,
    eventType: "API_OPENING_BALANCE", accountAmount: input.accountAmount,
    accountCurrency: input.accountCurrency, cashPaidCny: null,
    occurredAt: input.occurredAt ?? PROVIDER_FINANCE_CUTOVER,
    externalReference: input.externalReference ?? null,
    description: input.description, evidenceRef: input.evidenceRef,
    source: input.source ?? "ADMIN", idempotencyKey: input.idempotencyKey,
  });
}

/** 资金事件的「正金额」形状：充值/购买/续费要求账户金额与人民币实付同时为正。 */
function assertPositiveMoneyPair(accountAmount: string, cashPaidCny: string | null | undefined): void {
  if (!new Money(accountAmount).gt(0)) {
    throw new ProviderFinanceError("INVALID_REQUEST", "账户金额必须为正");
  }
  if (cashPaidCny === null || cashPaidCny === undefined || !new Money(cashPaidCny).gt(0)) {
    throw new ProviderFinanceError("INVALID_REQUEST", "人民币实付必须为正");
  }
}

/** 历史/日常充值：`API_RECHARGE` 要求账户金额与人民币实付同时为正。 */
export async function insertRechargeTx(
  trx: Transaction<Database>, input: FinanceEventInput,
  options: { source?: "ADMIN" | "MIGRATION" } = {},
): Promise<FinanceEventView> {
  assertPositiveMoneyPair(input.accountAmount, input.cashPaidCny);
  return insertFinanceEventTx(trx, {
    enterpriseId: input.enterpriseId, resourceId: input.resourceId, adminId: input.adminId,
    eventType: "API_RECHARGE", accountAmount: input.accountAmount,
    accountCurrency: input.accountCurrency, cashPaidCny: input.cashPaidCny ?? null,
    occurredAt: input.occurredAt, externalReference: input.externalReference ?? null,
    description: input.description ?? null, evidenceRef: input.evidenceRef ?? null,
    source: options.source ?? "ADMIN", idempotencyKey: input.idempotencyKey,
  });
}

/**
 * 订阅/续费写入输入。
 *
 * 与日常 `SubscriptionInput` 结构兼容（后者可直接传入），
 * 但放宽了 `adminId`：系统自动续订没有操作管理员，`created_by_admin_user_id` 为 NULL。
 */
export interface SubscriptionWriteInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string | null;
  kind: "PURCHASE" | "RENEWAL";
  productName: string;
  accountAmount: string;
  accountCurrency: FinanceCurrency;
  cashPaidCny?: string | null;
  occurredAt: Date;
  externalReference?: string | null;
  description?: string | null;
  evidenceRef?: string | null;
  idempotencyKey: string;
  periodStart: Date;
  periodEndExclusive: Date;
}

/**
 * 订阅/续费：事件与周期必须同生同死。
 * `occurred_at` 落在服务开始日的上海自然日内，周期边界为上海零点。
 */
export async function insertSubscriptionTx(
  trx: Transaction<Database>, input: SubscriptionWriteInput,
  options: {
    source?: "ADMIN" | "MIGRATION" | "SYSTEM_RENEWAL";
    /** 周期来源；`MIGRATED_PURCHASE` 要求同时给出 `migrationSourceRecordId`（0059 形状约束）。 */
    periodSource?: "PURCHASE" | "RENEWAL" | "MIGRATED_PURCHASE";
    migrationSourceRecordId?: string | null;
    /** 覆盖 `created_by_admin_user_id`；系统续订传 null。 */
    actorAdminId?: string | null;
  } = {},
): Promise<{ event: FinanceEventView; periodId: string }> {
  assertShanghaiMidnight(input.periodStart, "订阅周期开始");
  assertShanghaiMidnight(input.periodEndExclusive, "订阅周期结束");
  if (input.periodStart.getTime() >= input.periodEndExclusive.getTime()) {
    throw new ProviderFinanceError("INVALID_REQUEST", "订阅周期结束必须晚于开始");
  }
  if (options.periodSource === "MIGRATED_PURCHASE" && !options.migrationSourceRecordId) {
    throw new ProviderFinanceError("INVALID_REQUEST", "迁移而来的订阅周期必须绑定源购买记录");
  }
  assertSameShanghaiDay(input.occurredAt, input.periodStart);
  assertPositiveMoneyPair(input.accountAmount, input.cashPaidCny);
  const actorAdminId = options.actorAdminId === undefined ? input.adminId : options.actorAdminId;
  const event = await insertFinanceEventTx(trx, {
    enterpriseId: input.enterpriseId, resourceId: input.resourceId, adminId: actorAdminId,
    eventType: input.kind === "PURCHASE" ? "CODING_PLAN_PURCHASE" : "CODING_PLAN_RENEWAL",
    accountAmount: input.accountAmount, accountCurrency: input.accountCurrency,
    cashPaidCny: input.cashPaidCny ?? null, occurredAt: input.occurredAt,
    externalReference: input.externalReference ?? null,
    description: input.description ?? null, evidenceRef: input.evidenceRef ?? null,
    source: options.source ?? "ADMIN", idempotencyKey: input.idempotencyKey,
  });
  const period = await trx.insertInto("provider_subscription_period").values({
    enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
    finance_event_id: event.id, product_name: input.productName,
    period_start: input.periodStart, period_end_exclusive: input.periodEndExclusive,
    source: options.periodSource ?? input.kind,
    migration_source_record_id: options.migrationSourceRecordId ?? null,
    reversed_by_event_id: null, created_by_admin_user_id: actorAdminId,
  }).returning("id").executeTakeFirstOrThrow();
  return { event, periodId: period.id };
}

export interface CarryoverPeriodWriteInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string | null;
  productName: string;
  /** 跨切换时点的既有周期，上海自然日边界。 */
  periodStart: Date;
  periodEndExclusive: Date;
  /** 运营快照 id；作为 `migration_source_record_id` 承担唯一性。 */
  migrationSourceRecordId: string;
  description: string | null;
  evidenceRef: string | null;
}

/**
 * 跨切换周期：切换时点前就已存在、跨过切换时点的既有套餐周期。
 *
 * 它不产生新的资金事件（钱在切换前已付），因此 `source='MIGRATED_CARRYOVER'`
 * 且 `finance_event_id IS NULL`；唯一性由 `migration_source_record_id` 保证。
 * 写入它的意义是让切换后的套餐用量能唯一归属到真实周期。
 */
export async function insertCarryoverPeriodTx(
  trx: Transaction<Database>, input: CarryoverPeriodWriteInput,
): Promise<{ periodId: string }> {
  assertShanghaiMidnight(input.periodStart, "跨切换周期开始");
  assertShanghaiMidnight(input.periodEndExclusive, "跨切换周期结束");
  if (input.periodStart.getTime() >= input.periodEndExclusive.getTime()) {
    throw new ProviderFinanceError("INVALID_REQUEST", "跨切换周期结束必须晚于开始");
  }
  const existing = await trx.selectFrom("provider_subscription_period").select("id")
    .where("enterprise_id", "=", input.enterpriseId)
    .where("migration_source_record_id", "=", input.migrationSourceRecordId)
    .executeTakeFirst();
  if (existing) return { periodId: existing.id };
  const period = await trx.insertInto("provider_subscription_period").values({
    enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
    finance_event_id: null, product_name: input.productName,
    period_start: input.periodStart, period_end_exclusive: input.periodEndExclusive,
    source: "MIGRATED_CARRYOVER", migration_source_record_id: input.migrationSourceRecordId,
    reversed_by_event_id: null, created_by_admin_user_id: input.adminId,
  }).returning("id").executeTakeFirstOrThrow();
  return { periodId: period.id };
}

export interface LegacyPurchaseClosureWriteInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string;
  legacyRecordId: string;
  resolution: "MIGRATED" | "ALREADY_REPRESENTED" | "REJECTED_WITH_EVIDENCE";
  /** MIGRATED：承载该笔资金的草稿明细行所写出的资金事件 id。 */
  migratedEventId: string | null;
  /** ALREADY_REPRESENTED：被引用的既有资金事件 id。 */
  representedEventId: string | null;
  externalReference: string | null;
  reason: string | null;
  evidenceRef: string | null;
}

/**
 * 旧购买记录关闭（PFH-02）。
 *
 * 关闭结果的权威载体是**审计行**：`change_summary` 固定记录
 * `legacy_record_id` 与关闭方式，`target_id` 固定为该旧记录，
 * 因此每条旧记录最多留下一个终态关闭决定，可被 activation-state 与审计复算。
 * MIGRATED 的金额事实由草稿明细行写出的资金事件承载，
 * 并在关闭审计里记录 `migrated_event_id`，形成「记录 → 事件」不可变映射。
 */
export async function closeLegacyPurchaseTx(
  trx: Transaction<Database>, input: LegacyPurchaseClosureWriteInput,
): Promise<void> {
  if (input.resolution === "MIGRATED" && (!input.migratedEventId || !input.externalReference)) {
    throw new ProviderFinanceError("INVALID_REQUEST", "MIGRATED 必须登记外部订单引用与对应资金事件");
  }
  if (input.resolution === "ALREADY_REPRESENTED" && !input.representedEventId) {
    throw new ProviderFinanceError("INVALID_REQUEST", "ALREADY_REPRESENTED 必须引用既有资金事件");
  }
  if (input.resolution === "REJECTED_WITH_EVIDENCE"
    && (!input.reason || !input.evidenceRef || input.reason.trim().length === 0
      || input.evidenceRef.trim().length === 0)) {
    throw new ProviderFinanceError("INVALID_REQUEST", "拒绝旧记录必须填写原因与证据");
  }
  await trx.insertInto("operation_log").values({
    actor_source: "ADMIN", enterprise_id: input.enterpriseId, admin_user_id: input.adminId,
    action: "provider_finance.legacy_purchase.close",
    target_type: "resource_purchase_record", target_id: input.legacyRecordId,
    result: "SUCCESS", failure_reason: null,
    change_summary: {
      resolution: input.resolution,
      resource_id: input.resourceId,
      migrated_event_id: input.migratedEventId,
      represented_event_id: input.representedEventId,
      external_reference: input.externalReference,
    },
  }).execute();
}

export interface ActivationAuditWriteInput {
  enterpriseId: string;
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: Record<string, unknown>;
  result?: "SUCCESS" | "FAILURE";
  failureReason?: string | null;
  actorSource?: "ADMIN" | "SYSTEM";
}

/** 审计写入原语：激活成功与失败留痕都走这里，字段形状一致。 */
export async function writeActivationAuditTx(
  trx: Transaction<Database>, input: ActivationAuditWriteInput,
): Promise<void> {
  await trx.insertInto("operation_log").values({
    actor_source: input.actorSource ?? "ADMIN",
    enterprise_id: input.enterpriseId,
    admin_user_id: input.adminId,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    result: input.result ?? "SUCCESS",
    failure_reason: input.failureReason ?? null,
    change_summary: input.summary,
  }).execute();
}
