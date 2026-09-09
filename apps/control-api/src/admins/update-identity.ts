import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { AdminContext } from "../server.js";
export async function updateAdminIdentity(app: FastifyInstance, actor: AdminContext, id: string,
  body: { display_name: string; role_code?: "SUPER_ADMIN" | "CUSTOM"; expected_version?: number }) {
  return app.db.transaction().execute(async trx => {
    await trx.selectFrom("enterprise").select("id").where("id", "=", actor.enterpriseId).forUpdate().execute();
    const before = await trx.selectFrom("admin_user").selectAll().where("enterprise_id", "=", actor.enterpriseId)
      .where("id", "=", id).where("archived_at", "is", null).forUpdate().executeTakeFirst();
    if (!before) return { admin: undefined };
    if (body.expected_version !== undefined && body.expected_version !== before.version) return { error: "账号已被修改，请刷新" };
    if (body.role_code === "CUSTOM") {
      if (!await trx.selectFrom("admin_role").select("enterprise_id").where("enterprise_id", "=", actor.enterpriseId).executeTakeFirst()) return { error: "请先保存自定义岗位" };
      const count = await trx.selectFrom("admin_user").select("id").where("enterprise_id", "=", actor.enterpriseId)
        .where("role_code", "=", "SUPER_ADMIN").where("status", "=", "ACTIVE").where("archived_at", "is", null).execute();
      if (before.role_code === "SUPER_ADMIN" && before.status === "ACTIVE" && count.length <= 1) return { error: "必须保留至少一个有效超级管理员" };
    }
    const admin = await trx.updateTable("admin_user").set({ display_name: body.display_name,
      role_code: body.role_code ?? before.role_code, version: sql<number>`version + 1`, updated_at: new Date() })
      .where("id", "=", id).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto("operation_log").values({ enterprise_id: actor.enterpriseId, admin_user_id: actor.adminUserId,
      actor_source: "ADMIN", action: "admin.identity.update", target_type: "admin_user", target_id: id, result: "SUCCESS",
      change_summary: { before: { display_name: before.display_name, role_code: before.role_code },
        after: { display_name: admin.display_name, role_code: admin.role_code } } }).execute();
    return { admin };
  });
}
