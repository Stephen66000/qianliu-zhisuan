import { Decimal } from "decimal.js";
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import {
  addAccountFact,
  finishAccountTotals,
  newAccountAccumulator,
  type OperatingBillAccountFact,
} from "./operating-bill-account-aggregate.js";
import {
  loadFrozenOperatingBillAccountSummary,
  loadFrozenOperatingBillEmployeeName,
  loadFrozenOperatingBillRequestPage,
} from "./operating-bill-account-frozen.js";
export { OperatingBillAccountEvidenceUnavailableError } from "./operating-bill-account-frozen.js";
import { loadFrozenOperatingBillEmployeeSummary } from "./operating-bill-account-frozen-detail.js";
import {
  loadLiveOperatingBillAccountFacts,
  loadLiveOperatingBillAccountSummary,
  loadLiveOperatingBillRequestPage,
} from "./operating-bill-account-live.js";
import { loadLiveOperatingBillEmployeeSummary } from "./operating-bill-account-live-detail.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import type {
  OperatingBillAccountListView,
  OperatingBillAccountSubjectRow,
  OperatingBillEmployeeDetailView,
  OperatingBillRequestListView,
} from "./operating-bill-account-types.js";

export type * from "./operating-bill-account-types.js";

export interface OperatingBillAccountQuery {
  providerCode?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface OperatingBillRequestQuery {
  providerCode?: string;
  limit: number;
  offset: number;
}

export class OperatingBillAccountReferenceError extends Error {}
export class OperatingBillAccountRepository {
  constructor(private db: Kysely<Database>) {}

  async listAccounts(
    enterpriseId: string,
    month: string,
    dimension: "EMPLOYEE" | "PROJECT",
    query: OperatingBillAccountQuery = {},
  ): Promise<OperatingBillAccountListView> {
    return this.readSnapshot(async (repo) => {
      const page = { ...query, limit: query.limit ?? 25, offset: query.offset ?? 0 };
      const status = await repo.status(enterpriseId, month);
      const summary = status === "CLOSED"
        ? await loadFrozenOperatingBillAccountSummary(repo.db, enterpriseId, month, dimension, page)
        : await loadLiveOperatingBillAccountSummary(repo.db, enterpriseId, month, dimension, page);
      for (const row of summary.rows) {
        row.providers.sort((a, b) => a.providerName.localeCompare(b.providerName));
      }
      summary.rows.sort((a, b) => repo.compareRows(a, b));
      return {
        month, status, dimension, ...summary,
        limit: page.limit, offset: page.offset,
      };
    });
  }

  async getEmployeeDetail(
    enterpriseId: string,
    month: string,
    principalId: string,
    providerCode?: string,
  ): Promise<OperatingBillEmployeeDetailView> {
    return this.readSnapshot(async (repo) => {
      const status = await repo.status(enterpriseId, month);
      const summary = status === "CLOSED"
        ? await loadFrozenOperatingBillEmployeeSummary(repo.db, enterpriseId, month, principalId, providerCode)
        : await loadLiveOperatingBillEmployeeSummary(repo.db, enterpriseId, month, principalId, providerCode);
      const employeeName = status === "CLOSED"
        ? await repo.frozenEmployeeName(enterpriseId, month, principalId)
        : (await repo.requireEmployee(enterpriseId, principalId)).name;
      return { month, status, employee: { principalId, principalName: employeeName }, ...summary };
    });
  }

