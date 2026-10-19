import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "./kysely.js";

export const reportTypes = ["DAILY", "COMPANY_WEEKLY", "PERSONAL_WEEKLY", "COMPANY_MONTHLY", "PERSONAL_MONTHLY", "TOP1", "OVER50"] as const;
export type ReportType = typeof reportTypes[number];
export type ReportMessageStatus = "PENDING" | "SENDING" | "SENT" | "RETRYABLE_FAILED" | "PERMANENT_FAILED" | "UNKNOWN" | "SKIPPED";
export interface ReportSnapshot { png: string; text: string; filename: string }
export interface ReportBundle {
  id: string; enterprise_id: string; report_type: ReportType; period_key: string;
  recipient_ref: string; target_user_id: string | null; endpoint_id: string | null;
  period_start: Date; period_end: Date; window_start: Date; window_end: Date;
  snapshot: ReportSnapshot; content_hash: string;
}
export interface ReportMessage {
  id: string; enterprise_id: string; bundle_id: string; kind: "IMAGE" | "TEXT";
  status: ReportMessageStatus; attempt_count: number; version: number;
  lease_until: Date | null; next_attempt_at: Date | null; last_attempt_at: Date | null;
  provider_message_id: string | null; error_code: string | null; classification: string | null;
}
export interface FreezeReport {
  enterpriseId: string; type: ReportType; periodKey: string; recipientRef: string;
  targetUserId?: string; endpointId?: string; periodStart: Date; periodEnd: Date;
  windowStart: Date; windowEnd: Date; snapshot: ReportSnapshot; claims?: string[];
}
export interface ReportReceipt {
  status: Exclude<ReportMessageStatus, "PENDING" | "SENDING">;
  providerMessageId?: string; providerErrorCode?: string; classification?: string;
}
export class ReportDeliveryRepository {
  constructor(readonly db: Kysely<Database>) {}

