import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProviderFinanceError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  BalanceQuery, currentShanghaiMonthRange, dayAfterShanghaiDate, defaultServiceEndDate,
  DuplicateConfirmationBody,
  EventQuery, MonthQuery, OpeningBalanceBody,
  OpeningCorrectionBody, RechargeBody, ReconciliationCaseBody,
  ReconciliationDecisionBody, ReconciliationQuery, ResourceParams, ReversalBody, shanghaiDayStart,
  SubscriptionBody,
} from "./contracts.js";

function invalid(reply: FastifyReply, message = "请求参数不合法") {
  return reply.code(400).send({ error: "invalid_request", message });
}

function financeFailure(error: unknown, reply: FastifyReply) {
  if (!(error instanceof ProviderFinanceError)) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code) : null;
    if (code === "23505" || code === "23503" || code === "23514" || code === "P0001") {
      return reply.code(409).send({
        error: "finance_contract_conflict",
        message: "资金记录与现有事实冲突，请核对期初、付款凭证、资源模式或关联事件",
      });
    }
    throw error;
  }
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "INVALID_MODE" || error.code === "CONFLICT"
      || error.code === "IDEMPOTENCY_CONFLICT"
      || error.code === "DUPLICATE_CONFIRMATION_REQUIRED" ? 409 : 400;
  return reply.code(status).send({ error: error.code.toLowerCase(), message: error.message,
    ...(error.detail ? { detail: error.detail } : {}) });
}

