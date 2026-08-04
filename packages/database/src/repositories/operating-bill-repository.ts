/**
 * POOL-025 月度经营账单仓储。
 *
 * 草稿来自请求账本与厂商经营快照的确定性聚合；结账时把完整读模型冻结到
 * operating_bill_version.snapshot。读取已结账月份永远返回冻结版本，不按新规则重算。
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { buildOperatingBillDraft } from "./operating-bill-draft.js";
import type {
  OperatingBillGap,
  OperatingBillPeriod,
  OperatingBillSnapshot,
  OperatingBillValueItemView,
  OperatingBillView,
} from "./operating-bill-types.js";

export type * from "./operating-bill-types.js";

/** 账期参数只接受 YYYY-MM，边界固定为北京时间自然月。 */
export function operatingBillMonthRange(month: string): { start: Date; end: Date; monthDate: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new InvalidOperatingBillMonthError();
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year < 2000 || year > 2200) throw new InvalidOperatingBillMonthError();
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return {
    start: new Date(`${month}-01T00:00:00+08:00`),
    end: new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`),
    monthDate: `${month}-01`,
  };
}

export class OperatingBillRepository {
  constructor(private db: Kysely<Database>) {}

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
      const repo = new OperatingBillRepository(trx);
      const initial = await repo.ensurePeriod(input.enterpriseId, input.adminId, input.month);
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
      }
    });
    return this.getValueItemView(input.enterpriseId, input.itemId);
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
      const request = await trx.selectFrom("ai_request").select(["id", "started_at"])
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.requestId)
        .executeTakeFirst();
      const project = await trx.selectFrom("principal").select("id")
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.projectPrincipalId)
        .where("type", "=", "PROJECT").where("status", "=", "ACTIVE").executeTakeFirst();
      if (!request || !project) throw new OperatingBillReferenceError();
      const month = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
      }).format(request.started_at).slice(0, 7);
      if (month !== input.month) throw new OperatingBillReferenceError();
      const repo = new OperatingBillRepository(trx);
      const initial = await repo.ensurePeriod(input.enterpriseId, input.adminId, month);
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
    });
  }

  async closeMonth(input: {
    enterpriseId: string;
    adminId: string;
    month: string;
    allowIncomplete: boolean;
    note: string | null;
  }): Promise<OperatingBillView> {
    const initial = await this.ensurePeriod(input.enterpriseId, input.adminId, input.month);
    await this.db.transaction().execute(async (trx) => {
      const period = await trx.selectFrom("operating_bill_period").selectAll()
        .where("enterprise_id", "=", input.enterpriseId).where("id", "=", initial.id)
        .forUpdate().executeTakeFirstOrThrow();
      if (period.status === "CLOSED") throw new OperatingBillAlreadyClosedError();
      const repo = new OperatingBillRepository(trx);
      const draft = await repo.buildDraft(input.enterpriseId, input.month, period);
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
    });
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
    return buildOperatingBillDraft(this.db, enterpriseId, month, period, values, start, end);
  }
  private async ensurePeriod(enterpriseId: string, adminId: string, month: string): Promise<OperatingBillPeriod> {
    const range = operatingBillMonthRange(month);
    const inserted = await this.db.insertInto("operating_bill_period").values({
      enterprise_id: enterpriseId, period_month: range.monthDate, created_by: adminId,
    }).onConflict((oc) => oc.columns(["enterprise_id", "period_month"]).doNothing())
      .returningAll().executeTakeFirst();
    const period = inserted ?? await this.findPeriod(enterpriseId, range.monthDate);
    if (!period) throw new Error("operating_bill_period_create_failed");
    if (inserted) {
      await this.db.insertInto("operating_bill_event").values({
        enterprise_id: enterpriseId, period_id: period.id, action: "CREATED", version: 0,
        reason: null, actor_admin_id: adminId, metadata: { month },
      }).execute();
    }
    return period;
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

export class InvalidOperatingBillMonthError extends Error {}
export class OperatingBillClosedError extends Error {}
export class OperatingBillAlreadyClosedError extends Error {}
export class OperatingBillNotClosedError extends Error {}
export class OperatingBillReferenceError extends Error {}
export class OperatingBillCloseNoteRequiredError extends Error {}
export class OperatingBillIncompleteError extends Error {
  constructor(readonly gaps: OperatingBillGap[]) {
    super("operating_bill_incomplete");
  }
}
