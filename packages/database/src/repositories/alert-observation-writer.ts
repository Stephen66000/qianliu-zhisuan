import { sql, type Kysely } from "kysely";
import { createHash } from "node:crypto";
import { availabilitySignalSummary } from "@qianliu/domain";
import type { Database } from "../kysely.js";
import type { SignalInput } from "./runtime-assurance-core.js";
import { verifyRequestRecoveries } from "./alert-event-recovery.js";

export async function writeObservationFault(
  db: Kysely<Database>,
  input: SignalInput,
  now: Date,
  detail?: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${"alerts:" + input.enterpriseId}))`.execute(
      trx,
    );
    const modelScope = createHash("sha256")
      .update(input.unifiedModelId ?? input.upstreamModel)
      .digest("hex")
      .slice(0, 24);
    const key = `RUNTIME_ASSURANCE:${input.signal}:${input.providerResourceId}:${modelScope}`;
    const request = await trx
      .selectFrom("ai_request")
      .select("finished_at")
      .where("enterprise_id", "=", input.enterpriseId)
      .where("id", "=", input.aiRequestId)
      .executeTakeFirst();
    // Gateway supplies request start as occurrence time, but recovery must follow
    // the actual completion of every failure, including long/late requests.
    const observedAt = new Date(
      Math.max(now.getTime(), request?.finished_at?.getTime() ?? Date.now()),
    );
    await verifyRequestRecoveries(trx, input.enterpriseId, {
      alertKey: key,
      observedAt,
    });
    const recovered = await trx
      .selectFrom("alert_event")
      .select(["id", "first_seen_at"])
      .where("enterprise_id", "=", input.enterpriseId)
      .where("alert_key", "=", key)
      .where("recovery_evidence", "is not", null)
      .where("source_cleared_at", ">", observedAt)
      .orderBy("source_cleared_at", "asc")
      .orderBy("id", "asc")
      .forUpdate()
      .executeTakeFirst();
    // A replay belongs to the first episode whose recovery follows that failure.
    // Do not reopen it or move a newer active episode back into an earlier month.
    if (recovered) {
      if (now < recovered.first_seen_at)
        await trx
          .updateTable("alert_event")
          .set({ first_seen_at: now })
          .where("id", "=", recovered.id)
          .execute();
      return;
    }
    const latest = await trx
      .selectFrom("alert_event")
      .selectAll()
      .where("enterprise_id", "=", input.enterpriseId)
      .where("alert_key", "=", key)
      .orderBy("last_seen_at", "desc")
      .orderBy("id", "desc")
      .forUpdate()
      .executeTakeFirst();
    const priorRequest = latest?.ai_request_id
      ? await trx
          .selectFrom("ai_request")
          .select("finished_at")
          .where("enterprise_id", "=", input.enterpriseId)
          .where("id", "=", latest.ai_request_id)
          .executeTakeFirst()
      : undefined;
    const barrier = latest
      ? new Date(
          Math.max(
            latest.last_seen_at.getTime(),
            priorRequest?.finished_at?.getTime() ?? 0,
          ),
        )
      : observedAt;
    const patch = {
      last_seen_at: observedAt,
      title: `上游故障：${availabilitySignalSummary(input.signal)}`,
      detail:
        detail ??
        input.sanitizedSummary ??
        availabilitySignalSummary(input.signal),
      principal_id: input.principalId,
      ai_request_id: input.aiRequestId,
    };
    if (latest && !latest.recovery_evidence) {
      await trx
        .updateTable("alert_event")
        .set({
          // Completion time is monotonic; payload and trigger must describe the
          // same latest failure, while first occurrence keeps the earliest date.
          ...(observedAt > barrier ? patch : { last_seen_at: barrier }),
          first_seen_at:
            now < latest.first_seen_at ? now : latest.first_seen_at,
          ...(latest.status === "AUTO_RESOLVED"
            ? { status: "OPEN", source_cleared_at: null, resolved_at: null }
            : {}),
        })
        .where("id", "=", latest.id)
        .execute();
    } else {
      await trx
        .insertInto("alert_event")
        .values({
          enterprise_id: input.enterpriseId,
          alert_key: key,
          domain: "RESOURCE_UNAVAILABLE",
          signal: input.signal,
          severity: "MEDIUM",
          ...patch,
          resource_id: input.providerResourceId,
          first_seen_at: now,
          status: "OPEN",
        })
        .execute();
    }
  });
}
