#!/usr/bin/env bash
# 生产热修 POOL-045/046。
#
# 数据库基线：0044_operating_bill_model_identity
# 目标迁移：0045_zhipu_weekday_window_alias
# 发布源：GitHub main 的精确 commit，由 CANDIDATE_COMMIT 传入完整 40 位 SHA。
#
# 失败策略：
# - 迁移前失败：恢复旧应用镜像并重启上一 release；数据库仍为 0044。
# - 数据库发生迁移后失败：恢复旧应用镜像 tag，但保持业务停写；必须先用本次
#   pg_dump 备份恢复数据库到 0044，再启动上一 release，禁止旧应用在 0045 上写入。
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
release="/Users/stephen/releases/qianliu-zhisuan-pool045046-${candidate_short}-${stamp}"
current_pointer="/Users/stephen/qianliu-current-release.txt"
test -r "$current_pointer"
previous="$(<"$current_pointer")"
case "$previous" in
  /Users/stephen/releases/*) ;;
  *) printf '非法 current release 路径：%s\n' "$previous" >&2; exit 2 ;;
esac
test -f "$previous/deploy/compose.yaml"

backup_dir="/Users/stephen/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-pool045046-${stamp}.dump"
log_dir="/Users/stephen/logs/qianliu-zhisuan"
log_file="${log_dir}/deploy-pool045046-${candidate_short}-${stamp}.log"
# shellcheck disable=SC2016 # 变量必须在 postgres 容器内展开。
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
        docker image tag "qianliu-rollback-${candidate_short}-${service}" \
          "qianliu-zhisuan-${service}" || rollback_images_ok=0
      else
        rollback_images_ok=0
        log "rollback image missing service=${service}"
      fi
    done
    log "application rollback tags restored=${rollback_images_ok}"

    current_migration="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null || true)"
    if test "$migration_started" = 0 \
      || test "$current_migration" = "0044_operating_bill_model_identity"; then
      log "database=${current_migration:-unknown}; restarting previous release=${previous}"
      (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
        control-api gateway worker web caddy) \
        || log "previous release restart failed; keep write pause and repair manually"
    else
      docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
        qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 \
        >/dev/null 2>&1 || true
      log "database=${current_migration:-unknown}; old application images are ready but business services remain stopped"
      log "数据库已发生迁移，完整回退必须先从备份恢复到 0044；脚本不会自动执行破坏性 pg_restore"
      log "restore command: docker compose --project-directory '${previous}/deploy' exec -T postgres sh -lc 'pg_restore --exit-on-error --clean --if-exists --no-owner -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' < '${backup}'"
      log "restore 后先确认 latest migration=0044_operating_bill_model_identity，再执行: (cd '${previous}/deploy' && docker compose up -d --no-build --force-recreate --no-deps control-api gateway worker web caddy)"
    fi
  fi
  exit "$status"
}
trap rollback ERR

log "step 1: fetch GitHub main candidate=${candidate_commit}"
git -C "$release" init
git -C "$release" remote add origin "$repo_url"
remote_main="$(GIT_TERMINAL_PROMPT=0 git -C "$release" ls-remote origin refs/heads/main | awk 'NR == 1 {print $1}')"
test "$remote_main" = "$candidate_commit"
GIT_TERMINAL_PROMPT=0 git -C "$release" fetch --depth 1 origin "$candidate_commit"
test "$(git -C "$release" rev-parse FETCH_HEAD)" = "$candidate_commit"
git -C "$release" checkout --detach "$candidate_commit"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate_commit"
test -z "$(git -C "$release" status --porcelain --untracked-files=all)"
test -f "$release/packages/database/migrations/0045_zhipu_weekday_window_alias.js"
unexpected_migrations="$(
  find "$release/packages/database/migrations" -maxdepth 1 -type f -name '*.js' -exec basename {} \; \
    | awk -F_ '$1 ~ /^[0-9]+$/ && ($1 + 0) > 45 { print }'
)"
test -z "$unexpected_migrations"
cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
(cd "$release/deploy" && docker compose config --quiet)
log "GitHub main commit verified; release=${release}"

log "step 2: verify production baseline"
latest_before="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;")"
test "$latest_before" = "0044_operating_bill_model_identity"
legacy_target_policy_count="$(db_query "
  SELECT COUNT(*)
  FROM dispatch_policy
  WHERE policy_version = 'v2'
    AND status = 'PUBLISHED'
    AND action = 'REJECT'
    AND match_unified_model = 'qianliu-zhipu-glm-5-2'
    AND match_timezone = 'Asia/Shanghai'
    AND match_days_of_week = '[1,2,3,4,5]'::jsonb
    AND LEFT(match_start_time, 5) = '14:00'
    AND LEFT(match_end_time, 5) = '18:00'
    AND priority = 10;
")"
test "$legacy_target_policy_count" = 1
current_target_policy_count="$(db_query "
  SELECT COUNT(*)
  FROM dispatch_policy
  WHERE policy_version = 'v2'
    AND status = 'PUBLISHED'
    AND action = 'REJECT'
    AND match_unified_model = 'ql-glm-5.2'
    AND match_timezone = 'Asia/Shanghai'
    AND match_days_of_week = '[1,2,3,4,5]'::jsonb
    AND LEFT(match_start_time, 5) = '14:00'
    AND LEFT(match_end_time, 5) = '18:00'
    AND priority = 10;
")"
test "$current_target_policy_count" = 0
legacy_target_billing_count="$(db_query "
  SELECT COUNT(DISTINCT br.rule_version)
  FROM billing_rule AS br
  JOIN provider_resource AS pr
    ON pr.id = br.provider_resource_id
   AND pr.enterprise_id = br.enterprise_id
  JOIN provider AS p
    ON p.id = pr.provider_id
   AND p.enterprise_id = pr.enterprise_id
  WHERE p.code = 'zhipu'
    AND br.rule_type = 'TIME_WINDOW'
    AND br.enabled = TRUE
    AND br.multiplier = 3
    AND ((br.rule_version = 'zhipu-peak-v2' AND br.upstream_model = 'glm-5.2')
      OR (br.rule_version = 'zhipu-peak-v1' AND br.upstream_model = '5.2'))
    AND ((br.timezone = 'Asia/Shanghai'
      AND br.days_of_week = '[1,2,3,4,5,6,7]'::jsonb
      AND LEFT(br.start_time, 5) = '14:00'
      AND LEFT(br.end_time, 5) = '18:00')
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(br.time_windows, '[]'::jsonb)) AS item(value)
        WHERE item.value ->> 'timezone' = 'Asia/Shanghai'
          AND item.value -> 'days_of_week' = '[1,2,3,4,5,6,7]'::jsonb
          AND LEFT(item.value ->> 'start_time', 5) = '14:00'
          AND LEFT(item.value ->> 'end_time', 5) = '18:00'
      ));
")"
test "$legacy_target_billing_count" = 2
log "database baseline=${latest_before} legacy_policy=${legacy_target_policy_count} current_policy=${current_target_policy_count} legacy_billing_versions=${legacy_target_billing_count}"

log "step 3: freeze rollback images"
for service in control-api gateway worker web; do
  old_id="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  test -n "$old_id"
  docker image tag "$old_id" "qianliu-rollback-${candidate_short}-${service}"
done

log "step 4: build migration and application images"
(cd "$release/deploy" && docker compose build migrate control-api gateway worker web)
for service in migrate control-api gateway worker web; do
  test -n "$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-${service}")"
done

log "step 5: controlled write pause, final baseline check and backup"
paused=1
docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
  qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 >/dev/null

latest_paused="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;")"
test "$latest_paused" = "0044_operating_bill_model_identity"

docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
test "${#backup_sha}" = 64
log "backup verified path=${backup} sha256=${backup_sha}"

log "step 6: migrate 0044 → 0045"
migration_started=1
(cd "$release/deploy" && docker compose run --rm --no-deps migrate)

latest_after="$(db_query "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;")"
test "$latest_after" = "0045_zhipu_weekday_window_alias"
migration_count="$(db_query "SELECT COUNT(*) FROM kysely_migration WHERE name = '0045_zhipu_weekday_window_alias';")"
test "$migration_count" = 1

policy_v2_count="$(db_query "
  SELECT COUNT(*)
  FROM dispatch_policy
  WHERE policy_version = 'v2'
    AND status = 'PUBLISHED'
    AND action = 'REJECT'
    AND match_unified_model = 'ql-glm-5.2'
    AND match_timezone = 'Asia/Shanghai'
    AND match_days_of_week = '[1,2,3,4,5]'::jsonb
    AND LEFT(match_start_time, 5) = '14:00'
    AND LEFT(match_end_time, 5) = '18:00'
    AND priority = 10;
")"
test "$policy_v2_count" = 1
legacy_policy_alias_count="$(db_query "
  SELECT COUNT(*)
  FROM dispatch_policy
  WHERE policy_version = 'v2'
    AND status = 'PUBLISHED'
    AND action = 'REJECT'
    AND match_unified_model = 'qianliu-zhipu-glm-5-2'
    AND match_timezone = 'Asia/Shanghai'
    AND match_days_of_week = '[1,2,3,4,5]'::jsonb
    AND LEFT(match_start_time, 5) = '14:00'
    AND LEFT(match_end_time, 5) = '18:00'
    AND priority = 10;
")"
test "$legacy_policy_alias_count" = 0

billing_window_versions="$(db_query "
  WITH target_rules AS (
    SELECT br.*
    FROM billing_rule AS br
    JOIN provider_resource AS pr
      ON pr.id = br.provider_resource_id
     AND pr.enterprise_id = br.enterprise_id
    JOIN provider AS p
      ON p.id = pr.provider_id
     AND p.enterprise_id = pr.enterprise_id
    WHERE p.code = 'zhipu'
      AND br.rule_type = 'TIME_WINDOW'
      AND br.enabled = TRUE
      AND br.multiplier = 3
      AND ((br.rule_version = 'zhipu-peak-v2' AND br.upstream_model = 'glm-5.2')
        OR (br.rule_version = 'zhipu-peak-v1' AND br.upstream_model = '5.2'))
  ), target_windows AS (
    SELECT rule_version, days_of_week AS window_days
    FROM target_rules
    WHERE timezone = 'Asia/Shanghai'
      AND LEFT(start_time, 5) = '14:00'
      AND LEFT(end_time, 5) = '18:00'
    UNION ALL
    SELECT tr.rule_version, item.value -> 'days_of_week' AS window_days
    FROM target_rules AS tr
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tr.time_windows, '[]'::jsonb)) AS item(value)
    WHERE item.value ->> 'timezone' = 'Asia/Shanghai'
      AND LEFT(item.value ->> 'start_time', 5) = '14:00'
      AND LEFT(item.value ->> 'end_time', 5) = '18:00'
  )
  SELECT COUNT(DISTINCT rule_version) FROM target_windows;
")"
test "$billing_window_versions" = 2

invalid_billing_window_count="$(db_query "
  WITH target_rules AS (
    SELECT br.*
    FROM billing_rule AS br
    JOIN provider_resource AS pr
      ON pr.id = br.provider_resource_id
     AND pr.enterprise_id = br.enterprise_id
    JOIN provider AS p
      ON p.id = pr.provider_id
     AND p.enterprise_id = pr.enterprise_id
    WHERE p.code = 'zhipu'
      AND br.rule_type = 'TIME_WINDOW'
      AND br.enabled = TRUE
      AND br.multiplier = 3
      AND ((br.rule_version = 'zhipu-peak-v2' AND br.upstream_model = 'glm-5.2')
        OR (br.rule_version = 'zhipu-peak-v1' AND br.upstream_model = '5.2'))
  ), target_windows AS (
    SELECT rule_version, days_of_week AS window_days
    FROM target_rules
    WHERE timezone = 'Asia/Shanghai'
      AND LEFT(start_time, 5) = '14:00'
      AND LEFT(end_time, 5) = '18:00'
    UNION ALL
    SELECT tr.rule_version, item.value -> 'days_of_week' AS window_days
    FROM target_rules AS tr
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(tr.time_windows, '[]'::jsonb)) AS item(value)
    WHERE item.value ->> 'timezone' = 'Asia/Shanghai'
      AND LEFT(item.value ->> 'start_time', 5) = '14:00'
      AND LEFT(item.value ->> 'end_time', 5) = '18:00'
  )
  SELECT COUNT(*)
  FROM target_windows
  WHERE window_days IS DISTINCT FROM '[1,2,3,4,5]'::jsonb;
")"
test "$invalid_billing_window_count" = 0
log "0045 verified policy_v2=${policy_v2_count} legacy_alias=${legacy_policy_alias_count} billing_versions=${billing_window_versions} invalid_windows=${invalid_billing_window_count}"

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
    log "health ready attempt=${attempt}"
    break
  fi
  sleep 2
done
test "$control_code" = 200
test "$gateway_code" = 200
test "$web_code" = 200
test "$worker_health" = healthy

log "step 8: verify commit, images, restarts, database and current pointer"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate_commit"
test -z "$(git -C "$release" status --porcelain --untracked-files=all)"

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
test "$final_latest" = "0045_zhipu_weekday_window_alias"

printf '%s\n' "$release" > "${current_pointer}.next"
mv "${current_pointer}.next" "$current_pointer"
test "$(<"$current_pointer")" = "$release"
paused=0

log "COMPLETE release=${release} commit=${candidate_commit} database=${final_latest} control=${control_code} gateway=${gateway_code} web=${web_code} worker=${worker_health} caddy_restarts=${caddy_restarts} backup=${backup} backup_sha256=${backup_sha} current_pointer=${release}"
