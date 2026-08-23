#!/usr/bin/env bash
# Mac Mini 原位发布：从已部署 POOL20-048 / 0055 升级 POOL20-045～049 / 0056。
# 保持既有 qianliu-zhisuan Compose 项目、双域名和端口拓扑不变。

set -Eeuo pipefail
umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

validate_env_file() {
  local file="$1" key value count assignment
  test -f "$file" || { echo "环境文件不存在: $file" >&2; return 2; }
  if LC_ALL=C grep -q $'\r' "$file"; then echo "环境文件包含 CR 换行" >&2; return 2; fi
  if ! awk '
    /^[[:space:]]*$/ {next}
    /^#/ {next}
    /^[A-Za-z_][A-Za-z0-9_]*=/ {next}
    {exit 1}
  ' "$file"; then
    echo "环境文件必须使用 KEY=value 规范语法；禁止前导空白、export 或键名周边空白" >&2
    return 2
  fi
  if grep -q 'PLACEHOLDER' "$file"; then echo "环境文件仍含 PLACEHOLDER" >&2; return 2; fi
  for key in DEEPSEEK_API_KEY ZHIPU_CODING_TOKEN KIMI_CODING_TOKEN GATEWAY_KEY_PEPPER \
    SESSION_AFFINITY_HMAC_KEY CREDENTIAL_KEK COOKIE_SECRET POSTGRES_DB POSTGRES_USER \
    POSTGRES_PASSWORD WEB_ORIGIN; do
    count="$(awk -F= -v wanted="$key" '$1 == wanted {count++} END {print count + 0}' "$file")"
    test "$count" = 1 || { echo "环境文件要求 ${key} 恰好出现一次" >&2; return 2; }
    value="$(awk -v wanted="$key" 'index($0, wanted "=") == 1 {sub(/^[^=]*=/, ""); print; exit}' "$file")"
    case "$value" in ""|[[:space:]]*|*[[:space:]]) echo "环境变量 ${key} 为空或含首尾空白" >&2; return 2;; esac
  done
  for assignment in \
    NODE_ENV=production \
    CONTENT_RETENTION_MODE=METADATA_ONLY \
    FEATURE_DIRECTORY_IMPORT=true \
    FEATURE_USAGE_OVERVIEW_V2=true \
    FEATURE_DEPARTMENT_COST=true \
    FEATURE_RESOURCE_UTILIZATION_V2=true \
    FEATURE_PROCUREMENT_REVIEW=true; do
    key="${assignment%%=*}"
    count="$(awk -F= -v wanted="$key" '$1 == wanted {count++} END {print count + 0}' "$file")"
    test "$count" = 1 || { echo "环境文件要求 ${key} 恰好出现一次" >&2; return 2; }
    value="$(awk -v wanted="$key" 'index($0, wanted "=") == 1 {sub(/^[^=]*=/, ""); print; exit}' "$file")"
    test "$value" = "${assignment#*=}" || { echo "环境文件必须设置 ${assignment}" >&2; return 2; }
  done
}

if test "${1:-}" = "--check-contract"; then
  test "$#" = 1 || { echo "用法: $0 --check-contract" >&2; exit 2; }
  bash -n "$0"
  grep -q 'candidate_ref="refs/heads/main"' "$0"
  grep -q 'target_head="0056_resource_monthly_budget"' "$0"
  grep -q '0055_upstream_error_evidence' "$0"
  grep -q '0056_resource_monthly_budget.js' "$0"
  grep -q 'test "$budget_schema_check" = "1,14,6,3"' "$0"
  echo "release_contract_check=PASS"
  exit 0
elif test "${1:-}" = "--check-env"; then
  test "$#" = 2 || { echo "用法: $0 --check-env <env-file>" >&2; exit 2; }
  validate_env_file "$2"
  echo "env_check=PASS"
  exit 0
elif test "$#" -ne 0; then
  echo "用法: $0 [--check-contract|--check-env <env-file>]" >&2
  exit 2
fi

repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
candidate_ref="refs/heads/main"
candidate_commit="${CANDIDATE_COMMIT:?请传入 GitHub 上已审核候选的完整 Commit SHA}"
candidate_tree="${CANDIDATE_TREE:?请传入已审核候选的完整 Tree SHA}"
target_head="0056_resource_monthly_budget"
server_home="${QIANLIU_SERVER_HOME:-/Users/stephen}"
product_commit="92ebb29284dfa654a72456663629473444659c2d"
product_tree="16fb8c3fbd1ee2ce0b424653599aba5ac977f31c"
compose_sha="d879661443997680f0236e0e0f231cf367e484b870f21545ff1023b7f7c75fee"
caddy_sha="4ac0c0f85548f695720a1761bfccf77064ab03cc04f876c77379021944fa659e"

