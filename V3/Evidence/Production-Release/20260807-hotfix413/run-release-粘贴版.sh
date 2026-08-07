#!/usr/bin/env bash
# 部署 hotfix-413：bodyLimit 413 修复 + 历史截断安全网（commit 21e5a20）。
#
# 本次改动（计划外紧急 hotfix，非 POOL 计划项）：
#   ① bodyLimit 默认 1MB→10MB + FST_ERR_CTP_BODY_TOO_LARGE 统一错误归因（即时生效）
#   ② 历史截断安全网（默认关闭，env 未设=零行为变化；仅 chat/messages）
#   ③ readPositiveIntEnv 抽到 @qianliu/config（gateway/control-api 共享）
#
# 触发：生产报 FST_ERR_CTP_BODY_TOO_LARGE / 413 / reason=unknown；直连智谱正常、走仟流即 413。
# 根因：gateway Fastify 未设 bodyLimit，吃默认 1MB，ZCode 长会话几轮即超，进路由前被拒。
#
# 无数据库迁移（纯应用层改动）。数据库应保持 0041_provider_quota_window 不变。
# 回滚保险：部署前 pg_dump 生成 pre-hotfix413-<时间戳>.dump（纯代码改动，
#   回滚只需镜像 tag 退回 + compose up；dump 作为额外保险，非必需）。
#
# 审核状态：两轮代码审核（自审 + 独立审核），P1 清零，72 单测全过。
#   合规缺口：独立性 I1（同模型同会话），R3 建议 I2 第二模型。本次按紧急 hotfix 处理。
#   详见 V3/Evidence/gateway-body-limit-413-历史截断-代码审核报告-20260807.md
#
# 与 pool031035 对称：set -Eeuo pipefail + trap ERR + 每步校验 + tee 日志。
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
candidate_commit="21e5a2030b8c0daec8131a2b66d08e37ab1359c8"
release="/Users/stephen/releases/qianliu-zhisuan-hotfix413-21e5a20-$(date '+%Y%m%d')"
previous="$(cat /Users/stephen/qianliu-current-release.txt)"
stamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-hotfix413-${stamp}.dump"
log_file="${release}/deploy-hotfix413-${stamp}.log"
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
      docker image tag "qianliu-rollback-21e5a20-${service}" "qianliu-zhisuan-${service}" || true
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

# ========== 2. 部署前数据库备份（回滚保险，本次无迁移但保留）==========
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

# ========== 3. 冻结回滚镜像 ==========
log "step 3: freezing rollback images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-21e5a20-${service}"
done
log "已冻结回滚镜像（回到当前线上版本 4057e46）"

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

# 数据库迁移号应保持 0041 不变（本次无迁移，断言未意外漂移）
final_latest="$(docker compose exec -T postgres sh -lc "${PG_SH} -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$final_latest" = "0041_provider_quota_window"
log "迁移号确认为 ${final_latest}（本次无迁移，应保持 0041）"

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
log "hotfix-413 已就绪：① bodyLimit 10MB 即时生效；② 历史截断默认关闭（需时设 GATEWAY_HISTORY_TRUNCATE_AT_TOKENS + GATEWAY_HISTORY_KEEP_TOKENS 成对启用）"
