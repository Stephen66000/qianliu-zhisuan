import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { migrateToLatest } from "../migrator.js";
import { deriveDispatchAlerts } from "../repositories/alert-event-request-derivations.js";

describe.sequential("异常中心调度历史容量", () => {
  it("65,535 条正常历史决策不会耗尽绑定参数或产生异常", async () => {
    const pg = await startPostgresContainer("alert_dispatch_scale");
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterpriseId = randomUUID();
      await db
        .insertInto("enterprise")
        .values({ id: enterpriseId, name: "容量测试" })
        .execute();
      const principal = await db
        .insertInto("principal")
        .values({
          enterprise_id: enterpriseId,
          type: "EMPLOYEE",
          name: "容量主体",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const key = await db
        .insertInto("principal_key")
        .values({
          enterprise_id: enterpriseId,
          principal_id: principal.id,
          key_prefix: "scale",
          key_digest: randomUUID(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const policy = await db
        .insertInto("dispatch_policy")
        .values({
          enterprise_id: enterpriseId,
          status: "PUBLISHED",
          action: "ALLOW",
          policy_version: "scale",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await sql`INSERT INTO ai_request
        (id, enterprise_id, principal_id, principal_key_id, protocol, unified_model, status)
        SELECT gen_random_uuid(), ${enterpriseId}::uuid, ${principal.id}::uuid,
               ${key.id}::uuid, 'openai', 'scale-model', 'SUCCEEDED'
          FROM generate_series(1, 65535)`.execute(db);
      await sql`INSERT INTO dispatch_decision
        (enterprise_id, ai_request_id, matched_policy_id, matched_policy_action,
         final_action, reason_code)
        SELECT enterprise_id, id, ${policy.id}::uuid, 'ALLOW', 'ALLOW', 'SCALE'
          FROM ai_request
         WHERE enterprise_id = ${enterpriseId}
           AND unified_model = 'scale-model'`.execute(db);

      await expect(deriveDispatchAlerts(db, enterpriseId)).resolves.toEqual([]);
    } finally {
      await db.destroy();
      await pg.stop();
    }
  }, 120_000);
});
