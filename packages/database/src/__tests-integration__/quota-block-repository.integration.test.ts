/**
 * CPQW 集成测试：额度条件提交仓储（quota-block-repository）+ 0087 迁移。
 *
 * 覆盖计划§4/§7（F1/F4）与 tasks 1.3/1.4/2.1/2.5 的核心行为：
 *   - 0087 默认值（revision=0、block NULL）与有事实时 down 保护
 *   - 明确耗尽故障 → incident 创建/合并 + EXHAUSTED + revision 递增 + 事件同事务绑定
 *   - GET 成功条件提交：token 失配（轮换/revision 变化/新 incident）→ SUPERSEDED 零写入
 *   - Kimi 双窗口恢复 → block 清空、DEGRADED、同 incident 额度事件关闭
 *   - 周窗口 UNSUPPORTED/缺失不清除（B2 部分）
 *   - 查询失败提交：保鲜 + nextCheck + revision 递增，block 保留
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  AdminWriteRepository,
  createKysely,
  migrateDown,
  migrateToLatest,
  QuotaBlockRepository,
  type Database,
} from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("cpqw_quota_block_repo");
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
  version: number;
}

async function fixture(
  providerCode: "kimi" | "zhipu" = "kimi",
  opts: { credentialVersion?: number | null } = {},
): Promise<Fixture> {
  const db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  const enterpriseId = randomUUID();
  const providerId = randomUUID();
  const resourceId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "CPQW测试" }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: providerCode, name: providerCode,
    adapter_type: "OPENAI_COMPATIBLE", status: "ACTIVE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
    name: `${providerCode} CP`, mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    credential_ciphertext: "{}",
    ...(opts.credentialVersion === null ? {} : { credential_version: opts.credentialVersion ?? 1 }),
    status: "ACTIVE",
  }).execute();
  const snapshot = await db.selectFrom("provider_resource").select("version")
    .where("id", "=", resourceId).executeTakeFirstOrThrow();
  return {
    db, repo: new QuotaBlockRepository(db), enterpriseId, providerId, resourceId,
    version: snapshot.version,
  };
}

async function resourceRow(t: Fixture) {
  return t.db.selectFrom("provider_resource")
    .select(["status", "quota_state_revision", "quota_block_state", "cooldown_until"])
    .where("id", "=", t.resourceId).executeTakeFirstOrThrow();
}

function positiveWindows(resetFiveHour = FIVE_HOUR_RESET, resetWeekly = WEEKLY_RESET) {
  return [
    { windowType: "FIVE_HOUR" as const, limit: "100", used: "0", remaining: "100", unit: "POINT" as const, ratio: "0", resetAt: new Date(resetFiveHour), unsupported: false },
    { windowType: "WEEKLY" as const, limit: "1000", used: "10", remaining: "990", unit: "POINT" as const, ratio: "0.01", resetAt: new Date(resetWeekly), unsupported: false },
  ];
}

async function publishQuotaRule(t: Fixture): Promise<{ ruleId: string; versionId: string }> {
  const rule = await t.db.insertInto("availability_rule").values({
    name: "CPQW额度熔断", rule_type: "UPSTREAM_SIGNAL",
  }).returning("id").executeTakeFirstOrThrow();
  const version = await t.db.insertInto("availability_rule_version").values({
    availability_rule_id: rule.id, rule_version: 1, status: "PUBLISHED",
    unified_signal: "QUOTA_EXHAUSTED", action: "BLOCK", recovery_method: "UPSTREAM_RESET_TIME",
  }).returning("id").executeTakeFirstOrThrow();
  return { ruleId: rule.id, versionId: version.id };
}

describe("0087 迁移", () => {
  it("默认值正确：revision=0、block NULL、事件 incident 列 NULL", async () => {
    const t = await fixture();
    try {
      const row = await resourceRow(t);
      expect(Number(row.quota_state_revision)).toBe(0);
      expect(row.quota_block_state).toBeNull();
      const column = await sql<{ is_nullable: string }>`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'availability_event' AND column_name = 'quota_block_incident_id'`.execute(t.db);
      expect(column.rows[0]?.is_nullable).toBe("YES");
    } finally {
      await t.db.destroy();
    }
  });

  it("有耗尽事实时 down 拒绝执行（计划§10）", async () => {
    const t = await fixture();
    try {
      const fault = await t.repo.recordCodingPlanExhaustionFault({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version,
        expectedCredentialVersion: 1,
        observations: [{ windowType: "FIVE_HOUR", resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" }],
        now: NOW,
        runtimeAssurance: null,
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: "x", sanitizedSummary: null, aiRequestId: null, principalId: null,
        },
      });
      expect(fault.status).toBe("COMMITTED");
      await expect(migrateDown(t.db)).rejects.toThrow(/quota block facts exist/);
    } finally {
      await t.db.destroy();
    }
  });
});

describe("明确耗尽故障（F2/D4）", () => {
  it("首次 5 小时耗尽：创建 incident、EXHAUSTED、revision 递增、事件绑定 incident", async () => {
    const t = await fixture();
    try {
      await publishQuotaRule(t);
      const fault = await t.repo.recordCodingPlanExhaustionFault({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version,
        expectedCredentialVersion: 1,
        observations: [{ windowType: "FIVE_HOUR", resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" }],
        now: NOW,
        runtimeAssurance: { mode: "ENFORCE", wecomNotify: false },
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: "quota", sanitizedSummary: "上游额度已耗尽",
          aiRequestId: null, principalId: null,
        },
      });
      expect(fault.status).toBe("COMMITTED");
      if (fault.status !== "COMMITTED") return;
      const row = await resourceRow(t);
      expect(row.status).toBe("EXHAUSTED");
      expect(Number(row.quota_state_revision)).toBe(1);
      expect(row.cooldown_until?.toISOString()).toBe(FIVE_HOUR_RESET);

      const block = row.quota_block_state as Record<string, unknown>;
      expect(block.incidentId).toBe(fault.block?.incidentId);
      expect(block.windows).toEqual([
        { type: "FIVE_HOUR", observedAt: NOW.toISOString(), resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" },
      ]);
      const events = await t.db.selectFrom("availability_event").selectAll()
        .where("provider_resource_id", "=", t.resourceId).execute();
      expect(events).toHaveLength(1);
      expect(events[0]!.quota_block_incident_id).toBe(block.incidentId);
      expect(events[0]!.recover_at).toBeNull();
      expect(events[0]!.status).toBe("OPEN");

      // 同 incident 二次故障（周窗口）合并；revision 再递增。
      const second = await t.repo.recordCodingPlanExhaustionFault({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version,
        expectedCredentialVersion: 1,
        observations: [{ windowType: "WEEKLY", resetAt: WEEKLY_RESET, resetSource: "UPSTREAM_RESET_AT" }],
        now: NOW,
        runtimeAssurance: { mode: "ENFORCE", wecomNotify: false },
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: "quota", sanitizedSummary: null,
          aiRequestId: null, principalId: null,
        },
      });
      expect(second.status).toBe("COMMITTED");
      const merged = (await resourceRow(t)).quota_block_state as Record<string, unknown>;
      expect(merged.incidentId).toBe(block.incidentId);
      expect((merged.windows as Array<{ type: string }>).map((w) => w.type).sort()).toEqual(["FIVE_HOUR", "WEEKLY"]);
      expect(Number((await resourceRow(t)).quota_state_revision)).toBe(2);
      // 事件仍只有一条（同 incident 去重）。
      expect(await t.db.selectFrom("availability_event").select("id")
        .where("provider_resource_id", "=", t.resourceId).execute()).toHaveLength(1);
    } finally {
      await t.db.destroy();
    }
  });

  it("迟到失败落到新凭证时被拒绝（expectedCredentialVersion 不匹配 → 零写入）", async () => {
    const t = await fixture();
    try {
      const stale = await t.repo.recordCodingPlanExhaustionFault({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version,
        expectedCredentialVersion: 7, // 实际是 1
        observations: [{ windowType: "FIVE_HOUR", resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" }],
        now: NOW,
        runtimeAssurance: null,
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: null, sanitizedSummary: null, aiRequestId: null, principalId: null,
        },
      });
      expect(stale).toMatchObject({ status: "SUPERSEDED", reason: "CREDENTIAL_ROTATED" });
      const row = await resourceRow(t);
      expect(row.quota_block_state).toBeNull();
      expect(row.status).toBe("ACTIVE");
      expect(Number(row.quota_state_revision)).toBe(0);
    } finally {
      await t.db.destroy();
    }
  });
});

describe("额度 GET 条件提交（F4）", () => {
  it("轮换后旧 token 提交 → SUPERSEDED，不写当前窗口/状态", async () => {
    const t = await fixture();
    try {
      const capture = await t.repo.captureQuotaQueryToken(t.resourceId, NOW);
      expect(capture).not.toBeNull();
      // 管理前提写入（轮换）使 token 失效。
      await t.db.updateTable("provider_resource")
        .set({ credential_version: 2, quota_state_revision: sql`quota_state_revision + 1`, updated_at: NOW })
        .where("id", "=", t.resourceId).execute();
      const result = await t.repo.commitQuotaQueryResult({
        token: capture!.token,
        source: "PROVIDER_SYNC",
        adapterVersion: "test-v1",
        providerDataAt: NOW,
        windows: positiveWindows(),
        now: NOW,
      });
      expect(result).toMatchObject({ status: "SUPERSEDED", reason: "CREDENTIAL_ROTATED" });
      expect(await t.db.selectFrom("provider_quota_window").select("id")
        .where("provider_resource_id", "=", t.resourceId).execute()).toHaveLength(0);
    } finally {
      await t.db.destroy();
    }
  });

  it("同 token 双结果只接受首次提交（revision 递增使后者失配）", async () => {
    const t = await fixture();
    try {
      const capture = await t.repo.captureQuotaQueryToken(t.resourceId, NOW);
      const first = await t.repo.commitQuotaQueryResult({
        token: capture!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
        providerDataAt: NOW, windows: positiveWindows(), now: NOW,
      });
      expect(first.status).toBe("COMMITTED");
      const second = await t.repo.commitQuotaQueryResult({
        token: capture!.token, source: "MANUAL_SYNC", adapterVersion: "v1",
        providerDataAt: NOW, windows: positiveWindows(), now: NOW,
      });
      expect(second).toMatchObject({ status: "SUPERSEDED", reason: "QUOTA_REVISION_CHANGED" });
      expect(await t.db.selectFrom("provider_quota_window").select("id")
        .where("provider_resource_id", "=", t.resourceId).execute()).toHaveLength(2);
    } finally {
      await t.db.destroy();
    }
  });

  it("Kimi 双窗口正余量 → block 清空、DEGRADED、同 incident 事件关闭；旧零值不无限回溯", async () => {
    const t = await fixture();
    try {
      await publishQuotaRule(t);
      const fault = await t.repo.recordCodingPlanExhaustionFault({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version, expectedCredentialVersion: 1,
        observations: [{ windowType: "FIVE_HOUR", resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" }],
        now: NOW,
        runtimeAssurance: { mode: "ENFORCE", wecomNotify: false },
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: null, sanitizedSummary: null, aiRequestId: null, principalId: null,
        },
      });
      const incidentId = fault.status === "COMMITTED" ? fault.block!.incidentId : "";

      // 周窗口缺失（只有 5h 正余量）→ 不恢复。
      const capture1 = await t.repo.captureQuotaQueryToken(t.resourceId, new Date("2026-10-03T02:00:00.000Z"));
      const partial = await t.repo.commitQuotaQueryResult({
        token: capture1!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
        providerDataAt: NOW,
        windows: [
          { windowType: "FIVE_HOUR", limit: "100", used: "0", remaining: "100", unit: "POINT", ratio: "0", resetAt: new Date(FIVE_HOUR_RESET), unsupported: false },
          { windowType: "WEEKLY", limit: null, used: null, remaining: null, unit: null, ratio: null, resetAt: null, unsupported: true },
        ],
        now: new Date("2026-10-03T02:00:00.000Z"),
      });
      expect(partial.status).toBe("COMMITTED");
      if (partial.status !== "COMMITTED") return;
      expect(partial.recovered).toBe(false);
      expect(partial.blockActive).toBe(true);
      expect((await resourceRow(t)).status).toBe("EXHAUSTED");

      // 双窗口正余量 → 恢复：DEGRADED、block 清空、事件关闭。
      const capture2 = await t.repo.captureQuotaQueryToken(t.resourceId, new Date("2026-10-03T03:00:00.000Z"));
      const recovered = await t.repo.commitQuotaQueryResult({
        token: capture2!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
        providerDataAt: NOW, windows: positiveWindows(), now: new Date("2026-10-03T03:00:00.000Z"),
      });
      expect(recovered.status).toBe("COMMITTED");
      if (recovered.status !== "COMMITTED") return;
      expect(recovered.recovered).toBe(true);
      expect(recovered.incidentsClosed).toBe(1);
      const row = await resourceRow(t);
      expect(row.status).toBe("DEGRADED");
      expect(row.quota_block_state).toBeNull();
      expect(row.cooldown_until).toBeNull();
      const events = await t.db.selectFrom("availability_event").selectAll()
        .where("provider_resource_id", "=", t.resourceId).execute();
      expect(events[0]!.status).toBe("RECOVERED");
      expect(events[0]!.quota_block_incident_id).toBe(incidentId);
    } finally {
      await t.db.destroy();
    }
  });

  it("查询失败提交：保鲜 + nextCheck=now+5min + revision 递增，block 与未来 reset 保留", async () => {
    const t = await fixture();
    try {
      await t.repo.recordCodingPlanExhaustionFault({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version, expectedCredentialVersion: 1,
        observations: [{ windowType: "FIVE_HOUR", resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" }],
        now: NOW,
        runtimeAssurance: null,
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: null, sanitizedSummary: null, aiRequestId: null, principalId: null,
        },
      });
      const capture = await t.repo.captureQuotaQueryToken(t.resourceId, NOW);
      const failureAt = new Date("2026-10-03T00:02:00.000Z");
      const failed = await t.repo.commitQuotaQueryFailure({
        token: capture!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
        errorCode: "UPSTREAM_UNAVAILABLE", now: failureAt,
      });
      expect(failed.status).toBe("COMMITTED");
      const row = await resourceRow(t);
      expect(row.status).toBe("EXHAUSTED");
      expect(row.cooldown_until?.toISOString()).toBe(new Date(failureAt.getTime() + 5 * 60_000).toISOString());
      const block = row.quota_block_state as { windows: Array<{ resetAt: string }> };
      expect(block.windows[0]!.resetAt).toBe(FIVE_HOUR_RESET);
      const stale = await t.db.selectFrom("provider_quota_window").select(["window_type", "sync_status"])
        .where("provider_resource_id", "=", t.resourceId).orderBy("window_type").execute();
      expect(stale).toHaveLength(2);
      expect(stale.every((item) => item.sync_status === "FAILED")).toBe(true);
      // 失败提交也递增 revision：同 token 再提交失败 → SUPERSEDED。
      const again = await t.repo.commitQuotaQueryFailure({
        token: capture!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
        errorCode: "UPSTREAM_UNAVAILABLE", now: failureAt,
      });
      expect(again).toMatchObject({ status: "SUPERSEDED" });
    } finally {
      await t.db.destroy();
    }
  });
});

describe("凭证轮换废弃旧 incident（D1）", () => {
  it("管理轮换后活跃 block 替换为新凭证 unknownWindow 待确认记录，且 token 失效", async () => {
    const t = await fixture();
    try {
      const capture = await t.repo.captureQuotaQueryToken(t.resourceId, NOW);
      await t.repo.recordCodingPlanExhaustionFault({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version, expectedCredentialVersion: 1,
        observations: [{ windowType: "FIVE_HOUR", resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" }],
        now: NOW,
        runtimeAssurance: null,
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: null, sanitizedSummary: null, aiRequestId: null, principalId: null,
        },
      });
      const beforeRotation = (await resourceRow(t)).quota_block_state as Record<string, unknown>;
      const adminWrite = new AdminWriteRepository(t.db);
      const rotated = await adminWrite.adminRecoverResource(t.enterpriseId, t.resourceId, {
        credential_encrypted: { ciphertext: "c", nonce: "n", tag: "t" },
        credential_fingerprint: "fp-2",
      });
      expect(rotated).not.toBeNull();
      const row = await resourceRow(t);
      const block = row.quota_block_state as Record<string, unknown>;
      expect(block.incidentId).not.toBe(beforeRotation.incidentId);
      expect(block.unknownWindow).toBe(true);
      expect(block.windows).toEqual([]);
      expect(block.credentialVersion).toBe(2);
      expect(Number(row.quota_state_revision)).toBeGreaterThan(1);
      // 轮换后旧 token 的额度提交被拒绝（revision + 凭证都变了）。
      const stale = await t.repo.commitQuotaQueryResult({
        token: capture!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
        providerDataAt: NOW, windows: positiveWindows(), now: NOW,
      });
      expect(stale.status).toBe("SUPERSEDED");
      expect(await t.db.selectFrom("provider_quota_window").select("id")
        .where("provider_resource_id", "=", t.resourceId).execute()).toHaveLength(0);
    } finally {
      await t.db.destroy();
    }
  });
});

describe("复审缺陷回归", () => {
  it("缺陷1：旧凭证版本为 null 时，轮换后的迟到故障被拒绝，不污染新凭证", async () => {
    const t = await fixture("kimi", { credentialVersion: null });
    try {
      const faultInput = (expectedCredentialVersion: number | null) => ({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version,
        expectedCredentialVersion,
        observations: [{ windowType: "FIVE_HOUR" as const, resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" as const }],
        now: NOW,
        runtimeAssurance: null,
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: null, sanitizedSummary: null, aiRequestId: null, principalId: null,
        },
      });
      // 轮换前：行内与 fencing 均为 null → 一致，接受。
      const accepted = await t.repo.recordCodingPlanExhaustionFault(faultInput(null));
      expect(accepted.status).toBe("COMMITTED");
      // 轮换 → credential_version 1（含额度代次递增）。
      await t.db.updateTable("provider_resource")
        .set({ credential_version: 1, quota_state_revision: sql`quota_state_revision + 1` })
        .where("id", "=", t.resourceId).execute();
      // 迟到的旧凭证故障（fencing 仍为 null）必须被拒绝。
      const stale = await t.repo.recordCodingPlanExhaustionFault(faultInput(null));
      expect(stale).toMatchObject({ status: "SUPERSEDED", reason: "CREDENTIAL_ROTATED" });
      // 携带新凭证版本的故障仍可提交（新 incident，credentialVersion=1）。
      const fresh = await t.repo.recordCodingPlanExhaustionFault(faultInput(1));
      expect(fresh.status).toBe("COMMITTED");
      const block = (await resourceRow(t)).quota_block_state as { credentialVersion: number };
      expect(block.credentialVersion).toBe(1);
    } finally {
      await t.db.destroy();
    }
  });

  it("缺陷2：轮换废弃旧 incident 时同事务关闭其绑定的 OPEN 额度事件", async () => {
    const t = await fixture();
    try {
      await publishQuotaRule(t);
      const fault = await t.repo.recordCodingPlanExhaustionFault({
        resourceId: t.resourceId,
        expectedResourceVersion: t.version,
        expectedCredentialVersion: 1,
        observations: [{ windowType: "FIVE_HOUR", resetAt: FIVE_HOUR_RESET, resetSource: "UPSTREAM_RESET_AT" }],
        now: NOW,
        runtimeAssurance: { mode: "ENFORCE", wecomNotify: false },
        signal: {
          providerId: t.providerId, unifiedModelId: null, upstreamModel: "k3",
          upstreamCode: null, sanitizedSummary: null, aiRequestId: null, principalId: null,
        },
      });
      expect(fault.status).toBe("COMMITTED");
      const incidentId = fault.status === "COMMITTED" ? fault.block!.incidentId : "";
      const before = await t.db.selectFrom("availability_event").selectAll()
        .where("provider_resource_id", "=", t.resourceId).execute();
      expect(before).toHaveLength(1);
      expect(before[0]!.status).toBe("OPEN");

      const adminWrite = new AdminWriteRepository(t.db);
      const rotated = await adminWrite.adminRecoverResource(t.enterpriseId, t.resourceId, {
        credential_encrypted: { ciphertext: "c", nonce: "n", tag: "t" },
        credential_fingerprint: "fp-rotated",
      });
      expect(rotated).not.toBeNull();
      // 旧 incident 的事件被取消（不再 OPEN），新 unknown 待确认记录不建事件。
      const after = await t.db.selectFrom("availability_event").selectAll()
        .where("provider_resource_id", "=", t.resourceId).execute();
      expect(after).toHaveLength(1);
      expect(after[0]!.status).toBe("CANCELLED");
      expect(after[0]!.quota_block_incident_id).toBe(incidentId);
      const block = (await resourceRow(t)).quota_block_state as { incidentId: string; unknownWindow: boolean };
      expect(block.incidentId).not.toBe(incidentId);
      expect(block.unknownWindow).toBe(true);
      // 新凭证额度确认恢复后：block 清空且无残留 OPEN 额度事件（ENFORCE 不再阻断）。
      const capture = await t.repo.captureQuotaQueryToken(t.resourceId, new Date("2026-10-03T04:00:00.000Z"));
      const recovered = await t.repo.commitQuotaQueryResult({
        token: capture!.token, source: "PROVIDER_SYNC", adapterVersion: "v1",
        providerDataAt: NOW, windows: positiveWindows(), now: new Date("2026-10-03T04:00:00.000Z"),
      });
      expect(recovered.status).toBe("COMMITTED");
      if (recovered.status !== "COMMITTED") return;
      expect(recovered.recovered).toBe(true);
      expect((await resourceRow(t)).quota_block_state).toBeNull();
      const openLeft = await t.db.selectFrom("availability_event").select("id")
        .where("provider_resource_id", "=", t.resourceId)
        .where("status", "=", "OPEN").execute();
      expect(openLeft).toHaveLength(0);
    } finally {
      await t.db.destroy();
    }
  });
});
