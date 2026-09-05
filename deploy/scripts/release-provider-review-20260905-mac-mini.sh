#!/usr/bin/env bash
# 厂商模块复盘修复：从已部署的首轮候选原位发布利用率口径修正。

set -Eeuo pipefail
umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"

if test "${1:-}" = "--check-contract"; then
  test "$#" = 1
  bash -n "$0"
  grep -q 'candidate_ref="refs/heads/codex/provider-module-review-20260905"' "$0"
  grep -q 'source_commit="acad686cc8876fa4b7322f945273e7c97a8f000f"' "$0"
  grep -q 'expected_migration="0063_operating_snapshot_subscription_period"' "$0"
  echo "release_contract_check=PASS"
  exit 0
elif test "$#" -ne 0; then
  echo "用法: $0 [--check-contract]" >&2
  exit 2
fi

repo_url="git@github.com:Stephen66000/qianliu-zhisuan.git"
candidate_ref="refs/heads/codex/provider-module-review-20260905"
candidate_commit="${CANDIDATE_COMMIT:?请传入已审核候选的完整 Commit SHA}"
candidate_tree="${CANDIDATE_TREE:?请传入已审核候选的完整 Tree SHA}"
source_commit="acad686cc8876fa4b7322f945273e7c97a8f000f"
expected_migration="0063_operating_snapshot_subscription_period"
server_root="${QIANLIU_SERVER_HOME:-/Users/stephen}"
current_pointer="${server_root}/qianliu-current-release.txt"

for value in "$candidate_commit" "$candidate_tree"; do
  test "${#value}" = 40
  case "$value" in *[!0-9a-f]*) echo "Commit/Tree 必须是 40 位小写十六进制 Hash" >&2; exit 2;; esac
done

stamp="$(date '+%Y%m%d-%H%M%S')"
short="${candidate_commit:0:7}"
release="${server_root}/releases/qianliu-provider-review-${short}-${stamp}"
backup_dir="${server_root}/backups/qianliu-zhisuan"
backup="${backup_dir}/pre-provider-review-${short}-${stamp}.dump"
log_dir="${server_root}/logs/qianliu-zhisuan"
log_file="${log_dir}/deploy-provider-review-${short}-${stamp}.log"
lock_dir="${server_root}/.qianliu-provider-review-release.lock"

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "已有厂商模块发布任务持有锁: $lock_dir" >&2
  test -f "$lock_dir/owner" && sed -n '1,5p' "$lock_dir/owner" >&2
  exit 2
fi
printf 'pid=%s\ncommit=%s\nstarted_at=%s\n' "$$" "$candidate_commit" "$(date -Iseconds)" > "$lock_dir/owner"
unlock() { rm -f "$lock_dir/owner" 2>/dev/null || true; rmdir "$lock_dir" 2>/dev/null || true; }

images_frozen=0
paused=0
pointer_switched=0
success=0
previous=""
control_code=000
gateway_code=000
web_code=000
caddy_code=000
worker_health=unknown

