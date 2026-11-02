import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { ActiveKeyExistsError, createKysely, KeyRepository, migrateToLatest } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let keys: KeyRepository;
const enterpriseId = randomUUID();
const otherEnterpriseId = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer("prerelease_key_contract");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values([{ id: enterpriseId, name: "合成Key企业" },
    { id: otherEnterpriseId, name: "合成隔离企业" }]).execute();
  keys = new KeyRepository(db, "synthetic-pepper", () => `synthetic-${randomUUID()}`,
    (value, pepper) => createHash("sha256").update(pepper + value).digest("hex"), (value) => value.slice(0, 12));
}, 120_000);

afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function principal(name: string) {
  return (await db.insertInto("principal").values({ enterprise_id: enterpriseId, type: "EMPLOYEE", name })
    .returning("id").executeTakeFirstOrThrow()).id;
}

describe("pre-release Key lifecycle and scope", () => {
  it("concurrent creation leaves exactly one ACTIVE key and classifies the database conflict", async () => {
    const principalId = await principal("并发Key");
    const results = await Promise.allSettled([keys.create(enterpriseId, principalId), keys.create(enterpriseId, principalId)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(ActiveKeyExistsError);
    const rows = await db.selectFrom("principal_key").selectAll().where("principal_id", "=", principalId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ACTIVE");
  });

  it("revocation is enterprise-scoped, idempotent, and does not revoke another principal", async () => {
    const one = await principal("撤销目标"), two = await principal("保留目标");
    const first = await keys.create(enterpriseId, one);
    const second = await keys.create(enterpriseId, two);
    expect(await keys.revokeAllByPrincipal(otherEnterpriseId, one)).toBe(0);
    expect(await keys.revokeAllByPrincipal(enterpriseId, one)).toBe(1);
    expect(await keys.revokeAllByPrincipal(enterpriseId, one)).toBe(0);
    const revoked = await db.selectFrom("principal_key").select(["status", "revoked_at"]).where("id", "=", first.record.id).executeTakeFirstOrThrow();
    expect(revoked.status).toBe("REVOKED");
    expect(revoked.revoked_at).toBeInstanceOf(Date);
    expect((await keys.findActive(enterpriseId, two))?.id).toBe(second.record.id);
  });
});
