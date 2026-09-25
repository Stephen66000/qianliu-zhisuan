/**
 * WP08 演练会话刷新（仅 127.0.0.1 本地容器库；非生产、非真实业务数据）。
 *
 * 背景：`dual-dark-drill.sh` / `quiescence-drill.sh` 从 `/tmp/wp08/secrets.json` 读取管理员会话 Cookie。
 * 该 Cookie 由 `harness-seed-wp08.ts` 播种，TTL 8 小时。**重跑同一批本地容器库时，旧 Cookie 可能已过期**，
 * 于是所有请求在鉴权层被 401 挡下、根本走不到资金门禁，被 drill 的 classify()（只认门禁体）
 * 误判为「PASSED(未拦)」——这会让 PFA-08 的 P1 断言**假绿**。
 *
 * 本脚本只做一件事：插入一条**新的** `admin_session` 行并把新令牌写回 `/tmp/wp08/secrets.json`
 * 的 `cookie` 字段，**不改动** 既有的 provider / provider_resource / unified_model / model_route /
 * billing_rule / principal / principal_key / principal_grant 链路（那部分由 §4 的本地合成数据承载，
 * 且重跑会撞唯一约束）。敏感产物只写 `/tmp/wp08/secrets.json`，不进入证据归档。
 */
import { readFileSync, writeFileSync } from "node:fs";
// 本脚本位于 V4/Evidence/... 之下，不在 pnpm workspace 的包图内，`@qianliu/*` 裸说明符无法解析；
// 故以仓库内相对路径直接引用 workspace 源码入口（两者的 package.json main 均指向 src/index.ts）。
import { createKysely } from "../../../../../packages/database/src/index.ts";
import {
  digestSessionToken,
  generateSessionToken,
} from "../../../../../packages/provider-adapters/src/index.ts";

const DB_URL = "postgres://qianliu:qianliu_dev_only@127.0.0.1:5433/qianliu";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const SECRETS = "/tmp/wp08/secrets.json";

async function main(): Promise<void> {
  const db = createKysely(DB_URL);
  try {
    const token = generateSessionToken();
    await db.insertInto("admin_session").values({
      admin_user_id: ADMIN_ID,
      token_hash: digestSessionToken(token),
      expires_at: new Date(Date.now() + 8 * 3_600_000),
    }).execute();

    const secrets = JSON.parse(readFileSync(SECRETS, "utf8")) as Record<string, unknown>;
    secrets.cookie = `qianliu_admin_session=${token}`;
    writeFileSync(SECRETS, `${JSON.stringify(secrets, null, 2)}\n`);

    const alive = await db.selectFrom("admin_session")
      .select(({ fn }) => [fn.countAll<number>().as("total")])
      .where("admin_user_id", "=", ADMIN_ID)
      .where("expires_at", ">", new Date())
      .executeTakeFirstOrThrow();
    console.log(JSON.stringify({
      refreshed: { adminId: ADMIN_ID, cookieRewrittenTo: SECRETS, liveSessions: alive.total },
    }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("会话刷新失败:", error);
  process.exit(1);
});
