import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateToLatest } from "../migrator.js";

// Exercise the exact deployment guard against PostgreSQL, including a real dump restore.
// This is a release compatibility check; business behavior is covered by the I1 recheck.
it("0070 备份可恢复，0071/0072 保留账号和审计引用，新权限或安全策略阻止旧版回退", async () => {
  const container = await new PostgreSqlContainer(
    "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
  )
    .withDatabase("settings_source")
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
    expect(
      (await createMigrator(db).migrateTo("0070_alert_recovery_evidence"))
        .error,
    ).toBeUndefined();
    const enterpriseId = randomUUID();
    const adminIds = [randomUUID(), randomUUID(), randomUUID()];
    const auditId = randomUUID(),
      sessionId = randomUUID();
    await sql`INSERT INTO enterprise (id,name) VALUES (${enterpriseId}::uuid,'部署演练企业')`.execute(
      db,
    );
    for (const [index, id] of adminIds.entries()) {
      await sql`INSERT INTO admin_user (id,enterprise_id,username,password_hash,status,archived_at)
        VALUES (${id}::uuid,${enterpriseId}::uuid,${`admin-${index}`},'test_only_hash',
          ${index === 0 ? "ACTIVE" : "DISABLED"},${index === 2 ? new Date("2026-09-01T00:00:00Z") : null})`.execute(
        db,
      );
    }
    await sql`INSERT INTO operation_log (id,enterprise_id,admin_user_id,action,target_type,result)
      VALUES (${auditId}::uuid,${enterpriseId}::uuid,${adminIds[2]}::uuid,'enterprise.update','enterprise','SUCCESS')`.execute(
      db,
    );
    await sql`INSERT INTO admin_session (id,admin_user_id,token_hash,expires_at)
      VALUES (${sessionId}::uuid,${adminIds[0]}::uuid,'test_only_session_hash',now()+interval '1 hour')`.execute(
      db,
    );
    const oldAdmins = (
      await sql`SELECT id,username,password_hash,status,archived_at FROM admin_user ORDER BY username`.execute(
        db,
      )
    ).rows;
    await command([
      "pg_dump",
      "-U",
      "test_user",
      "-d",
      "settings_source",
      "-Fc",
      "-f",
      "/tmp/pre-settings.dump",
    ]);
    await command(["pg_restore", "-l", "/tmp/pre-settings.dump"]);
    await command(["createdb", "-U", "test_user", "settings_restore"]);
    await command([
      "pg_restore",
      "-U",
      "test_user",
      "-d",
      "settings_restore",
      "--exit-on-error",
      "/tmp/pre-settings.dump",
    ]);
    const restoreUrl = new URL(container.getConnectionUri());
    restoreUrl.pathname = "/settings_restore";
    restored = createKysely(restoreUrl.toString());
    expect(
      (
        await sql<{
          name: string;
        }>`SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1`.execute(
          restored,
        )
      ).rows[0]?.name,
    ).toBe("0070_alert_recovery_evidence");
    expect(await migrateToLatest(db)).toEqual([
      "0071_enterprise_contact_details",
      "0072_admin_roles_security",
    ]);
    for (const connection of [db, restored]) {
      expect(
        (
          await sql`SELECT id,username,password_hash,status,archived_at FROM admin_user ORDER BY username`.execute(
            connection,
          )
        ).rows,
      ).toEqual(oldAdmins);
      expect(
        (
          await sql`SELECT admin_user_id FROM operation_log WHERE id=${auditId}::uuid`.execute(
            connection,
          )
        ).rows,
      ).toEqual([{ admin_user_id: adminIds[2] }]);
      expect(
        (
          await sql`SELECT admin_user_id,token_hash,revoked_at FROM admin_session WHERE id=${sessionId}::uuid`.execute(
            connection,
          )
        ).rows,
      ).toEqual([
        {
          admin_user_id: adminIds[0],
          token_hash: "test_only_session_hash",
          revoked_at: null,
        },
      ]);
    }
    expect(
      (await sql`SELECT DISTINCT role_code FROM admin_user`.execute(db)).rows,
    ).toEqual([{ role_code: "SUPER_ADMIN" }]);
    expect(
      (
        await sql`SELECT management_contact,contact_email,security_version FROM enterprise`.execute(
          db,
        )
      ).rows,
    ).toEqual([
      { management_contact: null, contact_email: null, security_version: 1 },
    ]);
    // Extract the shell's fixed SQL so the DB exercise cannot drift from the release guard.
    const shell = readFileSync(
      new URL(
        "../../../../deploy/scripts/release-system-settings-20260909-mac-mini.sh",
        import.meta.url,
      ),
      "utf8",
    );
    const guardSql = shell.match(
      /settings_count="\$\(db_sql "([^"]+)"\)"/,
    )?.[1];
    expect(guardSql).toBeTruthy();
    const guard = async () =>
      Number(
        Object.values(
          (await sql.raw(guardSql!).execute(db)).rows[0] as Record<
            string,
            unknown
          >,
        )[0],
      );
    expect(await guard()).toBe(0);
    await sql`INSERT INTO admin_role (enterprise_id,name) VALUES (${enterpriseId}::uuid,'只读岗位')`.execute(
      db,
    );
    expect(await guard()).toBe(1);
    await sql`DELETE FROM admin_role`.execute(db);
    await sql`UPDATE admin_user SET role_code='CUSTOM' WHERE id=${adminIds[1]}::uuid`.execute(
      db,
    );
    expect(await guard()).toBe(1);
    await sql`UPDATE admin_user SET role_code='SUPER_ADMIN' WHERE id=${adminIds[1]}::uuid`.execute(
      db,
    );
    await sql`UPDATE enterprise SET security_version=2,session_minutes=60`.execute(
      db,
    );
    expect(await guard()).toBe(1);
  } finally {
    await restored?.destroy();
    await db.destroy();
    await container.stop();
  }
}, 120_000);