export function registerProviderFinanceRoutes(
  app: FastifyInstance,
  options: { mode: "DARK" | "ACTIVE" },
): void {
  const requireActive = async (req: FastifyRequest, reply: FastifyReply) => {
    if (options.mode !== "ACTIVE") {
      return reply.code(404).send({ error: "not_found", message: "资金写入口尚未启用" });
    }
    if (!req.admin || !await app.providerFinanceRepo.isStrictWritesEnabled(req.admin.enterpriseId)) {
      return reply.code(503).send({
        error: "finance_write_contract_inactive",
        message: "严格资金写合同尚未通过守恒门启用",
      });
    }
  };
  const writeGuards = [requireAuth, requireActive];
  app.post("/provider-resources/:id/finance/opening-balances", { preHandler: writeGuards },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params); const body = OpeningBalanceBody.safeParse(req.body);
      if (!params.success || !body.success) return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
      try {
        const event = await app.providerFinanceRepo.recordOpeningBalance({
          enterpriseId: req.admin!.enterpriseId, resourceId: params.data.id,
          adminId: req.admin!.adminUserId, accountAmount: body.data.account_amount,
          accountCurrency: body.data.account_currency, occurredAt: new Date(body.data.occurred_at),
          description: body.data.description ?? null, evidenceRef: body.data.evidence_ref ?? null,
          idempotencyKey: body.data.idempotency_key,
        });
        return reply.code(event.replayed ? 200 : 201).send({ event });
      } catch (error) { return financeFailure(error, reply); }
    });

  app.post("/provider-resources/:id/finance/opening-balance-corrections", { preHandler: writeGuards },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params); const body = OpeningCorrectionBody.safeParse(req.body);
      if (!params.success || !body.success) return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
      try {
        const event = await app.providerFinanceRepo.recordOpeningCorrection({
          enterpriseId: req.admin!.enterpriseId, resourceId: params.data.id,
          adminId: req.admin!.adminUserId, openingEventId: body.data.opening_event_id,
          accountAmount: body.data.account_amount, accountCurrency: body.data.account_currency,
          occurredAt: new Date(body.data.occurred_at), description: body.data.description ?? null,
          evidenceRef: body.data.evidence_ref ?? null, idempotencyKey: body.data.idempotency_key,
        });
        return reply.code(event.replayed ? 200 : 201).send({ event });
      } catch (error) { return financeFailure(error, reply); }
    });

  app.post("/provider-resources/:id/finance/recharges", { preHandler: writeGuards },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params); const body = RechargeBody.safeParse(req.body);
      if (!params.success || !body.success) return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
      try {
        const event = await app.providerFinanceRepo.recordRecharge({
          enterpriseId: req.admin!.enterpriseId, resourceId: params.data.id,
          adminId: req.admin!.adminUserId, accountAmount: body.data.account_amount,
          accountCurrency: body.data.account_currency, cashPaidCny: body.data.cash_paid_cny,
          occurredAt: new Date(body.data.occurred_at), externalReference: body.data.external_reference ?? null,
          description: body.data.description ?? null, evidenceRef: body.data.evidence_ref ?? null,
          idempotencyKey: body.data.idempotency_key,
        });
        return reply.code(event.replayed ? 200 : 201).send({ event });
      } catch (error) { return financeFailure(error, reply); }
    });

  app.post("/provider-resources/:id/finance/subscriptions", { preHandler: writeGuards },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params); const body = SubscriptionBody.safeParse(req.body);
      if (!params.success || !body.success) return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
      try {
        const result = await app.providerFinanceRepo.recordSubscription({
          enterpriseId: req.admin!.enterpriseId, resourceId: params.data.id,
          adminId: req.admin!.adminUserId, kind: body.data.kind, productName: body.data.product_name,
          accountAmount: body.data.account_amount, accountCurrency: body.data.account_currency,
          cashPaidCny: body.data.cash_paid_cny, occurredAt: new Date(body.data.occurred_at),
          periodStart: shanghaiDayStart(body.data.service_period_start),
          periodEndExclusive: dayAfterShanghaiDate(body.data.service_period_end
            ?? defaultServiceEndDate(body.data.service_period_start)),
          externalReference: body.data.external_reference ?? null,
          description: body.data.description ?? null, evidenceRef: body.data.evidence_ref ?? null,
          idempotencyKey: body.data.idempotency_key,
        });
        return reply.code(result.event.replayed ? 200 : 201).send(result);
      } catch (error) { return financeFailure(error, reply); }
    });

  app.get("/provider-resources/:id/finance/balance", { preHandler: [requireAuth] }, async (req, reply) => {
    const params = ResourceParams.safeParse(req.params); const query = BalanceQuery.safeParse(req.query);
    if (!params.success || !query.success) return invalid(reply, query.success ? undefined : query.error.issues[0]?.message);
    const asOf = query.data.as_of ? new Date(query.data.as_of) : undefined;
    let balance;
    try {
      balance = await app.providerFinanceRepo.getCurrentBalance(
        req.admin!.enterpriseId, params.data.id, query.data.currency, asOf,
      );
    } catch (error) { return financeFailure(error, reply); }
    if (!balance) return reply.code(404).send({ error: "not_found", message: "API资源不存在" });
    return balance;
  });

  app.get("/provider-resources/:id/finance/events", { preHandler: [requireAuth] }, async (req, reply) => {
    const params = ResourceParams.safeParse(req.params); const query = EventQuery.safeParse(req.query);
    if (!params.success || !query.success) return invalid(reply, query.success ? undefined : query.error.issues[0]?.message);
    const defaultRange = !query.data.from && !query.data.to ? currentShanghaiMonthRange() : null;
    const result = await app.providerFinanceRepo.listFinanceEvents(req.admin!.enterpriseId, params.data.id, {
      from: query.data.from ? new Date(query.data.from) : defaultRange?.from,
      to: query.data.to ? new Date(query.data.to) : defaultRange?.to,
      eventType: query.data.type,
      limit: query.data.limit, offset: query.data.offset,
    });
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return result;
  });

  app.get("/provider-resources/:id/subscription-periods", { preHandler: [requireAuth] }, async (req, reply) => {
    const params = ResourceParams.safeParse(req.params);
    if (!params.success) return invalid(reply);
    const periods = await app.providerFinanceRepo.listSubscriptionPeriods(req.admin!.enterpriseId, params.data.id);
    if (!periods) return reply.code(404).send({ error: "not_found", message: "Coding Plan资源不存在" });
    return { periods };
  });

  app.get("/provider-subscription-periods/:id/usage", { preHandler: [requireAuth] }, async (req, reply) => {
    const params = ResourceParams.safeParse(req.params);
    if (!params.success) return invalid(reply);
    const usage = await app.providerFinanceRepo.getSubscriptionPeriodUsage(
      req.admin!.enterpriseId, params.data.id,
    );
    if (!usage) return reply.code(404).send({ error: "not_found", message: "订阅周期不存在" });
    return usage;
  });

  app.get("/provider-finance/reconciliation-cases", { preHandler: [requireAuth] }, async (req, reply) => {
    const query = ReconciliationQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error.issues[0]?.message);
    return app.providerFinanceRepo.listReconciliationCases(req.admin!.enterpriseId, query.data);
  });

  app.post("/provider-finance-events/:id/reversal", { preHandler: writeGuards }, async (req, reply) => {
    const params = ResourceParams.safeParse(req.params); const body = ReversalBody.safeParse(req.body);
    if (!params.success || !body.success) return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
    try {
      const event = await app.providerFinanceRepo.reverseFinanceEvent({
        enterpriseId: req.admin!.enterpriseId, eventId: params.data.id,
        adminId: req.admin!.adminUserId, reason: body.data.reason,
        evidenceRef: body.data.evidence_ref, idempotencyKey: body.data.idempotency_key,
      });
      return reply.code(event.replayed ? 200 : 201).send({ event });
    } catch (error) { return financeFailure(error, reply); }
  });

  app.post("/provider-finance-duplicate-candidates/:id/confirm", { preHandler: writeGuards },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params);
      const body = DuplicateConfirmationBody.safeParse(req.body);
      if (!params.success || !body.success) {
        return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
      }
      try {
        const result = await app.providerFinanceRepo.confirmDuplicateCandidate({
          enterpriseId: req.admin!.enterpriseId, candidateId: params.data.id,
          adminId: req.admin!.adminUserId, confirmationToken: body.data.confirmation_token,
          requestHash: body.data.request_hash, idempotencyKey: body.data.idempotency_key,
        });
        if ("event" in result) {
          return reply.code(result.event.replayed ? 200 : 201).send(result);
        }
        return reply.code(result.replayed ? 200 : 201).send({ event: result });
      } catch (error) { return financeFailure(error, reply); }
    });

  app.post("/provider-resources/:id/finance/reconciliation-cases", { preHandler: writeGuards },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params); const body = ReconciliationCaseBody.safeParse(req.body);
      if (!params.success || !body.success) return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
      try {
        const financeCase = await app.providerFinanceRepo.createReconciliationCase({
          enterpriseId: req.admin!.enterpriseId, resourceId: params.data.id,
          adminId: req.admin!.adminUserId, accountCurrency: body.data.account_currency,
          providerConfirmedBalance: body.data.provider_confirmed_balance,
          balanceAsOf: new Date(body.data.balance_as_of), evidenceRef: body.data.evidence_ref,
        });
        return reply.code(201).send({ case: financeCase });
      } catch (error) { return financeFailure(error, reply); }
    });

  app.post("/provider-finance-reconciliation-cases/:id/confirm", { preHandler: writeGuards },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params); const body = ReconciliationDecisionBody.safeParse(req.body);
      if (!params.success || !body.success) return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
      try {
        const event = await app.providerFinanceRepo.confirmReconciliationCase({
          enterpriseId: req.admin!.enterpriseId, caseId: params.data.id,
          adminId: req.admin!.adminUserId, note: body.data.note,
          expectedVersion: body.data.expected_version, idempotencyKey: body.data.idempotency_key,
        });
        return { event };
      } catch (error) { return financeFailure(error, reply); }
    });

  app.post("/provider-finance-reconciliation-cases/:id/reject", { preHandler: writeGuards },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params); const body = ReconciliationDecisionBody.safeParse(req.body);
      if (!params.success || !body.success) return invalid(reply, body.success ? undefined : body.error.issues[0]?.message);
      try {
        return { case: await app.providerFinanceRepo.rejectReconciliationCase({
          enterpriseId: req.admin!.enterpriseId, caseId: params.data.id,
          adminId: req.admin!.adminUserId, note: body.data.note,
          expectedVersion: body.data.expected_version, idempotencyKey: body.data.idempotency_key,
        }) };
      } catch (error) { return financeFailure(error, reply); }
    });

  app.get("/provider-finance/summary", { preHandler: [requireAuth] }, async (req, reply) => {
    const query = MonthQuery.safeParse(req.query);
    if (!query.success) return invalid(reply, query.error.issues[0]?.message);
    return app.providerFinanceRepo.getMonthlyFinanceSummary(req.admin!.enterpriseId, query.data.month);
  });
}
