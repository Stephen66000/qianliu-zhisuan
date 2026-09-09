/** Recovery must have positive evidence; retain historical flags without inventing proof. */
export async function up(db) {
  await db.schema
    .alterTable("alert_event")
    .addColumn("recovery_evidence", "jsonb")
    .execute();
}
export async function down(db) {
  const found = await db
    .selectFrom("alert_event")
    .select("id")
    .where("recovery_evidence", "is not", null)
    .limit(1)
    .executeTakeFirst();
  if (found) throw new Error("0070 rollback blocked: recovery evidence exists");
  await db.schema
    .alterTable("alert_event")
    .dropColumn("recovery_evidence")
    .execute();
}
