import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateToLatest } from "../migrator.js";

it("0066 备份可恢复，0067/0068 保留管理员历史引用且归档后禁止回退", async () => {
  const container = await new PostgreSqlContainer(
    "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
  )
    .withDatabase("runtime_source")
    .withUsername("test_user")
    .withPassword("test_only")
    .start();
  const db = createKysely(container.getConnectionUri());
  let restored: ReturnType<typeof createKysely> | undefined;
  const command = async (args: string[]) => {
    const result = await container.exec(args);
    expect(result.exitCode, result.output).toBe(0);
  };
  try {
    const baseline = await createMigrator(db).migrateTo(
      "0066_subscription_auto_renewal",
    );
    expect(baseline.error).toBeUndefined();
    const enterpriseId = randomUUID(),
      adminId = randomUUID();
    const employeeId = randomUUID(),
      projectId = randomUUID(),
      assignmentId = randomUUID();
    await db
      .insertInto("enterprise")
      .values({ id: enterpriseId, name: "发布演练企业" })
      .execute();
    await db
      .insertInto("admin_user")
      .values({
        id: adminId,
        enterprise_id: enterpriseId,
        username: "historical-admin",
        password_hash: "test_only",
        status: "DISABLED",
      })
      .execute();
    await db
      .insertInto("principal")
      .values([
        {
          id: employeeId,
          enterprise_id: enterpriseId,
          type: "EMPLOYEE",
          name: "负责人",
        },
        {
          id: projectId,
          enterprise_id: enterpriseId,
          type: "PROJECT",
          name: "历史项目",
        },
      ])
      .execute();
    await sql`INSERT INTO principal_accounting_assignment
      (id,enterprise_id,principal_id,principal_type,owner_principal_id,version,valid_from,created_by)
      VALUES (${assignmentId}::uuid,${enterpriseId}::uuid,${projectId}::uuid,'PROJECT',
        ${employeeId}::uuid,1,now(),${adminId}::uuid)`.execute(db);
    await command([
      "pg_dump",
      "-U",
      "test_user",
      "-d",
      "runtime_source",
      "-Fc",
      "-f",
      "/tmp/pre-runtime.dump",
    ]);
    await command(["pg_restore", "-l", "/tmp/pre-runtime.dump"]);
    await command(["createdb", "-U", "test_user", "runtime_restore"]);
    await command([
      "pg_restore",
      "-U",
      "test_user",
      "-d",
      "runtime_restore",
      "--exit-on-error",
      "/tmp/pre-runtime.dump",
    ]);
    const restoreUrl = new URL(container.getConnectionUri());
    restoreUrl.pathname = "/runtime_restore";
    restored = createKysely(restoreUrl.toString());
    expect(
      (
        await sql<{
          name: string;
        }>`SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1`.execute(
          restored,
        )
      ).rows[0]?.name,
    ).toBe("0066_subscription_auto_renewal");
    expect(
      await restored
        .selectFrom("admin_user")
        .select(["id", "status"])
        .where("id", "=", adminId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: adminId, status: "DISABLED" });
    expect(await migrateToLatest(db)).toEqual([
      "0067_admin_cleanup",
      "0068_alert_resource_context",
      "0069_auth_error_evidence",
      "0070_alert_recovery_evidence",
      "0071_enterprise_contact_details",
      "0072_admin_roles_security",
      "0073_credential_chat_probe",
      "0074_runtime_notification_recipients",
      "0075_provider_resource_archive",
      "0076_provider_model_probe",
      "0077_provider_model_probe_run_identity",
      "0078_provider_model_probe_enum_checks",
      "0079_project_allocation_relations",
      "0080_project_allocation_compute",
    ]);
    expect(
      await db
        .selectFrom("admin_user")
        .select("archived_at")
        .where("id", "=", adminId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ archived_at: null });
    await db
      .updateTable("admin_user")
      .set({ archived_at: new Date() })
      .where("id", "=", adminId)
      .execute();
    for (const connection of [db, restored]) {
      expect(
        (
          await sql<{
            created_by: string;
          }>`SELECT created_by FROM principal_accounting_assignment WHERE id=${assignmentId}::uuid`.execute(
            connection,
          )
        ).rows,
      ).toEqual([{ created_by: adminId }]);
    }
    const rollback = await createMigrator(db).migrateTo(
      "0066_subscription_auto_renewal",
    );
    expect(String(rollback.error)).toContain(
      "cannot roll back while archived administrators exist",
    );
    expect(
      (
        await db
          .selectFrom("admin_user")
          .select("archived_at")
          .where("id", "=", adminId)
          .executeTakeFirstOrThrow()
      ).archived_at,
    ).not.toBeNull();
  } finally {
    await restored?.destroy();
    await db.destroy();
    await container.stop();
  }
}, 120_000);
