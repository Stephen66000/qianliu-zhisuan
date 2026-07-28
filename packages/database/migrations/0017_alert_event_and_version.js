/**
 * 迁移 0017：并发版本列 + 额度非负约束 + 告警事实表。
 *
 * P2-01：provider_resource/unified_model/model_route/principal_grant 加单调 version 列，
 *        替代 updated_at 毫秒乐观锁（同毫秒 ABA 窗口）。
 * P2-02：principal_grant.quota_value 加 CHECK 非负（此前可接受负额度）。
 * P1-05：alert_event 告警事实表（独立于 reconciliation_discrepancy），
 *        保存触发/恢复/处置历史；四域八类、状态机、唯一键幂等。
 */
import { sql } from "kysely";

export default {
  async up(db) {
    // ===== P2-01：单调 version 列 =====
    for (const table of ["provider_resource", "unified_model", "model_route", "principal_grant"]) {
      await db.schema
        .alterTable(table)
        .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
        .execute();
    }

    // ===== P2-02：额度非负 =====
    await sql`ALTER TABLE principal_grant ADD CONSTRAINT principal_grant_quota_value_nonneg CHECK (quota_value >= 0)`.execute(db);

    // ===== P1-05：alert_event 告警事实表 =====
    await db.schema
      .createTable("alert_event")
      .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
      .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
      // 稳定派生键（domain:signal:entity），幂等挂载点
      .addColumn("alert_key", "varchar(255)", (c) => c.notNull())
      // 四告警域（PRD §11）
      .addColumn("domain", "varchar(32)", (c) => c.notNull())
      // 八类技术信号（TRD §13）
      .addColumn("signal", "varchar(64)", (c) => c.notNull())
      .addColumn("severity", "varchar(16)", (c) => c.notNull().defaultTo("MEDIUM"))
      .addColumn("title", "varchar(255)", (c) => c.notNull())
      .addColumn("detail", "text")
      .addColumn("resource_id", "uuid")
      .addColumn("principal_id", "uuid")
      .addColumn("ai_request_id", "uuid")
      // 生命周期：OPEN（触发）→ INVESTIGATING → RESOLVED/IGNORED；源恢复 → AUTO_RESOLVED
      .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("OPEN"))
      .addColumn("first_seen_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
      .addColumn("last_seen_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
      .addColumn("resolved_at", "timestamptz")
      .addColumn("resolution_note", "text")
      .addColumn("resolved_by", "uuid")
      .execute();

    // 唯一键：活跃告警按 alert_key 幂等（同 key 只一条 OPEN）
    await sql`CREATE UNIQUE INDEX alert_event_open_key ON alert_event (enterprise_id, alert_key) WHERE status = 'OPEN'`.execute(db);
    await sql`CREATE INDEX alert_event_domain_idx ON alert_event (enterprise_id, domain, status)`.execute(db);
    await sql`ALTER TABLE alert_event ADD CONSTRAINT alert_event_domain_check CHECK (domain IN ('RESOURCE_UNAVAILABLE','USAGE_SPIKE','QUOTA_ANOMALY','CREDENTIAL_INVALID'))`.execute(db);
    await sql`ALTER TABLE alert_event ADD CONSTRAINT alert_event_status_check CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','IGNORED','AUTO_RESOLVED'))`.execute(db);
    await sql`ALTER TABLE alert_event ADD CONSTRAINT alert_event_severity_check CHECK (severity IN ('HIGH','MEDIUM','LOW'))`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("alert_event").execute();
    await sql`ALTER TABLE principal_grant DROP CONSTRAINT IF EXISTS principal_grant_quota_value_nonneg`.execute(db);
    for (const table of ["provider_resource", "unified_model", "model_route", "principal_grant"]) {
      await db.schema.alterTable(table).dropColumn("version").execute();
    }
  },
};
