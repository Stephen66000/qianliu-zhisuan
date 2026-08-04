#!/usr/bin/env tsx
/**
 * 生产应急管理员密码重置。只修改精确企业 + 用户名命中的账号，撤销其全部会话并写审计。
 *
 * 用法：
 *   ADMIN_RESET_PASSWORD='强密码' DATABASE_URL='postgres://...' pnpm reset:admin -- \
 *     --enterprise '企业全名' --username admin --confirm admin
 *
 * 密码只从环境变量读取，命令输出和审计日志均不记录明文或哈希。
 */
import {
  AdminRepository,
  AuditRepository,
  createKysely,
} from "@qianliu/database";
import {
  hashPassword,
  isStrongPassword,
  PASSWORD_POLICY_MESSAGE,
} from "../auth/password.js";

interface Args {
  enterprise: string;
  username: string;
  confirm: string;
}

export function parseResetArgs(argv: string[]): Args {
  const values: Partial<Args> = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--enterprise") values.enterprise = value;
    if (key === "--username") values.username = value;
    if (key === "--confirm") values.confirm = value;
  }
  if (!values.enterprise || !values.username || values.confirm !== values.username) {
    throw new Error("参数错误：必须提供 --enterprise、--username，并用 --confirm 重复用户名");
  }
  return values as Args;
}

async function main(): Promise<void> {
  const args = parseResetArgs(process.argv);
  const password = process.env.ADMIN_RESET_PASSWORD ?? "";
  if (!isStrongPassword(password)) throw new Error(PASSWORD_POLICY_MESSAGE);

  const db = createKysely();
  try {
    const enterprise = await db
      .selectFrom("enterprise")
      .select(["id", "name"])
      .where("name", "=", args.enterprise)
      .executeTakeFirst();
    if (!enterprise) throw new Error("未找到完全匹配的企业，未执行任何修改");

    const target = await db
      .selectFrom("admin_user")
      .select(["id", "username"])
      .where("enterprise_id", "=", enterprise.id)
      .where("username", "=", args.username)
      .executeTakeFirst();
    if (!target) throw new Error("当前企业内未找到该管理员，未执行任何修改");

    const adminRepo = new AdminRepository(db);
    const updated = await adminRepo.resetPassword({
      enterpriseId: enterprise.id,
      adminId: target.id,
      newPasswordHash: await hashPassword(password),
    });
    if (!updated) throw new Error("管理员在重置期间发生变化，未完成重置");

    await new AuditRepository(db).write({
      enterprise_id: enterprise.id,
      admin_user_id: target.id,
      action: "admin.password.emergency_reset",
      target_type: "admin_user",
      target_id: target.id,
      change_summary: {
        actor: "production_cli",
        sessions_revoked: true,
        must_change_password: true,
      },
      result: "SUCCESS",
    });
    console.log(`✓ 已重置 ${enterprise.name}/${target.username}，全部会话已撤销，首次登录必须改密`);
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("应急密码重置失败:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
