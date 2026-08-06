#!/usr/bin/env bash
# 清理老员工授权数据（修复版 POOL-033 部署后、重新配置员工前执行）。
#
# 只清员工授权相关数据，保留：
#   - principal / principal_key（Key 字符串不变，员工不用重新领 Key）
#   - provider / provider_resource / unified_model / model_route（厂商资源与模型不动）
#   - operation_log / ai_request / usage 等账本历史（完整保留）
#
# 清理前再备份一次（pre-cleanup-<时间戳>.dump）。
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

current_release="$(cat /Users/stephen/qianliu-current-release.txt)"
stamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-cleanup-${stamp}.dump"
log_file="${current_release}/cleanup-${stamp}.log"
PG_SH='psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

mkdir -p "$backup_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

log "=== 清理前校验：确认在修复版 0039 ==="
latest="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
if test "$latest" != "0039_principal_provider_pool"; then
  log "ABORT: 数据库不在 0039（当前=${latest}），清理脚本仅适用于修复版部署后"
  exit 2
fi
log "数据库在 ${latest}，继续"

log "=== 清理前备份（pre-cleanup）==="
docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
cleanup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
log "cleanup前备份=${backup} sha256=${cleanup_sha}"

log "=== 清理前数据快照（清理前后对比用）==="
before_keys="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_key where status='ACTIVE'\"")"
before_grants="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_grant\"")"
before_models="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from unified_model\"")"
before_routes="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from model_route\"")"
log "清理前：active_keys=${before_keys} grants=${before_grants} unified_models=${before_models} model_routes=${before_routes}"

log "=== 执行清理（单事务）==="
docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH}" <<'SQL'
BEGIN;
-- 清员工授权相关数据
DELETE FROM principal_provider_disabled_model;
DELETE FROM employee_model_rule_assignment;
DELETE FROM employee_model_rule_version WHERE owner_principal_id IS NOT NULL;
DELETE FROM principal_access_idempotency;
DELETE FROM principal_access_config_state;
-- 停用所有池/规则 grant，并清空对应计数器
UPDATE principal_grant SET status='DISABLED', updated_at=now() WHERE pool_model_alias='*' OR authorization_rule_version_id IS NOT NULL;
DELETE FROM quota_counter WHERE grant_id IN (SELECT id FROM principal_grant WHERE status='DISABLED');
-- 清手工基线
DELETE FROM principal_model_manual_authorization;
-- 白名单清空（重新配置时由修复版 refreshKeyModels 重算）
UPDATE principal_key SET allowed_model_ids = '[]';
COMMIT;
SQL

log "=== 清理后校验 ==="
after_keys="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_key where status='ACTIVE'\"")"
after_grants_active="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_grant where status='ACTIVE'\"")"
after_disabled_grants="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_grant where status='DISABLED'\"")"
after_models="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from unified_model\"")"
after_routes="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from model_route\"")"
after_empty_whitelist="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_key where allowed_model_ids = '[]'::jsonb\"")"

log "清理后：active_keys=${after_keys} active_grants=${after_grants_active} disabled_grants=${after_disabled_grants} unified_models=${after_models} model_routes=${after_routes} empty_whitelist_keys=${after_empty_whitelist}"

# 关键断言
test "$after_keys" = "$before_keys"           # Key 行数不变（字符串保留）
test "$after_models" = "$before_models"        # 模型不动
test "$after_routes" = "$before_routes"        # 路由不动
test "$after_grants_active" = "0"              # 授权全停用
log "校验通过：Key/模型/路由保留，授权已清空"

log "COMPLETE cleanup active_keys=${after_keys}（待重新配置）backup=${backup} sha256=${cleanup_sha}"
log "下一步：用修复后的接入配置页给每个员工重新分配厂商额度与型号。"
