/**
 * 0078：探针证据枚举列 CHECK 约束补齐（审核 P3，加法迁移）。
 *
 * 背景：0076 的 endpoint_scope / resource_mode / status 与
 * provider_model_probe_item.validation_status 均为裸 text（弱于 0073 同项目
 * 惯例）。本迁移为四列补 CHECK 约束，值域与 Kysely 类型（ProbeRunEndpointScope、
 * CredentialValidationStatus 等）严格一致：
 * - endpoint_scope：端点策略四值 + 端点歧义兜底 ENDPOINT_SCOPE_AMBIGUOUS；
 * - validation_status：三层状态合同的八个值（含 F-P2-10 落地的 NOT_RUN）。
 *
 * 安全：纯加法（仅 ADD CONSTRAINT），不删除/改写任何探针证据；应用前
 * fail-closed 预检——发现值域外的既有行即拒绝执行并完整保留数据，由运维
 * 人工甄别后重试，绝不自动改写。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // fail-closed 预检：值域外既有行直接拒绝，绝不静默改写或删除证据。
  const runViolations = await sql`
    SELECT count(*)::int AS n FROM provider_model_probe_run
    WHERE endpoint_scope NOT IN ('MODE_SCOPED_CONFIG','ENV','LEGACY_BASE_URL','MODE_DEFAULT','ENDPOINT_SCOPE_AMBIGUOUS')
       OR resource_mode NOT IN ('API','CODING_PLAN')
       OR status NOT IN ('COMPLETED','FAILED')`.execute(db);
  if (Number(runViolations.rows?.[0]?.n ?? 0) > 0) {
    throw new Error(
      "0078 refused to run: provider_model_probe_run contains rows outside the enum domain. " +
      "Probe evidence is never rewritten by this migration; reconcile manually, then retry.",
    );
  }
  const itemViolations = await sql`
    SELECT count(*)::int AS n FROM provider_model_probe_item
    WHERE validation_status NOT IN ('NOT_RUN','READY','AUTH_FAILED','PLAN_NOT_ENTITLED','REQUEST_REJECTED','RATE_LIMITED','UPSTREAM_UNAVAILABLE','NETWORK_FAILED')`.execute(db);
  if (Number(itemViolations.rows?.[0]?.n ?? 0) > 0) {
    throw new Error(
      "0078 refused to run: provider_model_probe_item contains rows outside the enum domain. " +
      "Probe evidence is never rewritten by this migration; reconcile manually, then retry.",
    );
  }
  await sql`
    ALTER TABLE provider_model_probe_run
    ADD CONSTRAINT provider_model_probe_run_endpoint_scope_check
    CHECK (endpoint_scope IN ('MODE_SCOPED_CONFIG','ENV','LEGACY_BASE_URL','MODE_DEFAULT','ENDPOINT_SCOPE_AMBIGUOUS'))`.execute(db);
  await sql`
    ALTER TABLE provider_model_probe_run
    ADD CONSTRAINT provider_model_probe_run_resource_mode_check
    CHECK (resource_mode IN ('API','CODING_PLAN'))`.execute(db);
  await sql`
    ALTER TABLE provider_model_probe_run
    ADD CONSTRAINT provider_model_probe_run_status_check
    CHECK (status IN ('COMPLETED','FAILED'))`.execute(db);
  await sql`
    ALTER TABLE provider_model_probe_item
    ADD CONSTRAINT provider_model_probe_item_validation_status_check
    CHECK (validation_status IN ('NOT_RUN','READY','AUTH_FAILED','PLAN_NOT_ENTITLED','REQUEST_REJECTED','RATE_LIMITED','UPSTREAM_UNAVAILABLE','NETWORK_FAILED'))`.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`ALTER TABLE provider_model_probe_item DROP CONSTRAINT IF EXISTS provider_model_probe_item_validation_status_check`.execute(db);
  await sql`ALTER TABLE provider_model_probe_run DROP CONSTRAINT IF EXISTS provider_model_probe_run_status_check`.execute(db);
  await sql`ALTER TABLE provider_model_probe_run DROP CONSTRAINT IF EXISTS provider_model_probe_run_resource_mode_check`.execute(db);
  await sql`ALTER TABLE provider_model_probe_run DROP CONSTRAINT IF EXISTS provider_model_probe_run_endpoint_scope_check`.execute(db);
}
