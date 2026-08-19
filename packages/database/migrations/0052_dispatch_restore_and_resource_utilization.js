/**
 * POOL20-037/041：调度版本并发约束与资源利用月查询索引。
 * 升级新增恢复来源列与索引，不回写历史行；若同一历史源已有多个活动恢复则
 * fail-closed，先对账再升级。回退删除本迁移列与索引，不改写策略、账本或经营快照。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.alterTable("dispatch_policy")
    .addColumn("restore_source_policy_id", "uuid", (column) => column.references("dispatch_policy.id"))
    .execute();
  await sql`
    CREATE UNIQUE INDEX dispatch_policy_active_restore_unique_idx
        ON dispatch_policy (enterprise_id, restore_source_policy_id)
     WHERE restore_source_policy_id IS NOT NULL AND status = 'PUBLISHED'
  `.execute(db);
  await sql`
    CREATE INDEX ledger_line_resource_month_cover_idx
        ON ledger_line (enterprise_id, provider_resource_id, created_at)
        INCLUDE (ai_request_id, raw_input_tokens, raw_output_tokens, api_cost, deducted_quota)
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("ledger_line_resource_month_cover_idx").ifExists().execute();
  await db.schema.dropIndex("dispatch_policy_active_restore_unique_idx").ifExists().execute();
  await db.schema.alterTable("dispatch_policy").dropColumn("restore_source_policy_id").execute();
}
