import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let cookieA: string;
const password = "POOL-026-Password!";
const enterpriseA = randomUUID();
const enterpriseB = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  const passwordHash = await hashPassword(password);
  // 登录路由是一期单企业口径（取 `created_at` 最早、同值时按 `id` 排序的第一条企业）。
  // 迁移里 `defaultTo("now()")` 落库为**常量默认值**，同一语句插入的两条企业会得到完全相同
  // 的 `created_at`，此时谁被选中只取决于随机 UUID 的字典序 —— 夹具会约 50% 概率把会话落到
  // `deploy-b` 企业上，导致登录取不到 `deploy-a`。显式锚定被测企业更早创建以消除该随机性。
  await db.insertInto("enterprise").values([
    { id: enterpriseA, name: "deploy-a", created_at: new Date("2020-01-01T00:00:00.000Z") },
    { id: enterpriseB, name: "deploy-b", created_at: new Date("2020-01-02T00:00:00.000Z") },
  ]).execute();
  await db.insertInto("admin_user").values({
    enterprise_id: enterpriseA, username: "deploy-a", display_name: "deploy-a",
    password_hash: passwordHash, status: "ACTIVE",
  }).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = async (username: string) => {
    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
    const header = response.headers["set-cookie"];
    return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
  };
  cookieA = await login("deploy-a");
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("POOL-026 升级日志", () => {
  const startedAt = "2026-08-03T01:00:00.000Z";
  const finishedAt = "2026-08-03T01:10:00.000Z";
  const base = {
    deploymentId: "release-20260803-001",
    startedAt,
    status: "IN_PROGRESS",
    fromVersion: "abc1234",
    toVersion: "def5678",
    gitCommit: "def5678",
    artifactSha256: "a".repeat(64),
    migrationFrom: "0034_supply_forecast_production",
    migrationTo: "0035_deployment_log",
    releaseId: "20260803-001",
    actor: "mac-mini-release",
    summary: "修复升级日志闭环",
    poolRefs: ["POOL-026"],
    backupRef: "backup-20260803-001",
    rollbackTarget: "abc1234",
    healthSummary: { controlApi: "PASS", gateway: "PASS" },
    smokeSummary: { chromium: "PASS" },
    evidenceRefs: ["V3/Evidence/POOL-026-20260803.md"],
  } as const;

  it("开始、成功与重复导入只形成一条主记录和有序事件", async () => {
    expect((await app.inject({
      method: "POST", url: "/deployment-logs/import", headers: { cookie: cookieA }, payload: base,
    })).statusCode).toBe(200);
    const terminal = { ...base, status: "SUCCEEDED", finishedAt };
    const completed = await app.inject({
      method: "POST", url: "/deployment-logs/import", headers: { cookie: cookieA }, payload: terminal,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().deployment.status).toBe("SUCCEEDED");
    expect((await app.inject({
      method: "POST", url: "/deployment-logs/import", headers: { cookie: cookieA }, payload: terminal,
    })).statusCode).toBe(200);
    const rows = await db.selectFrom("deployment_log").selectAll()
      .where("enterprise_id", "=", enterpriseA).execute();
    expect(rows).toHaveLength(1);
    const events = await db.selectFrom("deployment_log_event").selectAll()
      .where("deployment_log_id", "=", rows[0]!.id).orderBy("occurred_at").execute();
    expect(events.map((event) => event.event_type)).toEqual(["IN_PROGRESS", "SUCCEEDED"]);
  });

  it("支持状态、版本和问题编号筛选，详情及企业边界正确", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/deployment-logs?status=SUCCEEDED&version=def5678&pool_ref=POOL-026",
      headers: { cookie: cookieA },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);
    const id = list.json().items[0].id;
    expect((await app.inject({ method: "GET", url: `/deployment-logs/${id}`, headers: { cookie: cookieA } })).json().events).toHaveLength(2);
    expect(await app.deploymentLogRepo.get(enterpriseB, id)).toBeNull();
  });

  it("完成记录不可改写，敏感 Manifest 被拒绝且不落库", async () => {
    const overwrite = await app.inject({
      method: "POST", url: "/deployment-logs/import", headers: { cookie: cookieA },
      payload: { ...base, status: "FAILED", finishedAt, summary: "试图覆盖" },
    });
    expect(overwrite.statusCode).toBe(409);
    const sensitive = await app.inject({
      method: "POST", url: "/deployment-logs/import", headers: { cookie: cookieA },
      payload: { ...base, deploymentId: "sensitive", status: "FAILED", finishedAt, summary: "Bearer abc.def.ghi" },
    });
    expect(sensitive.statusCode).toBe(400);
    const count = await db.selectFrom("deployment_log").select((eb) => eb.fn.countAll().as("count"))
      .where("deployment_id", "=", "sensitive").executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(0);
  });

  it("失败与回滚分别保留终态、失败分类和回滚目标", async () => {
    const failed = await app.inject({
      method: "POST", url: "/deployment-logs/import", headers: { cookie: cookieA },
      payload: {
        ...base,
        deploymentId: "release-20260803-failed",
        status: "FAILED",
        finishedAt,
        summary: "数据库迁移校验失败",
        failureClassification: "MIGRATION_CHECK_FAILED",
      },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().deployment).toMatchObject({
      status: "FAILED",
      failure_classification: "MIGRATION_CHECK_FAILED",
    });

    const rolledBack = await app.inject({
      method: "POST", url: "/deployment-logs/import", headers: { cookie: cookieA },
      payload: {
        ...base,
        deploymentId: "release-20260803-rollback",
        status: "ROLLED_BACK",
        finishedAt,
        summary: "健康检查失败后安全回滚",
        rollbackTarget: "abc1234",
        failureClassification: "HEALTH_CHECK_FAILED",
      },
    });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json().deployment).toMatchObject({
      status: "ROLLED_BACK",
      rollback_target: "abc1234",
      failure_classification: "HEALTH_CHECK_FAILED",
    });

    const statuses = await db.selectFrom("deployment_log").select(["deployment_id", "status"])
      .where("enterprise_id", "=", enterpriseA)
      .where("deployment_id", "in", ["release-20260803-failed", "release-20260803-rollback"])
      .orderBy("deployment_id").execute();
    expect(statuses).toEqual([
      { deployment_id: "release-20260803-failed", status: "FAILED" },
      { deployment_id: "release-20260803-rollback", status: "ROLLED_BACK" },
    ]);
  });
});
