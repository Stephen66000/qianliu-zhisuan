#!/usr/bin/env bash
# 部署 POOL-037：批量模型授权页隐藏未启用 route（commit 4f05c6c）。
#
# 本次改动（POOL-033 切型号的延伸修复，P2）：
#   catalog() 的 model_route 查询新增 enabled=true 过滤，隐藏 pool033 切型号时停用的
#   旧笼统别名（K3/zhipu/qianliu-deepseek）。与 validation ALL 范围语义一致
#   （enabled=false 本就不进 readyTargets），不影响 refreshKeyModels 白名单计算
#   （白名单从 principal_grant 厂商池反推，不查 catalog）。
#   3 条旧别名有 2000+ 历史用量，不删除，历史仍可在账本按 alias 查到。
#
# 无数据库迁移（纯查询过滤）。数据库应保持 0041_provider_quota_window 不变。
# 线上当前版本：POOL-036 7b9f7d9（本次回滚目标）。
#
# 审核状态：R2，I2 自审通过；审核报告 V3/Evidence/POOL-037-代码审核报告-20260808.md。
#   typecheck/lint 全绿；pool029 集成测试 12 passed；web 79 passed。
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
candidate_commit="4f05c6ca6e3583162ccd7557b01fe4e3d869e1d2"
release="/Users/stephen/releases/qianliu-zhisuan-pool037-4f05c6c-$(date '+%Y%m%d')"
previous="$(cat /Users/stephen/qianliu-current-release.txt)"
stamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-pool037-${stamp}.dump"
log_file="${release}/deploy-pool037-${stamp}.log"
PG_SH='psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
paused=0

mkdir -p "$release" "$backup_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
rollback() {
  status=$?
  log "FAILED status=${status} line=${BASH_LINENO[0]}"
  if test "$paused" = 1; then
    log "attempting application rollback (纯代码改动，镜像 tag 退回即可)"
    for service in control-api gateway worker web; do
      docker image tag "qianliu-rollback-4f05c6c-${service}" "qianliu-zhisuan-${service}" || true
    done
    (cd "$previous/deploy" && docker compose up -d --no-build) || true
    log "应用层已回退；数据库未变更（本次无迁移），无需 pg_restore"
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
test "$latest_before" = "0041_provider_quota_window"
log "数据库基线=${latest_before}（确在 0041，本次不迁移）"
docker compose --project-directory "${previous}/deploy" exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "${previous}/deploy" exec -T postgres sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
log "backup=${backup} sha256=${backup_sha}"

cd "$release/deploy"
docker compose config --quiet

# ========== 3. 冻结回滚镜像（回到当前线上 7b9f7d9）==========
log "step 3: freezing rollback images (回到当前线上版本 7b9f7d9)"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-4f05c6c-${service}"
done
log "已冻结回滚镜像"

# ========== 4. 构建新镜像 ==========
log "step 4: building images (control-api gateway worker web)"
docker compose build control-api gateway worker web
log "新镜像构建完成"

# ========== 5. 写暂停 + 启动新版本（无迁移）==========
log "step 5: controlled write pause + start new release (无数据库迁移)"
docker stop \
  qianliu-zhisuan-caddy-1 \
  qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-control-api-1 \
  qianliu-zhisuan-web-1 \
  qianliu-zhisuan-worker-1 >/dev/null
paused=1
log "本次无迁移，跳过 migrate 步骤"

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
log "迁移号确认为 ${final_latest}（本次无迁移，应保持 0041）"

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
log "POOL-037 已就绪：批量模型授权页已隐藏未启用 route（旧笼统别名）"
