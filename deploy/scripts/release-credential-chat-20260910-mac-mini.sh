#!/usr/bin/env bash
# 从已核对的生产 0072 原位升级同模型 Chat 探测与受控凭证恢复。默认只预检。
set -Eeuo pipefail
umask 077
export PATH="${PATH}:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"

candidate=fa864239167a2ca881b0bb7ad6641154da1dc38c
candidate_tree=134dc87198973319b3554ed26f529581d7357aba
expected_source=28f6a603c29986b56985f9e305a82cb6c51a9253
source_tree=2928ab83891701833d19c68502443eb506291a3c
source_migration=0072_admin_roles_security
target_migration=0073_credential_chat_probe
migration_sha=04fb892e6bcfaab723b28fe8029e9e14d7acd7dbf0382bc58fa560847dc78273
server_root=/Users/stephen
pointer="$server_root/qianliu-current-release.txt"
lock="$server_root/.qianliu-quota-pricing-release.lock"
services=(caddy web gateway control-api worker)
applications=(control-api gateway worker web)
mode="${1:---preflight}"

test "$#" -le 1
case "$mode" in
  --check-contract)
    bash -n "$0"
    echo "release_contract_check=PASS"
    exit 0
    ;;
  --preflight|--deploy) ;;
  *) echo "用法: $0 [--preflight|--deploy|--check-contract]" >&2; exit 2 ;;
esac

for value in "$candidate" "$candidate_tree" "$expected_source" "$source_tree" "$migration_sha"; do
  [[ "$value" =~ ^[0-9a-f]{40}$ || "$value" =~ ^[0-9a-f]{64}$ ]]
done
for command_name in awk curl docker git mktemp shasum; do
  command -v "$command_name" >/dev/null
done

