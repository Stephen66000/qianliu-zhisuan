#!/usr/bin/env bash
# 集成发布 POOL-039/043，并保留已上线的 POOL-040/041。
#
# 数据库基线：0042_alias_ql_format
# 目标迁移链：0042 → 0043_single_owner_rule_history → 0044_operating_bill_model_identity
# 发布源：GitHub main 的精确 commit，由 CANDIDATE_COMMIT 传入完整 40 位 SHA。
#
# 失败策略：
# - 迁移前失败：恢复旧应用镜像并重启上一 release；数据库仍为 0042。
# - 数据库发生迁移后失败：恢复旧应用镜像 tag，但保持业务停写；必须先用本次
#   pg_dump 备份恢复数据库到 0042，再启动上一 release，禁止旧应用在 0044 上继续写入。
set -Eeuo pipefail

umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

repo_url="https://github.com/Stephen66000/qianliu-zhisuan.git"
candidate_commit="${CANDIDATE_COMMIT:?请传入已上传到 GitHub main 的完整候选 commit SHA}"
test "${#candidate_commit}" = 40
case "$candidate_commit" in
  *[!0-9a-f]*) printf 'CANDIDATE_COMMIT 必须是 40 位小写十六进制 SHA\n' >&2; exit 2 ;;
esac

