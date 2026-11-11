/** WP3 task 3.2：官方余额手动刷新请求（0096 表）——在途租约/幂等重放/终态收敛。 */
import { sql, type Generated, type Kysely, type Selectable } from "kysely";
import type { Database } from "../kysely.js";

export interface ProviderResourceBalanceRefreshTable {
  id: Generated<string>; enterprise_id: string; provider_resource_id: string;
  actor_admin_id: string; idempotency_key: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  error_code: string | null;
  started_at: Generated<Date>; finished_at: Date | null; expires_at: Date;
  created_at: Generated<Date>; updated_at: Generated<Date>;
}
export type ProviderBalanceRefreshRow = Selectable<ProviderResourceBalanceRefreshTable>;

/** begin 的拒绝态：cooldown（最近 attempt started_at + P3 内）/ in_progress（RUNNING 在途）。 */
export class OfficialBalanceRefreshConflict extends Error {
  constructor(
    readonly code: "in_progress" | "cooldown",
    readonly retryAfterSeconds: number,
  ) {
    super(`official_balance_refresh_${code}`);
    this.name = "OfficialBalanceRefreshConflict";
  }
}

export interface OfficialBalanceRefreshBeginInput {
  enterpriseId: string; resourceId: string; actorAdminId: string; idempotencyKey: string;
  cooldownMs: number; leaseMs: number; now: Date;
}

function secondsUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

function isUniqueViolation(cause: unknown): boolean {
  let current: unknown = cause;
  while (current !== null && current !== undefined) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 与 credential_chat_probe（0073）同款模式：
 * - begin：收敛过期 RUNNING → 幂等重放 → 在途检查（RUNNING 部分唯一索引兜底并发）
 *   → 冷却检查（最近 attempt started_at + P3，任意 outcome、含周期同步产生的行）
 *   → 插入 RUNNING 行。
 * - finish：仅 RUNNING 行可置终态（被并发收敛的行不动）。
 */
export class OfficialBalanceRefreshRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * 进程崩溃残留的 RUNNING 按 expires_at 租约收敛为 FAILED（非证据，可安全覆盖）。
   * R2 根治（R1 复审 C1）：判定基准由宿主时钟 now 改为 DB 侧 now()——expires_at 可能
   * 由 DB 时钟写入（夹具直插/运维修正），宿主-testcontainer 时钟偏移（R8a 实测 ~1.2s）
   * 曾使 DB 侧已过期的租约按宿主时钟判「未过期」而滞留 IN_PROGRESS（AT-X02 三连假阴性）。
   * 判定与留痕（finished_at/updated_at）同用单条 UPDATE 内的 now()，同一 DB 时钟基准；
   * 租约时长（leaseMs）/冷却/幂等/状态机合同不变。
   */
  private async convergeExpiredLeases(resourceId: string): Promise<void> {
    await this.db.updateTable("provider_resource_balance_refresh")
      .set({ status: "FAILED", error_code: "REFRESH_LEASE_EXPIRED",
        finished_at: sql`now()`, updated_at: sql`now()` })
      .where("provider_resource_id", "=", resourceId)
      .where("status", "=", "RUNNING")
      .where(sql<boolean>`expires_at <= now()`)
      .execute();
  }

  async begin(
    input: OfficialBalanceRefreshBeginInput,
  ): Promise<{ row: ProviderBalanceRefreshRow; replay: boolean }> {
    const { now } = input;
    await this.convergeExpiredLeases(input.resourceId);

    // 幂等重放：同键历史请求直接复用既有结果，不触达上游、不受冷却影响。
    const prior = await this.db.selectFrom("provider_resource_balance_refresh")
      .selectAll()
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .where("idempotency_key", "=", input.idempotencyKey)
      .orderBy("started_at", "desc")
      .executeTakeFirst();
    if (prior) {
      if (prior.status === "RUNNING") {
        throw new OfficialBalanceRefreshConflict("in_progress", secondsUntil(prior.expires_at, now));
      }
      return { row: prior, replay: true };
    }

    // 在途：同资源已有 RUNNING（并发第二请求识别在途）。
    const running = await this.db.selectFrom("provider_resource_balance_refresh")
      .selectAll()
      .where("provider_resource_id", "=", input.resourceId)
      .where("status", "=", "RUNNING")
      .executeTakeFirst();
    if (running) {
      throw new OfficialBalanceRefreshConflict("in_progress", secondsUntil(running.expires_at, now));
    }

    // 冷却：最近一次同步尝试（任意 outcome、手动或周期产生）started_at 距 now < P3。
    const latestAttempt = await this.db.selectFrom("provider_resource_operating_sync_attempt")
      .select("started_at")
      .where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .orderBy("started_at", "desc").orderBy("created_at", "desc")
      .executeTakeFirst();
    if (latestAttempt) {
      const elapsed = now.getTime() - latestAttempt.started_at.getTime();
      if (elapsed >= 0 && elapsed < input.cooldownMs) {
        throw new OfficialBalanceRefreshConflict(
          "cooldown",
          Math.max(1, Math.ceil(
            (latestAttempt.started_at.getTime() + input.cooldownMs - now.getTime()) / 1000,
          )),
        );
      }
    }

    try {
      const row = await this.db.insertInto("provider_resource_balance_refresh").values({
        enterprise_id: input.enterpriseId,
        provider_resource_id: input.resourceId,
        actor_admin_id: input.actorAdminId,
        idempotency_key: input.idempotencyKey,
        status: "RUNNING",
        error_code: null,
        started_at: now,
        finished_at: null,
        expires_at: new Date(now.getTime() + input.leaseMs),
        updated_at: now,
      }).returningAll().executeTakeFirstOrThrow();
      return { row, replay: false };
    } catch (cause) {
      // 并发竞态兜底：显式检查与插入之间另一请求抢先插入 RUNNING。
      if (isUniqueViolation(cause)) {
        throw new OfficialBalanceRefreshConflict(
          "in_progress", secondsUntil(new Date(now.getTime() + input.leaseMs), now),
        );
      }
      throw cause;
    }
  }

  async finish(input: {
    requestId: string; outcome: "SUCCEEDED" | "FAILED"; errorCode: string | null; now: Date;
  }): Promise<void> {
    await this.db.updateTable("provider_resource_balance_refresh")
      .set({ status: input.outcome, error_code: input.errorCode,
        finished_at: input.now, updated_at: input.now })
      .where("id", "=", input.requestId)
      .where("status", "=", "RUNNING")
      .execute();
  }

  async listLatest(resourceId: string): Promise<ProviderBalanceRefreshRow | undefined> {
    return this.db.selectFrom("provider_resource_balance_refresh")
      .selectAll()
      .where("provider_resource_id", "=", resourceId)
      .orderBy("started_at", "desc")
      .executeTakeFirst();
  }
}
