/**
 * 0077：探针 run 身份原子化（P2 整改，加法迁移）。
 *
 * 背景：recordModelProbeRun 原实现为 select-then-insert + catch(() => null)：
 * 并发飞行（ad-hoc 检测 / onboard / sync 同键并发）下两个事务可同时通过
 * SELECT 检查后双双 INSERT，造成重复 run 与重复明细；写入错误又被静默吞掉。
 *
 * 变更：
 * - 去重历史重复 run（按 (enterprise_id, idempotency_key) 保留 started_at/id
 *   最早一条，重复 run 的明细级联删除）；
 * - 为 (enterprise_id, idempotency_key) 增加唯一约束，run 身份原子化。
 *   idempotency_key 由调用方构造为 requestHash:discoveredAt，其中 request_hash
 *   覆盖 凭证指纹 + endpoint scope/host + 官方目录哈希 + 模型集——run 身份
 *   因此完全由 request_hash 派生，Key/端点/目录任一变化即新 run。
 *
 * 0076 的防回滚门禁（存在证据拒绝 down）不受影响：本迁移 down 仅删约束。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // 先清历史重复明细（0076 与本迁移同版本发布，生产尚无数据；防御性去重）。
  await sql`
    DELETE FROM provider_model_probe_item WHERE probe_run_id IN (
      SELECT r.id FROM provider_model_probe_run r
      WHERE EXISTS (
        SELECT 1 FROM provider_model_probe_run r2
        WHERE r2.enterprise_id = r.enterprise_id
          AND r2.idempotency_key = r.idempotency_key
          AND (r2.started_at, r2.id) < (r.started_at, r.id)
      )
    )`.execute(db);
  await sql`
    DELETE FROM provider_model_probe_run r
    WHERE EXISTS (
      SELECT 1 FROM provider_model_probe_run r2
      WHERE r2.enterprise_id = r.enterprise_id
        AND r2.idempotency_key = r.idempotency_key
        AND (r2.started_at, r2.id) < (r.started_at, r.id)
    )`.execute(db);
  await sql`
    ALTER TABLE provider_model_probe_run
    ADD CONSTRAINT provider_model_probe_run_idem_uniq
    UNIQUE (enterprise_id, idempotency_key)`.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    ALTER TABLE provider_model_probe_run
    DROP CONSTRAINT IF EXISTS provider_model_probe_run_idem_uniq`.execute(db);
}