stop_business() {
  local service running stop_ok=1
  docker stop qianliu-zhisuan-caddy-1 qianliu-zhisuan-gateway-1 \
    qianliu-zhisuan-control-api-1 qianliu-zhisuan-web-1 qianliu-zhisuan-worker-1 \
    >/dev/null 2>&1 || stop_ok=0
  for service in caddy gateway control-api web worker; do
    running="$(docker inspect --format '{{.State.Running}}' "qianliu-zhisuan-${service}-1" 2>/dev/null)" \
      || stop_ok=0
    test "$running" = false || stop_ok=0
  done
  test "$stop_ok" = 1
}
wait_for_health() {
  local attempt
  for attempt in $(seq 1 45); do
    control_code="$(curl --connect-timeout 1 --max-time 2 -sS -o /dev/null -w '%{http_code}' \
      http://127.0.0.1:8788/health || true)"
    gateway_code="$(curl --connect-timeout 1 --max-time 2 -sS -o /dev/null -w '%{http_code}' \
      http://127.0.0.1:8787/health || true)"
    web_code="$(curl --connect-timeout 1 --max-time 2 -sS -o /dev/null -w '%{http_code}' \
      http://127.0.0.1:8080/ || true)"
    caddy_code="$(curl --connect-timeout 1 --max-time 2 -sS -o /dev/null -w '%{http_code}' \
      http://127.0.0.1/health || true)"
    worker_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      qianliu-zhisuan-worker-1 2>/dev/null || true)"
    if test "$control_code" = 200 && test "$gateway_code" = 200 \
      && test "$web_code" = 200 && test "$caddy_code" = 200 \
      && test "$worker_health" = healthy; then
      return 0
    fi
    sleep 2
  done
  return 1
}
rollback() {
  local status="$1" line="$2" service rollback_images_ok=1 rollback_runtime_ok=1
  set +e
  printf '[%s] FAILED status=%s line=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$status" "$line"
  if test "$pointer_switched" = 1 && test -n "$previous"; then
    printf '%s\n' "$previous" > "${current_pointer}.rollback"
    mv "${current_pointer}.rollback" "$current_pointer"
  fi
  if test "$images_frozen" = 1; then
    for service in control-api gateway worker web; do
      docker image tag "qianliu-provider-review-rollback-${short}-${service}" \
        "qianliu-zhisuan-${service}" || rollback_images_ok=0
    done
  fi
  if test "$paused" = 1 && test -n "$previous"; then
    if test "$rollback_images_ok" != 1; then
      if stop_business; then
        echo "ERROR: 旧镜像未完整恢复；已确认业务服务停止，请人工处置" >&2
      else
        echo "ERROR: 旧镜像未完整恢复且停止状态未确认；业务可能仍在运行，请立即人工处置" >&2
      fi
      return
    fi
    (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
      control-api gateway worker web caddy) || rollback_runtime_ok=0
    for service in control-api gateway worker web; do
      container="qianliu-zhisuan-${service}-1"
      test "$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" = \
        "$(docker image inspect --format '{{.Id}}' "qianliu-provider-review-rollback-${short}-${service}" 2>/dev/null)" \
        || rollback_runtime_ok=0
      test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
        "$container" 2>/dev/null)" = "$previous/deploy" || rollback_runtime_ok=0
    done
    test "$(docker inspect --format '{{.State.Running}}' qianliu-zhisuan-caddy-1 2>/dev/null)" = true \
      || rollback_runtime_ok=0
    test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' \
      qianliu-zhisuan-caddy-1 2>/dev/null)" = "$previous/deploy" || rollback_runtime_ok=0
    wait_for_health || rollback_runtime_ok=0
    if test "$rollback_runtime_ok" = 1; then
      echo "已验证恢复上一发布目录: $previous"
    else
      if stop_business; then
        echo "ERROR: 上一发布恢复验收失败；已确认业务服务停止，请人工处置" >&2
      else
        echo "ERROR: 上一发布恢复验收失败且停止状态未确认；业务可能仍在运行，请立即人工处置" >&2
      fi
    fi
  fi
}
on_exit() {
  local status=$? line="${BASH_LINENO[0]:-unknown}"
  trap - EXIT HUP INT TERM
  test "$success" = 1 || rollback "$status" "$line"
  unlock
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for command_name in awk curl docker git shasum; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "缺少命令: $command_name" >&2; exit 2; }
done

