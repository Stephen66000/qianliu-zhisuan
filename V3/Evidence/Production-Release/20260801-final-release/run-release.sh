#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

release="/Users/stephen/releases/qianliu-zhisuan-v0.3.0-dd80e975-20260801"
previous="/Users/stephen/releases/qianliu-zhisuan-pool013-20260731-222133"
archive="/Users/stephen/qianliu-dd80e975.tar.gz"
archive_sha="dd88ed205ca7ef7734ca29ce439ae8f1157390b81828b7b7b922438e30d263cc"
backup_path_file="/tmp/qianliu-final-backup-path"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
fail_context() {
  status=$?
  log "FAILED status=${status} line=${BASH_LINENO[0]}"
  log "数据库不自动恢复；恢复前须停止新版本写入并按已记录的备份命令人工执行"
  exit "$status"
}
trap fail_context ERR

log "release validation start"
test "$(shasum -a 256 "$archive" | awk '{print $1}')" = "$archive_sha"
test -s "$backup_path_file"
backup="$(<"$backup_path_file")"
test -s "$backup"
gzip -t "$backup"
log "archive and pre-migration backup verified"

if ! test -d "$release"; then
  mkdir -p "$release"
  tar -xzf "$archive" -C "$release"
  cp -p "$previous/deploy/.env" "$release/deploy/.env"
else
  log "reusing previously extracted candidate after checksum-only preflight failure"
  test -s "$release/deploy/.env"
fi

test "$(shasum -a 256 "$release/packages/database/migrations/0030_runtime_assurance_foundation.js" | awk '{print $1}')" = "480612e93b15f1b54ffec11de2d149c2826999488bfc15a4e02954b1bf2feab6"
test "$(shasum -a 256 "$release/packages/database/migrations/0031_gateway_stream_resilience.js" | awk '{print $1}')" = "9fcb5fade54f6ef0d88a6ffb31c8ca6747e756ba6b9e1dc870820d8996e75cd4"
test "$(shasum -a 256 "$release/deploy/compose.yaml" | awk '{print $1}')" = "6ccadd69ee364497617674e739008a5f5ffd5109d0c964496cbbcc73259566c6"
test "$(shasum -a 256 "$release/deploy/caddy/Caddyfile" | awk '{print $1}')" = "4ac0c0f85548f695720a1761bfccf77064ab03cc04f876c77379021944fa659e"

cd "$release/deploy"
set -a
# shellcheck disable=SC1091
source ./.env
set +a
docker compose config --quiet

for service in control-api gateway web; do
  rollback_image="qianliu-rollback-dd80e975-${service}:pool013"
  if ! docker image inspect "$rollback_image" >/dev/null 2>&1; then
    old_image="$(cd "$previous/deploy" && docker compose images -q "$service" | head -n 1)"
    test -n "$old_image"
    docker image tag "$old_image" "$rollback_image"
  fi
done
log "rollback images frozen"

latest_before="$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select name from kysely_migration order by timestamp desc limit 1")"
test "$latest_before" = "0029_provider_quota_auto_calculation"
log "database baseline=${latest_before}"

log "building candidate images while current release remains online"
docker compose build migrate control-api gateway worker web
log "candidate images built"

log "controlled write pause begins"
docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 >/dev/null

log "running migrations from 0029; expected sequence 0030 then 0031"
docker compose run --rm migrate

migration_rows="$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select name from kysely_migration where name in ('0030_runtime_assurance_foundation','0031_gateway_stream_resilience') order by timestamp")"
test "$migration_rows" = $'0030_runtime_assurance_foundation\n0031_gateway_stream_resilience'
latest_after="$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select name from kysely_migration order by timestamp desc limit 1")"
test "$latest_after" = "0031_gateway_stream_resilience"

schema_check="$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select concat_ws(',',to_regclass('person'),to_regclass('availability_rule'),to_regclass('availability_event'),to_regclass('notification_endpoint'),to_regclass('notification_delivery'),(select column_name from information_schema.columns where table_name='upstream_attempt' and column_name='failure_layer'))")"
test "$schema_check" = "person,availability_rule,availability_event,notification_endpoint,notification_delivery,failure_layer"
status_constraint="$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select pg_get_constraintdef(oid) from pg_constraint where conname='provider_resource_status_check'")"
case "$status_constraint" in *RATE_LIMITED*) ;; *) exit 32 ;; esac
log "migrations and schema verified: latest=${latest_after}"

log "starting unified release services"
docker compose up -d --no-build

for attempt in $(seq 1 60); do
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

for container in qianliu-zhisuan-caddy-1 qianliu-zhisuan-control-api-1 qianliu-zhisuan-gateway-1 qianliu-zhisuan-postgres-1 qianliu-zhisuan-redis-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1; do
  test "$(docker inspect --format '{{.RestartCount}}' "$container")" = 0
done

test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-control-api-1)" = "$release/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-gateway-1)" = "$release/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-web-1)" = "$release/deploy"
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-worker-1)" = "$release/deploy"
test "$(docker exec qianliu-zhisuan-caddy-1 caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -n 1)" != ""

worker_count="$(docker ps --filter name=qianliu-zhisuan-worker --filter status=running -q | wc -l | tr -d ' ')"
test "$worker_count" = 1
worker_health_json="$(docker exec qianliu-zhisuan-worker-1 wget -q -O - http://127.0.0.1:9191/health)"
printf '%s' "$worker_health_json" | grep -q '"status":"ok"'
printf '%s' "$worker_health_json" | grep -q '"lastSuccessAt":"'

log "release complete: database=${latest_after} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} worker_count=${worker_count}"
printf '%s\n' "$release" > /Users/stephen/qianliu-current-release.txt
log "COMPLETE"
