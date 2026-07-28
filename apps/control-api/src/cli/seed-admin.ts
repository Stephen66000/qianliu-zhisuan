#!/usr/bin/env tsx
/**
 * 种子管理员 CLI（E2E / 本地开发前置）—— 创建企业 + 管理员账号。
 *
 * 用法：
 *   DATABASE_URL=postgres://... tsx src/cli/seed-admin.ts \
 *     --enterprise "仟流试点企业" --username admin --password admin123
 *
 * 幂等：同名企业/用户名已存在则复用，不重复创建（返回既有 id）。
 * 安全：密码用 Argon2id 哈希（同 auth/password.ts），绝不打印明文哈希外的信息。
 *
 * 仅用于开发/E2E 库；生产管理员应由正式开通流程创建。
 */
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest } from "@qianliu/database";
import { hashPassword } from "../auth/password.js";

interface Args {
  enterprise: string;
  username: string;
  password: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--enterprise") args.enterprise = value;
    else if (key === "--username") args.username = value;
    else if (key === "--password") args.password = value;
  }
  if (!args.enterprise || !args.username || !args.password) {
    console.error(
      "用法: tsx src/cli/seed-admin.ts --enterprise <名> --username <用户名> --password <密码>",
    );
    process.exit(2);
  }
  return args as Args;
}

async function main(): Promise<void> {
  const { enterprise, username, password } = parseArgs(process.argv);
  const db = createKysely();
  try {
    await migrateToLatest(db);

    // 企业（幂等：按名称复用）
    let ent = await db
      .selectFrom("enterprise")
      .select(["id", "name"])
      .where("name", "=", enterprise)
      .executeTakeFirst();
    if (!ent) {
      ent = await db
        .insertInto("enterprise")
        .values({ id: randomUUID(), name: enterprise })
        .returning(["id", "name"])
        .executeTakeFirstOrThrow();
      console.log(`✓ 创建企业: ${ent.name} (${ent.id})`);
    } else {
      console.log(`= 企业已存在: ${ent.name} (${ent.id})`);
    }

    // 管理员（幂等：按 enterprise_id + username 复用）
    const existing = await db
      .selectFrom("admin_user")
      .select("id")
      .where("enterprise_id", "=", ent.id)
      .where("username", "=", username)
      .executeTakeFirst();
    if (existing) {
      console.log(`= 管理员已存在: ${username} (${existing.id})，未改动密码`);
    } else {
      const passwordHash = await hashPassword(password);
      const admin = await db
        .insertInto("admin_user")
        .values({
          id: randomUUID(),
          enterprise_id: ent.id,
          username,
          password_hash: passwordHash,
          status: "ACTIVE",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      console.log(`✓ 创建管理员: ${username} (${admin.id})，状态 ACTIVE`);
    }

    console.log("\n完成。可用以下凭据登录管理后台 / E2E：");
    console.log(`  用户名: ${username}`);
    console.log(`  密码:   ${password}`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("seed-admin 失败:", err);
  process.exit(1);
});