test -r "$current_pointer"
previous="$(<"$current_pointer")"
case "$previous" in "${server_root}"/releases/*) ;; *) echo "非法 current release: $previous" >&2; exit 2;; esac
test -f "$previous/deploy/compose.yaml"
test -f "$previous/deploy/.env"
test "$(git -C "$previous" rev-parse HEAD)" = "$source_commit"
test -z "$(git -C "$previous" status --porcelain --untracked-files=all)"

for service in control-api gateway worker web caddy; do
  container="qianliu-zhisuan-${service}-1"
  test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container")" = "$previous/deploy"
done

mkdir -p "$release" "$backup_dir" "$log_dir"
exec > >(tee -a "$log_file") 2>&1
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# Variables intentionally expand only inside the PostgreSQL container.
# shellcheck disable=SC2016
pg_command='psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
db_query() {
  printf '%s\n' "$1" | docker compose --project-directory "$previous/deploy" \
    exec -T postgres sh -lc "$pg_command -Atq"
}

log "step 1: fetch exact GitHub candidate"
git -C "$release" init -q
git -C "$release" remote add origin "$repo_url"
remote_commit="$(GIT_SSH_COMMAND='ssh -o BatchMode=yes' GIT_TERMINAL_PROMPT=0 \
  git -C "$release" ls-remote origin "$candidate_ref" | awk 'NR == 1 {print $1}')"
test "$remote_commit" = "$candidate_commit"
GIT_SSH_COMMAND='ssh -o BatchMode=yes' GIT_TERMINAL_PROMPT=0 \
  git -C "$release" fetch --depth 64 origin "$candidate_ref"
test "$(git -C "$release" rev-parse FETCH_HEAD)" = "$candidate_commit"
git -C "$release" checkout -q --detach "$candidate_commit"
test "$(git -C "$release" rev-parse 'HEAD^{tree}')" = "$candidate_tree"
test -z "$(git -C "$release" status --porcelain --untracked-files=all)"
git -C "$release" merge-base --is-ancestor "$source_commit" "$candidate_commit"

log "step 2: verify no migration or deployment-topology change"
git -C "$release" diff --quiet "$source_commit..$candidate_commit" -- \
  packages/database/migrations deploy/compose.yaml deploy/caddy/Caddyfile deploy/postgres-init
test -f "$release/packages/database/migrations/0063_operating_snapshot_subscription_period.js"
unexpected_migrations="$(find "$release/packages/database/migrations" -maxdepth 1 -type f -name '*.js' \
  -exec basename {} \; | awk -F_ '$1 ~ /^[0-9]+$/ && ($1 + 0) > 63 {print}')"
test -z "$unexpected_migrations"
test "$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;')" = "$expected_migration"

cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
(cd "$release/deploy" && docker compose config --quiet)

log "step 3: freeze current application images"
for service in control-api gateway worker web; do
  current_image="$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")"
  docker image tag "$current_image" "qianliu-provider-review-rollback-${short}-${service}"
done
images_frozen=1

log "step 4: build candidate while current release stays online"
(cd "$release/deploy" && docker compose build migrate control-api gateway worker web)

log "step 5: pause writes and create verified backup"
paused=1
(cd "$previous/deploy" && docker compose stop caddy gateway control-api web worker)
test "$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;')" = "$expected_migration"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
test "${#backup_sha}" = 64

log "step 6: start candidate without database migration"
(cd "$release/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
  control-api gateway worker web caddy)

wait_for_health
log "health ready control=${control_code} gateway=${gateway_code} web=${web_code} caddy=${caddy_code} worker=${worker_health}"

log "step 7: verify containers, database, and release pointer"
for service in control-api gateway worker web; do
  container="qianliu-zhisuan-${service}-1"
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container")" = "$release/deploy"
  test "$(docker inspect --format '{{.Image}}' "$container")" = \
    "$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-${service}")"
  test "$(docker inspect --format '{{.RestartCount}}' "$container")" = 0
done
test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' qianliu-zhisuan-caddy-1)" = "$release/deploy"
test "$(docker inspect --format '{{.State.Running}}' qianliu-zhisuan-caddy-1)" = true
test "$(docker inspect --format '{{.RestartCount}}' qianliu-zhisuan-caddy-1)" = 0
test "$caddy_code" = 200
test "$(db_query 'SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;')" = "$expected_migration"

pointer_switched=1
printf '%s\n' "$release" > "${current_pointer}.next"
mv "${current_pointer}.next" "$current_pointer"
test "$(<"$current_pointer")" = "$release"
success=1
paused=0

log "COMPLETE release=${release} commit=${candidate_commit} tree=${candidate_tree} database=${expected_migration} control=${control_code} gateway=${gateway_code} web=${web_code} caddy=${caddy_code} worker=${worker_health} backup=${backup} backup_sha256=${backup_sha}"
