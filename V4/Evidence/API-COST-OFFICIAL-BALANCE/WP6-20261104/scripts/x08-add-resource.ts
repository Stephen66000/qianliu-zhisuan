/**
 * X08 切换窗口资源登记（T3 段，证据脚本）：在候选栈 schema（0096 水位）上
 * 新登记一台 API 资源 C（零同步尝试），供 T4 新 worker 官方余额同步 runner
 * 路径验证。演练夹具操作（pg 直插，非业务端点）：旧栈“每日一次”同步门禁
 * 已覆盖资源 A/B 的节奏（next_sync_at=T0+24h），资源 C 是 runner 路径的
 * 干净目标。凭证为合成值，仅指向本地模拟上游。
 *
 * 运行（候选 worktree 根）：
 *   DATABASE_URL=... X08_FIXTURE=... corepack pnpm@11.11.0 exec tsx \
 *   V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/x08-add-resource.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pgClient from "../../../../../packages/database/node_modules/pg/lib/index.js";
import { decodeKek, encryptCredential, credentialFingerprint } from "../../../../../packages/provider-adapters/src/crypto.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const url = new URL(DATABASE_URL);
if ((url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || url.pathname !== "/wp6_x08_drill") {
  throw new Error(`拒绝连接非演练专用库：${url.hostname}${url.pathname}`);
}
const fixture = JSON.parse(readFileSync(process.env.X08_FIXTURE ?? "", "utf8")) as {
  enterpriseId: string; providerId: string; credentialKekBase64: string;
};
const client = new pgClient.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  const id = randomUUID();
  await client.query(
    "INSERT INTO provider_resource (id, enterprise_id, provider_id, name, mode, credential_type,"
    + " credential_ciphertext, credential_fingerprint, credential_version, status)"
    + " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [id, fixture.enterpriseId, fixture.providerId, "X08 API 资源C（切换窗口登记，runner 同步路径）",
     "API", "API_KEY",
     JSON.stringify(encryptCredential("sk-x08-synthetic-mock-key", decodeKek(fixture.credentialKekBase64))),
     credentialFingerprint("sk-x08-synthetic-mock-key"), 1, "ACTIVE"],
  );
  console.log(JSON.stringify({ resourceC: id }));
} finally {
  await client.end();
}
