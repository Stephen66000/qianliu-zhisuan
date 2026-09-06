/** 每个测试文件独立建立企业、数据库和登录会话。 */
import { beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
export let db: Database;
export let app: FastifyInstance;
export let adminCookie: string;

const TEST_PASSWORD = "W19-Test-Password!";
export const ENT_ID = randomUUID();
export const ADM_ID = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流 W19 测试企业" }).execute();
  const hash = await hashPassword(TEST_PASSWORD);
  await db
    .insertInto("admin_user")
    .values({ id: ADM_ID, enterprise_id: ENT_ID, username: "admin", password_hash: hash, status: "ACTIVE" })
    .execute();

  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();

  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "admin", password: TEST_PASSWORD },
  });
  const setCookie = loginRes.headers["set-cookie"];
  adminCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

/** provider 按 code 复用（provider 表 UNIQUE(enterprise_id, code)，重复 insert 会撞唯一约束）。 */
async function ensureProvider(code: "deepseek" | "zhipu" | "kimi") {
  const existing = await db
    .selectFrom("provider")
    .selectAll()
    .where("enterprise_id", "=", ENT_ID)
    .where("code", "=", code)
    .executeTakeFirst();
  if (existing) return existing;
  return db
    .insertInto("provider")
    .values({ enterprise_id: ENT_ID, code, name: `${code} 测试`, adapter_type: code })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function seedProviderResource(status = "ACTIVE", mode: "API" | "CODING_PLAN" = "API") {
  const provider = await ensureProvider("zhipu");
  const resource = await db
    .insertInto("provider_resource")
    .values({
      enterprise_id: ENT_ID,
      provider_id: provider.id,
      name: `智谱主账号-${randomUUID().slice(0, 8)}`,
      mode,
      credential_type: mode === "CODING_PLAN" ? "SUBSCRIPTION_SESSION" : "API_KEY",
      status,
      credential_version: 1,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { provider, resource };
}

export async function countAudit(action: string): Promise<number> {
  const rows = await db
    .selectFrom("operation_log")
    .select("id")
    .where("enterprise_id", "=", ENT_ID)
    .where("action", "=", action)
    .execute();
  return rows.length;
}
