/**
 * 迁移 0001 —— 企业、管理员、管理员会话、员工登录账号（W02）。
 *
 * 依据：TRD §5.1（enterprise/admin_user/admin_session/employee_login）、§14.1（认证）。
 * 一期只有一个企业，所有管理员权限相同（TRD §5.1 L176）。
 * enterprise_id 贯穿约束（TRD §2.1 L69）从这里开始落地。
 */
/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // enterprise：企业（一期单企业）
  await db.schema
    .createTable("enterprise")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("name", "varchar(255)", (c) => c.notNull())
    .addColumn("status", "varchar(32)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();

  // admin_user：管理员（所有权限相同，一期不建角色层级）
  await db.schema
    .createTable("admin_user")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("username", "varchar(128)", (c) => c.notNull())
    .addColumn("password_hash", "text", (c) => c.notNull()) // Argon2id
    .addColumn("status", "varchar(32)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  // 同企业内 username 唯一
  await db.schema
    .createIndex("admin_user_enterprise_username_idx")
    .ifNotExists()
    .on("admin_user")
    .columns(["enterprise_id", "username"])
    .unique()
    .execute();

  // admin_session：管理员会话（DB session + 不透明 Cookie，TRD §5.1 L174）
  await db.schema
    .createTable("admin_session")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("admin_user_id", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("token_hash", "text", (c) => c.notNull()) // 不存明文 token，存 SHA-256 摘要
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await db.schema
    .createIndex("admin_session_token_hash_idx")
    .ifNotExists()
    .on("admin_session")
    .column("token_hash")
    .unique()
    .execute();

  // employee_login：员工登录账号（项目无此表；员工登录仟流 IDE 用）
  // must_change_password：员工首次登录必须改密码（TRD §14.1 L773）
  await db.schema
    .createTable("employee_login")
    .ifNotExists()
    .addColumn("principal_id", "uuid", (c) => c.notNull()) // FK 在 0002 迁移后补
    .addColumn("username", "varchar(128)", (c) => c.notNull())
    .addColumn("password_hash", "text", (c) => c.notNull())
    .addColumn("must_change_password", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await db.schema
    .createIndex("employee_login_username_idx")
    .ifNotExists()
    .on("employee_login")
    .column("username")
    .unique()
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("employee_login").ifExists().execute();
  await db.schema.dropTable("admin_session").ifExists().execute();
  await db.schema.dropTable("admin_user").ifExists().execute();
  await db.schema.dropTable("enterprise").ifExists().execute();
}
