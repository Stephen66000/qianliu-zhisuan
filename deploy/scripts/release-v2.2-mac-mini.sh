#!/usr/bin/env bash
# Mac Mini 原位发布：从当前受支持迁移头升级到 v2.2 / 0052。
# 保持既有 qianliu-zhisuan Compose 项目、双域名和端口拓扑不变。

set -Eeuo pipefail
umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

repo_url="${QIANLIU_REPO_URL:-git@github.com:Stephen66000/qianliu-zhisuan.git}"
candidate_ref="${QIANLIU_CANDIDATE_REF:-refs/heads/codex/v2.2-test-fixes}"
candidate_commit="${CANDIDATE_COMMIT:?请传入 GitHub 上已审核候选的完整 Commit SHA}"
candidate_tree="${CANDIDATE_TREE:?请传入已审核候选的完整 Tree SHA}"
target_head="0052_dispatch_restore_and_resource_utilization"
server_home="${QIANLIU_SERVER_HOME:-/Users/stephen}"

for value in "$candidate_commit" "$candidate_tree"; do
  test "${#value}" = 40
  case "$value" in *[!0-9a-f]*) echo "Commit/Tree 必须是 40 位小写十六进制 Hash" >&2; exit 2;; esac
done

stamp="$(date '+%Y%m%d-%H%M%S')"
candidate_short="${candidate_commit:0:7}"
release="${server_home}/releases/qianliu-zhisuan-v2.2-${candidate_short}-${stamp}"
current_pointer="${server_home}/qianliu-current-release.txt"
backup_dir="${server_home}/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-v2.2-${stamp}.dump"
log_dir="${server_home}/logs/qianliu-zhisuan"
log_file="${log_dir}/deploy-v2.2-${candidate_short}-${stamp}.log"

