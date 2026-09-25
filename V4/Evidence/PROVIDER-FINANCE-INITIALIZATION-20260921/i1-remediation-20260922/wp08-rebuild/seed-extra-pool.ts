/**
 * WP08 7.3 正向激活池扩展（仅 127.0.0.1 本地一次性容器库）。
 *
 * 背景：`quiescence-drill.sh` 第 9 节要在**未被任何资金写入触碰过**的企业上跑一次性正向激活
 * （严格写激活不可逆，回执一次性）。原冻结池 P1..P4 已在历次演练中用尽（P1/P2/P3 已激活，
 * P4 在本轮会话的一次无效运行中留下了合成订阅夹具与一条 append-only 资金事件）。
 * `provider_finance_event` 是 append-only（触发器拒绝 DELETE），**不能**通过删除来复原 P4，
 * 也不应通过临时禁用完整性触发器来绕开。
 *
 * 因此本脚本按 `quiescence-seed.ts` 的同一列集合与同一锚点规则，**追加** pristine 企业
 * P5/P6（enterprise + admin_user + admin_session），并以"读改写"方式把新租户合并进
 * `/tmp/wp08/quiescence-secrets.json`——**不触碰**既有 A..F/P1..P4 的 Cookie。
 * `quiescence-seed.ts` 保持逐字节原样（其 md5 与本目录归档件一致）。
 *
 * 敏感产物只写 /tmp/wp08/quiescence-secrets.json，不进入证据归档。
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
const ANCHOR = new Date("2026-01-01T00:00:00.000Z");
const SECRETS = "/tmp/wp08/quiescence-secrets.json";

/** 与 quiescence-seed.ts 的 TENANTS 同一锚点规则（anchor 秒偏移），追加 pristine 池位。 */
const EXTRA = [
  { key: "P5", enterpriseId: "66666666-0000-4000-8000-000000000061",
    adminId: "66666666-1111-4111-8111-000000000061", name: "WP08-QUIESCENCE-P5", anchor: 14 },
  { key: "P6", enterpriseId: "55555555-0000-4000-8000-000000000051",
    adminId: "55555555-1111-4111-8111-000000000051", name: "WP08-QUIESCENCE-P6", anchor: 15 },
] as const;

async function main(): Promise<void> {
  const db = createKysely(DB_URL);
  const created: Record<string, string> = {};
  try {
    const secrets = JSON.parse(readFileSync(SECRETS, "utf8")) as {
      tenants: Record<string, { enterpriseId: string; adminId: string; cookie: string }>;
    };

    for (const t of EXTRA) {
      const at = new Date(ANCHOR.getTime() + t.anchor * 1000);
      const existing = await db.selectFrom("enterprise").select("id")
        .where("id", "=", t.enterpriseId).executeTakeFirst();
      if (!existing) {
        await db.insertInto("enterprise").values({
          id: t.enterpriseId, name: t.name, status: "ACTIVE", timezone: "Asia/Shanghai",
          default_currency: "CNY", created_at: at, updated_at: at,
        }).execute();
      }
      const adminExists = await db.selectFrom("admin_user").select("id")
        .where("id", "=", t.adminId).executeTakeFirst();
      if (!adminExists) {
        await db.insertInto("admin_user").values({
          id: t.adminId, enterprise_id: t.enterpriseId, username: `wp08-${t.key.toLowerCase()}`,
          password_hash: "wp08-local-not-a-real-password-hash", status: "ACTIVE",
          display_name: `WP08 ${t.key} 管理员`, role_code: "SUPER_ADMIN",
          created_at: at, updated_at: at,
        }).execute();
      }

      const token = generateSessionToken();
      await db.insertInto("admin_session").values({
        admin_user_id: t.adminId, token_hash: digestSessionToken(token),
        expires_at: new Date(Date.now() + 8 * 3_600_000),
      }).execute();

      secrets.tenants[t.key] = {
        enterpriseId: t.enterpriseId, adminId: t.adminId,
        cookie: `qianliu_admin_session=${token}`,
      };
      const state = await db.selectFrom("provider_finance_runtime_state").select("enterprise_id")
        .where("enterprise_id", "=", t.enterpriseId).executeTakeFirst();
      created[t.key] = `enterprise=${t.enterpriseId} 未激活=${state === undefined}`;
    }

    writeFileSync(SECRETS, `${JSON.stringify(secrets, null, 2)}\n`);
    console.log(JSON.stringify({
      added: created,
      tenantsNow: Object.keys(secrets.tenants).join(","),
      secretsWrittenTo: "/tmp/wp08/quiescence-secrets.json（不入证据）",
    }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("池扩展失败:", error);
  process.exit(1);
});
