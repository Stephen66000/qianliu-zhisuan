#!/usr/bin/env bash
# On the production host. Backup-only: no deployment logic, no container restarts, no writes to any production table.
# Database access is read-only: pg_dump does not write to the database.
# Output goes to the operator-specified state directory (API_DECOUPLE_BACKUP_STATE_DIR); umask 077 keeps the archive private.
set -Eeuo pipefail
umask 077
mode="${1:---check-contract}"
if [[ "$mode" == --check-contract ]]; then bash -n "$0"; exit 0; fi
[[ "$mode" == --backup ]] || { echo "usage: $0 --backup"; exit 2; }
state_dir="${API_DECOUPLE_BACKUP_STATE_DIR:?existing operator state directory required}"
mkdir -p "$state_dir"
migration_head() { docker exec ic-postgres sh -c 'psql -X -Atq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1"'; }
target="$state_dir/database-before-api-decouple-$(date +%Y%m%d-%H%M%S).dump"
[[ ! -e "$target" ]] || { echo "Refusing to overwrite existing file: $target"; exit 2; }
docker exec ic-postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$target"
[[ -s "$target" ]] || { echo 'Backup file is empty'; exit 2; }
# Integrity precheck: pg_restore must be able to list the archive TOC. awk reads to EOF so the
# pipe is never closed early (SIGPIPE-safe under pipefail), while printing only the first 3 lines.
toc_head="$(docker exec -i ic-postgres sh -c 'pg_restore --list' < "$target" | awk 'NR<=3')" || { echo 'Integrity check failed: pg_restore cannot list the archive TOC'; exit 2; }
echo "backup_file=$target"
echo "bytes=$(wc -c < "$target" | tr -d ' ')"
echo 'archive TOC (first 3 lines):'
echo "$toc_head"
echo "migration_head=$(migration_head)"
echo 'TODO: 登记 deployment_log.backup_ref 于发布流程执行'
