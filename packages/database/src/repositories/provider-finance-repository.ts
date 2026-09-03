import { createHash, randomBytes } from "node:crypto";
import { Decimal } from "decimal.js";
import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "../kysely.js";
import { guardOperatingBillLedgerWrite } from "./operating-bill-write-barrier.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import {
  PROVIDER_FINANCE_CUTOVER,
  ProviderFinanceError,
  type DuplicateConfirmationInput,
  type FinanceBalanceView,
  type FinanceCurrency,
  type FinanceEventInput,
  type FinanceEventType,
  type FinanceEventView,
  type MonthlyFinanceSummary,
  type OpeningCorrectionInput,
  type ReconciliationCaseInput,
  type ResourceFinanceView,
  type ReverseFinanceEventInput,
  type SubscriptionInput,
} from "./provider-finance-types.js";

const Money = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

function money(value: Decimal.Value): string {
  return new Money(value).toDecimalPlaces(8).toFixed(8);
}

function stableHash(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Date) return item.toISOString();
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(normalize);
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function validateOrdinaryOccurredAt(value: Date): void {
  if (value < PROVIDER_FINANCE_CUTOVER) {
    throw new ProviderFinanceError("INVALID_REQUEST", "业务时间不得早于新账本切换时点");
  }
  if (value.getTime() > Date.now()) {
    throw new ProviderFinanceError("INVALID_REQUEST", "业务时间不能晚于当前时间");
  }
}

function eventView(row: {
  id: string; provider_resource_id: string; event_type: string; account_amount: string;
  account_currency: string; cash_paid_cny: string | null; occurred_at: Date;
  external_reference: string | null; reversal_of_event_id: string | null;
  correction_of_event_id: string | null; reconciliation_case_id: string | null;
  legacy_cost_resolution_id: string | null;
  description: string | null; evidence_ref: string | null; source: string; created_at: Date;
}): FinanceEventView {
  return {
    id: row.id, providerResourceId: row.provider_resource_id,
    eventType: row.event_type as FinanceEventType,
    accountAmount: row.account_amount, accountCurrency: row.account_currency as FinanceCurrency,
    cashPaidCny: row.cash_paid_cny, occurredAt: row.occurred_at.toISOString(),
    externalReference: row.external_reference, reversalOfEventId: row.reversal_of_event_id,
    correctionOfEventId: row.correction_of_event_id,
    reconciliationCaseId: row.reconciliation_case_id,
    legacyCostResolutionId: row.legacy_cost_resolution_id,
    description: row.description, evidenceRef: row.evidence_ref,
    source: row.source, createdAt: row.created_at.toISOString(), replayed: false,
  };
}

async function lockResource(
  trx: Transaction<Database>, enterpriseId: string, resourceId: string,
) {
  const resource = await trx.selectFrom("provider_resource")
    .select(["id", "mode"]).where("enterprise_id", "=", enterpriseId)
    .where("id", "=", resourceId).where("status", "<>", "DELETED")
    .forUpdate().executeTakeFirst();
  if (!resource) throw new ProviderFinanceError("NOT_FOUND", "厂商资源不存在");
  return resource;
}

