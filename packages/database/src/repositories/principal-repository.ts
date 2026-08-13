/**
 * Principal 仓储 —— 员工/项目统一主体的 CRUD（W02）。
 *
 * 依据：TRD §5.2。enterprise_id 贯穿所有查询。
 * 停用语义：status=DISABLED；停用时上层应同步撤销 Key（W03）。
 */
import { sql, type Kysely, type Selectable } from "kysely";
import type { Database, PrincipalTable } from "../kysely.js";

export type Principal = Selectable<PrincipalTable>;

export class PrincipalNotActiveError extends Error {
  constructor() {
    super("principal is disabled or archived");
    this.name = "PrincipalNotActiveError";
  }
}

export interface CreatePrincipalInput {
  enterprise_id: string;
  type: "EMPLOYEE" | "PROJECT";
  name: string;
  department_label?: string | null;
}

export interface UpdatePrincipalInput {
  name?: string;
  department_label?: string | null;
  status?: "ACTIVE" | "DISABLED";
}

export interface PrincipalCleanupPreview {
  keyCount: number;
  activeKeyCount: number;
  grantCount: number;
  activeGrantCount: number;
  requestCount: number;
  usageCount: number;
  ledgerCount: number;
  employeeLoginCount: number;
  authorizationRuleAssignmentCount: number;
  canDelete: boolean;
}

export interface PrincipalDeactivationResult {
  principal: Principal;
  revokedKeyCount: number;
  disabledGrantCount: number;
}

export interface PrincipalLifecycleAudit {
  adminUserId: string;
}

export type PrincipalDeleteResult =
  | {
      deleted: true;
      removedKeyCount: number;
      removedGrantCount: number;
    }
  | {
      deleted: false;
      preview: PrincipalCleanupPreview;
    };

interface PrincipalQueryOptions {
  type?: "EMPLOYEE" | "PROJECT";
  archived?: "exclude" | "only" | "all";
  search?: string;
  limit?: number;
  offset?: number;
}

export class PrincipalRepository {
  constructor(private db: Kysely<Database>) {}