candidate_short="${candidate_commit:0:7}"
stamp="$(date '+%Y%m%d-%H%M%S')"
release="/Users/stephen/releases/qianliu-zhisuan-pool039043-${candidate_short}-${stamp}"
current_pointer="/Users/stephen/qianliu-current-release.txt"
test -r "$current_pointer"
previous="$(<"$current_pointer")"
case "$previous" in
  /Users/stephen/releases/*) ;;
  *) printf '非法 current release 路径：%s\n' "$previous" >&2; exit 2 ;;
esac
test -f "$previous/deploy/compose.yaml"

backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-pool039043-${stamp}.dump"
log_dir="/Users/stephen/logs/qianliu-zhisuan"
log_file="${log_dir}/deploy-pool039043-${candidate_short}-${stamp}.log"
PG_SH='psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
paused=0
migration_started=0

mkdir -p "$release" "$backup_dir" "$log_dir"
exec > >(tee -a "$log_file") 2>&1

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

db_query() {
  local query="$1"
  printf '%s\n' "$query" | docker compose --project-directory "$previous/deploy" \
    exec -T postgres sh -lc "$PG_SH -Atq"
}

assert_no_migration_blockers() {
  local phase="$1"
  local duplicate_editable duplicate_published duplicate_attempt duplicate_usage

  duplicate_editable="$(db_query "
    SELECT COUNT(*) FROM (
      SELECT 1
      FROM employee_model_rule_version
      WHERE owner_principal_id IS NOT NULL
        AND status IN ('DRAFT', 'VALIDATED')
      GROUP BY enterprise_id, owner_principal_id
      HAVING COUNT(*) > 1
    ) blocker;
  ")"
  duplicate_published="$(db_query "
    SELECT COUNT(*) FROM (
      SELECT 1
      FROM employee_model_rule_version
      WHERE owner_principal_id IS NOT NULL
        AND status = 'PUBLISHED'
      GROUP BY enterprise_id, owner_principal_id
      HAVING COUNT(*) > 1
    ) blocker;
  ")"
  duplicate_attempt="$(db_query "
    SELECT COUNT(*) FROM (
      SELECT 1
      FROM upstream_attempt
      GROUP BY ai_request_id, attempt_no
      HAVING COUNT(*) > 1
    ) blocker;
  ")"
  duplicate_usage="$(db_query "
    SELECT COUNT(*) FROM (
      SELECT 1
      FROM ledger_line
      WHERE usage_event_id IS NOT NULL
      GROUP BY usage_event_id
      HAVING COUNT(*) > 1
    ) blocker;
  ")"

  log "blockers phase=${phase} editable_owner=${duplicate_editable} published_owner=${duplicate_published} upstream_attempt=${duplicate_attempt} usage_event=${duplicate_usage}"
  test "$duplicate_editable" = 0
  test "$duplicate_published" = 0
  test "$duplicate_attempt" = 0
  test "$duplicate_usage" = 0
}

rollback() {
  local status=$?
  local failed_line="${BASH_LINENO[0]:-unknown}"
  local service current_migration rollback_images_ok
  trap - ERR
  set +e
  log "FAILED status=${status} line=${failed_line}"

  if test "$paused" = 1; then
    rollback_images_ok=1
    for service in control-api gateway worker web; do
      if docker image inspect "qianliu-rollback-${candidate_short}-${service}" >/dev/null 2>&1; then
        docker image tag "qianliu-rollback-${candidate_short}-${service}" "qianliu-zhisuan-${service}" || rollback_images_ok=0
      else
        rollback_images_ok=0
        log "rollback image missing service=${service}"
      fi
    done
    log "application rollback tags restored=${rollback_images_ok}"

    current_migration="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null || true)"
    if test "$migration_started" = 0 || test "$current_migration" = "0042_alias_ql_format"; then
      log "database=${current_migration:-unknown}; restarting previous release=${previous}"
      (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
        control-api gateway worker web caddy) || log "previous release restart failed; keep write pause and repair manually"
    else
      docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
        qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 \
        >/dev/null 2>&1 || true
      log "database=${current_migration:-unknown}; old application images are ready but business services remain stopped"
      log "数据库已发生迁移，完整回退必须先从备份恢复到 0042；脚本不会自动执行破坏性 pg_restore"
      log "restore command: docker compose --project-directory '${previous}/deploy' exec -T postgres sh -lc 'pg_restore --exit-on-error --clean --if-exists --no-owner -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' < '${backup}'"
      log "restore 后先确认 latest migration=0042_alias_ql_format，再执行: (cd '${previous}/deploy' && docker compose up -d --no-build --force-recreate --no-deps control-api gateway worker web caddy)"
    fi
  fi
  exit "$status"
}
trap rollback ERR

log "step 1: fetch GitHub main candidate=${candidate_commit}"
if ! test -d "$release/.git"; then git -C "$release" init; fi
git -C "$release" remote add origin "$repo_url"
remote_main="$(GIT_TERMINAL_PROMPT=0 git -C "$release" ls-remote origin refs/heads/main | awk 'NR == 1 {print $1}')"
test "$remote_main" = "$candidate_commit"
GIT_TERMINAL_PROMPT=0 git -C "$release" fetch --depth 1 origin "$candidate_commit"
test "$(git -C "$release" rev-parse FETCH_HEAD)" = "$candidate_commit"
git -C "$release" checkout --detach "$candidate_commit"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate_commit"
test -z "$(git -C "$release" status --porcelain --untracked-files=all)"
cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
(cd "$release/deploy" && docker compose config --quiet)
log "GitHub main commit verified; release=${release}"

log "step 2: live preflight on database baseline and migration blockers"
latest_before="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;")"
test "$latest_before" = "0042_alias_ql_format"
assert_no_migration_blockers "live"
log "database baseline=${latest_before}"

log "step 3: freeze rollback images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-${candidate_short}-${service}"
done

log "step 4: build migrate and application images"
(cd "$release/deploy" && docker compose build migrate control-api gateway worker web)
for service in migrate control-api gateway worker web; do
  test -n "$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-${service}")"
done

log "step 5: controlled write pause, final blockers and backup"
paused=1
docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 >/dev/null

latest_paused="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;")"
test "$latest_paused" = "0042_alias_ql_format"
assert_no_migration_blockers "write-paused"

docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
test "${#backup_sha}" = 64
log "backup verified path=${backup} sha256=${backup_sha}"

log "step 6: migrate 0042 → 0043 → 0044"
migration_started=1
(cd "$release/deploy" && docker compose run --rm --no-deps migrate)

latest_after="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;")"
test "$latest_after" = "0044_operating_bill_model_identity"
migration_chain="$(db_query "
  SELECT COALESCE(string_agg(name, ',' ORDER BY timestamp), '')
  FROM kysely_migration
  WHERE name IN ('0043_single_owner_rule_history', '0044_operating_bill_model_identity');
")"
test "$migration_chain" = "0043_single_owner_rule_history,0044_operating_bill_model_identity"

migration_columns="$(db_query "
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'employee_model_rule_version' AND column_name = 'publish_request_hash')
      OR (table_name = 'ai_request' AND column_name = 'unified_model_id'));
")"
test "$migration_columns" = 2

migration_indexes="$(db_query "
  SELECT COUNT(*)
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'employee_model_rule_single_owner_editable_uq',
      'employee_model_rule_single_owner_published_uq',
      'ai_request_enterprise_principal_model_started_idx',
      'ledger_line_enterprise_created_request_idx',
      'upstream_attempt_unique_request_no_idx',
      'ledger_line_unique_usage_event_idx'
    );
")"
test "$migration_indexes" = 6

unique_indexes="$(db_query "
  SELECT COUNT(*)
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'employee_model_rule_single_owner_editable_uq',
      'employee_model_rule_single_owner_published_uq',
      'upstream_attempt_unique_request_no_idx',
      'ledger_line_unique_usage_event_idx'
    )
    AND indexdef LIKE 'CREATE UNIQUE INDEX%';
")"
test "$unique_indexes" = 4

legacy_index="$(db_query "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'employee_model_rule_single_owner_uq';")"
test "$legacy_index" = 0
model_fk="$(db_query "SELECT COUNT(*) FROM pg_constraint WHERE conname = 'ai_request_enterprise_model_fk' AND contype = 'f';")"
test "$model_fk" = 1
unresolved_model_count="$(db_query "SELECT COUNT(*) FROM ai_request WHERE unified_model_id IS NULL;")"
log "migration verified chain=${migration_chain} unresolved_historical_model_ids=${unresolved_model_count}"

log "step 7: start candidate release"
(cd "$release/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
  control-api gateway worker web caddy)

control_code=000
gateway_code=000
web_code=000
worker_health=unknown
for attempt in $(seq 1 90); do
  control_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health || true)"
  gateway_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health || true)"
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
  worker_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' qianliu-zhisuan-worker-1 2>/dev/null || true)"
  if test "$control_code" = 200 && test "$gateway_code" = 200 \
    && test "$web_code" = 200 && test "$worker_health" = healthy; then
    break
  fi
  sleep 2
done
test "$control_code" = 200
test "$gateway_code" = 200
test "$web_code" = 200
test "$worker_health" = healthy

log "step 8: verify version, images, restarts and final database"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate_commit"
git -C "$release" diff --quiet
git -C "$release" diff --cached --quiet

for service in control-api gateway worker web; do
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "qianliu-zhisuan-${service}-1")" = "$release/deploy"
  expected_image="$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-${service}")"
  actual_image="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test "$actual_image" = "$expected_image"
  restart_count="$(docker inspect --format '{{.RestartCount}}' "qianliu-zhisuan-${service}-1")"
  test "$restart_count" = 0
done
caddy_running="$(docker inspect --format '{{.State.Running}}' qianliu-zhisuan-caddy-1)"
test "$caddy_running" = true
caddy_restarts="$(docker inspect --format '{{.RestartCount}}' qianliu-zhisuan-caddy-1)"
test "$caddy_restarts" = 0

final_latest="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;")"
test "$final_latest" = "0044_operating_bill_model_identity"
active_key_count="$(db_query "SELECT COUNT(*) FROM principal_key WHERE status = 'ACTIVE';")"

printf '%s\n' "$release" > "${current_pointer}.next"
mv "${current_pointer}.next" "$current_pointer"
paused=0

log "COMPLETE release=${release} commit=${candidate_commit} database=${final_latest} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} caddy_restarts=${caddy_restarts} active_keys=${active_key_count} backup=${backup} backup_sha256=${backup_sha}"
