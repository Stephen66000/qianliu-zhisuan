/**
 * P1-05 生命周期补强：区分“管理员已处置但源仍异常”和“源已恢复”。
 *
 * 处置后源仍异常时不得立即重开同 key；只有 source_cleared_at 已记录，
 * 后续再次出现同一信号才视为新一轮告警。
 */
export default {
  async up(db) {
    await db.schema.alterTable("alert_event").addColumn("source_cleared_at", "timestamptz").execute();
  },

  async down(db) {
    await db.schema.alterTable("alert_event").dropColumn("source_cleared_at").execute();
  },
};
