import { ReportDeliveryRepository, type Database, type FreezeReport, type ReportBundle,
  type ReportMessage, type ReportReceipt } from "@qianliu/database";
import type { Kysely } from "kysely";
import { WecomAppClient, WecomPreparationError } from "../runtime-assurance/wecom-client.js";

export type DeliveryStatus = "SENT" | "DELIVERY_PENDING" | "DELIVERY_FAILED" | "UNKNOWN" | "NO_ELIGIBLE_RECIPIENTS" | "CLAIM_CONFLICT";
export interface DeliveryOptions { now?: Date; deliveryWindow?: { start: Date; end: Date }; clock?: () => Date }
export interface DeliverySummary { status: DeliveryStatus; sent: number; failed: number; unknown: number; pending: number; skipped: number }
export function summarizeMessages(messages: ReportMessage[]): DeliverySummary {
  const count = (states: string[]) => messages.filter(m => states.includes(m.status)).length;
  const sent = count(["SENT"]), failed = count(["PERMANENT_FAILED", "RETRYABLE_FAILED"]);
  const unknown = count(["UNKNOWN"]), pending = count(["PENDING", "SENDING"]), skipped = count(["SKIPPED"]);
  const status = !messages.length || skipped === messages.length ? "NO_ELIGIBLE_RECIPIENTS"
    : sent === messages.length ? "SENT" : unknown ? "UNKNOWN" : failed ? "DELIVERY_FAILED" : "DELIVERY_PENDING";
  return { status, sent, failed, unknown, pending, skipped };
}

/** All seven report paths use this entry. Frozen content always wins over regeneration. */
export async function deliverReport(input: Omit<FreezeReport, "windowStart" | "windowEnd"> & DeliveryOptions & {
  db: Kysely<Database>; kekBase64: string;
}): Promise<DeliverySummary> {
  const clock = input.clock ?? (() => new Date());
  const now = clock();
  const window = input.deliveryWindow ?? reportWindow(now, input.type === "TOP1" || input.type === "OVER50");
  const repo = new ReportDeliveryRepository(input.db);
  const bundle = await repo.freeze({ ...input, windowStart: window.start, windowEnd: window.end });
  if (bundle && (input.type === "TOP1" || input.type === "OVER50") && bundle.window_start.getTime() !== window.start.getTime()) {
    return { ...summarizeMessages([]), status: "CLAIM_CONFLICT" };
  }
  if (!bundle) return { ...summarizeMessages([]), status: "CLAIM_CONFLICT" };
  return executeReportBundle({ repo, bundle, kekBase64: input.kekBase64, clock });
}

export function reportWindow(now: Date, incentive = false) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { start: new Date(`${date}T09:${incentive ? "30" : "00"}:00+08:00`),
    end: new Date(`${date}T${incentive ? "10:00" : "09:30"}:00+08:00`) };
}

export async function executeReportBundle(input: {
  repo: ReportDeliveryRepository; bundle: ReportBundle; kekBase64: string; clock?: () => Date;
  client?: WecomAppClient;
  manual?: { versions: Record<string, number>; allowUnknown: boolean; reason: string; deadline: Date };
}): Promise<DeliverySummary> {
  const { repo, bundle, manual } = input, clock = input.clock ?? (() => new Date());
  await repo.expire(bundle.enterprise_id, clock());
  const client = input.client ?? new WecomAppClient(input.kekBase64);
  const endpoint = bundle.endpoint_id ? await repo.db.selectFrom("notification_endpoint").selectAll()
    .where("id", "=", bundle.endpoint_id).where("status", "=", "ACTIVE").executeTakeFirst() : null;
  for (const row of await repo.messages(bundle.enterprise_id, bundle.id)) {
    if (manual && (manual.versions[row.id] === undefined || clock() >= manual.deadline)) continue;
    const claimed = await repo.claim(bundle.enterprise_id, row.id, clock(), manual ? {
      version: manual.versions[row.id]!, allowUnknown: manual.allowUnknown, reason: manual.reason,
    } : undefined);
    if (!claimed) continue;
    const before = { ...client.requestCounts };
    let receipt: ReportReceipt;
    try {
      if (!endpoint || !bundle.target_user_id) {
        receipt = { status: "PERMANENT_FAILED", classification: !endpoint ? "NO_ACTIVE_ENDPOINT" : "NO_WECOM_IDENTITY" };
      } else {
        const guard = async () => {
          const now = clock();
          const inWindow = manual ? now < manual.deadline : now >= bundle.window_start && now < bundle.window_end;
          return inWindow && await repo.owns(claimed, now);
        };
        if (!await guard()) receipt = { status: "RETRYABLE_FAILED", classification: "SEND_GUARD_CLOSED" };
        else {
          const message = row.kind === "IMAGE" ? { kind: "IMAGE" as const, mediaId: await client.uploadMedia(endpoint,
            Buffer.from(bundle.snapshot.png, "base64"), bundle.snapshot.filename) }
            : { kind: "TEXT" as const, content: bundle.snapshot.text };
          receipt = await client.sendReportMessage(endpoint, bundle.target_user_id, message, async () => await guard() && await repo.startMessageRequest(claimed, clock()));
        }
      }
    } catch (error) {
      receipt = error instanceof WecomPreparationError ? error.result
        : { status: "RETRYABLE_FAILED", classification: "PREPARATION_FAILED" };
    }
    // If this write fails the SENDING lease remains; expiration becomes UNKNOWN, never replay.
    try {
      await repo.finish(claimed, receipt, clock(), client.requestCounts.token - before.token + client.requestCounts.media - before.media,
        client.requestCounts.message - before.message,client.requestCounts.token-before.token,client.requestCounts.media-before.media);
    } catch {
      // Try to persist ambiguity, not a false failure. If DB remains down, lease recovery does this.
      await repo.finish(claimed, { status: "UNKNOWN", classification: "RECEIPT_PERSISTENCE_FAILED" }, clock(),
        client.requestCounts.token - before.token + client.requestCounts.media - before.media, client.requestCounts.message - before.message,client.requestCounts.token-before.token,client.requestCounts.media-before.media);
    }
  }
  return summarizeMessages(await repo.messages(bundle.enterprise_id, bundle.id));
}

/** Stable person identity prevents a changed WeCom account from creating a second delivery. */
export async function reportRecipientRef(db: Kysely<Database>, enterpriseId: string, user: string) {
  const identity = await db.selectFrom("person_external_identity").select("person_id")
    .where("enterprise_id", "=", enterpriseId).where("provider", "=", "WECOM")
    .where("status", "=", "ACTIVE").where("provider_user_id", "=", user).executeTakeFirst();
  return identity?.person_id ?? `wecom:${user.toLowerCase()}`;
}
