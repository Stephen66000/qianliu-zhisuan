import { randomBytes } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { guardOperatingBillLedgerWrite } from "./operating-bill-write-barrier.js";
import { markAllocationDirty, shanghaiMonthOf } from "./project-allocation-common.js";
import { Money, eventView, lockResource, money, stableHash, validateOrdinaryOccurredAt } from "./provider-finance-core.js";
import {
  insertFinanceEventTx, insertOpeningBalanceTx, insertRechargeTx, insertSubscriptionTx,
} from "./provider-finance-activation-writes.js";
import {
  ProviderFinanceError, type DuplicateConfirmationInput,
  type FinanceCurrency, type FinanceEventInput, type FinanceEventType, type FinanceEventView,
  type OpeningCorrectionInput, type ReverseFinanceEventInput, type SubscriptionInput,
} from "./provider-finance-types.js";

export class ProviderFinanceEventRepository {
  constructor(protected readonly db: Kysely<Database>) {}

  async isStrictWritesEnabled(enterpriseId: string): Promise<boolean> {
    const result = await sql<{ enabled: boolean }>`
      SELECT COALESCE((SELECT strict_writes_enabled
        FROM provider_finance_runtime_state WHERE enterprise_id=${enterpriseId}::uuid), false)
        AS enabled`.execute(this.db);
    return result.rows[0]?.enabled === true;
  }

  async recordOpeningBalance(input: FinanceEventInput): Promise<FinanceEventView> {
    // F-P2-6：期初时点校验在事务内持锁后进行（需资源 created_at 作下界、
    // 既有期初行作多币种同点约束），见 recordSimpleEvent 的 API_OPENING_BALANCE 分支。
    return this.recordSimpleEvent("API_OPENING_BALANCE", input);
  }

  async recordRecharge(input: FinanceEventInput): Promise<FinanceEventView> {
    validateOrdinaryOccurredAt(input.occurredAt);
    return this.recordSimpleEvent("API_RECHARGE", input);
  }

