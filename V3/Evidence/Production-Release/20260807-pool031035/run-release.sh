#!/usr/bin/env bash
# 部署 POOL-031/032/034/035 + 星期选择器：从 0039 升级到 0041（0040+0041 两个迁移）。
#
# 本次改动：
#   POOL-034  智谱流式空闲超时厂商级可配置（无迁移）
#   POOL-035  批量模型授权页额度厂商池化（0040）
#   星期选择器 计价/调度规则星期按钮组（无迁移）
#   POOL-031  资源健康与异常面板（无迁移）
#   POOL-032  Coding Plan 额度厂商自动同步（0041）
#
# 数据库基线：0039_principal_provider_pool → 0041_provider_quota_window
# 回滚保险：部署前 pg_dump 生成 pre-pool031035-<时间戳>.dump
#
# 与 pool033-fix 对称：set -Eeuo pipefail + trap ERR + 每步校验 + tee 日志。
# 两个迁移都是加性的（加列/加表），回滚时应用层可退，数据层需 pg_restore。
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
candidate_commit="4057e46e1a456a1442b4e92d0ea6867f992e6f1b"
release="/Users/stephen/releases/qianliu-zhisuan-pool031035-4057e46-$(date '+%Y%m%d')"
previous="$(cat /Users/stephen/qianliu-current-release.txt)"
stamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-pool031035-${stamp}.dump"
log_file="${release}/deploy-pool031035-${stamp}.log"
PG_SH='psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
paused=0

mkdir -p "$release" "$backup_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
rollback() {
  status=$?
  log "FAILED status=${status} line=${BASH_LINENO[0]}"
  if test "$paused" = 1; then
    log "attempting application rollback; database may already be at 0040/0041 (additive, 不自动回滚)"
    for service in control-api gateway worker web; do
      docker image tag "qianliu-rollback-4057e46-${service}" "qianliu-zhisuan-${service}" || true
    done
    (cd "$previous/deploy" && docker compose up -d --no-build) || true
    log "若数据库已升级，需用 ${backup} 恢复回 0039 才能完整回退"
  fi
  exit "$status"
}
trap rollback ERR

# ========== 1. fetch 发布 commit ==========
log "step 1: fetching verified commit=${candidate_commit}"
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
log "commit checkout 完成，.env 已复制"

# ========== 2. 部署前数据库备份（回滚保险）==========
log "step 2: pre-deployment database backup (回滚保险)"
latest_before="$(docker compose --project-directory "${previous}/deploy" exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$latest_before" = "0039_principal_provider_pool"
log "数据库基线=${latest_before}（确在 0039）"
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
  docker image tag "$old_id" "qianliu-rollback-4057e46-${service}"
done
log "已冻结回滚镜像（回到当前线上版本）"

# ========== 4. 构建新镜像 ==========
log "step 4: building images (migrate control-api gateway worker web)"
docker compose build migrate control-api gateway worker web
log "新镜像构建完成"

# ========== 5. 写暂停 + 跑迁移 0040 + 0041 ==========
log "step 5: controlled write pause + migration 0040→0041"
docker stop \
  qianliu-zhisuan-caddy-1 \
  qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-control-api-1 \
  qianliu-zhisuan-web-1 \
  qianliu-zhisuan-worker-1 >/dev/null
paused=1

log "applying database migrations 0040 + 0041"
docker compose run --rm migrate
latest_after="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$latest_after" = "0041_provider_quota_window"
log "迁移完成，数据库现在=${latest_after}"

# 断言新表/列存在（0040 加列 + 0041 建表）
has_pool_quotas="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from information_schema.columns where table_name='employee_model_rule_version' and column_name='pool_quotas'\"")"
test "$has_pool_quotas" = "1"
log "0040 断言：employee_model_rule_version.pool_quotas 列存在"

has_quota_window="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from information_schema.tables where table_name='provider_quota_window'\"")"
test "$has_quota_window" = "1"
log "0041 断言：provider_quota_window 表存在"

# ========== 6. 启动新版本 ==========
log "step 6: starting new release"
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
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-worker-1)" = "$release/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-web-1)" = "$release/deploy"

final_latest="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$final_latest" = "0041_provider_quota_window"
log "迁移号确认为 ${final_latest}"

# 所有业务容器 RestartCount=0
for service in control-api gateway worker web; do
  restart_count="$(docker inspect --format '{{.RestartCount}}' "qianliu-zhisuan-${service}-1")"
  test "$restart_count" = 0
done
log "所有业务容器 RestartCount=0"

active_key_count="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select count(*) from principal_key where status='ACTIVE'\"")"
log "ACTIVE Key 数量=${active_key_count}（部署保留，不受影响）"

# ========== 8. 更新 release 指针 ==========
printf '%s\n' "$release" > /Users/stephen/qianliu-current-release.txt.next
mv /Users/stephen/qianliu-current-release.txt.next /Users/stephen/qianliu-current-release.txt
paused=0

log "COMPLETE deploy release=${release} database=${final_latest} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} backup=${backup} backup_sha256=${backup_sha} active_keys=${active_key_count}"
log "本次无 cleanup 步骤——POOL-031/032/034/035 + 星期选择器均已就绪。"
