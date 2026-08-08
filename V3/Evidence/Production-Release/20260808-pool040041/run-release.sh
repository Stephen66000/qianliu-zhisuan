#!/usr/bin/env bash
# 部署 POOL-040/041：Gateway 最终准入栅栏与单人接入配置重复输入校验。
# 本次为纯代码发布，无数据库迁移；数据库应保持 0042_alias_ql_format。
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

candidate_commit="${CANDIDATE_COMMIT:?请传入已上传的候选 commit SHA}"
candidate_short="${candidate_commit:0:7}"
repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
release="/Users/stephen/releases/qianliu-zhisuan-pool040041-${candidate_short}-$(date '+%Y%m%d')"
previous="$(cat /Users/stephen/qianliu-current-release.txt)"
stamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-pool040041-${stamp}.dump"
log_file="${release}/deploy-pool040041-${stamp}.log"
PG_SH='psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
paused=0

mkdir -p "$release" "$backup_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
rollback() {
  status=$?
  trap - ERR
  set +e
  log "FAILED status=${status} line=${BASH_LINENO[0]}"
  if test "$paused" = 1; then
    log "attempting application rollback; database remains at 0042 (本次无迁移)"
    for service in control-api gateway worker web; do
      rollback_id="$(docker image inspect --format '{{.Id}}' "qianliu-rollback-${candidate_short}-${service}" 2>/dev/null)"
      if test -n "$rollback_id"; then
        docker image tag "qianliu-rollback-${candidate_short}-${service}" "qianliu-zhisuan-${service}"
      else
        log "rollback image missing service=${service}"
      fi
    done
    (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps control-api gateway worker web caddy)
    for service in control-api gateway worker web; do
      expected_id="$(docker image inspect --format '{{.Id}}' "qianliu-rollback-${candidate_short}-${service}" 2>/dev/null)"
      actual_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1" 2>/dev/null)"
      if test "$actual_id" = "$expected_id"; then
        log "rollback image verified service=${service} image=${actual_id}"
      else
        log "rollback image mismatch service=${service} expected=${expected_id} actual=${actual_id}"
      fi
    done
  fi
  exit "$status"
}
trap rollback ERR

log "step 1: fetching verified commit=${candidate_commit}"
if ! test -d "$release/.git"; then git -C "$release" init; fi
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

log "step 2: pre-deployment database backup (无迁移，回滚保险)"
latest_before="$(docker compose --project-directory "$previous/deploy" exec -T postgres sh -lc "$PG_SH -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$latest_before" = "0042_alias_ql_format"
docker compose --project-directory "$previous/deploy" exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "$previous/deploy" exec -T postgres sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
log "backup=${backup} sha256=${backup_sha} database=${latest_before}"

cd "$release/deploy"
docker compose config --quiet

log "step 3: freezing rollback images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-${candidate_short}-${service}"
done

log "step 4: building new images"
docker compose build control-api gateway worker web

log "step 5: controlled write pause + start new release (无数据库迁移)"
paused=1
docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 >/dev/null
docker compose up -d --no-build --no-deps control-api gateway worker web caddy

for attempt in $(seq 1 90); do
  control_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health || true)"
  gateway_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health || true)"
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
  worker_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' qianliu-zhisuan-worker-1 2>/dev/null || true)"
  if test "$control_code" = 200 && test "$gateway_code" = 200 && test "$web_code" = 200 && test "$worker_health" = healthy; then break; fi
  sleep 2
done
test "$control_code" = 200
test "$gateway_code" = 200
test "$web_code" = 200
test "$worker_health" = healthy

log "step 6: post-deployment checks"
for service in control-api gateway worker web; do
  restart_count="$(docker inspect --format '{{.RestartCount}}' "qianliu-zhisuan-${service}-1")"
  test "$restart_count" = 0
done
final_latest="$(docker compose exec -T postgres sh -lc "$PG_SH -Atqc \"select name from kysely_migration order by timestamp desc limit 1\"")"
test "$final_latest" = "0042_alias_ql_format"
active_key_count="$(docker compose exec -T postgres sh -lc "$PG_SH -Atqc \"select count(*) from principal_key where status='ACTIVE'\"")"
log "health control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} database=${final_latest} active_keys=${active_key_count}"

printf '%s\n' "$release" > /Users/stephen/qianliu-current-release.txt.next
mv /Users/stephen/qianliu-current-release.txt.next /Users/stephen/qianliu-current-release.txt
paused=0
log "COMPLETE release=${release} commit=${candidate_commit} backup_sha256=${backup_sha}"
