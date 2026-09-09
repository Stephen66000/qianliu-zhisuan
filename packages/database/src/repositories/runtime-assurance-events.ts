import { sql, type Transaction } from "kysely";
import {
  AVAILABILITY_ACTION, AVAILABILITY_RULE_TYPE, matchAvailabilityRule, recoverAtForRule,
  scheduleMatches, type AvailabilityRuleSnapshot, type AvailabilityRuleType,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";
import {
  RuntimeAssuranceConflictError, eventNumber, versionSnapshot,
  type AvailabilityEvent, type LegacyUnavailableAssessment, type SignalInput, type SignalResult,
} from "./runtime-assurance-core.js";
import { RuntimeAssuranceRulesRepository } from "./runtime-assurance-rules.js";
import { writeObservationFault } from "./alert-observation-writer.js";

export class RuntimeAssuranceEventsRepository extends RuntimeAssuranceRulesRepository {
  async recordSignal(input: SignalInput): Promise<SignalResult> {
    const now = input.now ?? new Date();
    if (input.mode === "OFF") return { decision: "ALLOW", event: null, matchedRule: null, recoverAt: null };
    const rules = await this.activeRuleSnapshots(now);
    const matched = matchAvailabilityRule(rules, {
      now,
      providerId: input.providerId,
      providerResourceId: input.providerResourceId,
      unifiedModelId: input.unifiedModelId,
      upstreamModel: input.upstreamModel,
      unifiedSignal: input.signal,
    }, input.signal === "TECHNICAL_FAILURE" || input.signal === "CONFIGURATION_ERROR"
      ? AVAILABILITY_RULE_TYPE.OBSERVATION_ALERT
      : AVAILABILITY_RULE_TYPE.UPSTREAM_SIGNAL);
    if (!matched || matched.action === AVAILABILITY_ACTION.WARN_ONLY || input.mode === "OBSERVE") {
      await this.upsertObservationAlert(input, matched, now);
      return { decision: matched ? "WARN_ONLY" : "ALLOW", event: null, matchedRule: matched, recoverAt: null };
    }
    const recoverAt = recoverAtForRule(matched, now, input.upstreamRecoverAt);
    if (!recoverAt && matched.recoveryMethod !== "MANUAL") {
      await this.upsertObservationAlert(input, matched, now, "缺少可靠恢复字段，已降为预警");
      return { decision: "WARN_ONLY", event: null, matchedRule: matched, recoverAt: null };
    }
    const dedupKey = [matched.id, input.providerResourceId, input.upstreamModel, input.signal, recoverAt?.toISOString() ?? "manual"].join(":");
    const event = await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${dedupKey}))`.execute(trx);
      const existing = await trx.selectFrom("availability_event").selectAll()
        .where("dedup_key", "=", dedupKey).where("status", "=", "OPEN").forUpdate().executeTakeFirst();
      if (existing) {
        let updated = await trx.updateTable("availability_event").set({
          affected_request_count: sql`affected_request_count + 1`, updated_at: now,
          ...(input.upstreamRecoverAt && (!existing.recover_at || input.upstreamRecoverAt > existing.recover_at)
            ? { recover_at: input.upstreamRecoverAt }
            : {}),
        }).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow();
        if (input.wecomNotify && await this.enqueueEventDeliveryTx(trx, updated, input.principalId, "TRIGGER")) {
          updated = await trx.updateTable("availability_event").set({
            affected_person_count: sql`affected_person_count + 1`, updated_at: now,
          }).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow();
        }
        return updated;
      }
      const created = await trx.insertInto("availability_event").values({
        event_number: eventNumber(now),
        availability_rule_id: matched.ruleId,
        rule_version_id: matched.id,
        rule_version: matched.ruleVersion,
        provider_id: input.providerId,
        provider_resource_id: input.providerResourceId,
        unified_model_id: input.unifiedModelId,
        upstream_model: input.upstreamModel,
        unified_signal: input.signal,
        upstream_code: input.upstreamCode ?? null,
        sanitized_summary: input.sanitizedSummary?.slice(0, 255) ?? null,
        availability_decision: "BLOCKED_UPSTREAM",
        trigger_ai_request_id: input.aiRequestId,
        trigger_principal_id: input.principalId,
        recovery_method: matched.recoveryMethod!,
        dedup_key: dedupKey,
        recover_at: recoverAt,
        affected_request_count: 1,
      }).returningAll().executeTakeFirstOrThrow();
      if (input.wecomNotify && await this.enqueueEventDeliveryTx(trx, created, input.principalId, "TRIGGER")) {
        return trx.updateTable("availability_event").set({ affected_person_count: 1 })
          .where("id", "=", created.id).returningAll().executeTakeFirstOrThrow();
      }
      return created;
    });
    return { decision: "BLOCKED_UPSTREAM", event, matchedRule: matched, recoverAt };
  }

  async createScheduleEvent(input: {
    rule: AvailabilityRuleSnapshot;
    enterpriseId: string;
    providerId: string;
    providerResourceId: string;
    unifiedModelId: string | null;
    upstreamModel: string;
    aiRequestId: string;
    principalId: string;
    now: Date;
    wecomNotify: boolean;
  }): Promise<AvailabilityEvent> {
    const dedupKey = `${input.rule.id}:${input.providerResourceId}:${input.upstreamModel}:schedule`;
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${dedupKey}))`.execute(trx);
      const existing = await trx.selectFrom("availability_event").selectAll()
        .where("dedup_key", "=", dedupKey).where("status", "=", "OPEN").forUpdate().executeTakeFirst();
      if (existing) {
        if (input.wecomNotify && await this.enqueueEventDeliveryTx(trx, existing, input.principalId, "TRIGGER")) {
          return trx.updateTable("availability_event").set({
            affected_person_count: sql`affected_person_count + 1`, updated_at: input.now,
          }).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow();
        }
        return existing;
      }
      const created = await trx.insertInto("availability_event").values({
        event_number: eventNumber(input.now), availability_rule_id: input.rule.ruleId,
        rule_version_id: input.rule.id, rule_version: input.rule.ruleVersion,
        provider_id: input.providerId, provider_resource_id: input.providerResourceId,
        unified_model_id: input.unifiedModelId, upstream_model: input.upstreamModel,
        unified_signal: "UPSTREAM_MAINTENANCE", availability_decision: "BLOCKED_SCHEDULE",
        trigger_ai_request_id: input.aiRequestId, trigger_principal_id: input.principalId,
        recovery_method: "SCHEDULE_END", dedup_key: dedupKey, affected_request_count: 1,
      }).returningAll().executeTakeFirstOrThrow();
      if (input.wecomNotify && await this.enqueueEventDeliveryTx(trx, created, input.principalId, "TRIGGER")) {
        return trx.updateTable("availability_event").set({ affected_person_count: 1 })
          .where("id", "=", created.id).returningAll().executeTakeFirstOrThrow();
      }
      return created;
    });
  }

  async listEvents(history = false): Promise<AvailabilityEvent[]> {
    let query = this.db.selectFrom("availability_event").selectAll();
    if (!history) query = query.where("status", "=", "OPEN");
    return query.orderBy("started_at", "desc").execute();
  }

  async findOpenBlock(providerResourceId: string, upstreamModel?: string | null): Promise<AvailabilityEvent | null> {
    let query = this.db.selectFrom("availability_event").selectAll()
      .where("provider_resource_id", "=", providerResourceId).where("status", "=", "OPEN");
    if (upstreamModel) {
      query = query.where((eb) => eb.or([eb("upstream_model", "=", upstreamModel), eb("upstream_model", "is", null)]));
    }
    return await query.orderBy("started_at", "desc").executeTakeFirst() ?? null;
  }

  async recoverEvent(eventId: string, reason: string, manual = true, notify = true, now = new Date()): Promise<AvailabilityEvent> {
    return this.db.transaction().execute(async (trx) => {
      const event = await trx.selectFrom("availability_event").selectAll().where("id", "=", eventId)
        .forUpdate().executeTakeFirst();
      if (!event) throw new RuntimeAssuranceConflictError("event_not_found", "熔断事件不存在");
      if (event.status !== "OPEN") return event;
      const recovered = await trx.updateTable("availability_event").set({
        status: manual ? "MANUALLY_RECOVERED" : "RECOVERED",
        recovered_at: now,
        recovery_reason: reason.slice(0, 255),
        updated_at: now,
      }).where("id", "=", eventId).returningAll().executeTakeFirstOrThrow();
      if (notify) {
        const recipients = await trx.selectFrom("notification_delivery")
          .select("recipient_person_id").distinct()
          .where("availability_event_id", "=", event.id)
          .where("delivery_type", "=", "TRIGGER").execute();
        if (recipients.length > 0) {
          for (const recipient of recipients) {
            await this.enqueuePersonDeliveryTx(trx, recovered, recipient.recipient_person_id, "RECOVERY");
          }
        } else if (event.trigger_principal_id) {
          await this.enqueueEventDeliveryTx(trx, recovered, event.trigger_principal_id, "RECOVERY");
        }
      }
      return recovered;
    });
  }

  async recoverDueEvents(now = new Date(), notify = true): Promise<AvailabilityEvent[]> {
    const due = await this.db.selectFrom("availability_event").selectAll()
      .where("status", "=", "OPEN").where("recover_at", "is not", null).where("recover_at", "<=", now).execute();
    const recovered: AvailabilityEvent[] = [];
    for (const event of due) recovered.push(await this.recoverEvent(event.id, "到达规则恢复时间", false, notify, now));
    return recovered;
  }

  async recoverInactiveScheduleEvents(now = new Date(), notify = true): Promise<AvailabilityEvent[]> {
    const rows = await this.db.selectFrom("availability_event")
      .innerJoin("availability_rule_version", "availability_rule_version.id", "availability_event.rule_version_id")
      .innerJoin("availability_rule", "availability_rule.id", "availability_rule_version.availability_rule_id")
      .select(["availability_event.id as event_id", "availability_event.rule_version_id", "availability_rule.rule_type"])
      .where("availability_event.status", "=", "OPEN")
      .where("availability_event.availability_decision", "=", "BLOCKED_SCHEDULE")
      .execute();
    const recovered: AvailabilityEvent[] = [];
    for (const row of rows) {
      const version = await this.db.selectFrom("availability_rule_version").selectAll()
        .where("id", "=", row.rule_version_id).executeTakeFirstOrThrow();
      const snapshot = versionSnapshot({ ...version, rule_type: row.rule_type as AvailabilityRuleType });
      if (!scheduleMatches(snapshot, now)) {
        recovered.push(await this.recoverEvent(row.event_id, "计划熔断时段已结束", false, notify, now));
      }
    }
    return recovered;
  }

  /**
   * 旧 UNAVAILABLE 只读 Shadow 盘点。只有最近一次明确属于技术故障的旧状态事件
   * 才能自动降为 DEGRADED；其余全部保留并要求人工核验，绝不推断为新硬熔断。
   */
  async assessLegacyUnavailable(): Promise<LegacyUnavailableAssessment[]> {
    const rows = await this.db.selectFrom("provider_resource")
      .leftJoin("resource_status_event", (join) => join
        .onRef("resource_status_event.provider_resource_id", "=", "provider_resource.id")
        .on("resource_status_event.id", "=", sql<string>`(
          select e.id from resource_status_event e
          where e.provider_resource_id = provider_resource.id
          order by e.created_at desc, e.id desc limit 1
        )`))
      .select([
        "provider_resource.id as resource_id", "provider_resource.name as resource_name",
        "resource_status_event.reason as latest_reason",
        "resource_status_event.error_classification as latest_error_classification",
      ])
      .where("provider_resource.status", "=", "UNAVAILABLE")
      .execute();
    const technicalReasons = new Set(["FAILURE_THRESHOLD", "RATE_LIMITED", "PASSIVE_FAILURE"]);
    const technicalClassifications = new Set(["UPSTREAM_TEMPORARY", "TRANSPORT_ERROR", "UPSTREAM_RATE_LIMITED", "UNKNOWN"]);
    return rows.map((row) => ({
      ...row,
      disposition: technicalReasons.has(row.latest_reason ?? "") ||
        technicalClassifications.has(row.latest_error_classification ?? "")
        ? "SAFE_DOWNGRADE" as const
        : "MANUAL_REVIEW" as const,
    }));
  }

  /** W05B：只执行 Shadow 已证明安全的技术性 UNAVAILABLE -> DEGRADED。 */
  async migrateSafeLegacyUnavailable(now = new Date()): Promise<LegacyUnavailableAssessment[]> {
    const safe = (await this.assessLegacyUnavailable()).filter((item) => item.disposition === "SAFE_DOWNGRADE");
    for (const item of safe) {
      await this.db.transaction().execute(async (trx) => {
        const resource = await trx.selectFrom("provider_resource").selectAll()
          .where("id", "=", item.resource_id).where("status", "=", "UNAVAILABLE")
          .forUpdate().executeTakeFirst();
        if (!resource) return;
        await trx.updateTable("provider_resource").set({
          status: "DEGRADED", cooldown_until: null, version: sql`version + 1`, updated_at: now,
        }).where("id", "=", resource.id).execute();
        await trx.insertInto("resource_status_event").values({
          enterprise_id: resource.enterprise_id,
          provider_resource_id: resource.id,
          from_status: "UNAVAILABLE",
          to_status: "DEGRADED",
          reason: "RA_LEGACY_TECHNICAL_DOWNGRADE",
          error_classification: item.latest_error_classification,
          consecutive_failures: resource.consecutive_failures,
          cooldown_until: null,
          actor: "system",
        }).execute();
      });
    }
    return safe;
  }

  private async upsertObservationAlert(
    input: SignalInput,
    matched: AvailabilityRuleSnapshot | null,
    now: Date,
    detail?: string,
  ): Promise<void> {
    await writeObservationFault(this.db, input, now, detail ?? input.sanitizedSummary ?? matched?.ruleType);
  }

  protected async enqueueEventDeliveryTx(
    trx: Transaction<Database>,
    event: AvailabilityEvent,
    principalId: string,
    type: "TRIGGER" | "RECOVERY",
  ): Promise<boolean> {
    const principal = await trx.selectFrom("principal").select(["type", "person_id", "owner_person_id"])
      .where("id", "=", principalId).executeTakeFirst();
    const personId = principal?.type === "EMPLOYEE" ? principal.person_id : principal?.owner_person_id;
    if (!personId) return false;
    return this.enqueuePersonDeliveryTx(trx, event, personId, type);
  }

  protected async enqueuePersonDeliveryTx(
    trx: Transaction<Database>,
    event: AvailabilityEvent,
    personId: string,
    type: "TRIGGER" | "RECOVERY",
  ): Promise<boolean> {
    const endpoint = await trx.selectFrom("notification_endpoint").selectAll().where("status", "=", "ACTIVE").executeTakeFirst();
    if (!endpoint) return false;
    const identity = await trx.selectFrom("person_external_identity").selectAll()
      .where("person_id", "=", personId).where("provider", "=", "WECOM").where("status", "=", "ACTIVE").executeTakeFirst();
    const inserted = await trx.insertInto("notification_delivery").values({
      availability_event_id: event.id, notification_endpoint_id: endpoint.id,
      recipient_person_id: personId, recipient_identity_id: identity?.id ?? null,
      delivery_type: type, idempotency_key: `${event.id}:${personId}:${type}`,
      status: identity ? "PENDING" : "SKIPPED",
      last_error_classification: identity ? null : "RECIPIENT_IDENTITY_MISSING",
    }).onConflict((oc) => oc.column("idempotency_key").doNothing()).returning("id").executeTakeFirst();
    return Boolean(inserted);
  }
}
