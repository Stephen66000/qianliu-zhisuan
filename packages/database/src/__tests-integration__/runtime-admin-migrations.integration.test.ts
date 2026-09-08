import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown, migrateToLatest } from "../migrator.js";
import { AlertEventRepository } from "../repositories/alert-event-repository.js";

describe.sequential("0067/0068 运行保障与管理员迁移", () => {
  it("补齐历史异常资源，并阻止存在已清理管理员时回退", async () => {
    const pg = await startPostgresContainer("runtime_admin_0067_0068");
    const db = createKysely(pg.connectionString);
    try {
      const baseline = await createMigrator(db).migrateTo("0067_admin_cleanup");
      expect(baseline.error).toBeUndefined();
      const enterpriseId = randomUUID();
      const adminId = randomUUID();
      await db
        .insertInto("enterprise")
        .values({ id: enterpriseId, name: "迁移测试" })
        .execute();
      await db
        .insertInto("admin_user")
        .values({
          id: adminId,
          enterprise_id: enterpriseId,
          username: "archived-admin",
          password_hash: "test-only",
          status: "DISABLED",
        })
        .execute();
      const principal = await db
        .insertInto("principal")
        .values({
          enterprise_id: enterpriseId,
          type: "EMPLOYEE",
          name: "迁移主体",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const key = await db
        .insertInto("principal_key")
        .values({
          enterprise_id: enterpriseId,
          principal_id: principal.id,
          key_prefix: "migration",
          key_digest: randomUUID(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const provider = await db
        .insertInto("provider")
        .values({
          enterprise_id: enterpriseId,
          code: "migration-provider",
          name: "迁移厂商",
          adapter_type: "OPENAI_COMPATIBLE",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const resource = await db
        .insertInto("provider_resource")
        .values({
          enterprise_id: enterpriseId,
          provider_id: provider.id,
          name: "迁移资源",
          mode: "API",
          credential_type: "API_KEY",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const requestId = randomUUID();
      await db
        .insertInto("ai_request")
        .values({
          id: requestId,
          enterprise_id: enterpriseId,
          principal_id: principal.id,
          principal_key_id: key.id,
          protocol: "openai",
          unified_model: "migration-model",
          status: "FAILED",
        })
        .execute();
      await db
        .insertInto("upstream_attempt")
        .values({
          ai_request_id: requestId,
          enterprise_id: enterpriseId,
          attempt_no: 1,
          provider_resource_id: resource.id,
          upstream_model: "migration-model",
        })
        .execute();
      const reconciliationRun = await db
        .insertInto("reconciliation_run")
        .values({
          enterprise_id: enterpriseId,
          range_from: new Date(),
          range_to: new Date(),
          result: "REVIEW",
          algorithm_version: "migration-test",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const discrepancy = await db
        .insertInto("reconciliation_discrepancy")
        .values({
          enterprise_id: enterpriseId,
          reconciliation_run_id: reconciliationRun.id,
          discrepancy_type: "SETTLEMENT_MISMATCH",
          ai_request_id: requestId,
          detail: {},
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const alertId = await db
        .insertInto("alert_event")
        .values({
          enterprise_id: enterpriseId,
          alert_key: `QUOTA_ANOMALY:reconciliation:${discrepancy.id}`,
          domain: "QUOTA_ANOMALY",
          signal: "call_deduction_anomaly",
          title: "迁移异常",
          ai_request_id: requestId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      expect(await migrateToLatest(db)).toContain(
        "0068_alert_resource_context",
      );
      expect(
        await db
          .selectFrom("alert_event")
          .select("resource_id")
          .where("id", "=", alertId.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ resource_id: resource.id });
      await new AlertEventRepository(db).evaluate(enterpriseId);
      expect(
        await db
          .selectFrom("alert_event")
          .select("resource_id")
          .where("id", "=", alertId.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ resource_id: resource.id });
      expect(await migrateDown(db)).toBe("0069_auth_error_evidence");
      expect(await migrateDown(db)).toBe("0068_alert_resource_context");
      expect(
        await db
          .selectFrom("alert_event")
          .select("resource_id")
          .where("id", "=", alertId.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ resource_id: resource.id });

      await db
        .updateTable("admin_user")
        .set({ archived_at: new Date() })
        .where("id", "=", adminId)
        .execute();
      await expect(migrateDown(db)).rejects.toThrow(
        "cannot roll back while archived administrators exist",
      );
    } finally {
      await db.destroy();
      await pg.stop();
    }
  }, 120_000);
});
