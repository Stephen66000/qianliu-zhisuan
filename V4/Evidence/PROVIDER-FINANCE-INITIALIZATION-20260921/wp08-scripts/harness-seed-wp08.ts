/**
 * WP08 本地合成企业播种（仅 127.0.0.1 本地容器库；非生产、非真实业务数据）。
 *
 * 目的：让 7.2/7.3 能在**运行中的候选容器**上做真实 HTTP 演练：
 *   - 一条可用的管理员会话（用于观察 DARK 写入门禁与静默期读接口保留）；
 *   - 一条完整的 Gateway admission 链（provider → resource → unified_model →
 *     model_route → billing_rule → principal_key → principal_grant），
 *     使模型调用能真正走到"上游"——而上游被钉死为本地 stub。
 *
 * 敏感产物（会话令牌、API Key、KEK）只写入 /tmp/wp08/secrets.json，**不进入证据归档**。
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "kysely";
import { createKysely } from "@qianliu/database";
import {
  apiKeyPrefix,
  decodeKek,
  digestApiKey,
  digestSessionToken,
  encryptCredential,
  generateApiKey,
  generateSessionToken,
} from "@qianliu/provider-adapters";

// 注意：compose 的 environment 块用 `${POSTGRES_PASSWORD:-...}` 从**宿主 shell**插值，
// 而非 env_file，故本地容器实际口令为仓库文档化的开发默认值（仅回环监听）。
const DB_URL = "postgres://qianliu:qianliu_dev_only@127.0.0.1:5433/qianliu";
const ENTERPRISE_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const DEEPSEEK_PROVIDER_ID = "55555555-5555-4555-8555-555555555555";
const API_RESOURCE_ID = "66666666-6666-4666-8666-666666666666";
const STUB_BASE_URL = "http://stub-upstream:9299/v1";
const MODEL_ALIAS = "wp08-synthetic-deepseek";

function envFrom(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function main(): Promise<void> {
  const env = envFrom("/tmp/wp08/local.env");
  const kek = decodeKek(readFileSync("/tmp/wp08/kek.txt", "utf8").trim());
  const pepper = env.GATEWAY_KEY_PEPPER!;
  const db = createKysely(DB_URL);
  try {
    // ---- 1) 管理员会话（直接落库；等价于会话存储，不经过登录口令） ----
    const token = generateSessionToken();
    await db.insertInto("admin_session").values({
      admin_user_id: ADMIN_ID,
      token_hash: digestSessionToken(token),
      expires_at: new Date(Date.now() + 8 * 3_600_000),
    }).execute();

    // ---- 2) Provider 上游地址钉死到本地 stub（含模式专属端点） ----
    await db.updateTable("provider")
      .set({ capability_set: JSON.stringify({ base_url: STUB_BASE_URL, endpoints: { API: "chat/completions" } }) as never })
      .where("id", "=", DEEPSEEK_PROVIDER_ID).execute();

    // ---- 3) API 资源：写入以候选 KEK 加密的一次性本地凭证 + 并发上限 ----
    const credential = encryptCredential("wp08-local-only-not-a-real-vendor-key", kek);
    await db.updateTable("provider_resource")
      .set({ status: "ACTIVE", concurrency_limit: 4, credential_ciphertext: JSON.stringify(credential) })
      .where("id", "=", API_RESOURCE_ID).execute();

    // ---- 4) 统一模型 + 路由 + 计费规则 ----
    const modelId = (await db.insertInto("unified_model").values({
      enterprise_id: ENTERPRISE_ID, alias: MODEL_ALIAS, display_name: "WP08 合成模型", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("model_route").values({
      enterprise_id: ENTERPRISE_ID, unified_model_id: modelId,
      provider_resource_id: API_RESOURCE_ID, upstream_model: "deepseek-chat", enabled: true,
    }).execute();
    await db.insertInto("billing_rule").values({
      enterprise_id: ENTERPRISE_ID, provider_resource_id: API_RESOURCE_ID,
      upstream_model: "deepseek-chat", rule_type: "API_PRICE", rule_version: "wp08-local",
      effective_from: new Date(0), cache_miss_price: "0.000001",
    }).execute();

    // ---- 5) 主体 + API Key + 授权 ----
    const principalId = randomUUID();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: ENTERPRISE_ID, type: "EMPLOYEE", name: "WP08 合成调用者",
      department_label: null, person_id: null, owner_person_id: null,
    }).execute();
    const apiKey = generateApiKey();
    await db.insertInto("principal_key").values({
      enterprise_id: ENTERPRISE_ID, principal_id: principalId,
      key_prefix: apiKeyPrefix(apiKey), key_digest: digestApiKey(apiKey, pepper),
      allowed_model_ids: JSON.stringify([modelId]) as unknown as string[],
      status: "ACTIVE", expires_at: null,
    }).execute();
    await db.insertInto("principal_grant").values({
      enterprise_id: ENTERPRISE_ID, principal_id: principalId, provider: "deepseek",
      model_alias: MODEL_ALIAS, quota_value: 1_000_000n, status: "ACTIVE",
    }).execute();

    writeFileSync("/tmp/wp08/secrets.json", JSON.stringify({
      note: "WP08 本地一次性凭证；禁止进入证据归档",
      cookie: `qianliu_admin_session=${token}`,
      apiKey,
      modelAlias: MODEL_ALIAS,
      principalId,
      modelId,
    }, null, 2));

    // ---- 非敏感摘要（可入证据） ----
    const counts = await sql<{ enterprise: string; principal_key: string; model_route: string; billing_rule: string }>`
      SELECT (SELECT count(*) FROM enterprise)::text AS enterprise,
             (SELECT count(*) FROM principal_key)::text AS principal_key,
             (SELECT count(*) FROM model_route)::text AS model_route,
             (SELECT count(*) FROM billing_rule)::text AS billing_rule`.execute(db);
    console.log(JSON.stringify({
      seeded: {
        enterpriseId: ENTERPRISE_ID, adminId: ADMIN_ID,
        provider: "deepseek", apiResourceId: API_RESOURCE_ID,
        upstreamBaseUrl: STUB_BASE_URL, modelAlias: MODEL_ALIAS,
        credentialEncrypted: true, sessionStored: true, apiKeyStored: true,
      },
      counts: counts.rows[0],
      secretsWrittenTo: "/tmp/wp08/secrets.json（不入证据）",
    }, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("播种失败:", error);
  process.exit(1);
});
