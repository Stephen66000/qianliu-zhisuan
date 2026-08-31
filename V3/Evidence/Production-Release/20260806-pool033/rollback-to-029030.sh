#!/usr/bin/env bash
# 回滚：POOL-033（迁移 0039、镜像 bf4eb80）→ POOL-029/030（迁移 0038、镜像 9da9ab1）
#
# 回滚资源（部署 POOL-033 时已冻结，均需就位）：
#   - 数据库备份（0038 时刻）：pre-pool033-20260806-174655.dump
#   - 回滚镜像：qianliu-rollback-bf4eb80-{control-api,gateway,web,worker}
#     —— 注意：名字带 bf4eb80，但它是“033 部署前一刻在生产跑着的 029/030 镜像”
#   - pool029030 release 目录（含 deploy/.env）
#
# 与 run-release.sh 对称：set -Eeuo pipefail + trap ERR + 每步校验 + tee 日志。
# 不可逆操作前先做安全网备份；失败时 trap 报告安全网路径供人工恢复。
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

target_release="/Users/stephen/releases/qianliu-zhisuan-pool029030-9da9ab1-20260804"
pre_pool033_backup="/Users/stephen/backups/qianliu-zhisuan/pre-pool033-20260806-174655.dump"
current_release_file="/Users/stephen/qianliu-current-release.txt"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
stamp="$(date '+%Y%m%d-%H%M%S')"
safety_backup="${backup_dir}/pre-rollback-to-029030-${stamp}.dump"
log_file="${target_release}/rollback-to-029030-${stamp}.log"

# pg 操作在容器内用 SH 变量注入，避免本地 psql 凭据依赖。
PG_SH='psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

mkdir -p "$backup_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# 失败时只报告，不自动再动作——回滚的中途失败需要人工判断，
# 自动二次恢复反而可能掩盖真实状态。报告安全网备份路径。
rollback() {
  status=$?
  log "FAILED status=${status} line=${BASH_LINENO[0]}"
  log "数据库可能处于中间状态。安全网备份：${safety_backup}（若已生成）"
  log "回滚未完成，生产仍可能不可用。请人工核对后决定：重试本脚本或从 pre-pool033 备份恢复。"
  exit "$status"
}
trap rollback ERR

# ========== 1. 前置校验 ==========
log "step 1: 前置校验"

test -f "$pre_pool033_backup"
test -s "$pre_pool033_backup"
log "pre-pool033 备份就位：${pre_pool033_backup}"

test -d "${target_release}/deploy"
test -f "${target_release}/deploy/.env"
test -f "${target_release}/deploy/compose.yaml"
log "pool029030 release 目录就位：${target_release}"

current_release="$(cat "$current_release_file")"
case "$current_release" in
  *pool033*) log "当前确在 POOL-033：${current_release}" ;;
  *) log "ABORT: 当前 release 非预期（不是 pool033）：${current_release}"; exit 2 ;;
esac

for service in control-api gateway web worker; do
  docker image inspect "qianliu-rollback-bf4eb80-${service}:latest" >/dev/null
done
log "4 个回滚镜像就位：qianliu-rollback-bf4eb80-{control-api,gateway,web,worker}"

latest_now="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$latest_now" = "0039_principal_provider_pool"
log "数据库当前迁移号=${latest_now}（确在 0039，需回滚到 0038）"

# ========== 2. 安全网备份（回滚的回滚）==========
log "step 2: 安全网备份当前 0039 数据库"
docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$safety_backup"
test -s "$safety_backup"
docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc 'pg_restore -l >/dev/null' < "$safety_backup"
safety_sha="$(shasum -a 256 "$safety_backup" | awk '{print $1}')"
log "安全网备份=${safety_backup} sha256=${safety_sha}"

# ========== 3. 冻结反向镜像（万一要再回 033）==========
log "step 3: 冻结当前 033 镜像为 qianliu-rollback-pool033-*"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-pool033-${service}"
done
log "已冻结 033 反向镜像（control-api/gateway/worker/web）"

# ========== 4. 写暂停（保留 postgres）==========
log "step 4: 暂停写入服务（保留 postgres）"
docker stop \
  qianliu-zhisuan-caddy-1 \
  qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-control-api-1 \
  qianliu-zhisuan-web-1 \
  qianliu-zhisuan-worker-1 >/dev/null
log "已停止 caddy/gateway/control-api/web/worker"

# ========== 5. 恢复数据库到 0038 ==========
# 033 的 down() 在有池数据时抛错禁止回滚，故不走 migrate down，直接 pg_restore 物理覆盖。
log "step 5: 从 pre-pool033 备份恢复数据库到 0038"

# 删除所有现存连接后 DROP/CREATE，避免连接占用导致删除失败。
docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()\"" >/dev/null
docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -c 'DROP DATABASE IF EXISTS \"'\"\\\$POSTGRES_DB\"'\"'" >/dev/null
docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -c 'CREATE DATABASE \"'\"\\\$POSTGRES_DB\"'\"'" >/dev/null

