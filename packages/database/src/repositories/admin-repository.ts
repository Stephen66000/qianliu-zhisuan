/**
 * 管理员与会话仓储（W02）。
 *
 * 依据：TRD §5.1（admin_user/admin_session）、§14.1（认证）。
 * Session 使用不透明 token：DB 存 SHA-256(token) 摘要，Cookie 存明文 token。
 */
import { sql, type Kysely, type Selectable } from "kysely";
import type { Database, AdminUserTable, AdminSessionTable } from "../kysely.js";

export type AdminUser = Selectable<AdminUserTable>;
export type AdminSession = Selectable<AdminSessionTable>;

export class AdminRepository {
  constructor(private db: Kysely<Database>) {}

  async findByUsername(
    enterpriseId: string,
    username: string,
  ): Promise<AdminUser | undefined> {
    return this.db
      .selectFrom("admin_user")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("username", "=", username)
      .where("archived_at", "is", null)
      .executeTakeFirst();
  }

  async findById(id: string): Promise<AdminUser | undefined> {
    return this.db
      .selectFrom("admin_user")
      .selectAll()
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .executeTakeFirst();
  }

  async findByIdForEnterprise(
    enterpriseId: string,
    id: string,
  ): Promise<AdminUser | undefined> {
    return this.db
      .selectFrom("admin_user")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .executeTakeFirst();
  }

  async listByEnterprise(enterpriseId: string, archived = false): Promise<AdminUser[]> {
    return this.db
      .selectFrom("admin_user")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("archived_at", archived ? "is not" : "is", null)
      .orderBy("created_at", "asc")
      .execute();
  }

  async create(
    enterpriseId: string,
    username: string,
    passwordHash: string,
  ): Promise<AdminUser> {
    return this.db
      .insertInto("admin_user")
      .values({
        enterprise_id: enterpriseId,
        username,
        password_hash: passwordHash,
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async createManaged(input: {
    enterpriseId: string;
    username: string;
    displayName: string;
    passwordHash: string;
    roleCode?: "SUPER_ADMIN" | "CUSTOM";
  }): Promise<AdminUser> {
    const enterprise = await this.db.selectFrom("enterprise").select("force_initial_password_change")
      .where("id", "=", input.enterpriseId).executeTakeFirstOrThrow();
    return this.db
      .insertInto("admin_user")
      .values({
        enterprise_id: input.enterpriseId,
        username: input.username,
        display_name: input.displayName,
        password_hash: input.passwordHash,
        must_change_password: enterprise.force_initial_password_change,
        role_code: input.roleCode ?? "SUPER_ADMIN",
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateDisplayName(
    enterpriseId: string,
    id: string,
    displayName: string,
  ): Promise<AdminUser | undefined> {
    return this.db
      .updateTable("admin_user")
      .set({
        display_name: displayName,
        updated_at: new Date(),
        version: sql<number>`version + 1`,
      })
      .where("enterprise_id", "=", enterpriseId)
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .returningAll()
      .executeTakeFirst();
  }

  async changeOwnPassword(input: {
    enterpriseId: string;
    adminId: string;
    previousPasswordHash: string;
    newPasswordHash: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable("admin_user")
        .set({
          password_hash: input.newPasswordHash,
          must_change_password: false,
          updated_at: new Date(),
          version: sql<number>`version + 1`,
        })
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.adminId)
        .where("archived_at", "is", null)
        .where("password_hash", "=", input.previousPasswordHash)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) return false;
      await trx
        .updateTable("admin_session")
        .set({ revoked_at: new Date() })
        .where("admin_user_id", "=", input.adminId)
        .where("revoked_at", "is", null)
        .execute();
      return true;
    });
  }

  async resetPassword(input: {
    enterpriseId: string;
    adminId: string;
    newPasswordHash: string;
  }): Promise<AdminUser | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const enterprise = await trx.selectFrom("enterprise").select("force_initial_password_change")
        .where("id", "=", input.enterpriseId).executeTakeFirstOrThrow();
      const updated = await trx
        .updateTable("admin_user")
        .set({
          password_hash: input.newPasswordHash,
          must_change_password: enterprise.force_initial_password_change,
          updated_at: new Date(),
          version: sql<number>`version + 1`,
        })
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.adminId)
        .where("archived_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      if (!updated) return undefined;
      await trx
        .updateTable("admin_session")
        .set({ revoked_at: new Date() })
        .where("admin_user_id", "=", input.adminId)
        .where("revoked_at", "is", null)
        .execute();
      return updated;
    });
  }

