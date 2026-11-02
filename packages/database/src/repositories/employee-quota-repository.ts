import type { Kysely } from "kysely";
import { evaluateQuotaGate, type QuotaGateResult } from "@qianliu/domain";
import type { Database } from "../kysely.js";
import type { EmployeeQuotaBasis } from "../employee-quota-types.js";
import {
  currentScope,
  activePool,
  ensureCurrentQuotaPeriod,
  type EmployeeQuotaScope,
} from "./employee-quota-period-repository.js";
import {
  readQuotaPeriodsInTransaction,
  type ReadEmployeeQuotaPeriodsInput,
} from "./employee-quota-read-repository.js";
import { settleEmployeeQuotaInTransaction } from "./employee-quota-settlement.js";
export {
  ensureCurrentQuotaPeriod,
  adjustEmployeeQuotaPeriod,
  employeeQuotaPeriodSnapshot,
  type EmployeeQuotaScope,
} from "./employee-quota-period-repository.js";
export {
  readQuotaPeriodsInTransaction,
  type ReadEmployeeQuotaPeriodsInput,
} from "./employee-quota-read-repository.js";
export {
  settleEmployeeQuotaInTransaction,
  settleMonthlyQuotaItems,
} from "./employee-quota-settlement.js";
export { previewEmployeeQuotaReconciliation } from "./employee-quota-reconciliation.js";
export interface ReserveEmployeeQuotaInput extends EmployeeQuotaScope {
  modelAlias: string;
  requestId: string;
  attemptNo: number;
  basis: EmployeeQuotaBasis;
  estimatedCost: bigint;
}
export interface ReserveEmployeeQuotaOutcome {
  mode: "LEGACY" | "MONTHLY";
  decision: QuotaGateResult["decision"];
  grantId: string | null;
  reservedEstimate: bigint;
  gate: QuotaGateResult;
  periodId?: string;
  usageId?: string;
  basis?: EmployeeQuotaBasis;
  periodEnd?: Date;
}

