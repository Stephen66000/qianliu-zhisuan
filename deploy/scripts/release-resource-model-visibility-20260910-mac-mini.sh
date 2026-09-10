#!/usr/bin/env bash
# Resource model visibility update on the deployed credential Chat recovery base; no migration.
set -Eeuo pipefail
umask 077
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"
if test "${1:-}" = --check-contract; then
  bash -n "$0"
  echo 'release_contract_check=PASS (syntax only; not production execution)'
  exit 0
fi
test "$#" = 0
candidate="${CANDIDATE_COMMIT:?missing CANDIDATE_COMMIT}"
tree="${CANDIDATE_TREE:?missing CANDIDATE_TREE}"
source_commit=fa864239167a2ca881b0bb7ad6641154da1dc38c
root=/Users/stephen
pointer="$root/qianliu-current-release.txt"
previous="$(<"$pointer")"
case "$previous" in "$root"/releases/*) ;; *) echo 'Invalid release pointer'; exit 2;; esac
for digest in "$candidate" "$tree"; do
  test "${#digest}" = 40
  case "$digest" in *[!0-9a-f]*) exit 2;; esac
done
test "$(git -C "$previous" rev-parse HEAD)" = "$source_commit"
test -z "$(git -C "$previous" status --porcelain --untracked-files=all)"
test -f "$previous/deploy/.env"
stamp="$(date '+%Y%m%d-%H%M%S')"
release="$root/releases/qianliu-resource-model-visibility-${candidate:0:7}-$stamp"
backup_image="qianliu-resource-model-visibility-rollback-$stamp"
lock="$root/.qianliu-quota-pricing-release.lock"
mkdir "$lock" || { echo 'Another deployment holds the release lock'; exit 2; }
started=0
frozen=0
success=0
pointer_changed=0
services=(control-api gateway worker web caddy)

health() {
  local i control gateway web caddy worker
  for i in $(seq 1 45); do
    control="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health || true)"
    gateway="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health || true)"
    web="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
    caddy="$(curl --connect-timeout 1 --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1/health || true)"
    worker="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' qianliu-zhisuan-worker-1 2>/dev/null || true)"
    if test "$control/$gateway/$web/$caddy/$worker" = '200/200/200/200/healthy'; then return 0; fi
    sleep 2
  done
  echo "Health failed: $control/$gateway/$web/$caddy/$worker"
  return 1
}
verify_containers() {
  local directory="$1" service container
  for service in "${services[@]}"; do
    container="qianliu-zhisuan-${service}-1"
    test "$(docker inspect --format '{{.State.Running}}' "$container")" = true || return 1
    test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container")" = "$directory/deploy" || return 1
    if test "$service" != caddy; then
      test "$(docker inspect --format '{{.Image}}' "$container")" = "$(docker image inspect --format '{{.Id}}' "qianliu-zhisuan-$service")" || return 1
    fi
  done
}
on_exit() {
  local status=$? rollback_ok=1 service
  trap - EXIT HUP INT TERM
  set +e
  if test "$success" != 1; then
    if test "$frozen" = 1; then
      for service in control-api gateway worker web; do
        docker image tag "${backup_image}-${service}" "qianliu-zhisuan-${service}" || rollback_ok=0
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
        echo "FAILED; previous release restored: $previous"
      else
        (cd "$previous/deploy" && docker compose stop "${services[@]}")
        echo 'ERROR: rollback verification failed; requested business services stop. Manual intervention required.'
      fi
    else
      echo "FAILED before service replacement; previous release remains selected: $previous"
    fi
  fi
  rmdir "$lock" || true
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$root/logs/qianliu-zhisuan"
exec > >(tee -a "$root/logs/qianliu-zhisuan/deploy-resource-model-visibility-$stamp.log") 2>&1
verify_containers "$previous"
db_head() {
  docker compose --project-directory "$previous/deploy" exec -T postgres sh -lc \
    'psql -X -v ON_ERROR_STOP=1 -Atq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1;"'
}
test "$(db_head)" = 0073_credential_chat_probe
echo 'step 1: fetch and verify exact candidate'
GIT_SSH_COMMAND='ssh -o BatchMode=yes' GIT_TERMINAL_PROMPT=0 git clone --depth 8 \
  --branch codex/resource-model-visibility-release-20260910 git@github.com:Stephen66000/qianliu-zhisuan.git "$release"
test "$(git -C "$release" rev-parse HEAD)" = "$candidate"
test "$(git -C "$release" rev-parse 'HEAD^{tree}')" = "$tree"
git -C "$release" merge-base --is-ancestor "$source_commit" "$candidate"
# Only reviewed display filtering, tests and this release helper may differ.
git -C "$release" diff --quiet "$source_commit..$candidate" -- . \
  ':(exclude)apps/control-api/src/providers/routes.ts' \
  ':(exclude)apps/control-api/src/providers/resource-model-visibility.ts' \
  ':(exclude)apps/control-api/src/__tests-integration__/resource-model-visibility.test.ts' \
  ':(exclude)apps/web/src/api/types.ts' \
  ':(exclude)apps/web/src/components/resources/ResourceTable.tsx' \
  ':(exclude)apps/web/src/components/resources/ResourceTable.models.test.ts' \
  ':(exclude)apps/web/src/pages/quota-rules-page-model.ts' \
  ':(exclude)apps/web/src/pages/QuotaModelDisable.test.tsx' \
  ':(exclude)deploy/scripts/release-resource-model-visibility-20260910-mac-mini.sh'
cp -p "$previous/deploy/.env" "$release/deploy/.env"
chmod 600 "$release/deploy/.env"
(cd "$release/deploy" && docker compose config --quiet)
for service in control-api gateway worker web; do
  docker image tag "$(docker inspect --format '{{.Image}}' "qianliu-zhisuan-${service}-1")" "${backup_image}-${service}"
done
frozen=1
echo 'step 2: build application images while current services remain online'
(cd "$release/deploy" && docker compose build control-api gateway worker web)
echo 'step 3: replace application containers; no migration, postgres/redis remain running'
test "$(<"$pointer")" = "$previous"
started=1
(cd "$release/deploy" && docker compose up -d --no-build --force-recreate --no-deps "${services[@]}")
verify_containers "$release"
health
test "$(db_head)" = 0073_credential_chat_probe
pointer_changed=1
printf '%s\n' "$release" > "$pointer.next"
mv "$pointer.next" "$pointer"
test "$(<"$pointer")" = "$release"
success=1
echo "COMPLETE release=$release commit=$candidate tree=$tree database=0073_credential_chat_probe control=200 gateway=200 web=200 caddy=200 worker=healthy rollback_image=$backup_image"