  async setStatus(input: {
    enterpriseId: string;
    actorAdminId: string;
    targetAdminId: string;
    status: "ACTIVE" | "DISABLED";
  }): Promise<AdminUser> {
    return this.db.transaction().execute(async (trx) => {
      await trx.selectFrom("enterprise").select("id").where("id", "=", input.enterpriseId).forUpdate().execute();
      const target = await trx
        .selectFrom("admin_user")
        .selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.targetAdminId)
        .where("archived_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw new AdminNotFoundError();
      if (input.status === "DISABLED") {
        if (input.actorAdminId === input.targetAdminId)
          throw new SelfDisableError();
        const activeAdmins = await trx
          .selectFrom("admin_user")
          .select("id")
          .where("enterprise_id", "=", input.enterpriseId)
          .where("status", "=", "ACTIVE")
          .where("role_code", "=", "SUPER_ADMIN")
          .where("archived_at", "is", null)
          .forUpdate()
          .execute();
        if (target.role_code === "SUPER_ADMIN" && activeAdmins.length <= 1) throw new LastActiveAdminError();
      }
      if (target.status === input.status) return target;
      const updated = await trx
        .updateTable("admin_user")
        .set({
          status: input.status,
          updated_at: new Date(),
          version: sql<number>`version + 1`,
        })
        .where("id", "=", target.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (input.status === "DISABLED") {
        await trx
          .updateTable("admin_session")
          .set({ revoked_at: new Date() })
          .where("admin_user_id", "=", target.id)
          .where("revoked_at", "is", null)
          .execute();
      }
      return updated;
    });
  }

  /**
   * 清理已停用管理员：归档账号并撤销会话，保留被审计/经营事实引用的身份行。
   */
  async cleanup(input: {
    enterpriseId: string;
    actorAdminId: string;
    targetAdminId: string;
  }): Promise<AdminUser> {
    return this.db.transaction().execute(async (trx) => {
      const target = await trx
        .selectFrom("admin_user")
        .selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("id", "=", input.targetAdminId)
        .where("archived_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw new AdminNotFoundError();
      if (input.actorAdminId === target.id) throw new SelfCleanupError();
      if (target.status !== "DISABLED") throw new AdminMustBeDisabledError();

      const archivedAt = new Date();
      const archived = await trx
        .updateTable("admin_user")
        .set({
          archived_at: archivedAt,
          updated_at: archivedAt,
          version: sql<number>`version + 1`,
        })
        .where("id", "=", target.id)
        .where("archived_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      if (!archived) throw new AdminNotFoundError();

      await trx
        .updateTable("admin_session")
        .set({ revoked_at: archivedAt })
        .where("admin_user_id", "=", target.id)
        .where("revoked_at", "is", null)
        .execute();
      await trx
        .insertInto("operation_log")
        .values({
          enterprise_id: input.enterpriseId,
          admin_user_id: input.actorAdminId,
          action: "admin.cleanup",
          actor_source: "ADMIN",
          target_type: "admin_user",
          target_id: target.id,
          change_summary: {
            username: target.username,
            status: target.status,
            archived_at: archivedAt.toISOString(),
            sessions_revoked: true,
          },
          result: "SUCCESS",
        })
        .executeTakeFirstOrThrow();
      return archived;
    });
  }

  /** 创建 session；tokenHash = SHA-256(明文 token)。 */
  async createSession(
    adminUserId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<AdminSession> {
    return this.db
      .insertInto("admin_session")
      .values({
        admin_user_id: adminUserId,
        token_hash: tokenHash,
        expires_at: expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** 找到有效 session 并附带管理员信息（扁平字段）。 */
  async findSessionByTokenHash(tokenHash: string): Promise<
    | {
        session_id: string;
        admin_user_id: string;
        admin_id: string;
        admin_enterprise_id: string;
        admin_username: string;
        admin_display_name: string;
        admin_must_change_password: boolean;
        admin_status: string;
      }
    | undefined
  > {
    return this.db
      .selectFrom("admin_session")
      .innerJoin(
        "admin_user as admin",
        "admin.id",
        "admin_session.admin_user_id",
      )
      .select([
        "admin_session.id as session_id",
        "admin_session.admin_user_id as admin_user_id",
        "admin.id as admin_id",
        "admin.enterprise_id as admin_enterprise_id",
        "admin.username as admin_username",
        "admin.display_name as admin_display_name",
        "admin.must_change_password as admin_must_change_password",
        "admin.status as admin_status",
      ])
      .where("admin_session.token_hash", "=", tokenHash)
      .where("admin_session.revoked_at", "is", null)
      .where("admin_session.expires_at", ">", new Date())
      .where("admin.archived_at", "is", null)
      .executeTakeFirst();
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.db
      .updateTable("admin_session")
      .set({ revoked_at: new Date() })
      .where("token_hash", "=", tokenHash)
      .execute();
  }
}

export class AdminNotFoundError extends Error {
  constructor() {
    super("管理员不存在");
    this.name = "AdminNotFoundError";
  }
}

export class SelfDisableError extends Error {
  constructor() {
    super("不能停用当前登录管理员");
    this.name = "SelfDisableError";
  }
}

export class LastActiveAdminError extends Error {
  constructor() {
    super("不能停用最后一个有效管理员");
    this.name = "LastActiveAdminError";
  }
}

export class SelfCleanupError extends Error {
  constructor() {
    super("不能清理当前登录管理员");
    this.name = "SelfCleanupError";
  }
}

export class AdminMustBeDisabledError extends Error {
  constructor() {
    super("管理员必须先停用才能清理");
    this.name = "AdminMustBeDisabledError";
  }
}
