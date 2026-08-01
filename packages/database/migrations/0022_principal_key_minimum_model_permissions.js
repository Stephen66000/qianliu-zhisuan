/**
 * POOL-002：Principal Key 模型权限改为最小权限缺省。
 *
 * 向前兼容：
 * - 历史 allowed_model_ids IS NULL 曾表示“企业全部 ACTIVE 模型”，迁移时把当时
 *   本企业全部 ACTIVE 模型 ID 冻结为显式数组，保持已有权限且未来新增模型不自动授权；
 * - 新记录数据库缺省同样为 []，并通过 NOT NULL 阻止应用遗漏后重新引入全模型语义。
 *
 * 回滚限制：
 * - down 只移除 NOT NULL 和 DEFAULT；
 * - 无法判断迁移前哪些 NULL 是有意“全部模型”，不会把 [] 自动恢复为 NULL，
 *   避免回滚时静默扩大权限。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    UPDATE principal_key AS principal_key_row
       SET allowed_model_ids = COALESCE(
         (
           SELECT jsonb_agg(unified_model.id ORDER BY unified_model.id)
             FROM unified_model
            WHERE unified_model.enterprise_id = principal_key_row.enterprise_id
              AND unified_model.status = 'ACTIVE'
         ),
         '[]'::jsonb
       )
     WHERE principal_key_row.allowed_model_ids IS NULL
  `.execute(db);

  await sql`
    ALTER TABLE principal_key
      ALTER COLUMN allowed_model_ids SET DEFAULT '[]'::jsonb,
      ALTER COLUMN allowed_model_ids SET NOT NULL
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    ALTER TABLE principal_key
      ALTER COLUMN allowed_model_ids DROP NOT NULL,
      ALTER COLUMN allowed_model_ids DROP DEFAULT
  `.execute(db);
}
