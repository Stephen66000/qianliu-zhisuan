/**
 * 迁移 0016：扩展 reconciliation_discrepancy.discrepancy_type 的 CHECK 约束，
 * 允许 W20 异常告警四域值（派生告警的处置记录复用本表状态机）。
 *
 * 背景（W20）：PRD §11 四告警域（RESOURCE_UNAVAILABLE/USAGE_SPIKE/QUOTA_ANOMALY/
 * CREDENTIAL_INVALID）的"标记已处理"复用 discrepancy 的 OPEN/INVESTIGATING/RESOLVED/
 * IGNORED 状态机。原 CHECK 只允许 5 个对账类型，告警域值 insert 会被拒绝。
 */
import { sql } from "kysely";

export default {
  async up(db) {
    await sql`ALTER TABLE reconciliation_discrepancy DROP CONSTRAINT reconciliation_discrepancy_type_check`.execute(
      db,
    );
    await sql`ALTER TABLE reconciliation_discrepancy ADD CONSTRAINT reconciliation_discrepancy_type_check CHECK (discrepancy_type IN (
      'DUPLICATE_USAGE','MISSING_LEDGER_LINE','MISSING_USAGE','ORPHAN_LEDGER_LINE','SETTLEMENT_MISMATCH',
      'RESOURCE_UNAVAILABLE','USAGE_SPIKE','QUOTA_ANOMALY','CREDENTIAL_INVALID'
    ))`.execute(db);
  },

  async down(db) {
    // 回滚前需清除告警域行，否则恢复原 CHECK 会失败
    await sql`DELETE FROM reconciliation_discrepancy WHERE discrepancy_type IN ('RESOURCE_UNAVAILABLE','USAGE_SPIKE','QUOTA_ANOMALY','CREDENTIAL_INVALID')`.execute(
      db,
    );
    await sql`ALTER TABLE reconciliation_discrepancy DROP CONSTRAINT reconciliation_discrepancy_type_check`.execute(
      db,
    );
    await sql`ALTER TABLE reconciliation_discrepancy ADD CONSTRAINT reconciliation_discrepancy_type_check CHECK (discrepancy_type IN (
      'DUPLICATE_USAGE','MISSING_LEDGER_LINE','MISSING_USAGE','ORPHAN_LEDGER_LINE','SETTLEMENT_MISMATCH'
    ))`.execute(db);
  },
};