test -r "$current_pointer"
previous="$(<"$current_pointer")"
case "$previous" in "$server_home"/releases/*) ;; *) echo "非法 current release: $previous" >&2; exit 2;; esac
test -f "$previous/deploy/compose.yaml"
test -f "$previous/deploy/.env"

mkdir -p "$release" "$backup_dir" "$log_dir"
exec > >(tee -a "$log_file") 2>&1
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# 变量必须在 postgres 容器内展开。
# shellcheck disable=SC2016
pg_sh='psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
db_query() {
  printf '%s\n' "$1" | docker compose --project-directory "$previous/deploy" \
    exec -T postgres sh -lc "$pg_sh -Atq"
}

images_frozen=0
paused=0
migration_started=0
source_head=""
rollback() {
  local status=$? failed_line="${BASH_LINENO[0]:-unknown}" service current_head
  trap - ERR
  set +e
  log "FAILED status=${status} line=${failed_line}"
  if test "$images_frozen" = 1; then
    for service in control-api gateway worker web; do
      docker image tag "qianliu-v22-rollback-${candidate_short}-${service}" \
        "qianliu-zhisuan-${service}" || log "rollback image restore failed service=${service}"
    done
  fi
  if test "$paused" = 1; then
    current_head="$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;' 2>/dev/null || true)"
    if test "$migration_started" = 0 || test "$current_head" = "$source_head"; then
      log "database=${current_head:-unknown}; restarting previous release=${previous}"
      (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
        control-api gateway worker web caddy) \
        || log "previous release restart failed; keep write pause and repair manually"
    else
      docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
        qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 \
        >/dev/null 2>&1 || true
      log "database=${current_head:-unknown}; migration changed database, business services remain stopped"
      log "restore backup first: ${backup} (expected migration after restore: ${source_head})"
      log "pg_restore command: docker compose --project-directory '${previous}/deploy' exec -T postgres sh -lc 'pg_restore --exit-on-error --clean --if-exists --no-owner -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' < '${backup}'"
    fi
  fi
  exit "$status"
}
trap rollback ERR

log "step 1: fetch exact GitHub candidate ref=${candidate_ref} commit=${candidate_commit}"
git -C "$release" init -q
git -C "$release" remote add origin "$repo_url"
remote_commit="$(GIT_TERMINAL_PROMPT=0 git -C "$release" ls-remote origin "$candidate_ref" | awk 'NR == 1 {print $1}')"
test "$remote_commit" = "$candidate_commit"
GIT_TERMINAL_PROMPT=0 git -C "$release" fetch --depth 64 origin "$candidate_ref"
test "$(git -C "$release" rev-parse FETCH_HEAD)" = "$candidate_commit"
git -C "$release" checkout -q --detach "$candidate_commit"
test "$(git -C "$release" rev-parse 'HEAD^{tree}')" = "$candidate_tree"
test -z "$(git -C "$release" status --porcelain --untracked-files=all)"
test -f "$release/packages/database/migrations/0052_dispatch_restore_and_resource_utilization.js"
unexpected_migrations="$(find "$release/packages/database/migrations" -maxdepth 1 -type f -name '*.js' \
  -exec basename {} \; | awk -F_ '$1 ~ /^[0-9]+$/ && ($1 + 0) > 52 {print}')"
test -z "$unexpected_migrations"
cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
if grep -q 'PLACEHOLDER' "$release/deploy/.env"; then
  log "production .env contains PLACEHOLDER"
  exit 2
fi
for assignment in \
  NODE_ENV=production \
  CONTENT_RETENTION_MODE=METADATA_ONLY \
  FEATURE_DIRECTORY_IMPORT=true \
  FEATURE_USAGE_OVERVIEW_V2=true \
  FEATURE_DEPARTMENT_COST=true \
  FEATURE_RESOURCE_UTILIZATION_V2=true \
  FEATURE_PROCUREMENT_REVIEW=true; do
  key="${assignment%%=*}"
  if grep -q "^${key}=" "$release/deploy/.env" \
    && ! grep -qx "$assignment" "$release/deploy/.env"; then
    log "production .env must set ${assignment}"
    exit 2
  fi
  if ! grep -q "^${key}=" "$release/deploy/.env"; then printf '%s\n' "$assignment" >> "$release/deploy/.env"; fi
done
(cd "$release/deploy" && docker compose config --quiet)

log "step 2: verify supported production database baseline"
source_head="$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;')"
case "$source_head" in
  0045_zhipu_weekday_window_alias|0051_pool20_operating_sync_and_closing_confirmation) ;;
  *) log "unsupported source migration=${source_head}"; exit 2;;
esac
log "database source=${source_head} target=${target_head}"

log "step 3: freeze previous application images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-v22-rollback-${candidate_short}-${service}"
done
images_frozen=1

log "step 4: build candidate images while current release remains online"
(cd "$release/deploy" && docker compose build migrate control-api gateway worker web)
for service in migrate control-api gateway worker web; do
  test -n "$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-${service}")"
done

log "step 5: controlled write pause, recheck and backup"
paused=1
(cd "$previous/deploy" && docker compose stop caddy gateway control-api web worker)
test "$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;')" = "$source_head"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
test "${#backup_sha}" = 64
log "backup verified path=${backup} sha256=${backup_sha}"

log "step 6: migrate ${source_head} → ${target_head}"
migration_started=1
(cd "$release/deploy" && docker compose run --rm --no-deps migrate)
test "$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;')" = "$target_head"
schema_check="$(db_query "
  SELECT concat_ws(',',
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'dispatch_policy'
        AND column_name = 'restore_source_policy_id'),
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN ('dispatch_policy_active_restore_unique_idx','ledger_line_resource_month_cover_idx'))
  );")"
test "$schema_check" = "1,2"

log "step 7: start candidate release and verify local health"
(cd "$release/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
  control-api gateway worker web caddy)
control_code=000; gateway_code=000; web_code=000; worker_health=unknown
for _ in $(seq 1 90); do
  control_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health || true)"
  gateway_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health || true)"
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
  worker_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    qianliu-zhisuan-worker-1 2>/dev/null || true)"
  if test "$control_code" = 200 && test "$gateway_code" = 200 \
    && test "$web_code" = 200 && test "$worker_health" = healthy; then break; fi
  sleep 2
done
test "$control_code" = 200
test "$gateway_code" = 200
test "$web_code" = 200
test "$worker_health" = healthy

log "step 8: verify containers and advance current release pointer"
for service in control-api gateway worker web; do
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
    "qianliu-zhisuan-${service}-1")" = "$release/deploy"
  expected_image="$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-${service}")"
  test "$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")" = "$expected_image"
  test "$(docker inspect --format '{{.RestartCount}}' "qianliu-zhisuan-${service}-1")" = 0
done
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
  qianliu-zhisuan-caddy-1)" = "$release/deploy"
test "$(docker inspect --format '{{.RestartCount}}' qianliu-zhisuan-caddy-1)" = 0
test "$(git -C "$release" rev-parse HEAD)" = "$candidate_commit"
test "$(git -C "$release" rev-parse 'HEAD^{tree}')" = "$candidate_tree"
test -z "$(git -C "$release" status --porcelain --untracked-files=all)"
printf '%s\n' "$release" > "${current_pointer}.next"
mv "${current_pointer}.next" "$current_pointer"
test "$(<"$current_pointer")" = "$release"
paused=0

log "COMPLETE release=${release} commit=${candidate_commit} tree=${candidate_tree} source=${source_head} target=${target_head} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} backup=${backup} backup_sha256=${backup_sha} current_pointer=${release}"
