/**
 * M6 DoD 门禁：停用／重置 5 秒内生效（WT-09/14 相关）。
 *
 * M6 DoD（详细计划行 154）：停用／重置 5 秒内生效。
 *
 * 架构查证结论：principal-auth 每次请求直接查 principal_key 表比对 digest，
 * 无 Redis 缓存层（principal-auth.ts 注释「Redis 5 秒 TTL 在 W07 接入」，
 * 实际 W07 未接入）。因此停用／重置同步写 DB 后，下一次请求即时被拒，
 * 实际 0 秒生效，优于 5 秒要求。本测试证明该门禁。
 *
 * 隔离设计：每个测试用独立主体 + Key（不共享可变 DB 状态），
 * 避免用例间顺序依赖；改动只影响该用例自己的主体/Key。
 *
 * 用 Testcontainer PG + 真实 Key + stub pipeline。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { generateApiKey, digestApiKey, apiKeyPrefix } from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { stubPipeline } from "../pipeline/stub-pipeline.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
const ENT_ID = randomUUID();
const PEPPER = "m6-revoke-test-pepper-32bytes!!!";

/** 为单个测试创建独立主体 + Key + 模型，返回主体 id 和明文 Key。 */
async function provision(): Promise<{ principalId: string; key: string; keyRowId: string }> {
  const principalId = randomUUID();
  const key = generateApiKey();
  const keyRowId = randomUUID();
  await db
    .insertInto("principal")
    .values({ id: principalId, enterprise_id: ENT_ID, type: "EMPLOYEE", name: `M6-${principalId.slice(0, 8)}` })
    .execute();
  await db
    .insertInto("principal_key")
    .values({
      id: keyRowId,
      enterprise_id: ENT_ID,
      principal_id: principalId,
      key_prefix: apiKeyPrefix(key),
      key_digest: digestApiKey(key, PEPPER),
      status: "ACTIVE",
    })
    .execute();
  return { principalId, key, keyRowId };
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流 M6 测试" }).execute();
  await db
    .insertInto("unified_model")
    .values({ enterprise_id: ENT_ID, alias: "qianliu-deepseek", display_name: "DS", status: "ACTIVE" })
    .execute();

  app = buildGateway(db, PEPPER, stubPipeline);
  await app.ready();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

function authHeader(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

async function callModels(key: string) {
  return app.inject({ method: "GET", url: "/v1/models", headers: authHeader(key) });
}

describe("M6：停用／重置即时生效门禁（≤5 秒，实际 0 秒）", () => {
  it("基线：有效 Key 可正常访问", async () => {
    const { key } = await provision();
    const res = await callModels(key);
    expect(res.statusCode).toBe(200);
  });

  it("停用主体后，同一 Key 下一次请求即时 401 principal_disabled", async () => {
    const { principalId, key } = await provision();
    // 停用前可访问
    expect((await callModels(key)).statusCode).toBe(200);
    // 同步停用主体（写 DB）
    await db.updateTable("principal").set({ status: "DISABLED" }).where("id", "=", principalId).execute();
    // 下一次请求即时被拒（无缓存，0 秒生效，满足 ≤5 秒）
    const res = await callModels(key);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("principal_disabled");
  });

  it("恢复主体后，同一 Key 立即恢复访问", async () => {
    const { principalId, key } = await provision();
    await db.updateTable("principal").set({ status: "DISABLED" }).where("id", "=", principalId).execute();
    expect((await callModels(key)).statusCode).toBe(401);
    await db.updateTable("principal").set({ status: "ACTIVE" }).where("id", "=", principalId).execute();
    const res = await callModels(key);
    expect(res.statusCode).toBe(200);
  });

  it("撤销 Key（重置）后，旧 Key 下一次请求即时 401 invalid_principal_key", async () => {
    const { key, keyRowId } = await provision();
    expect((await callModels(key)).statusCode).toBe(200);
    // 同步撤销旧 Key（重置语义：旧 Key REVOKED）
    await db.updateTable("principal_key").set({ status: "REVOKED" }).where("id", "=", keyRowId).execute();
    // 下一次请求即时被拒
    const res = await callModels(key);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_principal_key");
  });

  it("重置产生的新 Key 立即生效，旧 Key 仍被拒", async () => {
    const { principalId, key: oldKey, keyRowId } = await provision();
    // 撤销旧 Key，建新 Key（同一主体）
    await db.updateTable("principal_key").set({ status: "REVOKED" }).where("id", "=", keyRowId).execute();
    const newKey = generateApiKey();
    await db
      .insertInto("principal_key")
      .values({
        id: randomUUID(),
        enterprise_id: ENT_ID,
        principal_id: principalId,
        key_prefix: apiKeyPrefix(newKey),
        key_digest: digestApiKey(newKey, PEPPER),
        status: "ACTIVE",
      })
      .execute();
    // 新 Key 立即可用
    expect((await callModels(newKey)).statusCode).toBe(200);
    // 旧 Key 仍被拒
    expect((await callModels(oldKey)).statusCode).toBe(401);
  });
});
