/** POOL-028：冻结请求发生时的标准 Agent 身份事实。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.alterTable("ai_request")
    .addColumn("agent_family", "varchar(32)", (c) => c.notNull().defaultTo("UNKNOWN"))
    .addColumn("agent_version", "varchar(32)")
    .addColumn("agent_identity_source", "varchar(32)", (c) => c.notNull().defaultTo("NONE"))
    .addColumn("agent_identity_confidence", "varchar(24)", (c) => c.notNull().defaultTo("UNKNOWN"))
    .addColumn("client_identity_rule_version", "varchar(32)", (c) => c.notNull().defaultTo("legacy"))
    .execute();
  await sql`ALTER TABLE ai_request ADD CONSTRAINT ai_request_agent_family_check CHECK (agent_family IN ('WORKBUDDY','CODEX','ZCODE','CLAUDE_CODE','QIANLIU_IDE','OTHER','UNKNOWN'))`.execute(db);
  await db.schema.createIndex("ai_request_enterprise_agent_idx")
    .on("ai_request").columns(["enterprise_id", "agent_family", "started_at"]).execute();
  await db.schema.createTable("principal_agent_expectation")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("agent_family", "varchar(32)", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("principal_agent_expectation_unique", ["enterprise_id", "principal_id", "agent_family"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("principal_agent_expectation").ifExists().execute();
  await db.schema.dropIndex("ai_request_enterprise_agent_idx").ifExists().execute();
  await db.schema.alterTable("ai_request")
    .dropColumn("client_identity_rule_version")
    .dropColumn("agent_identity_confidence")
    .dropColumn("agent_identity_source")
    .dropColumn("agent_version")
    .dropColumn("agent_family")
    .execute();
}
