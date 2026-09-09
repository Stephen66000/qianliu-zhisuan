import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";

/** Shared worker task health: only a subsequent completed execution proves recovery. */
export class OperationalFaultRepository {
  constructor(private db: Kysely<Database>) {}
  async record(
    task: string,
    title: string,
    ok: boolean,
    at = new Date(),
    enterpriseId?: string,
  ): Promise<void> {
    let query = this.db.selectFrom("enterprise").select("id");
    if (enterpriseId) query = query.where("id", "=", enterpriseId);
    const enterprises = await query.execute();
    for (const enterprise of enterprises) {
      await this.db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${"alerts:" + enterprise.id}))`.execute(
          trx,
        );
        const key = `SYSTEM_TASK:${task}`;
        const latest = await trx
          .selectFrom("alert_event")
          .selectAll()
          .where("enterprise_id", "=", enterprise.id)
          .where("alert_key", "=", key)
          .orderBy("first_seen_at", "desc")
          .orderBy("id", "desc")
          .forUpdate()
          .executeTakeFirst();
        if (ok) {
          if (!latest || latest.recovery_evidence || at <= latest.last_seen_at)
            return;
          await trx
            .updateTable("alert_event")
            .set({
              recovery_evidence: {
                kind: task.startsWith("health:")
                  ? "SERVICE_HEALTHY"
                  : "TASK_SUCCEEDED",
                summary: `${title}后续执行成功`,
                verifiedAt: at.toISOString(),
                referenceId: task,
              },
              source_cleared_at: at,
              ...(["OPEN", "INVESTIGATING", "AUTO_RESOLVED"].includes(
                latest.status,
              )
                ? { status: "AUTO_RESOLVED", resolved_at: at }
                : {}),
            })
            .where("id", "=", latest.id)
            .execute();
        } else if (latest && !latest.recovery_evidence) {
          if (at > latest.last_seen_at)
            await trx
              .updateTable("alert_event")
              .set({ last_seen_at: at })
              .where("id", "=", latest.id)
              .execute();
        } else {
          if (latest?.source_cleared_at && at <= latest.source_cleared_at)
            return;
          await trx
            .insertInto("alert_event")
            .values({
              enterprise_id: enterprise.id,
              alert_key: key,
              domain: "RESOURCE_UNAVAILABLE",
              signal: task.startsWith("health:")
                ? "service_failure"
                : "background_task_failure",
              severity: "HIGH",
              title: `${title}失败`,
              detail:
                "共享后台任务执行失败；请检查运行日志。此记录不表示本企业所有请求均已失败。",
              first_seen_at: at,
              last_seen_at: at,
              status: "OPEN",
            })
            .execute();
        }
      });
    }
  }
}
