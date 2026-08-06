#!/usr/bin/env bash
# 部署修复版 POOL-033：从 POOL-029/030（0038）升级到修复版（0039 + bug 修复）。
#
# 与既有 run-release.sh 对称：set -Eeuo pipefail + trap ERR + 每步校验 + tee 日志。
# 部署后需立即执行清理脚本（cleanup-authorization.sh）并重新配置员工。
#
# 回滚保险：部署前 pg_dump 生成 pre-fix033-<时间戳>.dump。
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
candidate_commit="bed91986a6594ee2c37c83936f86a2c88d5ff931"
release="/Users/stephen/releases/qianliu-zhisuan-pool033fix-bed9198-$(date '+%Y%m%d')"
previous="$(cat /Users/stephen/qianliu-current-release.txt)"
stamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-fix033-${stamp}.dump"
log_file="${release}/deploy-pool033fix-${stamp}.log"
PG_SH='psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
paused=0

mkdir -p "$release" "$backup_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
rollback() {
  status=$?
  log "FAILED status=${status} line=${BASH_LINENO[0]}"
  if test "$paused" = 1; then
    log "attempting application rollback; database may already be at 0039 (additive, 不回滚)"
    for service in control-api gateway worker web; do
      docker image tag "qianliu-rollback-bed9198-${service}" "qianliu-zhisuan-${service}" || true
    done
    (cd "$previous/deploy" && docker compose up -d --no-build) || true
    log "若数据库已升到 0039，需用 ${backup} 恢复回 0038 才能完整回到 029/030"
  fi
  exit "$status"
}
trap rollback ERR

# ========== 1. fetch 修复 commit ==========
log "step 1: fetching verified fix commit=${candidate_commit}"
if ! test -d "$release/.git"; then
  git -C "$release" init
fi
if git -C "$release" remote get-url origin >/dev/null 2>&1; then
  test "$(git -C "$release" remote get-url origin)" = "$repo_url"
else
  git -C "$release" remote add origin "$repo_url"
fi
GIT_TERMINAL_PROMPT=0 git -C "$release" fetch --depth 1 origin "$candidate_commit"
test "$(git -C "$release" rev-parse FETCH_HEAD)" = "$candidate_commit"
git -C "$release" checkout --detach "$candidate_commit"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate_commit"
git -C "$release" diff --quiet
git -C "$release" diff --cached --quiet
cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
log "fix commit checkout 完成，.env 已复制"

# ========== 2. 部署前数据库备份（回滚保险）==========
log "step 2: pre-deployment database backup (回滚保险)"
latest_before="$(docker compose --project-directory "${previous}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$latest_before" = "0038_employee_model_authorization_rule"
log "数据库基线=${latest_before}（确在 0038）"
docker compose --project-directory "${previous}/deploy" exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "${previous}/deploy" exec -T postgres sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
log "backup=${backup} sha256=${backup_sha}"

cd "$release/deploy"
docker compose config --quiet

# ========== 3. 冻结回滚镜像 ==========
log "step 3: freezing rollback images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-bed9198-${service}"
done
log "已冻结回滚镜像（回到 029/030）"

# ========== 4. 构建修复版镜像 ==========
log "step 4: building fix images"
docker compose build migrate control-api gateway worker web
log "修复版镜像构建完成"

# ========== 5. 写暂停 + 跑迁移 0039 ==========
log "step 5: controlled write pause + migration 0039"
docker stop \
  qianliu-zhisuan-caddy-1 \
  qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-control-api-1 \
  qianliu-zhisuan-web-1 \
  qianliu-zhisuan-worker-1 >/dev/null
paused=1

log "applying database migration 0039"
docker compose run --rm migrate
latest_after="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$latest_after" = "0039_principal_provider_pool"
log "迁移完成，数据库现在=${latest_after}"

# ========== 6. 启动修复版 ==========
log "step 6: starting fix release"
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

# ========== 7. 校验 ==========
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-control-api-1)" = "$release/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-gateway-1)" = "$release/deploy"
test "$(docker compose exec -T gateway printenv GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS)" = "120000"

final_latest="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$final_latest" = "0039_principal_provider_pool"
log "迁移号确认为 ${final_latest}"

active_key_count="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_key where status='ACTIVE'\"")"
log "ACTIVE Key 数量=${active_key_count}（部署保留，待清理后重新配置）"

# ========== 8. 更新 release 指针 ==========
printf '%s\n' "$release" > /Users/stephen/qianliu-current-release.txt.next
mv /Users/stephen/qianliu-current-release.txt.next /Users/stephen/qianliu-current-release.txt
paused=0

log "COMPLETE deploy_fix release=${release} database=${final_latest} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} backup=${backup} backup_sha256=${backup_sha} active_keys=${active_key_count}"
log "下一步：立即执行 cleanup-authorization.sh 清理老授权，然后重新配置员工。"
log "⚠ 员工 Key 在重新配置前暂时不可用——请连续执行清理+配置，不要隔夜。"