export class EmployeeQuotaRepository {
  constructor(private db: Kysely<Database>) {}
  async reserveEmployeeQuota(
    input: ReserveEmployeeQuotaInput,
  ): Promise<ReserveEmployeeQuotaOutcome> {
    if (
      input.estimatedCost < 0n ||
      !Number.isInteger(input.attemptNo) ||
      input.attemptNo < 1
    )
      throw new Error("invalid_quota_reservation");
    return this.db.transaction().execute(async (trx) => {
      const scope = await currentScope(trx, input);
      const noGrant = evaluateQuotaGate({
        hasGrant: false,
        grantStatus: null,
        validFrom: null,
        validUntil: null,
        quotaValue: 0n,
        usedValue: 0n,
        estimatedCost: input.estimatedCost,
        allowOverage: false,
        now: (input.now ?? new Date()).getTime(),
      });
      if (!scope)
        return {
          mode: "LEGACY",
          decision: noGrant.decision,
          grantId: null,
          reservedEstimate: 0n,
          gate: noGrant,
        };
      const request = await trx
        .selectFrom("ai_request")
        .select(["principal_id", "status"])
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.requestId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        request.principal_id !== input.principalId ||
        request.status !== "IN_PROGRESS"
      )
        throw new Error("quota_request_scope_conflict");
      const grant = await activePool(trx, input, scope.now);
      const existing = await trx
        .selectFrom("principal_quota_usage")
        .selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("request_id", "=", input.requestId)
        .where("attempt_no", "=", input.attemptNo)
        .executeTakeFirst();
      const period = existing
        ? await trx
            .selectFrom("principal_quota_period")
            .selectAll()
            .where("enterprise_id", "=", input.enterpriseId)
            .where("id", "=", existing.period_id)
            .forUpdate()
            .executeTakeFirstOrThrow()
        : await ensureCurrentQuotaPeriod(trx, input);
      const disabled = await trx
        .selectFrom("principal_provider_disabled_model")
        .innerJoin(
          "unified_model",
          "unified_model.id",
          "principal_provider_disabled_model.unified_model_id",
        )
        .select("unified_model.id")
        .where(
          "principal_provider_disabled_model.enterprise_id",
          "=",
          input.enterpriseId,
        )
        .where("principal_id", "=", input.principalId)
        .where("provider", "=", input.provider)
        .where("unified_model.alias", "=", input.modelAlias)
        .executeTakeFirst();
      if (!period || !grant || disabled)
        return {
          mode: "MONTHLY",
          decision: noGrant.decision,
          grantId: grant?.id ?? null,
          reservedEstimate: 0n,
          gate: noGrant,
        };
      if (period.quota_basis !== input.basis)
        throw new Error("quota_basis_route_conflict");
      if (existing) {
        if (
          existing.period_id !== period.id ||
          existing.quota_basis !== input.basis ||
          BigInt(existing.estimate) !== input.estimatedCost ||
          existing.status !== "RESERVED"
        )
          throw new Error("quota_reservation_replay_conflict");
        const gate = evaluateQuotaGate({
          hasGrant: true,
          grantStatus: "ACTIVE",
          validFrom: null,
          validUntil: null,
          quotaValue: BigInt(period.limit_value),
          usedValue:
            BigInt(period.used_value) +
            BigInt(period.reserved_value) -
            BigInt(existing.estimate),
          estimatedCost: input.estimatedCost,
          allowOverage: grant.allow_overage,
          now: +scope.now,
        });
        return {
          mode: "MONTHLY",
          decision: gate.decision,
          grantId: existing.grant_id,
          reservedEstimate: BigInt(existing.estimate),
          gate,
          periodId: period.id,
          usageId: existing.id,
          basis: input.basis,
          periodEnd: period.period_end,
        };
      }
      const gate = evaluateQuotaGate({
        hasGrant: true,
        grantStatus: "ACTIVE",
        validFrom: null,
        validUntil: null,
        quotaValue: BigInt(period.limit_value),
        usedValue: BigInt(period.used_value) + BigInt(period.reserved_value),
        estimatedCost: input.estimatedCost,
        allowOverage: grant.allow_overage,
        now: +scope.now,
      });
      if (gate.decision.startsWith("REJECT"))
        return {
          mode: "MONTHLY",
          decision: gate.decision,
          grantId: grant.id,
          reservedEstimate: 0n,
          gate,
          periodId: period.id,
          basis: input.basis,
          periodEnd: period.period_end,
        };
      const usage = await trx
        .insertInto("principal_quota_usage")
        .values({
          enterprise_id: input.enterpriseId,
          request_id: input.requestId,
          attempt_no: input.attemptNo,
          upstream_attempt_id: null,
          period_id: period.id,
          grant_id: grant.id,
          grant_version: grant.version,
          quota_basis: input.basis,
          estimate: input.estimatedCost,
          actual: null,
          settled_at: null,
          created_at: scope.now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("principal_quota_period")
        .set({
          reserved_value: BigInt(period.reserved_value) + input.estimatedCost,
          updated_at: scope.now,
        })
        .where("id", "=", period.id)
        .execute();
      return {
        mode: "MONTHLY",
        decision: gate.decision,
        grantId: grant.id,
        reservedEstimate: input.estimatedCost,
        gate,
        periodId: period.id,
        usageId: usage.id,
        basis: input.basis,
        periodEnd: period.period_end,
      };
    });
  }
  async bindEmployeeQuotaAttempt(input: {
    enterpriseId: string;
    usageId: string;
    upstreamAttemptId: string;
  }) {
    return this.db.transaction().execute(async (trx) => {
      const usage = await trx
        .selectFrom("principal_quota_usage")
        .selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.usageId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const attempt = await trx
        .selectFrom("upstream_attempt")
        .select(["ai_request_id", "attempt_no"])
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.upstreamAttemptId)
        .executeTakeFirstOrThrow();
      if (
        attempt.ai_request_id !== usage.request_id ||
        attempt.attempt_no !== usage.attempt_no ||
        (usage.upstream_attempt_id &&
          usage.upstream_attempt_id !== input.upstreamAttemptId) ||
        usage.status !== "RESERVED"
      )
        throw new Error("quota_attempt_binding_conflict");
      await trx
        .updateTable("principal_quota_usage")
        .set({ upstream_attempt_id: input.upstreamAttemptId })
        .where("id", "=", usage.id)
        .execute();
    });
  }
  async settleEmployeeQuota(
    input: Parameters<typeof settleEmployeeQuotaInTransaction>[1],
  ) {
    return this.db
      .transaction()
      .execute((trx) => settleEmployeeQuotaInTransaction(trx, input));
  }
  async ensureCurrentQuotaPeriod(input: EmployeeQuotaScope) {
    return this.db
      .transaction()
      .execute((trx) => ensureCurrentQuotaPeriod(trx, input));
  }
  async readQuotaPeriods(input: ReadEmployeeQuotaPeriodsInput) {
    return readQuotaPeriodsInTransaction(this.db, input);
  }
  async initializeCurrentQuotaPeriods(
    input: { enterpriseId?: string; now?: Date } = {},
  ) {
    const now = input.now ?? new Date();
    let query = this.db
      .selectFrom("enterprise")
      .select("id")
      .where("employee_quota_monthly_from", "<=", now);
    if (input.enterpriseId) query = query.where("id", "=", input.enterpriseId);
    let initialized = 0;
    for (const enterprise of await query.execute()) {
      const pools = await this.db
        .selectFrom("principal_grant")
        .select(["principal_id", "provider"])
        .distinct()
        .where("enterprise_id", "=", enterprise.id)
        .where("pool_model_alias", "=", "*")
        .where("status", "=", "ACTIVE")
        .execute();
      for (const pool of pools)
        if (
          await this.ensureCurrentQuotaPeriod({
            enterpriseId: enterprise.id,
            principalId: pool.principal_id,
            provider: pool.provider,
            now,
          })
        )
          initialized++;
    }
    return { initialized };
  }
}