  async listEmployeeModelRequests(
    enterpriseId: string,
    month: string,
    principalId: string,
    unifiedModelId: string,
    query: OperatingBillRequestQuery,
  ): Promise<OperatingBillRequestListView> {
    return this.readSnapshot(async (repo) => {
      const model = await repo.db.selectFrom("unified_model").select(["id", "alias"])
        .where("enterprise_id", "=", enterpriseId).where("id", "=", unifiedModelId)
        .executeTakeFirst();
      if (!model) throw new OperatingBillAccountReferenceError();
      const status = await repo.status(enterpriseId, month);
      const filter = { principalId, unifiedModelId, providerCode: query.providerCode };
      const page = status === "CLOSED"
        ? await loadFrozenOperatingBillRequestPage(repo.db, enterpriseId, month, filter, query)
        : await loadLiveOperatingBillRequestPage(repo.db, enterpriseId, month, filter, query);
      const employeeName = status === "CLOSED"
        ? page.employeeName ?? (await repo.requireEmployee(enterpriseId, principalId)).name
        : (await repo.requireEmployee(enterpriseId, principalId)).name;
      return {
        month,
        status,
        employee: { principalId, principalName: employeeName },
        model: { unifiedModelId, currentAlias: model.alias },
        items: page.facts.map((fact) => repo.requestRow(fact)),
        total: page.total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  private requestRow(fact: OperatingBillAccountFact) {
    const totals = this.totals([fact]);
    return {
      requestId: fact.requestId,
      modelAliasAtRequest: fact.historicalAlias,
      currentAlias: fact.currentAlias,
      tokens: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheTokens: totals.cacheTokens,
        reasoningTokens: totals.reasoningTokens,
        totalTokens: totals.totalTokens,
      },
      costs: {
        deductedQuota: totals.deductedQuota,
        apiCost: totals.apiCost,
        packageAllocatedCost: totals.packageAllocatedCost,
        totalAllocatedCost: totals.totalAllocatedCost,
      },
      usageQuality: totals.usageQuality,
      status: fact.requestStatus,
      usedAt: fact.usedAt.toISOString(),
    };
  }

  private totals(facts: OperatingBillAccountFact[]) {
    const accumulator = newAccountAccumulator();
    for (const fact of facts) addAccountFact(accumulator, fact);
    return finishAccountTotals(accumulator);
  }

  private compareRows(left: OperatingBillAccountSubjectRow, right: OperatingBillAccountSubjectRow): number {
    if (left.totals.totalAllocatedCost === null && right.totals.totalAllocatedCost !== null) return 1;
    if (left.totals.totalAllocatedCost !== null && right.totals.totalAllocatedCost === null) return -1;
    const cost = new Decimal(right.totals.totalAllocatedCost ?? 0)
      .cmp(left.totals.totalAllocatedCost ?? 0);
    return cost
      || left.subjectName.localeCompare(right.subjectName)
      || (left.subjectId ?? "").localeCompare(right.subjectId ?? "");
  }

  private async requireEmployee(enterpriseId: string, principalId: string) {
    const employee = await this.db.selectFrom("principal").select(["id", "name"])
      .where("enterprise_id", "=", enterpriseId).where("id", "=", principalId)
      .where("type", "=", "EMPLOYEE").executeTakeFirst();
    if (!employee) throw new OperatingBillAccountReferenceError();
    return employee;
  }

  private async frozenEmployeeName(enterpriseId: string, month: string, principalId: string) {
    return (await loadFrozenOperatingBillEmployeeName(this.db, enterpriseId, month, principalId))
      ?? (await this.requireEmployee(enterpriseId, principalId)).name;
  }

  private async status(enterpriseId: string, month: string): Promise<"DRAFT" | "CLOSED"> {
    const range = operatingBillMonthRange(month);
    const period = await this.db.selectFrom("operating_bill_period").select("status")
      .where("enterprise_id", "=", enterpriseId).where("period_month", "=", range.monthDate)
      .executeTakeFirst();
    return period?.status ?? "DRAFT";
  }

  async loadLiveFacts(enterpriseId: string, month: string): Promise<OperatingBillAccountFact[]> {
    return loadLiveOperatingBillAccountFacts(this.db, enterpriseId, month);
  }

  private readSnapshot<T>(read: (repo: OperatingBillAccountRepository) => Promise<T>): Promise<T> {
    return this.db.transaction().setIsolationLevel("repeatable read")
      .execute((trx) => read(new OperatingBillAccountRepository(trx)));
  }
}
