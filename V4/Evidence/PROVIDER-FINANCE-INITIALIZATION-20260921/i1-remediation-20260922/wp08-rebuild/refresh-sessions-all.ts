/**
 * WP08 演练会话批量刷新（仅 127.0.0.1 本地一次性容器库；非生产、非真实业务数据）。
 *
 * 背景：`dual-dark-drill.sh`（PFA-08）读 `/tmp/wp08/secrets.json` 的单一管理员 Cookie；
 * `quiescence-drill.sh`（PFA-09）读 `/tmp/wp08/quiescence-secrets.json` 里 A/B/C/D/E/F/P1..P4
 * 各企业的管理员 Cookie。两者均由 `harness-seed-wp08.ts` 以 8 小时 TTL 播种。
 * **重跑同一批本地容器库时旧 Cookie 早已过期**：
 *   * PFA-08 的写入口在被鉴权层 401 挡下后，响应体不含门禁串，drill 的 classify() 会误判为
 *     「PASSED(未拦)」 —— 假绿；
 *   * PFA-09 的控制面写入探针会整体 401，断言大面积 FAIL。
 * 本脚本为每个管理员各插入一条**新的** admin_session 行，并把新令牌逐项写回对应机密文件。
 * 只动 admin_session 与会话 Cookie 字段，不触碰 provider / resource / principal / 资金事实链路。
 * 敏感产物只写 /tmp/wp08/*.json，不进入证据归档。
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
const TTL_MS = 8 * 3_600_000;
/** PFA-08 的单一管理员（与 harness-seed-wp08.ts 播种的一致）。 */
const SINGLE_ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const SINGLE_SECRETS = "/tmp/wp08/secrets.json";
const QUIESCENCE_SECRETS = "/tmp/wp08/quiescence-secrets.json";

type Kysely = ReturnType<typeof createKysely>;

async function issue(db: Kysely, adminId: string): Promise<string> {
  const token = generateSessionToken();
  await db.insertInto("admin_session").values({
    admin_user_id: adminId,
    token_hash: digestSessionToken(token),
    expires_at: new Date(Date.now() + TTL_MS),
  }).execute();
  return `qianliu_admin_session=${token}`;
}

async function liveCount(db: Kysely, adminId: string): Promise<number> {
  const row = await db.selectFrom("admin_session")
    .select(({ fn }) => [fn.countAll<number>().as("total")])
    .where("admin_user_id", "=", adminId)
    .where("expires_at", ">", new Date())
    .executeTakeFirstOrThrow();
  return row.total;
}

async function main(): Promise<void> {
  const db = createKysely(DB_URL);
  try {
    const report: Record<string, string> = {};

    // 1) PFA-08：单管理员
    const single = JSON.parse(readFileSync(SINGLE_SECRETS, "utf8")) as Record<string, unknown>;
    const singleAdmin = typeof single.adminId === "string" ? single.adminId : SINGLE_ADMIN_ID;
    single.cookie = await issue(db, singleAdmin);
    writeFileSync(SINGLE_SECRETS, `${JSON.stringify(single, null, 2)}\n`);
    report["PFA-08 secrets.json"] = `admin=${singleAdmin} liveSessions=${await liveCount(db, singleAdmin)}`;

    // 2) PFA-09：逐租户
    const q = JSON.parse(readFileSync(QUIESCENCE_SECRETS, "utf8")) as {
      tenants: Record<string, { adminId: string; cookie: string }>;
    };
    const perTenant: string[] = [];
    for (const [key, tenant] of Object.entries(q.tenants)) {
      tenant.cookie = await issue(db, tenant.adminId);
      perTenant.push(`${key}(live=${await liveCount(db, tenant.adminId)})`);
    }
    writeFileSync(QUIESCENCE_SECRETS, `${JSON.stringify(q, null, 2)}\n`);
    report["PFA-09 quiescence-secrets.json"] = perTenant.join(" ");

    console.log(JSON.stringify({ refreshed: report }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("会话批量刷新失败:", error);
  process.exit(1);
});
