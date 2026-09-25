/**
 * WP08 7.3 激活前静默演练 —— 本地合成企业播种（仅 127.0.0.1 本地一次性容器库）。
 *
 * 三家合成企业：
 *   A = 11111111-...  （复用既有 WP08 合成企业；已具备完整 Gateway admission 链）
 *   B = bbbbbbbb-...  （租约到期 / 剩余不足 / 正向激活）
 *   C = cccccccc-...  （候选 TTL 30 分钟）
 *
 * 会话直接落 `admin_session`（不经登录口令），因此不受多企业登录抖动影响；
 * 仍为每家企业锚定互不相同的 `created_at`。敏感产物只写入
 * /tmp/wp08/quiescence-secrets.json，**不进入证据归档**。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createKysely } from "@qianliu/database";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";

const DB_URL = "postgres://qianliu:qianliu_dev_only@127.0.0.1:5433/qianliu";
const ANCHOR = new Date("2026-01-01T00:00:00.000Z");

const TENANTS = [
  { key: "A", enterpriseId: "11111111-1111-4111-8111-111111111111",
    adminId: "22222222-2222-4222-8222-222222222222", name: "WP08-SYNTHETIC 既有企业", anchor: 0 },
  { key: "B", enterpriseId: "bbbbbbbb-0000-4000-8000-0000000000b1",
    adminId: "bbbbbbbb-1111-4111-8111-0000000000b1", name: "WP08-QUIESCENCE-B", anchor: 1 },
  { key: "C", enterpriseId: "cccccccc-0000-4000-8000-0000000000c1",
    adminId: "cccccccc-1111-4111-8111-0000000000c1", name: "WP08-QUIESCENCE-C", anchor: 2 },
  { key: "D", enterpriseId: "dddddddd-0000-4000-8000-0000000000d1",
    adminId: "dddddddd-1111-4111-8111-0000000000d1", name: "WP08-QUIESCENCE-D", anchor: 3 },
  { key: "E", enterpriseId: "eeeeeeee-0000-4000-8000-0000000000e1",
    adminId: "eeeeeeee-1111-4111-8111-0000000000e1", name: "WP08-QUIESCENCE-E", anchor: 4 },
  { key: "F", enterpriseId: "ffffffff-0000-4000-8000-0000000000f1",
    adminId: "ffffffff-1111-4111-8111-0000000000f1", name: "WP08-QUIESCENCE-F", anchor: 5 },
  // 正向激活池：每次演练取"首个尚未激活"的一家，保证演练可重复、回执一次性。
  { key: "P1", enterpriseId: "aaaaaaaa-0000-4000-8000-0000000000a1",
    adminId: "aaaaaaaa-1111-4111-8111-0000000000a1", name: "WP08-QUIESCENCE-P1", anchor: 10 },
  { key: "P2", enterpriseId: "99999999-0000-4000-8000-000000000091",
    adminId: "99999999-1111-4111-8111-000000000091", name: "WP08-QUIESCENCE-P2", anchor: 11 },
  { key: "P3", enterpriseId: "88888888-0000-4000-8000-000000000081",
    adminId: "88888888-1111-4111-8111-000000000081", name: "WP08-QUIESCENCE-P3", anchor: 12 },
  { key: "P4", enterpriseId: "77777777-0000-4000-8000-000000000071",
    adminId: "77777777-1111-4111-8111-000000000071", name: "WP08-QUIESCENCE-P4", anchor: 13 },
] as const;

async function main(): Promise<void> {
  const db = createKysely(DB_URL);
  const out: Record<string, { enterpriseId: string; adminId: string; cookie: string }> = {};
  try {
    for (const t of TENANTS) {
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
      out[t.key] = {
        enterpriseId: t.enterpriseId, adminId: t.adminId,
        cookie: `qianliu_admin_session=${token}`,
      };
    }
    // 既有 API Key（用于 Gateway 调用）从上一轮播种结果继承。
    const prev = JSON.parse(readFileSync("/tmp/wp08/secrets.json", "utf8")) as {
      apiKey: string; modelAlias: string;
    };
    writeFileSync("/tmp/wp08/quiescence-secrets.json", JSON.stringify({
      note: "WP08 7.3 本地一次性凭证；禁止进入证据归档",
      tenants: out,
      apiKey: prev.apiKey,
      apiKeyEnterpriseId: "11111111-1111-4111-8111-111111111111",
      modelAlias: prev.modelAlias,
      slowModelAlias: "wp08-synthetic-slow",
    }, null, 2));

    console.log(JSON.stringify({
      seeded: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, {
        enterpriseId: v.enterpriseId, adminId: v.adminId, sessionStored: true }])),
      secretsWrittenTo: "/tmp/wp08/quiescence-secrets.json（不入证据）",
    }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("播种失败:", error);
  process.exit(1);
});
