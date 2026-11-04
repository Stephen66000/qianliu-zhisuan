/**
 * X08 切换演练 T0 准备段（WP6 S4，一次性演练脚本，非测试套件成员）。
 *
 * 职责：在演练专用库（wp6_x08_drill，T2 之前 0092 水位）用【旧基线 ae506fe
 * migrator】迁移到 0092 并播种演练图（单企业/管理员/员工/Key/统一模型/
 * DeepSeek provider（capability_set.base_url 指向本地模拟上游）/API 资源 A、B/
 * CODING_PLAN 资源 P/model_route/billing_rule/grant/strict_writes 运行态）。
 * 全程零期初资金（provider_resource_finance_state 零行），资金四表基线为零
 * （订阅在 T0 由旧栈 HTTP 登记，本脚本不写任何资金行）。
 *
 * 只写本演练专用库（安全门：仅 127.0.0.1 ＋库名 wp6_x08_drill）。
 *
 * 运行（旧 worktree 根，legacy tsx）：
 *   DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55434/wp6_x08_drill \
 *   X08_FIXTURE_OUTPUT=/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/x08-fixture.json \
 *   corepack pnpm@11.11.0 exec tsx \
 *   /Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/x08-prepare.ts
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

// 旧基线（ae506fe）源码绝对路径直引（S3 legacy-read 先例；禁止 bare "@qianliu/*"，
// 否则解析回候选树）。两 worktree 的 provider-adapters src 目录逐字节一致
//（diff -rq 已核），资金/续订仓储也逐字节一致，密钥格式两栈通用。
const LEGACY_ROOT = "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe";
import { createKysely, migrateToLatest } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/index.ts";
import {
  apiKeyPrefix, credentialFingerprint, decodeKek, digestApiKey, encryptCredential, generateApiKey,
} from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/provider-adapters/src/crypto.ts";
import { hashPassword } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/apps/control-api/src/auth/password.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FIXTURE_OUTPUT = process.env.X08_FIXTURE_OUTPUT ?? "";
const KEK_BASE64 = "ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA=";
const PEPPER = "x08-drill-pepper-32bytes-length-ok";
const MOCK_ORIGIN = process.env.X08_MOCK_ORIGIN ?? "http://127.0.0.1:19191";

function assertDedicatedDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || url.pathname !== "/wp6_x08_drill") {
    throw new Error(`拒绝连接非演练专用库：${url.hostname}${url.pathname}`);
  }
}

const db = createKysely(DATABASE_URL);

async function main(): Promise<void> {
  assertDedicatedDatabase(DATABASE_URL);
  const migrated = await migrateToLatest(db);
  const headRows = await (db.selectFrom("kysely_migration" as never) as ReturnType<
    ReturnType<typeof createKysely>["selectFrom"]
  >).select("name").orderBy("name", "desc").limit(1).execute();
  const head = (headRows[0] as { name?: string } | undefined)?.name ?? null;
  if (head !== "0092_employee_monthly_quota") {
    throw new Error(`T0 水位必须是 0092，实际 ${head}`);
  }
  console.log(JSON.stringify({ step: "migrateToLatest(legacy)", executedCount: migrated.length, head }));

  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  const password = "X08-Drill-2026!";
  const passwordHash = await hashPassword(password);
  const kek = decodeKek(KEK_BASE64);

  await db.insertInto("enterprise").values({ id: enterpriseId, name: "WP6 X08 切换演练企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "x08admin",
    display_name: "X08 Admin", password_hash: passwordHash, status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "X08 员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();

  const model = await db.insertInto("unified_model").values({
    enterprise_id: enterpriseId, alias: "qianliu-x08-deepseek",
    display_name: "X08 DeepSeek", status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow();
  const key = generateApiKey();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, PEPPER),
    allowed_model_ids: JSON.stringify([model.id]) as never, status: "ACTIVE",
  }).execute();

  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "X08 DeepSeek",
    adapter_type: "deepseek",
    capability_set: { base_url: `${MOCK_ORIGIN}/v1` } as never,
  }).returning("id").executeTakeFirstOrThrow();

  const apiKeyPlaintext = "sk-x08-synthetic-mock-key";
  const resourceSeed: Array<{ id: string; name: string; mode: "API" | "CODING_PLAN"; credential: string | null }> = [
    { name: "X08 API 资源A（消费/刷新主资源）", mode: "API", credential: apiKeyPlaintext },
    { name: "X08 API 资源B（余额同步 runner 路径）", mode: "API", credential: apiKeyPlaintext },
    { name: "X08 套餐资源P（订阅/续订）", mode: "CODING_PLAN", credential: null },
  ];
  const resources: Record<string, string> = {};
  for (const item of resourceSeed) {
    const id = randomUUID();
    await db.insertInto("provider_resource").values({
      id, enterprise_id: enterpriseId, provider_id: provider.id, name: item.name,
      mode: item.mode,
      credential_type: item.mode === "API" ? "API_KEY" : "SUBSCRIPTION_SESSION",
      credential_ciphertext: item.credential
        ? JSON.stringify(encryptCredential(item.credential, kek)) as never : null,
      credential_fingerprint: item.credential ? credentialFingerprint(item.credential) : null,
      credential_version: item.credential ? 1 : null,
      status: "ACTIVE",
    }).execute();
    resources[item.mode === "CODING_PLAN" ? "planP" : item.name.includes("资源A") ? "apiA" : "apiB"] = id;
  }

  await db.insertInto("model_route").values({
    enterprise_id: enterpriseId, unified_model_id: model.id,
    provider_resource_id: resources.apiA, upstream_model: "deepseek-chat",
  }).execute();
  // 计价：cache_miss 0.000001/1K?——与 gateway billing-rule-fixture 同型（已验证管线
  // 可结算）；成本公式 cost=(input-cache)*0.000001 + output*0（toFixed(8)）。
  await db.insertInto("billing_rule").values({
    enterprise_id: enterpriseId, provider_resource_id: resources.apiA,
    upstream_model: "deepseek-chat", rule_type: "API_PRICE",
    rule_version: "x08-api-price-v1", effective_from: new Date(0),
    cache_miss_price: "0.000001", multiplier: null, priority: 1000,
  }).execute();
  await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId, principal_id: principalId, provider: "deepseek",
    model_alias: "qianliu-x08-deepseek", quota_value: 1_000_000n, quota_basis: "RAW_TOKEN",
  }).execute();

  // 严格写运行态（S3 先例：演练造数直插；仅为了旧栈订阅/静默租约 HTTP 入口可用），
  // 不产生任何 provider_finance_activation_attempt 行。
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: enterpriseId, strict_writes_enabled: true,
    activated_at: new Date("2026-11-04T00:00:00.000Z"), activated_by_admin_user_id: adminId,
  }).execute();

  // 零期初守卫：A/B/P 均不得存在 finance_state 行。
  const financeStates = await db.selectFrom("provider_resource_finance_state")
    .selectAll().where("enterprise_id", "=", enterpriseId).execute();
  if (financeStates.length !== 0) {
    throw new Error(`演练资源出现期初资金行（应为零）：${financeStates.length}`);
  }

  const fixture = {
    generatedAt: new Date().toISOString(),
    legacyRoot: LEGACY_ROOT,
    t0MigrationHead: head,
    databaseUrlHost: new URL(DATABASE_URL).host,
    databaseName: new URL(DATABASE_URL).pathname,
    enterpriseId, adminId, principalId, keyId,
    adminUsername: "x08admin", adminPassword: password,
    apiKey: key, gatewayKeyPepper: PEPPER,
    credentialKekBase64: KEK_BASE64,
    unifiedModelAlias: "qianliu-x08-deepseek",
    unifiedModelId: model.id,
    providerId: provider.id,
    resourceA: resources.apiA, resourceB: resources.apiB, resourceP: resources.planP,
    mockOrigin: MOCK_ORIGIN,
    expectedCosts: {
      "X08-T0-NORMAL": "0.00100000",
      "X08-T1-INFLIGHT": "0.00040000",
      "X08-T4-NEW": "0.00060000",
    },
  };
  writeFileSync(FIXTURE_OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify({ step: "seeded", enterpriseId, resources, fixture: FIXTURE_OUTPUT }));
  await db.destroy();
}

main().catch((error) => {
  console.error("X08_PREPARE_FAILED", error);
  process.exitCode = 1;
});
