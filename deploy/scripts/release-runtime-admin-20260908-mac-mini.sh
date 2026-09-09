#!/usr/bin/env bash
# Exact-source upgrade from the latest supplied Mac mini receipt. Default is read-only.
set -Eeuo pipefail
umask 077
export PATH="${PATH}:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"
candidate=eb1ed123ec8e919cad0e78947c9cd9c441dee352
tree=bb364298d362c22c7628b7f0d36e160563b0deaf
expected_source=1dc468369c56fb59f3a64d40b6136d102b5a1a41
source_tree=3beaa4deb0d0da808b6ed4592d08baeb5ca9ef69
migration=0069_auth_error_evidence
target_migration=0070_alert_recovery_evidence
root=/Users/stephen
pointer="$root/qianliu-current-release.txt"
lock="$root/.qianliu-quota-pricing-release.lock"
services=(caddy web gateway control-api worker)
applications=(control-api gateway worker web)
mode="${1:---preflight}"
test "$#" -le 1
case "$mode" in
  --check-contract) bash -n "$0"; echo 'PASS: shell syntax; use the local rehearsal for behavior checks'; exit 0 ;;
  --preflight|--deploy) ;;
  *) echo 'Usage: bash release-runtime-admin-20260908-mac-mini.sh [--preflight|--deploy|--check-contract]' >&2; exit 2 ;;
