/**
 * POOL-039 前置迁移：单人规则允许保留不可变历史版本。
 *
 * 0039 的 owner 唯一索引把同一主体的所有单人规则版本限制为一行，导致再次保存
 * 只能覆盖已发布版本。0043 将唯一性收敛为“最多一个编辑态 + 最多一个发布态”；
 * DISABLED 历史不占用当前编辑／发布槽位，规则版本仍通过同一 rule_id 追溯。
 */
import { sql } from "kysely";

const LEGACY_INDEX = "employee_model_rule_single_owner_uq";
const EDITABLE_INDEX = "employee_model_rule_single_owner_editable_uq";
const PUBLISHED_INDEX = "employee_model_rule_single_owner_published_uq";
const PUBLISH_REQUEST_HASH = "publish_request_hash";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  const duplicateEditable = await sql`
    SELECT enterprise_id, owner_principal_id, COUNT(*)::int AS count
    FROM employee_model_rule_version
    WHERE owner_principal_id IS NOT NULL
      AND status IN ('DRAFT', 'VALIDATED')
    GROUP BY enterprise_id, owner_principal_id
    HAVING COUNT(*) > 1
  `.execute(db);
  if (duplicateEditable.rows.length > 0) {
    throw new Error(`0043 blocked: multiple editable single-owner versions exist: ${JSON.stringify(duplicateEditable.rows)}`);
  }

  const duplicatePublished = await sql`
    SELECT enterprise_id, owner_principal_id, COUNT(*)::int AS count
    FROM employee_model_rule_version
    WHERE owner_principal_id IS NOT NULL AND status = 'PUBLISHED'
    GROUP BY enterprise_id, owner_principal_id
    HAVING COUNT(*) > 1
  `.execute(db);
  if (duplicatePublished.rows.length > 0) {
    throw new Error(`0043 blocked: multiple published single-owner versions exist: ${JSON.stringify(duplicatePublished.rows)}`);
  }

  await sql`DROP INDEX IF EXISTS ${sql.raw(LEGACY_INDEX)}`.execute(db);
  await sql`
    CREATE UNIQUE INDEX ${sql.raw(EDITABLE_INDEX)}
    ON employee_model_rule_version (enterprise_id, owner_principal_id)
    WHERE owner_principal_id IS NOT NULL AND status IN ('DRAFT', 'VALIDATED')
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX ${sql.raw(PUBLISHED_INDEX)}
    ON employee_model_rule_version (enterprise_id, owner_principal_id)
    WHERE owner_principal_id IS NOT NULL AND status = 'PUBLISHED'
  `.execute(db);
  await db.schema.alterTable("employee_model_rule_version")
    .addColumn(PUBLISH_REQUEST_HASH, "varchar(64)")
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const history = await sql`
    SELECT enterprise_id, owner_principal_id, COUNT(*)::int AS count
    FROM employee_model_rule_version
    WHERE owner_principal_id IS NOT NULL
    GROUP BY enterprise_id, owner_principal_id
    HAVING COUNT(*) > 1
  `.execute(db);
  if (history.rows.length > 0) {
    throw new Error(`0043 rollback blocked: single-owner rule history exists: ${JSON.stringify(history.rows)}`);
  }

  await sql`DROP INDEX IF EXISTS ${sql.raw(PUBLISHED_INDEX)}`.execute(db);
  await sql`DROP INDEX IF EXISTS ${sql.raw(EDITABLE_INDEX)}`.execute(db);
  await sql`
    CREATE UNIQUE INDEX ${sql.raw(LEGACY_INDEX)}
    ON employee_model_rule_version (enterprise_id, owner_principal_id)
    WHERE owner_principal_id IS NOT NULL
  `.execute(db);
  await db.schema.alterTable("employee_model_rule_version")
    .dropColumn(PUBLISH_REQUEST_HASH)
    .execute();
}