  async freeze(input: FreezeReport): Promise<ReportBundle | null> {
    return this.db.transaction().execute(async tx => {
      // Serialize logical identity and incentive guards, including across different winners.
      const scopes = [`bundle:${input.type}:${input.periodKey}:${input.recipientRef}`, ...(input.claims ?? [])].sort();
      for (const scope of scopes) await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.enterpriseId + scope},0))`.execute(tx);
      const existing = await sql<ReportBundle>`SELECT * FROM report_delivery_bundle WHERE enterprise_id=${input.enterpriseId}
        AND report_type=${input.type} AND period_key=${input.periodKey} AND recipient_ref=${input.recipientRef}`.execute(tx);
      if (existing.rows[0]) return existing.rows[0];
      for (const scope of input.claims ?? []) {
        const claimed = await sql`SELECT 1 FROM report_delivery_claim WHERE enterprise_id=${input.enterpriseId} AND scope=${scope}`.execute(tx);
        if (claimed.rows.length) return null;
      }
      const hash = createHash("sha256").update(JSON.stringify(input.snapshot)).digest("hex");
      const { rows: [bundle] } = await sql<ReportBundle>`INSERT INTO report_delivery_bundle
        (enterprise_id,report_type,period_key,recipient_ref,target_user_id,endpoint_id,period_start,period_end,window_start,window_end,snapshot,content_hash)
        VALUES (${input.enterpriseId},${input.type},${input.periodKey},${input.recipientRef},${input.targetUserId ?? null},${input.endpointId ?? null},
          ${input.periodStart},${input.periodEnd},${input.windowStart},${input.windowEnd},${JSON.stringify(input.snapshot)}::jsonb,${hash}) RETURNING *`.execute(tx);
      if (!bundle) throw new Error("REPORT_FREEZE_FAILED");
      const classification = !input.targetUserId ? "NO_WECOM_IDENTITY" : !input.endpointId ? "NO_ACTIVE_ENDPOINT" : null;
      for (const kind of ["IMAGE", "TEXT"]) await sql`INSERT INTO report_delivery_message(enterprise_id,bundle_id,kind,status,classification)
        VALUES(${input.enterpriseId},${bundle.id},${kind},${classification ? "PERMANENT_FAILED" : "PENDING"},${classification})`.execute(tx);
      for (const scope of input.claims ?? []) await sql`INSERT INTO report_delivery_claim(enterprise_id,scope,bundle_id)
        VALUES(${input.enterpriseId},${scope},${bundle.id})`.execute(tx);
      return bundle;
    });
  }

  async bundles(enterprise: string, type: ReportType, period: string, recipient?: string) {
    return (await sql<ReportBundle>`SELECT * FROM report_delivery_bundle WHERE enterprise_id=${enterprise}
      AND report_type=${type} AND period_key=${period} ${recipient ? sql`AND recipient_ref=${recipient}` : sql``} ORDER BY recipient_ref`.execute(this.db)).rows;
  }
  async messages(enterprise: string, bundle: string) {
    return (await sql<ReportMessage>`SELECT * FROM report_delivery_message WHERE enterprise_id=${enterprise} AND bundle_id=${bundle} ORDER BY kind`.execute(this.db)).rows;
  }
  async schedule(enterprise: string, type: ReportType, date: string) {
    return (await sql<{schedule_date:string;status:string;classification:string|null;updated_at:Date}>`
      SELECT schedule_date,status,classification,updated_at FROM report_delivery_schedule
      WHERE enterprise_id=${enterprise} AND report_type=${type} AND schedule_date=${date}`.execute(this.db)).rows;
  }
  async attempts(enterprise: string, bundle: string) {
    return (await sql`SELECT a.* FROM report_delivery_attempt a JOIN report_delivery_message m ON m.id=a.message_id AND m.enterprise_id=a.enterprise_id
      WHERE m.enterprise_id=${enterprise} AND m.bundle_id=${bundle} ORDER BY a.started_at,a.message_id,a.version`.execute(this.db)).rows;
  }
  async expire(enterprise: string, now: Date) {
    await this.db.transaction().execute(async tx => {
      const expired = await sql<ReportMessage>`UPDATE report_delivery_message SET status='UNKNOWN',classification='LEASE_EXPIRED',lease_until=NULL
        WHERE enterprise_id=${enterprise} AND status='SENDING' AND lease_until<=${now} RETURNING *`.execute(tx);
      for (const row of expired.rows) await sql`UPDATE report_delivery_attempt SET status='UNKNOWN',classification='LEASE_EXPIRED',finished_at=${now}
        WHERE enterprise_id=${enterprise} AND message_id=${row.id} AND version=${row.version} AND status='SENDING'`.execute(tx);
    });
  }

  async claim(enterprise: string, id: string, now: Date, manual?: { version: number; allowUnknown: boolean; reason: string }) {
    return this.db.transaction().execute(async tx => {
      const { rows: [message] } = await sql<ReportMessage>`SELECT m.* FROM report_delivery_message m
        JOIN report_delivery_bundle b ON b.id=m.bundle_id AND b.enterprise_id=m.enterprise_id
        WHERE m.enterprise_id=${enterprise} AND m.id=${id} FOR UPDATE OF m`.execute(tx);
      if (!message || message.status === "SENT" || message.status === "SENDING" || message.status === "SKIPPED") return null;
      if (message.kind === "TEXT") {
        const image = await sql`SELECT 1 FROM report_delivery_message WHERE enterprise_id=${enterprise} AND bundle_id=${message.bundle_id} AND kind='IMAGE' AND status='SENT'`.execute(tx);
        if (!image.rows.length) return null;
      }
      if (manual) {
        if (message.version !== manual.version || (message.status === "UNKNOWN" && !manual.allowUnknown)) return null;
        await sql`INSERT INTO report_delivery_action(enterprise_id,bundle_id,message_id,action,reason,previous_status,previous_version)
          VALUES(${enterprise},${message.bundle_id},${id},'MANUAL_RETRY',${manual.reason},${message.status},${message.version})`.execute(tx);
      } else {
        if (!["PENDING", "RETRYABLE_FAILED"].includes(message.status) || message.attempt_count >= 3 || (message.next_attempt_at && message.next_attempt_at > now)) return null;
        const window = await sql`SELECT 1 FROM report_delivery_bundle WHERE enterprise_id=${enterprise} AND id=${message.bundle_id}
          AND window_start<=${now} AND window_end>${now}`.execute(tx);
        if (!window.rows.length) return null;
      }
      const { rows: [claimed] } = await sql<ReportMessage>`UPDATE report_delivery_message SET status='SENDING',version=version+1,
        attempt_count=attempt_count+1,last_attempt_at=${now},lease_until=${new Date(now.getTime()+90_000)},next_attempt_at=NULL
        WHERE enterprise_id=${enterprise} AND id=${id} RETURNING *`.execute(tx);
      await sql`INSERT INTO report_delivery_attempt(enterprise_id,message_id,version,started_at,status)
        VALUES(${enterprise},${id},${claimed!.version},${now},'SENDING')`.execute(tx);
      return claimed!;
    });
  }

  async owns(message: ReportMessage, now: Date) {
    return (await sql`SELECT 1 FROM report_delivery_message WHERE enterprise_id=${message.enterprise_id} AND id=${message.id}
      AND status='SENDING' AND version=${message.version} AND lease_until>${now}`.execute(this.db)).rows.length > 0;
  }
  async startMessageRequest(message: ReportMessage, now: Date) {
    const result = await sql`UPDATE report_delivery_attempt a SET message_requests=1
      FROM report_delivery_message m WHERE a.enterprise_id=${message.enterprise_id} AND a.message_id=${message.id}
      AND a.version=${message.version} AND m.id=a.message_id AND m.enterprise_id=a.enterprise_id
      AND m.version=a.version AND m.status='SENDING' AND m.lease_until>${now} RETURNING a.id`.execute(this.db);
    return result.rows.length > 0;
  }
  async finish(message: ReportMessage, receipt: ReportReceipt, now: Date, preparationRequests = 0, messageRequests = 0, tokenRequests = 0, mediaRequests = 0) {
    const jitter = parseInt(createHash("sha256").update(message.id).digest("hex").slice(0,4),16)%5*1000;
    const retry = receipt.status === "RETRYABLE_FAILED" && message.attempt_count < 3
      ? new Date(now.getTime() + (message.attempt_count === 1 ? 30_000 : 120_000) + jitter) : null;
    return this.db.transaction().execute(async tx => {
      const updated = await sql`UPDATE report_delivery_message SET status=${receipt.status},provider_message_id=${receipt.providerMessageId ?? null},
        error_code=${receipt.providerErrorCode ?? null},classification=${receipt.classification ?? null},lease_until=NULL,next_attempt_at=${retry}
        WHERE enterprise_id=${message.enterprise_id} AND id=${message.id} AND version=${message.version} AND status='SENDING' AND lease_until>${now} RETURNING id`.execute(tx);
      if (!updated.rows.length) return false;
      await sql`UPDATE report_delivery_attempt SET status=${receipt.status},finished_at=${now},provider_message_id=${receipt.providerMessageId ?? null},
        error_code=${receipt.providerErrorCode ?? null},classification=${receipt.classification ?? null},preparation_requests=${preparationRequests},message_requests=${messageRequests},token_requests=${tokenRequests},media_requests=${mediaRequests}
        WHERE enterprise_id=${message.enterprise_id} AND message_id=${message.id} AND version=${message.version}`.execute(tx);
      return true;
    });
  }
}
