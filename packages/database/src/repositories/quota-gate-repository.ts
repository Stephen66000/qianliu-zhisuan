/**
 * 额度门禁仓储（W14）—— 预占/结算/并发租约的落库侧。
 *
 * 依据：TRD §5.5（quota_counter）、§5.4 行 247（并发上限）、§8 行 504（预占额度/并发租约）。
 *
 * 职责边界：
 *   - 判定规则在 @qianliu/domain（quota-gate.ts 纯函数）；
 *   - 本仓储做：查 grant+counter（行锁）→ 预占（used += estimated）→ 结算校正（按实际）→
 *     并发租约获取（活跃数 < limit，行锁防穿透）/释放。
 *   - 并发不穿透：PostgreSQL 行锁（W14 离线可测）；Redis 短期计数在 W25 叠加。
 */
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import {
  evaluateQuotaGate,
  settleQuota,
  QUOTA_DECISION,
  type QuotaDecision,
  type QuotaGateResult,
} from "@qianliu/domain";

export interface QuotaReserveOutcome {
  decision: QuotaDecision;
  grantId: string | null;
  /** 预占的预估值（结算时按实际校正）。 */
  reservedEstimate: bigint;
  gate: QuotaGateResult;
}

export class QuotaGateRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * 模型调用授权门禁（API / CODING_PLAN 共用）。
   * 不做缓存，每次直接查库，使 grant 停用、过期或撤权在下一请求即时生效。
   */
  async hasActiveGrant(input: {
    enterpriseId: string;
    principalId: string;
    provider: string;
    modelAlias: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const grant = await this.db
      .selectFrom("principal_grant")
      .select("id")
      .where("enterprise_id", "=", input.enterpriseId)
      .where("principal_id", "=", input.principalId)
      .where("provider", "=", input.provider)
      .where("model_alias", "=", input.modelAlias)
      .where("status", "=", "ACTIVE")
      .where("valid_from", "<=", now)
      .where((eb) => eb.or([
        eb("valid_until", "is", null),
        eb("valid_until", ">", now),
      ]))
      .executeTakeFirst();
    return Boolean(grant);
  }

  /**
   * 额度预占（行锁防并发穿透）。
   * 查 principal 在该 provider+model 的 ACTIVE grant + counter，判定后预占 estimated。
   * REJECT 时不改 counter。返回判定结果 + 预估值（结算用）。
   */
  async reserveQuota(input: {
    enterpriseId: string;
    principalId: string;
    provider: string;
    modelAlias: string;
    estimatedCost: bigint;
    now?: Date;
  }): Promise<QuotaReserveOutcome> {
    const now = input.now ?? new Date();
    return this.db.transaction().execute(async (trx) => {
      const grant = await trx
        .selectFrom("principal_grant")
        .selectAll()
        .where("enterprise_id", "=", input.enterpriseId)
        .where("principal_id", "=", input.principalId)
        .where("provider", "=", input.provider)
        .where("model_alias", "=", input.modelAlias)
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();

      if (!grant) {
        const gate = evaluateQuotaGate({
          hasGrant: false, grantStatus: null, validFrom: null, validUntil: null,
          quotaValue: 0n, usedValue: 0n, estimatedCost: input.estimatedCost,
          allowOverage: false, now: now.getTime(),
        });
        return { decision: gate.decision, grantId: null, reservedEstimate: 0n, gate };
      }

      const counter = await trx
        .selectFrom("quota_counter")
        .selectAll()
        .where("grant_id", "=", grant.id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const gate = evaluateQuotaGate({
        hasGrant: true,
        grantStatus: grant.status as "ACTIVE",
        validFrom: grant.valid_from.getTime(),
        validUntil: grant.valid_until ? grant.valid_until.getTime() : null,
        quotaValue: BigInt(grant.quota_value),
        usedValue: BigInt(counter.used_value),
        estimatedCost: input.estimatedCost,
        allowOverage: grant.allow_overage,
        now: now.getTime(),
      });

      if (gate.decision === QUOTA_DECISION.ALLOW || gate.decision === QUOTA_DECISION.ALLOW_OVERAGE) {
        // 预占：used += estimated；超额部分记 overage_value
        await trx
          .updateTable("quota_counter")
          .set({
            used_value: BigInt(counter.used_value) + input.estimatedCost,
            overage_value: BigInt(counter.overage_value) + gate.overageAmount,
            updated_at: now,
          })
          .where("grant_id", "=", grant.id)
          .execute();
        return { decision: gate.decision, grantId: grant.id, reservedEstimate: input.estimatedCost, gate };
      }
      return { decision: gate.decision, grantId: grant.id, reservedEstimate: 0n, gate };
    });
  }

  /**
   * 结算校正：预占 estimated，实际 actual（deducted_quota）。
   * 多退少补；超额重算（actual 超出 quota 的部分）。
   */
  async settleQuota(grantId: string, estimated: bigint, actual: bigint): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const counter = await trx
        .selectFrom("quota_counter")
        .selectAll()
        .where("grant_id", "=", grantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const grant = await trx
        .selectFrom("principal_grant")
        .selectAll()
        .where("id", "=", grantId)
        .executeTakeFirstOrThrow();
      const newUsed = settleQuota(BigInt(counter.used_value), estimated, actual);
      // 超额 = max(0, newUsed - quota)（allow_overage 时才可能 > 0）
      const overage = newUsed > BigInt(grant.quota_value) ? newUsed - BigInt(grant.quota_value) : 0n;
      await trx
        .updateTable("quota_counter")
        .set({ used_value: newUsed, overage_value: overage, updated_at: new Date() })
        .where("grant_id", "=", grantId)
        .execute();
    });
  }

  /** 释放预占（请求失败/取消未产生实际消耗）：used -= estimated。 */
  async releaseQuota(grantId: string, estimated: bigint): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const counter = await trx
        .selectFrom("quota_counter")
        .selectAll()
        .where("grant_id", "=", grantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const newUsed = BigInt(counter.used_value) - estimated;
      await trx
        .updateTable("quota_counter")
        .set({ used_value: newUsed < 0n ? 0n : newUsed, updated_at: new Date() })
        .where("grant_id", "=", grantId)
        .execute();
    });
  }

  /**
   * 获取资源并发租约（行锁防穿透）。
   * 活跃租约数（released_at IS NULL）>= concurrency_limit 时返回 null（并发满，该资源不可选）。
   */
  async acquireLease(input: {
    enterpriseId: string;
    providerResourceId: string;
    aiRequestId: string;
    leaseTtlMs?: number;
  }): Promise<string | null> {
    return this.db.transaction().execute(async (trx) => {
      const resource = await trx
        .selectFrom("provider_resource")
        .select(["concurrency_limit"])
        .where("id", "=", input.providerResourceId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const limit = resource.concurrency_limit ?? 0;
      if (limit <= 0) {
        // 无并发限制配置：直接发租约（不阻塞）
        const lease = await trx
          .insertInto("concurrency_lease")
          .values({
            enterprise_id: input.enterpriseId,
            provider_resource_id: input.providerResourceId,
            ai_request_id: input.aiRequestId,
            expires_at: new Date(Date.now() + (input.leaseTtlMs ?? 60_000)),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return lease.id;
      }
      const active = await trx
        .selectFrom("concurrency_lease")
        .select((eb) => eb.fn.countAll().as("cnt"))
        .where("provider_resource_id", "=", input.providerResourceId)
        .where("released_at", "is", null)
        .executeTakeFirstOrThrow();
      const activeCount = Number((active as { cnt: bigint | number }).cnt);
      if (activeCount >= limit) return null; // 并发满
      const lease = await trx
        .insertInto("concurrency_lease")
        .values({
          enterprise_id: input.enterpriseId,
          provider_resource_id: input.providerResourceId,
          ai_request_id: input.aiRequestId,
          expires_at: new Date(Date.now() + (input.leaseTtlMs ?? 60_000)),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return lease.id;
    });
  }

  /** 释放租约（Attempt 结束）。 */
  async releaseLease(leaseId: string): Promise<void> {
    await this.db
      .updateTable("concurrency_lease")
      .set({ released_at: new Date() })
      .where("id", "=", leaseId)
      .where("released_at", "is", null)
      .execute();
  }

  /** 恢复任务接口：回收过期未释放的租约（崩溃残留；W25 worker 定时调用）。 */
  async reclaimExpiredLeases(now: Date = new Date()): Promise<number> {
    const result = await this.db
      .updateTable("concurrency_lease")
      .set({ released_at: now })
      .where("expires_at", "<", now)
      .where("released_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  /** 查询资源当前活跃并发数（capacity_headroom 供 W12 评分/W15 预测）。 */
  async activeConcurrency(providerResourceId: string): Promise<number> {
    const row = await this.db
      .selectFrom("concurrency_lease")
      .select((eb) => eb.fn.countAll().as("cnt"))
      .where("provider_resource_id", "=", providerResourceId)
      .where("released_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number((row as { cnt: bigint | number }).cnt);
  }
}
