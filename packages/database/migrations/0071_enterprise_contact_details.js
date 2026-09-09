/**
 * 企业信息补充管理联系人与联系邮箱。
 *
 * 两个字段均允许为空；一旦写入真实数据，回退会拒绝丢弃这些信息。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("enterprise")
    .addColumn("management_contact", "varchar(128)")
    .addColumn("contact_email", "varchar(320)")
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const result = await sql`
    SELECT COUNT(*)::text AS count
      FROM enterprise
     WHERE management_contact IS NOT NULL OR contact_email IS NOT NULL
  `.execute(db);
  if (BigInt(result.rows[0]?.count ?? "0") > 0n) {
    throw new Error(
      "0071 down refused: enterprise contact details already contain data",
    );
  }
  await db.schema
    .alterTable("enterprise")
    .dropColumn("contact_email")
    .dropColumn("management_contact")
    .execute();
}