  async recordSubscription(input: SubscriptionInput): Promise<{
    event: FinanceEventView; periodId: string;
  }> {
    validateOrdinaryOccurredAt(input.occurredAt);
    const eventType = input.kind === "PURCHASE"
      ? "CODING_PLAN_PURCHASE" : "CODING_PLAN_RENEWAL";
    const requestHash = stableHash({ eventType, enterpriseId: input.enterpriseId,
      resourceId: input.resourceId, adminId: input.adminId, accountAmount: input.accountAmount,
      accountCurrency: input.accountCurrency, cashPaidCny: input.cashPaidCny,
      occurredAt: input.occurredAt.toISOString(), externalReference: input.externalReference ?? null,
      description: input.description ?? null, evidenceRef: input.evidenceRef ?? null,
      kind: input.kind, productName: input.productName, periodStart: input.periodStart.toISOString(),
      periodEndExclusive: input.periodEndExclusive.toISOString(),
      ...(input.autoRenew === undefined ? {} : { autoRenew: input.autoRenew }) });
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
      const systemPeriod = await trx.selectFrom("provider_subscription_period as period")
        .innerJoin("provider_finance_event as event", join => join.onRef("event.id", "=", "period.finance_event_id")
          .onRef("event.enterprise_id", "=", "period.enterprise_id"))
        .selectAll("event").select("period.id as period_id")
        .where("period.enterprise_id", "=", input.enterpriseId).where("period.provider_resource_id", "=", input.resourceId)
        .where("period.period_start", "=", input.periodStart).where("period.period_end_exclusive", "=", input.periodEndExclusive)
        .where("period.reversed_by_event_id", "is", null).where("event.source", "=", "SYSTEM_RENEWAL").executeTakeFirst();
      if (systemPeriod) {
        if (systemPeriod.account_amount !== money(input.accountAmount) || systemPeriod.account_currency !== input.accountCurrency
          || systemPeriod.cash_paid_cny !== money(input.cashPaidCny!)) {
          throw new ProviderFinanceError("CONFLICT", "本周期已系统续订，金额不同请先核对原记录");
        }
        return { event: { ...eventView(systemPeriod), replayed: true }, periodId: systemPeriod.period_id };
      }
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, input.occurredAt);
      const duplicate = await this.authorizeDuplicate(trx, eventType, input, requestHash);
      if (duplicate.requirement) return { duplicate: duplicate.requirement };
      // 事件与周期由 3.1 原语同生同死写入，激活事务复用同一段代码。
      const written = await insertSubscriptionTx(trx, input);
      // A newly registered subscription starts a new standing renewal instruction; replay does not undo cancellation.
      await trx.updateTable("provider_resource").set({ subscription_auto_renew_enabled: input.autoRenew ?? true })
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.resourceId).execute();
      const response = { event: written.event, periodId: written.periodId };
      await this.auditAndRemember(trx, input, eventType, written.event.id, requestHash, response);
      await this.consumeDuplicateCandidate(trx, duplicate.candidateId, written.event.id);
      // CODING_PLAN 现金事件是归集余量（C08）的 authority：同事务按事件月推脏，
      // 使套餐购买/续订后余量表随下一个批次刷新，而不是等下次任意输入变更。
      await markAllocationDirty(trx, input.enterpriseId, [shanghaiMonthOf(input.occurredAt)]);
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
      // F-P2-6：激活后资源级期初使用资源自身生效时点——不得早于资源创建、不得在未来，
      // 多币种期初保持同一资源生效时点（首个期初锚定；历史初始化路径不经此入口）。
      if (eventType === "API_OPENING_BALANCE") {
        if (input.occurredAt.getTime() < resource.created_at.getTime()) {
          throw new ProviderFinanceError("INVALID_REQUEST", "期初时间不得早于资源创建时点");
        }
        if (input.occurredAt.getTime() > Date.now()) {
          throw new ProviderFinanceError("INVALID_REQUEST", "期初时间不能晚于当前时间");
        }
        const existingOpenings = await trx.selectFrom("provider_finance_event")
          .select("occurred_at")
          .where("enterprise_id", "=", input.enterpriseId)
          .where("provider_resource_id", "=", input.resourceId)
          .where("event_type", "=", "API_OPENING_BALANCE")
          .execute();
        if (existingOpenings.some((row) => row.occurred_at.getTime() !== input.occurredAt.getTime())) {
          throw new ProviderFinanceError("INVALID_REQUEST", "多币种期初必须使用同一资源生效时点");
        }
      }
      const replay = await this.replay(trx, input, requestHash);
      if (replay) return { ...replay as FinanceEventView, replayed: true };
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, input.occurredAt);
      const duplicate = await this.authorizeDuplicate(trx, eventType, input, requestHash);
      if (duplicate.requirement) return { duplicate: duplicate.requirement };
      // 期初与充值由 3.1 原语落库：期初时点由入口语义决定（资源级=资源生效时点，
      // 历史初始化=切换时点缺省）且不带实付，充值强制正金额。
      const response = eventType === "API_OPENING_BALANCE"
        ? await insertOpeningBalanceTx(trx, {
          enterpriseId: input.enterpriseId, resourceId: input.resourceId, adminId: input.adminId,
          accountAmount: input.accountAmount, accountCurrency: input.accountCurrency,
          occurredAt: input.occurredAt,
          description: input.description ?? null, evidenceRef: input.evidenceRef ?? null,
          externalReference: input.externalReference ?? null, idempotencyKey: input.idempotencyKey,
        })
        : await insertRechargeTx(trx, input);
      await this.auditAndRemember(trx, input, eventType, response.id, requestHash, response);
      await this.consumeDuplicateCandidate(trx, duplicate.candidateId, response.id);
      return response;
    });
    if ("duplicate" in result) {
      throw new ProviderFinanceError("DUPLICATE_CONFIRMATION_REQUIRED",
        "检测到可能重复的资金记录", result.duplicate);
    }
    return result;
  }

  protected async replay(
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

  protected async auditAndRemember(
    trx: Transaction<Database>, input: FinanceEventInput, eventType: FinanceEventType,
    eventId: string, requestHash: string, response: unknown,
  ) {
    await trx.insertInto("operation_log").values({ actor_source: "ADMIN",
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
        productName: subscription?.productName ?? null, autoRenew: subscription?.autoRenew,
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
        ...common, autoRenew: typeof payload.autoRenew === "boolean" ? payload.autoRenew : undefined, kind: candidate.event_type === "CODING_PLAN_PURCHASE" ? "PURCHASE" : "RENEWAL",
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
    const requestHash = stableHash({ ...input, occurredAt: input.occurredAt.toISOString() });
    return this.db.transaction().execute(async (trx) => {
      const earlyReplay = await this.replay(trx, input, requestHash);
      if (earlyReplay) return { ...earlyReplay as FinanceEventView, replayed: true };
      const resource = await lockResource(trx, input.enterpriseId, input.resourceId);
      if (resource.mode !== "API") throw new ProviderFinanceError("INVALID_MODE", "请选择 API 资源");
      // F-P2-6：期初更正追随其原始期初时点（初始化期初仍锚定切换时点，口径不变）。
      const original = await trx.selectFrom("provider_finance_event")
        .select(["event_type", "occurred_at"])
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.openingEventId)
        .executeTakeFirst();
      if (!original || original.event_type !== "API_OPENING_BALANCE") {
        throw new ProviderFinanceError("NOT_FOUND", "原始期初事件不存在");
      }
      if (input.occurredAt.getTime() !== original.occurred_at.getTime()) {
        throw new ProviderFinanceError("INVALID_REQUEST", "期初更正时间必须等于原始期初时点");
      }
      const replay = await this.replay(trx, input, requestHash);
      if (replay) return { ...replay as FinanceEventView, replayed: true };
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, input.occurredAt);
      const row = await insertFinanceEventTx(trx, {
        enterpriseId: input.enterpriseId, resourceId: input.resourceId, adminId: input.adminId,
        eventType: "API_OPENING_BALANCE_CORRECTION", accountAmount: input.accountAmount,
        accountCurrency: input.accountCurrency, cashPaidCny: null,
        occurredAt: original.occurred_at, correctionOfEventId: input.openingEventId,
        description: input.description ?? null, evidenceRef: input.evidenceRef ?? null,
        source: "ADMIN", idempotencyKey: input.idempotencyKey,
      });
      await this.auditAndRemember(trx, input, "API_OPENING_BALANCE_CORRECTION", row.id, requestHash, row);
      return row;
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
      const resource = await lockResource(trx, input.enterpriseId, original.provider_resource_id);
      const replayAfterLock = await this.replay(trx, eventInput, requestHash);
      if (replayAfterLock) return { ...replayAfterLock as FinanceEventView, replayed: true };
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, original.occurred_at);
      const row = await insertFinanceEventTx(trx, {
        enterpriseId: input.enterpriseId, resourceId: original.provider_resource_id, adminId: input.adminId,
        eventType: "REVERSAL", accountAmount: eventInput.accountAmount,
        accountCurrency: original.account_currency, cashPaidCny: eventInput.cashPaidCny ?? null,
        occurredAt: original.occurred_at, reversalOfEventId: original.id,
        description: input.reason, evidenceRef: input.evidenceRef,
        source: "SYSTEM_REVERSAL", idempotencyKey: input.idempotencyKey,
      });
      await trx.updateTable("provider_subscription_period").set({ reversed_by_event_id: row.id })
        .where("enterprise_id", "=", input.enterpriseId)
        .where("finance_event_id", "=", original.id).execute();
      const response = row;
      await this.auditAndRemember(trx, eventInput, "REVERSAL", row.id, requestHash, response);
      // 冲正同上：套餐资源的冲正计入余量 authority，同事务按原事件月推脏。
      if (resource.mode === "CODING_PLAN") {
        await markAllocationDirty(trx, input.enterpriseId, [shanghaiMonthOf(original.occurred_at)]);
      }
      return response;
    });
  }

}
