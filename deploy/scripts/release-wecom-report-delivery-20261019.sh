#!/usr/bin/env bash
# On the production host. Each mutation is a separate, explicitly approved operator action.
set -Eeuo pipefail
umask 077
mode="${1:---check-contract}"
if [[ "$mode" == --check-contract ]]; then bash -n "$0"; exit 0; fi
case "$mode" in --preflight|--migrate|--deploy|--verify|--rollback) ;; *) exit 2;; esac
revision="${2:?approved full candidate SHA required}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 2
image="${WECOM_RELEASE_IMAGE:?candidate Worker image required}"
compose_dir="${WECOM_RELEASE_COMPOSE_DIR:?existing production compose directory required}"
compose_file="${WECOM_RELEASE_COMPOSE_FILE:?existing effective compose file required}"
state_dir="${WECOM_RELEASE_STATE_DIR:?private release state directory required}"
head() { docker exec ic-postgres sh -c 'psql -X -Atq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1"'; }
outside_window() {
  local hour
  hour="$(TZ=Asia/Shanghai date +%H)"
  [[ "$hour" != 09 ]] || { echo 'Stop: report window is open'; exit 2; }
}
candidate() {
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]] || { echo 'Candidate label mismatch'; exit 2; }
}
compose() { docker compose --project-directory "$compose_dir" -f "$compose_file" -f "$state_dir/report-worker.json" "$@"; }
case "$mode" in
  --preflight)
    docker inspect --format '{{.Config.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{.State.Health.Status}}' ic-worker
    head
    candidate
    echo 'Read-only preflight; inspect effective compose paths and authorize migration/deployment separately.'
    ;;
  --migrate)
    outside_window; candidate
    [[ "$(head)" == 0089_model_validation_binding ]] || { echo 'Migration head changed'; exit 2; }
    mkdir -p "$state_dir"
    [[ ! -e "$state_dir/database-before-report-delivery.dump" ]] || { echo 'Backup already exists; inspect instead of overwriting'; exit 2; }
    docker exec ic-postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$state_dir/database-before-report-delivery.dump"
    # Keep the effective environment private and off stdout. Do not archive it into Evidence.
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ic-worker > "$state_dir/worker-private.env"
    docker run --rm --network container:ic-worker --env-file "$state_dir/worker-private.env" "$image" \
      node --import tsx --input-type=module -e 'import {createKysely} from "./packages/database/src/index.ts";import {createMigrator} from "./packages/database/src/migrator.ts";const db=createKysely();try{const r=await createMigrator(db).migrateTo("0090_report_delivery");if(r.error)throw r.error;console.log("MIGRATION_0090_OK");}finally{await db.destroy();}'
    [[ "$(head)" == 0090_report_delivery ]]
    ;;
  --deploy)
    outside_window; candidate
    [[ "$(head)" == 0090_report_delivery ]] || exit 2
    [[ -s "$state_dir/database-before-report-delivery.dump" ]] || { echo 'Verified backup required'; exit 2; }
    activation="${WECOM_REPORT_DELIVERY_ENABLED_AT:?future report activation timestamp required}"
    docker run --rm --network none -e ACTIVATION="$activation" "$image" node -e 'const a=new Date(process.env.ACTIVATION);if(!Number.isFinite(+a)||+a<=Date.now())process.exit(2)'
    [[ ! -e "$state_dir/previous-worker-image" ]] || { echo 'Release state already exists'; exit 2; }
    docker inspect --format '{{.Config.Image}}' ic-worker > "$state_dir/previous-worker-image"
    export WECOM_RELEASE_IMAGE="$image"
    python3 - "$state_dir/report-worker.json" "$activation" <<'PY'
import json,os,sys
json.dump({'services':{'worker':{'image':os.environ['WECOM_RELEASE_IMAGE'],'environment':{'WECOM_REPORT_DELIVERY_ENABLED_AT':sys.argv[2],'WECOM_REPORT_DELIVERY_PAUSED':'0'}}}},open(sys.argv[1],'w'))
PY
    compose up -d --no-deps --no-build worker
    echo 'Worker replaced. Run --verify; controlled sends remain a separate authorization.'
    ;;
  --verify)
    candidate
    [[ "$(head)" == 0090_report_delivery ]] || exit 2
    [[ "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' ic-worker)" == "$revision" ]] || exit 2
    [[ "$(docker inspect --format '{{.State.Health.Status}}' ic-worker)" == healthy ]] || exit 2
    docker exec ic-worker node -e 'console.log(JSON.stringify({node:process.version,enabledAt:process.env.WECOM_REPORT_DELIVERY_ENABLED_AT,paused:process.env.WECOM_REPORT_DELIVERY_PAUSED}))'
    echo 'Version/migration/health verified; this does not prove recipient delivery.'
    ;;
  --rollback)
    outside_window
    [[ -s "$state_dir/previous-worker-image" ]] || exit 2
    # Before replacing new code, reserve old incentive guards. UNKNOWN needs separate review.
    if [[ "${WECOM_ROLLBACK_UNKNOWN_REVIEWED:-0}" == 1 ]]; then
      docker exec ic-worker node --import tsx apps/worker/src/main.ts report-rollback-compat --execute --allow-unknown
    else
      docker exec ic-worker node --import tsx apps/worker/src/main.ts report-rollback-compat --execute
    fi
    previous="$(cat "$state_dir/previous-worker-image")"
    python3 - "$state_dir/report-worker.json" "$previous" <<'PY'
import json,sys
json.dump({'services':{'worker':{'image':sys.argv[2],'environment':{'WECOM_REPORT_DELIVERY_PAUSED':'1'}}}},open(sys.argv[1],'w'))
PY
    compose up -d --no-deps --no-build worker
    echo 'Old Worker restored outside sending window; additive schema/receipts retained. Old code ignores pause; future scheduling resumes under old rules and exported guards.'
    ;;
esac
