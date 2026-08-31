#!/usr/bin/env bash
set -euo pipefail

poc_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
poc_root="$(CDPATH= cd -- "$poc_dir/../../.." && pwd)"
poc_profile="${POC20_PROFILE:-smoke}"
poc_password="poc20_capacity_password"
poc_source="qianliu-poc20-004-source-$$"
poc_restore="qianliu-poc20-004-restore-$$"
poc_temp="$(mktemp -d)"
poc_docker_arch="$(docker info --format '{{.Architecture}}')"
case "$poc_docker_arch" in
  arm64) poc_platform="linux/arm64/v8" ;;
  amd64) poc_platform="linux/amd64" ;;
  *) echo "unsupported Docker architecture: $poc_docker_arch" >&2; exit 1 ;;
esac

if [[ "$poc_profile" == "full" ]]; then
  poc_rows="${POC20_USAGE_ROWS:-10000000}"
  poc_gateway_concurrency="${POC20_GATEWAY_CONCURRENCY:-500}"
  poc_stream_concurrency="${POC20_STREAM_CONCURRENCY:-200}"
else
  poc_rows="${POC20_USAGE_ROWS:-1000000}"
  poc_gateway_concurrency="${POC20_GATEWAY_CONCURRENCY:-100}"
  poc_stream_concurrency="${POC20_STREAM_CONCURRENCY:-50}"
fi

cleanup() {
  docker stop "$poc_source" "$poc_restore" >/dev/null 2>&1 || true
  rm -f "$poc_temp/capacity.dump"
  rmdir "$poc_temp" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

start_postgres() {
  local container="$1"
  docker run --rm --detach \
    --name "$container" \
    --platform "$poc_platform" \
    --env POSTGRES_PASSWORD="$poc_password" \
    --publish 127.0.0.1::5432 \
    postgres:17-alpine >/dev/null
  local ready="false"
  for _ in $(seq 1 90); do
    if docker logs "$container" 2>&1 | rg --quiet "PostgreSQL init process complete; ready for start up" \
      && docker exec "$container" pg_isready --username postgres --dbname postgres >/dev/null 2>&1; then
      ready="true"
      break
    fi
    sleep 0.2
  done
  if [[ "$ready" != "true" ]]; then
    echo "PostgreSQL did not become ready: $container" >&2
    exit 1
  fi
}

elapsed_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

echo "POC20-004 profile=$poc_profile rows=$poc_rows gateway_concurrency=$poc_gateway_concurrency stream_concurrency=$poc_stream_concurrency"
uname -a
docker version --format 'docker_client={{.Client.Version}} docker_server={{.Server.Version}} server_arch={{.Server.Arch}}'
docker info --format 'docker_cpus={{.NCPU}} docker_memory_bytes={{.MemTotal}} storage_driver={{.Driver}}'
node --version
git -C "$poc_root" rev-parse HEAD
git -C "$poc_root" status --short --untracked-files=no | wc -l | tr -d ' '

start_postgres "$poc_source"
poc_source_port="$(docker port "$poc_source" 5432/tcp)"
poc_source_port="${poc_source_port##*:}"
poc_source_url="postgresql://postgres:${poc_password}@127.0.0.1:${poc_source_port}/postgres"

docker exec --interactive "$poc_source" \
  psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 < "$poc_dir/schema.sql"

NODE_PATH="$poc_root/packages/database/node_modules" \
DATABASE_URL="$poc_source_url" \
POC20_USAGE_ROWS="$poc_rows" \
  node "$poc_dir/database_capacity_check.cjs"

poc_source_invariant="$(docker exec "$poc_source" psql --username postgres --dbname postgres --tuples-only --no-align --command "select md5(concat_ws('|', count(*)::text, sum(id)::text, sum(input_tokens)::text, sum(output_tokens)::text, sum(api_cost)::text)) from poc20_capacity_ledger_line")"
poc_dump_started="$(elapsed_ms)"
docker exec "$poc_source" pg_dump --username postgres --dbname postgres --format custom --no-owner --no-privileges > "$poc_temp/capacity.dump"
poc_dump_finished="$(elapsed_ms)"
poc_dump_ms="$((poc_dump_finished - poc_dump_started))"
poc_dump_bytes="$(wc -c < "$poc_temp/capacity.dump" | tr -d ' ')"
poc_dump_sha="$(shasum -a 256 "$poc_temp/capacity.dump" | awk '{print $1}')"

start_postgres "$poc_restore"
docker exec "$poc_restore" psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 \
  --command "create role poc20_capacity_runtime nologin nosuperuser nobypassrls" >/dev/null
poc_restore_started="$(elapsed_ms)"
docker exec --interactive "$poc_restore" pg_restore --username postgres --dbname postgres --no-owner --no-privileges < "$poc_temp/capacity.dump"
poc_restore_finished="$(elapsed_ms)"
poc_restore_ms="$((poc_restore_finished - poc_restore_started))"
poc_restore_invariant="$(docker exec "$poc_restore" psql --username postgres --dbname postgres --tuples-only --no-align --command "select md5(concat_ws('|', count(*)::text, sum(id)::text, sum(input_tokens)::text, sum(output_tokens)::text, sum(api_cost)::text)) from poc20_capacity_ledger_line")"
poc_restore_rows="$(docker exec "$poc_restore" psql --username postgres --dbname postgres --tuples-only --no-align --command "select count(*) from poc20_capacity_ledger_line")"

if [[ "$poc_source_invariant" != "$poc_restore_invariant" || "$poc_restore_rows" != "$poc_rows" ]]; then
  echo "restore invariant mismatch" >&2
  exit 1
fi

echo "backup_restore_result=PASS dump_ms=$poc_dump_ms restore_ms=$poc_restore_ms dump_bytes=$poc_dump_bytes dump_sha256=$poc_dump_sha restored_rows=$poc_restore_rows invariant_hash=$poc_restore_invariant"

POC20_GATEWAY_CONCURRENCY="$poc_gateway_concurrency" \
POC20_STREAM_CONCURRENCY="$poc_stream_concurrency" \
  corepack pnpm@11.11.0 --filter @qianliu/gateway exec tsx "$poc_dir/gateway_capacity_check.ts"

docker exec "$poc_source" psql --username postgres --dbname postgres --tuples-only --no-align \
  --command "select version();"