previous="$(cat "$pointer")"
case "$previous" in "$server_root"/releases/*) ;; *) echo "STOP: 非法发布指针 $previous" >&2; exit 2 ;; esac
test "$(cd "$previous" && pwd -P)" = "$previous"
actual_source="$(git -C "$previous" rev-parse HEAD)"
printf 'OBSERVED release=%s commit=%s\nEXPECTED source=%s candidate=%s\n' \
  "$previous" "$actual_source" "$expected_source" "$candidate"
test "$actual_source" = "$expected_source" || {
  echo "STOP: 当前生产提交与预检基线不同，请把输出发回核对" >&2
  exit 2
}
test "$(git -C "$previous" rev-parse 'HEAD^{tree}')" = "$source_tree"
test -z "$(git -C "$previous" status --porcelain --untracked-files=all)"
test -f "$previous/deploy/.env"
(cd "$previous/deploy" && docker compose config --quiet)

source_names="$(git -C "$previous" ls-tree -r --name-only HEAD packages/database/migrations \
  | sed -n 's|^packages/database/migrations/\(.*\)\.js$|\1|p' | LC_ALL=C sort)"
test "$(printf '%s\n' "$source_names" | tail -1)" = "$source_migration"
target_names="$(printf '%s\n%s' "$source_names" "$target_migration")"

db_sql() {
  printf '%s\n' "$1" | docker compose --project-directory "$previous/deploy" exec -T postgres \
    sh -lc 'psql -X -v ON_ERROR_STOP=1 -Atq -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}
db_names() { db_sql 'SELECT name FROM kysely_migration ORDER BY name;'; }
require_db_names() {
  local actual_names
  actual_names="$(db_names)" || return 1
  test "$actual_names" = "$1"
}
verify_containers() {
  local directory="$1" service container
  for service in "${services[@]}"; do
    container="qianliu-zhisuan-$service-1"
    test "$(docker inspect --format '{{.State.Running}}' "$container")" = true || return 1
    test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")" = "$directory/deploy" || return 1
    if test "$service" != caddy; then
      test "$(docker inspect --format '{{.Image}}' "$container")" = \
        "$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-$service")" || return 1
    fi
  done
}
health() {
  local attempt port codes worker endpoint
  for ((attempt=0; attempt<30; attempt++)); do
    codes=""
    for port in 8788 8787 8080 80; do
      endpoint=/health
      test "$port" != 8080 || endpoint=/
      codes="$codes/$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' \
        "http://127.0.0.1:$port$endpoint" || true)"
    done
    worker="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      qianliu-zhisuan-worker-1 2>/dev/null || true)"
    if test "$codes/$worker" = "/200/200/200/200/healthy"; then return 0; fi
    sleep 2
  done
  echo "STOP: health=$codes/$worker" >&2
  return 1
}
stop_and_verify() {
  local service
  (cd "$previous/deploy" && docker compose stop "${services[@]}") || return 1
  for service in "${services[@]}"; do
    test "$(docker inspect --format '{{.State.Running}}' "qianliu-zhisuan-$service-1")" = false || return 1
  done
}

# Only the exact old chain or this additive migration is compatible with the previous images.
safe_previous() {
  local names
  names="$(db_names)" || return 1
  test "$names" = "$source_names" || test "$names" = "$target_names"
}

require_db_names "$source_names" || { echo "STOP: 数据库迁移历史与生产源码不一致" >&2; exit 2; }
verify_containers "$previous"
health
test ! -e "$lock" || { echo "STOP: 发布锁已存在 $lock" >&2; exit 2; }
env_sha="$(shasum -a 256 "$previous/deploy/.env" | awk '{print $1}')"
printf 'PREFLIGHT PASS source=%s migration=%s candidate=%s target=%s\n' \
  "$expected_source" "$source_migration" "$candidate" "$target_migration"
test "$mode" = --deploy || exit 0

mkdir "$lock"
started=0
frozen=0
success=0
rollback_prefix=""
on_exit() {
  local status=$? service rollback_ok=1
  trap - EXIT HUP INT TERM
  set +e
  if test "$success" != 1; then
    test "$status" != 0 || status=1
    if test "$started" = 1; then
      stop_and_verify || rollback_ok=0
      safe_previous || rollback_ok=0
    fi
    if test "$frozen" = 1; then
      for service in "${applications[@]}"; do
        docker image tag "$rollback_prefix-$service" "qianliu-zhisuan-$service" || rollback_ok=0
      done
    fi
    if test "$started" = 1 && test "$rollback_ok" = 1; then
      (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
        "${services[@]}") || rollback_ok=0
      verify_containers "$previous" || rollback_ok=0
      health || rollback_ok=0
      printf '%s\n' "$previous" > "$pointer.rollback" && mv "$pointer.rollback" "$pointer" || rollback_ok=0
    fi
    if test "$rollback_ok" != 1; then
      stop_and_verify || true
      echo "STOP: 回退验收失败；数据库和备份保留，发布锁未删除，请人工处理" >&2
      exit "$status"
    fi
    echo "FAILED: 已恢复上一版应用；0073 为兼容性增量迁移，可能保留" >&2
  fi
  rmdir "$lock" || { echo "STOP: 无法删除发布锁 $lock" >&2; exit 1; }
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

test "$(cat "$pointer")" = "$previous"
test "$(git -C "$previous" rev-parse HEAD)" = "$expected_source"
require_db_names "$source_names"
verify_containers "$previous"

stamp="$(date '+%Y%m%d-%H%M%S')"
mkdir -p "$server_root/backups/qianliu-zhisuan" "$server_root/logs/qianliu-zhisuan"
release="$(mktemp -d "$server_root/releases/qianliu-credential-chat-$stamp.XXXXXX")"
backup="$server_root/backups/qianliu-zhisuan/pre-credential-chat-$stamp.dump"
log="$server_root/logs/qianliu-zhisuan/deploy-credential-chat-$stamp.log"
rollback_prefix="qianliu-credential-chat-rollback-$stamp"
exec > >(tee -a "$log") 2>&1
printf 'START candidate=%s tree=%s previous=%s\n' "$candidate" "$candidate_tree" "$previous"

git -C "$release" init -q
git -C "$release" remote add origin ssh://git@ssh.github.com:443/Stephen66000/qianliu-zhisuan.git
GIT_SSH_COMMAND='ssh -o BatchMode=yes' GIT_TERMINAL_PROMPT=0 \
  git -C "$release" fetch --depth 64 origin "$candidate"
git -C "$release" checkout -q --detach "$candidate"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate"
test "$(git -C "$release" rev-parse 'HEAD^{tree}')" = "$candidate_tree"
git -C "$release" merge-base --is-ancestor "$expected_source" "$candidate"
test "$(git -C "$release" -c diff.renames=false diff --name-status "$expected_source..$candidate" -- packages/database/migrations)" = \
  $'A\tpackages/database/migrations/0073_credential_chat_probe.js'
git -C "$release" diff --quiet "$expected_source..$candidate" -- \
  deploy/compose.yaml deploy/compose.target.yaml deploy/caddy deploy/postgres-init \
  package.json pnpm-lock.yaml pnpm-workspace.yaml
test "$(shasum -a 256 "$release/packages/database/migrations/0073_credential_chat_probe.js" | awk '{print $1}')" = "$migration_sha"

cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
test "$(shasum -a 256 "$release/deploy/.env" | awk '{print $1}')" = "$env_sha"
(cd "$release/deploy" && docker compose config --quiet)
for service in "${applications[@]}"; do
  docker image tag "$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-$service-1")" \
    "$rollback_prefix-$service"
done
frozen=1
(cd "$release/deploy" && docker compose build migrate "${applications[@]}")

test "$(cat "$pointer")" = "$previous"
test "$(shasum -a 256 "$previous/deploy/.env" | awk '{print $1}')" = "$env_sha"
test "$(git -C "$previous" rev-parse HEAD)" = "$expected_source"
test -z "$(git -C "$previous" status --porcelain --untracked-files=all)"
started=1
stop_and_verify
require_db_names "$source_names"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"

(cd "$release/deploy" && docker compose run --rm --no-deps migrate)
require_db_names "$target_names"
(cd "$release/deploy" && docker compose up -d --no-build --force-recreate --no-deps \
  "${services[@]}")
verify_containers "$release"
health
require_db_names "$target_names"
for service in "${services[@]}"; do
  test "$(docker inspect --format '{{.RestartCount}}' "qianliu-zhisuan-$service-1")" = 0
done

printf '%s\n' "$release" > "$pointer.next"
mv "$pointer.next" "$pointer"
test "$(cat "$pointer")" = "$release"
success=1
printf 'COMPLETE release=%s commit=%s tree=%s migration=%s backup=%s backup_sha256=%s rollback_prefix=%s control=200 gateway=200 web=200 edge=200 worker=healthy\n' \
  "$release" "$candidate" "$candidate_tree" "$target_migration" "$backup" "$backup_sha" "$rollback_prefix"