for value in "$candidate_commit" "$candidate_tree"; do
  test "${#value}" = 40
  case "$value" in *[!0-9a-f]*) echo "Commit/Tree 必须是 40 位小写十六进制 Hash" >&2; exit 2;; esac
done

stamp="$(date '+%Y%m%d-%H%M%S')"
candidate_short="${candidate_commit:0:7}"
release="${server_home}/releases/qianliu-zhisuan-pool20-045-049-${candidate_short}-${stamp}"
current_pointer="${server_home}/qianliu-current-release.txt"
backup_dir="${server_home}/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-pool20-045-049-${stamp}.dump"
log_dir="${server_home}/logs/qianliu-zhisuan"
log_file="${log_dir}/deploy-pool20-045-049-${candidate_short}-${stamp}.log"
lock_dir="${server_home}/.qianliu-pool20-045-049-release.lock"

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "已有发布任务持有锁: $lock_dir" >&2
  test -f "$lock_dir/owner" && sed -n '1,5p' "$lock_dir/owner" >&2
  exit 2
fi
printf 'pid=%s\ncommit=%s\nstarted_at=%s\n' "$$" "$candidate_commit" "$(date -Iseconds)" > "$lock_dir/owner"
unlock() { rm -f "$lock_dir/owner" 2>/dev/null || true; rmdir "$lock_dir" 2>/dev/null || true; }
trap unlock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for command_name in awk curl docker git shasum; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "缺少命令: $command_name" >&2; exit 2; }
done

