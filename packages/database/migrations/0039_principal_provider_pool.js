/** POOL-033：主体×厂商额度池与接入配置统一。
 *
 * 背景：029 把额度挂在"规则/型号"粒度，且存在三条平行写入路径。本条把额度归集
 * 升级为"主体×厂商"池，规则退化为型号准入开关；并收编手工直写路径。
 *
 * 变更：
 *  1. principal_grant 增加 pool_model_alias 列：'*' 表示该行是"主体×厂商"池
 *     （model_alias 同步写 '*'）；NULL 表示旧的型号级手工 Grant（仅过渡/识别用）。
 *  2. 每主体每厂商至多一个 ACTIVE 池：部分唯一索引。
 *  3. employee_model_rule_version.quota_value 放宽为允许 NULL（非空仍须 >= 0）：
 *     新版本写 NULL 表示额度不在规则上；旧版本数值仅用于回放。
 *  4. 存量手工 Grant（authorization_rule_version_id IS NULL）按 (enterprise,
 *     principal, provider) 一对一升格为池。现状每组至多一条；若防御性检查发现
 *     同组多条 ACTIVE 手工 Grant，迁移报错并列出清单，人工确认后处理，不自动合并。
 *  5. principal_access_idempotency：编排端点幂等存档表。
 *  6. principal_access_config_state：单主体配置乐观锁版本（config_version）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // ===== 1. pool_model_alias 列 =====
  await db.schema.alterTable("principal_grant")
    .addColumn("pool_model_alias", "varchar(64)")
    .execute();

  // ===== 2. 每主体每厂商至多一个 ACTIVE 池 =====
  await sql`
    CREATE UNIQUE INDEX principal_grant_pool_uq
    ON principal_grant (enterprise_id, principal_id, provider)
    WHERE pool_model_alias = '*' AND status = 'ACTIVE'
  `.execute(db);

  // ===== 3. 规则版本额度放宽为可空（新版本不再承载额度） =====
  await sql`ALTER TABLE employee_model_rule_version ALTER COLUMN quota_value DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE employee_model_rule_version DROP CONSTRAINT IF EXISTS employee_model_rule_quota_check`.execute(db);
  await sql`ALTER TABLE employee_model_rule_version ADD CONSTRAINT employee_model_rule_quota_check CHECK (quota_value IS NULL OR quota_value >= 0)`.execute(db);

  // ===== 4. 存量手工 Grant 升格为池 =====
  // 防御性检查：同组多条 ACTIVE 手工 Grant 不自动合并，迁移中止并列出清单。
  const multiManual = await sql`
    SELECT enterprise_id, principal_id, provider, COUNT(*) AS cnt
    FROM principal_grant
    WHERE authorization_rule_version_id IS NULL AND status = 'ACTIVE'
    GROUP BY enterprise_id, principal_id, provider
    HAVING COUNT(*) > 1
  `.execute(db);
  if (multiManual.rows.length > 0) {
    const detail = multiManual.rows
      .map((row) => `enterprise=${row.enterprise_id} principal=${row.principal_id} provider=${row.provider} count=${row.cnt}`)
      .join("; ");
    throw new Error(`0039 blocked: multiple ACTIVE manual grants per (enterprise, principal, provider); manual review required: ${detail}`);
  }
  // 一对一升格：该组唯一的手工 Grant 成为池行。额度、已用量、账本原样平移。
  await sql`
    UPDATE principal_grant
    SET pool_model_alias = '*', model_alias = '*', updated_at = now()
    WHERE authorization_rule_version_id IS NULL AND status = 'ACTIVE'
  `.execute(db);

  // ===== 5. 编排端点幂等存档表 =====
  await db.schema.createTable("principal_access_idempotency")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_hash", "varchar(64)", (c) => c.notNull())
    .addColumn("response_snapshot", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("principal_access_idempotency_pk", [
      "enterprise_id", "principal_id", "idempotency_key",
    ])
    .execute();

  // ===== 6. 单主体配置乐观锁版本表 =====
  await db.schema.createTable("principal_access_config_state")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("config_version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("principal_access_config_state_pk", [
      "enterprise_id", "principal_id",
    ])
    .execute();

  // ===== 7. 单人规则归属列（决策点①）：每主体至多一条单人规则 =====
  await db.schema.alterTable("employee_model_rule_version")
    .addColumn("owner_principal_id", "uuid")
    .execute();
  await sql`
    CREATE UNIQUE INDEX employee_model_rule_single_owner_uq
    ON employee_model_rule_version (enterprise_id, owner_principal_id)
    WHERE owner_principal_id IS NOT NULL
  `.execute(db);
  await db.schema.alterTable("employee_model_rule_version")
    .addForeignKeyConstraint(
      "employee_model_rule_version_owner_principal_fk",
      ["owner_principal_id"],
      "principal",
      ["id"],
    )
    .execute();

  // ===== 8. 显式禁用型号清单（决策点④：新型号自动并入，掐型号走显式清单） =====
  // 准入判定 = 厂商池 ACTIVE AND 型号不在本清单；新接入型号默认无禁用行 → 可用。
  await db.schema.createTable("principal_provider_disabled_model")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("provider", "varchar(32)", (c) => c.notNull())
    .addColumn("unified_model_id", "uuid", (c) => c.notNull().references("unified_model.id"))
    .addColumn("disabled_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("disable_rule_version_id", "uuid")
    .addPrimaryKeyConstraint("principal_provider_disabled_model_pk", [
      "enterprise_id", "principal_id", "provider", "unified_model_id",
    ])
    .execute();
  await db.schema.alterTable("principal_provider_disabled_model")
    .addForeignKeyConstraint(
      "principal_provider_disabled_model_rule_fk",
      ["disable_rule_version_id"],
      "employee_model_rule_version",
      ["id"],
    )
    .execute();
  await db.schema.createIndex("principal_provider_disabled_model_lookup_idx")
    .on("principal_provider_disabled_model")
    .columns(["enterprise_id", "principal_id", "provider", "unified_model_id"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  // 已产生池数据后禁止破坏性回滚：池 Grant 的账本与计数器不可重建。
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM principal_grant WHERE pool_model_alias = '*' LIMIT 1) THEN
        RAISE EXCEPTION '0039 rollback blocked: provider pool data exists';
      END IF;
    END $$
  `.execute(db);

  await db.schema.dropTable("principal_provider_disabled_model").ifExists().execute();

  await db.schema.alterTable("employee_model_rule_version")
    .dropConstraint("employee_model_rule_version_owner_principal_fk")
    .execute();
  await sql`DROP INDEX IF EXISTS employee_model_rule_single_owner_uq`.execute(db);
  await db.schema.alterTable("employee_model_rule_version")
    .dropColumn("owner_principal_id")
    .execute();

  await db.schema.dropTable("principal_access_config_state").ifExists().execute();
  await db.schema.dropTable("principal_access_idempotency").ifExists().execute();

  // 恢复规则额度约束（需先清掉 NULL，但上面已阻止有池数据时回滚，此处仅为对称）。
  await sql`ALTER TABLE employee_model_rule_version DROP CONSTRAINT IF EXISTS employee_model_rule_quota_check`.execute(db);
  await sql`ALTER TABLE employee_model_rule_version ALTER COLUMN quota_value SET NOT NULL`.execute(db);
  await sql`ALTER TABLE employee_model_rule_version ADD CONSTRAINT employee_model_rule_quota_check CHECK (quota_value >= 0)`.execute(db);

  await sql`DROP INDEX IF EXISTS principal_grant_pool_uq`.execute(db);
  await db.schema.alterTable("principal_grant")
    .dropColumn("pool_model_alias")
    .execute();
}
