#!/usr/bin/env bash
set -euo pipefail

poc_container="qianliu-poc20-002-20260811-$$"
poc_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
poc_root="$(CDPATH= cd -- "$poc_dir/../../.." && pwd)"
poc_postgres_password="poc20_postgres_password"
poc_v1_password="poc20_v1_password"

cleanup() {
  docker stop "$poc_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --rm --detach \
  --name "$poc_container" \
  --platform linux/amd64 \
  --env POSTGRES_PASSWORD="$poc_postgres_password" \
  --publish 127.0.0.1::5432 \
  postgres:17-alpine >/dev/null

ready="false"
for _ in $(seq 1 60); do
  if docker logs "$poc_container" 2>&1 | rg --quiet "PostgreSQL init process complete; ready for start up" \
    && docker exec "$poc_container" pg_isready --username postgres --dbname postgres >/dev/null 2>&1; then
    ready="true"
    break
  fi
  sleep 0.2
done

if [[ "$ready" != "true" ]]; then
  echo "PostgreSQL did not become ready" >&2
  exit 1
fi

docker exec "$poc_container" psql --username postgres --dbname postgres --set ON_ERROR_STOP=1 --command \
  "CREATE ROLE ql_poc_v1 LOGIN PASSWORD '${poc_v1_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; CREATE ROLE ql_poc_v2 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;"

for poc_database in poc_valid poc_ambiguous poc_cross; do
  docker exec "$poc_container" createdb --username postgres "$poc_database"
done

poc_binding="$(docker port "$poc_container" 5432/tcp)"
poc_port="${poc_binding##*:}"

for poc_database in poc_valid poc_ambiguous poc_cross; do
  DATABASE_URL="postgresql://postgres:${poc_postgres_password}@127.0.0.1:${poc_port}/${poc_database}" \
    corepack pnpm@11.11.0 --filter @qianliu/database exec tsx src/cli/migrate.ts up >/dev/null
done

NODE_PATH="$poc_root/packages/database/node_modules" \
POC_POSTGRES_PORT="$poc_port" \
POC_POSTGRES_PASSWORD="$poc_postgres_password" \
POC_V1_PASSWORD="$poc_v1_password" \
  node "$poc_dir/migration_check.cjs"

docker exec "$poc_container" psql --username postgres --dbname postgres --tuples-only --no-align \
  --command "select version();"