# pg_restore：--no-owner --no-privileges 适配容器内角色；--clean 在空库上会 warn 但安全。
docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --if-exists --clean' < "$pre_pool033_backup"

# 恢复后校验：迁移号回到 0038；0038 关键表/列在位；033 新表已消失。
latest_after="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$latest_after" = "0038_employee_model_authorization_rule"
log "恢复后迁移号=${latest_after}"

schema_check="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select concat_ws(',',to_regclass('employee_model_rule_version'),to_regclass('employee_model_rule_assignment'),to_regclass('principal_model_manual_authorization'),(select column_name from information_schema.columns where table_name='principal_grant' and column_name='authorization_rule_version_id'))\"")"
test "$schema_check" = "employee_model_rule_version,employee_model_rule_assignment,principal_model_manual_authorization,authorization_rule_version_id"
log "0038 schema 校验通过"

# 033 新对象必须消失，确认确实退回 0038（而非带着 033 残留）。
pool033_residual="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select concat_ws(',',to_regclass('principal_access_idempotency'),to_regclass('principal_access_config_state'),to_regclass('principal_provider_disabled_model'),(select column_name from information_schema.columns where table_name='principal_grant' and column_name='pool_model_alias'))\"")"
test "$pool033_residual" = ","
log "033 新表/列已消失，确认退回 0038"

# 业务数据连续性快照（人工核对的锚点）。
active_key_count="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_key where status='ACTIVE'\"")"
manual_baseline_count="$(docker compose --project-directory "${current_release}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_model_manual_authorization\"")"
log "恢复后数据：active_keys=${active_key_count} manual_baseline=${manual_baseline_count}"

# ========== 6. 覆盖镜像回 029/030（含 migrate）==========
# 关键：migrate 镜像也要覆盖。033 的 migrate 镜像带 0039 迁移文件，
# 若不覆盖，compose up 会在已恢复成 0038 的库上把 0039 再跑一遍，回滚作废。
# migrate 与 control-api 共用 apps/control-api/Dockerfile，镜像等价，直接复用。
log "step 6: 用 029/030 回滚镜像覆盖 qianliu-zhisuan-*（含 migrate）"
for service in control-api gateway web worker; do
  docker image tag "qianliu-rollback-bf4eb80-${service}:latest" "qianliu-zhisuan-${service}"
done
docker image tag "qianliu-rollback-bf4eb80-control-api:latest" "qianliu-zhisuan-migrate"
log "已覆盖 control-api/gateway/web/worker/migrate 为 029/030 镜像"

# ========== 7. 启动 + 健康检查 ==========
log "step 7: 启动 pool029030 release"
cd "${target_release}/deploy"
docker compose config --quiet
docker compose up -d --no-build

for attempt in $(seq 1 90); do
  control_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health || true)"
  gateway_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health || true)"
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
  worker_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' qianliu-zhisuan-worker-1 2>/dev/null || true)"
  if test "$control_code" = 200 && test "$gateway_code" = 200 && test "$web_code" = 200 && test "$worker_health" = healthy; then
    break
  fi
  sleep 2
done
test "$control_code" = 200
test "$gateway_code" = 200
test "$web_code" = 200
test "$worker_health" = healthy
log "健康检查通过：control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health}"

# 必须仍是 0038：确认启动时 migrate（029/030 镜像）没有把库改掉。
final_latest="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$final_latest" = "0038_employee_model_authorization_rule"
log "启动后迁移号仍为 ${final_latest}（未被误升级）"

# 容器归属 pool029030。
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-control-api-1)" = "${target_release}/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-gateway-1)" = "${target_release}/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-web-1)" = "${target_release}/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-worker-1)" = "${target_release}/deploy"
log "容器 working_dir 指向 pool029030"

# POOL-030 的关键配置必须生效。
test "$(docker compose exec -T gateway printenv GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS)" = "120000"

# 无重启循环。
for container in \
  qianliu-zhisuan-caddy-1 \
  qianliu-zhisuan-control-api-1 \
  qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-postgres-1 \
  qianliu-zhisuan-redis-1 \
  qianliu-zhisuan-web-1 \
  qianliu-zhisuan-worker-1; do
  test "$(docker inspect --format '{{.RestartCount}}' "$container")" = 0
done
log "所有容器 RestartCount=0"

final_active_key_count="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_key where status='ACTIVE'\"")"
test "$final_active_key_count" = "$active_key_count"
log "ACTIVE Key 数量一致=${final_active_key_count}（恢复前后未变）"

# ========== 8. 更新 release 指针 ==========
printf '%s\n' "$target_release" > "${current_release_file}.next"
mv "${current_release_file}.next" "$current_release_file"

log "COMPLETE rollback_to_pool029030 release=${target_release} database=${final_latest} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} active_keys=${final_active_key_count} safety_backup=${safety_backup} safety_sha256=${safety_sha}"
log "下一步：用员工 Key 跑 curl 验证（见回滚方案说明）。"