esac
[[ "$candidate" =~ ^[0-9a-f]{40}$ && "$tree" =~ ^[0-9a-f]{40}$ ]]
for command_name in git docker curl shasum awk mktemp; do command -v "$command_name" >/dev/null; done
previous="$(cat "$pointer")"
case "$previous" in "$root"/releases/*) ;; *) echo 'STOP: invalid release pointer' >&2; exit 2 ;; esac
test "$(cd "$previous" && pwd -P)" = "$previous"
actual_source="$(git -C "$previous" rev-parse HEAD)"
printf 'OBSERVED release=%s commit=%s\nEXPECTED source=%s candidate=%s\n' "$previous" "$actual_source" "$expected_source" "$candidate"
test "$actual_source" = "$expected_source" || { echo 'STOP: source differs from latest supplied receipt; send this output for reconciliation' >&2; exit 2; }
test "$(git -C "$previous" rev-parse 'HEAD^{tree}')" = "$source_tree"
test -z "$(git -C "$previous" status --porcelain --untracked-files=all)"
test -f "$previous/deploy/.env"
(cd "$previous/deploy" && docker compose config --quiet)
source_names="$(git -C "$previous" ls-tree -r --name-only HEAD packages/database/migrations | sed -n 's|^packages/database/migrations/\(.*\)\.js$|\1|p' | LC_ALL=C sort)"
test "$(printf '%s\n' "$source_names" | tail -1)" = "$migration"
target_names="$(printf '%s\n%s' "$source_names" "$target_migration")"
db_sql() {
  # SQL is fixed by this script; no environment contents or passwords are printed.
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
      test "$(docker inspect --format '{{.Image}}' "$container")" = "$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-$service")" || return 1
    fi
  done
}
health() {
  local i port code worker
  for ((i=0; i<30; i++)); do
    code=''
    for port in 8788 8787 8080 80; do
      local endpoint=/health
      test "$port" != 8080 || endpoint=/
      code="$code/$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$endpoint" || true)"
    done
    worker="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' qianliu-zhisuan-worker-1 2>/dev/null || true)"
    if test "$code/$worker" = '/200/200/200/200/healthy'; then return 0; fi
    sleep 2
  done
  echo "STOP: health=$code/$worker" >&2; return 1
}
stop_and_verify() {
  local service
  (cd "$previous/deploy" && docker compose stop "${services[@]}") || return 1
  for service in "${services[@]}"; do
    test "$(docker inspect --format '{{.State.Running}}' "qianliu-zhisuan-$service-1")" = false || return 1
  done
}
safe_previous() {
  local names evidence_count
  names="$(db_names)" || return 1
  if test "$names" = "$source_names"; then return 0; fi
  test "$names" = "$target_names" || return 1
  # Source code already understands archived admins, but not recovery_evidence.
  # Do not let old writers invalidate newly recorded proof. Keep the additive column.
  evidence_count="$(db_sql 'SELECT COUNT(*) FROM alert_event WHERE recovery_evidence IS NOT NULL;')" || return 1
  test "$evidence_count" = 0
}
require_db_names "$source_names" || { echo 'STOP: database migration history query failed or differs from source' >&2; exit 2; }
verify_containers "$previous"
health
test ! -e "$lock" || { echo 'STOP: release lock exists; inspect its owner before continuing' >&2; exit 2; }
env_sha="$(shasum -a 256 "$previous/deploy/.env" | awk '{print $1}')"
printf 'PREFLIGHT PASS source=%s migration=%s candidate=%s target=%s\n' "$expected_source" "$migration" "$candidate" "$target_migration"
test "$mode" = --deploy || exit 0
mkdir "$lock"
started=0
frozen=0
success=0
rollback_prefix=''
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
    if test "$rollback_ok" = 1 && test "$frozen" = 1; then
      for service in "${applications[@]}"; do
        docker image tag "$rollback_prefix-$service" "qianliu-zhisuan-$service" || rollback_ok=0
      done
    fi
    if test "$started" = 1 && test "$rollback_ok" = 1; then
      (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps "${services[@]}") || rollback_ok=0
      verify_containers "$previous" || rollback_ok=0
      health || rollback_ok=0
      if test "$rollback_ok" = 1; then
        printf '%s\n' "$previous" > "$pointer.rollback" && mv "$pointer.rollback" "$pointer" || rollback_ok=0
      fi
    fi
    if test "$rollback_ok" != 1; then
      if test "$started" = 1; then stop_and_verify || true; fi
      echo "STOP: recovery cannot be verified or recovery evidence exists. Database/backup preserved; lock retained at $lock. Forward repair required." >&2
      exit "$status"
    fi
    echo 'FAILED: previous applications retained/restored; database preserved (additive migrations may remain). No automatic down/restore was executed.' >&2
  fi
  rmdir "$lock" || { echo "STOP: could not release $lock" >&2; exit 1; }
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
test "$(cat "$pointer")" = "$previous"
test "$(git -C "$previous" rev-parse HEAD)" = "$expected_source"
test -z "$(git -C "$previous" status --porcelain --untracked-files=all)"
require_db_names "$source_names"
verify_containers "$previous"
stamp="$(date '+%Y%m%d-%H%M%S')"
mkdir -p "$root/backups/qianliu-zhisuan" "$root/logs/qianliu-zhisuan"
release="$(mktemp -d "$root/releases/qianliu-runtime-admin-$stamp.XXXXXX")"
backup="$root/backups/qianliu-zhisuan/pre-runtime-admin-$stamp.dump"
log="$root/logs/qianliu-zhisuan/deploy-runtime-admin-$stamp.log"
rollback_prefix="qianliu-runtime-admin-rollback-$stamp"
exec > >(tee -a "$log") 2>&1
printf 'START candidate=%s tree=%s previous=%s\n' "$candidate" "$tree" "$previous"
git -C "$release" init -q
git -C "$release" remote add origin ssh://git@ssh.github.com:443/Stephen66000/qianliu-zhisuan.git
GIT_SSH_COMMAND='ssh -o BatchMode=yes' GIT_TERMINAL_PROMPT=0 git -C "$release" fetch --depth 64 origin "$candidate"
git -C "$release" checkout -q --detach "$candidate"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate"
test "$(git -C "$release" rev-parse 'HEAD^{tree}')" = "$tree"
git -C "$release" merge-base --is-ancestor "$expected_source" "$candidate"
test "$(git -C "$release" -c diff.renames=false diff --name-status "$expected_source..$candidate" -- packages/database/migrations)" = $'A\tpackages/database/migrations/0070_alert_recovery_evidence.js'
git -C "$release" diff --quiet "$expected_source..$candidate" -- deploy/compose.yaml deploy/compose.target.yaml deploy/caddy deploy/postgres-init package.json pnpm-lock.yaml pnpm-workspace.yaml
test "$(shasum -a 256 "$release/packages/database/migrations/0070_alert_recovery_evidence.js" | awk '{print $1}')" = 8847f1898128d4a4cc004e747611d20134015e9d4d9f744048f09b198537ac51
cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
test "$(shasum -a 256 "$release/deploy/.env" | awk '{print $1}')" = "$env_sha"
(cd "$release/deploy" && docker compose config --quiet)
for service in "${applications[@]}"; do
  docker image tag "$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-$service-1")" "$rollback_prefix-$service"
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
(cd "$release/deploy" && docker compose up -d --no-build --force-recreate --no-deps "${services[@]}")
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
printf 'COMPLETE release=%s commit=%s tree=%s migration=%s backup=%s backup_sha256=%s rollback_prefix=%s control=200 gateway=200 web=200 edge=200 worker=healthy\n' "$release" "$candidate" "$tree" "$target_migration" "$backup" "$backup_sha" "$rollback_prefix"