test -r "$current_pointer"
previous="$(<"$current_pointer")"
case "$previous" in "$server_home"/releases/*) ;; *) echo "非法 current release: $previous" >&2; exit 2;; esac
test -f "$previous/deploy/compose.yaml"
test -f "$previous/deploy/.env"
for service in control-api gateway worker web caddy; do
  container="qianliu-zhisuan-${service}-1"
  test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
    "$container")" = "$previous/deploy"
done

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
success=0
cleanup_running=0
pointer_switch_started=0
handle_failure() {
  local status="$1" failed_line="${2:-unknown}" service current_head rollback_images_ok=1
  test "$cleanup_running" = 0 || return
  cleanup_running=1
  set +e
  log "FAILED status=${status} line=${failed_line}"
  if test "$pointer_switch_started" = 1; then
    printf '%s\n' "$previous" > "${current_pointer}.rollback"
    mv "${current_pointer}.rollback" "$current_pointer"
    log "current release pointer restored=${previous}"
  fi
  if test "$images_frozen" = 1; then
    for service in control-api gateway worker web; do
      docker image tag "qianliu-pool20-045-049-rollback-${candidate_short}-${service}" \
        "qianliu-zhisuan-${service}" || { rollback_images_ok=0; log "rollback image restore failed service=${service}"; }
    done
  fi
  if test "$paused" = 1; then
    current_head="$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;' 2>/dev/null || true)"
    if test "$migration_started" = 0 || test "$current_head" = "$source_head"; then
      if test "$rollback_images_ok" = 1; then
        log "database=${current_head:-unknown}; restarting previous release=${previous}"
        (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
          control-api gateway worker web caddy) \
          || log "previous release restart failed; keep write pause and repair manually"
      else
        docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
          qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 \
          >/dev/null 2>&1 || true
        log "old image restore incomplete; business services remain stopped"
      fi
    else
      docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
        qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 \
        >/dev/null 2>&1 || true
      log "database=${current_head:-unknown}; migration changed database, business services remain stopped"
      log "restore backup first: ${backup} (expected migration after restore: ${source_head})"
      log "restore step 1: docker compose --project-directory '${previous}/deploy' exec -T postgres sh -ceu 'case \"\$POSTGRES_DB\" in postgres|template0|template1) exit 1;; esac; dropdb --if-exists --force -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"; createdb -U \"\$POSTGRES_USER\" -O \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"'"
      log "restore step 2: docker compose --project-directory '${previous}/deploy' exec -T postgres sh -ceu 'pg_restore --exit-on-error --no-owner -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' < '${backup}'"
      log "restore step 3: verify: docker compose --project-directory '${previous}/deploy' exec -T postgres sh -lc '${pg_sh} -Atqc \"SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1\"'  # must equal ${source_head}"
      log "restore step 4: for service in control-api gateway worker web; do docker image tag \"qianliu-pool20-045-049-rollback-${candidate_short}-\$service\" \"qianliu-zhisuan-\$service\"; done"
      log "restore step 5: (cd '${previous}/deploy' && docker compose up -d --no-build --force-recreate --no-deps control-api gateway worker web caddy)"
    fi
  fi
}
on_exit() {
  local status=$? failed_line="${BASH_LINENO[0]:-unknown}"
  trap - EXIT HUP INT TERM
  if test "$success" != 1; then handle_failure "$status" "$failed_line"; fi
  unlock
  exit "$status"
}
trap - EXIT HUP INT TERM
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap on_exit EXIT

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
test "$(git -C "$release" rev-parse "${product_commit}^{tree}")" = "$product_tree"
git -C "$release" merge-base --is-ancestor "$product_commit" "$candidate_commit"
test -f "$release/packages/database/migrations/0053_operating_bill_opening_balance.js"
test -f "$release/packages/database/migrations/0054_usage_aggregate_settlement_time.js"
test -f "$release/packages/database/migrations/0055_upstream_error_evidence.js"
test -f "$release/packages/database/migrations/0056_resource_monthly_budget.js"
unexpected_migrations="$(find "$release/packages/database/migrations" -maxdepth 1 -type f -name '*.js' \
  -exec basename {} \; | awk -F_ '$1 ~ /^[0-9]+$/ && ($1 + 0) > 56 {print}')"
test -z "$unexpected_migrations"
git -C "$release" diff --quiet "$product_commit..$candidate_commit" -- \
  deploy/compose.yaml deploy/caddy/Caddyfile deploy/postgres-init
test "$(shasum -a 256 "$release/deploy/compose.yaml" | awk '{print $1}')" = "$compose_sha"
test "$(shasum -a 256 "$release/deploy/caddy/Caddyfile" | awk '{print $1}')" = "$caddy_sha"
migration_0053_sha="$(shasum -a 256 "$release/packages/database/migrations/0053_operating_bill_opening_balance.js" | awk '{print $1}')"
migration_0054_sha="$(shasum -a 256 "$release/packages/database/migrations/0054_usage_aggregate_settlement_time.js" | awk '{print $1}')"
migration_0055_sha="$(shasum -a 256 "$release/packages/database/migrations/0055_upstream_error_evidence.js" | awk '{print $1}')"
migration_0056_sha="$(shasum -a 256 "$release/packages/database/migrations/0056_resource_monthly_budget.js" | awk '{print $1}')"
test "${#migration_0053_sha}" = 64
test "${#migration_0054_sha}" = 64
test "${#migration_0055_sha}" = 64
test "${#migration_0056_sha}" = 64
cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
validate_env_file "$release/deploy/.env"
(cd "$release/deploy" && docker compose config --quiet)

log "step 2: verify supported production database baseline"
source_head="$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;')"
test "$source_head" = "0055_upstream_error_evidence" \
  || { log "unsupported source migration=${source_head}; expected 0055"; exit 2; }
log "database source=${source_head} target=${target_head}"

log "step 3: freeze previous application images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-pool20-045-049-rollback-${candidate_short}-${service}"
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
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'operating_bill_opening_balance'),
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'usage_bucket_aggregate'
        AND column_name IN ('provider_reported_count','estimated_count','account_aggregated_count','mixed_count','unknown_count')),
    (SELECT count(*) FROM pg_constraint
      WHERE conname = 'usage_event_quality_check' AND pg_get_constraintdef(oid) LIKE '%MIXED%'),
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'upstream_attempt'
        AND column_name IN ('upstream_error_evidence','request_shape_summary')),
    (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('upstream_attempt_error_evidence_object_check',
                        'upstream_attempt_request_shape_object_check',
                        'upstream_attempt_diagnostic_pair_check',
                        'upstream_attempt_diagnostic_status_check'))
  );")"
test "$schema_check" = "1,5,1,2,4"
budget_schema_check="$(db_query "
  SELECT concat_ws(',',
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'provider_resource_monthly_budget'),
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'provider_resource_monthly_budget'),
    (SELECT count(*) FROM pg_constraint
      WHERE conname IN ('provider_resource_monthly_budget_resource_tenant_fk',
                        'provider_resource_monthly_budget_actor_tenant_fk',
                        'provider_resource_monthly_budget_month_check',
                        'provider_resource_monthly_budget_version_check',
                        'provider_resource_monthly_budget_status_check',
                        'provider_resource_monthly_budget_value_check')),
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN ('provider_resource_monthly_budget_version_uq',
                          'provider_resource_monthly_budget_idempotency_uq',
                          'provider_resource_monthly_budget_current_uq'))
  );")"
test "$budget_schema_check" = "1,14,6,3"
log "migration evidence 0053_sha=${migration_0053_sha} 0054_sha=${migration_0054_sha} 0055_sha=${migration_0055_sha} 0056_sha=${migration_0056_sha}"
log "rollback boundary: 0055 diagnostic evidence and 0056 budget facts reject destructive down; restore verified backup instead"

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
pointer_switch_started=1
printf '%s\n' "$release" > "${current_pointer}.next"
mv "${current_pointer}.next" "$current_pointer"
test "$(<"$current_pointer")" = "$release"
success=1
paused=0

log "COMPLETE release=${release} commit=${candidate_commit} tree=${candidate_tree} source=${source_head} target=${target_head} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} backup=${backup} backup_sha256=${backup_sha} current_pointer=${release}"
