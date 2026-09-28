/**
 * 受控验证种子（tasks 6.3）——向隔离 PostgreSQL（siv300-pg，127.0.0.1:55432）做真实迁移 + 种子。
 * 代码候选 30337df 的 migrator 与 schema；不触碰任何生产库。
 * 三个别名各对应上游模式：siv300-model→deepseek-fast，siv300-slow→deepseek-slow，siv300-error→deepseek-error。
 * 生成的北向 API key 写入 logs/api-key.txt（隔离环境专用，非敏感）。
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createKysely } from "../../../../../packages/database/src/kysely.js";
import { migrateToLatest } from "../../../../../packages/database/src/migrator.js";
import { generateApiKey, digestApiKey, apiKeyPrefix } from "../../../../../packages/provider-adapters/src/crypto.js";

const PEPPER = "<redacted-e2e-pepper>";
const BASE_URL = "http://host.docker.internal:9399";

const db = createKysely(process.env.DATABASE_URL!);
const applied = await migrateToLatest(db);
console.log(`migrations_applied=${applied.length} head=${applied.at(-1) ?? "none"}`);

const entId = randomUUID();
const principalId = randomUUID();
const unifiedModelIds: Record<string, string> = {};
const routes: Array<{ alias: string; upstream: string }> = [
  { alias: "siv300-model", upstream: "deepseek-fast" },
  { alias: "siv300-slow", upstream: "deepseek-slow" },
  { alias: "siv300-error", upstream: "deepseek-error" },
];

await db.insertInto("enterprise").values({ id: entId, name: "SIV300 受控验证企业" }).execute();
await db.insertInto("principal").values({ id: principalId, enterprise_id: entId, type: "EMPLOYEE", name: "受控验证主体" }).execute();

for (const r of routes) {
  const m = await db.insertInto("unified_model").values({
    enterprise_id: entId, alias: r.alias, display_name: `SIV300 ${r.alias}`, status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  unifiedModelIds[r.alias] = m.id;
}

const validKey = generateApiKey();
await db.insertInto("principal_key").values({
  enterprise_id: entId, principal_id: principalId,
  key_prefix: apiKeyPrefix(validKey), key_digest: digestApiKey(validKey, PEPPER),
  allowed_model_ids: JSON.stringify(Object.values(unifiedModelIds)) as never,
  status: "ACTIVE",
}).execute();

const provider = await db.insertInto("provider").values({
  enterprise_id: entId, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  capability_set: JSON.stringify({ base_url: BASE_URL }) as never,
}).returningAll().executeTakeFirstOrThrow();

const resource = await db.insertInto("provider_resource").values({
  enterprise_id: entId, provider_id: provider.id, name: "受控验证资源",
  mode: "API", credential_type: "API_KEY", status: "ACTIVE", concurrency_limit: 2,
}).returningAll().executeTakeFirstOrThrow();

for (const r of routes) {
  await db.insertInto("model_route").values({
    enterprise_id: entId, unified_model_id: unifiedModelIds[r.alias]!,
    provider_resource_id: resource.id, upstream_model: r.upstream,
  }).execute();
  await db.insertInto("principal_grant").values({
    enterprise_id: entId, principal_id: principalId, provider: "deepseek",
    model_alias: r.alias, quota_value: 10_000_000n,
  }).execute();
  const priceWindows = JSON.stringify([{
    timezone: "Asia/Shanghai", days_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: "00:00", end_time: "24:00",
  }]) as never;
  await db.insertInto("billing_rule").values({
    enterprise_id: entId, provider_resource_id: resource.id,
    upstream_model: r.upstream, rule_type: "API_PRICE",
    rule_version: "siv300-price-v1", effective_from: new Date(0),
    timezone: "Asia/Shanghai", days_of_week: JSON.stringify([1, 2, 3, 4, 5, 6, 7]) as never,
    start_time: "00:00", end_time: "24:00", time_windows: priceWindows,
    cache_hit_price: "0.000001", cache_miss_price: "0.000002",
    output_price: "0.000004", priority: 10,
  }).execute();
}

const logPath = decodeURIComponent(new URL("../logs/api-key.txt", import.meta.url).pathname);
writeFileSync(logPath, `${validKey}\nENTERPRISE_ID=${entId}\nRESOURCE_ID=${resource.id}\n`);
console.log(`seeded enterprise=${entId} resource=${resource.id} aliases=${routes.map((r) => r.alias).join(",")}`);
console.log(`api_key_written=${logPath}`);
await db.destroy();
