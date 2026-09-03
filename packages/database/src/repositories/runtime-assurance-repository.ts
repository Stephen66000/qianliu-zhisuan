import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { RuntimeAssuranceEventsRepository } from "./runtime-assurance-events.js";
import {
  RuntimeAssuranceConflictError, type DeliveryContext, type NotificationDelivery,
  type NotificationEndpoint, type PersonExternalIdentity,
} from "./runtime-assurance-core.js";

export * from "./runtime-assurance-core.js";

export class RuntimeAssuranceRepository extends RuntimeAssuranceEventsRepository {
  async getOverview(): Promise<Record<string, unknown>> {
    const resourceRows = await this.db.selectFrom("provider_resource")
      .select(["status", sql<number>`count(*)::int`.as("count")]).groupBy("status").execute();
    const open = await this.db.selectFrom("availability_event").select([
      sql<number>`count(*)::int`.as("count"),
      sql<number>`count(distinct provider_resource_id)::int`.as("resource_count"),
      sql<number>`coalesce(sum(affected_request_count), 0)::int`.as("affected_requests"),
      sql<Date | null>`min(recover_at)`.as("next_recover_at"),
    ]).where("status", "=", "OPEN").executeTakeFirstOrThrow();
    return {
      resources: Object.fromEntries(resourceRows.map((row) => [row.status, row.count])),
      open_event_count: open.count,
      blocked_resource_count: open.resource_count,
      affected_request_count: open.affected_requests,
      next_recover_at: open.next_recover_at,
    };
  }

  async getEndpoint(): Promise<NotificationEndpoint | null> {
    return await this.db.selectFrom("notification_endpoint").selectAll().orderBy("created_at", "desc").executeTakeFirst() ?? null;
  }

  async saveEndpoint(input: {
    corpId: string;
    agentId: string;
    secretCiphertext: string;
    secretFingerprint: string;
    status: "ACTIVE" | "DISABLED";
    expectedVersion?: number;
  }): Promise<NotificationEndpoint> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx.selectFrom("notification_endpoint").selectAll().orderBy("created_at", "desc")
        .forUpdate().executeTakeFirst();
      if (!current) {
        return trx.insertInto("notification_endpoint").values({
          provider: "WECOM_APP", corp_id: input.corpId, agent_id: input.agentId,
          secret_ciphertext: input.secretCiphertext, secret_fingerprint: input.secretFingerprint,
          status: input.status,
        }).returningAll().executeTakeFirstOrThrow();
      }
      if (input.expectedVersion !== current.version) {
        throw new RuntimeAssuranceConflictError("version_conflict", "企微应用配置已被其他操作修改");
      }
      return trx.updateTable("notification_endpoint").set({
        corp_id: input.corpId, agent_id: input.agentId,
        secret_ciphertext: input.secretCiphertext, secret_fingerprint: input.secretFingerprint,
        status: input.status, version: sql`version + 1`, updated_at: new Date(),
      }).where("id", "=", current.id).where("version", "=", input.expectedVersion!)
        .returningAll().executeTakeFirstOrThrow();
    });
  }

  async enqueueTestDelivery(personId: string): Promise<NotificationDelivery> {
    return this.db.transaction().execute(async (trx) => {
      const endpoint = await trx.selectFrom("notification_endpoint").selectAll().where("status", "=", "ACTIVE").executeTakeFirst();
      if (!endpoint) throw new RuntimeAssuranceConflictError("wecom_endpoint_inactive", "企微应用未启用");
      const identity = await trx.selectFrom("person_external_identity").selectAll()
        .where("person_id", "=", personId).where("provider", "=", "WECOM").where("status", "=", "ACTIVE").executeTakeFirst();
      if (!identity) throw new RuntimeAssuranceConflictError("wecom_identity_missing", "该人员未配置企微 userid");
      return trx.insertInto("notification_delivery").values({
        notification_endpoint_id: endpoint.id, recipient_person_id: personId,
        recipient_identity_id: identity.id, delivery_type: "TEST",
        idempotency_key: `test:${personId}:${randomUUID()}`,
      }).returningAll().executeTakeFirstOrThrow();
    });
  }

  async listDeliveries(limit = 100): Promise<NotificationDelivery[]> {
    return this.db.selectFrom("notification_delivery").selectAll().orderBy("created_at", "desc").limit(limit).execute();
  }

  async getDeliveryContext(deliveryId: string): Promise<DeliveryContext | null> {
    const delivery = await this.db.selectFrom("notification_delivery").selectAll()
      .where("id", "=", deliveryId).executeTakeFirst();
    if (!delivery) return null;
    const [endpoint, identity, person, event] = await Promise.all([
      this.db.selectFrom("notification_endpoint").selectAll()
        .where("id", "=", delivery.notification_endpoint_id).executeTakeFirst(),
      delivery.recipient_identity_id
        ? this.db.selectFrom("person_external_identity").selectAll()
          .where("id", "=", delivery.recipient_identity_id).where("provider", "=", "WECOM").executeTakeFirst()
        : Promise.resolve(undefined),
      this.db.selectFrom("person").selectAll().where("id", "=", delivery.recipient_person_id).executeTakeFirst(),
      delivery.availability_event_id
        ? this.db.selectFrom("availability_event").selectAll()
          .where("id", "=", delivery.availability_event_id).executeTakeFirst()
        : Promise.resolve(undefined),
    ]);
    if (!endpoint || !person) return null;
    const principal = event?.trigger_principal_id
      ? await this.db.selectFrom("principal").selectAll().where("id", "=", event.trigger_principal_id).executeTakeFirst()
      : undefined;
    return { delivery, endpoint, identity: identity as PersonExternalIdentity | undefined ?? null, person, principal: principal ?? null, event: event ?? null };
  }

  async releaseStaleDeliveries(staleBefore: Date, now = new Date()): Promise<number> {
    const result = await this.db.updateTable("notification_delivery").set({
      status: "RETRYABLE_FAILED", next_attempt_at: now,
      last_error_classification: "STALE_CLAIM_RECOVERED", updated_at: now,
    }).where("status", "=", "IN_PROGRESS").where("updated_at", "<", staleBefore).executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  async claimDeliveries(limit = 20, now = new Date()): Promise<NotificationDelivery[]> {
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom("notification_delivery").selectAll()
        .where("status", "in", ["PENDING", "RETRYABLE_FAILED"])
        .where((eb) => eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", now)]))
        .orderBy("created_at", "asc").limit(limit).forUpdate().skipLocked().execute();
      if (rows.length === 0) return [];
      await trx.updateTable("notification_delivery").set({ status: "IN_PROGRESS", updated_at: now })
        .where("id", "in", rows.map((row) => row.id)).execute();
      return rows.map((row) => ({ ...row, status: "IN_PROGRESS" as const }));
    });
  }

  async completeDelivery(input: {
    id: string;
    status: "SENT" | "RETRYABLE_FAILED" | "PERMANENT_FAILED" | "SKIPPED";
    providerMessageId?: string | null;
    providerErrorCode?: string | null;
    classification?: string | null;
    nextAttemptAt?: Date | null;
  }): Promise<void> {
    await this.db.updateTable("notification_delivery").set({
      status: input.status,
      attempt_count: sql`attempt_count + 1`,
      provider_message_id: input.providerMessageId ?? null,
      provider_error_code: input.providerErrorCode ?? null,
      last_error_classification: input.classification ?? null,
      next_attempt_at: input.nextAttemptAt ?? null,
      sent_at: input.status === "SENT" ? new Date() : null,
      updated_at: new Date(),
    }).where("id", "=", input.id).execute();
  }

}
