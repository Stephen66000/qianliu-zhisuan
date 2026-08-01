import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let cookie: string;
const enterpriseId = randomUUID();
const adminId = randomUUID();
const password = "RA-Control-Test-Password!";

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "运行保障测试" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "admin",
    password_hash: await hashPassword(password), status: "ACTIVE",
  }).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password } });
  const setCookie = login.headers["set-cookie"];
  cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

const inject = (options: Parameters<FastifyInstance["inject"]>[0]) => app.inject({
  ...options,
  headers: { cookie, ...(options as { headers?: Record<string, string> }).headers },
});

describe("RA-W02 人员、主体负责人", () => {
  let personId: string;
  let employeePrincipalId: string;
  let projectPrincipalId: string;

  it("人员、企微 userid、人主体和项目负责人闭环", async () => {
    const created = await inject({ method: "POST", url: "/people", payload: { name: "张三", department_label: "研发" } });
    expect(created.statusCode).toBe(201);
    personId = created.json().person.id;
    const identity = await inject({
      method: "PATCH", url: `/people/${personId}/wecom-identity`,
      payload: { provider_user_id: "zhangsan", expected_version: 1 },
    });
    expect(identity.statusCode).toBe(200);
    expect(identity.json().identity.provider_user_id).toBe("zhangsan");

    const employee = await inject({ method: "POST", url: "/principals", payload: { type: "EMPLOYEE", name: "张三主体" } });
    employeePrincipalId = employee.json().principal.id;
    const bindEmployee = await inject({
      method: "PATCH", url: `/principals/${employeePrincipalId}/person`,
      payload: { person_id: personId, expected_version: 1 },
    });
    expect(bindEmployee.json().principal.person_id).toBe(personId);

    const project = await inject({ method: "POST", url: "/principals", payload: { type: "PROJECT", name: "运行保障项目" } });
    projectPrincipalId = project.json().principal.id;
    const bindOwner = await inject({
      method: "PATCH", url: `/principals/${projectPrincipalId}/owner`,
      payload: { person_id: personId, expected_version: 1 },
    });
    expect(bindOwner.json().principal.owner_person_id).toBe(personId);
  });

  it("人员仍负责启用项目时阻止停用", async () => {
    const list = await inject({ method: "GET", url: "/people" });
    const person = list.json().people.find((item: { id: string }) => item.id === personId);
    const disabled = await inject({
      method: "PATCH", url: `/people/${personId}`,
      payload: { status: "DISABLED", expected_version: person.version },
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error).toBe("person_owns_active_projects");
  });
});

describe("RA-W03 规则版本闭环", () => {
  const basePayload = {
    name: "智谱额度耗尽",
    rule_type: "UPSTREAM_SIGNAL",
    version: {
      unified_signal: "QUOTA_EXHAUSTED",
      action: "BLOCK",
      recovery_method: "UPSTREAM_RESET_TIME",
      fallback_duration_seconds: 600,
      priority: 10,
    },
  };
  let ruleId: string;
  let publishedVersion: number;

  it("新建并发布规则", async () => {
    const created = await inject({ method: "POST", url: "/availability-rules", payload: basePayload });
    expect(created.statusCode).toBe(201);
    ruleId = created.json().rule.rule.id;
    const published = await inject({
      method: "POST", url: `/availability-rules/${ruleId}/publish`, payload: { expected_version: 1 },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().rule.current_version.status).toBe("PUBLISHED");
    publishedVersion = published.json().rule.current_version.version;
  });

  it("编辑已发布规则生成新草稿，发布后旧版 SUPERSEDED", async () => {
    const edited = await inject({
      method: "PATCH", url: `/availability-rules/${ruleId}`,
      payload: { expected_version: publishedVersion, version: { priority: 5 } },
    });
    expect(edited.json().rule.current_version).toMatchObject({ rule_version: 2, status: "DRAFT", priority: 5 });
    const next = await inject({
      method: "POST", url: `/availability-rules/${ruleId}/publish`,
      payload: { expected_version: edited.json().rule.current_version.version },
    });
    expect(next.json().rule.current_version.rule_version).toBe(2);
    const detail = await inject({ method: "GET", url: `/availability-rules/${ruleId}` });
    expect(detail.json().rule.versions.find((item: { rule_version: number }) => item.rule_version === 1).status).toBe("SUPERSEDED");
  });

  it("回滚生成新版本，不覆盖历史", async () => {
    const detail = await inject({ method: "GET", url: `/availability-rules/${ruleId}` });
    const current = detail.json().rule.current_version;
    const rolled = await inject({
      method: "POST", url: `/availability-rules/${ruleId}/rollback`,
      payload: { source_rule_version: 1, expected_version: current.version },
    });
    expect(rolled.json().rule.current_version).toMatchObject({ rule_version: 3, status: "PUBLISHED" });
  });

  it("相同作用域和有效期的第二条规则发布冲突", async () => {
    const second = await inject({ method: "POST", url: "/availability-rules", payload: { ...basePayload, name: "冲突规则" } });
    const conflict = await inject({
      method: "POST", url: `/availability-rules/${second.json().rule.rule.id}/publish`,
      payload: { expected_version: 1 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("rule_conflict");
  });
});

describe("RA-W06 企微配置安全边界", () => {
  it("Secret 仅密文入库，API 只返回掩码和指纹", async () => {
    const plaintext = `ra-secret-${randomUUID()}`;
    const saved = await inject({
      method: "PATCH", url: "/notification-endpoints/wecom-app",
      payload: { corp_id: "corp-test", agent_id: "1000002", secret: plaintext, status: "ACTIVE" },
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json())).not.toContain(plaintext);
    expect(saved.json().endpoint.secret_masked).toBe("••••••••");
    const canary = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM notification_endpoint
       WHERE secret_ciphertext LIKE ${`%${plaintext}%`}
    `.execute(db);
    expect(canary.rows[0]!.count).toBe(0);
  });
});
