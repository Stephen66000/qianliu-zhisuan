/**
 * P1-02：计价规则管理写闭环使用单调 version 乐观锁。
 */
export default {
  async up(db) {
    await db.schema
      .alterTable("billing_rule")
      .addColumn("version", "integer", (col) => col.notNull().defaultTo(1))
      .execute();
  },

  async down(db) {
    await db.schema.alterTable("billing_rule").dropColumn("version").execute();
  },
};
