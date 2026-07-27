/**
 * 管理员与会话仓储（W02）。
 *
 * 依据：TRD §5.1（admin_user/admin_session）、§14.1（认证）。
 * Session 使用不透明 token：DB 存 SHA-256(token) 摘要，Cookie 存明文 token。
 */
import type { Kysely, Selectable } from "kysely";
import type { Database, AdminUserTable, AdminSessionTable } from "../kysely.js";

export type AdminUser = Selectable<AdminUserTable>;
export type AdminSession = Selectable<AdminSessionTable>;

export class AdminRepository {
  constructor(private db: Kysely<Database>) {}

  async findByUsername(enterpriseId: string, username: string): Promise<AdminUser | undefined> {
    return this.db
      .selectFrom("admin_user")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("username", "=", username)
      .executeTakeFirst();
  }

  async findById(id: string): Promise<AdminUser | undefined> {
    return this.db.selectFrom("admin_user").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async create(enterpriseId: string, username: string, passwordHash: string): Promise<AdminUser> {
    return this.db
      .insertInto("admin_user")
      .values({ enterprise_id: enterpriseId, username, password_hash: passwordHash, status: "ACTIVE" })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** 创建 session；tokenHash = SHA-256(明文 token)。 */
  async createSession(
    adminUserId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<AdminSession> {
    return this.db
      .insertInto("admin_session")
      .values({ admin_user_id: adminUserId, token_hash: tokenHash, expires_at: expiresAt })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** 找到有效 session 并附带管理员信息（扁平字段）。 */
  async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<
    | {
        session_id: string;
        admin_user_id: string;
        admin_id: string;
        admin_enterprise_id: string;
        admin_username: string;
        admin_status: string;
      }
    | undefined
  > {
    return this.db
      .selectFrom("admin_session")
      .innerJoin("admin_user as admin", "admin.id", "admin_session.admin_user_id")
      .select([
        "admin_session.id as session_id",
        "admin_session.admin_user_id as admin_user_id",
        "admin.id as admin_id",
        "admin.enterprise_id as admin_enterprise_id",
        "admin.username as admin_username",
        "admin.status as admin_status",
      ])
      .where("admin_session.token_hash", "=", tokenHash)
      .where("admin_session.revoked_at", "is", null)
      .where("admin_session.expires_at", ">", new Date())
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
