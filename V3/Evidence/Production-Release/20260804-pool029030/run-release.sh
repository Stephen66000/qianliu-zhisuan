#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
candidate_commit="9da9ab12c42b1168485592ef75a5a4c35ca06fec"
release="/Users/stephen/releases/qianliu-zhisuan-pool029030-9da9ab1-20260804"
previous="$(cat /Users/stephen/qianliu-current-release.txt)"
stamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-pool029030-${stamp}.dump"
log_file="${release}/deploy-pool029030-${stamp}.log"
paused=0

mkdir -p "$release" "$backup_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
rollback() {
  status=$?
  log "FAILED status=${status} line=${BASH_LINENO[0]}"
  if test "$paused" = 1; then
    log "attempting application rollback; database migration is additive and is not rolled back"
    for service in control-api gateway worker web; do
      docker image tag "qianliu-rollback-9da9ab1-${service}" "qianliu-zhisuan-${service}" || true
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
awk '!/^GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS=/' "$release/deploy/.env" > "$release/deploy/.env.next"
printf '%s\n' 'GATEWAY_KIMI_FIRST_BYTE_TIMEOUT_MS=120000' >> "$release/deploy/.env.next"
mv "$release/deploy/.env.next" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"

cd "$release/deploy"
docker compose config --quiet

log "freezing rollback images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-9da9ab1-${service}"
done

latest_before="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select name from kysely_migration order by timestamp desc limit 1"')"
test "$latest_before" = "0037_client_identity"
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

log "applying database migration 0038"
docker compose run --rm migrate
latest_after="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select name from kysely_migration order by timestamp desc limit 1"')"
test "$latest_after" = "0038_employee_model_authorization_rule"
schema_check="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select concat_ws('"'"','"'"',to_regclass('"'"'employee_model_rule_version'"'"'),to_regclass('"'"'employee_model_rule_assignment'"'"'),to_regclass('"'"'principal_model_manual_authorization'"'"'),(select column_name from information_schema.columns where table_name='"'"'principal_grant'"'"' and column_name='"'"'authorization_rule_version_id'"'"'))"')"
test "$schema_check" = "employee_model_rule_version,employee_model_rule_assignment,principal_model_manual_authorization,authorization_rule_version_id"

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

manual_baseline_count="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from principal_model_manual_authorization"')"
active_key_count="$(docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from principal_key where status='"'"'ACTIVE'"'"'"')"
log "POOL-029 migration smoke: manual_baseline=${manual_baseline_count} active_keys=${active_key_count}"

printf '%s\n' "$release" > /Users/stephen/qianliu-current-release.txt.next
mv /Users/stephen/qianliu-current-release.txt.next /Users/stephen/qianliu-current-release.txt
paused=0

log "COMPLETE release=${release} database=${latest_after} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} backup=${backup} backup_sha256=${backup_sha}"
