/**
 * POOL-025 月度经营账单仓储。
 *
 * 草稿来自请求账本、厂商经营快照与采购记录的确定性聚合；API 花费使用余额桥接，
 * 账本计价保留为核对证据。结账时把完整读模型冻结到
 * operating_bill_version.snapshot。读取已结账月份永远返回冻结版本，不按新规则重算。
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { buildOperatingBillDraft } from "./operating-bill-draft.js";
import { OperatingBillAccountRepository } from "./operating-bill-account-repository.js";
import { assertDepartmentCostConserved, loadDepartmentCloseEvidence } from "./department-cost-evidence.js";
import {
  OperatingBillConcurrentModificationError,
  withOperatingBillSerializationRetry,
} from "./operating-bill-concurrency.js";
import {
  OperatingBillAlreadyClosedError,
  OperatingBillCloseNoteRequiredError,
  OperatingBillIncompleteError,
  OperatingBillNotClosedError,
  OperatingBillReferenceError,
} from "./operating-bill-errors.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import {
  recordOperatingBillOpeningBalance,
  type RecordOpeningBalanceInput,
} from "./operating-bill-opening-balance.js";
import { ensureOperatingBillPeriod } from "./operating-bill-period.js";
import {
  acquireOperatingBillMonthWriteBarrier,
  hasPendingOperatingBillSettlement,
  OperatingBillClosedError,
} from "./operating-bill-write-barrier.js";
import { appendProjectAttributionCorrection } from "./operating-bill-project-attribution.js";
import type {
  OperatingBillPeriod,
  OperatingBillSnapshot,
  OperatingBillValueItemView,
  OperatingBillView,
} from "./operating-bill-types.js";
import { ProviderFinanceRepository } from "./provider-finance-repository.js";
import { projectOperatingBillFinance } from "./operating-bill-finance-projection.js";

export type * from "./operating-bill-types.js";
export { operatingBillMonthRange, InvalidOperatingBillMonthError } from "./operating-bill-month.js";
export { OperatingBillConcurrentModificationError } from "./operating-bill-concurrency.js";
export * from "./operating-bill-errors.js";
export { OperatingBillClosedError } from "./operating-bill-write-barrier.js";

export class OperatingBillRepository {
  constructor(
    private db: Kysely<Database>,
    private financeMode: "OFF" | "DARK" | "ACTIVE" = "OFF",
    private transactionBound = false,
  ) {}

  private async financeEnabled(enterpriseId: string): Promise<boolean> {
    return this.financeMode === "DARK" || this.financeMode === "ACTIVE"
      && await new ProviderFinanceRepository(this.db).isStrictWritesEnabled(enterpriseId);
  }

  async getBill(enterpriseId: string, month: string): Promise<OperatingBillView> {
    const range = operatingBillMonthRange(month);
    const period = await this.findPeriod(enterpriseId, range.monthDate);
    let snapshot: OperatingBillSnapshot;
    if (period?.status === "CLOSED") {
      const frozen = await this.db
        .selectFrom("operating_bill_version")
        .selectAll()
        .where("enterprise_id", "=", enterpriseId)
        .where("period_id", "=", period.id)
        .where("version", "=", period.current_version)
        .executeTakeFirstOrThrow();
      snapshot = frozen.snapshot as unknown as OperatingBillSnapshot;
    } else {
      snapshot = await this.buildDraft(enterpriseId, month, period ?? null);
    }
    const [versions, events] = period
      ? await Promise.all([this.listVersions(enterpriseId, period.id), this.listEvents(enterpriseId, period.id)])
      : [[], []];
    return { ...snapshot, versions, events };
  }

  async listAvailableMonths(enterpriseId: string): Promise<Array<{
    month: string;
    status: "DRAFT" | "CLOSED";
    currentVersion: number;
  }>> {
    const result = await sql<{ month: string; status: "DRAFT" | "CLOSED"; current_version: number }>`
      SELECT to_char(period_month, 'YYYY-MM') AS month, status, current_version
        FROM operating_bill_period
       WHERE enterprise_id = ${enterpriseId}
       ORDER BY period_month DESC
    `.execute(this.db);
    const current = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
    }).format(new Date()).slice(0, 7);
    const rows = result.rows.map((row) => ({
      month: row.month, status: row.status, currentVersion: row.current_version,
    }));
    if (!rows.some((row) => row.month === current)) {
      rows.unshift({ month: current, status: "DRAFT", currentVersion: 0 });
    }
    return rows;
  }

  async createValueItem(input: {
    enterpriseId: string;
    adminId: string;
    month: string;
    title: string;
    valueType: "MONETARY" | "NON_MONETARY";
    amount?: string | null;
    metricValue?: string | null;
    metricUnit?: string | null;
    description?: string | null;
    evidenceRef?: string | null;
    relatedPrincipalId?: string | null;
  }): Promise<OperatingBillValueItemView> {
    const created = await this.db.transaction().execute(async (trx) => {
      const initial = await ensureOperatingBillPeriod(
        trx, input.enterpriseId, input.adminId, input.month,
      );
      const period = await trx.selectFrom("operating_bill_period").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", initial.id)
        .forUpdate().executeTakeFirstOrThrow();
      if (period.status === "CLOSED") throw new OperatingBillClosedError();
      if (input.relatedPrincipalId) {
        const principal = await trx.selectFrom("principal").select("id")
          .where("enterprise_id", "=", input.enterpriseId)
          .where("id", "=", input.relatedPrincipalId).executeTakeFirst();
        if (!principal) throw new OperatingBillReferenceError();
      }
      const item = await trx.insertInto("operating_bill_value_item").values({
        enterprise_id: input.enterpriseId,
        period_id: period.id,
        title: input.title,
        value_type: input.valueType,
        amount: input.valueType === "MONETARY" ? input.amount ?? null : null,
        metric_value: input.valueType === "NON_MONETARY" ? input.metricValue ?? null : null,
        metric_unit: input.metricUnit ?? null,
        description: input.description ?? null,
        evidence_ref: input.evidenceRef ?? null,
        related_principal_id: input.relatedPrincipalId ?? null,
        submitted_by: input.adminId,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operating_bill_event").values({
        enterprise_id: input.enterpriseId,
        period_id: period.id,
        action: "VALUE_CREATED",
        version: period.current_version,
        reason: null,
        actor_admin_id: input.adminId,
        metadata: { value_item_id: item.id, value_type: item.value_type },
      }).execute();
      await trx.updateTable("operating_bill_period").set({ updated_at: new Date() })
        .where("id", "=", period.id).execute();
      return item;
    });
    return this.getValueItemView(input.enterpriseId, created.id);
  }

  async confirmValueItem(input: {
    enterpriseId: string;
    adminId: string;
    itemId: string;
  }): Promise<OperatingBillValueItemView> {
    await this.db.transaction().execute(async (trx) => {
      const item = await trx.selectFrom("operating_bill_value_item as v")
        .innerJoin("operating_bill_period as p", "p.id", "v.period_id")
        .select(["v.id", "v.period_id", "v.status", "p.status as period_status", "p.current_version"])
        .where("v.enterprise_id", "=", input.enterpriseId)
        .where("v.id", "=", input.itemId)
        .forUpdate().executeTakeFirst();
      if (!item) throw new OperatingBillReferenceError();
      if (item.period_status === "CLOSED") throw new OperatingBillClosedError();
      if (item.status !== "CONFIRMED") {
        await trx.updateTable("operating_bill_value_item").set({
          status: "CONFIRMED", confirmed_by: input.adminId, confirmed_at: new Date(), updated_at: new Date(),
        }).where("id", "=", item.id).where("enterprise_id", "=", input.enterpriseId).execute();
        await trx.insertInto("operating_bill_event").values({
          enterprise_id: input.enterpriseId, period_id: item.period_id,
          action: "VALUE_CONFIRMED", version: item.current_version, reason: null,
          actor_admin_id: input.adminId, metadata: { value_item_id: item.id },
        }).execute();
        await trx.updateTable("operating_bill_period").set({ updated_at: new Date() })
          .where("id", "=", item.period_id).execute();
      }
    });
    return this.getValueItemView(input.enterpriseId, input.itemId);
  }

  async confirmResourceFacts(input: {
    enterpriseId: string;
    adminId: string;
    month: string;
    providerResourceId: string;
    status: "CONFIRMED" | "PENDING" | "NOT_APPLICABLE" | "ANOMALY";
    note: string | null;
  }): Promise<OperatingBillView> {
    const period = await ensureOperatingBillPeriod(
      this.db, input.enterpriseId, input.adminId, input.month,
    );
    if (period.status === "CLOSED") throw new OperatingBillClosedError();
    const draft = await this.buildDraft(input.enterpriseId, input.month, period);
    const provider = draft.providers.find((row) => row.providerResourceId === input.providerResourceId);
    if (!provider) throw new OperatingBillReferenceError();
    if ((input.status === "ANOMALY" || input.status === "NOT_APPLICABLE") && !input.note?.trim()) {
      throw new OperatingBillReferenceError();
    }
    await this.db.insertInto("operating_bill_resource_confirmation").values({
      enterprise_id: input.enterpriseId,
      period_id: period.id,
      provider_resource_id: provider.providerResourceId,
      status: input.status,
      fact_fingerprint: provider.factFingerprint,
      operating_snapshot_id: provider.operatingSnapshotId,
      request_range_from: provider.requestRange.from ? new Date(provider.requestRange.from) : null,
      request_range_to: provider.requestRange.to ? new Date(provider.requestRange.to) : null,
      request_count: provider.requestRange.count,
      note: input.note,
      confirmed_by: input.adminId,
      confirmed_at: new Date(),
    }).onConflict((oc) => oc.columns(["enterprise_id", "period_id", "provider_resource_id"])
      .doUpdateSet({
        status: input.status,
        fact_fingerprint: provider.factFingerprint,
        operating_snapshot_id: provider.operatingSnapshotId,
        request_range_from: provider.requestRange.from ? new Date(provider.requestRange.from) : null,
        request_range_to: provider.requestRange.to ? new Date(provider.requestRange.to) : null,
        request_count: provider.requestRange.count,
        note: input.note,
        confirmed_by: input.adminId,
        confirmed_at: new Date(),
        version: sql`operating_bill_resource_confirmation.version + 1`,
      })).execute();
    return this.getBill(input.enterpriseId, input.month);
  }

  recordOpeningBalance(input: RecordOpeningBalanceInput) {
    return recordOperatingBillOpeningBalance(
      this.db, input,
      () => this.getBill(input.enterpriseId, input.month),
    );
  }

  async assignRequestToProject(input: {
    enterpriseId: string;
    adminId: string;
    month: string;
    requestId: string;
    projectPrincipalId: string;
    reason?: string | null;
  }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const request = await trx.selectFrom("ai_request as ar")
        .innerJoin("principal as source", "source.id", "ar.principal_id")
        .select(["ar.id", "source.id as source_principal_id", "source.person_id", "source.type as principal_type"])
        .where("ar.enterprise_id", "=", input.enterpriseId)
        .where("source.enterprise_id", "=", input.enterpriseId)
        .where("ar.id", "=", input.requestId).executeTakeFirst();
      const project = await trx.selectFrom("principal").select("id")
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.projectPrincipalId)
        .where("type", "=", "PROJECT").where("status", "=", "ACTIVE").executeTakeFirst();
      const lineRange = await trx.selectFrom("ledger_line").select((eb) => [
        eb.fn.min("created_at").as("first_at"), eb.fn.max("created_at").as("last_at"),
      ]).where("enterprise_id", "=", input.enterpriseId)
        .where("ai_request_id", "=", input.requestId).executeTakeFirst();
      const enterprise = await trx.selectFrom("enterprise").select("timezone")
        .where("id", "=", input.enterpriseId).executeTakeFirst();
      if (!request || request.principal_type !== "EMPLOYEE" || !project
        || !lineRange?.first_at || !lineRange.last_at || !enterprise) {
        throw new OperatingBillReferenceError();
      }
      const monthOf = (value: Date) => new Intl.DateTimeFormat("en-CA", {
        timeZone: enterprise.timezone, year: "numeric", month: "2-digit",
      }).format(value).slice(0, 7);
      if (monthOf(lineRange.first_at) !== input.month || monthOf(lineRange.last_at) !== input.month) {
        throw new OperatingBillReferenceError();
      }
      const initial = await ensureOperatingBillPeriod(
        trx, input.enterpriseId, input.adminId, input.month,
      );
      const period = await trx.selectFrom("operating_bill_period").select(["id", "status"])
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", initial.id)
        .forUpdate().executeTakeFirstOrThrow();
      if (period.status === "CLOSED") throw new OperatingBillClosedError();
      await trx.insertInto("operating_bill_request_project_assignment").values({
        enterprise_id: input.enterpriseId, ai_request_id: input.requestId,
        project_principal_id: input.projectPrincipalId, assigned_by: input.adminId,
        reason: input.reason ?? null,
      }).onConflict((oc) => oc.columns(["enterprise_id", "ai_request_id"]).doUpdateSet({
        project_principal_id: input.projectPrincipalId, assigned_by: input.adminId,
        reason: input.reason ?? null, updated_at: new Date(),
      })).execute();
      await appendProjectAttributionCorrection(trx, input, request, lineRange.first_at);
      await trx.updateTable("operating_bill_period").set({ updated_at: new Date() })
        .where("id", "=", period.id).execute();
    });
  }

  async closeMonth(input: {
    enterpriseId: string;
    adminId: string;
    month: string;
    allowIncomplete: boolean;
    note: string | null;
    includeDepartmentEvidence?: boolean;
  }): Promise<OperatingBillView> {
    // 先在独立 READ COMMITTED 事务中创建账期。不把 advisory lock 放进
    // 后续 RR 事务，避免等锁前取到旧快照而漏掉在途结算。
    const initial = await this.db.transaction().execute(async (trx) => {
      await acquireOperatingBillMonthWriteBarrier(trx, input.enterpriseId, input.month);
      return ensureOperatingBillPeriod(trx, input.enterpriseId, input.adminId, input.month);
    });
    await withOperatingBillSerializationRetry(() =>
      this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
        const period = await trx.selectFrom("operating_bill_period").selectAll()
          .where("enterprise_id", "=", input.enterpriseId).where("id", "=", initial.id)
          .forUpdate().executeTakeFirstOrThrow();
        if (period.status === "CLOSED") throw new OperatingBillAlreadyClosedError();
        if (await hasPendingOperatingBillSettlement(
          trx, input.enterpriseId, input.month, new Date(),
        )) throw new OperatingBillConcurrentModificationError();
        const repo = new OperatingBillRepository(trx, this.financeMode, true);
        const draft = await repo.buildDraft(input.enterpriseId, input.month, period);
        const financeEnabled = await repo.financeEnabled(input.enterpriseId);
        const departmentEvidence = input.includeDepartmentEvidence === false
          ? null
          : await loadDepartmentCloseEvidence(trx, input.enterpriseId, input.month, financeEnabled);
        // 部门行与企业基础事实不守恒属于硬错误，allowIncomplete 不得绕过。
        if (departmentEvidence) assertDepartmentCostConserved(departmentEvidence.departmentBill);
        if (draft.gaps.length > 0 && !input.allowIncomplete) {
          throw new OperatingBillIncompleteError(draft.gaps);
        }
        if (draft.gaps.length > 0 && !input.note?.trim()) {
          throw new OperatingBillCloseNoteRequiredError();
        }
        const nextVersion = period.current_version + 1;
        const closedAt = new Date();
        const admin = await trx.selectFrom("admin_user").select("display_name")
          .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.adminId)
          .executeTakeFirstOrThrow();
        const frozen: OperatingBillSnapshot = {
          ...draft, status: "CLOSED", version: nextVersion,
          generatedAt: closedAt.toISOString(), closedAt: closedAt.toISOString(),
          closedBy: admin.display_name, closeNote: input.note,
          sourceFacts: {
            ...draft.sourceFacts,
            accountFacts: (await new OperatingBillAccountRepository(trx)
              .loadLiveFacts(input.enterpriseId, input.month))
              .map((fact) => ({ ...fact, usedAt: fact.usedAt.toISOString() })),
            ...(departmentEvidence ? {
              departmentBill: {
                ...departmentEvidence.departmentBill,
                status: "CLOSED" as const,
                version: nextVersion,
                generatedAt: closedAt.toISOString(),
              },
              departmentAttributionFacts: departmentEvidence.departmentAttributionFacts,
              departmentBudgetFacts: departmentEvidence.departmentBudgetFacts,
              resourcePurchaseFacts: departmentEvidence.resourcePurchaseFacts,
            } : {}),
          },
        };
        await trx.insertInto("operating_bill_version").values({
          enterprise_id: input.enterpriseId, period_id: period.id, version: nextVersion,
          snapshot: frozen as unknown as Record<string, unknown>, close_note: input.note,
          exceptions: sql`${JSON.stringify(draft.gaps)}::jsonb`, closed_by: input.adminId,
          closed_at: closedAt,
        }).execute();
        await trx.updateTable("operating_bill_period").set({
          status: "CLOSED", current_version: nextVersion, updated_at: closedAt,
        }).where("id", "=", period.id).execute();
        await trx.insertInto("operating_bill_event").values({
          enterprise_id: input.enterpriseId, period_id: period.id, action: "CLOSED",
          version: nextVersion, reason: input.note, actor_admin_id: input.adminId,
          metadata: { allow_incomplete: input.allowIncomplete, gap_count: draft.gaps.length },
        }).execute();
      }),
    );
    return this.getBill(input.enterpriseId, input.month);
  }

  async reopenMonth(input: {
    enterpriseId: string;
    adminId: string;
    month: string;
    reason: string;
  }): Promise<OperatingBillView> {
    const range = operatingBillMonthRange(input.month);
    await this.db.transaction().execute(async (trx) => {
      const period = await trx.selectFrom("operating_bill_period").selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("period_month", "=", range.monthDate).forUpdate().executeTakeFirst();
      if (!period) throw new OperatingBillReferenceError();
      if (period.status !== "CLOSED") throw new OperatingBillNotClosedError();
      await trx.updateTable("operating_bill_period").set({ status: "DRAFT", updated_at: new Date() })
        .where("id", "=", period.id).execute();
      await trx.insertInto("operating_bill_event").values({
        enterprise_id: input.enterpriseId, period_id: period.id, action: "REOPENED",
        version: period.current_version, reason: input.reason, actor_admin_id: input.adminId,
        metadata: null,
      }).execute();
    });
    return this.getBill(input.enterpriseId, input.month);
  }

  private async buildDraft(
    enterpriseId: string,
    month: string,
    period: OperatingBillPeriod | null,
  ): Promise<OperatingBillSnapshot> {
    const { start, end } = operatingBillMonthRange(month);
    const values = period ? await this.listValueItems(enterpriseId, period.id) : [];
    const draft = await buildOperatingBillDraft(
      this.db, enterpriseId, month, period, values, start, end,
    );
    if (!await this.financeEnabled(enterpriseId)) return draft;
    const asOf = new Date(Math.min(Date.now(), end.getTime() - 1));
    const finance = new ProviderFinanceRepository(this.db);
    const views = this.transactionBound
      ? await finance.loadResourceFinanceViews(
        this.db as unknown as Transaction<Database>, enterpriseId, month, asOf,
      ) : await finance.listResourceFinanceViews(enterpriseId, month, asOf);
    return projectOperatingBillFinance(this.db, enterpriseId, month, draft, views);
  }
  private findPeriod(enterpriseId: string, monthDate: string): Promise<OperatingBillPeriod | undefined> {
    return this.db.selectFrom("operating_bill_period").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("period_month", "=", monthDate)
      .executeTakeFirst();
  }

  private async getValueItemView(enterpriseId: string, id: string): Promise<OperatingBillValueItemView> {
    const item = await this.db.selectFrom("operating_bill_value_item as v")
      .innerJoin("admin_user as submitter", "submitter.id", "v.submitted_by")
      .leftJoin("admin_user as confirmer", "confirmer.id", "v.confirmed_by")
      .leftJoin("principal as related", "related.id", "v.related_principal_id")
      .selectAll("v")
      .select([
        "submitter.display_name as submitted_by_name", "confirmer.display_name as confirmed_by_name",
        "related.name as related_principal_name",
      ])
      .where("v.enterprise_id", "=", enterpriseId).where("v.id", "=", id).executeTakeFirst();
    if (!item) throw new OperatingBillReferenceError();
    return item;
  }

  private listValueItems(enterpriseId: string, periodId: string): Promise<OperatingBillValueItemView[]> {
    return this.db.selectFrom("operating_bill_value_item as v")
      .innerJoin("admin_user as submitter", "submitter.id", "v.submitted_by")
      .leftJoin("admin_user as confirmer", "confirmer.id", "v.confirmed_by")
      .leftJoin("principal as related", "related.id", "v.related_principal_id")
      .selectAll("v")
      .select([
        "submitter.display_name as submitted_by_name", "confirmer.display_name as confirmed_by_name",
        "related.name as related_principal_name",
      ])
      .where("v.enterprise_id", "=", enterpriseId).where("v.period_id", "=", periodId)
      .orderBy("v.created_at", "asc").execute();
  }

  private async listVersions(enterpriseId: string, periodId: string): Promise<OperatingBillView["versions"]> {
    const rows = await this.db.selectFrom("operating_bill_version as v")
      .innerJoin("admin_user as a", "a.id", "v.closed_by")
      .select(["v.id", "v.version", "v.closed_at", "v.close_note", "v.exceptions", "a.display_name as closed_by_name"])
      .where("v.enterprise_id", "=", enterpriseId).where("v.period_id", "=", periodId)
      .orderBy("v.version", "desc").execute();
    return rows.map((row) => ({
      id: row.id, version: row.version, closedAt: row.closed_at.toISOString(),
      closedBy: row.closed_by_name, closeNote: row.close_note,
      exceptions: row.exceptions,
    }));
  }

  private async listEvents(enterpriseId: string, periodId: string): Promise<OperatingBillView["events"]> {
    const rows = await this.db.selectFrom("operating_bill_event as e")
      .innerJoin("admin_user as a", "a.id", "e.actor_admin_id")
      .select(["e.id", "e.action", "e.version", "e.reason", "e.created_at", "a.display_name as actor_name"])
      .where("e.enterprise_id", "=", enterpriseId).where("e.period_id", "=", periodId)
      .orderBy("e.created_at", "desc").execute();
    return rows.map((row) => ({
      id: row.id, action: row.action, version: row.version, reason: row.reason,
      actor: row.actor_name, createdAt: row.created_at.toISOString(),
    }));
  }
}
