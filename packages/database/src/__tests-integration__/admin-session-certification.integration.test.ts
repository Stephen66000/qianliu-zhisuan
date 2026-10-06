/**
 * F-050 集成测试：登录发证绑定密码代次（条件发证 + 行锁串行化）。
 *
 * 覆盖窗口的两个方向与既有合同：
 *   - 改密已提交 → 持旧哈希的在途登录被拒发证（旧窗口的挂起会话不再出现）；
 *   - 发证先提交 → changeOwnPassword / resetPassword 的同事务撤销覆盖该会话；
 *   - 当前哈希匹配时正常发证；归档管理员不发证。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { AdminRepository, createKysely, migrateToLatest, type Database } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;
let db: Database;
let repo: AdminRepository;

const ENT_ID = randomUUID();

async function seedAdmin(username: string, passwordHash: string): Promise<{ id: string }> {
  const id = randomUUID();
  await db.insertInto("admin_user").values({
    id, enterprise_id: ENT_ID, username, display_name: username,
    password_hash: passwordHash, status: "ACTIVE",
  }).execute();
  return { id };
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  repo = new AdminRepository(db);
  await db.insertInto("enterprise").values({ id: ENT_ID, name: "F-050 认证测试" }).execute();
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("F-050：条件发证关闭旧密码登录与改密的并发窗口", () => {
  it("改密提交后，持有旧哈希的在途登录被拒发证", async () => {
    const admin = await seedAdmin("f050-after-change", "hash-v1");
    const changed = await repo.changeOwnPassword({
      enterpriseId: ENT_ID, adminId: admin.id,
      previousPasswordHash: "hash-v1", newPasswordHash: "hash-v2",
    });
    expect(changed).toBe(true);
    const issued = await repo.createSessionIfPasswordHashMatches(
      admin.id, "hash-v1", `token-${randomUUID()}`, new Date(Date.now() + 60_000),
    );
    expect(issued).toBeNull();
  });

  it("resetPassword 提交后，持有旧哈希的在途登录同样被拒发证", async () => {
    const admin = await seedAdmin("f050-after-reset", "hash-v1");
    await repo.resetPassword({ enterpriseId: ENT_ID, adminId: admin.id, newPasswordHash: "hash-r2" });
    const issued = await repo.createSessionIfPasswordHashMatches(
      admin.id, "hash-v1", `token-${randomUUID()}`, new Date(Date.now() + 60_000),
    );
    expect(issued).toBeNull();
  });

  it("发证先提交：changeOwnPassword 与 resetPassword 的同事务撤销覆盖新发会话", async () => {
    const admin = await seedAdmin("f050-revoke-own", "hash-v1");
    const tokenHash = `token-hash-${randomUUID()}`;
    const session = await repo.createSessionIfPasswordHashMatches(
      admin.id, "hash-v1", tokenHash, new Date(Date.now() + 60_000),
    );
    expect(session).not.toBeNull();
    expect(await repo.findSessionByTokenHash(tokenHash)).toBeDefined();

    await repo.changeOwnPassword({
      enterpriseId: ENT_ID, adminId: admin.id,
      previousPasswordHash: "hash-v1", newPasswordHash: "hash-v2",
    });
    expect(await repo.findSessionByTokenHash(tokenHash)).toBeUndefined();

    const admin2 = await seedAdmin("f050-revoke-reset", "hash-v1");
    const tokenHash2 = `token-hash-${randomUUID()}`;
    expect(await repo.createSessionIfPasswordHashMatches(
      admin2.id, "hash-v1", tokenHash2, new Date(Date.now() + 60_000),
    )).not.toBeNull();
    await repo.resetPassword({ enterpriseId: ENT_ID, adminId: admin2.id, newPasswordHash: "hash-r2" });
    expect(await repo.findSessionByTokenHash(tokenHash2)).toBeUndefined();
  });

  it("当前哈希匹配时正常发证；归档管理员不发证", async () => {
    const admin = await seedAdmin("f050-normal", "hash-v1");
    const tokenHash = `token-hash-${randomUUID()}`;
    const session = await repo.createSessionIfPasswordHashMatches(
      admin.id, "hash-v1", tokenHash, new Date(Date.now() + 60_000),
    );
    expect(session).not.toBeNull();
    expect((await repo.findSessionByTokenHash(tokenHash))?.admin_id).toBe(admin.id);

    await db.updateTable("admin_user").set({ archived_at: new Date() })
      .where("id", "=", admin.id).execute();
    const archivedIssue = await repo.createSessionIfPasswordHashMatches(
      admin.id, "hash-v1", `token-hash-${randomUUID()}`, new Date(Date.now() + 60_000),
    );
    expect(archivedIssue).toBeNull();
  });
});
