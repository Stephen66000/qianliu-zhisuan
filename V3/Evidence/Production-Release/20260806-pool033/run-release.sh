#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
candidate_commit="bf4eb80c65e848b690dffc6b246ef012a23050c2"
release="/Users/stephen/releases/qianliu-zhisuan-pool033-bf4eb80-20260806"
previous="$(cat /Users/stephen/qianliu-current-release.txt)"
stamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-pool033-${stamp}.dump"
log_file="${release}/deploy-pool033-${stamp}.log"
paused=0

mkdir -p "$release" "$backup_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
rollback() {
  status=$?
  log "FAILED status=${status} line=${BASH_LINENO[0]}"
  if test "$paused" = 1; then
    log "attempting application rollback; database migration 0039 blocks destructive rollback once pool data exists and is not rolled back"
    for service in control-api gateway worker web; do
      docker image tag "qianliu-rollback-bf4eb80-${service}" "qianliu-zhisuan-${service}" || true
    done
    (cd "$previous/deploy" && docker compose up -d --no-build) || true
  fi
  exit "$status"
}
trap rollback ERR

log "fetching verified candidate commit=${candidate_commit}"
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

cd "$release/deploy"
docker compose config --quiet

log "freezing rollback images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-bf4eb80-${service}"
done

latest_before="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select name from kysely_migration order by timestamp desc limit 1"')"
test "$latest_before" = "0038_employee_model_authorization_rule"
log "database baseline=${latest_before}"

log "creating pre-migration database backup"
docker compose exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose exec -T postgres sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
log "backup=${backup} sha256=${backup_sha}"

log "building candidate images while production remains online"
docker compose build migrate control-api gateway worker web

log "controlled write pause begins"
docker stop \
  qianliu-zhisuan-caddy-1 \
  qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-control-api-1 \
  qianliu-zhisuan-web-1 \
  qianliu-zhisuan-worker-1 >/dev/null
paused=1

log "applying database migration 0039"
docker compose run --rm migrate
latest_after="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select name from kysely_migration order by timestamp desc limit 1"')"
test "$latest_after" = "0039_principal_provider_pool"
schema_check="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select concat_ws('"'"','"'"',to_regclass('"'"'principal_access_idempotency'"'"'),to_regclass('"'"'principal_access_config_state'"'"'),to_regclass('"'"'principal_provider_disabled_model'"'"'),(select column_name from information_schema.columns where table_name='"'"'principal_grant'"'"' and column_name='"'"'pool_model_alias'"'"'),(select column_name from information_schema.columns where table_name='"'"'employee_model_rule_version'"'"' and column_name='"'"'owner_principal_id'"'"'))"')"
test "$schema_check" = "principal_access_idempotency,principal_access_config_state,principal_provider_disabled_model,pool_model_alias,owner_principal_id"
pool_uq="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from pg_indexes where indexname='"'"'principal_grant_pool_uq'"'"'"')"
test "$pool_uq" = "1"

log "starting unified release"
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

running="$(docker compose ps --status running --services | sort)"
for service in caddy control-api gateway postgres redis web worker; do
  printf '%s\n' "$running" | grep -Fx "$service" >/dev/null
done
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

test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-control-api-1)" = "$release/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-gateway-1)" = "$release/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-web-1)" = "$release/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-worker-1)" = "$release/deploy"
test "$(docker compose exec -T gateway printenv GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS)" = "120000"

pool_count="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from principal_grant where pool_model_alias='"'"'*'"'"'"')"
manual_remaining="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from principal_grant where authorization_rule_version_id is null and status='"'"'ACTIVE'"'"' and pool_model_alias is null"')"
manual_baseline_count="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from principal_model_manual_authorization"')"
active_key_count="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from principal_key where status='"'"'ACTIVE'"'"'"')"
log "POOL-033 migration smoke: pools=${pool_count} manual_grants_not_promoted=${manual_remaining} manual_baseline=${manual_baseline_count} active_keys=${active_key_count}"
test "$manual_remaining" = "0"

printf '%s\n' "$release" > /Users/stephen/qianliu-current-release.txt.next
mv /Users/stephen/qianliu-current-release.txt.next /Users/stephen/qianliu-current-release.txt
paused=0

log "COMPLETE release=${release} database=${latest_after} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} backup=${backup} backup_sha256=${backup_sha} pools=${pool_count}"
