/**
 * POOL-015 —— 管理员账号与密码生命周期字段。
 *
 * display_name 支持老板账号显示名称修改；must_change_password 强制重置后的首次改密；
 * version 为管理写操作提供单调版本事实。既有管理员保持可登录且无需强制改密。
 */

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("admin_user")
    // 保留数据库层默认值，兼容 seed/运维脚本；正式管理 API 始终要求显式显示名称。
    .addColumn("display_name", "varchar(128)", (c) => c.defaultTo("管理员"))
    .addColumn("must_change_password", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .execute();

  await db
    .updateTable("admin_user")
    .set((eb) => ({ display_name: eb.ref("username") }))
    .where("display_name", "is", null)
    .execute();

  await db.schema
    .alterTable("admin_user")
    .alterColumn("display_name", (c) => c.setNotNull())
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema
    .alterTable("admin_user")
    .dropColumn("version")
    .dropColumn("must_change_password")
    .dropColumn("display_name")
    .execute();
}
