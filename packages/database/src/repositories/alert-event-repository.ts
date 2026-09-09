import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { AuditRepository } from "./audit-repository.js";
import {
  isPlannedRequestBlock,
  REQUEST_FAULT_SIGNALS,
} from "./alert-event-exclusions.js";
import {
  deriveCallDeductionAlerts,
  deriveCredentialAlerts,
} from "./alert-event-operational-derivations.js";
import {
  deriveDispatchAlerts,
  deriveFailedRequestAlerts,
  toAlertEvent,
} from "./alert-event-request-derivations.js";
import { deriveBackgroundFaults } from "./alert-event-background.js";
import {
  EXCLUDED_ALERT_SIGNALS,
  verifyAlertRecoveries,
} from "./alert-event-recovery.js";
import {
  DEFAULT_THRESHOLDS,
  type AlertEvent,
  type AlertThresholds,
  type DerivedAlert,
} from "./alert-event-types.js";
export type {
  AlertDomain,
  AlertEvent,
  AlertThresholds,
  DerivedAlert,
} from "./alert-event-types.js";
export { DEFAULT_THRESHOLDS } from "./alert-event-types.js";

const RESOURCE_UNAVAILABLE_STATES = new Set([
  "DEGRADED",
  "EXHAUSTED",
  "RATE_LIMITED",
  "UNAVAILABLE",
]);
export class AlertDispositionNoteError extends Error {}

export class AlertEventRepository {
  constructor(
    private db: Kysely<Database>,
    private thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
    _includeDepartmentBudget = false,
  ) {}

