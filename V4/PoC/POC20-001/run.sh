#!/usr/bin/env bash
set -euo pipefail

poc_container="qianliu-poc20-001-20260811-$$"
poc_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
poc_root="$(CDPATH= cd -- "$poc_dir/../../.." && pwd)"

if docker container inspect "$poc_container" >/dev/null 2>&1; then
  echo "PoC container already exists: $poc_container" >&2
  exit 1
fi

cleanup() {
  docker stop "$poc_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm --detach \
  --name "$poc_container" \
  --platform linux/amd64 \
  --env POSTGRES_PASSWORD=poc20_postgres_password \
  --publish 127.0.0.1::5432 \
  postgres:17-alpine >/dev/null

ready="false"
for _ in $(seq 1 60); do
  if docker logs "$poc_container" 2>&1 | rg --quiet "PostgreSQL init process complete; ready for start up" \
    && docker exec "$poc_container" \
    psql --username postgres --dbname postgres --tuples-only --command "select 1" >/dev/null 2>&1; then
    ready="true"
    break
  fi
  sleep 0.2
done

if [[ "$ready" != "true" ]]; then
  echo "PostgreSQL did not become ready" >&2
  exit 1
fi

docker exec --interactive "$poc_container" \
  psql --username postgres --dbname postgres < "$poc_dir/schema.sql"

poc_binding="$(docker port "$poc_container" 5432/tcp)"
poc_port="${poc_binding##*:}"

NODE_PATH="$poc_root/packages/database/node_modules" \
DATABASE_URL="postgresql://ql_poc_app:poc20_local_password@127.0.0.1:${poc_port}/postgres" \
  node "$poc_dir/pool_rls_check.cjs"

docker exec "$poc_container" \
  psql --username postgres --dbname postgres --tuples-only --no-align \
  --command "select version();"
