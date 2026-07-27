/**
 * 迁移 0002 —— 使用主体 principal（员工/项目统一表，W02）。
 *
 * 依据：TRD §5.2（principal 统一表，type EMPLOYEE/PROJECT）。
 * enterprise_id 贯穿；员工和项目复用同一套 Key/额度/计量（TRD §5.2 L192）。
 * 补 employee_login.principal_id 的 FK。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("principal")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("type", "varchar(16)", (c) => c.notNull()) // EMPLOYEE | PROJECT
    .addColumn("name", "varchar(255)", (c) => c.notNull())
    .addColumn("department_label", "varchar(255)") // 员工可选信息；项目为 null
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE")) // ACTIVE | DISABLED
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  // CHECK 约束：type 与 status 枚举（Kysely schema builder 不直接支持，用 sql）
  await sql`ALTER TABLE principal ADD CONSTRAINT principal_type_check CHECK (type IN ('EMPLOYEE', 'PROJECT'))`.execute(
    db,
  );
  await sql`ALTER TABLE principal ADD CONSTRAINT principal_status_check CHECK (status IN ('ACTIVE', 'DISABLED'))`.execute(
    db,
  );

  // 补 employee_login → principal 的 FK
  await db.schema
    .alterTable("employee_login")
    .addForeignKeyConstraint(
      "employee_login_principal_fk",
      ["principal_id"],
      "principal",
      ["id"],
    )
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema
    .alterTable("employee_login")
    .dropConstraint("employee_login_principal_fk")
    .execute();
  await db.schema.dropTable("principal").ifExists().execute();
}