export class ProviderFinanceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async isStrictWritesEnabled(enterpriseId: string): Promise<boolean> {
    const result = await sql<{ enabled: boolean }>`
      SELECT COALESCE((SELECT strict_writes_enabled
        FROM provider_finance_runtime_state WHERE enterprise_id=${enterpriseId}::uuid), false)
        AS enabled`.execute(this.db);
    return result.rows[0]?.enabled === true;
  }

  async recordOpeningBalance(input: FinanceEventInput): Promise<FinanceEventView> {
    if (input.occurredAt.getTime() !== PROVIDER_FINANCE_CUTOVER.getTime()) {
      throw new ProviderFinanceError("INVALID_REQUEST", "期初余额时间必须等于新账本切换时点");
    }
    return this.recordSimpleEvent("API_OPENING_BALANCE", input, null);
  }

  async recordRecharge(input: FinanceEventInput): Promise<FinanceEventView> {
    validateOrdinaryOccurredAt(input.occurredAt);
    return this.recordSimpleEvent("API_RECHARGE", input, input.cashPaidCny ?? null);
  }

  async recordSubscription(input: SubscriptionInput): Promise<{
    event: FinanceEventView; periodId: string;
  }> {
    validateOrdinaryOccurredAt(input.occurredAt);
    if (input.periodStart.getTime() >= input.periodEndExclusive.getTime()) {
      throw new ProviderFinanceError("INVALID_REQUEST", "订阅周期结束必须晚于开始");
    }
    const shanghaiOffset = 8 * 3600_000;
    const dayMs = 24 * 3600_000;
    if ((input.periodStart.getTime() + shanghaiOffset) % dayMs !== 0
      || (input.periodEndExclusive.getTime() + shanghaiOffset) % dayMs !== 0) {
      throw new ProviderFinanceError("INVALID_REQUEST", "订阅周期必须使用上海自然日零点边界");
    }
    const shanghaiDay = (value: Date) => new Date(value.getTime() + 8 * 3600_000)
      .toISOString().slice(0, 10);
    if (shanghaiDay(input.occurredAt) !== shanghaiDay(input.periodStart)) {
      throw new ProviderFinanceError("INVALID_REQUEST", "扣费日期必须等于服务周期开始日");
    }
    const eventType = input.kind === "PURCHASE"
      ? "CODING_PLAN_PURCHASE" : "CODING_PLAN_RENEWAL";
    const requestHash = stableHash({ eventType, enterpriseId: input.enterpriseId,
      resourceId: input.resourceId, adminId: input.adminId, accountAmount: input.accountAmount,
      accountCurrency: input.accountCurrency, cashPaidCny: input.cashPaidCny,
      occurredAt: input.occurredAt.toISOString(), externalReference: input.externalReference ?? null,
      description: input.description ?? null, evidenceRef: input.evidenceRef ?? null,
      kind: input.kind, productName: input.productName, periodStart: input.periodStart.toISOString(),
      periodEndExclusive: input.periodEndExclusive.toISOString() });
    const result = await this.db.transaction().execute(async (trx) => {
      const earlyReplay = await this.replay(trx, input, requestHash);
      if (earlyReplay) {
        const prior = earlyReplay as { event: FinanceEventView; periodId: string };
        return { ...prior, event: { ...prior.event, replayed: true } };
      }
      const resource = await lockResource(trx, input.enterpriseId, input.resourceId);
      if (resource.mode !== "CODING_PLAN") throw new ProviderFinanceError("INVALID_MODE", "请选择 Coding Plan 资源");
      const replay = await this.replay(trx, input, requestHash);
      if (replay) {
        const result = replay as { event: FinanceEventView; periodId: string };
        return { ...result, event: { ...result.event, replayed: true } };
      }
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, input.occurredAt);
      const duplicate = await this.authorizeDuplicate(trx, eventType, input, requestHash);
      if (duplicate.requirement) return { duplicate: duplicate.requirement };
      const row = await trx.insertInto("provider_finance_event").values({
        enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
        event_type: eventType, account_amount: money(input.accountAmount),
        account_currency: input.accountCurrency, cash_paid_cny: money(input.cashPaidCny!),
        occurred_at: input.occurredAt, external_reference: input.externalReference ?? null,
        reversal_of_event_id: null, correction_of_event_id: null, reconciliation_case_id: null,
        description: input.description ?? null, evidence_ref: input.evidenceRef ?? null,
        source: "ADMIN", idempotency_key: input.idempotencyKey,
        created_by_admin_user_id: input.adminId,
      }).returningAll().executeTakeFirstOrThrow();
      const period = await trx.insertInto("provider_subscription_period").values({
        enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
        finance_event_id: row.id, product_name: input.productName,
        period_start: input.periodStart, period_end_exclusive: input.periodEndExclusive,
        source: input.kind, migration_source_record_id: null, reversed_by_event_id: null,
        created_by_admin_user_id: input.adminId,
      }).returning("id").executeTakeFirstOrThrow();
      const response = { event: eventView(row), periodId: period.id };
      await this.auditAndRemember(trx, input, eventType, row.id, requestHash, response);
      await this.consumeDuplicateCandidate(trx, duplicate.candidateId, row.id);
      return response;
    });
    if ("duplicate" in result) {
      throw new ProviderFinanceError("DUPLICATE_CONFIRMATION_REQUIRED",
        "检测到可能重复的资金记录", result.duplicate);
    }
    return result;
  }

  private async recordSimpleEvent(
    eventType: "API_OPENING_BALANCE" | "API_RECHARGE",
    input: FinanceEventInput,
    expectedCash: string | null,
  ): Promise<FinanceEventView> {
    const requestHash = stableHash({ eventType, enterpriseId: input.enterpriseId,
      resourceId: input.resourceId, adminId: input.adminId, accountAmount: input.accountAmount,
      accountCurrency: input.accountCurrency, cashPaidCny: input.cashPaidCny ?? null,
      occurredAt: input.occurredAt.toISOString(), externalReference: input.externalReference ?? null,
      description: input.description ?? null, evidenceRef: input.evidenceRef ?? null });
    const result = await this.db.transaction().execute(async (trx) => {
      const earlyReplay = await this.replay(trx, input, requestHash);
      if (earlyReplay) return { ...earlyReplay as FinanceEventView, replayed: true };
      const resource = await lockResource(trx, input.enterpriseId, input.resourceId);
      if (resource.mode !== "API") throw new ProviderFinanceError("INVALID_MODE", "请选择 API 资源");
      const replay = await this.replay(trx, input, requestHash);
      if (replay) return { ...replay as FinanceEventView, replayed: true };
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, input.occurredAt);
      const duplicate = await this.authorizeDuplicate(trx, eventType, input, requestHash);
      if (duplicate.requirement) return { duplicate: duplicate.requirement };
      const row = await trx.insertInto("provider_finance_event").values({
        enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
        event_type: eventType, account_amount: money(input.accountAmount),
        account_currency: input.accountCurrency,
        cash_paid_cny: expectedCash === null ? null : money(expectedCash),
        occurred_at: input.occurredAt, external_reference: input.externalReference ?? null,
        reversal_of_event_id: null, correction_of_event_id: null, reconciliation_case_id: null,
        description: input.description ?? null, evidence_ref: input.evidenceRef ?? null,
        source: "ADMIN", idempotency_key: input.idempotencyKey,
        created_by_admin_user_id: input.adminId,
      }).returningAll().executeTakeFirstOrThrow();
      const response = eventView(row);
      await this.auditAndRemember(trx, input, eventType, row.id, requestHash, response);
      await this.consumeDuplicateCandidate(trx, duplicate.candidateId, row.id);
      return response;
    });
    if ("duplicate" in result) {
      throw new ProviderFinanceError("DUPLICATE_CONFIRMATION_REQUIRED",
        "检测到可能重复的资金记录", result.duplicate);
    }
    return result;
  }

  private async replay(
    trx: Transaction<Database>, input: FinanceEventInput, requestHash: string,
  ): Promise<unknown | null> {
    const prior = await trx.selectFrom("provider_finance_idempotency")
      .select(["request_hash", "response_snapshot"])
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
    if (!prior) return null;
    if (prior.request_hash !== requestHash) {
      throw new ProviderFinanceError("IDEMPOTENCY_CONFLICT", "幂等键已用于不同请求");
    }
    return prior.response_snapshot;
  }

  private async auditAndRemember(
    trx: Transaction<Database>, input: FinanceEventInput, eventType: FinanceEventType,
    eventId: string, requestHash: string, response: unknown,
  ) {
    await trx.insertInto("operation_log").values({
      enterprise_id: input.enterpriseId, admin_user_id: input.adminId,
      action: "provider_finance_event.create", target_type: "provider_finance_event",
      target_id: eventId, result: "SUCCESS", failure_reason: null,
      change_summary: JSON.stringify({ event_type: eventType, resource_id: input.resourceId,
        account_amount: money(input.accountAmount), account_currency: input.accountCurrency,
        cash_paid_cny: input.cashPaidCny ? money(input.cashPaidCny) : null,
        occurred_at: input.occurredAt.toISOString() }) as unknown as Record<string, unknown>,
    }).execute();
    await trx.insertInto("provider_finance_idempotency").values({
      enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
      idempotency_key: input.idempotencyKey, request_hash: requestHash,
      response_snapshot: JSON.stringify(response) as unknown as Record<string, unknown>,
    }).execute();
  }

  private async authorizeDuplicate(
    trx: Transaction<Database>,
    eventType: "API_RECHARGE" | "CODING_PLAN_PURCHASE" | "CODING_PLAN_RENEWAL" | "API_OPENING_BALANCE",
    input: FinanceEventInput,
    requestHash: string,
  ): Promise<{ candidateId: string | null; requirement?: {
    candidateId: string; confirmationToken: string; requestHash: string; expiresInSeconds: number;
  } }> {
    if (eventType === "API_OPENING_BALANCE" || input.externalReference) return { candidateId: null };
    await trx.updateTable("provider_finance_duplicate_candidate").set({ status: "EXPIRED" })
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .where("status", "=", "PENDING").where("expires_at", "<=", new Date()).execute();
    const existing = await trx.selectFrom("provider_finance_event").select(["id", "idempotency_key"])
      .where("enterprise_id", "=", input.enterpriseId).where("provider_resource_id", "=", input.resourceId)
      .where("event_type", "=", eventType).where("account_amount", "=", money(input.accountAmount))
      .where("account_currency", "=", input.accountCurrency)
      .where("cash_paid_cny", "=", money(input.cashPaidCny!))
      .where("occurred_at", "=", input.occurredAt).executeTakeFirst();
    if (!existing) return { candidateId: null };
    // 技术幂等重放优先于业务重复候选；同一请求号不得被误报为重复付款。
    if (existing.idempotency_key === input.idempotencyKey) return { candidateId: null };
    if (input.duplicateCandidateId && input.duplicateConfirmationToken) {
      const candidate = await trx.selectFrom("provider_finance_duplicate_candidate").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.duplicateCandidateId)
        .where("provider_resource_id", "=", input.resourceId).where("status", "=", "PENDING")
        .where("request_hash", "=", requestHash).where("created_by_admin_user_id", "=", input.adminId)
        .where("expires_at", ">", new Date()).executeTakeFirst();
      const tokenHash = stableHash(input.duplicateConfirmationToken);
      if (!candidate || candidate.confirmation_token_hash !== tokenHash) {
        throw new ProviderFinanceError("CONFLICT", "重复候选确认已过期或不匹配");
      }
      return { candidateId: candidate.id };
    }
    const token = randomBytes(24).toString("base64url");
    const subscription = "productName" in input ? input as SubscriptionInput : null;
    const candidate = await trx.insertInto("provider_finance_duplicate_candidate").values({
      enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
      event_type: eventType, request_hash: requestHash,
      request_payload: JSON.stringify({
        accountAmount: input.accountAmount, accountCurrency: input.accountCurrency,
        cashPaidCny: input.cashPaidCny ?? null, occurredAt: input.occurredAt.toISOString(),
        description: input.description ?? null, evidenceRef: input.evidenceRef ?? null,
        productName: subscription?.productName ?? null,
        periodStart: subscription?.periodStart.toISOString() ?? null,
        periodEndExclusive: subscription?.periodEndExclusive.toISOString() ?? null,
      }) as unknown as Record<string, unknown>,
      confirmation_token_hash: stableHash(token), expires_at: new Date(Date.now() + 15 * 60_000),
      created_by_admin_user_id: input.adminId, consumed_event_id: null, consumed_at: null,
    }).returning("id").executeTakeFirstOrThrow();
    return { candidateId: null, requirement: {
      candidateId: candidate.id, confirmationToken: token, requestHash, expiresInSeconds: 900,
    } };
  }

  async confirmDuplicateCandidate(input: DuplicateConfirmationInput): Promise<FinanceEventView | {
    event: FinanceEventView; periodId: string;
  }> {
    await this.db.updateTable("provider_finance_duplicate_candidate").set({ status: "EXPIRED" })
      .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.candidateId)
      .where("status", "=", "PENDING").where("expires_at", "<=", new Date()).execute();
    const candidate = await this.db.selectFrom("provider_finance_duplicate_candidate").selectAll()
      .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.candidateId)
      .where("created_by_admin_user_id", "=", input.adminId).executeTakeFirst();
    if (!candidate || candidate.request_hash !== input.requestHash
      || candidate.confirmation_token_hash !== stableHash(input.confirmationToken)) {
      throw new ProviderFinanceError("CONFLICT", "重复候选确认已过期或不匹配");
    }
    if (candidate?.status === "CONSUMED" && candidate.consumed_event_id) {
      const consumed = await this.db.selectFrom("provider_finance_event").selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", candidate.consumed_event_id).executeTakeFirstOrThrow();
      if (consumed.idempotency_key !== input.idempotencyKey) {
        throw new ProviderFinanceError("CONFLICT", "重复候选已经使用");
      }
      const event = { ...eventView(consumed), replayed: true };
      if (consumed.event_type === "CODING_PLAN_PURCHASE" || consumed.event_type === "CODING_PLAN_RENEWAL") {
        const period = await this.db.selectFrom("provider_subscription_period").select("id")
          .where("enterprise_id", "=", input.enterpriseId)
          .where("finance_event_id", "=", consumed.id).executeTakeFirstOrThrow();
        return { event, periodId: period.id };
      }
      return event;
    }
    if (candidate.status !== "PENDING" || candidate.expires_at <= new Date()) {
      throw new ProviderFinanceError("CONFLICT", "重复候选确认已过期或不匹配");
    }
    const payload = candidate.request_payload as Record<string, unknown>;
    const nullableText = (value: unknown): string | null => value === null || value === undefined
      ? null : String(value);
    const common: FinanceEventInput = {
      enterpriseId: candidate.enterprise_id, resourceId: candidate.provider_resource_id,
      adminId: input.adminId, accountAmount: String(payload.accountAmount),
      accountCurrency: String(payload.accountCurrency) as FinanceCurrency,
      cashPaidCny: String(payload.cashPaidCny), occurredAt: new Date(String(payload.occurredAt)),
      externalReference: null, description: nullableText(payload.description),
      evidenceRef: nullableText(payload.evidenceRef),
      idempotencyKey: input.idempotencyKey, duplicateCandidateId: candidate.id,
      duplicateConfirmationToken: input.confirmationToken,
    };
    if (candidate.event_type === "API_RECHARGE") return this.recordRecharge(common);
    if (candidate.event_type === "CODING_PLAN_PURCHASE" || candidate.event_type === "CODING_PLAN_RENEWAL") {
      return this.recordSubscription({
        ...common, kind: candidate.event_type === "CODING_PLAN_PURCHASE" ? "PURCHASE" : "RENEWAL",
        productName: String(payload.productName), periodStart: new Date(String(payload.periodStart)),
        periodEndExclusive: new Date(String(payload.periodEndExclusive)),
      });
    }
    throw new ProviderFinanceError("CONFLICT", "重复候选事件类型不支持确认");
  }

  private async consumeDuplicateCandidate(
    trx: Transaction<Database>, candidateId: string | null, eventId: string,
  ): Promise<void> {
    if (!candidateId) return;
    const updated = await trx.updateTable("provider_finance_duplicate_candidate").set({
      status: "CONSUMED", consumed_event_id: eventId, consumed_at: new Date(),
    }).where("id", "=", candidateId).where("status", "=", "PENDING").executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw new ProviderFinanceError("CONFLICT", "重复候选已被使用");
    }
  }

  async recordOpeningCorrection(input: OpeningCorrectionInput): Promise<FinanceEventView> {
    if (input.occurredAt.getTime() !== PROVIDER_FINANCE_CUTOVER.getTime()) {
      throw new ProviderFinanceError("INVALID_REQUEST", "期初更正时间必须等于新账本切换时点");
    }
    const requestHash = stableHash({ ...input, occurredAt: input.occurredAt.toISOString() });
    return this.db.transaction().execute(async (trx) => {
      const earlyReplay = await this.replay(trx, input, requestHash);
      if (earlyReplay) return { ...earlyReplay as FinanceEventView, replayed: true };
      const resource = await lockResource(trx, input.enterpriseId, input.resourceId);
      if (resource.mode !== "API") throw new ProviderFinanceError("INVALID_MODE", "请选择 API 资源");
      const replay = await this.replay(trx, input, requestHash);
      if (replay) return { ...replay as FinanceEventView, replayed: true };
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, input.occurredAt);
      const row = await trx.insertInto("provider_finance_event").values({
        enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
        event_type: "API_OPENING_BALANCE_CORRECTION", account_amount: money(input.accountAmount),
        account_currency: input.accountCurrency, cash_paid_cny: null,
        occurred_at: PROVIDER_FINANCE_CUTOVER, external_reference: null,
        reversal_of_event_id: null, correction_of_event_id: input.openingEventId,
        reconciliation_case_id: null, description: input.description ?? null,
        evidence_ref: input.evidenceRef ?? null, source: "ADMIN",
        idempotency_key: input.idempotencyKey, created_by_admin_user_id: input.adminId,
      }).returningAll().executeTakeFirstOrThrow();
      const response = eventView(row);
      await this.auditAndRemember(trx, input, "API_OPENING_BALANCE_CORRECTION", row.id, requestHash, response);
      return response;
    });
  }

  async reverseFinanceEvent(input: ReverseFinanceEventInput): Promise<FinanceEventView> {
    return this.db.transaction().execute(async (trx) => {
      const original = await trx.selectFrom("provider_finance_event").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.eventId)
        .forUpdate().executeTakeFirst();
      if (!original) throw new ProviderFinanceError("NOT_FOUND", "资金事件不存在");
      const eventInput: FinanceEventInput = {
        enterpriseId: input.enterpriseId, resourceId: original.provider_resource_id,
        adminId: input.adminId, accountAmount: money(new Money(original.account_amount).negated()),
        accountCurrency: original.account_currency,
        cashPaidCny: original.cash_paid_cny === null ? null : money(new Money(original.cash_paid_cny).negated()),
        occurredAt: original.occurred_at, description: input.reason,
        evidenceRef: input.evidenceRef, idempotencyKey: input.idempotencyKey,
      };
      const requestHash = stableHash({ eventId: input.eventId, reason: input.reason,
        evidenceRef: input.evidenceRef });
      const replay = await this.replay(trx, eventInput, requestHash);
      if (replay) return { ...replay as FinanceEventView, replayed: true };
      await lockResource(trx, input.enterpriseId, original.provider_resource_id);
      const replayAfterLock = await this.replay(trx, eventInput, requestHash);
      if (replayAfterLock) return { ...replayAfterLock as FinanceEventView, replayed: true };
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, original.occurred_at);
      const row = await trx.insertInto("provider_finance_event").values({
        enterprise_id: input.enterpriseId, provider_resource_id: original.provider_resource_id,
        event_type: "REVERSAL", account_amount: eventInput.accountAmount,
        account_currency: original.account_currency, cash_paid_cny: eventInput.cashPaidCny ?? null,
        occurred_at: original.occurred_at, external_reference: null,
        reversal_of_event_id: original.id, correction_of_event_id: null,
        reconciliation_case_id: null, description: input.reason, evidence_ref: input.evidenceRef,
        source: "SYSTEM_REVERSAL", idempotency_key: input.idempotencyKey,
        created_by_admin_user_id: input.adminId,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable("provider_subscription_period").set({ reversed_by_event_id: row.id })
        .where("enterprise_id", "=", input.enterpriseId)
        .where("finance_event_id", "=", original.id).execute();
      const response = eventView(row);
      await this.auditAndRemember(trx, eventInput, "REVERSAL", row.id, requestHash, response);
      return response;
    });
  }

  async createReconciliationCase(input: ReconciliationCaseInput) {
    if (input.balanceAsOf.getTime() > Date.now()) {
      throw new ProviderFinanceError("INVALID_REQUEST", "对账截止时间不能晚于当前时间");
    }
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      const balance = await this.loadCurrentBalanceSnapshot(
        trx, input.enterpriseId, input.resourceId, input.accountCurrency, input.balanceAsOf,
      );
      if (!balance) throw new ProviderFinanceError("NOT_FOUND", "API资源不存在");
      if (balance.balance === null) throw new ProviderFinanceError("CONFLICT", "余额不可计算，不能发起对账");
      const difference = new Money(input.providerConfirmedBalance).minus(balance.balance);
      if (difference.isZero() || new Money(input.providerConfirmedBalance).isNegative()) {
        throw new ProviderFinanceError("INVALID_REQUEST", "厂商确认余额必须非负且与本地余额存在差异");
      }
      const row = await trx.insertInto("provider_finance_reconciliation_case").values({
        enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
        account_currency: input.accountCurrency, local_balance: balance.balance,
        provider_confirmed_balance: money(input.providerConfirmedBalance),
        difference_amount: money(difference), balance_as_of: input.balanceAsOf,
        fact_watermark: JSON.stringify(balance.factWatermark) as unknown as Record<string, unknown>,
        decision: null, evidence_ref: input.evidenceRef, opened_by_admin_user_id: input.adminId,
        decided_by_admin_user_id: null, adjustment_event_id: null, decision_note: null,
        decision_idempotency_key: null, decided_at: null, resolved_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operation_log").values({
        enterprise_id: input.enterpriseId, admin_user_id: input.adminId,
        action: "provider_finance_reconciliation_case.create",
        target_type: "provider_finance_reconciliation_case", target_id: row.id,
        result: "SUCCESS", failure_reason: null,
        change_summary: JSON.stringify({ resource_id: input.resourceId,
          account_currency: input.accountCurrency, local_balance: balance.balance,
          provider_confirmed_balance: money(input.providerConfirmedBalance),
          balance_as_of: input.balanceAsOf.toISOString() }) as unknown as Record<string, unknown>,
      }).execute();
      return row;
    });
  }

  async rejectReconciliationCase(input: {
    enterpriseId: string; caseId: string; adminId: string; note: string; expectedVersion: number;
    idempotencyKey: string;
  }) {
    return this.db.transaction().execute(async (trx) => {
      const financeCase = await trx.selectFrom("provider_finance_reconciliation_case").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.caseId)
        .forUpdate().executeTakeFirst();
      if (!financeCase) throw new ProviderFinanceError("NOT_FOUND", "对账案件不存在");
      const eventInput: FinanceEventInput = {
        enterpriseId: input.enterpriseId, resourceId: financeCase.provider_resource_id,
        adminId: input.adminId, accountAmount: financeCase.difference_amount,
        accountCurrency: financeCase.account_currency, occurredAt: financeCase.balance_as_of,
        description: input.note, evidenceRef: financeCase.evidence_ref,
        idempotencyKey: input.idempotencyKey,
      };
      const requestHash = stableHash({ action: "REJECT", caseId: input.caseId,
        adminId: input.adminId, note: input.note, expectedVersion: input.expectedVersion });
      const replay = await this.replay(trx, eventInput, requestHash);
      if (replay) return replay;
      if (financeCase.status !== "OPEN" || financeCase.version !== input.expectedVersion) {
        throw new ProviderFinanceError("CONFLICT", "对账案件已被处理或版本冲突");
      }
      const row = await trx.updateTable("provider_finance_reconciliation_case").set({
        status: "REJECTED", decision: "REJECTED", decided_by_admin_user_id: input.adminId,
        decision_note: input.note, decided_at: new Date(), version: input.expectedVersion + 1,
        decision_idempotency_key: input.idempotencyKey, updated_at: new Date(),
      }).where("id", "=", financeCase.id).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operation_log").values({
        enterprise_id: input.enterpriseId, admin_user_id: input.adminId,
        action: "provider_finance_reconciliation_case.reject",
        target_type: "provider_finance_reconciliation_case", target_id: row.id,
        result: "SUCCESS", failure_reason: null,
        change_summary: JSON.stringify({ note: input.note, version: row.version }) as unknown as Record<string, unknown>,
      }).execute();
      await trx.insertInto("provider_finance_idempotency").values({
        enterprise_id: input.enterpriseId, provider_resource_id: financeCase.provider_resource_id,
        idempotency_key: input.idempotencyKey, request_hash: requestHash,
        response_snapshot: JSON.stringify(row) as unknown as Record<string, unknown>,
      }).execute();
      return row;
    });
  }

  async confirmReconciliationCase(input: {
    enterpriseId: string; caseId: string; adminId: string; note: string;
    expectedVersion: number; idempotencyKey: string;
  }): Promise<FinanceEventView> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      const financeCase = await trx.selectFrom("provider_finance_reconciliation_case").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.caseId)
        .forUpdate().executeTakeFirst();
      if (!financeCase) throw new ProviderFinanceError("NOT_FOUND", "对账案件不存在");
      const eventInput: FinanceEventInput = {
        enterpriseId: input.enterpriseId, resourceId: financeCase.provider_resource_id,
        adminId: input.adminId, accountAmount: financeCase.difference_amount,
        accountCurrency: financeCase.account_currency, cashPaidCny: null,
        occurredAt: financeCase.balance_as_of, description: input.note,
        evidenceRef: financeCase.evidence_ref, idempotencyKey: input.idempotencyKey,
      };
      const requestHash = stableHash({ action: "CONFIRM", caseId: input.caseId,
        adminId: input.adminId, note: input.note, expectedVersion: input.expectedVersion });
      const replay = await this.replay(trx, eventInput, requestHash);
      if (replay) return { ...replay as FinanceEventView, replayed: true };
      if (financeCase.status !== "OPEN" || financeCase.version !== input.expectedVersion) {
        throw new ProviderFinanceError("CONFLICT", "对账案件已被处理或版本冲突");
      }
      const current = await this.loadCurrentBalanceSnapshot(trx, input.enterpriseId,
        financeCase.provider_resource_id, financeCase.account_currency, financeCase.balance_as_of);
      if (!current?.balance || current.balance !== financeCase.local_balance
        || stableHash(current.factWatermark) !== stableHash(financeCase.fact_watermark)) {
        throw new ProviderFinanceError("CONFLICT", "余额事实水位已变化，请重新发起对账");
      }
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, financeCase.balance_as_of);
      const row = await trx.insertInto("provider_finance_event").values({
        enterprise_id: input.enterpriseId, provider_resource_id: financeCase.provider_resource_id,
        event_type: "API_BALANCE_RECONCILIATION",
        account_amount: financeCase.difference_amount, account_currency: financeCase.account_currency,
        cash_paid_cny: null, occurred_at: financeCase.balance_as_of, external_reference: null,
        reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: financeCase.id, description: input.note,
        evidence_ref: financeCase.evidence_ref, source: "RECONCILIATION",
        idempotency_key: input.idempotencyKey, created_by_admin_user_id: input.adminId,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable("provider_finance_reconciliation_case").set({
        status: "RESOLVED", decision: "CONFIRMED", adjustment_event_id: row.id,
        decided_by_admin_user_id: input.adminId, decision_note: input.note,
        decision_idempotency_key: input.idempotencyKey,
        decided_at: new Date(), resolved_at: new Date(), updated_at: new Date(),
        version: input.expectedVersion + 1,
      }).where("id", "=", financeCase.id).execute();
      const response = eventView(row);
      await this.auditAndRemember(trx, eventInput, "API_BALANCE_RECONCILIATION",
        row.id, requestHash, response);
      return response;
    });
  }

  async getCurrentBalance(
    enterpriseId: string, resourceId: string, currency: FinanceCurrency, asOf?: Date,
  ): Promise<FinanceBalanceView | null> {
    return this.db.transaction().setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        const effectiveAsOf = asOf ?? new Date();
        if (effectiveAsOf.getTime() > Date.now()) {
          throw new ProviderFinanceError("INVALID_REQUEST", "余额截止时间不能晚于当前时间");
        }
        return this.loadCurrentBalanceSnapshot(trx, enterpriseId, resourceId, currency, effectiveAsOf);
      });
  }

  /** @internal Reuses a caller-owned repeatable-read snapshot for atomic reports. */
  async loadCurrentBalanceSnapshot(
    trx: Transaction<Database>, enterpriseId: string, resourceId: string,
    currency: FinanceCurrency, asOf: Date,
  ): Promise<FinanceBalanceView | null> {
      const resource = await trx.selectFrom("provider_resource").select("id")
        .where("enterprise_id", "=", enterpriseId).where("id", "=", resourceId)
        .where("mode", "=", "API").where("status", "<>", "DELETED").executeTakeFirst();
      if (!resource) return null;
      const empty = {
        openingBalance: "0.00000000", openingCorrections: "0.00000000",
        recharges: "0.00000000", usageDebits: "0.00000000",
        balanceReconciliations: "0.00000000", legacyCostAdjustments: "0.00000000",
        reversals: "0.00000000",
      };
      if (asOf < PROVIDER_FINANCE_CUTOVER) return {
        providerResourceId: resourceId, currency, asOf: asOf.toISOString(),
        state: "LEGACY_ARCHIVED", balance: null, components: empty,
        factWatermark: { latestFinanceEventId: null, latestFinanceOccurredAt: null,
          latestLedgerLineId: null, latestSettledAt: null },
        reconciliationCaseId: null, gaps: [],
      };
      const [events, usage, unknown, openCase] = await Promise.all([
        sql<{ opening: string; corrections: string; recharges: string; reconciliations: string;
          legacy_costs: string;
          reversals: string; opening_count: string; latest_id: string | null; latest_at: Date | null }>`
          SELECT COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_OPENING_BALANCE'),0)::text AS opening,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_OPENING_BALANCE_CORRECTION'),0)::text AS corrections,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_RECHARGE'),0)::text AS recharges,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_BALANCE_RECONCILIATION'),0)::text AS reconciliations,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_LEGACY_COST_ADJUSTMENT'),0)::text AS legacy_costs,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='REVERSAL'),0)::text AS reversals,
                 COUNT(*) FILTER (WHERE event_type='API_OPENING_BALANCE')::text AS opening_count,
                 (ARRAY_AGG(id ORDER BY occurred_at DESC, created_at DESC, id DESC))[1] AS latest_id,
                 MAX(occurred_at) AS latest_at
            FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
             AND provider_resource_id=${resourceId}::uuid AND account_currency=${currency}
             AND occurred_at <= ${asOf}`.execute(trx),
        sql<{ amount: string; latest_id: string | null; latest_at: Date | null }>`
          SELECT COALESCE(SUM(api_cost) FILTER (
                   WHERE api_cost_status='PRICED_USAGE' AND api_cost_currency=${currency}
                 ),0)::text AS amount,
                 (ARRAY_AGG(id ORDER BY COALESCE(settled_at,created_at) DESC,
                   created_at DESC, id DESC))[1] AS latest_id,
                 MAX(COALESCE(settled_at,created_at)) AS latest_at
            FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
             AND provider_resource_id=${resourceId}::uuid AND resource_mode='API'
             AND COALESCE(settled_at,created_at) >= ${PROVIDER_FINANCE_CUTOVER}
             AND COALESCE(settled_at,created_at) <= ${asOf}`.execute(trx),
        sql<{ id: string; ai_request_id: string }>`SELECT line.id, line.ai_request_id
          FROM ledger_line line
          LEFT JOIN provider_finance_legacy_cost_resolution resolution
            ON resolution.enterprise_id=line.enterprise_id
           AND resolution.id=line.legacy_cost_resolution_id
          WHERE line.enterprise_id=${enterpriseId}::uuid
            AND line.provider_resource_id=${resourceId}::uuid
            AND line.resource_mode='API'
            AND (line.api_cost_status='UNKNOWN_COST' OR line.api_cost_status IS NULL)
            AND COALESCE(line.settled_at, line.created_at) >= ${PROVIDER_FINANCE_CUTOVER}
            AND COALESCE(line.settled_at, line.created_at) <= ${asOf}
            AND (resolution.id IS NULL OR resolution.status<>'RESOLVED'
              OR resolution.window_end_inclusive>${asOf})
          ORDER BY COALESCE(line.settled_at, line.created_at), line.id LIMIT 100`.execute(trx),
        trx.selectFrom("provider_finance_reconciliation_case").select("id")
          .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resourceId)
          .where("account_currency", "=", currency).where("status", "=", "OPEN")
          .executeTakeFirst(),
      ]);
      const e = events.rows[0]!; const u = usage.rows[0]!;
      const components = { openingBalance: money(e.opening), openingCorrections: money(e.corrections),
        recharges: money(e.recharges), usageDebits: money(u.amount),
        balanceReconciliations: money(e.reconciliations),
        legacyCostAdjustments: money(e.legacy_costs), reversals: money(e.reversals) };
      const base = { providerResourceId: resourceId, currency, asOf: asOf.toISOString(), components,
        factWatermark: { latestFinanceEventId: e.latest_id,
          latestFinanceOccurredAt: e.latest_at?.toISOString() ?? null,
          latestLedgerLineId: u.latest_id, latestSettledAt: u.latest_at?.toISOString() ?? null },
        reconciliationCaseId: openCase?.id ?? null };
      if (Number(e.opening_count) === 0) return { ...base, state: "MISSING_OPENING_BALANCE", balance: null, gaps: [] };
      if (unknown.rows.length > 0) return { ...base, state: "INCOMPLETE_USAGE_COST", balance: null,
        gaps: unknown.rows.map((row) => ({ code: "API_USAGE_COST_UNKNOWN", requestId: row.ai_request_id, ledgerLineId: row.id })) };
      const balance = new Money(e.opening).plus(e.corrections).plus(e.recharges)
        .plus(e.reconciliations).plus(e.legacy_costs).plus(e.reversals).minus(u.amount);
      return { ...base, state: balance.isNegative() ? "NEGATIVE_RECONCILIATION_REQUIRED" : "NORMAL",
        balance: money(balance), gaps: [] };
  }

  async listFinanceEvents(
    enterpriseId: string,
    resourceId: string,
    input: { from?: Date; to?: Date; eventType?: FinanceEventType; limit: number; offset: number },
  ): Promise<{ items: FinanceEventView[]; total: number } | null> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const resource = await trx.selectFrom("provider_resource").select("id")
        .where("enterprise_id", "=", enterpriseId).where("id", "=", resourceId)
        .where("status", "<>", "DELETED").executeTakeFirst();
      if (!resource) return null;
      let query = trx.selectFrom("provider_finance_event").selectAll()
        .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resourceId);
      let countQuery = trx.selectFrom("provider_finance_event")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resourceId);
      if (input.from) query = query.where("occurred_at", ">=", input.from);
      if (input.to) query = query.where("occurred_at", "<", input.to);
      if (input.eventType) query = query.where("event_type", "=", input.eventType);
      if (input.from) countQuery = countQuery.where("occurred_at", ">=", input.from);
      if (input.to) countQuery = countQuery.where("occurred_at", "<", input.to);
      if (input.eventType) countQuery = countQuery.where("event_type", "=", input.eventType);
      const [rows, count] = await Promise.all([
        query.orderBy("occurred_at", "desc").orderBy("created_at", "desc").orderBy("id", "desc")
          .limit(input.limit).offset(input.offset).execute(),
        countQuery.executeTakeFirstOrThrow(),
      ]);
      return { items: rows.map(eventView), total: Number(count.count) };
    });
  }

  async getMonthlyFinanceSummary(
    enterpriseId: string, month: string,
  ): Promise<MonthlyFinanceSummary> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return this.loadMonthlyFinanceSummary(trx, enterpriseId, month);
    });
  }

  async listResourceFinanceViews(
    enterpriseId: string, month: string, asOf = new Date(),
  ): Promise<ResourceFinanceView[]> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return this.loadResourceFinanceViews(trx, enterpriseId, month, asOf);
    });
  }

  /** @internal Reuses the operating-bill close transaction snapshot. */
  async loadResourceFinanceViews(
    trx: Transaction<Database>, enterpriseId: string, month: string, asOf: Date,
  ): Promise<ResourceFinanceView[]> {
      const { start, end } = operatingBillMonthRange(month);
      const [resources, accountKeys, apiCosts, recharges, planCosts, periods] = await Promise.all([
        trx.selectFrom("provider_resource").select(["id", "mode"])
          .where("enterprise_id", "=", enterpriseId).where("status", "<>", "DELETED").execute(),
        sql<{ provider_resource_id: string; currency: FinanceCurrency }>`
          SELECT DISTINCT provider_resource_id, currency FROM (
            SELECT provider_resource_id, account_currency AS currency
              FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
               AND event_type='API_OPENING_BALANCE'
            UNION
            SELECT provider_resource_id, api_cost_currency AS currency
              FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
               AND resource_mode='API' AND api_cost_status='PRICED_USAGE'
               AND api_cost_currency IS NOT NULL AND settled_at>=${start} AND settled_at<${end}
          ) account ORDER BY provider_resource_id, currency`.execute(trx),
        sql<{ provider_resource_id: string; currency: FinanceCurrency; amount: string }>`
          SELECT provider_resource_id, currency, COALESCE(SUM(amount),0)::text AS amount FROM (
            SELECT provider_resource_id, api_cost_currency AS currency, api_cost AS amount
              FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
               AND resource_mode='API' AND api_cost_status='PRICED_USAGE'
               AND settled_at>=${start} AND settled_at<${end}
            UNION ALL
            SELECT provider_resource_id, account_currency, -account_amount
              FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
               AND event_type='API_LEGACY_COST_ADJUSTMENT'
               AND occurred_at>=${start} AND occurred_at<${end}
          ) cost GROUP BY provider_resource_id, currency`.execute(trx),
        sql<{ provider_resource_id: string; currency: FinanceCurrency; amount: string }>`
          SELECT provider_resource_id, account_currency AS currency,
                 COALESCE(SUM(account_amount),0)::text AS amount
            FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
             AND event_type IN ('API_RECHARGE','REVERSAL')
             AND occurred_at>=${start} AND occurred_at<${end}
           GROUP BY provider_resource_id, account_currency`.execute(trx),
        sql<{ provider_resource_id: string; cash_cny: string }>`
          SELECT event.provider_resource_id, COALESCE(SUM(event.cash_paid_cny),0)::text AS cash_cny
            FROM provider_finance_event event
            JOIN provider_resource resource ON resource.enterprise_id=event.enterprise_id
             AND resource.id=event.provider_resource_id AND resource.mode='CODING_PLAN'
           WHERE event.enterprise_id=${enterpriseId}::uuid
             AND event.event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL')
             AND event.occurred_at>=${start} AND event.occurred_at<${end}
           GROUP BY event.provider_resource_id`.execute(trx),
        sql<{ id: string; provider_resource_id: string; product_name: string;
          period_start: Date; period_end_exclusive: Date; true_tokens: string;
          request_count: string }>`
          SELECT DISTINCT ON (period.provider_resource_id)
                 period.id, period.provider_resource_id, period.product_name,
                 period.period_start, period.period_end_exclusive,
                 COALESCE(usage.true_tokens,0)::text AS true_tokens,
                 COALESCE(usage.request_count,0)::text AS request_count
            FROM provider_subscription_period period
            LEFT JOIN LATERAL (
              SELECT SUM(line.raw_input_tokens+line.raw_output_tokens) AS true_tokens,
                     COUNT(DISTINCT line.ai_request_id) AS request_count
                FROM ledger_line line WHERE line.enterprise_id=period.enterprise_id
                 AND line.subscription_period_id=period.id
            ) usage ON true
           WHERE period.enterprise_id=${enterpriseId}::uuid
             AND period.reversed_by_event_id IS NULL
             AND period.period_start<=${asOf} AND period.period_end_exclusive>${asOf}
           ORDER BY period.provider_resource_id, period.period_start DESC,
                    period.created_at DESC, period.id DESC`.execute(trx),
      ]);
      const key = (resourceId: string, currency: string) => `${resourceId}:${currency}`;
      const costs = new Map(apiCosts.rows.map((row) => [key(row.provider_resource_id, row.currency), row.amount]));
      const recharge = new Map(recharges.rows.map((row) => [key(row.provider_resource_id, row.currency), row.amount]));
      const planCash = new Map(planCosts.rows.map((row) => [row.provider_resource_id, row.cash_cny]));
      const currentPeriods = new Map(periods.rows.map((row) => [row.provider_resource_id, row]));
      const balances = await Promise.all(accountKeys.rows.map(async (account) => ({
        account,
        balance: await this.loadCurrentBalanceSnapshot(
          trx, enterpriseId, account.provider_resource_id, account.currency, asOf,
        ),
        opening: await this.loadCurrentBalanceSnapshot(
          trx, enterpriseId, account.provider_resource_id, account.currency, start,
        ),
      })));
      const accountsByResource = new Map<string, ResourceFinanceView["accounts"]>();
      for (const item of balances) {
        const list = accountsByResource.get(item.account.provider_resource_id) ?? [];
        list.push({ currency: item.account.currency,
          balanceState: item.balance?.state ?? "MISSING_OPENING_BALANCE",
          balance: item.balance?.balance ?? null,
          monthOpeningState: item.opening?.state ?? "MISSING_OPENING_BALANCE",
          monthOpeningBalance: item.opening?.balance ?? null,
          monthlyRecharge: money(recharge.get(key(item.account.provider_resource_id,
            item.account.currency)) ?? 0),
          monthlyApiCost: money(costs.get(key(item.account.provider_resource_id,
            item.account.currency)) ?? 0) });
        accountsByResource.set(item.account.provider_resource_id, list);
      }
      return resources.map((resource) => {
        const period = currentPeriods.get(resource.id);
        return { resourceId: resource.id, mode: resource.mode,
          accounts: accountsByResource.get(resource.id) ?? [],
          monthlyPlanCashCny: money(planCash.get(resource.id) ?? 0),
          currentPeriod: period ? { id: period.id, productName: period.product_name,
            periodStart: period.period_start.toISOString(),
            periodEndExclusive: period.period_end_exclusive.toISOString(),
            trueTokens: period.true_tokens, requestCount: period.request_count } : null };
      });
  }

  /** @internal Reuses a caller-owned repeatable-read snapshot for cutover conservation. */
  async loadMonthlyFinanceSummary(
    trx: Transaction<Database>, enterpriseId: string, month: string,
  ): Promise<MonthlyFinanceSummary> {
    const { start, end } = operatingBillMonthRange(month);
    const [cash, eventAmounts, apiCosts, gapResult] = await Promise.all([
      sql<{ amount: string }>`SELECT COALESCE(SUM(cash_paid_cny),0)::text AS amount
        FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
          AND occurred_at>=${start} AND occurred_at<${end}`.execute(trx),
      sql<{ mode: "API" | "CODING_PLAN"; currency: FinanceCurrency; amount: string;
        cash_cny: string }>`
        SELECT pr.mode, event.account_currency AS currency,
               COALESCE(SUM(event.account_amount),0)::text AS amount,
               COALESCE(SUM(event.cash_paid_cny),0)::text AS cash_cny
          FROM provider_finance_event event
          JOIN provider_resource pr ON pr.id=event.provider_resource_id
           AND pr.enterprise_id=event.enterprise_id
         WHERE event.enterprise_id=${enterpriseId}::uuid
           AND event.occurred_at>=${start} AND event.occurred_at<${end}
           AND (event.event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
             OR event.event_type='REVERSAL')
         GROUP BY pr.mode, event.account_currency ORDER BY pr.mode, event.account_currency`.execute(trx),
      sql<{ currency: FinanceCurrency; amount: string }>`
        SELECT currency, COALESCE(SUM(amount),0)::text AS amount FROM (
          SELECT api_cost_currency AS currency, api_cost AS amount
            FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
             AND resource_mode='API' AND api_cost_status='PRICED_USAGE'
             AND settled_at>=${start} AND settled_at<${end}
          UNION ALL
          SELECT account_currency AS currency, -account_amount AS amount
            FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
             AND event_type='API_LEGACY_COST_ADJUSTMENT'
             AND occurred_at>=${start} AND occurred_at<${end}
        ) cost
        GROUP BY currency ORDER BY currency`.execute(trx),
      sql<{ code: string; count: string }>`
        SELECT 'API_USAGE_COST_UNKNOWN' AS code, COUNT(*)::text AS count
          FROM ledger_line line
          LEFT JOIN provider_finance_legacy_cost_resolution resolution
            ON resolution.enterprise_id=line.enterprise_id
           AND resolution.id=line.legacy_cost_resolution_id
         WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='API'
           AND (line.api_cost_status='UNKNOWN_COST' OR line.api_cost_status IS NULL)
           AND COALESCE(line.settled_at, line.created_at)>=${start}
           AND COALESCE(line.settled_at, line.created_at)<${end}
           AND (resolution.id IS NULL OR resolution.status<>'RESOLVED')
        UNION ALL
        SELECT 'API_COST_CURRENCY_MISSING', COUNT(*)::text
          FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid AND resource_mode='API'
           AND api_cost IS NOT NULL AND api_cost_currency IS NULL
           AND COALESCE(settled_at, created_at)>=${start}
           AND COALESCE(settled_at, created_at)<${end}
        UNION ALL
        SELECT 'API_COST_CURRENCY_CONFLICT', COUNT(*)::text
          FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid AND resource_mode='API'
           AND api_cost_currency IS NOT NULL
           AND billing_rule_snapshot->>'currency' IS NOT NULL
           AND billing_rule_snapshot->>'currency' <> api_cost_currency
           AND COALESCE(settled_at, created_at)>=${start}
           AND COALESCE(settled_at, created_at)<${end}
        UNION ALL
        SELECT 'OPENING_BALANCE_MISSING', COUNT(*)::text FROM (
          SELECT DISTINCT line.provider_resource_id, line.api_cost_currency
            FROM ledger_line line
           WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='API'
             AND line.api_cost_status='PRICED_USAGE' AND line.api_cost_currency IS NOT NULL
             AND line.settled_at>=${start} AND line.settled_at<${end}
             AND NOT EXISTS (
               SELECT 1 FROM provider_finance_event opening
                WHERE opening.enterprise_id=line.enterprise_id
                  AND opening.provider_resource_id=line.provider_resource_id
                  AND opening.account_currency=line.api_cost_currency
                  AND opening.event_type='API_OPENING_BALANCE'
             )
        ) missing_opening
        UNION ALL
        SELECT 'SUBSCRIPTION_PERIOD_MISSING', COUNT(*)::text
          FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
           AND resource_mode='CODING_PLAN' AND subscription_period_id IS NULL
           AND COALESCE(settled_at, created_at)>=${start}
           AND COALESCE(settled_at, created_at)<${end}
        UNION ALL
        SELECT 'CASH_PAID_CNY_MISSING', COUNT(*)::text
          FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
           AND event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
           AND cash_paid_cny IS NULL AND occurred_at>=${start} AND occurred_at<${end}
      `.execute(trx),
    ]);
    const apiRecharges = eventAmounts.rows.filter((row) => row.mode === "API")
      .map((row) => ({ currency: row.currency, amount: money(row.amount) }));
    const codingPlanOrders = eventAmounts.rows.filter((row) => row.mode === "CODING_PLAN")
      .map((row) => ({ currency: row.currency, amount: money(row.amount) }));
    const planCash = eventAmounts.rows.filter((row) => row.mode === "CODING_PLAN")
      .reduce((sum, row) => sum.plus(row.cash_cny), new Money(0));
    const cnyApi = apiCosts.rows.find((row) => row.currency === "CNY")?.amount ?? "0";
    const summaryGaps = gapResult.rows.filter((row) => Number(row.count) > 0)
      .map((row) => ({ code: row.code, count: Number(row.count) }));
    return {
      month, timezone: "Asia/Shanghai", cashOutflowCny: money(cash.rows[0]?.amount ?? "0"),
      apiRecharges, apiOperatingCosts: apiCosts.rows.map((row) => ({
        currency: row.currency, amount: money(row.amount),
      })), codingPlanOrders, codingPlanFixedCostCny: money(planCash),
      operatingCostCny: money(new Money(cnyApi).plus(planCash)),
      operatingCostByCurrency: apiCosts.rows.filter((row) => row.currency !== "CNY")
        .map((row) => ({ currency: row.currency, amount: money(row.amount) })),
      complete: summaryGaps.length === 0,
      gaps: summaryGaps,
    };
  }

  async listSubscriptionPeriods(enterpriseId: string, resourceId: string) {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const resource = await trx.selectFrom("provider_resource").select("id")
      .where("enterprise_id", "=", enterpriseId).where("id", "=", resourceId)
      .where("mode", "=", "CODING_PLAN").where("status", "<>", "DELETED")
      .executeTakeFirst();
    if (!resource) return null;
    const now = new Date();
    const rows = await trx.selectFrom("provider_subscription_period")
      .leftJoin("provider_finance_event", (join) => join
        .onRef("provider_finance_event.enterprise_id", "=", "provider_subscription_period.enterprise_id")
        .onRef("provider_finance_event.id", "=", "provider_subscription_period.finance_event_id"))
      .selectAll("provider_subscription_period")
      .select(["provider_finance_event.account_amount as fixed_fee_amount",
        "provider_finance_event.account_currency as fixed_fee_currency",
        "provider_finance_event.cash_paid_cny as fixed_cash_paid_cny"])
      .where("provider_subscription_period.enterprise_id", "=", enterpriseId)
      .where("provider_subscription_period.provider_resource_id", "=", resourceId)
      .orderBy("provider_subscription_period.period_start", "desc").execute();
    const usageResult = await sql<{
      subscription_period_id: string; request_count: string; input_tokens: string;
      output_tokens: string; cache_tokens: string; reasoning_tokens: string; true_tokens: string;
    }>`SELECT subscription_period_id, COUNT(DISTINCT ai_request_id)::text AS request_count,
              COALESCE(SUM(raw_input_tokens),0)::text AS input_tokens,
              COALESCE(SUM(raw_output_tokens),0)::text AS output_tokens,
              COALESCE(SUM(raw_cache_tokens),0)::text AS cache_tokens,
              COALESCE(SUM(raw_reasoning_tokens),0)::text AS reasoning_tokens,
              COALESCE(SUM(raw_input_tokens+raw_output_tokens),0)::text AS true_tokens
         FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
          AND provider_resource_id=${resourceId}::uuid AND resource_mode='CODING_PLAN'
          AND subscription_period_id IS NOT NULL GROUP BY subscription_period_id`.execute(trx);
    const usageByPeriod = new Map(usageResult.rows.map((usage) => [usage.subscription_period_id, usage]));
    return rows.map((row) => ({ ...row, current_status: row.reversed_by_event_id ? "REVERSED"
      : now >= row.period_end_exclusive ? "EXPIRED"
        : now >= row.period_start ? "ACTIVE" : "UPCOMING",
      token_usage: usageByPeriod.get(row.id) ?? {
        subscription_period_id: row.id, request_count: "0", input_tokens: "0",
        output_tokens: "0", cache_tokens: "0", reasoning_tokens: "0", true_tokens: "0",
      } }));
    });
  }

  async getSubscriptionPeriodUsage(enterpriseId: string, periodId: string) {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const period = await trx.selectFrom("provider_subscription_period")
      .select(["id", "provider_resource_id", "product_name", "period_start",
        "period_end_exclusive", "reversed_by_event_id"])
      .where("enterprise_id", "=", enterpriseId).where("id", "=", periodId)
      .executeTakeFirst();
    if (!period) return null;
    const result = await sql<{ request_count: string; input_tokens: string; output_tokens: string;
      cache_tokens: string; reasoning_tokens: string; true_tokens: string }>`
      SELECT COUNT(DISTINCT ai_request_id)::text AS request_count,
             COALESCE(SUM(raw_input_tokens),0)::text AS input_tokens,
             COALESCE(SUM(raw_output_tokens),0)::text AS output_tokens,
             COALESCE(SUM(raw_cache_tokens),0)::text AS cache_tokens,
             COALESCE(SUM(raw_reasoning_tokens),0)::text AS reasoning_tokens,
             COALESCE(SUM(raw_input_tokens+raw_output_tokens),0)::text AS true_tokens
        FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
         AND subscription_period_id=${periodId}::uuid`.execute(trx);
    return { period, tokenUsage: result.rows[0]! };
    });
  }

  async listReconciliationCases(
    enterpriseId: string,
    input: { status?: "OPEN" | "REJECTED" | "RESOLVED"; limit: number; offset: number },
  ) {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      let query = trx.selectFrom("provider_finance_reconciliation_case").selectAll()
        .where("enterprise_id", "=", enterpriseId);
      let countQuery = trx.selectFrom("provider_finance_reconciliation_case")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("enterprise_id", "=", enterpriseId);
      if (input.status) {
        query = query.where("status", "=", input.status);
        countQuery = countQuery.where("status", "=", input.status);
      }
      const [rows, count] = await Promise.all([
        query.orderBy("created_at", "desc").orderBy("id", "desc")
          .limit(input.limit).offset(input.offset).execute(),
        countQuery.executeTakeFirstOrThrow(),
      ]);
      return { items: rows, total: Number(count.count) };
    });
  }
}
