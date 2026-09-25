import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely, migrateDown, ProviderFinanceActivationRepository } from "../index.js";
import { createMigrator } from "../migrator.js";
import { rollbackTo } from "./migration-rollback.js";

/**
 * 0078 迁移与激活控制仓储集成测试（WP01 / PFA-03、PFA-06、PFA-09、PFH-07）。
 *
 * 覆盖：
 * - 候选 TTL 固定 30 分钟且不可滑动、状态白名单不含 ACTIVATING、终态不可修改；
 * - 企业级激活幂等键唯一；
 * - 静默租约 60 分钟上限、状态形状、审计留痕与到期自动失效；
 * - 资源资金状态 PENDING/READY 形状与种子规则；
 * - Gateway 可服务资源排除 PENDING（PFH-07）；
 * - 存在激活事实时拒绝回退（0078 与 0079 均有 ACTIVATED 守卫，失败关闭）。
 */
describe.sequential("PF-INIT WP01：资金账本初始化控制结构", () => {
  /** 空草稿载荷：结构完整、可被领域规范化读取。 */
  function emptyDraft() {
    return {
      schema_version: "1",
      api_opening_balances: [],
      historical_api_recharges: [],
      coding_plan_purchases: [],
      coding_plan_carryovers: [],
      legacy_purchase_resolutions: [],
    };
  }

  async function bootstrap(name: string) {
    const pg = await startPostgresContainer(name);
    const db = createKysely(pg.connectionString);
    expect((await createMigrator(db).migrateToLatest()).error).toBeUndefined();
    const enterpriseId = randomUUID();
    const adminId = randomUUID();
    await db.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
    await db.insertInto("admin_user").values({
      id: adminId, enterprise_id: enterpriseId, username: name,
      display_name: name.toUpperCase(), password_hash: "test",
    }).execute();
    const provider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: name, name, adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();
    const resource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.id, name: `${name} API`,
      mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    return { pg, db, enterpriseId, adminId, providerId: provider.id, apiResourceId: resource.id };
  }

  function candidateValues(enterpriseId: string, adminId: string, overrides: Record<string, unknown> = {}) {
    const createdAt = new Date("2026-09-21T10:00:00.000Z");
    return {
      enterprise_id: enterpriseId,
      candidate_hash: "a".repeat(64),
      fact_watermark_hash: "b".repeat(64),
      decision: "GO_CANDIDATE",
      status: "PREVIEWED",
      // jsonb 数组需显式 JSON 序列化（pg 会把 JS 数组当作 Postgres 数组字面量）
      gap_summary: JSON.stringify([]) as unknown as Array<{ code: string; count: number }>,
      projection_summary: {} as never,
      usage_repair_baseline: [] as never,
      // 0079：候选草稿载荷必须随候选一起落库（activate 合同不接受草稿）
      candidate_draft: JSON.stringify(emptyDraft()) as never,
      created_by_admin_user_id: adminId,
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + 1_800_000),
      ...overrides,
    };
  }

  it("候选 TTL 固定 30 分钟、状态白名单不含 ACTIVATING、终态不可修改", async () => {
    const { pg, db, enterpriseId, adminId } = await bootstrap("pfinit_candidate");
    try {
      const created = await db.insertInto("provider_finance_activation_attempt")
        .values(candidateValues(enterpriseId, adminId))
        .returning(["id", "expires_at"]).executeTakeFirstOrThrow();
      expect(created.expires_at.toISOString()).toBe("2026-09-21T10:30:00.000Z");

      // TTL 必须严格等于 30 分钟，禁止滑动续期
      await expect(db.updateTable("provider_finance_activation_attempt")
        .set({ expires_at: new Date("2026-09-21T10:31:00.000Z") })
        .where("id", "=", created.id).execute()).rejects.toThrow();

      // 不存在持久化 ACTIVATING 状态
      await expect(db.updateTable("provider_finance_activation_attempt")
        .set({ status: "ACTIVATING" })
        .where("id", "=", created.id).execute()).rejects.toThrow();

      // 只能 PREVIEWED → ACTIVATED，且必须同时写入激活事实
      await expect(db.updateTable("provider_finance_activation_attempt")
        .set({ status: "ACTIVATED" })
        .where("id", "=", created.id).execute()).rejects.toThrow();

      const activated = await db.updateTable("provider_finance_activation_attempt")
        .set({
          status: "ACTIVATED",
          activation_idempotency_key: "activate-1",
          activation_result: { candidateId: created.id },
          activated_by_admin_user_id: adminId,
          activated_at: new Date("2026-09-21T10:05:00.000Z"),
        })
        .where("id", "=", created.id).returning(["id", "status"]).executeTakeFirstOrThrow();
      expect(activated.status).toBe("ACTIVATED");

      // ACTIVATED 为不可修改终态
      await expect(db.updateTable("provider_finance_activation_attempt")
        .set({ status: "EXPIRED" })
        .where("id", "=", created.id).execute()).rejects.toThrow();
      await expect(db.deleteFrom("provider_finance_activation_attempt")
        .where("id", "=", created.id).execute()).rejects.toThrow();

      // PREVIEWED 候选不可被直接改写为非法状态
      const second = await db.insertInto("provider_finance_activation_attempt")
        .values(candidateValues(enterpriseId, adminId, { candidate_hash: "c".repeat(64) }))
        .returning(["id"]).executeTakeFirstOrThrow();
      await expect(db.updateTable("provider_finance_activation_attempt")
        .set({ status: "PREVIEWED", candidate_hash: "d".repeat(64) })
        .where("id", "=", second.id).execute()).rejects.toThrow();
    } finally {
      await db.destroy(); await pg.stop();
    }
  }, 120_000);

  it("企业级激活幂等键唯一，且预检候选不进入资金事实表", async () => {
    const { pg, db, enterpriseId, adminId } = await bootstrap("pfinit_idempotency");
    try {
      const repo = new ProviderFinanceActivationRepository(db);
      const first = await repo.recordPreviewCandidate({
        enterpriseId, adminId, candidateHash: "1".repeat(64), factWatermarkHash: "2".repeat(64),
        decision: "GO_CANDIDATE", gaps: [], gapSummary: [],
        projection: {
          accounts: [], monthsChecked: ["2026-09"], tokenConserved: true,
          codingPlanUsageAttributed: true, operatingBillsComplete: true,
        },
        usageRepairBaseline: [{
          ledgerLineId: "00000000-0000-4000-8000-000000000001",
          eligibleRepairs: ["settled_at", "api_cost_currency"],
          targetFieldsBeforeHash: "e".repeat(64), nonTargetFieldsBeforeHash: "f".repeat(64),
        }],
        candidateDraft: emptyDraft(),
        previewCommittedAt: new Date("2026-09-21T10:00:00.000Z"),
      });
      expect(first.status).toBe("PREVIEWED");
      expect(first.expiresAt).toBe("2026-09-21T10:30:00.000Z");
      expect(first.usageRepairBaseline).toHaveLength(1);

      const loaded = await repo.loadLatestCandidate(enterpriseId);
      expect(loaded?.candidateId).toBe(first.candidateId);
      expect(repo.assertCandidateUsable(loaded, new Date("2026-09-21T10:29:59.000Z")).candidateId)
        .toBe(first.candidateId);
      expect(() => repo.assertCandidateUsable(loaded, new Date("2026-09-21T10:30:00.000Z")))
        .toThrowError(/候选已过期/);

      await db.updateTable("provider_finance_activation_attempt").set({
        status: "ACTIVATED", activation_idempotency_key: "activate-1",
        activation_result: { candidateId: first.candidateId } as never, activated_by_admin_user_id: adminId,
        activated_at: new Date("2026-09-21T10:01:00.000Z"),
      }).where("id", "=", first.candidateId).execute();

      const replay = await repo.findActivationByIdempotencyKey(enterpriseId, "activate-1");
      expect(replay?.status).toBe("ACTIVATED");
      expect(await repo.findActivatedCandidate(enterpriseId)).not.toBeNull();
      // 已激活候选不得再次用于激活（幂等重放由激活结果快照负责）
      expect(() => repo.assertCandidateUsable(replay, new Date("2026-09-21T10:02:00.000Z")))
        .toThrowError(/已经完成激活/);

      const second = await repo.recordPreviewCandidate({
        enterpriseId, adminId, candidateHash: "3".repeat(64), factWatermarkHash: "4".repeat(64),
        decision: "GO_CANDIDATE", gaps: [], gapSummary: [], projection: {
          accounts: [], monthsChecked: [], tokenConserved: true,
          codingPlanUsageAttributed: true, operatingBillsComplete: true,
        },
        usageRepairBaseline: [], candidateDraft: emptyDraft(),
        previewCommittedAt: new Date("2026-09-21T10:05:00.000Z"),
      });
      await expect(db.updateTable("provider_finance_activation_attempt").set({
        status: "ACTIVATED", activation_idempotency_key: "activate-1",
        activation_result: {}, activated_by_admin_user_id: adminId, activated_at: new Date(),
      }).where("id", "=", second.candidateId).execute()).rejects.toThrow();

      const facts = await db.selectFrom("provider_finance_event")
        .select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirst();
      expect(facts?.count).toBe("0");
    } finally {
      await db.destroy(); await pg.stop();
    }
  }, 120_000);

  it("静默租约上限 60 分钟、审计留痕、到期自动失效且不可复活", async () => {
    const { pg, db, enterpriseId, adminId } = await bootstrap("pfinit_quiescence");
    try {
      const repo = new ProviderFinanceActivationRepository(db);
      const started = await repo.startQuiescenceLease({
        enterpriseId, adminId, now: new Date("2026-09-21T10:00:00.000Z"),
      });
      expect(started.status).toBe("ACTIVE");
      expect(started.expiresAt).toBe("2026-09-21T11:00:00.000Z");
      await expect(repo.startQuiescenceLease({
        enterpriseId, adminId, now: new Date("2026-09-21T10:00:00.000Z"), durationSeconds: 3601,
      })).rejects.toThrowError(/静默租约时长/);

      const active = await repo.evaluateQuiescence(enterpriseId, new Date("2026-09-21T10:30:00.000Z"));
      expect(active.active).toBe(true);
      expect(active.remainingSeconds).toBe(1800);
      expect(active.insufficientForActivation).toBe(false);

      const expiring = await repo.evaluateQuiescence(enterpriseId, new Date("2026-09-21T10:58:00.000Z"));
      expect(expiring.insufficientForActivation).toBe(true);

      // 有效期内可显式解除
      await repo.releaseQuiescenceLease(enterpriseId, adminId, "范围变更，重新预检",
        new Date("2026-09-21T10:59:00.000Z"));
      const released = await db.selectFrom("provider_finance_activation_quiescence")
        .selectAll().where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
      expect(released.status).toBe("RELEASED");
      expect(released.release_reason).toBe("范围变更，重新预检");
      expect((await repo.evaluateQuiescence(enterpriseId)).active).toBe(false);

      // 重新建立租约后到期由服务端时间自动失效，且过期租约不可复活
      await repo.startQuiescenceLease({
        enterpriseId, adminId, now: new Date("2026-09-21T10:00:00.000Z"),
      });
      const expired = await repo.evaluateQuiescence(enterpriseId, new Date("2026-09-21T11:00:01.000Z"));
      expect(expired.active).toBe(false);
      expect(expired.lease?.status).toBe("EXPIRED");
      const afterExpiry = await db.selectFrom("provider_finance_activation_quiescence")
        .selectAll().where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
      expect(afterExpiry.status).toBe("EXPIRED");
      expect(afterExpiry.released_at).toBeNull();
      await expect(repo.releaseQuiescenceLease(enterpriseId, adminId, "过期后解除"))
        .rejects.toThrowError(/未处于有效状态/);

      const audits = await db.selectFrom("operation_log").select(["action", "result"])
        .where("enterprise_id", "=", enterpriseId)
        .where("action", "like", "provider_finance.activation_quiescence.%").execute();
      expect(audits.map((item) => item.action).sort())
        .toEqual([
          "provider_finance.activation_quiescence.expire",
          "provider_finance.activation_quiescence.release",
          "provider_finance.activation_quiescence.start",
          "provider_finance.activation_quiescence.start",
        ]);

      await expect(repo.releaseQuiescenceLease(enterpriseId, adminId, "   "))
        .rejects.toThrowError(/原因/);
    } finally {
      await db.destroy(); await pg.stop();
    }
  }, 120_000);

  it("资源资金状态：新 API 资源在已激活企业下默认 PENDING，未激活则不纳入门禁", async () => {
    const { pg, db, enterpriseId, adminId, providerId, apiResourceId } = await bootstrap("pfinit_resource_state");
    try {
      const repo = new ProviderFinanceActivationRepository(db);
      expect(await repo.loadResourceFinanceState(enterpriseId, apiResourceId)).toBeNull();

      // 未激活企业：新建 API 资源不纳入资金门禁（保持既有行为）
      const beforeActivation = await db.insertInto("provider_resource").values({
        enterprise_id: enterpriseId, provider_id: providerId, name: "未激活期资源",
        mode: "API", credential_type: "API_KEY",
      }).returning("id").executeTakeFirstOrThrow();
      expect(await repo.loadResourceFinanceState(enterpriseId, beforeActivation.id)).toBeNull();

      await db.insertInto("provider_finance_runtime_state").values({
        enterprise_id: enterpriseId, strict_writes_enabled: true,
        activated_at: new Date("2026-09-21T10:00:00.000Z"), activated_by_admin_user_id: adminId,
      }).execute();

      const afterActivation = await db.insertInto("provider_resource").values({
        enterprise_id: enterpriseId, provider_id: providerId, name: "激活后资源",
        mode: "API", credential_type: "API_KEY",
      }).returning("id").executeTakeFirstOrThrow();
      const seeded = await repo.loadResourceFinanceState(enterpriseId, afterActivation.id);
      expect(seeded?.state).toBe("PENDING");
      expect(seeded?.requiredCurrencies).toEqual([]);
      expect(await repo.isResourceFinancePending(enterpriseId, afterActivation.id)).toBe(true);
      expect((await repo.listPendingResources(enterpriseId)).map((item) => item.resourceId))
        .toEqual([afterActivation.id]);

      // Coding Plan 资源不纳入 API 资金就绪门禁
      const codingPlan = await db.insertInto("provider_resource").values({
        enterprise_id: enterpriseId, provider_id: providerId, name: "激活后套餐资源",
        mode: "CODING_PLAN", credential_type: "API_KEY",
      }).returning("id").executeTakeFirstOrThrow();
      expect(await repo.loadResourceFinanceState(enterpriseId, codingPlan.id)).toBeNull();

      // 就绪登记：必须至少一个必备币种
      await expect(repo.markResourceFinanceReady({
        enterpriseId, resourceId: afterActivation.id, adminId,
        requiredCurrencies: [], now: new Date("2026-09-21T10:10:00.000Z"),
      })).rejects.toThrowError(/必要币种/);
      const ready = await repo.markResourceFinanceReady({
        enterpriseId, resourceId: afterActivation.id, adminId,
        requiredCurrencies: ["CNY"], now: new Date("2026-09-21T10:10:00.000Z"),
      });
      expect(ready.state).toBe("READY");
      expect(ready.version).toBe(2);
      expect(await repo.isResourceFinancePending(enterpriseId, afterActivation.id)).toBe(false);

      // 乐观并发版本冲突
      await expect(repo.markResourceFinanceReady({
        enterpriseId, resourceId: afterActivation.id, adminId,
        requiredCurrencies: ["USD"], now: new Date("2026-09-21T10:11:00.000Z"), expectedVersion: 1,
      })).rejects.toBeDefined();

      // 未纳入门禁的资源禁止登记就绪
      await expect(repo.markResourceFinanceReady({
        enterpriseId, resourceId: beforeActivation.id, adminId,
        requiredCurrencies: ["CNY"], now: new Date("2026-09-21T10:12:00.000Z"),
      })).rejects.toThrowError(/未纳入资金门禁/);

      // 形状约束：PENDING 不得带就绪信息，READY 不得缺少就绪信息与管理员
      const pendingResource = await db.insertInto("provider_resource").values({
        enterprise_id: enterpriseId, provider_id: providerId, name: "待就绪资源",
        mode: "API", credential_type: "API_KEY",
      }).returning("id").executeTakeFirstOrThrow();
      await expect(db.updateTable("provider_resource_finance_state")
        .set({ ready_at: new Date() })
        .where("provider_resource_id", "=", pendingResource.id).execute()).rejects.toBeDefined();
      await expect(db.updateTable("provider_resource_finance_state")
        .set({ state: "READY" })
        .where("provider_resource_id", "=", pendingResource.id).execute()).rejects.toBeDefined();
      await expect(db.updateTable("provider_resource_finance_state")
        .set({ version: 0 })
        .where("provider_resource_id", "=", afterActivation.id).execute()).rejects.toBeDefined();
    } finally {
      await db.destroy(); await pg.stop();
    }
  }, 120_000);

  it("Gateway 可服务资源排除 PENDING，就绪后恢复；存在激活事实时拒绝回退", async () => {
    const { pg, db, enterpriseId, adminId, providerId, apiResourceId } = await bootstrap("pfinit_servable");
    try {
      const activationRepo = new ProviderFinanceActivationRepository(db);
      await db.insertInto("provider_finance_runtime_state").values({
        enterprise_id: enterpriseId, strict_writes_enabled: true,
        activated_at: new Date("2026-09-21T10:00:00.000Z"), activated_by_admin_user_id: adminId,
      }).execute();
      const gated = await db.insertInto("provider_resource").values({
        enterprise_id: enterpriseId, provider_id: providerId, name: "门禁资源",
        mode: "API", credential_type: "API_KEY", status: "ACTIVE",
      }).returning("id").executeTakeFirstOrThrow();

      const { ResourcePoolRepository } = await import("../repositories/resource-pool-repository.js");
      const pool = new ResourcePoolRepository(db);
      const beforeReady = await pool.listServableResources(enterpriseId);
      expect(beforeReady.map((item) => item.id).sort()).toEqual([apiResourceId].sort());

      await activationRepo.markResourceFinanceReady({
        enterpriseId, resourceId: gated.id, adminId, requiredCurrencies: ["CNY"],
        now: new Date("2026-09-21T10:10:00.000Z"),
      });
      const afterReady = await pool.listServableResources(enterpriseId);
      expect(afterReady.map((item) => item.id).sort()).toEqual([apiResourceId, gated.id].sort());

      // 存在已激活候选 / 就绪事实时，0078 回退必须被拒绝并保留证据。
      // 回归（I1 复审 P2-2）：0079 的 down 曾无守卫直接 DROP candidate_draft——
      // 已激活候选的草稿列是候选哈希复算输入，删除等于篡改激活事实。
      // 现在存在 ACTIVATED 候选时 0079 回退同样必须被拒绝（失败关闭）；
      // 仅 PREVIEWED 候选时才可回退，回退后 0078 被就绪事实挡住。
      await db.insertInto("provider_finance_activation_attempt")
        .values(candidateValues(enterpriseId, adminId, {
          status: "ACTIVATED",
          activation_idempotency_key: "p2-2-activated",
          activation_result: { candidateId: "p2-2" } as never,
          activated_by_admin_user_id: adminId,
          activated_at: new Date("2026-09-21T10:05:00.000Z"),
        })).execute();
      // 当前迁移头为 0083（资金集成追加）。先安全回退 0083，使 0082 成为最后已应用
      // 迁移，再验证其 down 的 ACTIVATED 守卫拒绝；随后 0082 down 成功、0081 被
      // 就绪事实挡住的语义保持不变。
      await rollbackTo(db, "0083_provider_finance_resource_opening_trigger");
      await expect(migrateDown(db)).rejects.toThrow(/0079 rollback blocked/);
      // 被守卫拒绝后，草稿列与已激活候选必须原样保留。
      const draftColumnAfterBlock = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM information_schema.columns
         WHERE table_name = 'provider_finance_activation_attempt'
           AND column_name = 'candidate_draft'`.execute(db);
      expect(draftColumnAfterBlock.rows[0]?.count).toBe("1");
      const activatedCount = await db.selectFrom("provider_finance_activation_attempt")
        .select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirst();
      expect(activatedCount?.count).toBe("1");

      // 把候选改回可回退状态（通过直接 SQL 绕过触发器只为本测试服务）后，
      // 0079 可以回退；随后 0078 必须被就绪事实挡住。
      await sql`
        ALTER TABLE provider_finance_activation_attempt DISABLE TRIGGER USER
      `.execute(db);
      await db.deleteFrom("provider_finance_activation_attempt").execute();
      await sql`
        ALTER TABLE provider_finance_activation_attempt ENABLE TRIGGER USER
      `.execute(db);
      expect(await migrateDown(db)).toBe("0082_provider_finance_candidate_draft");
      const draftColumn = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM information_schema.columns
         WHERE table_name = 'provider_finance_activation_attempt'
           AND column_name = 'candidate_draft'`.execute(db);
      expect(draftColumn.rows[0]?.count).toBe("0");
      await expect(migrateDown(db)).rejects.toThrow(/rollback blocked/);
      const candidateTable = await db.selectFrom("provider_finance_activation_attempt")
        .select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirst();
      expect(candidateTable?.count).toBe("0");
    } finally {
      await db.destroy(); await pg.stop();
    }
  }, 120_000);
});
