/**
 * 迁移 0093 —— billing_rule 价格依据状态（ACE-02 场景 3 / WP0 P6）。
 *
 * 依据：OpenSpec change simplify-api-cost-and-official-balance（specs/api-cost-estimation
 * ACE-02「配置价格缺少官方来源」、WP0 contracts.md §1 C1 price_basis.source_status、
 * WP0 notes/inv-b.md §1、WP1 plan.md §4 决策 1）。
 *
 * 设计（总指挥已定决策，S1 合同 §3.1）：
 *   - billing_rule 新列 source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'，
 *     CHECK ∈ ('VERIFIED','UNVERIFIED')；
 *   - 存量规则默认 UNVERIFIED（不得宣称为已核实官方价）；
 *   - 既有 source 列（0011，自由文本「规则来源」描述）语义＝来源描述 ≠ 核实状态，保留不动；
 *   - down：drop column（纯加列，可无差别回滚）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    ALTER TABLE billing_rule
      ADD COLUMN source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED',
      ADD CONSTRAINT billing_rule_source_status_check
        CHECK (source_status IN ('VERIFIED','UNVERIFIED'));
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    ALTER TABLE billing_rule
      DROP CONSTRAINT IF EXISTS billing_rule_source_status_check,
      DROP COLUMN IF EXISTS source_status;
  `.execute(db);
}
