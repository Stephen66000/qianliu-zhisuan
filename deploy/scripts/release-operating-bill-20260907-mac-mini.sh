#!/usr/bin/env bash
# Reviewed operating-bill release: one additive migration (0065), unchanged dependencies and topology.
set -Eeuo pipefail
trap 'printf "STOP: release check failed at line %s (exit %s)\n" "$LINENO" "$?" >&2' ERR
umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"
if test "${1:-}" = --check-contract; then
  test "$#" = 1
  bash -n "$0"
  echo 'PASS: syntax only; production has not been changed'
  exit 0
fi
mode="${1:-deploy}"
case "$mode" in deploy|--preflight) ;; *) echo 'Usage: bash release-operating-bill-20260907-mac-mini.sh [--preflight|--check-contract]'; exit 2;; esac
test "$#" -le 1
candidate=a37de1a5c29e30aeb1d7aa84cbffadd331e22115
tree=c12d26cd8ddffdc517bb5c88d634a02e139ebdca
expected_source=b29df679283842d7503aab0991872b63c23be21b
migration=0064_quota_pricing_and_policy_archive
target_migration=0065_principal_accounting_assignment
root=/Users/stephen
pointer="$root/qianliu-current-release.txt"
lock="$root/.qianliu-quota-pricing-release.lock"
services=(control-api gateway worker web caddy)
applications=(control-api gateway worker web)
for command_name in git docker curl shasum; do command -v "$command_name" >/dev/null; done
previous="$(cat "$pointer")"
case "$previous" in "$root"/releases/*) ;; *) echo 'Invalid release pointer'; exit 2;; esac
actual_source="$(git -C "$previous" rev-parse HEAD)"
printf 'Current release: %s\nCurrent commit: %s\nCandidate: %s\n' "$previous" "$actual_source" "$candidate"
if test "$actual_source" != "$expected_source"; then
  echo "STOP: expected current commit $expected_source. Recheck release scope before continuing."
  exit 2
fi
test -z "$(git -C "$previous" status --porcelain --untracked-files=all)"
test -f "$previous/deploy/.env"
(cd "$previous/deploy" && docker compose config --quiet)
db_head() {
  docker compose --project-directory "$previous/deploy" exec -T postgres sh -lc \
    'psql -X -v ON_ERROR_STOP=1 -Atq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;"'
}
verify_containers() {
  local directory="$1" service container
  for service in "${services[@]}"; do
    container="qianliu-zhisuan-${service}-1"
    test "$(docker inspect --format '{{.State.Running}}' "$container")" = true || return 1
    test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")" = "$directory/deploy" || return 1
    if test "$service" != caddy; then
      test "$(docker inspect --format '{{.Image}}' "$container")" = "$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-$service")" || return 1
    fi
  done
}
health() {
  local i control gateway web edge worker
  for i in $(seq 1 45); do
    control="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health || true)"
    gateway="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health || true)"
    web="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
    edge="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1/health || true)"
    worker="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' qianliu-zhisuan-worker-1 2>/dev/null || true)"
    if test "$control/$gateway/$web/$edge/$worker" = '200/200/200/200/healthy'; then return 0; fi
    sleep 2
  done
  echo "Health failed: $control/$gateway/$web/$edge/$worker"
  return 1
}
test "$(db_head)" = "$migration"
verify_containers "$previous"
health
test ! -d "$lock"
echo 'PASS: current release, clean source, topology, migration, health and free release lock'
if test "$mode" = --preflight; then exit 0; fi
mkdir "$lock" || { echo 'Deployment lock held'; exit 2; }
stamp="$(date '+%Y%m%d-%H%M%S')"
release="$root/releases/qianliu-operating-a37de1a-$stamp"
backup="$root/backups/qianliu-zhisuan/pre-operating-a37de1a-$stamp.dump"
rollback_prefix="qianliu-operating-a37de1a-rollback-$stamp"
log="$root/logs/qianliu-zhisuan/deploy-operating-a37de1a-$stamp.log"
started=0
frozen=0
pointer_changed=0
success=0
on_exit() {
  local status=$? rollback_ok=1 service
  trap - EXIT HUP INT TERM
  set +e
  if test "$success" != 1; then
    # Never run the old attribution writer after new accounting relationships exist.
    # Preserve the database: 0065 is additive, so no automatic down or data restore.
    if test "$started" = 1; then
      (cd "$previous/deploy" && docker compose stop "${services[@]}") || rollback_ok=0
      for service in "${services[@]}"; do
        test "$(docker inspect --format '{{.State.Running}}' "qianliu-zhisuan-$service-1")" = false || rollback_ok=0
      done
      local current_migration assignments
      current_migration="$(db_head)" || rollback_ok=0
      case "$current_migration" in
        "$migration") ;;
        "$target_migration")
          assignments="$(docker compose --project-directory "$previous/deploy" exec -T postgres sh -lc 'psql -X -v ON_ERROR_STOP=1 -Atq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT COUNT(*) FROM principal_accounting_assignment;"')" || rollback_ok=0
          test "$assignments" = 0 || rollback_ok=0
          ;;
        *) rollback_ok=0 ;;
      esac
      if test "$rollback_ok" != 1; then
        echo 'STOP: cannot safely restore old applications (new assignments or unknown state). Database and backup preserved; manual forward repair required.'
        rmdir "$lock" || true
        exit "$status"
      fi
    fi
    if test "$frozen" = 1; then
      for service in "${applications[@]}"; do
        docker image tag "$rollback_prefix-$service" "qianliu-zhisuan-$service" || rollback_ok=0
      done
    fi
    if test "$pointer_changed" = 1; then
      printf '%s\n' "$previous" > "$pointer.rollback" && mv "$pointer.rollback" "$pointer" || rollback_ok=0
    fi
    if test "$started" = 1; then
      if test "$rollback_ok" = 1; then
        (cd "$previous/deploy" && docker compose up -d --no-build --force-recreate --no-deps "${services[@]}") || rollback_ok=0
        verify_containers "$previous" || rollback_ok=0
        health || rollback_ok=0
      fi
      if test "$rollback_ok" = 1; then
        echo "FAILED; previous application release restored: $previous (database preserved; additive 0065 may remain)"
      else
        (cd "$previous/deploy" && docker compose stop "${services[@]}")
        echo 'ERROR: rollback could not be verified; requested business service stop. Manual intervention required.'
      fi
    else
      echo 'FAILED before replacing services; previous running containers retained.'
    fi
  fi
  rmdir "$lock" || true
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Recheck after acquiring the shared deployment lock.
test "$(cat "$pointer")" = "$previous"
test "$(git -C "$previous" rev-parse HEAD)" = "$expected_source"
test -z "$(git -C "$previous" status --porcelain --untracked-files=all)"
verify_containers "$previous"
mkdir -p "$root/logs/qianliu-zhisuan" "$root/backups/qianliu-zhisuan"
exec > >(tee -a "$log") 2>&1
printf 'START candidate=%s tree=%s previous=%s\n' "$candidate" "$tree" "$previous"
echo '1. Fetch exact reviewed source and verify scope'
mkdir "$release"
git -C "$release" init -q
git -C "$release" remote add origin git@github.com:Stephen66000/qianliu-zhisuan.git
GIT_SSH_COMMAND='ssh -o BatchMode=yes' GIT_TERMINAL_PROMPT=0 \
  git -C "$release" fetch --depth 3 origin "$candidate"
git -C "$release" checkout -q --detach "$candidate"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate"
test "$(git -C "$release" rev-parse 'HEAD^{tree}')" = "$tree"
git -C "$release" merge-base --is-ancestor "$expected_source" "$candidate"
# The immutable candidate binds all reviewed source. Only 0065 changes schema.
test "$(git -C "$release" diff --name-status "$expected_source..$candidate" -- packages/database/migrations)" = $'A\tpackages/database/migrations/0065_principal_accounting_assignment.js'
git -C "$release" diff --quiet "$expected_source..$candidate" -- deploy/compose.yaml deploy/compose.target.yaml deploy/caddy deploy/postgres-init package.json pnpm-lock.yaml pnpm-workspace.yaml
cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
cmp -s "$previous/deploy/.env" "$release/deploy/.env"
(cd "$release/deploy" && docker compose config --quiet)
echo '2. Freeze all application images; build while the current release stays online'
for service in "${applications[@]}"; do
  docker image tag "$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-$service-1")" "$rollback_prefix-$service"
done
frozen=1
(cd "$release/deploy" && docker compose build migrate "${applications[@]}")
echo '3. Pause application writes and back up database before migration'
# Set started before stop so a partially stopped stack also enters recovery.
started=1
(cd "$previous/deploy" && docker compose stop "${services[@]}")
for service in "${services[@]}"; do
  test "$(docker inspect --format '{{.State.Running}}' "qianliu-zhisuan-$service-1")" = false
done
test "$(db_head)" = "$migration"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup"
test -s "$backup"
docker compose --project-directory "$previous/deploy" exec -T postgres \
  sh -lc 'pg_restore -l >/dev/null' < "$backup"
backup_sha="$(shasum -a 256 "$backup" | awk '{print $1}')"
echo '4. Apply 0065, replace applications, then verify health and release pointer'
(cd "$release/deploy" && docker compose run --rm --no-deps migrate)
test "$(db_head)" = "$target_migration"
started=1
(cd "$release/deploy" && docker compose up -d --no-build --force-recreate --no-deps "${services[@]}")
verify_containers "$release"
health
test "$(db_head)" = "$target_migration"
for service in "${services[@]}"; do
  test "$(docker inspect --format '{{.RestartCount}}' "qianliu-zhisuan-$service-1")" = 0
done
pointer_changed=1
printf '%s\n' "$release" > "$pointer.next"
mv "$pointer.next" "$pointer"
test "$(cat "$pointer")" = "$release"
success=1
printf 'COMPLETE release=%s commit=%s tree=%s migration=%s control=200 gateway=200 web=200 edge=200 worker=healthy backup=%s backup_sha256=%s rollback_prefix=%s\n' "$release" "$candidate" "$tree" "$target_migration" "$backup" "$backup_sha" "$rollback_prefix"