  async list(
    enterpriseId: string,
    opts?: PrincipalQueryOptions,
  ): Promise<Principal[]> {
    let q = this.db.selectFrom("principal").selectAll().where("enterprise_id", "=", enterpriseId);
    if (opts?.type) q = q.where("type", "=", opts.type);
    if (opts?.archived === "only") q = q.where("archived_at", "is not", null);
    else if (opts?.archived !== "all") q = q.where("archived_at", "is", null);
    const search = opts?.search?.trim();
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      q = q.where(sql<boolean>`(
        name ILIKE ${pattern} ESCAPE '\\'
        OR coalesce(department_label, '') ILIKE ${pattern} ESCAPE '\\'
      )`);
    }
    q = q.orderBy("created_at", "desc").orderBy("id", "desc");
    if (opts?.limit !== undefined) q = q.limit(opts.limit);
    if (opts?.offset !== undefined) q = q.offset(opts.offset);
    return q.execute();
  }

  async count(
    enterpriseId: string,
    opts?: Omit<PrincipalQueryOptions, "limit" | "offset">,
  ): Promise<number> {
    let q = this.db.selectFrom("principal")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("enterprise_id", "=", enterpriseId);
    if (opts?.type) q = q.where("type", "=", opts.type);
    if (opts?.archived === "only") q = q.where("archived_at", "is not", null);
    else if (opts?.archived !== "all") q = q.where("archived_at", "is", null);
    const search = opts?.search?.trim();
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      q = q.where(sql<boolean>`(
        name ILIKE ${pattern} ESCAPE '\\'
        OR coalesce(department_label, '') ILIKE ${pattern} ESCAPE '\\'
      )`);
    }
    const result = await q.executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async findById(enterpriseId: string, id: string): Promise<Principal | undefined> {
    return this.db
      .selectFrom("principal")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async create(input: CreatePrincipalInput): Promise<Principal> {
    return this.db
      .insertInto("principal")
      .values({
        enterprise_id: input.enterprise_id,
        type: input.type,
        name: input.name,
        department_label: input.department_label ?? null,
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(enterpriseId: string, id: string, input: UpdatePrincipalInput): Promise<Principal> {
    return this.db
      .updateTable("principal")
      .set({ ...input, updated_at: new Date() })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** 软停用：status=DISABLED。不删除（历史保留，PRD §6.4 L188）。 */
  async disable(enterpriseId: string, id: string): Promise<Principal> {
    return this.update(enterpriseId, id, { status: "DISABLED" });
  }

  async reactivate(enterpriseId: string, id: string): Promise<Principal> {
    return this.update(enterpriseId, id, { status: "ACTIVE" });
  }

  /**
   * 停用/归档必须在同一事务内撤销有效 Key 与 Grant，避免出现主体已停用但授权仍可用。
   */
  async deactivate(
    enterpriseId: string,
    id: string,
    archive: boolean,
    audit?: PrincipalLifecycleAudit,
  ): Promise<PrincipalDeactivationResult | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("principal")
        .selectAll()
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) return undefined;

      const now = new Date();
      const revokedKeys = await trx
        .updateTable("principal_key")
        .set({ status: "REVOKED", revoked_at: now })
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", id)
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();
      const disabledGrants = await trx
        .updateTable("principal_grant")
        .set({
          status: "DISABLED",
          updated_at: now,
          version: sql`version + 1`,
        })
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", id)
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();
      const principal = await trx
        .updateTable("principal")
        .set({
          status: "DISABLED",
          ...(archive ? { archived_at: now } : {}),
          updated_at: now,
        })
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();

      if (audit) {
        if (!archive) {
          await this.insertAudit(trx, enterpriseId, audit.adminUserId, {
            action: "key.revoke_on_disable",
            targetId: id,
            changeSummary: { revoked_keys: Number(revokedKeys?.numUpdatedRows ?? 0) },
          });
          await this.insertAudit(trx, enterpriseId, audit.adminUserId, {
            action: "grant.disable_on_disable",
            targetId: id,
            changeSummary: { disabled_grants: Number(disabledGrants?.numUpdatedRows ?? 0) },
          });
        }
        await this.insertAudit(trx, enterpriseId, audit.adminUserId, {
          action: archive ? "principal.archive" : "principal.disable",
          targetId: id,
          changeSummary: archive
            ? {
                archived_at: principal.archived_at,
                revoked_keys: Number(revokedKeys?.numUpdatedRows ?? 0),
                disabled_grants: Number(disabledGrants?.numUpdatedRows ?? 0),
                history_retained: true,
              }
            : {
                before: { status: existing.status },
                after: { status: principal.status },
                revoked_keys: Number(revokedKeys?.numUpdatedRows ?? 0),
                disabled_grants: Number(disabledGrants?.numUpdatedRows ?? 0),
              },
        });
      }

      return {
        principal,
        revokedKeyCount: Number(revokedKeys?.numUpdatedRows ?? 0),
        disabledGrantCount: Number(disabledGrants?.numUpdatedRows ?? 0),
      };
    });
  }

  async cleanupPreview(
    enterpriseId: string,
    id: string,
  ): Promise<PrincipalCleanupPreview | undefined> {
    const principal = await this.findById(enterpriseId, id);
    if (!principal) return undefined;
    return this.readCleanupPreview(this.db, enterpriseId, id);
  }

  /**
   * 无请求/Usage/账本/登录引用时才物理删除；Key、Grant 属于可清理配置，
   * 在事务内先撤销再移除。历史引用存在时返回 preview，由上层引导归档。
   */
  async deleteSafely(
    enterpriseId: string,
    id: string,
    audit?: PrincipalLifecycleAudit,
  ): Promise<PrincipalDeleteResult | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const principal = await trx
        .selectFrom("principal")
        .select(["id"])
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!principal) return undefined;

      const preview = await this.readCleanupPreview(trx, enterpriseId, id);
      if (!preview.canDelete) return { deleted: false, preview };

      const now = new Date();
      await trx
        .updateTable("principal_key")
        .set({ status: "REVOKED", revoked_at: now })
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", id)
        .where("status", "=", "ACTIVE")
        .execute();
      await trx
        .updateTable("principal_grant")
        .set({ status: "DISABLED", updated_at: now, version: sql`version + 1` })
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", id)
        .where("status", "=", "ACTIVE")
        .execute();
      await trx
        .deleteFrom("quota_counter")
        .where(
          "grant_id",
          "in",
          trx
            .selectFrom("principal_grant")
            .select("id")
            .where("enterprise_id", "=", enterpriseId)
            .where("principal_id", "=", id),
        )
        .execute();
      await trx
        .deleteFrom("principal_grant")
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", id)
        .execute();
      await trx
        .deleteFrom("principal_key")
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", id)
        .execute();
      await trx
        .deleteFrom("principal_model_manual_authorization")
        .where("enterprise_id", "=", enterpriseId)
        .where("principal_id", "=", id)
        .execute();
      await trx
        .deleteFrom("principal")
        .where("enterprise_id", "=", enterpriseId)
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

      if (audit) {
        await this.insertAudit(trx, enterpriseId, audit.adminUserId, {
          action: "principal.delete",
          targetId: id,
          changeSummary: {
            removed_keys: preview.keyCount,
            removed_grants: preview.grantCount,
            historical_data: false,
          },
        });
      }

      return {
        deleted: true,
        removedKeyCount: preview.keyCount,
        removedGrantCount: preview.grantCount,
      };
    });
  }

  private async readCleanupPreview(
    db: Kysely<Database>,
    enterpriseId: string,
    id: string,
  ): Promise<PrincipalCleanupPreview> {
    const queryResult = await sql<{
      key_count: string;
      active_key_count: string;
      grant_count: string;
      active_grant_count: string;
      request_count: string;
      usage_count: string;
      ledger_count: string;
      employee_login_count: string;
      authorization_rule_assignment_count: string;
    }>`
      SELECT
        (SELECT count(*) FROM principal_key
          WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid) AS key_count,
        (SELECT count(*) FROM principal_key
          WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid
            AND status = 'ACTIVE') AS active_key_count,
        (SELECT count(*) FROM principal_grant
          WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid) AS grant_count,
        (SELECT count(*) FROM principal_grant
          WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid
            AND status = 'ACTIVE') AS active_grant_count,
        (SELECT count(*) FROM ai_request
          WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid) AS request_count,
        (SELECT count(*) FROM usage_event ue
          JOIN upstream_attempt ua ON ua.id = ue.upstream_attempt_id
          JOIN ai_request ar ON ar.id = ua.ai_request_id
          WHERE ar.enterprise_id = ${enterpriseId}::uuid AND ar.principal_id = ${id}::uuid) AS usage_count,
        ((SELECT count(*) FROM ledger_line
          WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid) +
         (SELECT count(*) FROM ledger_transaction
          WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid)) AS ledger_count,
        (SELECT count(*) FROM employee_login
          WHERE principal_id = ${id}::uuid) AS employee_login_count,
        (SELECT count(*) FROM employee_model_rule_assignment
          WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid)
          AS authorization_rule_assignment_count
    `.execute(db);
    const result = queryResult.rows[0];
    if (!result) throw new Error("principal cleanup preview query returned no row");
    const preview = {
      keyCount: Number(result.key_count),
      activeKeyCount: Number(result.active_key_count),
      grantCount: Number(result.grant_count),
      activeGrantCount: Number(result.active_grant_count),
      requestCount: Number(result.request_count),
      usageCount: Number(result.usage_count),
      ledgerCount: Number(result.ledger_count),
      employeeLoginCount: Number(result.employee_login_count),
      authorizationRuleAssignmentCount: Number(result.authorization_rule_assignment_count),
      canDelete: false,
    };
    preview.canDelete =
      preview.requestCount === 0 &&
      preview.usageCount === 0 &&
      preview.ledgerCount === 0 &&
      preview.employeeLoginCount === 0 &&
      preview.authorizationRuleAssignmentCount === 0;
    return preview;
  }

  private async insertAudit(
    db: Kysely<Database>,
    enterpriseId: string,
    adminUserId: string,
    input: {
      action: string;
      targetId: string;
      changeSummary: Record<string, unknown>;
    },
  ): Promise<void> {
    await db
      .insertInto("operation_log")
      .values({
        enterprise_id: enterpriseId,
        admin_user_id: adminUserId,
        action: input.action,
        target_type: "principal",
        target_id: input.targetId,
        change_summary: input.changeSummary,
        result: "SUCCESS",
        failure_reason: null,
      })
      .execute();
  }
}