  async evaluate(enterpriseId: string): Promise<AlertEvent[]> {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${"alerts:" + enterpriseId}))`.execute(
        trx,
      );
      const repo = new AlertEventRepository(trx, this.thresholds);
      await repo.evaluateCurrent(enterpriseId);
    });
    return this.list(enterpriseId);
  }

  private async evaluateCurrent(enterpriseId: string): Promise<void> {
    const derived = await this.derive(enterpriseId);
    const events = await this.db
      .selectFrom("alert_event")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .orderBy("first_seen_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const latest = new Map<string, (typeof events)[number]>();
    for (const event of events)
      if (!latest.has(event.alert_key)) latest.set(event.alert_key, event);
    for (const d of derived) {
      const existing = latest.get(d.alertKey);
      // Immutable failed requests never reopen merely because a new evaluation ran.
      const persistentOccurrence =
        /^(RESOURCE_UNAVAILABLE:(routing|streaming|request|dispatch):|QUOTA_ANOMALY:reconciliation:|TASK:directory:|TASK:operating_sync:|AVAILABILITY:)/.test(
          d.alertKey,
        );
      const patch = {
        last_seen_at: d.observedAt ?? new Date(),
        domain: d.domain,
        signal: d.signal,
        title: d.title,
        detail: d.detail,
        severity: d.severity,
        resource_id: d.resourceId,
        principal_id: d.principalId,
        ai_request_id: d.aiRequestId,
      };
      if (
        persistentOccurrence &&
        existing &&
        (existing.status !== "AUTO_RESOLVED" || existing.recovery_evidence) &&
        existing.detail === d.detail &&
        existing.resource_id === d.resourceId &&
        existing.principal_id === d.principalId &&
        existing.first_seen_at.getTime() === d.occurredAt?.getTime()
      )
        continue;
      if (existing && (!existing.recovery_evidence || persistentOccurrence)) {
        await this.db
          .updateTable("alert_event")
          .set({
            ...patch,
            ...(persistentOccurrence && d.occurredAt
              ? { first_seen_at: d.occurredAt }
              : {}),
            ...(existing.status === "AUTO_RESOLVED" &&
            !existing.recovery_evidence
              ? { status: "OPEN", source_cleared_at: null, resolved_at: null }
              : {}),
          })
          .where("id", "=", existing.id)
          .execute();
      } else {
        await this.db
          .insertInto("alert_event")
          .values({
            enterprise_id: enterpriseId,
            alert_key: d.alertKey,
            ...patch,
            first_seen_at: d.occurredAt ?? new Date(),
            status: "OPEN",
          })
          .execute();
      }
    }
    // Only positive source evidence can verify recovery; never infer it from missing alerts.
    await verifyAlertRecoveries(this.db, enterpriseId);
  }

  async list(
    enterpriseId: string,
    statuses: Array<AlertEvent["status"]> = ["OPEN", "INVESTIGATING"],
  ): Promise<AlertEvent[]> {
    const rows = await this.db
      .selectFrom("alert_event")
      .selectAll()
      .select([
        sql<
          string | null
        >`(SELECT unified_model FROM ai_request WHERE ai_request.id=alert_event.ai_request_id AND ai_request.enterprise_id=alert_event.enterprise_id)`.as(
          "model",
        ),
        sql<
          string | null
        >`(SELECT principal_id FROM ai_request WHERE ai_request.id=alert_event.ai_request_id AND ai_request.enterprise_id=alert_event.enterprise_id)`.as(
          "request_principal",
        ),
        sql<
          string | null
        >`(SELECT COALESCE(display_name,username) FROM admin_user WHERE admin_user.id=alert_event.resolved_by AND admin_user.enterprise_id=alert_event.enterprise_id)`.as(
          "handled_by",
        ),
      ])
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "in", statuses)
      .where("domain", "!=", "USAGE_SPIKE")
      .where("signal", "not in", EXCLUDED_ALERT_SIGNALS)
      .where((eb) =>
        eb.or([
          eb("signal", "not in", REQUEST_FAULT_SIGNALS),
          sql<boolean>`NOT ${isPlannedRequestBlock("alert_event.ai_request_id", "alert_event.enterprise_id")}`,
        ]),
      )
      .orderBy("first_seen_at", "desc")
      .execute();
    return rows.map((row) => ({
      ...toAlertEvent(row),
      title: row.title === "运行保障预警" ? "上游故障" : row.title,
      principalId: row.principal_id ?? row.request_principal,
      model: row.model,
      handledBy: row.handled_by,
    }));
  }

  async listHistory(enterpriseId: string): Promise<AlertEvent[]> {
    return this.list(enterpriseId, ["RESOLVED", "IGNORED", "AUTO_RESOLVED"]);
  }

  async setDisposition(
    enterpriseId: string,
    alertKey: string,
    status: "INVESTIGATING" | "RESOLVED" | "IGNORED",
    resolutionNote: string | undefined,
    resolvedBy: string,
    alertId?: string,
  ): Promise<boolean> {
    const resolved = status === "RESOLVED" || status === "IGNORED";
    const note = resolutionNote?.trim();
    if (resolved && !note)
      throw new AlertDispositionNoteError("已处理必须填写处理说明");
    if (note && note.length > 2000)
      throw new AlertDispositionNoteError("处理说明不能超过2000字");
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${"alerts:" + enterpriseId}))`.execute(
        trx,
      );
      let query = trx
        .selectFrom("alert_event")
        .selectAll()
        .select(
          isPlannedRequestBlock(
            "alert_event.ai_request_id",
            "alert_event.enterprise_id",
          ).as("planned_block"),
        )
        .where("enterprise_id", "=", enterpriseId)
        .where("alert_key", "=", alertKey);
      if (alertId) query = query.where("id", "=", alertId);
      const row = await query
        .orderBy("first_seen_at", "desc")
        .orderBy("id", "desc")
        .forUpdate()
        .executeTakeFirst();
      if (
        !row ||
        (REQUEST_FAULT_SIGNALS.includes(row.signal) && row.planned_block) ||
        row.domain === "USAGE_SPIKE" ||
        EXCLUDED_ALERT_SIGNALS.includes(row.signal)
      )
        return false;
      if (
        ["RESOLVED", "IGNORED"].includes(row.status) &&
        row.resolution_note?.trim()
      )
        return false;
      await trx
        .updateTable("alert_event")
        .set({
          status,
          resolution_note: note ?? null,
          resolved_by: resolvedBy,
          resolved_at: resolved ? new Date() : null,
        })
        .where("id", "=", row.id)
        .execute();
      await new AuditRepository(trx).write({
        enterprise_id: enterpriseId,
        admin_user_id: resolvedBy,
        action: "alert.disposition",
        target_type: "alert",
        target_id: row.id,
        change_summary: {
          alert_key: alertKey,
          status,
          resolution_note: note ?? null,
        },
        result: "SUCCESS",
      });
      return true;
    });
  }

  private async derive(enterpriseId: string): Promise<DerivedAlert[]> {
    const resources = await this.db
      .selectFrom("provider_resource")
      .select(["id", "name", "status", "consecutive_failures"])
      .where("enterprise_id", "=", enterpriseId)
      .execute();
    const out: DerivedAlert[] = resources
      .filter(
        (r) =>
          RESOURCE_UNAVAILABLE_STATES.has(r.status) ||
          (r.status !== "DELETED" &&
            r.status !== "DISABLED" &&
            r.consecutive_failures >= this.thresholds.resourceFailureCount),
      )
      .map((r) => ({
        alertKey: `RESOURCE_UNAVAILABLE:resource:${r.id}`,
        domain: "RESOURCE_UNAVAILABLE",
        signal: "resource_unavailable",
        severity: "MEDIUM",
        title: `${r.status === "DEGRADED" ? "资源降级" : "资源状态异常"}：${r.name}`,
        detail: `资源状态 ${r.status}，连续失败 ${r.consecutive_failures} 次`,
        resourceId: r.id,
        principalId: null,
        aiRequestId: null,
      }));
    out.push(
      ...(await deriveCallDeductionAlerts(this.db, enterpriseId)),
      ...(await deriveCredentialAlerts(this.db, enterpriseId)),
      ...(await deriveFailedRequestAlerts(this.db, enterpriseId)),
      ...(await deriveDispatchAlerts(this.db, enterpriseId)),
      ...(await deriveBackgroundFaults(this.db, enterpriseId)),
    );
    return out;
  }
}
