import { sql, type Kysely } from "kysely";
import {
  ACTIVATION_QUIESCENCE_MIN_REMAINING_SECONDS,
  evaluateQuiescenceLease,
  type QuiescenceEvaluation,
} from "@qianliu/domain";
import type { Database } from "../kysely.js";

/**
 * 企业级静默租约的跨服务只读门禁（WP04 任务 4.5；PFA-09）。
 *
 * 为什么单独成模块：Gateway admission 与 Worker 定时任务不能实例化 Control API 的仓储，
 * 但必须与 Control API 用**同一套**判定语义（服务器时间、`ACTIVE AND expires_at > now`、
 * 到期自动失效）。任何一处另写一套时间比较都会造成"控制面以为已静默、数据面仍在写入"。
 *
 * 本模块只读：不写审计、不改租约状态。惰性标记 `EXPIRED` 与开始/解除/到期审计仍由
 * `ProviderFinanceActivationRepository` 在控制路径上完成。到期自动恢复流量即由
 * "`expires_at <= now` 一律视为失效"这个纯时间判定实现。
 */

export interface QuiescenceGate {
  /** 该企业当前是否被静默门禁拦下（租约 `ACTIVE` 且未到期）。 */
  quiescent: boolean;
  /** 生效中的租约到期时间；无有效租约时为 null。 */
  expiresAt: string | null;
  /** 距离到期的剩余秒数；无有效租约时为 0。 */
  remainingSeconds: number;
  /** 剩余时间是否已不足激活下限（5 分钟）。无有效租约时为 false。 */
  insufficientForActivation: boolean;
}

const NOT_QUIESCENT: QuiescenceGate = {
  quiescent: false, expiresAt: null, remainingSeconds: 0, insufficientForActivation: false,
};

/** 单条主键查询，供 Gateway 热路径使用；无租约时不产生任何写入。 */
export async function loadQuiescenceGate(
  db: Kysely<Database>, enterpriseId: string, now: Date = new Date(),
): Promise<QuiescenceGate> {
  const row = await db.selectFrom("provider_finance_activation_quiescence")
    .select(["status", "expires_at"])
    .where("enterprise_id", "=", enterpriseId)
    .executeTakeFirst();
  if (!row || row.status !== "ACTIVE") return NOT_QUIESCENT;
  return gateFromLease({ status: row.status, expiresAt: row.expires_at.toISOString() }, now);
}

/**
 * Gateway admission 专用：只回答"是否拦截"，避免热路径上构造完整评估对象。
 */
export async function isEnterpriseQuiescent(
  db: Kysely<Database>, enterpriseId: string, now: Date = new Date(),
): Promise<boolean> {
  return (await loadQuiescenceGate(db, enterpriseId, now)).quiescent;
}

/**
 * Worker 批量门禁：列出当前全部处于有效静默租约内的企业。
 * 用于"跳过该企业自动续订与会改变候选事实的任务"。
 */
export async function listQuiescentEnterpriseIds(
  db: Kysely<Database>, now: Date = new Date(),
): Promise<string[]> {
  const rows = await sql<{ enterprise_id: string }>`
    SELECT enterprise_id FROM provider_finance_activation_quiescence
     WHERE status = 'ACTIVE' AND expires_at > ${now}
     ORDER BY enterprise_id`.execute(db);
  return rows.rows.map((row) => row.enterprise_id);
}

function gateFromLease(
  lease: { status: "ACTIVE" | "RELEASED" | "EXPIRED"; expiresAt: string },
  now: Date,
): QuiescenceGate {
  const evaluation: QuiescenceEvaluation = evaluateQuiescenceLease(
    { status: lease.status, expiresAt: lease.expiresAt },
    now,
    ACTIVATION_QUIESCENCE_MIN_REMAINING_SECONDS,
  );
  return {
    quiescent: evaluation.active,
    expiresAt: evaluation.active ? lease.expiresAt : null,
    remainingSeconds: evaluation.active ? evaluation.remainingSeconds : 0,
    insufficientForActivation: evaluation.active && evaluation.insufficientForActivation,
  };
}
