/**
 * CPQW 任务 2.2 集成测试：条件提交事务的阶段故障注入 + 与授权撤销的锁顺序核对。
 *
 * 阶段故障注入（计划§7"任何一步失败全回滚，不出现部分放行"）：
 * 在提交事务的各阶段表上注入 BEFORE 触发器异常——窗口写入（provider_quota_window）、
 * 状态迁移审计（resource_status_event）、Key 模型刷新（principal_key）、
 * 额度事件关闭（availability_event）——断言整事务回滚：
 * 资源行（status/block/revision/cooldown）、窗口行、事件状态全部保持提交前快照。
 *
 * 锁顺序核对：额度恢复事务的加锁顺序为 provider_resource(FOR UPDATE) →
 * principal_key(FOR UPDATE)（refreshEmployeeKeyModels）；授权撤销路径
 * （updateGrant 乐观锁 + 独立事务的 Key 刷新）只锁主体侧、不反向持有资源锁。
 * 并发交替执行两者应无死锁逃逸（40P01 由提交重试吸收）、无部分状态。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  AdminWriteRepository,
  createKysely,
  migrateToLatest,
  QuotaBlockRepository,
  type Database,
} from "../index.js";
import { refreshEmployeeKeyModels } from "../repositories/employee-model-rule-lifecycle.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("cpqw_tx_faults");
}, 120_000);

afterAll(async () => {
  if (pg) await pg.stop();
}, 60_000);

const NOW = new Date("2026-10-03T00:00:00.000Z");
const FIVE_HOUR_RESET = "2026-10-03T01:16:00.000Z";
const WEEKLY_RESET = "2026-10-05T03:16:00.000Z";

interface Fixture {
  db: Database;
  repo: QuotaBlockRepository;
  enterpriseId: string;
  providerId: string;
  resourceId: string;
  resourceVersion: number;
  grantId: string;
  grantVersion: number;
  principalId: string;
  modelId: string;
}

async function fixture(): Promise<Fixture> {
  const db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  const enterpriseId = randomUUID();
  const providerId = randomUUID();
  const resourceId = randomUUID();
  const modelId = randomUUID();
  const principalId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "CPQW事务故障测试" }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "kimi", name: "Kimi",
    adapter_type: "OPENAI_COMPATIBLE", status: "ACTIVE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
    name: "CPQW事务故障", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    credential_ciphertext: "{}", credential_version: 1, status: "ACTIVE",
  }).execute();
  await db.insertInto("unified_model").values({
    id: modelId, enterprise_id: enterpriseId, alias: `cpqw-tx-${modelId.slice(0, 8)}`,
    display_name: "CPQW TX", status: "ACTIVE",
  }).execute();
  await db.insertInto("model_route").values({
    enterprise_id: enterpriseId, unified_model_id: modelId,
    provider_resource_id: resourceId, upstream_model: "kimi-k3", priority: 100, weight: 1,
  }).execute();
  await db.insertInto("billing_rule").values({
    enterprise_id: enterpriseId, provider_resource_id: resourceId, upstream_model: "kimi-k3",
    rule_type: "MODEL_TIER", rule_version: "cpqw-tx-v1", effective_from: new Date(0),
    multiplier: "1", priority: 1, enabled: true,
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "事务故障员工", status: "ACTIVE",
  }).execute();
  await db.insertInto("principal_key").values({
    enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "cpqw-tx", key_digest: randomUUID(),
    allowed_model_ids: JSON.stringify([modelId]) as unknown as string[], status: "ACTIVE",
  }).execute();
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId, principal_id: principalId, provider: "kimi",
    model_alias: "*", pool_model_alias: "*", quota_value: 100_000n, status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
  const resourceSnapshot = await db.selectFrom("provider_resource").select("version")
    .where("id", "=", resourceId).executeTakeFirstOrThrow();
  return {
    db, repo: new QuotaBlockRepository(db), enterpriseId, providerId, resourceId,
    resourceVersion: resourceSnapshot.version,
    grantId: grant.id, grantVersion: grant.version, principalId, modelId,
  };
}

/** 建立阻断基态：明确 5 小时耗尽故障 + 绑定 incident 的 OPEN 额度事件。 */
async function establishBlock(t: Fixture): Promise<void> {
  const rule = await t.db.insertInto("availability_rule").values({
    name: `CPQW额度熔断-${t.resourceId.slice(0, 8)}`, rule_type: "UPSTREAM_SIGNAL",
  }).returning("id").executeTakeFirstOrThrow();
  await t.db.insertInto("availability_rule_version").values({
    availability_rule_id: rule.id, rule_version: 1, status: "PUBLISHED",
    unified_signal: "QUOTA_EXHAUSTED", action: "BLOCK", recovery_method: "UPSTREAM_RESET_TIME",
  }).execute();
  const fault = await t.repo.recordCodingPlanExhaustionFault({
    resourceId: t.resourceId,
    expectedResourceVersion: t.resourceVersion,
    expectedCredentialVersion: 1,
    observations: [{ windowType: "FIVE_HOUR", resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" }],
    now: NOW,
    runtimeAssurance: { mode: "ENFORCE", wecomNotify: false },
    signal: {
      providerId: t.providerId, unifiedModelId: t.modelId, upstreamModel: "kimi-k3",
      upstreamCode: null, sanitizedSummary: null, aiRequestId: null, principalId: null,
    },
  });
  expect(fault.status).toBe("COMMITTED");
}

interface Snapshot {
  resource: { status: string; block: string | null; revision: number; cooldown: string | null };
  windows: number;
  openEvents: number;
}

async function snapshot(t: Fixture): Promise<Snapshot> {
  const row = await t.db.selectFrom("provider_resource")
    .select(["status", "quota_block_state", "quota_state_revision", "cooldown_until"])
    .where("id", "=", t.resourceId).executeTakeFirstOrThrow();
  const windows = await t.db.selectFrom("provider_quota_window").select("id")
    .where("provider_resource_id", "=", t.resourceId).execute();
  const openEvents = await t.db.selectFrom("availability_event").select("id")
    .where("provider_resource_id", "=", t.resourceId).where("status", "=", "OPEN").execute();
  return {
    resource: {
      status: row.status,
      block: row.quota_block_state === null ? null : JSON.stringify(row.quota_block_state),
      revision: Number(row.quota_state_revision),
      cooldown: row.cooldown_until?.toISOString() ?? null,
    },
    windows: windows.length,
    openEvents: openEvents.length,
  };
}

function positiveWindows() {
  return [
    { windowType: "FIVE_HOUR" as const, limit: "100", used: "0", remaining: "100", unit: "POINT" as const, ratio: "0", resetAt: new Date(FIVE_HOUR_RESET), unsupported: false },
    { windowType: "WEEKLY" as const, limit: "1000", used: "10", remaining: "990", unit: "POINT" as const, ratio: "0.01", resetAt: new Date(WEEKLY_RESET), unsupported: false },
  ];
}

async function attemptRecovery(t: Fixture): Promise<unknown> {
  const capture = await t.repo.captureQuotaQueryToken(t.resourceId, NOW);
  return t.repo.commitQuotaQueryResult({
    token: capture!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
    providerDataAt: NOW, windows: positiveWindows(), now: NOW,
  });
}

async function injectFault(db: Database, table: string): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION cpqw_inject_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'cpqw injected fault on %', TG_TABLE_NAME; END $$`.execute(db);
  await sql.raw(`CREATE TRIGGER cpqw_fault BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION cpqw_inject_fail()`).execute(db);
}

async function removeFault(db: Database, table: string): Promise<void> {
  await sql.raw(`DROP TRIGGER IF EXISTS cpqw_fault ON ${table}`).execute(db);
  await sql`DROP FUNCTION IF EXISTS cpqw_inject_fail()`.execute(db);
}

describe("CPQW 任务2.2：提交事务阶段故障注入全回滚", () => {
  const stages: Array<{ name: string; table: string }> = [
    { name: "窗口写入阶段（provider_quota_window）", table: "provider_quota_window" },
    { name: "状态迁移审计阶段（resource_status_event）", table: "resource_status_event" },
    { name: "Key 模型刷新阶段（principal_key）", table: "principal_key" },
    { name: "额度事件关闭阶段（availability_event）", table: "availability_event" },
  ];

  for (const stage of stages) {
    it(`恢复提交在${stage.name}失败 → 整事务回滚，无部分放行`, async () => {
      const t = await fixture();
      try {
        await establishBlock(t);
        const before = await snapshot(t);
        expect(before.resource.status).toBe("EXHAUSTED");
        expect(before.resource.block).not.toBeNull();
        expect(before.openEvents).toBe(1);
        await injectFault(t.db, stage.table);
        await expect(attemptRecovery(t)).rejects.toThrow(/cpqw injected fault/);
        await removeFault(t.db, stage.table);
        // 全回滚：与失败前快照完全一致（无部分恢复、无窗口残留、事件仍 OPEN、revision 不变）。
        expect(await snapshot(t)).toEqual(before);
      } finally {
        await t.db.destroy();
      }
    });
  }

  it("失败提交在保鲜阶段失败 → 整事务回滚，block 与未来 reset 保留", async () => {
    const t = await fixture();
    try {
      await establishBlock(t);
      const before = await snapshot(t);
      await injectFault(t.db, "provider_quota_window");
      const capture = await t.repo.captureQuotaQueryToken(t.resourceId, NOW);
      await expect(t.repo.commitQuotaQueryFailure({
        token: capture!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
        errorCode: "UPSTREAM_UNAVAILABLE", now: NOW,
      })).rejects.toThrow(/cpqw injected fault/);
      await removeFault(t.db, "provider_quota_window");
      expect(await snapshot(t)).toEqual(before);
    } finally {
      await t.db.destroy();
    }
  });

  it("注入清除后同一资源可正常恢复（故障不留下毒化状态）", async () => {
    const t = await fixture();
    try {
      await establishBlock(t);
      await injectFault(t.db, "resource_status_event");
      await expect(attemptRecovery(t)).rejects.toThrow(/cpqw injected fault/);
      await removeFault(t.db, "resource_status_event");
      const result = await attemptRecovery(t);
      expect(result).toMatchObject({ status: "COMMITTED", recovered: true });
      const after = await snapshot(t);
      expect(after.resource.status).toBe("DEGRADED");
      expect(after.resource.block).toBeNull();
      expect(after.openEvents).toBe(0);
    } finally {
      await t.db.destroy();
    }
  });
});

describe("CPQW 任务2.2：与授权撤销的锁顺序核对", () => {
  it("额度恢复提交与授权撤销并发交替：无死锁逃逸、无部分状态（资源锁→主体锁单向序）", async () => {
    const t = await fixture();
    try {
      await establishBlock(t);
      const rounds = 8;
      for (let round = 0; round < rounds; round += 1) {
        // 每轮重新建立阻断（上一轮恢复后需再耗尽），撤销侧每轮重新启用以保持竞争。
        if (round > 0) {
          await t.db.updateTable("principal_grant").set({ status: "ACTIVE" }).where("id", "=", t.grantId).execute();
          await establishBlock(t);
        }
        const recovery = attemptRecovery(t);
        const revoke = (async () => {
          // 授权撤销路径：updateGrant 乐观锁（主体侧）+ 独立事务 Key 刷新（principal_key 锁），
          // 不持有 provider_resource 锁——与恢复事务（资源锁→主体锁）保持单向序。
          const adminWrite = new AdminWriteRepository(t.db);
          const updated = await adminWrite.updateGrant(t.enterpriseId, t.grantId, t.grantVersion + round, {
            status: "DISABLED",
          });
          expect(updated).not.toBeNull();
          await t.db.transaction().execute(async (trx) => {
            await refreshEmployeeKeyModels(trx, t.enterpriseId, t.principalId);
          });
        })();
        const settled = await Promise.allSettled([recovery, revoke]);
        expect(settled[0]!.status).toBe("fulfilled");
        expect(settled[1]!.status).toBe("fulfilled");
        // 无部分状态：block 清空当且仅当恢复提交成功；授权始终被撤销成功。
        const row = await t.db.selectFrom("provider_resource")
          .select(["status", "quota_block_state"]).where("id", "=", t.resourceId).executeTakeFirstOrThrow();
        const grantRow = await t.db.selectFrom("principal_grant").select("status")
          .where("id", "=", t.grantId).executeTakeFirstOrThrow();
        expect(grantRow.status).toBe("DISABLED");
        if (row.quota_block_state === null) {
          expect(["DEGRADED", "EXHAUSTED"]).toContain(row.status);
        }
      }
    } finally {
      await t.db.destroy();
    }
  });
});
