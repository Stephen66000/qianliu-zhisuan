import { guardOperatingBillLedgerWrite } from "./operating-bill-write-barrier.js";
import { Money, eventView, money, stableHash } from "./provider-finance-core.js";
import { ProviderFinanceBalanceRepository } from "./provider-finance-balances.js";
import {
  ProviderFinanceError,
  type FinanceEventInput,
  type FinanceEventView,
  type ReconciliationCaseInput,
} from "./provider-finance-types.js";

export class ProviderFinanceReconciliationRepository extends ProviderFinanceBalanceRepository {
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

}
