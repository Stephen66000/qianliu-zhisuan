#!/usr/bin/env bash
# CQ-01 捕获审计——扫描某场景的桩捕获目录，汇总破坏性调用：
#   dropdb 目标 / createdb 目标 / psql 写入目标（含 stdin 摘要）/ ALTER DATABASE 改名。
# 兼容 bash 3.2（无 mapfile/关联数组）。
# 用法: audit-capture.sh <capture-dir>
set -u
DIR="${1:?usage: audit-capture.sh <capture-dir>}"
DROPDB_FILE="$DIR/.audit-dropdb"; : > "$DROPDB_FILE"
CREATEDB_FILE="$DIR/.audit-createdb"; : > "$CREATEDB_FILE"
PSQL_FILE="$DIR/.audit-psql"; : > "$PSQL_FILE"
OTHER_FILE="$DIR/.audit-other"; : > "$OTHER_FILE"

db_of_argv() { # $1=argv file → 目标库名＝argv 末参数（sh -c <script> sh <db> 形态的最后一参）
  db=""
  while IFS= read -r line; do
    [ -n "$line" ] && db="$line"
  done < "$1"
  printf '%s' "$db"
}

for argv in "$DIR"/*.argv; do
  [ -e "$argv" ] || continue
  dir="${argv%/*}"
  id="$(basename "$argv" .argv)"
  meta="$dir/$id.meta"
  stdin="$dir/$id.stdin"
  [ -f "$meta" ] || printf 'exit=missing\n' > "$meta"
  meta_v="$(cat "$meta")"
  join="$(tr '\n' ' ' < "$argv" | sed 's/ $//')"
  stdinha="(no-stdin)"
  [ -s "$stdin" ] && stdinha="sha256=$(shasum -a 256 "$stdin" | awk '{print $1}') bytes=$(wc -c < "$stdin" | tr -d ' ')"
  case "$join" in
    *"dropdb "*)
      echo "[$id] dropdb target=$(db_of_argv "$argv") $meta_v" >> "$DROPDB_FILE";;
    *"createdb "*)
      echo "[$id] createdb target=$(db_of_argv "$argv") $meta_v" >> "$CREATEDB_FILE";;
    *"pg_restore --no-owner"*)
      echo "[$id] pg_restore-restore $meta_v" >> "$OTHER_FILE";;
    *"pg_restore --list"*)
      echo "[$id] pg_restore-gate $meta_v" >> "$OTHER_FILE";;
    *"sh -c true"*)
      echo "[$id] require_env-true $meta_v" >> "$OTHER_FILE";;
    *"rm -rf"*|*"mkdir -p"*)
      echo "[$id] delta-dir-prep $meta_v" >> "$OTHER_FILE";;
    *"psql"*)
      db="$(db_of_argv "$argv")"
      echo "[$id] psql db=${db:-<postgres-direct>} $stdinha $meta_v" >> "$PSQL_FILE";;
    *)
      echo "[$id] other: $(printf '%.60s' "$join") $meta_v" >> "$OTHER_FILE";;
  esac
done

echo "== dropdb 调用 =="
[ -s "$DROPDB_FILE" ] && sed 's/^/  /' "$DROPDB_FILE" || echo "  （无）"
echo "== createdb 调用 =="
[ -s "$CREATEDB_FILE" ] && sed 's/^/  /' "$CREATEDB_FILE" || echo "  （无）"
echo "== psql 调用（写入/改名执行面）=="
[ -s "$PSQL_FILE" ] && sed 's/^/  /' "$PSQL_FILE" || echo "  （无）"
echo "== ALTER DATABASE 改名语句（psql stdin 内）=="
renames=0
for stdin in "$DIR"/*.stdin; do
  [ -s "$stdin" ] || continue
  id="$(basename "$stdin" .stdin)"
  if grep -q "ALTER DATABASE" "$stdin" 2>/dev/null; then
    echo "  [$id] $(grep 'ALTER DATABASE' "$stdin" | tr '\n' ';')"
    renames=1
  fi
done
[ "$renames" = "0" ] && echo "  （无）"
echo "== 其他容器调用 =="
[ -s "$OTHER_FILE" ] && sed 's/^/  /' "$OTHER_FILE" || echo "  （无）"
rm -f "$DROPDB_FILE" "$CREATEDB_FILE" "$PSQL_FILE" "$OTHER_FILE"
