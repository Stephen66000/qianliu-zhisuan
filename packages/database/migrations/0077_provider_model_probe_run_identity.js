/**
 * 0077：探针 run 身份原子化（P2 整改 → 终审整改三非破坏化改写）。
 *
 * 背景：recordModelProbeRun 原实现为 select-then-insert + catch(() => null)：
 * 并发飞行（ad-hoc 检测 / onboard / sync 同键并发）下两个事务可同时通过
 * SELECT 检查后双双 INSERT，造成重复 run 与重复明细；写入错误又被静默吞掉。
 *
 * 变更：
 * - 为 (enterprise_id, idempotency_key) 增加唯一约束，run 身份原子化。
 *   idempotency_key 由调用方构造为 requestHash:discoveredAt，其中 request_hash
 *   覆盖 凭证指纹 + endpoint scope/host + 官方目录哈希 + 模型集——run 身份
 *   因此完全由 request_hash 派生，Key/端点/目录任一变化即新 run。
 * - 终审整改三：本迁移必须保持纯加法，不得删除任何探针审计证据。
 *   应用前先做 fail-closed 预检：若发现同 (enterprise_id, idempotency_key)
 *   的重复 run，迁移直接失败并保留全部数据，由运维人工甄别合并后重试；
 *   绝不自动 DELETE。0076 与本迁移同版本首次发布（分支未发布，无已应用
 *   环境），预检正常情况下恒为空；保留预检仅作防御。
 *
 * 0076 的防回滚门禁（存在证据拒绝 down）不受影响：本迁移 down 仅删约束。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // fail-closed 预检：存在重复 run 时拒绝执行并完整保留证据，绝不删除。
  const result = await sql`
    SELECT count(*)::int AS duplicate_groups
    FROM (
      SELECT 1 FROM provider_model_probe_run
      GROUP BY enterprise_id, idempotency_key
      HAVING count(*) > 1
    ) duplicates`.execute(db);
  const duplicateGroups = Number(result.rows?.[0]?.duplicate_groups ?? 0);
  if (duplicateGroups > 0) {
    throw new Error(
      `0077 refused to run: ${duplicateGroups} duplicate (enterprise_id, idempotency_key) ` +
      "probe run group(s) detected. Probe evidence is never deleted by this migration; " +
      "preserve/merge the duplicate runs manually, then retry.",
    );
  }
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
